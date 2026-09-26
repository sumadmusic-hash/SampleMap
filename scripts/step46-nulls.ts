#!/usr/bin/env -S npx tsx
/**
 * STEP46 — Null-rate audit + duration-control survival + outlier IDs.
 *
 * Three focused analyses over the STEP45 reference rows:
 *  1. NULL-RATE AUDIT: per-class null rate for every raw feature. Where an
 *     effect-size was computed from a minuscule non-null subset it is flagged
 *     as UNRELIABLE (those rows aren't carrying pitch/decay/etc. at all).
 *  2. DURATION-CONTROL SURVIVAL: within a shared short window (<=0.6s, the
 *     dominant one-shot band) how well do the REAL separators (centroid,
 *     transientStrength, decayTimeSec, harmonicity, crestFactor,
 *     spectralFlatness) separate each drum boundary — vs. the full set.
 *  3. OUTLIER IDs: for each boundary, the samples of each class that land
 *     nearest the other class on each of the top-2 separators (so the report
 *     can name reproducible sampleIds).
 *
 * No production change. Emits step46-null-dur-outliers.json.
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
  metadataDurationSeconds: number;
}
const num = (r: Row, k: string): number | null => { const v = (r.audioFeaturesV2[k] as number | null); return typeof v === "number" && Number.isFinite(v) ? v : null; };
const v1num = (r: Row, k: string): number | null => { const v = r.audioFeatures[k]; return typeof v === "number" && Number.isFinite(v) ? v : null; };
const scnum = (r: Row, k: string): number | null => { const v = r.soundCharacter[k]; return typeof v === "number" && Number.isFinite(v) ? v : null; };

const RAW = [
  "crestFactor", "transientStrength", "zeroCrossingRate", "spectralCentroidHz",
  "spectralSpreadHz", "spectralRolloffHz", "spectralFlatness", "spectralFlux",
  "spectralSlope", "attackTimeSec", "decayTimeSec", "pitchHz", "pitchConfidence",
  "harmonicity", "inharmonicity",
];
const SC = ["brightness", "density", "transient", "duration", "tonality", "noisiness", "dynamics", "complexity"];

const DUR_BANDS: Array<[string, (d: number) => boolean]> = [
  ["<=0.6s", (d) => d <= 0.6],
  ["0.6-1.5s", (d) => d > 0.6 && d <= 1.5],
];
const SEPARATORS = ["spectralCentroidHz", "transientStrength", "decayTimeSec", "harmonicity", "crestFactor", "spectralFlatness"];

const BOUNDARIES: Array<[string, string]> = [
  ["kick", "snare"], ["kick", "clap"], ["kick", "percussion"], ["kick", "tom"],
  ["snare", "clap"], ["snare", "percussion"], ["snare", "hihat"], ["snare", "tom"],
  ["clap", "percussion"], ["hihat", "openhat"], ["hihat", "cymbal"], ["openhat", "cymbal"],
  ["tom", "percussion"],
];

function loadRows(): Row[] {
  const out: Row[] = [];
  for (const line of fs.readFileSync(ANALYSIS_PATH, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind !== "analysis" || r.corpusRole !== "reference" || !r.referenceClass) continue;
      out.push({
        sampleId: r.sampleId,
        referenceClass: r.referenceClass,
        audioFeaturesV2: r.audioFeaturesV2 ?? {},
        soundCharacter: r.soundCharacter ?? {},
        audioFeatures: r.audioFeatures ?? {},
        metadataDurationSeconds: r.metadataDurationSeconds ?? 0,
      });
    } catch { /* torn */ }
  }
  return out;
}
const durOf = (r: Row) => {
  const d = num(r, "durationSec"); if (d !== null && Number.isFinite(d)) return d;
  return r.metadataDurationSeconds;
};
const featOf = (r: Row, k: string): number | null => {
  const v = num(r, k); if (v !== null) return v;
  const v1map: Record<string, string> = { zeroCrossingRate: "zeroCrossingRate", spectralCentroidHz: "spectralCentroid", spectralSpreadHz: "spectralBandwidth", spectralRolloffHz: "spectralRolloff", spectralFlatness: "spectralFlatness", attackTimeSec: "attack", rms: "rms", peak: "peak" };
  if (v1map[k]) { const x = v1num(r, v1map[k]); if (x !== null) return x; }
  return null;
};
const scOf = (r: Row, k: string): number | null => scnum(r, k);

const vals = (rows: Row[], f: (r: Row) => number | null) => rows.map(f).filter((v): v is number => v !== null);
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a: number[]) => (a.length < 2 ? null : Math.sqrt(a.reduce((x, y) => x + (y - mean(a)!) ** 2, 0) / a.length));
const cohenD = (a: number[], b: number[]) => {
  if (a.length < 2 || b.length < 2) return null;
  const p = Math.sqrt((sd(a)! ** 2 + sd(b)! ** 2) / 2);
  return p === 0 ? null : (mean(a)! - mean(b)!) / p;
};
const pAB = (a: number[], b: number[]) => {
  if (!a.length || !b.length) return null;
  let gt = 0; for (const x of a) for (const y of b) if (x > y) gt++;
  return gt / (a.length * b.length);
};

function main() {
  const rows = loadRows();
  const byClass = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = byClass.get(r.referenceClass)! ?? [];
    arr.push(r); byClass.set(r.referenceClass, arr);
  }
  const classes = [...byClass.keys()].sort();

  // 1) null-rate audit (raw V2 features + SC)
  const nullRates: Record<string, Record<string, { n: number; nullRate: number }>> = {};
  for (const c of classes) {
    const list = byClass.get(c)!;
    const nr: Record<string, { n: number; nullRate: number }> = {};
    for (const k of [...RAW]) {
      const present = list.filter((r) => num(r, k) !== null).length;
      nr[k] = { n: present, nullRate: 1 - present / list.length };
    }
    for (const k of SC) {
      const present = list.filter((r) => scOf(r, k) !== null).length;
      nr[`sc_${k}`] = { n: present, nullRate: 1 - present / list.length };
    }
    nullRates[c] = nr;
  }

  // 2) duration-control survival
  const durSurvival: Record<string, any> = {};
  for (const [a, b] of BOUNDARIES) {
    const A = byClass.get(a)!, B = byClass.get(b)!;
    const row: Record<string, any> = { full: {}, bands: {} };
    for (const s of SEPARATORS) {
      const av = vals(A, (r) => featOf(r, s)), bv = vals(B, (r) => featOf(r, s));
      row.full[s] = { es: cohenD(av, bv), P: pAB(av, bv), nA: av.length, nB: bv.length };
    }
    for (const [band, pred] of DUR_BANDS) {
      const aB = A.filter((r) => pred(durOf(r)));
      const bB = B.filter((r) => pred(durOf(r)));
      const be: Record<string, any> = {};
      if (aB.length >= 5 && bB.length >= 5) {
        for (const s of SEPARATORS) {
          const av = vals(aB, (r) => featOf(r, s)), bv = vals(bB, (r) => featOf(r, s));
          be[s] = { es: cohenD(av, bv), P: pAB(av, bv), nA: av.length, nB: bv.length };
        }
      }
      row.bands[band] = { nA: aB.length, nB: bB.length, features: be };
    }
    durSurvival[`${a}/${b}`] = row;
  }

  // 3) outlier IDs: for each boundary, for each of the top-2 raw separators,
  //    the samples whose value lands nearest the OTHER class's median.
  const outlierRows: Record<string, any> = {};
  const boundarySeparators: Record<string, string[]> = {
    "kick/snare": ["spectralCentroidHz", "spectralFlatness"],
    "snare/clap": ["crestFactor", "harmonicity"],
    "snare/percussion": ["transientStrength", "spectralFlatness"],
    "hihat/openhat": ["decayTimeSec", "transientStrength"],
    "hihat/cymbal": ["transientStrength", "decayTimeSec"],
    "openhat/cymbal": ["spectralCentroidHz", "spectralSlope"],
    "clap/percussion": ["harmonicity", "transientStrength"],
    "kick/tom": ["spectralCentroidHz", "harmonicity"],
    "kick/percussion": ["spectralCentroidHz", "harmonicity"],
    "snare/hihat": ["spectralCentroidHz", "spectralFlatness"],
    "snare/tom": ["spectralCentroidHz", "harmonicity"],
    "tom/percussion": ["spectralCentroidHz", "transientStrength"],
  };
  for (const [a, b] of BOUNDARIES) {
    const key = `${a}/${b}`;
    const A = byClass.get(a)!, B = byClass.get(b)!;
    const seps = boundarySeparators[key] ?? ["spectralCentroidHz"];
    const per = (r: Row) => ({ dur: durOf(r), sampleId: r.sampleId });
    const eps: Record<string, any> = {};
    for (const s of seps) {
      const medA = (() => { const m = vals(A, (r) => featOf(r, s)); if (!m.length) return null; const mm = [...m].sort((x, y) => x - y); const i = Math.floor(mm.length / 2); return mm.length % 2 ? mm[i] : (mm[i - 1] + mm[i]) / 2; })();
      const medB = (() => { const m = vals(B, (r) => featOf(r, s)); if (!m.length) return null; const mm = [...m].sort((x, y) => x - y); const i = Math.floor(mm.length / 2); return mm.length % 2 ? mm[i] : (mm[i - 1] + mm[i]) / 2; })();
      const nearA = [...A].map((r) => ({ ...per(r), v: featOf(r, s) })).filter((x) => x.v !== null)
        .sort((x, y) => Math.abs(x.v! - (medB ?? 0)) - Math.abs(y.v! - (medB ?? 0))).slice(0, 3);
      const nearB = [...B].map((r) => ({ ...per(r), v: featOf(r, s) })).filter((x) => x.v !== null)
        .sort((x, y) => Math.abs(x.v! - (medA ?? 0)) - Math.abs(y.v! - (medA ?? 0))).slice(0, 3);
      eps[s] = { medA, medB, closestAToB: nearA, closestBToA: nearB };
    }
    outlierRows[key] = eps;
  }

  const out = { n: rows.length, nullRates, durSurvival, outlierRows };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "step46-null-dur-outliers.json"), JSON.stringify(out, null, 2) + "\n");

  // console: a compact null-rate table + duration survival for the critical pairs
  console.log("== NULL RATE (1 - present/total) per class, per critical feature ==");
  const crit = ["transientStrength", "decayTimeSec", "spectralCentroidHz", "spectralFlatness", "harmonicity", "spectralSlope", "pitchConfidence", "inharmonicity"];
  const hdr = ["class", ...crit.map((c) => c.slice(0, 12))].join("\t");
  console.log(hdr);
  for (const c of classes) {
    console.log([c, ...crit.map((k) => nullRates[c][k].nullRate.toFixed(2)).join("\t")].join("\t"));
  }

  console.log("\n== DURATION SURVIVAL (centroid es full vs <=0.6s) ==");
  for (const key of Object.keys(durSurvival)) {
    const d = durSurvival[key];
    const f = d.full["spectralCentroidHz"]; const s = d.bands["<=0.6s"].features ?? {};
    const st = s["transientStrength"] ? ` ts=${(s["transientStrength"].es ?? 0).toFixed(2)}` : "";
    console.log(`| ${key} | full cent=${f.es?.toFixed(2) ?? "—"} | <=0.6s cent=${(s["spectralCentroidHz"]?.es ?? 0).toFixed(2)}${st} |`);
  }
  console.log(`\nwrote ${path.join(OUT_DIR, "step46-null-dur-outliers.json")}`);
}

main();