/**
 * STEP99 — calibration analysis on the STEP98 drum corpus.
 *
 * Splits the corpus into RELIABLE and UNRELIABLE supervision:
 *
 *   reliable   the sample NAME and its TAG independently resolve to the SAME
 *              drum ClassId — two independent text surfaces agreeing is the
 *              strongest label the data offers without human annotation.
 *   unreliable they disagree, or only one is present — a wrong acoustic
 *              prediction here may simply mean the tag (or the name) is wrong.
 *
 * Only the reliable subset may drive a threshold/weight decision. The script
 * prints, per label, the feature medians of the correct vs. the incorrect
 * reliable rows, which is the evidence a calibration change must cite.
 *
 * Usage:
 *   npx tsx scripts/step99-calibration-analysis.ts [--corpus <ndjson>]
 */
import fs from "node:fs";
import type { ClassId } from "../src/classify/classifier";
import { subtypeToType } from "../src/classify/hier/evidence";
import { parseNameEvidence, parseTagEvidence } from "../src/classify/hier/evidence";
import { tagToSubtype } from "../src/classify/drumOntology";

const DEFAULT_CORPUS =
  "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step98/step98-drum-corpus.ndjson";

const readArg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const CORPUS = readArg("--corpus") ?? DEFAULT_CORPUS;

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
  structure?: string;
  durationSec?: number;
  flatness?: number;
  centroidHz?: number;
  harmonicity?: number | null;
  transientStrength?: number | null;
  zcr?: number;
  crest?: number | null;
  tags: string[];
};

/** The first drum ClassId a name/tag evidence block resolves to. */
function drumTypeOf(types: readonly ClassId[]): ClassId | undefined {
  const hit = types.find((t) => DRUM_TYPES.includes(t));
  return hit === undefined ? undefined : hit;
}

/** Subtype evidence refines to a ClassId too (e.g. "chh" → hihat). */
function subtypeEvidence(tags: readonly string[]): ClassId | undefined {
  for (const t of tags) {
    const s = tagToSubtype(t);
    if (s !== undefined) return subtypeToType(s);
  }
  return undefined;
}

const rows: Row[] = fs
  .readFileSync(CORPUS, "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Row);

console.log(`corpus: ${CORPUS}`);
console.log(`rows: ${rows.length}`);

type Annotated = Row & { metaLabel?: ClassId; reliable: boolean; agreed: boolean };

const annotated: Annotated[] = rows.map((r) => {
  const nameEv = parseNameEvidence(r.name ?? "");
  const tagEv = parseTagEvidence(r.tags ?? []);
  const nameType = drumTypeOf(nameEv.types) ?? subtypeEvidence([r.name ?? ""]);
  const tagType = drumTypeOf(tagEv.types) ?? subtypeEvidence(r.tags ?? []);
  const agreed = nameType !== undefined && tagType !== undefined && nameType === tagType;
  return {
    ...r,
    metaLabel: agreed ? nameType : (nameType ?? tagType),
    reliable: agreed,
    agreed: nameType !== undefined && tagType !== undefined,
  };
});

const reliable = annotated.filter((r) => r.reliable);
const onlyOne = annotated.filter((r) => !r.reliable && r.agreed && r.metaLabel !== undefined);
const noText = annotated.filter((r) => !r.agreed && r.metaLabel === undefined);

console.log(
  `\nname+tag AGREE (reliable): ${reliable.length}   one surface only: ${onlyOne.length}   no drum text evidence: ${noText.length}`,
);

const kindBucket = (k?: string) => (k === "loop" ? "loop" : k === "one-shot" ? "one-shot" : "other");

function report(label: string, subset: Annotated[]) {
  if (subset.length === 0) return;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const median = (xs: Array<number | undefined>) => {
    const s = xs.filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    if (s.length === 0) return "n/a";
    const m = s[Math.floor(s.length / 2)];
    return m.toFixed(m >= 100 ? 0 : 3);
  };
  const correct = subset.filter((r) => r.primaryClass === r.metaLabel);
  const wrong = subset.filter((r) => r.primaryClass !== r.metaLabel);
  console.log(
    `\n${label}: n=${subset.length}  correct=${correct.length} (${((correct.length / subset.length) * 100).toFixed(0)}%)`,
  );
  for (const [name, group] of [["correct", correct], ["wrong  ", wrong]] as const) {
    if (group.length === 0) continue;
    console.log(
      `  ${name} n=${String(group.length).padStart(3)}  dur=${median(group.map((r) => num(r.durationSec)))}  flat=${median(group.map((r) => num(r.flatness)))}  cent=${median(group.map((r) => num(r.centroidHz)))}  harm=${median(group.map((r) => num(r.harmonicity)))}  ts=${median(group.map((r) => num(r.transientStrength)))}  zcr=${median(group.map((r) => num(r.zcr)))}  crest=${median(group.map((r) => num(r.crest)))}`,
    );
  }
}

console.log("\n=== RELIABLE subset (name and tag agree) ===");
report("all reliable", reliable);
for (const bucket of ["one-shot", "loop"] as const) {
  report(`reliable ${bucket}`, reliable.filter((r) => kindBucket(r.kind) === bucket));
}

console.log("\n=== RELIABLE per label ===");
for (const t of DRUM_TYPES) {
  report(t, reliable.filter((r) => r.metaLabel === t));
}

console.log("\n=== reliable ERRORS (name+tag agree, acoustics disagree) ===");
for (const r of reliable.filter((x) => x.primaryClass !== x.metaLabel).slice(0, 30)) {
  console.log(
    `  ${String(r.metaLabel).padEnd(11)} -> ${String(r.primaryClass).padEnd(11)} fam=${String(r.family).padEnd(16)} ${String(r.kind).padEnd(9)} dur=${(r.durationSec ?? 0).toFixed(2)}s flat=${(r.flatness ?? 0).toFixed(4)} cent=${Math.round(r.centroidHz ?? 0)} harm=${r.harmonicity == null ? "null" : r.harmonicity.toFixed(2)} ts=${r.transientStrength == null ? "null" : r.transientStrength.toFixed(1)}  "${r.name}" [${r.tags.join(", ")}]`,
  );
}
