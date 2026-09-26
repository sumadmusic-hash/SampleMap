#!/usr/bin/env -S npx tsx
/**
 * STEP45 — Targeted One-Shot Reference Discovery (corpus builder).
 *
 * Deliberately-targeted discovery over the REAL Audiotool catalogue (§4/§6):
 *  - one-shots only for primary calibration (§2.1)
 *  - explicit specific tag → preferred; matching name token → secondary quality
 *  - previous corpora EXCLUDED: STEP42 + STEP44 (180) + STEP44.1 (629 analysis
 *    rows + 630 corpus rows) + the STEP44 rerun (180) — the full set of every
 *    sample id ever used by an audit/calibration step.
 *  - deterministic, reproducible; TIERS A/B/C per §5, Tier D (metadata
 *    conflict) RETAINED in a SEPARATE conflict corpus (never a clean label).
 *  - diversity across owner, naming family AND duration bucket (new pass) with
 *    content-hash uniqueness verified at analysis time (never trusted blindly).
 *
 * Tags label candidate REFERENCES; they never force the classifier output
 * (§2.2 / §19). The reference label and the acoustic-output distinction stays
 * explicit in every row (referenceTier / referenceClass vs audioOnly/full).
 *
 * Emits into <out> (default …/step45):
 *   step45-reference-corpus.ndjson   references (Tier A/B/C) + loop validation
 *   step45-conflict-corpus.ndjson    Tier D (mixed tag/name evidence), reasons
 *   step45-corpus-selection.json     deterministic selection + availability
 *
 * Usage:
 *   npx tsx scripts/step45-build-corpus.ts [--out <dir>] [--max-samples N]
 */
import fs from "node:fs";
import path from "node:path";
import type { ClassId } from "../src/classify/classifier";
import { parseNameEvidence, parseTagEvidence, subtypeToType } from "../src/classify/hier/evidence";
import type { SubtypeId } from "../src/classify/drumOntology";
import { normalizeTag } from "../src/classify/normalizeTag";

const OUT_DIR = parseArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step45";
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
    ];
const MAX_SAMPLES = Number(parseArg("--max-samples") ?? "0");

/** §3/§15 per-class targets (targets, not mandates — shortfall reported). */
export const CORPUS_TARGETS: Record<ClassId, number> = {
  kick: 50,
  snare: 50,
  clap: 40,
  hihat: 40,
  openhat: 30,
  tom: 30,
  cymbal: 30,
  percussion: 30,
  bass: 30,
  piano: 20,
  guitar: 20,
  strings: 20,
  keys: 20,
  synth: 30,
  pad: 30,
  lead: 30,
  vocal: 30,
  fx: 30,
  noise: 15,
  atmosphere: 15,
};

export const LOOP_VALIDATION_TARGET = 40;

const USAGE_SIGNAL_COUNT = 5;

/** Durations buckets used for the diversity pass (spread, not a rule). */
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
  class: ClassId;
  tier: "A" | "B" | "C";
  namingFamily: string;
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

/** Every sampleId ever analysed/selected by a previous calibration step. */
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

interface TierDecision {
  clazz?: ClassId;
  tier?: "A" | "B" | "C";
  /** D = genuinely mixed evidence (never used as a clean label). */
  ambiguous: boolean;
  union: ClassId[];
  subtypes: SubtypeId[];
}

function decideReference(row: MetaRow): TierDecision {
  const name = parseNameEvidence(row.name);
  const tag = parseTagEvidence(row.tags ?? []);
  const nameTypes = name.types.filter((t) => t !== "loop" && t !== "other");
  const tagTypes = tag.types.filter((t) => t !== "loop" && t !== "other");
  const subtypes: SubtypeId[] = [...name.subtypes, ...tag.subtypes];
  const union = [...new Set([...nameTypes, ...tagTypes])];
  if (union.includes("hihat") && union.includes("openhat") && union.length === 2) {
    const subtypeTypes = [...new Set(subtypes.map(subtypeToType))];
    if (subtypeTypes.length === 1 && subtypeTypes[0] !== undefined) {
      union.length = 0;
      union.push(subtypeTypes[0]);
    }
  }
  if (union.length !== 1) {
    return { ambiguous: union.length > 1, clazz: undefined, union, subtypes };
  }
  const clazz = union[0];
  const hasName = nameTypes.includes(clazz);
  const hasTag = tagTypes.includes(clazz);
  if (hasTag && hasName) {
    return {
      clazz,
      tier: row.numUsages >= USAGE_SIGNAL_COUNT ? "A" : "B",
      ambiguous: false,
      union,
      subtypes,
    };
  }
  if (hasTag) return { clazz, tier: "B", ambiguous: false, union, subtypes };
  if (hasName) return { clazz, tier: "C", ambiguous: false, union, subtypes };
  return { ambiguous: false, union, subtypes };
}

/**
 * Deterministic diversity pass over a sorted candidate list (§4.8–4.11):
 *  - pass 1: one per owner
 *  - pass 2: owner <= 3 and naming family <= 3
 *  - pass 3: owner <= 5 AND duration-bucket cap (~target/5, floor 2) — spreads
 *    picks across durations without starving a short class
 *  - pass 4: no quota (only fills a genuinely small pool)
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

interface LoopCandidate {
  row: MetaRow;
  band: string;
  referenceClass?: ClassId;
  namingFamily: string;
}

function loopBand(row: MetaRow): { band: string; referenceClass?: ClassId } {
  const tag = parseTagEvidence(row.tags ?? []);
  const specific = tag.types.filter((t) => t !== "loop" && t !== "other");
  if (specific.length === 1) {
    const fam = tag.familyHints[0];
    return { band: fam ?? "generic", referenceClass: specific[0] };
  }
  if (tag.generic.includes("drum") || tag.familyHints.includes("drums")) return { band: "drums" };
  if (tag.familyHints.includes("musical")) return { band: "musical" };
  if (tag.familyHints.includes("vocal")) return { band: "vocal" };
  if (tag.familyHints.includes("fx")) return { band: "fx" };
  if (tag.familyHints.includes("atmosphere-noise") || tag.generic.includes("noise"))
    return { band: "atmosphere-noise" };
  if (tag.types.length > 1) return { band: "mixed" };
  return { band: "generic" };
}

function selectLoops(loops: LoopCandidate[], target: number): LoopCandidate[] {
  const byBand = new Map<string, LoopCandidate[]>();
  for (const c of loops) {
    const list = byBand.get(c.band) ?? [];
    list.push(c);
    byBand.set(c.band, list);
  }
  const bands = [...byBand.keys()].sort(
    (a, b) => (LOOP_BAND_RANK[a] ?? 9) - (LOOP_BAND_RANK[b] ?? 9),
  );
  for (const b of bands) {
    byBand.get(b)!.sort((a, x) => a.row.sampleId.localeCompare(x.row.sampleId));
  }
  const chosen: LoopCandidate[] = [];
  const ownerCount = new Map<string, number>();
  const famCount = new Map<string, number>();
  const inChosen = new Set<LoopCandidate>();
  const pick = (c: LoopCandidate) => {
    chosen.push(c);
    ownerCount.set(c.row.owner, (ownerCount.get(c.row.owner) ?? 0) + 1);
    famCount.set(c.namingFamily, (famCount.get(c.namingFamily) ?? 0) + 1);
  };
  const stages: Array<(c: LoopCandidate) => boolean> = [
    (c) => !ownerCount.has(c.row.owner),
    (c) => (ownerCount.get(c.row.owner) ?? 0) < 2 && (famCount.get(c.namingFamily) ?? 0) < 2,
    () => (ownerCount.get(c.row.owner) ?? 0) < 4,
    () => true,
  ];
  for (const canPick of stages) {
    let progressed = true;
    while (progressed && chosen.length < target) {
      progressed = false;
      for (const b of bands) {
        if (chosen.length >= target) break;
        for (const c of byBand.get(b)!) {
          if (chosen.length >= target) break;
          if (inChosen.has(c)) continue;
          if (!canPick(c)) continue;
          inChosen.add(c);
          pick(c);
          progressed = true;
          break;
        }
      }
    }
  }
  return chosen;
}

const LOOP_BAND_RANK: Record<string, number> = {
  drums: 0,
  musical: 1,
  vocal: 2,
  fx: 3,
  "atmosphere-noise": 4,
  generic: 5,
  mixed: 6,
};

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(nums: number[], q: number): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)));
  return s[i];
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const corpusPath = path.join(OUT_DIR, "step45-reference-corpus.ndjson");
  const conflictPath = path.join(OUT_DIR, "step45-conflict-corpus.ndjson");
  const selectionPath = path.join(OUT_DIR, "step45-corpus-selection.json");

  const all = loadMeta();
  const { ids: previous, perFile } = loadPreviousAnalyzed(PREVIOUS_FILES);
  console.error(
    `loaded ${all.length} metadata rows; excluding ${previous.size} previously-used ids (${JSON.stringify(perFile)})`,
  );

  const oneShots = all.filter((r) => r.sampleKind === "one-shot");
  const loops = all.filter((r) => r.sampleKind === "loop");
  console.error(`one-shots=${oneShots.length}, loops=${loops.length}`);

  // ── Reference candidates + Tier-D (conflict) candidates ────────────────────
  const byClass: Record<string, Candidate[]> = {};
  const tierCounts: Record<string, Record<string, number>> = {};
  const prevOverlap: Record<string, number> = {};
  const conflictPool: Record<string, Array<{ row: MetaRow; union: ClassId[]; subtypes: SubtypeId[] }>> = {};
  let ambiguousTotal = 0;
  for (const row of oneShots) {
    const d = decideReference(row);
    if (d.ambiguous) {
      ambiguousTotal++;
      for (const t of d.union) {
        if (t in CORPUS_TARGETS) {
          (tierCounts[t] ??= { A: 0, B: 0, C: 0, D: 0 })["D"]++;
        }
      }
      if (previous.has(row.sampleId)) continue;
      const uniq = [...new Set(d.union)].filter((t) => t in CORPUS_TARGETS);
      if (uniq.length > 0) {
        const primary = uniq[0];
        (conflictPool[primary] ??= []).push({ row, union: d.union, subtypes: d.subtypes });
      }
      continue;
    }
    if (!d.clazz) continue;
    if (!(d.clazz in CORPUS_TARGETS)) continue;
    const c: Candidate = {
      row,
      class: d.clazz,
      tier: d.tier!,
      namingFamily: namingFamilyOf(row.name),
    };
    if (previous.has(row.sampleId)) {
      prevOverlap[d.clazz] = (prevOverlap[d.clazz] ?? 0) + 1;
      continue;
    }
    (byClass[d.clazz] ??= []).push(c);
    (tierCounts[d.clazz] ??= { A: 0, B: 0, C: 0 })[c.tier]++;
  }

  // ── Deterministic per-class selection ──────────────────────────────────────
  const selected: Candidate[] = [];
  const selectionStats: Record<string, Record<string, unknown>> = {};
  for (const clazz of Object.keys(CORPUS_TARGETS)) {
    const target = CORPUS_TARGETS[clazz as ClassId];
    const cands = (byClass[clazz] ?? []).sort((a, b) =>
      classSortKey(a).localeCompare(classSortKey(b)),
    );
    const picks = selectDiverse(cands, target);
    const owners = new Set(picks.map((p) => p.row.owner)).size;
    const fams = new Set(picks.map((p) => p.namingFamily)).size;
    const durs = picks.map((p) => p.row.durationSeconds);
    const buckets: Record<string, number> = {};
    for (const p of picks) {
      const b = durBucket(p.row.durationSeconds);
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    selectionStats[clazz] = {
      target,
      candidates: cands.length,
      candidateTiers: tierCounts[clazz] ?? { A: 0, B: 0, C: 0, D: 0 },
      previouslyUsedExcluded: prevOverlap[clazz] ?? 0,
      conflictCandidatesHeld: (conflictPool[clazz] ?? []).length,
      selected: picks.length,
      tiers: picks.reduce<Record<string, number>>((m, p) => ((m[p.tier] = (m[p.tier] ?? 0) + 1), m), {}),
      distinctOwners: owners,
      distinctNamingFamilies: fams,
      durationBuckets: buckets,
      durationQuartiles: [pct(durs, 0.25), pct(durs, 0.5), pct(durs, 0.75)].map((v) => (v === 0 ? 0 : Math.round(v * 1000) / 1000)),
      status: picks.length >= target ? "SATISFIED" : picks.length > 0 ? "INSUFFICIENT_SOURCE_POPULATION" : "EMPTY",
    };
    selected.push(...picks);
  }

  if (MAX_SAMPLES > 0 && selected.length > MAX_SAMPLES) {
    selected.length = MAX_SAMPLES;
  }

  // ── Tier-D conflict corpus (deterministic, top-5 per class by usage) ──────
  const conflictSelected: Array<Record<string, unknown>> = [];
  for (const clazz of Object.keys(conflictPool)) {
    const pool = (conflictPool[clazz] ?? [])
      .sort((a, b) =>
        `${String(b.row.numUsages).padStart(6, "0")}.${a.row.sampleId}`.localeCompare(
          `${String(a.row.numUsages).padStart(6, "0")}.${b.row.sampleId}`,
        ),
      )
      .slice(0, 5);
    for (const c of pool) {
      conflictSelected.push({
        kind: "conflict",
        sampleId: c.row.sampleId,
        name: c.row.name,
        owner: c.row.owner,
        durationSeconds: c.row.durationSeconds,
        numUsages: c.row.numUsages,
        originalTags: c.row.tags,
        primaryReferenceClass: clazz,
        conflictingEvidence: c.union,
        reason: "TAG_NAME_CONFLICT",
        note: "Tier D (STEP45 §5) — never a primary calibration reference; retained for conflict analysis",
      });
    }
  }

  // ── Loop validation set (unchanged method, fresh corpus) ───────────────────
  const loopCands: LoopCandidate[] = [];
  const loopOverlap = { total: 0 };
  for (const row of loops) {
    if (row.durationSeconds < 2 || row.durationSeconds > 60) continue;
    if (previous.has(row.sampleId)) {
      loopOverlap.total++;
      continue;
    }
    const { band, referenceClass } = loopBand(row);
    loopCands.push({ row, band, referenceClass, namingFamily: namingFamilyOf(row.name) });
  }
  const loopPicks = selectLoops(loopCands, LOOP_VALIDATION_TARGET);
  const loopBandDist: Record<string, number> = {};
  for (const p of loopPicks) loopBandDist[p.band] = (loopBandDist[p.band] ?? 0) + 1;

  // ── Emit ───────────────────────────────────────────────────────────────────
  const stream = fs.createWriteStream(corpusPath, { flags: "w" });
  for (const c of selected) {
    stream.write(
      JSON.stringify({
        kind: "reference",
        sampleId: c.row.sampleId,
        name: c.row.name,
        owner: c.row.owner,
        visibility: c.row.visibility,
        bpm: c.row.bpm,
        durationSeconds: c.row.durationSeconds,
        numFavorites: c.row.numFavorites,
        numUsages: c.row.numUsages,
        originalTags: c.row.tags,
        referenceClass: c.class,
        referenceTier: c.tier,
        namingFamily: c.namingFamily,
      }) + "\n",
    );
  }
  for (const p of loopPicks) {
    stream.write(
      JSON.stringify({
        kind: "loop-validation",
        sampleId: p.row.sampleId,
        name: p.row.name,
        owner: p.row.owner,
        visibility: p.row.visibility,
        bpm: p.row.bpm,
        durationSeconds: p.row.durationSeconds,
        numFavorites: p.row.numFavorites,
        numUsages: p.row.numUsages,
        originalTags: p.row.tags,
        referenceClass: p.referenceClass ?? null,
        loopBand: p.band,
        namingFamily: p.namingFamily,
      }) + "\n",
    );
  }
  stream.end();
  fs.writeFileSync(conflictPath, conflictSelected.map((c) => JSON.stringify(c)).join("\n") + "\n");

  const summary = {
    builder: "step45-build-corpus",
    generatedAt: new Date().toISOString(),
    sourceMetadata: META_PATH,
    metadataRows: all.length,
    oneShots: oneShots.length,
    loops: loops.length,
    previouslyUsedExcluded: previous.size,
    previousSources: perFile,
    maxSamplesCap: MAX_SAMPLES,
    referenceSelected: selected.length,
    loopValidationSelected: loopPicks.length,
    ambiguousTierDRowsExcluded: ambiguousTotal,
    conflictCorpusSelected: conflictSelected.length,
    perClass: selectionStats,
    loopValidation: {
      target: LOOP_VALIDATION_TARGET,
      candidates: loopCands.length,
      previouslyUsedOverlap: loopOverlap.total,
      selected: loopPicks.length,
      bandDistribution: loopBandDist,
      distinctOwners: new Set(loopPicks.map((p) => p.row.owner)).size,
      distinctNamingFamilies: new Set(loopPicks.map((p) => p.namingFamily)).size,
    },
    nonNegotiables: {
      oneShotsOnlyForCalibration: true,
      tagsAreReferenceLabelsNotTruth: true,
      noML: true,
      noTagAsTruthClassifier: true,
      noMassMigration: true,
    },
  };
  fs.writeFileSync(selectionPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}

main();