#!/usr/bin/env -S npx tsx
/**
 * STEP67 — 500-Sample Drum Corpus for Real Sample Map Validation (corpus builder).
 *
 * Deterministic, tag-driven selection over the REAL Audiotool catalogue
 * (step42-metadata.ndjson, 123,756 public samples). Tags are used ONLY to
 * select + document the corpus; they never determine map position (§4).
 *
 *   Input   : step42-metadata.ndjson (real Audiotool sample metadata)
 *   Output  : step67-corpus.ndjson      500 reference rows (one-shot drum hits)
 *             step67-selection.json     selection provenance + per-bucket stats
 *             step67-excluded.json      previously used / ambiguous exclusions
 *
 * Selection rules (reproducible, no RNG — same method family as STEP45):
 *  1. one-shots only (loop tag/duration exclusions documented)
 *  2. specific drum evidence via the EXISTING evidence parsers
 *     (parseNameEvidence / parseTagEvidence) — tag-specificity drives tier
 *  3. buckets: kick/snare/clap/hihat/openhat/cymbal/tom/percussion/sonstige-drum
 *  4. previously analysed ids (STEP44/44.1/45) are excluded — every STEP67
 *     sample is NEW to the production index
 *  5. deterministic per-bucket ranking + 4-stage diversity pass (owner,
 *     naming-family, duration bucket) — identical structure to STEP45.
 *
 * Usage: npx tsx scripts/step67-build-corpus.ts [--out <dir>] [--max-samples N]
 */
import fs from "node:fs";
import path from "node:path";
import type { ClassId } from "../src/classify/classifier";
import {
  parseNameEvidence,
  parseTagEvidence,
  subtypeToType,
} from "../src/classify/hier/evidence";
import type { SubtypeId } from "../src/classify/drumOntology";
import { normalizeTag } from "../src/classify/normalizeTag";

const OUT_DIR = parseArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step67";
const META_PATH =
  parseArg("--meta") ??
  "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step42/step42-metadata.ndjson";
const PREVIOUS_FILES = parseArg("--previous")
  ? parseArg("--previous")!.split(",")
  : [
      "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step42/step42-analysis.ndjson",
      "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step42/step44-analysis.ndjson",
      "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step44.1/step44.1-analysis.ndjson",
      "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step44.1/step44.1-reference-corpus.ndjson",
      "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step44.1-step44rerun/step44-analysis.ndjson",
      "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step45/step45-analysis.ndjson",
      "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step45/step45-reclass-after.ndjson",
      "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step45/step45-reference-corpus.ndjson",
    ];
const MAX_SAMPLES = Number(parseArg("--max-samples") ?? "0");

/** STEP67 §5 category buckets — the SPEC table, NOT a re-classifier. */
export const BUCKET_TARGETS: Record<string, number> = {
  kick: 70,
  snare: 70,
  clap: 60,
  hihat: 70,
  openhat: 50,
  cymbal: 50,
  tom: 40,
  percussion: 60,
  "sonstige-drum": 30,
};

/** The 8 SPEC drum classes (a specific evidence type in one of these fixes a bucket). */
const DRUM_TYPES: readonly ClassId[] = [
  "kick",
  "snare",
  "clap",
  "hihat",
  "openhat",
  "cymbal",
  "tom",
  "percussion",
];

const USAGE_SIGNAL_COUNT = 5;

/** Durations buckets (same spread as STEP45). */
const DUR_BUCKETS: Array<[string, (d: number) => boolean]> = [
  ["<=0.25", (d) => d <= 0.25],
  ["0.25-0.5", (d) => d > 0.25 && d <= 0.5],
  ["0.5-1.0", (d) => d > 0.5 && d <= 1.0],
  ["1.0-2.5", (d) => d > 1.0 && d <= 2.5],
  [">2.5", (d) => d > 2.5],
];

function durBucket(d: number): string {
  return DUR_BUCKETS.find(([, p]) => p(d))?.[0] ?? ">2.5";
}

interface MetaRow {
  sampleId: string;
  name: string;
  owner: string;
  visibility: string;
  sampleKind: string;
  bpm: number;
  durationSeconds: number;
  numFavorites: number;
  numUsages: number;
  tags: string[];
}

interface Candidate {
  row: MetaRow;
  bucket: string;
  tier: "A" | "B" | "C";
  namingFamily: string;
  evidence: { types: string[]; generic: string[]; subtypes: string[] };
}

function parseArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function loadMeta(): MetaRow[] {
  const out: MetaRow[] = [];
  for (const line of fs.readFileSync(META_PATH, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.sampleId !== "string" || !r.sampleId.startsWith("samples/")) continue;
      out.push({
        sampleId: r.sampleId,
        name: r.name ?? "",
        owner: r.owner ?? "",
        visibility: r.visibility ?? "",
        sampleKind: r.sampleKind ?? r.kind ?? "",
        bpm: r.bpm ?? 0,
        durationSeconds: r.durationSeconds ?? 0,
        numFavorites: r.numFavorites ?? 0,
        numUsages: r.numUsages ?? 0,
        tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      });
    } catch {
      // tolerate torn tail
    }
  }
  return out;
}

/** Every sampleId ever analysed/selected by an earlier calibration step. */
function loadPreviousAnalyzed(paths: string[]): { ids: Set<string>; perFile: Record<string, number> } {
  const ids = new Set<string>();
  const perFile: Record<string, number> = {};
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      perFile[p] = -1;
      continue;
    }
    let n = 0;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r.sampleId === "string") {
          ids.add(r.sampleId);
          n++;
        }
      } catch {
        // tolerate torn tail
      }
    }
    perFile[p] = n;
  }
  return { ids, perFile };
}

function namingFamilyOf(name: string): string {
  const norm = normalizeTag(name);
  if (!norm) return "<empty>";
  return norm
    .split(" ")
    .filter((tok) => !/^\d+$/.test(tok))
    .join(" ");
}

interface BucketDecision {
  bucket?: string;
  tier?: "A" | "B" | "C";
  ambiguous: boolean;
  evidence: { types: string[]; generic: string[]; subtypes: string[] };
}

/**
 * Tag-AND-name decision (evidence only — never a classifier). A row gets a
 * specific bucket only when the union of specific drum evidence collapses to
 * exactly ONE drum type. hihat/openhat pairs resolve through subtypes.
 * Rows with only generic drum evidence (tag "drum"/family drums) land in
 * "sonstige-drum". Multi-type or name/tag-conflicting rows are ambiguous.
 */
function decideBucket(row: MetaRow): BucketDecision {
  const name = parseNameEvidence(row.name);
  const tag = parseTagEvidence(row.tags ?? []);
  const nameTypes = name.types.filter((t) => (DRUM_TYPES as readonly string[]).includes(t));
  const tagTypes = tag.types.filter((t) => (DRUM_TYPES as readonly string[]).includes(t));
  const subtypes = [...new Set<SubtypeId>([...name.subtypes, ...tag.subtypes])];
  let union = [...new Set<string>([...nameTypes, ...tagTypes])];
  if (union.includes("hihat") && union.includes("openhat") && union.length === 2) {
    const subtypeTypes = [...new Set(subtypes.map(subtypeToType))];
    union = subtypeTypes.length === 1 && !(DRUM_TYPES as readonly string[]).includes(subtypeTypes[0] as string)
      ? union
      : subtypeTypes.length === 1
        ? [subtypeTypes[0]]
        : union;
  }
  if (union.length === 1 && (DRUM_TYPES as readonly string[]).includes(union[0])) {
    const clazz = union[0];
    const hasName = nameTypes.includes(clazz);
    const hasTag = tagTypes.includes(clazz);
    const tier = hasTag && hasName
      ? row.numUsages >= USAGE_SIGNAL_COUNT ? "A" : "B"
      : hasTag ? "B" : hasName ? "C" : "B";
    return { bucket: clazz, tier, ambiguous: false, evidence: { types: union, generic: [], subtypes } };
  }
  // generic drum-family evidence → sonstige-drum candidate
  const drumFamily =
    name.familyHints.includes("drums") ||
    tag.familyHints.includes("drums") ||
    tag.generic.includes("drum") ||
    tag.generic.includes("drums");
  if (drumFamily && union.length === 0) {
    return {
      bucket: "sonstige-drum",
      tier: tag.generic.includes("drum") || tag.generic.includes("drums") ? "B" : "C",
      ambiguous: false,
      evidence: { types: union, generic: tag.generic, subtypes },
    };
  }
  return { ambiguous: union.length > 1, evidence: { types: union, generic: tag.generic, subtypes } };
}

/**
 * Deterministic 4-stage diversity pass (same structure as STEP45 §4.8–4.11):
 *   pass 1: one per owner
 *   pass 2: owner <=3 and naming-family <=3
 *   pass 3: owner <=5 AND duration-bucket cap (~target/5, floor 2)
 *   pass 4: no quota
 */
function selectDiverse(cands: Candidate[], target: number): Candidate[] {
  const chosen: Candidate[] = [];
  const ownerCount = new Map<string, number>();
  const famCount = new Map<string, number>();
  const bucketCount = new Map<string, number>();
  const excTarget5 = Math.max(2, Math.round(target / 5));
  const pick = (c: Candidate) => {
    chosen.push(c);
    ownerCount.set(c.row.owner, (ownerCount.get(c.row.owner) ?? 0) + 1);
    famCount.set(c.namingFamily, (famCount.get(c.namingFamily) ?? 0) + 1);
    const b = durBucket(c.row.durationSeconds);
    bucketCount.set(b, (bucketCount.get(b) ?? 0) + 1);
  };
  const stages: Array<(c: Candidate) => boolean> = [
    (c) => !ownerCount.has(c.row.owner),
    (c) => (ownerCount.get(c.row.owner) ?? 0) < 3 && (famCount.get(c.namingFamily) ?? 0) < 3,
    (c) =>
      (ownerCount.get(c.row.owner) ?? 0) < 5 &&
      (bucketCount.get(durBucket(c.row.durationSeconds)) ?? 0) < excTarget5,
    () => true,
  ];
  for (const canPick of stages) {
    for (const c of cands) {
      if (chosen.length >= target) return chosen;
      if (chosen.includes(c)) continue;
      if (canPick(c)) pick(c);
    }
  }
  return chosen;
}

const TIER_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };

function classSortKey(c: Candidate): string {
  return `${TIER_RANK[c.tier]}.${String(c.row.numUsages).padStart(6, "0")}.${c.row.sampleId}`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const corpusPath = path.join(OUT_DIR, "step67-corpus.ndjson");
  const selectionPath = path.join(OUT_DIR, "step67-selection.json");
  const excludedPath = path.join(OUT_DIR, "step67-excluded.json");
  const backupPath = path.join(OUT_DIR, "step67-backup.ndjson");

  const all = loadMeta();
  const { ids: previous, perFile } = loadPreviousAnalyzed(PREVIOUS_FILES);
  console.error(
    `loaded ${all.length} metadata rows; excluding ${previous.size} previously-used ids (${JSON.stringify(perFile)})`,
  );

  const oneShots = all.filter((r) => r.sampleKind === "one-shot");
  const loops = all.filter((r) => r.sampleKind !== "one-shot");
  console.error(`one-shots=${oneShots.length}, loops=${loops.length}`);

  const byBucket: Record<string, Candidate[]> = {};
  const bucketStats: Record<string, Record<string, number | string>> = {};
  const excluded: Array<Record<string, unknown>> = [];
  const ambiguousTotal: Record<string, number> = {};

  for (const row of oneShots) {
    if ((row.tags ?? []).length === 0) continue; // STEP67 §2: tag-driven selection
    const d = decideBucket(row);
    if (d.ambiguous || !d.bucket || !d.tier) {
      ambiguousTotal[d.bucket ?? "ambiguous"] = (ambiguousTotal[d.bucket ?? "ambiguous"] ?? 0) + 1;
      continue;
    }
    if (!(d.bucket in BUCKET_TARGETS)) continue;
    if (previous.has(row.sampleId)) continue;
    const c: Candidate = {
      row,
      bucket: d.bucket,
      tier: d.tier,
      namingFamily: namingFamilyOf(row.name),
      evidence: d.evidence,
    };
    (byBucket[d.bucket] ??= []).push(c);
    const s = (bucketStats[d.bucket] ??= { A: 0, B: 0, C: 0 });
    s[d.tier]++;
  }

  const selected: Candidate[] = [];
  const perBucketPicks: Record<string, Candidate[]> = {};
  for (const bucket of Object.keys(BUCKET_TARGETS)) {
    const target = BUCKET_TARGETS[bucket];
    const cands = (byBucket[bucket] ?? []).sort((a, b) =>
      classSortKey(a).localeCompare(classSortKey(b)),
    );
    const picks = selectDiverse(cands, target);
    perBucketPicks[bucket] = picks;
    selected.push(...picks);
  }

  if (MAX_SAMPLES > 0 && selected.length > MAX_SAMPLES) {
    selected.length = MAX_SAMPLES;
  }

  const stream = fs.createWriteStream(corpusPath, { flags: "w" });
  for (const c of selected) {
    stream.write(
      JSON.stringify({
        kind: "reference",
        step: "step67",
        sampleId: c.row.sampleId,
        name: c.row.name,
        owner: c.row.owner,
        visibility: c.row.visibility,
        bpm: c.row.bpm,
        durationSeconds: c.row.durationSeconds,
        numFavorites: c.row.numFavorites,
        numUsages: c.row.numUsages,
        originalTags: c.row.tags,
        bucket: c.bucket,
        tier: c.tier,
        namingFamily: c.namingFamily,
        selectionEvidence: c.evidence,
        sampleKind: c.row.sampleKind,
      }) + "\n",
    );
  }
  stream.end();

  fs.writeFileSync(
    excludedPath,
    JSON.stringify({ ambiguousCounts: ambiguousTotal, note: "ambiguous rows dropped; previous ids dropped" }, null, 2) + "\n",
  );

  // ── Deterministic replacement pool (same sort as selection) ───────────────
  const backupStream = fs.createWriteStream(backupPath, { flags: "w" });
  const chosenIds = new Set(selected.map((c) => c.row.sampleId));
  for (const bucket of Object.keys(BUCKET_TARGETS)) {
    const cands = (byBucket[bucket] ?? [])
      .sort((a, b) => classSortKey(a).localeCompare(classSortKey(b)))
      .filter((c) => !chosenIds.has(c.row.sampleId));
    for (const c of cands) {
      backupStream.write(
        JSON.stringify({
          kind: "backup",
          step: "step67",
          sampleId: c.row.sampleId,
          name: c.row.name,
          owner: c.row.owner,
          visibility: c.row.visibility,
          bpm: c.row.bpm,
          durationSeconds: c.row.durationSeconds,
          numFavorites: c.row.numFavorites,
          numUsages: c.row.numUsages,
          originalTags: c.row.tags,
          bucket: c.bucket,
          tier: c.tier,
          namingFamily: c.namingFamily,
          selectionEvidence: c.evidence,
          sampleKind: c.row.sampleKind,
        }) + "\n",
      );
    }
  }
  backupStream.end();

  const selectionSummary = {
    builder: "step67-build-corpus",
    step: "STEP67",
    generatedAt: new Date().toISOString(),
    sourceMetadata: META_PATH,
    metadataRows: all.length,
    oneShots: oneShots.length,
    loops: loops.length,
    previouslyUsedExcluded: previous.size,
    previousSources: perFile,
    maxSamplesCap: MAX_SAMPLES,
    selectionMethod: {
      primary: "audiotool-tags-as-candidates (evidence-only, never map position)",
      specific: "existing parseNameEvidence/parseTagEvidence each one-shot",
      reproducibility: "deterministic sort + 4-stage diversity pass; no RNG",
      references: "STEP45-build-corpus selection-family",
    },
    totalTarget: Object.values(BUCKET_TARGETS).reduce((a, b) => a + b, 0),
    perBucketTargets: BUCKET_TARGETS,
    selected: selected.length,
    loopSelected: 0,
    perBucket: Object.fromEntries(
      Object.entries(perBucketPicks).map(([b, picks]) => [
        b,
        {
          target: BUCKET_TARGETS[b],
          candidates: (byBucket[b] ?? []).length,
          tiers: (bucketStats[b] ?? {}),
          selected: picks.length,
          distinctOwners: new Set(picks.map((p) => p.row.owner)).size,
          distinctNamingFamilies: new Set(picks.map((p) => p.namingFamily)).size,
          durationBuckets: picks.reduce<Record<string, number>>((m, p) => {
            const k = durBucket(p.row.durationSeconds);
            m[k] = (m[k] ?? 0) + 1;
            return m;
          }, {}),
          status:
            picks.length >= BUCKET_TARGETS[b]
              ? "SATISFIED"
              : picks.length > 0
                ? "INSUFFICIENT_SOURCE_POPULATION"
                : "EMPTY",
        },
      ]),
    ),
    output: { corpus: corpusPath, selection: selectionPath, excluded: excludedPath, backup: backupPath },
    nonNegotiables: {
      tagsAreCandidateEvidenceNotTruth: true,
      noClassifierChange: true,
      oneShotsOnly: true,
      previousCorporaExcluded: true,
      deterministic: true,
    },
  };
  fs.writeFileSync(selectionPath, JSON.stringify(selectionSummary, null, 2) + "\n");
  console.log(JSON.stringify(selectionSummary, null, 2));
}

main();