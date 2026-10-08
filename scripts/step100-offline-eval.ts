/**
 * STEP100 — OFFLINE A/B harness for the drum classifier.
 *
 * The STEP98 corpus builder now persists each analysed sample's FULL
 * `AudioFeatures` and `AudioFeaturesV2`. That makes `classifyHier` re-runnable
 * over the identical, real-audio corpus **without downloading or decoding
 * anything** — so a weight/threshold candidate can be evaluated in about a
 * second instead of a ten-minute corpus run. This is the fast half of the A/B;
 * any candidate that wins here must still be confirmed by one full corpus run
 * before it is committed.
 *
 * Supervision quality is reported separately: only rows whose NAME and TAG
 * independently resolve to the SAME drum ClassId are "reliable" (STEP99 §2).
 *
 * Usage:
 *   npx tsx scripts/step100-offline-eval.ts [--corpus <ndjson>] [--json <path>]
 */
import fs from "node:fs";
import { classifyHier } from "../src/classify/hier/classify";
import { parseNameEvidence, parseTagEvidence, subtypeToType } from "../src/classify/hier/evidence";
import { tagToSubtype } from "../src/classify/drumOntology";
import type { ClassId } from "../src/classify/classifier";
import type { AudioFeatures } from "../src/persistence/indexStore";
import type { AudioFeaturesV2 } from "../src/analysis/audioFeaturesV2";

const DEFAULT_CORPUS =
  "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step100-features/step98-drum-corpus.ndjson";

const readArg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const CORPUS = readArg("--corpus") ?? DEFAULT_CORPUS;
const JSON_OUT = readArg("--json");

const DRUM_TYPES: readonly ClassId[] = [
  "kick", "snare", "clap", "hihat", "openhat", "tom", "cymbal", "percussion",
];

type Row = {
  sampleId: string;
  name: string;
  kind?: string;
  label: ClassId;
  primaryClass: ClassId;
  family?: string;
  tags: string[];
  durationSec?: number;
  audioFeatures: AudioFeatures | null;
  v2Features: AudioFeaturesV2 | null;
};

const rows: Row[] = fs
  .readFileSync(CORPUS, "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Row);

const drumTypeOf = (types: readonly ClassId[]) => types.find((t) => DRUM_TYPES.includes(t));
const subtypeEvidence = (tags: readonly string[]) => {
  for (const t of tags) {
    const s = tagToSubtype(t);
    if (s !== undefined) return subtypeToType(s);
  }
  return undefined;
};

type Result = {
  sampleId: string;
  name: string;
  kind?: string;
  label: ClassId;
  meta?: ClassId;
  reliable: boolean;
  predicted: ClassId;
  /** Type from the ACOUSTIC decision alone (no name/tag evidence at all). */
  acoustic: ClassId;
  family: string;
  structure: string;
};

const results: Result[] = [];
for (const r of rows) {
  if (r.audioFeatures === null) continue; // feature capture failed for this row
  const nameEv = parseNameEvidence(r.name ?? "");
  const tagEv = parseTagEvidence(r.tags ?? []);
  const nameType = drumTypeOf(nameEv.types) ?? subtypeEvidence([r.name ?? ""]);
  const tagType = drumTypeOf(tagEv.types) ?? subtypeEvidence(r.tags ?? []);
  const reliable = nameType !== undefined && tagType !== undefined && nameType === tagType;
  const out = classifyHier({
    features: r.audioFeatures,
    meta: {
      kind: r.kind ?? "unknown",
      durationSeconds: r.audioFeatures.duration,
      name: r.name ?? "",
      tags: r.tags ?? [],
    },
    v2: r.v2Features,
  });
  // Acoustic-only view: strip ALL metadata so no tag/name adoption is possible.
  const acoustic = classifyHier({
    features: r.audioFeatures,
    meta: {
      kind: r.kind ?? "unknown",
      durationSeconds: r.audioFeatures.duration,
      name: "",
      tags: [],
    },
    v2: r.v2Features,
  });
  results.push({
    sampleId: r.sampleId,
    name: r.name,
    kind: r.kind,
    label: r.label,
    meta: reliable ? nameType : (nameType ?? tagType),
    reliable,
    predicted: out.surface.primaryClass,
    acoustic: acoustic.surface.primaryClass,
    family: out.hier.family,
    structure: out.hier.structure,
  });
}

const reliable = results.filter((r) => r.reliable && r.meta !== undefined);
const reliableShots = reliable.filter((r) => r.structure !== "loop");
const correct = reliableShots.filter((r) => r.predicted === r.meta);
const acousticCorrect = reliableShots.filter((r) => r.acoustic === r.meta);

const confusion = new Map<string, Map<string, number>>();
for (const r of reliableShots) {
  const row = confusion.get(r.meta!) ?? new Map<string, number>();
  row.set(r.predicted, (row.get(r.predicted) ?? 0) + 1);
  confusion.set(r.meta!, row);
}

console.log(`corpus: ${CORPUS}`);
console.log(`rows=${rows.length}  reliable=${reliable.length}  reliable one-shots=${reliableShots.length}`);
console.log(
  `RECONCILED (with tags/name)   : ${correct.length}/${reliableShots.length} = ${((correct.length / Math.max(1, reliableShots.length)) * 100).toFixed(1)}%   errors=${reliableShots.length - correct.length}`,
);
console.log(
  `ACOUSTIC-ONLY (no metadata)   : ${acousticCorrect.length}/${reliableShots.length} = ${((acousticCorrect.length / Math.max(1, reliableShots.length)) * 100).toFixed(1)}%   errors=${reliableShots.length - acousticCorrect.length}`,
);
console.log(
  "\nNOTE: the ground truth here is derived from the SAME name/tag text the classifier\n" +
    "consumes, so the RECONCILED number is circular — any change that increases metadata\n" +
    "adoption scores better on it regardless of acoustic quality. Only the ACOUSTIC-ONLY\n" +
    "number is evidence about the recognition algorithm itself.",
);

// STEP102 — held-out robustness check. Any single-term candidate can move the total by
// a few samples on noise alone, so a candidate must ALSO improve BOTH deterministic
// halves. All three candidates tested in STEP102 gained only in one half (or lost), and
// were rejected on this check.
const halfOf = (sampleId: string) => {
  let h = 0;
  for (const c of sampleId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 2;
};
console.log("\nACOUSTIC-ONLY by deterministic half (a candidate must improve BOTH):");
for (const half of [0, 1]) {
  const rowsInHalf = reliableShots.filter((r) => halfOf(r.sampleId) === half);
  const ok = rowsInHalf.filter((r) => r.acoustic === r.meta).length;
  console.log(
    `  half ${half}: n=${String(rowsInHalf.length).padStart(3)}  ${ok}/${rowsInHalf.length} = ${((ok / Math.max(1, rowsInHalf.length)) * 100).toFixed(1)}%`,
  );
}
console.log("\nconfusion (reliable label -> predicted), RECONCILED:");
for (const t of DRUM_TYPES) {
  const row = confusion.get(t);
  if (!row) continue;
  const total = [...row.values()].reduce((a, b) => a + b, 0);
  const cells = [...row.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ");
  console.log(`  ${t.padEnd(11)} n=${String(total).padStart(3)}  ${cells}`);
}

// The metric that matters: where do the ACOUSTIC decisions actually go?
const acousticConfusion = new Map<string, Map<string, number>>();
for (const r of reliableShots) {
  const row = acousticConfusion.get(r.meta!) ?? new Map<string, number>();
  row.set(r.acoustic, (row.get(r.acoustic) ?? 0) + 1);
  acousticConfusion.set(r.meta!, row);
}
console.log("\nconfusion (reliable label -> predicted), ACOUSTIC-ONLY:");
for (const t of DRUM_TYPES) {
  const row = acousticConfusion.get(t);
  if (!row) continue;
  const total = [...row.values()].reduce((a, b) => a + b, 0);
  const exact = row.get(t) ?? 0;
  const cells = [...row.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ");
  console.log(
    `  ${t.padEnd(11)} n=${String(total).padStart(3)}  exact=${String(exact).padStart(2)}  ${cells}`,
  );
}

if (JSON_OUT) {
  fs.writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        corpus: CORPUS,
        reliableOneShots: reliableShots.length,
        correct: correct.length,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${JSON_OUT}`);
}
