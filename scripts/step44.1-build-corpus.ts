#!/usr/bin/env -S npx tsx
/**
 * STEP44.1 — Targeted One-Shot Reference Corpus Builder.
 *
 * Pure-local, read-only, deterministic selection of a one-shot reference
 * corpus from the REAL Audiotool catalogue (step42-metadata.ndjson), ready for
 * the step44.1-audit loop.
 *
 * Reference construction principles (§1–§7):
 *  - Tags are PROXY LABELS, never ground truth (§15/§26). A corpus row is a
 *    *reference candidate* for exactly ONE class, decided only when the name
 *    and/or tag evidence consistently point to a single specific type.
 *  - Tier A = specific tag + matching name + usage signal (numUsages > 0).
 *    Tier B = specific tag only. Tier C = specific name only.
 *    Tier D = mixed/conflicting specific evidence — excluded from the clean
 *    label pool (ambiguous, never a reference label).
 *  - Generic terms (drum/music/sample/loop/fx…) are metadata evidence only and
 *    are NEVER class selectors.
 *  - Evidence reuses the EXISTING hier-v1 parsers (evidence.ts TYPE_TERMS /
 *    parseTagEvidence / parseNameEvidence / normalizeTag) — no second parser.
 *  - previouslyAnalyzedSampleIds (step42-analysis + step44-analysis rows) are
 *    excluded; overlap is reported when the population gets tight.
 *  - Diversity selection is deterministic: per-class candidates are sorted by
 *    [tier, usage, sampleId] and picked through owner + naming-family quota
 *    passes. Naming family = normalized name with number tokens stripped.
 *
 * Emits:
 *  <dir>/step44.1-reference-corpus.ndjson     one row per selected corpus sample
 *  <dir>/step44.1-corpus-selection.json       per-class availability + pick stats
 *
 * Usage:
 *   npx tsx scripts/step44.1-build-corpus.ts [--out <dir>] [--max-samples N]
 *
 *   --max-samples N  cap total selected samples (smoke tests only; the target
 *                    counts in §14 remain the authoritative default).
 */
import fs from "node:fs";
import path from "node:path";
import type { ClassId } from "../src/classify/classifier";
import { parseNameEvidence, parseTagEvidence, subtypeToType } from "../src/classify/hier/evidence";
import type { SubtypeId } from "../src/classify/drumOntology";
import { normalizeTag } from "../src/classify/normalizeTag";

const OUT_DIR = parseArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step44.1";
const META_PATH =
  parseArg("--meta") ??
  "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step42/step42-metadata.ndjson";
const STEP42_ANALYSIS =
  parseArg("--step42-analysis") ??
  "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step42/step42-analysis.ndjson";
const STEP44_ANALYSIS =
  parseArg("--step44-analysis") ??
  "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step42/step44-analysis.ndjson";
const MAX_SAMPLES = Number(parseArg("--max-samples") ?? "0");

/** §14 target counts (targets, not mandates — shortfall is reported, never hidden). */
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

/** Tier A "high usage" signal (§4): above the one-shot median (p50=2, p75=9). */
const USAGE_SIGNAL_COUNT = 5;

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
  nameTypes: ClassId[];
  tagTypes: ClassId[];
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

/** Previously analyzed ids (STEP42 + STEP44 audit corpora). */
function loadPreviousAnalyzed(paths: string[]): Set<string> {
  const ids = new Set<string>();
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r.sampleId === "string") ids.add(r.sampleId);
      } catch {
        // tolerate torn tail
      }
    }
  }
  return ids;
}

/** Naming family = normalized name with digit tokens removed, so "Kick 01"/"Kick 02" collide. */
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
  /** The distinct specific types found across name+tag evidence. */
  union: ClassId[];
  /** Drum subtypes found across name+tag evidence (existing ontology). */
  subtypes: SubtypeId[];
}

/**
 * Decide the reference class + tier for one metadata row from the EXISTING
 * hier-v1 evidence parsers. A clean label requires the specific name and/or tag
 * evidence to agree on a SINGLE specific ClassId.
 */
function decideReference(row: MetaRow): TierDecision {
  const name = parseNameEvidence(row.name);
  const tag = parseTagEvidence(row.tags ?? []);
  const nameTypes = name.types.filter((t) => t !== "loop" && t !== "other");
  const tagTypes = tag.types.filter((t) => t !== "loop" && t !== "other");
  const subtypes: SubtypeId[] = [...name.subtypes, ...tag.subtypes];
  const union = [...new Set([...nameTypes, ...tagTypes])];
  // Sibling collision hihat↔openhat arises because the "hat" hihat alias phrase
  // matches "open hat". The EXISTING subtype ontology resolves it the same way
  // the classifier does: a unique subtype resolves to exactly one type.
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
 * Deterministic diversity pass over a sorted candidate list. Quotas:
 *  - pass 1: one per owner
 *  - pass 2: owner <= 3 and naming family <= 3
 *  - pass 3: owner <= 5
 *  - pass 4: no quota (survives small pools)
 * Candidates are compared in the exact same order every run.
 */
function selectDiverse(cands: Candidate[], target: number): Candidate[] {
  const chosen: Candidate[] = [];
  const ownerCount = new Map<string, number>();
  const famCount = new Map<string, number>();
  const pick = (c: Candidate) => {
    chosen.push(c);
    ownerCount.set(c.row.owner, (ownerCount.get(c.row.owner) ?? 0) + 1);
    famCount.set(c.namingFamily, (famCount.get(c.namingFamily) ?? 0) + 1);
  };
  const stages: Array<(c: Candidate) => boolean> = [
    (c) => !ownerCount.has(c.row.owner),
    (c) => (ownerCount.get(c.row.owner) ?? 0) < 3 && (famCount.get(c.namingFamily) ?? 0) < 3,
    (c) => (ownerCount.get(c.row.owner) ?? 0) < 5,
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
  /** Deterministic tag band from strong + generic tag evidence. */
  band: string;
  /** Single strong tag type, when the tags agree (a WEAK loop hint, not a label). */
  referenceClass?: ClassId;
  namingFamily: string;
}

function loopBand(row: MetaRow): { band: string; referenceClass?: ClassId } {
  const tag = parseTagEvidence(row.tags ?? []);
  const specific = tag.types.filter((t) => t !== "loop" && t !== "other");
  if (specific.length === 1) {
    const t = specific[0];
    const fam = tag.familyHints[0];
    return { band: fam ?? "generic", referenceClass: t };
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

/** Select the loop validation set (~LOOP_VALIDATION_TARGET, diverse across bands). */
function selectLoops(
  loops: LoopCandidate[],
  target: number,
): LoopCandidate[] {
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
  const bandCount = new Map<string, number>();
  const famCount = new Map<string, number>();
  const pick = (c: LoopCandidate) => {
    chosen.push(c);
    ownerCount.set(c.row.owner, (ownerCount.get(c.row.owner) ?? 0) + 1);
    bandCount.set(c.band, (bandCount.get(c.band) ?? 0) + 1);
    famCount.set(c.namingFamily, (famCount.get(c.namingFamily) ?? 0) + 1);
  };
  const inChosen = new Set<LoopCandidate>();
  const stages: Array<(c: LoopCandidate) => boolean> = [
    (c) => !ownerCount.has(c.row.owner),
    (c) => (ownerCount.get(c.row.owner) ?? 0) < 2 && (famCount.get(c.namingFamily) ?? 0) < 2,
    (c) => (ownerCount.get(c.row.owner) ?? 0) < 4,
    () => true,
  ];
  for (const canPick of stages) {
    // Round-robin across bands so early passes do not starve later bands.
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
          break; // one pick per band per round → interleaving
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

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const corpusPath = path.join(OUT_DIR, "step44.1-reference-corpus.ndjson");
  const selectionPath = path.join(OUT_DIR, "step44.1-corpus-selection.json");

  const all = loadMeta();
  const previous = loadPreviousAnalyzed([STEP42_ANALYSIS, STEP44_ANALYSIS]);
  console.error(`loaded ${all.length} metadata rows; ${previous.size} previously-analyzed ids to exclude`);

  const oneShots = all.filter((r) => r.sampleKind === "one-shot");
  const loops = all.filter((r) => r.sampleKind === "loop");
  console.error(
    `one-shots=${oneShots.length}, loops=${loops.length} (population: one-shot corpus + loop validation)`,
  );

  // ── Classify every one-shot → reference candidate / ambiguous ──────────────
  const byClass: Record<string, Candidate[]> = {};
  const tierCounts: Record<string, Record<string, number>> = {};
  const prevOverlap: Record<string, number> = {};
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
      continue;
    }
    if (!d.clazz) continue;
    if (!(d.clazz in CORPUS_TARGETS)) continue;
    const c: Candidate = {
      row,
      class: d.clazz,
      tier: d.tier!,
      nameTypes: d.tier === "C" || d.tier === "A" ? [d.clazz] : [],
      tagTypes: d.tier === "B" || d.tier === "A" ? [d.clazz] : [],
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
  let totalSelected = 0;
  for (const clazz of Object.keys(CORPUS_TARGETS)) {
    const target = CORPUS_TARGETS[clazz as ClassId];
    const cands = (byClass[clazz] ?? []).sort((a, b) =>
      classSortKey(a).localeCompare(classSortKey(b)),
    );
    const picks = selectDiverse(cands, target);
    const owners = new Set(picks.map((p) => p.row.owner)).size;
    const fams = new Set(picks.map((p) => p.namingFamily)).size;
    selectionStats[clazz] = {
      target,
      candidates: cands.length,
      candidateTiers: tierCounts[clazz] ?? { A: 0, B: 0, C: 0, D: 0 },
      previouslyAnalyzedOverlap: prevOverlap[clazz] ?? 0,
      selected: picks.length,
      tiers: picks.reduce<Record<string, number>>((m, p) => ((m[p.tier] = (m[p.tier] ?? 0) + 1), m), {}),
      distinctOwners: owners,
      distinctNamingFamilies: fams,
      medianDurationSeconds: median(picks.map((p) => p.row.durationSeconds)),
      status: picks.length >= target ? "SATISFIED" : picks.length > 0 ? "INSUFFICIENT_SOURCE_POPULATION" : "EMPTY",
    };
    selected.push(...picks);
    totalSelected += picks.length;
  }

  // Optional smoke cap: truncate to the first MAX_SAMPLES in deterministic order.
  if (MAX_SAMPLES > 0 && selected.length > MAX_SAMPLES) {
    selected.length = MAX_SAMPLES;
    totalSelected = selected.length;
  }

  // ── Loop validation set ────────────────────────────────────────────────────
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

  const summary = {
    builder: "step44.1-build-corpus",
    generatedAt: new Date().toISOString(),
    sourceMetadata: META_PATH,
    metadataRows: all.length,
    oneShots: oneShots.length,
    loops: loops.length,
    previouslyAnalyzedExcluded: previous.size,
    maxSamplesCap: MAX_SAMPLES,
    referenceSelected: selected.length,
    loopValidationSelected: loopPicks.length,
    ambiguousRowsExcluded: ambiguousTotal,
    perClass: selectionStats,
    loopValidation: {
      target: LOOP_VALIDATION_TARGET,
      candidates: loopCands.length,
      previouslyAnalyzedOverlap: loopOverlap.total,
      selected: loopPicks.length,
      bandDistribution: loopBandDist,
      distinctOwners: new Set(loopPicks.map((p) => p.row.owner)).size,
      distinctNamingFamilies: new Set(loopPicks.map((p) => p.namingFamily)).size,
    },
  };
  fs.writeFileSync(selectionPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

main();