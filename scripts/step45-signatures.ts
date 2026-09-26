#!/usr/bin/env -S npx tsx
/**
 * STEP45 — Acoustic Class Signatures & Feature Discrimination (§8–§10).
 *
 * Descriptive statistics per reference class over the MEASURED features of the
 * STEP45 corpus (V1 + full V2 + SoundCharacter), then a discrimination analysis:
 * every (class, feature) pair is measured against its NEAREST competing class
 * with a pooled-sd effect size |medA − medB| / sqrt(mean(varA, varB)) and a
 * Mann-Whitney separation score (P(A > B)), then labelled STRONG / MODERATE /
 * WEAK / NON-DISCRIMINATOR from the measured distributions.
 *
 * Pure + deterministic. No network. Nulls are reported (nullRate) and never
 * substituted with zeros.
 *
 * Usage: npx tsx scripts/step45-signatures.ts [--out <dir>] [--an <analysis.ndjson>]
 * Emits:
 *   <dir>/step45-signatures.json        machine-readable statistics
 *   <dir>/step45-signatures.md          markdown tables for the STEP45 report
 */
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = parseArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step45";
const ANALYSIS_PATH = parseArg("--an") ?? path.join(OUT_DIR, "step45-analysis.ndjson");

const DRUMS = ["kick", "snare", "clap", "hihat", "openhat", "tom", "cymbal", "percussion"];
const MUSICAL = ["bass", "piano", "guitar", "strings", "keys", "synth", "pad", "lead"];

const FEATURES: Array<{ key: string; label: string; source: "v1" | "v2" | "char" }> = [
  { key: "duration", label: "duration (s)", source: "v1" },
  { key: "spectralCentroid", label: "centroid (V1 Hz)", source: "v1" },
  { key: "spectralCentroidHz", label: "centroid (V2 Hz)", source: "v2" },
  { key: "spectralRolloffHz", label: "rolloff (Hz)", source: "v2" },
  { key: "spectralSpreadHz", label: "spread/bw (Hz)", source: "v2" },
  { key: "spectralBandwidth", label: "bandwidth (V1 Hz)", source: "v1" },
  { key: "spectralFlatness", label: "flatness", source: "v2" },
  { key: "spectralFlux", label: "flux", source: "v2" },
  { key: "spectralSlope", label: "slope", source: "v2" },
  { key: "zeroCrossingRate", label: "zcr", source: "v1" },
  { key: "crestFactor", label: "crest", source: "v2" },
  { key: "transientStrength", label: "transient", source: "v2" },
  { key: "transientDensity", label: "transientDensity", source: "v1" },
  { key: "attackTimeSec", label: "attack (s)", source: "v2" },
  { key: "attack", label: "attack (V1)", source: "v1" },
  { key: "decayTimeSec", label: "decay (s)", source: "v2" },
  { key: "rms", label: "rms", source: "v1" },
  { key: "peak", label: "peak", source: "v1" },
  { key: "pitchHz", label: "pitch (Hz)", source: "v2" },
  { key: "pitchConfidence", label: "pitchConfidence", source: "v2" },
  { key: "harmonicity", label: "harmonicity", source: "v2" },
  { key: "inharmonicity", label: "inharmonicity", source: "v2" },
  { key: "tonalNoiseRatio", label: "tonalNoiseRatio", source: "v1" },
  { key: "brightness", label: "char:brightness", source: "char" },
  { key: "density", label: "char:density", source: "char" },
  { key: "transient", label: "char:transient", source: "char" },
  { key: "tonality", label: "char:tonality", source: "char" },
  { key: "noisiness", label: "char:noisiness", source: "char" },
  { key: "dynamics", label: "char:dynamics", source: "char" },
  { key: "complexity", label: "char:complexity", source: "char" },
];

const PAIRS: Array<[string, string]> = [
  ["kick", "snare"],
  ["kick", "clap"],
  ["snare", "clap"],
  ["snare", "hihat"],
  ["hihat", "openhat"],
  ["openhat", "cymbal"],
  ["cymbal", "openhat"],
  ["tom", "percussion"],
  ["tom", "snare"],
  ["snare", "percussion"],
  ["hihat", "percussion"],
  ["clap", "percussion"],
  ["bass", "synth"],
  ["piano", "keys"],
  ["piano", "strings"],
  ["guitar", "keys"],
  ["synth", "pad"],
  ["synth", "lead"],
  ["lead", "pad"],
  ["pad", "strings"],
];

function parseArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function loadRows(): any[] {
  const out: any[] = [];
  for (const line of fs.readFileSync(ANALYSIS_PATH, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind === "analysis" && r.corpusRole === "reference" && r.referenceClass) out.push(r);
    } catch {
      // torn tail
    }
  }
  return out;
}

function featValue(row: any, key: string): number | null {
  const v = row.audioFeaturesV2?.[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const v1 = row.audioFeatures?.[key];
  if (typeof v1 === "number" && Number.isFinite(v1)) return v1;
  const c = row.soundCharacter?.[key];
  if (typeof c === "number" && Number.isFinite(c)) return c;
  return null;
}

function stats(nums: number[]): Record<string, number> {
  if (nums.length === 0) return { n: 0, mean: NaN, sd: NaN, min: NaN, q1: NaN, median: NaN, q3: NaN, max: NaN };
  const s = [...nums].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const sd = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length);
  return {
    n: nums.length,
    mean: Math.round(mean * 1000) / 1000,
    sd: Math.round(sd * 1000) / 1000,
    min: Math.round(q(0) * 1000) / 1000,
    q1: Math.round(q(0.25) * 1000) / 1000,
    median: Math.round(q(0.5) * 1000) / 1000,
    q3: Math.round(q(0.75) * 1000) / 1000,
    max: Math.round(q(1) * 1000) / 1000,
  };
}

/** P(A > B) over pairwise comparisons (Mann-Whitney style); 0.5 = no separation. */
function sepScore(a: number[], b: number[]): number {
  let gt = 0;
  let n = 0;
  for (const x of a) {
    for (const y of b) {
      n++;
      if (x > y) gt++;
    }
  }
  return n === 0 ? 0.5 : Math.round((gt / n) * 1000) / 1000;
}

function verdict(es: number, sep: number): string {
  const directed = Math.max(sep, 1 - sep);
  if (es >= 2 || directed >= 0.85) return "STRONG";
  if (es >= 1 || directed >= 0.7) return "MODERATE";
  if (es >= 0.5 || directed >= 0.6) return "WEAK";
  return "NON-DISCRIMINATOR";
}

function main() {
  const rows = loadRows();
  const byClass: Record<string, any[]> = {};
  for (const r of rows) (byClass[r.referenceClass] ??= []).push(r);

  const perClass: Record<string, Record<string, Record<string, number> & { nullRate: number }>> = {};
  for (const [clazz, rs] of Object.entries(byClass)) {
    perClass[clazz] = {};
    for (const f of FEATURES) {
      const present: number[] = [];
      let nullCount = 0;
      for (const r of rs) {
        const v = featValue(r, f.key);
        if (v === null) nullCount++;
        else present.push(v);
      }
      perClass[clazz][f.key] = { ...stats(present), nullRate: Math.round((nullCount / rs.length) * 1000) / 1000 };
    }
  }

  const discrimination: Record<string, any> = {};
  for (const [a, b] of PAIRS) {
    const ra = byClass[a] ?? [];
    const rb = byClass[b] ?? [];
    if (ra.length === 0 || rb.length === 0) continue;
    const perFeature: Record<string, any> = {};
    for (const f of FEATURES) {
      const va: number[] = [];
      const vb: number[] = [];
      for (const r of ra) { const v = featValue(r, f.key); if (v !== null) va.push(v); }
      for (const r of rb) { const v = featValue(r, f.key); if (v !== null) vb.push(v); }
      if (va.length < 3 || vb.length < 3) {
        perFeature[f.key] = { verdict: "INSUFFICIENT", effectSize: null, sep: null };
        continue;
      }
      const mA = stats(va).median;
      const mB = stats(vb).median;
      const sdA = stats(va).sd;
      const sdB = stats(vb).sd;
      const pooled = Math.sqrt((sdA * sdA + sdB * sdB) / 2) || 1e-9;
      const es = Math.abs(mA - mB) / pooled;
      const sep = sepScore(va, vb);
      perFeature[f.key] = {
        aMedian: mA,
        bMedian: mB,
        effectSize: Math.round(es * 1000) / 1000,
        pAGtB: sep,
        verdict: verdict(es, sep),
      };
    }
    discrimination[`${a}↔${b}`] = perFeature;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ── markdown ───────────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push("# STEP45 — acoustic class signatures (measured)");
  lines.push("");
  lines.push(`Corpus: ${rows.length} reference rows analyzed; per-class n below.`);
  lines.push("");

  const HEADER = "| class | n | mean | sd | min | q1 | median | q3 | max | nullRate |";
  const ROW = "|---|---|---|---|---|---|---|---|---|---|";
  for (const clazz of Object.keys(byClass).sort()) {
    const rs = byClass[clazz];
    const fkeys = ["duration", "spectralCentroidHz", "spectralRolloffHz", "spectralSpreadHz", "spectralFlatness", "spectralFlux", "zeroCrossingRate", "crestFactor", "transientStrength", "attackTimeSec", "decayTimeSec", "pitchHz", "harmonicity", "brightness", "noisiness", "tonality"];
    lines.push(`## class: ${clazz} (n=${rs.length})`);
    lines.push("");
    lines.push(HEADER);
    lines.push(ROW);
    for (const fk of fkeys) {
      const s = perClass[clazz][fk];
      if (!s) continue;
      lines.push(
        `| ${fk} | ${s.n} | ${s.mean} | ${s.sd} | ${s.min} | ${s.q1} | ${s.median} | ${s.q3} | ${s.max} | ${s.nullRate} |`,
      );
    }
    lines.push("");
  }

  lines.push("# Discrimination (vs nearest competing class)");
  lines.push("");
  for (const [pair, perFeature] of Object.entries(discrimination)) {
    const [a, b] = pair.split("↔");
    lines.push(`## ${pair}`);
    lines.push("");
    lines.push("| feature | aMedian | bMedian | effectSize | P(a>b) | verdict |");
    lines.push("|---|---|---|---|---|---|");
    const sorted = Object.entries(perFeature)
      .map(([k, v]) => ({ k, ...(v as any) }))
      .sort((x, y) => (y.effectSize ?? 0) - (x.effectSize ?? 0))
      .slice(0, 12);
    for (const row of sorted) {
      const label = FEATURES.find((f) => f.key === row.k)?.label ?? row.k;
      lines.push(`| ${label} | ${row.aMedian} | ${row.bMedian} | ${row.effectSize} | ${row.pAGtB} | ${row.verdict} |`);
    }
    lines.push("");
  }

  // ── summary: best discriminator per class-pair ─────────────────────────────
  lines.push("# Per-pair best discriminators");
  lines.push("");
  lines.push("| pair | discriminator | effectSize | verdict |");
  lines.push("|---|---|---|---|");
  for (const [pair, perFeature] of Object.entries(discrimination)) {
    const best = Object.entries(perFeature)
      .map(([k, v]) => ({ k, ...(v as any) }))
      .sort((x, y) => (y.effectSize ?? 0) - (x.effectSize ?? 0))[0];
    if (!best) continue;
    lines.push(`| ${pair} | ${FEATURES.find((f) => f.key === best.k)?.label ?? best.k} | ${best.effectSize} | ${best.verdict} |`);
  }
  lines.push("");

  fs.writeFileSync(path.join(OUT_DIR, "step45-signatures.md"), lines.join("\n"));

  const json = {
    analyzer: "step45-signatures",
    generatedAt: new Date().toISOString(),
    n: rows.length,
    perClass,
    discrimination,
    note: "effectSize = |medianA − medianB| / pooled-sd; P(a>b) = chance a random class-A value exceeds a random class-B value. Labels from MEASURED separation.",
  };
  fs.writeFileSync(path.join(OUT_DIR, "step45-signatures.json"), JSON.stringify(json, null, 2) + "\n");
  console.log(`wrote step45-signatures.json + step45-signatures.md (classes=${Object.keys(byClass).length})`);
}

main();