#!/usr/bin/env -S npx tsx
/**
 * STEP45 — Offline before/after reclassification.
 *
 * Mode A/B of every stored STEP45 analysis row are re-run through the CURRENT
 * `hier-v1` code using ONLY persisted features (V1 slice + V2 slice + kind +
 * durations + name + tags). classifyHier is pure, so this reproduces Mode B
 * exactly as the pipeline ran it (meta.durationSeconds = V1 duration, name =
 * row.name, tags = originalTags) and Mode A exactly as the audit ran it
 * (name="", tags=[]).
 *
 * This makes calibration iteration O(file) and network-free: a BEFORE (stored
 * rows) → AFTER (reclassify) DELTA can be measured on the same rows with the
 * same audio, and the --noop mode verifies offline fidelity by asserting the
 * stored audioOnly/full equal the reconstructed ones BEFORE any code change.
 *
 * Usage:
 *   npx tsx scripts/step45-reclassify.ts [--in <analysis.ndjson>] [--out <dir>]
 *       [--noop]        run with the CURRENT code and assert 100% equality of the
 *                       classifier-INDEPENDENT layers (structure for both modes +
 *                       Mode-A family) against the stored rows (offline-fidelity
 *                       gate; exit 1 on mismatch); type/confidence/full-family
 *                       are expected to change post-calibration
 *       [--no-noop-write] in --noop, persist reconstructed rows anyway
 *   Emits <out>/step45-reclass-after.ndjson (same rows with audioOnly/full
 *   refreshed) and <out>/step45-reclass-fidelity.json.
 */
import fs from "node:fs";
import path from "node:path";
import type { AudioFeatures } from "../src/persistence/indexStore";
import type { AudioFeaturesV2 } from "../src/analysis/audioFeaturesV2";
import { classifyHier } from "../src/classify/hier/classify";
import type { HierClassifyInput } from "../src/classify/hier/types";

const IN_PATH = parseArg("--in") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step45/step45-analysis.ndjson";
const OUT_DIR = parseArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step45";
const NOOP = process.argv.includes("--noop");
const NOOP_WRITE = process.argv.includes("--no-noop-write");

function parseArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

interface AnalysisRow {
  kind: string;
  corpusRole: string;
  sampleId: string;
  name: string;
  owner: string;
  originalTags: string[];
  referenceClass: string | null;
  referenceTier: string | null;
  namingFamily: string | null;
  loopBand: string | null;
  metadataDurationSeconds: number;
  audioFeatures: Record<string, number>;
  audioFeaturesV2: Record<string, number | null>;
  audioOnly: {
    structure?: string;
    family?: string;
    type?: string;
    subtype?: string | null;
    confidence?: number;
    ambiguous?: boolean;
  };
  full: {
    structure?: string;
    family?: string;
    type?: string;
    subtype?: string | null;
    confidence?: number;
    ambiguous?: boolean;
    audioType?: string | null;
    tagType?: string | null;
    nameType?: string | null;
    reconciliationStatus?: string;
    reconciliationWinningSource?: string;
    reconciliationAgreement?: boolean;
    reconciliationConflict?: boolean;
  };
}

function load(): AnalysisRow[] {
  const out: AnalysisRow[] = [];
  for (const line of fs.readFileSync(IN_PATH, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind !== "analysis" || !r.audioOnly || !r.full) continue;
      out.push(r);
    } catch {
      // torn tail
    }
  }
  return out;
}

function kindOf(row: AnalysisRow): "one-shot" | "loop" {
  return row.corpusRole === "loop-validation" ? "loop" : "one-shot";
}

function featuresOf(slice: Record<string, number>): AudioFeatures {
  return {
    duration: slice.duration ?? 0,
    sampleRate: slice.sampleRate ?? 0,
    channels: slice.channels ?? 1,
    rms: slice.rms ?? 0,
    peak: slice.peak ?? 0,
    transientDensity: slice.transientDensity ?? 0,
    spectralCentroid: slice.spectralCentroid ?? 0,
    spectralBandwidth: slice.spectralBandwidth ?? 0,
    spectralRolloff: slice.spectralRolloff ?? 0,
    zeroCrossingRate: slice.zeroCrossingRate ?? 0,
    spectralFlatness: slice.spectralFlatness ?? 0,
    attack: slice.attack ?? 0,
    tonalNoiseRatio: slice.tonalNoiseRatio ?? 0,
  };
}

function v2Of(slice: Record<string, number | null>): AudioFeaturesV2 {
  const num = (k: string): number | null =>
    typeof slice[k] === "number" && Number.isFinite(slice[k]) ? (slice[k] as number) : null;
  return {
    durationSec: num("durationSec") ?? 0,
    sampleRate: 44100,
    channels: 1,
    rms: num("rms") ?? 0,
    peak: num("peak") ?? 0,
    crestFactor: num("crestFactor"),
    transientStrength: num("transientStrength"),
    zeroCrossingRate: num("zeroCrossingRate"),
    spectralCentroidHz: num("spectralCentroidHz"),
    spectralSpreadHz: num("spectralSpreadHz"),
    spectralRolloffHz: num("spectralRolloffHz"),
    spectralFlatness: num("spectralFlatness"),
    spectralFlux: num("spectralFlux"),
    spectralSlope: num("spectralSlope"),
    attackTimeSec: num("attackTimeSec"),
    decayTimeSec: num("decayTimeSec"),
    pitchHz: num("pitchHz"),
    pitchConfidence: num("pitchConfidence"),
    harmonicity: num("harmonicity"),
    inharmonicity: num("inharmonicity"),
  };
}

function classifyMode(row: AnalysisRow, kind: "one-shot" | "loop", withMeta: boolean) {
  const features = featuresOf(row.audioFeatures);
  const meta = {
    kind,
    durationSeconds: row.audioFeatures.duration ?? row.metadataDurationSeconds,
    name: withMeta ? row.name : "",
    tags: withMeta ? [...row.originalTags] : [],
  } as HierClassifyInput["meta"];
  return classifyHier({ features, meta, v2: v2Of(row.audioFeaturesV2) }).hier;
}

const pick = (h: ReturnType<typeof classifyMode>) => ({
  structure: h.structure,
  family: h.family,
  type: h.type,
  subtype: h.subtype ?? null,
  confidence: h.confidence,
  ambiguous: h.ambiguous,
  // Same flat reconciliation schema the STEP45 audit persisted (§23 fields) so
  // `evaluate()` (STEP44.1 definitions) reads BEFORE and AFTER identically.
  audioType: h.reconciliation?.audioType ?? null,
  tagType: h.reconciliation?.tagType ?? null,
  nameType: h.reconciliation?.nameType ?? null,
  reconciliationStatus: h.reconciliation?.status ?? "UNKNOWN",
  reconciliationWinningSource: h.reconciliation?.winningSource ?? "none",
  reconciliationAgreement: h.reconciliation?.agreement ?? false,
  reconciliationConflict: h.reconciliation?.conflict ?? false,
});

function main() {
  const rows = load();
  if (rows.length === 0) {
    console.error("no rows loaded — abort");
    process.exit(1);
  }

  const outRows = [];
  let mismatchA = 0;
  let mismatchB = 0;
  const mismatchExamples: Array<{ sampleId: string; mode: "A" | "B"; field: string }> = [];

  for (const row of rows) {
    const kind = kindOf(row);
    const modeA = pick(classifyMode(row, kind, false));
    const modeB = pick(classifyMode(row, kind, true));

    if (NOOP) {
      // Fidelity gate over the CLASSIFIER-INDEPENDENT layers only. `structure`
      // (authoritative kind/duration) is independent for BOTH modes; Mode A
      // `family` is pure acoustic family scoring (empty metadata). Mode B
      // `family` is deliberately NOT in the gate: it follows the
      // reconciliation-decided type (classify.ts), so it legitimately changes
      // with calibration and IS the measured after-effect. Reproducing these
      // faithful layers across all rows proves the offline inputs (V1 slice →
      // AudioFeatures, V2 slice → AudioFeaturesV2, kind, durationSeconds,
      // name, tags) equal the audit's, so any type/confidence/full-family
      // delta afterwards is a REAL calibration effect.
      for (const [field, got, exp] of [
        ["audioOnly", modeA, row.audioOnly],
        ["full", modeB, row.full],
      ] as const) {
        for (const k of field === "audioOnly"
          ? (["structure", "family"] as const)
          : (["structure"] as const)) {
          if (got[k] !== exp[k]) {
            mismatchExamples.push({ sampleId: row.sampleId, mode: field === "audioOnly" ? "A" : "B", field: String(k) });
            if (field === "audioOnly") mismatchA++;
            else mismatchB++;
          }
        }
      }
    }

    outRows.push({ ...row, audioOnly: modeA, full: modeB });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fidelity = {
    mode: NOOP ? "noop-fidelity" : "after",
    rows: rows.length,
    modeAExact: NOOP ? rows.length - mismatchA : null,
    modeBExact: NOOP ? rows.length - mismatchB : null,
    mismatchA,
    mismatchB,
    mismatchExamples: mismatchExamples.slice(0, 30),
  };
  fs.writeFileSync(path.join(OUT_DIR, "step45-reclass-fidelity.json"), JSON.stringify(fidelity, null, 2) + "\n");

  if (NOOP && !NOOP_WRITE) {
    if (mismatchA + mismatchB === 0) {
      console.log(`NOOP fidelity PASS: ${rows.length}/${rows.length} rows reproduce stored structure (both modes) + Mode-A family (classifier-independent layers) exactly.`);
    } else {
      console.error(`NOOP fidelity FAIL: modeA structure/family mismatches=${mismatchA} modeB structure/family mismatches=${mismatchB}`);
      console.error(JSON.stringify(mismatchExamples.slice(0, 20), null, 2));
      process.exit(1);
    }
    return;
  }

  const out = path.join(OUT_DIR, "step45-reclass-after.ndjson");
  let s = "";
  for (const r of outRows) s += JSON.stringify(r) + "\n";
  fs.writeFileSync(out, s);
  console.log(`wrote ${outRows.length} rows → ${out}`);
  console.log(JSON.stringify(fidelity, null, 2));
}

main();