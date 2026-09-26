#!/usr/bin/env -S npx tsx
/**
 * STEP46 — Acoustic Feature Gap & Classification Boundary Audit.
 *
 * AUDIT-FIRST. Measures the actual class boundaries against the actual feature
 * surface (V1 + V2 raw + V2 SoundCharacter) using the STEP45 reference corpus /
 * analysis rows. NO production code is touched — this is a pure read/measure
 * script.
 *
 * For each (boundary, feature) it computes:
 *   - medians (both classes), mean, sd
 *   - P(A>B) (empirical probability a sample of A exceeds a sample of B)
 *   - effect size (Cohen's d using the pooled sd of non-null paired values)
 *   - overlap (min of the two 25–75 percentile spans overlap fraction)
 *   - null rate per class (feature not determinable)
 *   - robustness (how much the effect size changes when the top 10% extremes
 *     are clipped — distinguishes real separation from outlier-driven)
 *
 * Rules: no weighting by class size beyond the actual reference counts; no
 * classifier invocation; no metadata (tags/name) as input — reference classes
 * only define the populations. This never tunes or changes anything.
 *
 * Emits <out>/step46-boundaries.json (all per-boundary stats) and prints a
 * compact per-boundary summary table.
 */
import fs from "node:fs";
import path from "node:path";

function parseArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const ANALYSIS_PATH = parseArg("--analysis") ??
  "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step45/step45-analysis.ndjson";
const OUT_DIR = parseArg("--out") ??
  "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step45";

/**
 * Feature inventory. name → { value, kind }. kind: 'v1raw' | 'v2raw' | 'sc'
 * (SoundCharacter, derived). Duplicates between V1 and V2 raw (e.g. centroid,
 * zcr, flatness) are both measured: V2 (when present) supersedes.
 */
interface FeatureDef {
  v1?: (r: AnalysisRow) => number | null;
  v2?: (r: AnalysisRow) => number | null;
  sc?: (r: AnalysisRow) => number | null;
  unit: string;
  range: string;
}
interface AnalysisRow {
  sampleId: string;
  referenceClass: string | null;
  audioFeatures: Record<string, number>;
  audioFeaturesV2: Record<string, number | null>;
  soundCharacter: Record<string, number | null>;
  metadataDurationSeconds: number;
}

const num = (r: AnalysisRow, k: string): number | null => {
  const v = r.audioFeaturesV2[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const v1num = (r: AnalysisRow, k: string): number | null => {
  const v = r.audioFeatures[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const scnum = (r: AnalysisRow, k: string): number | null => {
  const v = r.soundCharacter[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

// derived features the classifier actually reasons with (thresholds in text)
const isDark = (r: AnalysisRow) => {
  const c = num(r, "spectralCentroidHz") ?? v1num(r, "spectralCentroid");
  return c !== null ? (c < 250 ? 1 : 0) : null;
};
const isDarkMid = (r: AnalysisRow) => {
  const c = num(r, "spectralCentroidHz") ?? v1num(r, "spectralCentroid");
  return c !== null ? (c >= 250 && c < 900 ? 1 : 0) : null;
};
const isBright = (r: AnalysisRow) => {
  const c = num(r, "spectralCentroidHz") ?? v1num(r, "spectralCentroid");
  return c !== null ? (c > 3200 ? 1 : 0) : null;
};
const tsStrong = (r: AnalysisRow) => {
  const ts = num(r, "transientStrength");
  return ts !== null ? (ts >= 3 ? 1 : 0) : null;
};
const decayLong = (r: AnalysisRow) => {
  const d = num(r, "decayTimeSec");
  return d !== null ? (d > 0.12 ? 1 : 0) : null;
};
const slowAttack = (r: AnalysisRow) => {
  const a = num(r, "attackTimeSec");
  return a !== null ? (a >= 1.5 ? 1 : 0) : null;
};
const crestHigh = (r: AnalysisRow) => {
  const c = num(r, "crestFactor");
  return c !== null ? (c >= 5 ? 1 : 0) : null;
};
const flatMid = (r: AnalysisRow) => {
  const f = num(r, "spectralFlatness") ?? v1num(r, "spectralFlatness");
  return f !== null ? (f >= 0.1 && f <= 0.5 ? 1 : 0) : null;
};

const F: Record<string, FeatureDef> = {
  durationSec: { v2: (r) => num(r, "durationSec"), v1: (r) => v1num(r, "duration"), unit: "s", range: ">=0" },
  rms: { v2: (r) => num(r, "rms"), v1: (r) => v1num(r, "rms"), unit: "amp", range: ">=0" },
  peak: { v2: (r) => num(r, "peak"), v1: (r) => v1num(r, "peak"), unit: "amp", range: ">=0" },
  crestFactor: { v2: (r) => num(r, "crestFactor"), unit: "ratio", range: ">=1|null" },
  transientStrength: { v2: (r) => num(r, "transientStrength"), unit: "", range: ">=0|null" },
  zeroCrossingRate: { v2: (r) => num(r, "zeroCrossingRate"), v1: (r) => v1num(r, "zeroCrossingRate"), unit: "ratio", range: "0..1" },
  spectralCentroidHz: { v2: (r) => num(r, "spectralCentroidHz"), v1: (r) => v1num(r, "spectralCentroid"), unit: "Hz", range: ">=0|null" },
  spectralSpreadHz: { v2: (r) => num(r, "spectralSpreadHz"), v1: (r) => v1num(r, "spectralBandwidth"), unit: "Hz", range: ">=0|null" },
  spectralRolloffHz: { v2: (r) => num(r, "spectralRolloffHz"), v1: (r) => v1num(r, "spectralRolloff"), unit: "Hz", range: ">=0|null" },
  spectralFlatness: { v2: (r) => num(r, "spectralFlatness"), v1: (r) => v1num(r, "spectralFlatness"), unit: "", range: "0..1|null" },
  spectralFlux: { v2: (r) => num(r, "spectralFlux"), unit: "", range: ">=0|null" },
  spectralSlope: { v2: (r) => num(r, "spectralSlope"), unit: "", range: "signed|null" },
  attackTimeSec: { v2: (r) => num(r, "attackTimeSec"), v1: (r) => v1num(r, "attack"), unit: "s", range: ">=0|null" },
  decayTimeSec: { v2: (r) => num(r, "decayTimeSec"), unit: "s", range: ">=0|null" },
  pitchHz: { v2: (r) => num(r, "pitchHz"), unit: "Hz", range: ">=0|null" },
  pitchConfidence: { v2: (r) => num(r, "pitchConfidence"), unit: "", range: "0..1|null" },
  harmonicity: { v2: (r) => num(r, "harmonicity"), unit: "", range: "0..1|null" },
  inharmonicity: { v2: (r) => num(r, "inharmonicity"), unit: "", range: "0..1|null" },
  transientDensity: { v1: (r) => v1num(r, "transientDensity"), unit: "", range: ">=0" },
  tonalNoiseRatio: { v1: (r) => v1num(r, "tonalNoiseRatio"), unit: "", range: "0..1" },
  // SoundCharacter (derived, V2 downstream) — for VOLUME of the representation
  sc_brightness: { sc: (r) => scnum(r, "brightness"), unit: "", range: "0..1|null" },
  sc_density: { sc: (r) => scnum(r, "density"), unit: "", range: "0..1|null" },
  sc_transient: { sc: (r) => scnum(r, "transient"), unit: "", range: "0..1|null" },
  sc_duration: { sc: (r) => scnum(r, "duration"), unit: "", range: "0..1|null" },
  sc_tonality: { sc: (r) => scnum(r, "tonality"), unit: "", range: "0..1|null" },
  sc_noisiness: { sc: (r) => scnum(r, "noisiness"), unit: "", range: "0..1|null" },
  sc_dynamics: { sc: (r) => scnum(r, "dynamics"), unit: "", range: "0..1|null" },
  sc_complexity: { sc: (r) => scnum(r, "complexity"), unit: "", range: "0..1|null" },
  // derived binary discriminators the classifier actually uses
  isDark: { v2: isDark, unit: "", range: "0/1" },
  isDarkMid: { v2: isDarkMid, unit: "", range: "0/1" },
  isBright: { v2: isBright, unit: "", range: "0/1" },
  tsStrong: { v2: tsStrong, unit: "", range: "0/1" },
  decayLong: { v2: decayLong, unit: "", range: "0/1" },
  slowAttack: { v2: slowAttack, unit: "", range: "0/1" },
  crestHigh: { v2: crestHigh, unit: "", range: "0/1" },
  flatMid: { v2: flatMid, unit: "", range: "0/1" },
};

const FEATURES = Object.keys(F);

// All important boundary pairs (§7). Drums + instruments.
const BOUNDARIES: Array<[string, string]> = [
  // percussion
  ["kick", "snare"], ["kick", "clap"], ["kick", "percussion"], ["kick", "tom"],
  ["snare", "clap"], ["snare", "percussion"], ["snare", "hihat"], ["snare", "tom"],
  ["clap", "percussion"], ["hihat", "openhat"], ["hihat", "cymbal"], ["openhat", "cymbal"],
  ["tom", "percussion"],
  // musical instruments
  ["piano", "keys"], ["piano", "strings"], ["guitar", "keys"], ["synth", "pad"],
  ["synth", "lead"], ["lead", "pad"], ["pad", "strings"],
];

function loadRows(): AnalysisRow[] {
  const rows: AnalysisRow[] = [];
  for (const line of fs.readFileSync(ANALYSIS_PATH, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind !== "analysis" || !r.referenceClass) continue;
      if (r.corpusRole !== "reference") continue;
      rows.push({
        sampleId: r.sampleId,
        referenceClass: r.referenceClass,
        audioFeatures: r.audioFeatures ?? {},
        audioFeaturesV2: r.audioFeaturesV2 ?? {},
        soundCharacter: r.soundCharacter ?? {},
        metadataDurationSeconds: r.metadataDurationSeconds ?? 0,
      });
    } catch {
      // torn tail
    }
  }
  return rows;
}

function getAll(r: AnalysisRow, f: FeatureDef): number | null {
  if (f.v2 !== undefined) {
    const v = f.v2(r);
    if (v !== null) return v;
  }
  if (f.v1 !== undefined) {
    const v = f.v1(r);
    if (v !== null) return v;
  }
  if (f.sc !== undefined) return f.sc(r);
  return null;
}

const median = (arr: number[]) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (arr: number[], q: number) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
};
const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const sd = (arr: number[]) => {
  if (arr.length < 2) return null;
  const m = mean(arr)!;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
};
const cohenD = (a: number[], b: number[]) => {
  if (a.length < 2 || b.length < 2) return null;
  const pooled = Math.sqrt((sd(a)! ** 2 + sd(b)! ** 2) / 2);
  if (pooled === 0) return null;
  return (mean(a)! - mean(b)!) / pooled;
};
const pAB = (a: number[], b: number[]) => {
  if (!a.length || !b.length) return null;
  let gt = 0;
  for (const x of a) for (const y of b) if (x > y) gt++;
  return gt / (a.length * b.length);
};
/** 25–75 percentile span overlap (fraction of min span occupied by both). */
const overlap = (a: number[], b: number[]) => {
  if (a.length < 4 || b.length < 4) return null;
  const aLo = pct(a, 0.25)!, aHi = pct(a, 0.75)!;
  const bLo = pct(b, 0.25)!, bHi = pct(b, 0.75)!;
  const aSpan = aHi - aLo, bSpan = bHi - bLo;
  if (aSpan <= 0 || bSpan <= 0) return null;
  const inner = Math.min(aHi, bHi) - Math.max(aLo, bLo);
  return Math.max(0, inner / Math.min(aSpan, bSpan));
};

function main() {
  const rows = loadRows();
  const byClass = new Map<string, AnalysisRow[]>();
  for (const r of rows) {
    const arr = byClass.get(r.referenceClass!) ?? [];
    arr.push(r);
    byClass.set(r.referenceClass!, arr);
  }
  const classes = [...byClass.keys()].sort();
  const counts: Record<string, number> = {};
  for (const c of classes) counts[c] = byClass.get(c)!.length;

  const boundaryOut: Record<string, any> = {};
  for (const [a, b] of BOUNDARIES) {
    const A = byClass.get(a) ?? [];
    const B = byClass.get(b) ?? [];
    const feats: Record<string, any> = {};
    const summary: Record<string, any> = {};
    for (const fn of FEATURES) {
      const def = F[fn];
      const av = A.map((r) => getAll(r, def)).filter((v): v is number => v !== null);
      const bv = B.map((r) => getAll(r, def)).filter((v): v is number => v !== null);
      const nullA = A.length ? A.length - av.length : 0;
      const nullB = B.length ? B.length - bv.length : 0;
      const ca = cohenD(av, bv);
      const clipped = ca !== null && av.length >= 3 && bv.length >= 3 ? (() => {
        // clip top 10% and bottom 10% of each (by value magnitude) to see if the
        // effect is outlier-driven; recompute Cohen's d
        const clip = (arr: number[]) => {
          const s = [...arr].sort((x, y) => x - y);
          const lo = Math.max(1, Math.floor(s.length * 0.1));
          const hi = Math.min(s.length, s.length - Math.floor(s.length * 0.1) + 1);
          return s.slice(lo, hi);
        };
        const ac = clip(av), bc = clip(bv);
        return cohenD(ac, bc);
      })() : null;
      feats[fn] = {
        medianA: median(av), medianB: median(bv),
        q1A: pct(av, 0.25), q3A: pct(av, 0.75),
        q1B: pct(bv, 0.25), q3B: pct(bv, 0.75),
        cohenD: ca,
        cohenDClipped: clipped,
        pAB: pAB(av, bv),
        overlap: overlap(av, bv),
        nullRateA: A.length ? nullA / A.length : null,
        nullRateB: B.length ? nullB / B.length : null,
        nA: av.length, nB: bv.length,
        unit: def.unit,
      };
      summary[fn] = {
        es: ca === null ? null : Math.abs(ca),
        esClipped: clipped === null ? null : Math.abs(clipped),
        pAB: feats[fn].pAB,
        overlap: feats[fn].overlap,
      };
    }
    boundaryOut[`${a}/${b}`] = { a, b, counts: { [a]: A.length, [b]: B.length }, features: feats, summary };
  }

  // Which features best separate which boundary? (by |effect size|)
  const bestByBoundary: Record<string, Record<string, number>> = {};
  for (const key of Object.keys(boundaryOut)) {
    const bd = boundaryOut[key];
    const ranked = FEATURES.map((fn) => ({ fn, es: Math.abs(bd.features[fn].cohenD ?? 0) }))
      .sort((x, y) => y.es - x.es);
    bestByBoundary[key] = {
      best: ranked[0],
      second: ranked[1],
      third: ranked[2],
    };
  }

  const out = { audit: "STEP46 boundary audit", n: rows.length, counts, boundaries: boundaryOut, bestByBoundary };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "step46-boundaries.json"), JSON.stringify(out, null, 2) + "\n");

  console.log(`STEP46 boundary audit — rows=${rows.length}`);
  console.log(`class counts: ${JSON.stringify(counts)}\n`);
  console.log("| boundary | counts | best feature | es | es(clip) | P(A>B) | 2nd feature |");
  console.log("|---|---|---|---|---|---|---|");
  for (const key of Object.keys(boundaryOut)) {
    const bb = bestByBoundary[key];
    const f0 = bb.best, f1 = bb.second;
    const d0 = boundaryOut[key].features[f0.fn];
    const d1 = boundaryOut[key].features[f1.fn];
    console.log(`| ${key} | ${boundaryOut[key].counts[boundaryOut[key].a]}/${boundaryOut[key].counts[boundaryOut[key].b]} | ${f0.fn} (d=${d0.cohenD?.toFixed(2) ?? "null"}) | ${(d0.cohenD ?? 0) === null ? "—" : Math.abs(d0.cohenD!).toFixed(2)} | ${d0.cohenDClipped === null ? "—" : Math.abs(d0.cohenDClipped!).toFixed(2)} | ${d0.pAB?.toFixed(3) ?? "—"} | ${f1.fn} (d=${d1.cohenD?.toFixed(2) ?? "null"}) |`);
  }
  console.log(`\nwrote ${path.join(OUT_DIR, "step46-boundaries.json")}`);
}

main();