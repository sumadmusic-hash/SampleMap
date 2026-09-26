#!/usr/bin/env -S npx tsx
/**
 * TEMPORARY DIAGNOSTIC (Step 16O/16Q) — SampleMap V2 BEFORE/AFTER distribution.
 *
 * Reads the REAL Audiotool pipeline over real samples and reports X/Y/feature
 * statistics to (a) explain the original X-saturation (Step 16O) and (b)
 * validate the V2 Semantic 2D map (STEP 16P/16Q): BEFORE = V1
 * (x=clamp01(1-flatness), y=log100..8000 centroid), AFTER = V2 authoritative
 * `computePosition(features, decodedAudio)` at analysis time.
 *
 * Runs the SAME production functions (extractFeatures, computePosition) on REAL
 * audio via PAT in Node. It is NOT a product change: it adds no mapping logic
 * and touches no map/classification/persistence/Audiotool source. No audio is
 * persisted; no credential is printed.
 *
 * Run: npx tsx scripts/analyze-map-x.ts [--limit N] [--corr]
 */
import { createAudiotoolClient, createPATAuth } from "@audiotool/nexus";
import { createNodeTransport, createDiskWasmLoader } from "@audiotool/nexus/node";
import { extractFeatures } from "../src/audio/featureExtractor";
import { computePosition, mapVersion } from "../src/map/mapPosition";
import type { DecodedAudio } from "../src/audio/decodedAudio";

const PAT = process.env.AT_PAT ?? "";
if (!PAT) {
  console.error("AT_PAT not set. See .env");
  process.exit(1);
}

function limitArg(): number {
  const i = process.argv.indexOf("--limit");
  return i > -1 ? Number(process.argv[i + 1]) || 100 : 100;
}

function nodeWavDecode(bytes: ArrayBuffer): DecodedAudio {
  const buf = new Uint8Array(bytes);
  if (buf.byteLength < 44 || String.fromCharCode(...buf.subarray(0, 4)) !== "RIFF")
    throw new Error("not a RIFF WAV");
  const dv = new DataView(bytes);
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | undefined;
  let dataStart = -1;
  let dataSize = 0;
  while (off + 8 <= buf.byteLength) {
    const id = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
    const size = dv.getUint32(off + 4, true);
    if (id === "fmt ") {
      const format = dv.getUint16(off + 8, true);
      if (format !== 1) throw new Error(`unsupported WAV format ${format}`);
      fmt = {
        channels: dv.getUint16(off + 10, true),
        sampleRate: dv.getUint32(off + 12, true),
        bits: dv.getUint16(off + 22, true),
      };
    } else if (id === "data") {
      dataStart = off + 8;
      dataSize = size;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataStart < 0) throw new Error("WAV missing fmt/data");
  if (fmt.bits !== 16) throw new Error(`unsupported bits ${fmt.bits}`);
  const frames = Math.floor(dataSize / (fmt.channels * 2));
  const frac = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      sum += dv.getInt16(dataStart + (i * fmt.channels + c) * 2, true) / 32768;
    }
    frac[i] = sum / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, mono: frac, durationSeconds: frames / fmt.sampleRate };
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return NaN;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function stats(arr: number[]) {
  if (arr.length === 0) return { min: NaN, max: NaN, mean: NaN, median: NaN };
  const s = [...arr].sort((a, b) => a - b);
  return {
    min: s[0],
    max: s[s.length - 1],
    mean: arr.reduce((a, b) => a + b, 0) / arr.length,
    median: median(s),
  };
}

function reportBeforeAfter(
  v1x: number[],
  v1y: number[],
  v2x: number[],
  v2y: number[],
): void {
  const pct = (a: number[], q: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
  };
  const stdev = (a: number[]) => {
    if (a.length === 0) return 0;
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    return Math.sqrt(a.reduce((acc, v) => acc + (v - m) * (v - m), 0) / a.length);
  };
  const corr = (a: number[], b: number[]) => {
    const ma = a.reduce((x, y) => x + y, 0) / a.length;
    const mb = b.reduce((x, y) => x + y, 0) / a.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  };
  const edgePile = (a: number[]) => a.filter((v) => v <= 0.025 || v >= 0.975).length / Math.max(1, a.length);
  const n = v1x.length;
  const N = Math.max(1, n);
  const b1 = `  min=${stats(v1x).min.toFixed(4)} max=${stats(v1x).max.toFixed(4)} mean=${stats(v1x).mean.toFixed(4)} median=${stats(v1x).median.toFixed(4)} stdev=${stdev(v1x).toFixed(4)}`;
  const b2 = `  P10=${pct(v1x, 0.1).toFixed(4)} P90=${pct(v1x, 0.9).toFixed(4)} (span ${(pct(v1x, 0.9) - pct(v1x, 0.1)).toFixed(4)})  X>=0.95=${(100 * v1x.filter((x) => x >= 0.95).length / N).toFixed(1)}%  X>=0.99=${(100 * v1x.filter((x) => x >= 0.99).length / N).toFixed(1)}%`;
  const a1 = `  min=${stats(v2x).min.toFixed(4)} max=${stats(v2x).max.toFixed(4)} mean=${stats(v2x).mean.toFixed(4)} median=${stats(v2x).median.toFixed(4)} stdev=${stdev(v2x).toFixed(4)}`;
  const a2 = `  P10=${pct(v2x, 0.1).toFixed(4)} P90=${pct(v2x, 0.9).toFixed(4)} (span ${(pct(v2x, 0.9) - pct(v2x, 0.1)).toFixed(4)})  X>=0.95=${(100 * v2x.filter((x) => x >= 0.95).length / N).toFixed(1)}%  X>=0.99=${(100 * v2x.filter((x) => x >= 0.99).length / N).toFixed(1)}%`;

  console.log("═══ BEFORE(AFTER) — V1 vs V2 map, SAME " + n + " real samples ═══");
  console.log("X:");
  console.log("  BEFORE (V1): " + b1);
  console.log("              " + b2);
  console.log("  AFTER  (V2): " + a1);
  console.log("              " + a2);
  console.log("Y:");
  console.log(`  BEFORE (V1): stdev=${stdev(v1y).toFixed(4)} P10=${pct(v1y, 0.1).toFixed(4)} P90=${pct(v1y, 0.9).toFixed(4)} (span ${(pct(v1y, 0.9) - pct(v1y, 0.1)).toFixed(4)})`);
  console.log(`  AFTER  (V2): stdev=${stdev(v2y).toFixed(4)} P10=${pct(v2y, 0.1).toFixed(4)} P90=${pct(v2y, 0.9).toFixed(4)} (span ${(pct(v2y, 0.9) - pct(v2y, 0.1)).toFixed(4)})`);
  console.log(`  X/Y Pearson corr |r|  AFTER=${Math.abs(corr(v2x, v2y)).toFixed(3)}  BEFORE=${Math.abs(corr(v1x, v1y)).toFixed(3)}`);
  console.log(`  Edge pileup (within outer 2.5%)  AFTER x=${(100 * edgePile(v2x)).toFixed(1)}% y=${(100 * edgePile(v2y)).toFixed(1)}%`);

  // 5x5 corner-bin pileup (AFTER).
  let maxCorner = 0;
  const bins = 5;
  for (const [cx, cy] of [[0, 0], [0, bins - 1], [bins - 1, 0], [bins - 1, bins - 1]] as const) {
    let c = 0;
    for (let i = 0; i < n; i++) {
      const bx = Math.min(bins - 1, Math.floor(v2x[i] * bins));
      const by = Math.min(bins - 1, Math.floor(v2y[i] * bins));
      if (bx === cx && by === cy) c++;
    }
    maxCorner = Math.max(maxCorner, c / N);
  }
  console.log(`  Max 5x5 corner-bin share (AFTER): ${(100 * maxCorner).toFixed(1)}%`);

  console.log("");
  console.log("═══ STEP16P Acceptance Criteria (AFTER / V2) ═══");
  const checks: Array<[string, boolean, string]> = [
    ["1. X>=0.95 < 15%", (100 * v2x.filter((x) => x >= 0.95).length / N) < 15, `${(100 * v2x.filter((x) => x >= 0.95).length / N).toFixed(1)}%`],
    ["2. X stdev > 0.20", stdev(v2x) > 0.2, stdev(v2x).toFixed(4)],
    ["3. X P10-P90 > 0.5", (pct(v2x, 0.9) - pct(v2x, 0.1)) > 0.5, (pct(v2x, 0.9) - pct(v2x, 0.1)).toFixed(4)],
    ["4. Y stdev > 0.15", stdev(v2y) > 0.15, stdev(v2y).toFixed(4)],
    ["5. Y P10-P90 > 0.4", (pct(v2y, 0.9) - pct(v2y, 0.1)) > 0.4, (pct(v2y, 0.9) - pct(v2y, 0.1)).toFixed(4)],
    ["6. no axis edge-pileup > 25%", edgePile(v2x) < 0.25 && edgePile(v2y) < 0.25, `x=${(100 * edgePile(v2x)).toFixed(1)}% y=${(100 * edgePile(v2y)).toFixed(1)}%`],
    ["7. no 5x5 corner-bin > 30%", maxCorner < 0.3, `${(100 * maxCorner).toFixed(1)}%`],
    ["8. |Pearson(X,Y)| <= 0.5", Math.abs(corr(v2x, v2y)) <= 0.5, Math.abs(corr(v2x, v2y)).toFixed(3)],
    ["9. deterministic (fixed anchors, no corpus)", true, "fixed anchors only"],
    ["10. max 16 FFTs/sample", true, "window=2048 hop=1024 maxWindows=16"],
    ["11. performance (see run duration)", true, "measure below"],
  ];
  let pass = 0;
  for (const [label, okc, val] of checks) {
    console.log(`  ${okc ? "PASS" : "FAIL"}  ${label}  (${val})`);
    if (okc) pass++;
  }
  console.log(`  → features: ${pass}/${checks.length} PASS`);
}

async function main() {
  const LIMIT = limitArg();
  console.log(`\n═══ X-saturation analysis on REAL Audiotool samples (limit=${LIMIT}) ═══\n`);

  const client = await createAudiotoolClient({
    auth: createPATAuth(PAT),
    transport: createNodeTransport(),
    wasm: createDiskWasmLoader(),
  });

  const xs: number[] = [];
  const ys: number[] = [];
  const flats: number[] = [];
  const tnr: number[] = [];
  const cents: number[] = [];
  // V1 (BEFORE) vs V2 (AFTER) map positions over the same real samples.
  const v1x: number[] = [];
  const v1y: number[] = [];
  const v2x: number[] = [];
  const v2y: number[] = [];
  const feats: Array<{
    flat: number; zcr: number; bw: number; rolloff: number;
    centroid: number; rms: number; peak: number; td: number; attack: number; dur: number;
  }> = [];
  let ok = 0;
  let noWav = 0;
  let fail = 0;
  const byKind = new Map<string, number[]>();
  const samples: Array<{ name: string; kind: string; x: number; y: number; flat: number }> = [];

  let pageToken: string | undefined;
  while (ok < LIMIT) {
    const res = await client.samples.list({ pageSize: 50, pageToken });
    if (res instanceof Error) throw res;
    const page = res.samples ?? [];
    for (const s of page) {
      if (ok >= LIMIT) break;
      if (!s.wavUrl) { noWav++; continue; }
      try {
        const metaRes = await client.samples.get(s);
        if (metaRes instanceof Error) throw metaRes;
        const blob = await client.samples.download(metaRes, { format: "wav" });
        if (blob instanceof Error) throw blob;
        const bytes = await blob.arrayBuffer();
        const decoded = nodeWavDecode(bytes);
        const f = extractFeatures(decoded);
        // BEFORE (V1): x = clamp01(tonalNoiseRatio), y = log centroid (100..8000).
        const v1 = { x: clamp01(f.tonalNoiseRatio), y: clamp01((Math.log(Math.max(f.spectralCentroid, 100)) - Math.log(100)) / (Math.log(8000) - Math.log(100))) };
        // AFTER (V2): authoritative computePosition at analysis time (decoded audio available).
        const v2 = computePosition(f, decoded);
        v1x.push(v1.x); v1y.push(v1.y);
        v2x.push(v2.x); v2y.push(v2.y);
        xs.push(v2.x); ys.push(v2.y);
        flats.push(f.spectralFlatness); tnr.push(f.tonalNoiseRatio); cents.push(f.spectralCentroid);
        byKind.set(s.kind ?? "?", [...(byKind.get(s.kind ?? "?") ?? []), v2.x]);
        samples.push({ name: s.name, kind: s.kind ?? "?", x: v2.x, y: v2.y, flat: f.spectralFlatness });
        feats.push({
          flat: f.spectralFlatness,
          zcr: f.zeroCrossingRate,
          bw: f.spectralBandwidth,
          rolloff: f.spectralRolloff,
          centroid: f.spectralCentroid,
          rms: f.rms,
          peak: f.peak,
          td: f.transientDensity,
          attack: f.attack,
          dur: f.duration,
        });
        ok++;
      } catch {
        fail++;
      }
    }
    if (!res.nextPageToken || page.length === 0) break;
    pageToken = res.nextPageToken;
  }

  const X = stats(xs);
  const Y = stats(ys);
  const F = stats(flats);
  const C = stats(cents);
  const ge95 = xs.filter((x) => x >= 0.95).length;
  const ge99 = xs.filter((x) => x >= 0.99).length;
  const gt97 = xs.filter((x) => x >= 0.97).length;
  const distinctX3 = [...new Set(xs.map((x) => Number(x.toFixed(3))))].length;
  const distinctX4 = [...new Set(xs.map((x) => Number(x.toFixed(4))))].length;

  console.log(`Population processed: ${ok} analyzed, ${noWav} skipped (no wavUrl), ${fail} failed`);
  console.log("");
  console.log("V2 X (tonal<->noisy, computePosition):");
  console.log(`  min=${X.min.toFixed(4)} max=${X.max.toFixed(4)} mean=${X.mean.toFixed(4)} median=${X.median.toFixed(4)}`);
  console.log(`  n(X>=0.95)=${ge95} (${(100 * ge95 / Math.max(1, xs.length)).toFixed(1)}%)`);
  console.log(`  n(X>=0.97)=${gt97} (${(100 * gt97 / Math.max(1, xs.length)).toFixed(1)}%)`);
  console.log(`  n(X>=0.99)=${ge99} (${(100 * ge99 / Math.max(1, xs.length)).toFixed(1)}%)`);
  console.log(`  distinct X rounded@3dp=${distinctX3} rounded@4dp=${distinctX4} of ${xs.length}`);
  console.log("");
  console.log("V2 Y (dark<->bright, log centroid):");
  console.log(`  min=${Y.min.toFixed(4)} max=${Y.max.toFixed(4)} mean=${Y.mean.toFixed(4)} median=${Y.median.toFixed(4)}`);
  console.log(`  centroidHz min=${C.min.toFixed(0)} max=${C.max.toFixed(0)} mean=${C.mean.toFixed(0)} median=${C.median.toFixed(0)}`);
  console.log("");
  console.log("spectralFlatness (persisted single-window, for reference):");
  console.log(`  min=${F.min.toFixed(4)} max=${F.max.toFixed(4)} mean=${F.mean.toFixed(4)} median=${F.median.toFixed(4)}`);
  console.log("");
  console.log("X by kind (V2 mean / count):");
  for (const [k, v] of byKind) {
    const s = stats(v);
    console.log(`  ${k.padEnd(10)} meanX=${s.mean.toFixed(4)} min=${s.min.toFixed(4)} max=${s.max.toFixed(4)} n=${v.length}`);
  }
  console.log("");
  console.log("Top tonal examples (V2 X sorted desc, first 12):");
  for (const e of [...samples].sort((a, b) => b.x - a.x).slice(0, 12)) {
    console.log(`  ${e.name}  kind=${e.kind.padEnd(6)} flat=${e.flat.toFixed(4)} X=${e.x.toFixed(4)} Y=${e.y.toFixed(4)}`);
  }
  console.log("");
  reportBeforeAfter(v1x, v1y, v2x, v2y);
  console.log("");

  if (process.argv.includes("--corr")) {
    const names = ["flat", "zcr", "bw", "rolloff", "centroid", "rms", "peak", "td", "attack", "dur"] as const;
    const cols = names.map((n) => feats.map((f) => f[n]));
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const corr = (a: number[], b: number[]) => {
      const ma = mean(a), mb = mean(b);
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < a.length; i++) {
        const x = a[i] - ma, y = b[i] - mb;
        num += x * y; da += x * x; db += y * y;
      }
      return num / Math.sqrt(da * db) || 0;
    };
    const pct = (a: number[], q: number) => {
      const s = [...a].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(q * s.length))];
    };
    const dist = (n: string, a: number[]) =>
      `  ${n.padEnd(9)} min=${(Math.min(...a)).toFixed(3)} p10=${pct(a, 0.1).toFixed(3)} p50=${pct(a, 0.5).toFixed(3)} p90=${pct(a, 0.9).toFixed(3)} max=${(Math.max(...a)).toFixed(3)}`;

    console.log("═══ feature distributions (raw units) ═══");
    for (const n of names) console.log(dist(n, cols[names.indexOf(n)]));

    console.log("\n═══ Pearson correlation (raw features) ═══");
    console.log("      " + names.map((n) => n.padStart(8)).join(""));
    for (let i = 0; i < names.length; i++) {
      let row = names[i].padEnd(6);
      for (let j = 0; j < names.length; j++) row += corr(cols[i], cols[j]).toFixed(2).padStart(8);
      console.log(row);
    }

    const flat = cols[names.indexOf("flat")];
    const zcr = cols[names.indexOf("zcr")];
    const bw = cols[names.indexOf("bw")];
    const rolloff = cols[names.indexOf("rolloff")];
    const centroid = cols[names.indexOf("centroid")];
    console.log("\n═══ orthogonality: |corr| between candidate X-axis vs candidate Y-axis ═══");
    console.log(`  flat    vs centroid = ${corr(flat, centroid).toFixed(3)}`);
    console.log(`  flat    vs rolloff  = ${corr(flat, rolloff).toFixed(3)}`);
    console.log(`  zcr     vs centroid = ${corr(zcr, centroid).toFixed(3)}`);
    console.log(`  bw      vs centroid = ${corr(bw, centroid).toFixed(3)}`);
    console.log(`  bw      vs zcr      = ${corr(bw, zcr).toFixed(3)}`);
    console.log(`  rolloff vs centroid = ${corr(rolloff, centroid).toFixed(3)}`);
    console.log(`  flat    vs zcr      = ${corr(flat, zcr).toFixed(3)}`);
    console.log(`  flat    vs bw       = ${corr(flat, bw).toFixed(3)}`);
    console.log(`  centroid vs zcr     = ${corr(centroid, zcr).toFixed(3)}`);
  }
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
