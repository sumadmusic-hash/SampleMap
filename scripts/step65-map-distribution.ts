#!/usr/bin/env -S npx tsx
/**
 * STEP65 — Sample Map point-distribution audit (AUDIT ONLY, no production change).
 *
 * Measures the spatial X/Y distribution of the real analyzed Audiotool corpus
 * (1439 unique samples; the app's real pipeline applied to the real catalogue)
 * under BOTH map-coordinate systems that the production map renders:
 *
 *   1. canonical Sound Space v1.0.0 (`computeCanonicalSoundSpacePoint`) — the
 *      coordinate source the main map prefers for local records (STEP37), and
 *   2. persisted map-v2 (`mapPosition` / mapPosition.ts flatnessToX+centroidToY)
 *      — the coordinate source of the global worker `/map` points and the local
 *      fallback.
 *
 * Uses the PRODUCTION projector functions only. Computes the exact stats the
 * STEP65 task asks for (n/min/max/mean/median/p05/p25/p50/p75/p95, quartile
 * bins, raw pre-normalization values, canvas pixels), category-condit
 * subsets, random-subset stability, and the input-dimension audit for X.
 * Also emits SVG plots (histograms + scatter) into the output dir.
 *
 * Usage: npx tsx scripts/step65-map-distribution.ts
 */
import fs from "node:fs";
import path from "node:path";
import { computeCanonicalSoundSpacePoint } from "../src/analysis/soundSpaceProjector";
// map-v2 fixed X anchors (mapPosition.ts: RAW_X_MIN = -2.0, RAW_X_MAX = 3.0)
const RAW_X_MIN = -2.0;
const RAW_X_MAX = 3.0;

const OUT_DIR = "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step65";
const TMP = "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode";

const LCG = (seed: number) => () => {
  // deterministic PRNG (LCG) for reproducible subsets
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

interface Row {
  sampleId: string;
  name: string;
  cls: string;
  structure: string;
  centroidHz: number | null;
  flatness: number | null;
  soundCharacter: Record<string, number | null> | null;
  mapPosition: { x: number; y: number } | null;
}

function load(): Row[] {
  const out: Row[] = [];
  const seen = new Set<string>();
  const files = [
    `${TMP}/step42/step44-analysis.ndjson`,
    `${TMP}/step44.1/step44.1-analysis.ndjson`,
    `${TMP}/step45/step45-reclass-after.ndjson`,
  ];
  for (const f of files) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const d = JSON.parse(line);
      if (seen.has(d.sampleId)) continue;
      seen.add(d.sampleId);
      const hier = d.full ?? d.hier ?? null;
      const v1 = d.audioFeatures ?? d.classifierFeatures ?? null;
      out.push({
        sampleId: d.sampleId,
        name: d.name ?? d.sampleId,
        cls: (hier && hier.type) || d.primaryClass || (d.legacy && d.legacy.primaryClass) || "unknown",
        structure: (hier && hier.structure) || d.sampleKind || "unknown",
        centroidHz: v1 ? (v1.spectralCentroid ?? null) : null,
        flatness: v1 ? (v1.spectralFlatness ?? null) : null,
        soundCharacter: d.soundCharacter ?? null,
        mapPosition: d.mapPosition ?? null,
      });
    }
  }
  return out;
}

function canonicalXY(row: Row): { x: number; y: number } | null {
  if (!row.soundCharacter) return null;
  const out = computeCanonicalSoundSpacePoint({
    sampleId: row.sampleId,
    analysisV2: { soundCharacter: row.soundCharacter } as never,
  });
  return out ? { x: out.x, y: out.y } : null;
}

function quantile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[idx] ?? NaN;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function axisStats(values: number[]): Record<string, number> {
  const n = values.length;
  const s = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const lt25 = values.filter((v) => v < 0.25).length;
  const r25_50 = values.filter((v) => v >= 0.25 && v <= 0.5).length;
  const r50_75 = values.filter((v) => v > 0.5 && v <= 0.75).length;
  const gt75 = values.filter((v) => v > 0.75).length;
  return {
    n,
    min: s[0],
    max: s[n - 1],
    mean,
    median: quantile(s, 0.5),
    p05: quantile(s, 0.05),
    p25: quantile(s, 0.25),
    p50: quantile(s, 0.5),
    p75: quantile(s, 0.75),
    p95: quantile(s, 0.95),
    std: Math.sqrt(variance),
    skew: (mean - quantile(s, 0.5)) / (Math.sqrt(variance) || 1),
    lt25Frac: lt25 / n,
    r25_50Frac: r25_50 / n,
    r50_75Frac: r50_75 / n,
    gt75Frac: gt75 / n,
    le001: values.filter((v) => v <= 0.01).length,
    ge099: values.filter((v) => v >= 0.99).length,
    exact0: values.filter((v) => v === 0).length,
    exact1: values.filter((v) => v === 1).length,
  };
}

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n === 0) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

const ROUND = (n: number, d: number): number => Number(n.toFixed(d));

// ───────────────────────────────────────────────────────────────── SVG helpers
const W = 560, H = 220, PAD_L = 34, PAD_B = 26, PAD_T = 12, PAD_R = 10;
function svgHeader(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Menlo,monospace" font-size="10">`;
}
function histBars(values: number[], bins: number, color: string, title: string): string {
  const lo = 0, hi = 1;
  const c = new Array(bins).fill(0);
  for (const v of values) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * bins)));
    c[i] += 1;
  }
  const maxC = Math.max(...c, 1);
  const bw = (W - PAD_L - PAD_R) / bins;
  const plotH = H - PAD_B - PAD_T;
  let s = svgHeader();
  s += `<text x="${W / 2}" y="10" text-anchor="middle" font-size="11">${title}</text>`;
  for (let i = 0; i < bins; i++) {
    const bh = (c[i] / maxC) * plotH;
    const x = PAD_L + i * bw;
    const y = PAD_T + plotH - bh;
    s += `<rect x="${ROUND(x, 2)}" y="${ROUND(y, 2)}" width="${ROUND(bw - 1, 2)}" height="${ROUND(bh, 2)}" fill="${color}" opacity="0.85"/>`;
  }
  s += `<line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${W - PAD_R}" y2="${PAD_T + plotH}" stroke="#888"/>`;
  for (const [t, fx] of [["0", 0], ["0.25", 0.25], ["0.5", 0.5], ["0.75", 0.75], ["1", 1]] as const) {
    const x = PAD_L + fx * (W - PAD_L - PAD_R);
    s += `<text x="${ROUND(x, 1)}" y="${H - 8}" text-anchor="middle">${t}</text>`;
  }
  s += `</svg>`;
  return s;
}
function scatterSvg(pts: Array<{ x: number; y: number }>, title: string, color: string): string {
  let s = svgHeader();
  s += `<text x="${W / 2}" y="10" text-anchor="middle" font-size="11">${title}</text>`;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_B - PAD_T;
  // sample down to <= 2000 points for legibility
  const step = Math.max(1, Math.ceil(pts.length / 2000));
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i];
    const px = PAD_L + p.x * plotW;
    const py = PAD_T + (1 - p.y) * plotH;
    s += `<circle cx="${ROUND(px, 1)}" cy="${ROUND(py, 1)}" r="2.2" fill="${color}" opacity="0.5"/>`;
  }
  s += `<line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${W - PAD_R}" y2="${PAD_T + plotH}" stroke="#888"/>`;
  s += `<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + plotH}" stroke="#888"/>`;
  s += `<text x="${W / 2}" y="${H - 8}" text-anchor="middle">X (Noisy → Tonal)</text>`;
  s += `<text x="10" y="${H / 2}" text-anchor="middle" transform="rotate(-90 10 ${H / 2})">Y (Dark → Bright)</text>`;
  s += `</svg>`;
  return s;
}

// ───────────────────────────────────────────────────────────────── main
const rows = load();
const canonical: Array<{ x: number; y: number; row: Row }> = [];
const persisted: Array<{ x: number; y: number; row: Row }> = [];
for (const r of rows) {
  const c = canonicalXY(r);
  if (c) canonical.push({ ...c, row: r });
  if (r.mapPosition) persisted.push({ ...r.mapPosition, row: r });
}

const cX = axisStats(canonical.map((p) => p.x));
const cY = axisStats(canonical.map((p) => p.y));
const pX = axisStats(persisted.map((p) => p.x));
const pY = axisStats(persisted.map((p) => p.y));

// Raw (pre-normalization) values.
// canonical: projector output already in [0,1] (mean + clamp01; mean of two
//   [0,1] values is itself in [0,1], clamp is a no-op) => state A == state B.
// persisted map-v2: rawX = (x)*(5) - 2 (inverse of (rawX+2)/5), NOT yet the
//   log-SNR itself for clipped values (they sit exactly on RAW_X_MIN/MAX).
const cRawX = axisStats(canonical.map((p) => p.x)); // same array (see above)
const pRawX = axisStats(persisted.map((p) => p.x * (RAW_X_MAX - RAW_X_MIN) + RAW_X_MIN));

// canvas (state C): affine toScreen, x_px = x*W, y_px = (1-y)*H (W=800,H=520).
// Bin fractions are computed in normalized [0,1] units (affine preserves them);
// px columns report the pixel magnitudes (min/max/mean/median only).
const Wpx = 800, Hpx = 520;
const axisPx = (s: Record<string, number>, mult: number): Record<string, number> => ({
  ...s,
  min: s.min * mult,
  max: s.max * mult,
  mean: s.mean * mult,
  p05: s.p05 * mult,
  p25: s.p25 * mult,
  p50: s.p50 * mult,
  p75: s.p75 * mult,
  p95: s.p95 * mult,
  median: s.median * mult,
  std: s.std * mult,
  le001: Math.round(s.le001 * 0), // boundary counts computed on normalized units
  ge099: Math.round(s.ge099 * 0),
  exact0: Math.round(s.exact0 * 0),
  exact1: Math.round(s.exact1 * 0),
});
const cXpx = axisPx(cX, Wpx);
const cYpx = axisPx(cY, Hpx);
const pXpx = axisPx(pX, Wpx);
const pYpx = axisPx(pY, Hpx);

// input dimensions & correlations (canonical X vs its inputs)
const tones = canonical.filter((p) => p.row.soundCharacter!.tonality !== null);
const ton = tones.map((p) => p.row.soundCharacter!.tonality!);
const noi = tones.map((p) => p.row.soundCharacter!.noisiness!);
const bri = tones.map((p) => p.row.soundCharacter!.brightness!);
const candX = tones.map((p) => p.x);
const candY = tones.map((p) => p.y);
const dimStats = {
  tonality: axisStats(ton),
  noisiness: axisStats(noi),
  brightness: axisStats(bri),
  corrX_tonality: pearson(candX, ton),
  corrX_noisiness: pearson(candX, noi),
  corrX_1minus_noisiness: pearson(candX, noi.map((v) => 1 - v)),
  corrX_brightness: pearson(candX, bri),
  corrY_brightness: pearson(candY, bri),
  corrY_tonality: pearson(candY, ton),
};

// category-conditioned canonical
const byClass = new Map<string, Array<{ x: number; y: number }>>();
for (const p of canonical) {
  const cls = p.row.cls;
  byClass.set(cls, [...(byClass.get(cls) ?? []), { x: p.x, y: p.y }]);
}
const classRows: Record<string, unknown> = {};
for (const [cls, pts] of [...byClass.entries()].sort()) {
  if (pts.length < 20) continue;
  const mx = axisStats(pts.map((p) => p.x));
  const my = axisStats(pts.map((p) => p.y));
  classRows[cls] = {
    n: pts.length,
    meanX: mx.mean, p50X: mx.p50, p05X: mx.p05, p95X: mx.p95,
    lt25XFrac: mx.lt25Frac, gt75XFrac: mx.gt75Frac,
    meanY: my.mean, p50Y: my.p50,
  };
}

// structure subsets
const byStructure = new Map<string, Array<{ x: number; y: number }>>();
for (const p of canonical) {
  const st = p.row.structure;
  byStructure.set(st, [...(byStructure.get(st) ?? []), { x: p.x, y: p.y }]);
}
const structureRows: Record<string, unknown> = {};
for (const [st, pts] of [...byStructure.entries()].sort()) {
  structureRows[st] = axisStats(pts.map((p) => p.x));
}

// deterministic random subsets
function subsetStats(seed: number, n: number, pts: Array<{ x: number; y: number }>) {
  const rnd = LCG(seed);
  const picked: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rnd() * pts.length);
    picked.push(pts[idx]);
  }
  const mx = axisStats(picked.map((p) => p.x));
  const my = axisStats(picked.map((p) => p.y));
  return { meanX: mx.mean, p50X: mx.p50, lt25Frac: mx.lt25Frac, gt75Frac: mx.gt75Frac, meanY: my.mean };
}

const subsets = {
  seedA: subsetStats(0x5eed, 500, canonical),
  seedB: subsetStats(0xbeef, 500, canonical),
  seedC: subsetStats(0xcafe, 500, canonical),
  seedD: subsetStats(0xdead, 800, canonical),
};

// quadrant / half-plane occupancy (normalized units)
const quadrant = (pts: Array<{ x: number; y: number }>, hidden = false) => {
  const n = pts.length;
  const q = (tx: (v: number) => boolean, ty: (v: number) => boolean) =>
    pts.filter((p) => tx(p.x) && ty(p.y)).length / n;
  const out = {
    n,
    leftHalf: q((v) => v < 0.5, () => true),
    rightHalf: q((v) => v >= 0.5, () => true),
    lowerHalf: q(() => true, (v) => v < 0.5),
    upperHalf: q(() => true, (v) => v >= 0.5),
    lowerRight: q((v) => v >= 0.5, (w) => w < 0.5),
    upperLeft: q((v) => v < 0.5, (w) => w >= 0.5),
    lowerLeft: q((v) => v < 0.5, (w) => w < 0.5),
    upperRight: q((v) => v >= 0.5, (w) => w >= 0.5),
  };
  return hidden ? null : out;
};
const quadrantC = quadrant(canonical)!;
const quadrantP = quadrant(persisted)!;

// output
const fmt = (v: unknown, d = 4) => (typeof v === "number" ? v.toFixed(d) : String(v));
function pad(s: string) { return s.padEnd(24); }
fs.mkdirSync(OUT_DIR, { recursive: true });

const report: Record<string, unknown> = {
  corpus: { unique: rows.length, canonicalProjected: canonical.length, persistedPositions: persisted.length },
  canonical: { x: cX, y: cY, xCanvas: cXpx, yCanvas: cYpx, raw: { x: cRawX } },
  persisted: { x: pX, y: pY, xCanvas: pXpx, yCanvas: pYpx, raw: { x: pRawX } },
  dims: dimStats,
  classes: classRows,
  structures: structureRows,
  subsets,
  quadrants: { canonical: quadrantC, persisted: quadrantP },
};
fs.writeFileSync(path.join(OUT_DIR, "step65-distribution.json"), JSON.stringify(report, null, 2));

const line = (s: Record<string, number>) =>
  `n=${String(s.n).padStart(4)} min=${fmt(s.min)} p05=${fmt(s.p05)} p25=${fmt(s.p25)} p50=${fmt(s.p50)} p75=${fmt(s.p75)} p95=${fmt(s.p95)} max=${fmt(s.max)} mean=${fmt(s.mean)} med=${fmt(s.median)} skew=${fmt(s.skew, 3)}\n` +
  `  <0.25=${fmt(s.lt25Frac * 100, 1)}%  [0.25,0.5]=${fmt(s.r25_50Frac * 100, 1)}%  (0.5,0.75]=${fmt(s.r50_75Frac * 100, 1)}%  >0.75=${fmt(s.gt75Frac * 100, 1)}%  <=0.01=${s.le001}  >=0.99=${s.ge099}  ==0=${s.exact0}  ==1=${s.exact1}`;

console.log(`\nSTEP65 real-corpus audit — unique samples: ${rows.length}`);
console.log(`canonical (Sound Space v1.0.0) projected: ${canonical.length}; persisted map-v2: ${persisted.length}`);
console.log(`\n${pad("X canonical (state B/A)")}`, line(cX));
console.log(`${pad("Y canonical")}`, line(cY));
console.log(`\n${pad("X persisted map-v2")}`, line(pX));
console.log(`${pad("Y persisted map-v2")}`, line(pY));
console.log(`\n${pad("X pre-norm (persisted raw)")}`, line(pRawX));
console.log(`\n${pad("X canvas px (canonical)")}`, line(cXpx));
console.log(`\n${pad("X canvas px (persisted)")}`, line(pXpx));

console.log(`\nSoundCharacter input dims (canonical X inputs):`);
for (const [k, v] of Object.entries(dimStats)) {
  if (typeof v === "number") console.log(`  ${pad(String(k))} ${fmt(v, 4)}`);
  else if (v && typeof v === "object" && "n" in v) console.log(`  ${pad(String(k))} `, line(v as Record<string, number>));
}

console.log(`\nclass-conditioned canonical X (n>=20):`);
for (const [cls, v] of Object.entries(classRows)) {
  const r = v as Record<string, number>;
  console.log(`  ${pad(cls)} n=${String(r.n).padStart(3)} meanX=${fmt(r.meanX)} p50X=${fmt(r.p50X)} p05X=${fmt(r.p05X)} p95X=${fmt(r.p95X)} lt25=${fmt(r.lt25XFrac * 100, 1)}% gt75=${fmt(r.gt75XFrac * 100, 1)}% meanY=${fmt(r.meanY)}`);
}

console.log(`\nstructure subsets (canonical X):`);
for (const [st, v] of Object.entries(structureRows)) {
  const s = v as Record<string, number>;
  console.log(`  ${pad(st)} n=${s.n} meanX=${fmt(s.mean)} p50X=${fmt(s.p50)} lt25=${fmt(s.lt25Frac * 100, 1)}% gt75=${fmt(s.gt75Frac * 100, 1)}%`);
}

console.log(`\nrandom subsets (canonical X, stability check):`);
for (const [k, v] of Object.entries(subsets)) {
  const s = v as Record<string, number>;
  console.log(`  ${pad(k)} meanX=${fmt(s.meanX)} p50X=${fmt(s.p50X)} lt25=${fmt(s.lt25Frac * 100, 1)}% gt75=${fmt(s.gt75Frac * 100, 1)}%`);
}

const qc = (q: NonNullable<typeof quadrantC>) =>
  `${fmt(q.leftHalf * 100, 1)}/L  ${fmt(q.rightHalf * 100, 1)}%R  ${fmt(q.lowerRight * 100, 1)}%LR  ${fmt(q.upperLeft * 100, 1)}%UL`;
console.log(`\nquadrant occupancy:: canonical  leftHalf=${qc(quadrantC)}`);
console.log(`                      persisted  leftHalf=${qc(quadrantP)}`);

// SVG plots
fs.writeFileSync(path.join(OUT_DIR, "plotA-canonical-X-pre-norm-soundspace.svg"),
  histBars(canonical.map((p) => p.x), 20, "#1e88e5",
    `A: canonical X — Sound Space v1.0.0 output (pre-canvas, n=${canonical.length})`));
fs.writeFileSync(path.join(OUT_DIR, "plotA2-persisted-rawX.svg"),
  histBars(persisted.map((p) => p.x * (RAW_X_MAX - RAW_X_MIN) + RAW_X_MIN), 20, "#5e35b1",
    `A2: persisted rawX (pre-normalization, n=${persisted.length})`));
fs.writeFileSync(path.join(OUT_DIR, "plotB-canvas-X.svg"),
  histBars(canonical.map((p) => p.x), 20, "#00897b",
    `B: final canvas X (canonical, affine px → same shape, n=${canonical.length})`));
fs.writeFileSync(path.join(OUT_DIR, "plotC-scatter-canonical.svg"),
  scatterSvg(canonical.map((p) => ({ x: p.x, y: p.y })), `C: final positions (canonical Sound Space, n=${canonical.length})`, "#1e88e5"));
fs.writeFileSync(path.join(OUT_DIR, "plotC2-scatter-persisted.svg"),
  scatterSvg(persisted.map((p) => ({ x: p.x, y: p.y })), `C2: persisted map-v2 positions (n=${persisted.length})`, "#5e35b1"));

console.log(`\nplots written to ${OUT_DIR}/`);
console.log(`json written to ${OUT_DIR}/step65-distribution.json`);