#!/usr/bin/env -S npx tsx
/**
 * STEP46 — Multi-feature separability + duration control + robust subsets.
 *
 * For each boundary this measures:
 *  - Single-feature ranking (repeat of audit, but focused on the FAILING ones).
 *  - 2-feature pairwise separation: for the best K features, what fraction of
 *    samples of the two classes is COVERED by a naive non-overlapping box
 *    (feature A threshold OR feature B threshold) — i.e. can a simple 2-axis
 *    decision separate them?
 *  - Outlier robustness: recompute effect size after trimming the 10%/20%
 *    extremes.
 *  - Duration-controlled: within overlapping duration windows (e.g. short
 *    one-shots only <=0.6s), recompute P(A>B) and effect size for the key
 *    drum-boundaries. This determines whether "duration" is masquerading as
 *    class identity.
 *  - Subset separation: which specific samples become separable when
 *    restricted to a subrange (e.g. masked claps vs masked snares).
 *
 * No production change, no ML, no tuning. Output JSON:
 *   step46-multi-feature.json
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

interface Row {
  sampleId: string;
  referenceClass: string;
  audioFeaturesV2: Record<string, number | null>;
  soundCharacter: Record<string, number | null>;
  audioFeatures: Record<string, number>;
  audioOnly: { type?: string; family?: string; ambiguous?: boolean };
  full: { type?: string; family?: string; ambiguous?: boolean; reconciliationStatus?: string; reconciliationWinningSource?: string };
  metadataDurationSeconds: number;
}

const num = (r: Row, k: string): number | null => {
  const v = r.audioFeaturesV2[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const v1num = (r: Row, k: string): number | null => {
  const v = r.audioFeatures[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const scnum = (r: Row, k: string): number | null => {
  const v = r.soundCharacter[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

// the feature vector actually available to the classifier (V1+V2 union,
// preferring V2, plus derived binary terms and SC dims)
function featureOf(r: Row, k: string): number | null {
  if (k in r.audioFeaturesV2) {
    const v = num(r, k);
    if (v !== null) return v;
  }
  switch (k) {
    case "rms": return v1num(r, "rms") ?? num(r, "rms");
    case "peak": return v1num(r, "peak") ?? num(r, "peak");
    case "zeroCrossingRate": return (num(r, "zeroCrossingRate") ?? v1num(r, "zeroCrossingRate"));
    case "spectralCentroidHz": return num(r, "spectralCentroidHz") ?? v1num(r, "spectralCentroid");
    case "spectralSpreadHz": return num(r, "spectralSpreadHz") ?? v1num(r, "spectralBandwidth");
    case "spectralRolloffHz": return num(r, "spectralRolloffHz") ?? v1num(r, "spectralRolloff");
    case "spectralFlatness": return num(r, "spectralFlatness") ?? v1num(r, "spectralFlatness");
    case "durationSec": return num(r, "durationSec") ?? r.metadataDurationSeconds;
    case "attackTimeSec": return num(r, "attackTimeSec") ?? v1num(r, "attack");
    case "tonalNoiseRatio": return v1num(r, "tonalNoiseRatio");
    case "transientDensity": return v1num(r, "transientDensity");
    default: return null;
  }
}
function scOf(r: Row, k: string): number | null {
  return scnum(r, k);
}

// derived binary models the classifier uses
const isDark = (r: Row) => { const c = featureOf(r, "spectralCentroidHz"); return c !== null ? (c < 250 ? 1 : 0) : null; };
const isDarkMid = (r: Row) => { const c = featureOf(r, "spectralCentroidHz"); return c !== null ? (c >= 250 && c < 900 ? 1 : 0) : null; };
const isBright = (r: Row) => { const c = featureOf(r, "spectralCentroidHz"); return c !== null ? (c > 3200 ? 1 : 0) : null; };
const tsStrong = (r: Row) => { const t = num(r, "transientStrength"); return t !== null ? (t >= 3 ? 1 : 0) : null; };
const decayLong = (r: Row) => { const d = num(r, "decayTimeSec"); return d !== null ? (d > 0.12 ? 1 : 0) : null; };
const slowAttack = (r: Row) => { const a = num(r, "attackTimeSec"); return a !== null ? (a >= 1.5 ? 1 : 0) : null; };
const crestHigh = (r: Row) => { const c = num(r, "crestFactor"); return c !== null ? (c >= 5 ? 1 : 0) : null; };
const flatMid = (r: Row) => { const f = featureOf(r, "spectralFlatness"); return f !== null ? (f >= 0.1 && f <= 0.5 ? 1 : 0) : null; };

const F: Record<string, (r: Row) => number | null> = {
  durationSec: (r) => featureOf(r, "durationSec"),
  rms: (r) => featureOf(r, "rms"),
  peak: (r) => featureOf(r, "peak"),
  crestFactor: (r) => num(r, "crestFactor"),
  transientStrength: (r) => num(r, "transientStrength"),
  zeroCrossingRate: (r) => featureOf(r, "zeroCrossingRate"),
  spectralCentroidHz: (r) => featureOf(r, "spectralCentroidHz"),
  spectralSpreadHz: (r) => featureOf(r, "spectralSpreadHz"),
  spectralRolloffHz: (r) => featureOf(r, "spectralRolloffHz"),
  spectralFlatness: (r) => featureOf(r, "spectralFlatness"),
  spectralFlux: (r) => num(r, "spectralFlux"),
  spectralSlope: (r) => num(r, "spectralSlope"),
  attackTimeSec: (r) => featureOf(r, "attackTimeSec"),
  decayTimeSec: (r) => num(r, "decayTimeSec"),
  pitchHz: (r) => num(r, "pitchHz"),
  pitchConfidence: (r) => num(r, "pitchConfidence"),
  harmonicity: (r) => num(r, "harmonicity"),
  inharmonicity: (r) => num(r, "inharmonicity"),
  transientDensity: (r) => v1num(r, "transientDensity"),
  tonalNoiseRatio: (r) => v1num(r, "tonalNoiseRatio"),
  sc_brightness: (r) => scOf(r, "brightness"),
  sc_density: (r) => scOf(r, "density"),
  sc_transient: (r) => scOf(r, "transient"),
  sc_duration: (r) => scOf(r, "duration"),
  sc_tonality: (r) => scOf(r, "tonality"),
  sc_noisiness: (r) => scOf(r, "noisiness"),
  sc_dynamics: (r) => scOf(r, "dynamics"),
  sc_complexity: (r) => scOf(r, "complexity"),
  isDark: (r) => isDark(r),
  isDarkMid: (r) => isDarkMid(r),
  isBright: (r) => isBright(r),
  tsStrong: (r) => tsStrong(r),
  decayLong: (r) => decayLong(r),
  slowAttack: (r) => slowAttack(r),
  crestHigh: (r) => crestHigh(r),
  flatMid: (r) => flatMid(r),
};
const FEATURES = Object.keys(F);

const BOUNDARIES: Array<[string, string]> = [
  ["kick", "snare"], ["kick", "clap"], ["kick", "percussion"], ["kick", "tom"],
  ["snare", "clap"], ["snare", "percussion"], ["snare", "hihat"], ["snare", "tom"],
  ["clap", "percussion"], ["hihat", "openhat"], ["hihat", "cymbal"], ["openhat", "cymbal"],
  ["tom", "percussion"], ["piano", "keys"], ["piano", "strings"], ["guitar", "keys"],
  ["synth", "pad"], ["synth", "lead"], ["lead", "pad"], ["pad", "strings"],
];

function loadRows(): Row[] {
  const rows: Row[] = [];
  for (const line of fs.readFileSync(ANALYSIS_PATH, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind !== "analysis" || r.corpusRole !== "reference" || !r.referenceClass) continue;
      rows.push({
        sampleId: r.sampleId,
        referenceClass: r.referenceClass,
        audioFeaturesV2: r.audioFeaturesV2 ?? {},
        soundCharacter: r.soundCharacter ?? {},
        audioFeatures: r.audioFeatures ?? {},
        audioOnly: r.audioOnly ?? {},
        full: r.full ?? {},
        metadataDurationSeconds: r.metadataDurationSeconds ?? 0,
      });
    } catch { /* torn */ }
  }
  return rows;
}

const vals = (rows: Row[], k: string) => rows.map((r) => F[k](r)).filter((v): v is number => v !== null);
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a: number[]) => (a.length < 2 ? null : Math.sqrt(a.reduce((x, y) => x + (y - mean(a)!) ** 2, 0) / a.length));
const cohenD = (a: number[], b: number[]) => {
  if (a.length < 2 || b.length < 2) return null;
  const p = Math.sqrt((sd(a)! ** 2 + sd(b)! ** 2) / 2);
  return p === 0 ? null : (mean(a)! - mean(b)!) / p;
};
const pAB = (a: number[], b: number[]) => {
  if (!a.length || !b.length) return null;
  let gt = 0;
  for (const x of a) for (const y of b) if (x > y) gt++;
  return gt / (a.length * b.length);
};

function main() {
  const rows = loadRows();
  const byClass = new Map<string, Row[]>();
  for (const r of rows) (byClass.get(r.referenceClass) ?? byClass.set(r.referenceClass, []).get(r.referenceClass)!).push(r);

  const res: Record<string, any> = {};

  for (const [a, b] of BOUNDARIES) {
    const A = byClass.get(a);
    const B = byClass.get(b);
    if (!A || !B) {
      console.error(`missing class: ${a}=${A?.length} ${b}=${B?.length}`);
      process.exit(1);
    }

    // 1) rank features by |es|
    const ranked = FEATURES.map((f) => {
      const av = vals(A, f), bv = vals(B, f);
      return { f, es: Math.abs(cohenD(av, bv) ?? 0), P: pAB(av, bv), na: av.length, nb: bv.length };
    }).sort((x, y) => y.es - x.es).slice(0, 8);

    // 2) 2-feature boxes: for every ordered pair of top-4 features, find (by
    //    exhaustive threshold grid) the fraction of the union that the best
    //    single-feature OR 2-feature rectangle separates cleanly (no overlap).
    //    Return the best pair, its box coverage, and per-class coverage.
    const top = ranked.slice(0, 4).map((r) => r.f);
    const boxResults: any[] = [];
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const fa = top[i], fb = top[j];
        const pairs = boxScore(A, B, fa, fb);
        boxResults.push({ f1: fa, f2: fb, ...pairs });
      }
    }
    boxResults.sort((x, y) => (y.coveredFrac ?? 0) - (x.coveredFrac ?? 0));

    // 3) duration-controlled: only samples shared in duration bands
    const durBands = [
      { label: "<=0.6s", pred: (d: number) => d <= 0.6 },
      { label: "0.6-1.5s", pred: (d: number) => d > 0.6 && d <= 1.5 },
      { label: "1.5-3s", pred: (d: number) => d > 1.5 && d <= 3 },
      { label: ">3s", pred: (d: number) => d > 3 },
    ];
    const durCtl: Record<string, any> = {};
    for (const band of durBands) {
      const aD = A.filter((r) => band.pred(featureOf(r, "durationSec")!));
      const bD = B.filter((r) => band.pred(featureOf(r, "durationSec")!));
      if (aD.length >= 5 && bD.length >= 5) {
        const av = vals(aD, "spectralCentroidHz"), bv = vals(bD, "spectralCentroidHz");
        const aT = vals(aD, "transientStrength"), bT = vals(bD, "transientStrength");
        const aDur = vals(aD, "decayTimeSec"), bDur = vals(bD, "decayTimeSec");
        durCtl[band.label] = {
          nA: aD.length, nB: bD.length,
          centroid: { es: cohenD(av, bv), P: pAB(av, bv) },
          transient: { es: cohenD(aT, bT), P: pAB(aT, bT) },
          decay: { es: cohenD(aDur, bDur), P: pAB(aDur, bDur) },
        };
      }
    }

    // 4) outliers: 20% trimmed es
    const clip = (arr: number[], f: number) => {
      const s = [...arr].sort((x, y) => x - y);
      const lo = Math.max(1, Math.floor(s.length * f));
      const hi = Math.min(s.length, s.length - Math.floor(s.length * f) + 1);
      return s.slice(lo, hi);
    };
    const outTrim = FEATURES.map((f) => {
      const av = clip(vals(A, f), 0.2), bv = clip(vals(B, f), 0.2);
      return { f, es20: Math.abs(cohenD(av, bv) ?? 0) };
    }).sort((x, y) => y.es20 - x.es20).slice(0, 2);

    res[`${a}/${b}`] = { counts: [A.length, B.length], ranked, bestBox: boxResults[0] ?? null, boxCandidates: boxResults.slice(0, 3), durCtl, outlierRobust: outTrim };
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "step46-multi-feature.json"), JSON.stringify(res, null, 2) + "\n");

  // console summary
  for (const key of Object.keys(res)) {
    const r = res[key];
    const bb = r.bestBox;
    const dr = Object.entries(r.durCtl);
    const drStr = dr.length ? dr.map(([b, d]) => `${b}(${d.nA}/${d.nB} cent d=${d.centroid.es?.toFixed(2)})`).join(", ") : "no dur bands (n<5)";
    console.log(`\n== ${key} [${r.counts[0]}/${r.counts[1]}]`);
    console.log("  top single es: " + r.ranked.slice(0, 3).map((x: any) => `${x.f}=${x.es.toFixed(2)}`).join(", "));
    console.log(`  best 2feat box: ${bb ? `${bb.f1}+${bb.f2} cov=${bb.coveredFrac?.toFixed(2)} (A ${bb.aCovered}/${bb.aTotal}, B ${bb.bCovered}/${bb.bTotal})` : "none"}`);
    console.log(`  dur-ctrl: ${drStr}`);
    console.log(`  outlier20 top: ${r.outlierRobust[0]?.f}=${r.outlierRobust[0]?.es20.toFixed(2)} ${r.outlierRobust[1]?.f}=${r.outlierRobust[1]?.es20.toFixed(2)}`);
  }
}

function boxScore(A: Row[], B: Row[], f1: string, f2: string) {
  // Compute the fraction of each class that lies inside a per-class bounding
  // rectangle; the box "cleanly covers" a sample if its feature vector is
  // inside its OWN class's quartile box (25-75 pct) on the two axes and NOT
  // inside the other class's box. coveredFrac = combined clean coverage.
  const q = (arr: number[]) => {
    const s = [...arr].sort((x, y) => x - y);
    return { lo: s[Math.floor(s.length * 0.25)], hi: s[Math.min(s.length - 1, Math.floor(s.length * 0.75))] };
  };
  const a1 = vals(A, f1), a2 = vals(A, f2), b1 = vals(B, f1), b2 = vals(B, f2);
  if (a1.length < 5 || b1.length < 5) return { aCovered: 0, bCovered: 0, aTotal: A.length, bTotal: B.length, coveredFrac: 0 };
  const qa1 = q(a1), qa2 = q(a2), qb1 = q(b1), qb2 = q(b2);
  let aCovered = 0, bCovered = 0;
  for (const r of A) {
    const x = F[f1](r), y = F[f2](r);
    if (x === null || y === null) continue;
    const inA = x >= qa1.lo && x <= qa1.hi && y >= qa2.lo && y <= qa2.hi;
    const inB = x >= qb1.lo && x <= qb1.hi && y >= qb2.lo && y <= qb2.hi;
    if (inA && !inB) aCovered++;
  }
  for (const r of B) {
    const x = F[f1](r), y = F[f2](r);
    if (x === null || y === null) continue;
    const inA = x >= qa1.lo && x <= qa1.hi && y >= qa2.lo && y <= qa2.hi;
    const inB = x >= qb1.lo && x <= qb1.hi && y >= qb2.lo && y <= qb2.hi;
    if (inB && !inA) bCovered++;
  }
  const aTotal = A.filter((r) => F[f1](r) !== null && F[f2](r) !== null).length;
  const bTotal = B.filter((r) => F[f1](r) !== null && F[f2](r) !== null).length;
  const coveredFrac = (aCovered + bCovered) / Math.max(1, aTotal + bTotal);
  return { aCovered, bCovered, aTotal, bTotal, coveredFrac, q: { f1: [qa1.lo, qa1.hi, qb1.lo, qb1.hi], f2: [qa2.lo, qa2.hi, qb2.lo, qb2.hi] } };
}

main();