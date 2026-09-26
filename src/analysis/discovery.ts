/**
 * STEP26 — V2 Discovery Intelligence core.
 *
 * A pure, deterministic ORCHESTRATION boundary that joins the three frozen V1/V2
 * systems READ-ONLY — it reimplements none of their math or semantics:
 *
 *   1. TEXT       — the existing `SearchEngine` (relevance over name / tags /
 *                   owner; the search engine already applies the `analyzed`
 *                   default status gate and a deterministic comparator).
 *   2. CHARACTER  — the existing `SoundSpaceCharFilter` predicate
 *                   (`recordMatchesFilter` / `matchesSoundCharacter`).
 *   3. ACOUSTIC   — the existing `rankSimilar` productized ranking over the 8D
 *                   SoundCharacter (version gate, dedupe, self-exclusion, null
 *                   policy, deterministic ordering).
 *
 * Semantics (STEP26 §5–§13):
 *   - TEXT ∧ FILTER = INTERSECTION (a record must match every active source to
 *     be a candidate).
 *   - REFERENCE SIMILARITY = RANKING, not a hard filter: when a reference sample
 *     is provided it ranks the text∧filter candidate set (or the full analyzed
 *     pool when those sources are absent). Non-rankable candidates (no valid V2
 *     character / unsupported version / zero shared dims) cannot participate in
 *     a similarity ranking and are NOT candidates for reference discovery.
 *   - No ML, no embeddings, no LLM, no ANN, no clustering, no fabricated "AI"
 *     scores. Every numeric score comes from an existing system or is a
 *     deterministic boolean-derived constant; the combined `score` uses named,
 *     versioned weights and stays in [0, 1].
 *   - Deterministic: identical index snapshot + query ⇒ identical result list.
 *     Final order is `score DESC`, then `sampleId ASC` (code-unit order).
 *   - Pure: never writes, never loads audio, never triggers analysis, and never
 *     mutates its inputs. `undefined` beside the reference is untouched.
 *
 * Completeness rule (empty query): a discovery run needs at least ONE active
 * criterion (trimmed text, an active character filter, or a reference sample).
 * With none active the result is `[]` ("no criteria") — the orchestrator never
 * invents a browse-order.
 */
import type { SearchEngine } from "../search/searchEngine";
import type { SampleIndexRecord } from "../persistence/indexStore";
import {
  rankSimilar,
  resolveQueryCharacter,
  type SimilarityResult,
} from "./similarityRanking";
import {
  isFilterActive,
  recordMatchesFilter,
  type SoundSpaceCharFilter,
} from "./soundSpaceFilter";

/** Version of the DISCOVERY orchestration semantics (not the sub-system math). */
export const DISCOVERY_ALGORITHM_VERSION = "1.0.0" as const;

/** Default result count when `limit` is omitted. */
export const DISCOVERY_DEFAULT_LIMIT = 10;

/** Hard ceiling of the result count (bounded scan, cheap deterministic ranking). */
export const DISCOVERY_MAX_LIMIT = 100;

/**
 * Named, versioned combination weights (sum = 1). Each ACTIVE source contributes
 * `weight * value`; the combined score is the weighted mean of the ACTIVE source
 * values only (absent sources neither dilute nor boost). Every value is in
 * [0, 1], so the weighted mean stays in [0, 1].
 */
export const DISCOVERY_WEIGHTS = {
  text: 0.35,
  character: 0.2,
  similarity: 0.45,
} as const;

/** The label rendered for a discovery match (never "AI Score" / "Confidence"). */
export const DISCOVERY_MATCH_LABEL = "Match";

/** The three reason kinds; labels are the frozen display copy. */
export type DiscoveryReasonType =
  | "text-match"
  | "character-match"
  | "similar-to-reference";

export interface DiscoveryReason {
  type: DiscoveryReasonType;
  /** Frozen display copy: "Matches search" | "Matches filter" | "Similar". */
  label: string;
}

/** The discovery query (mirrors the spec's DiscoveryQuery). */
export interface DiscoveryQuery {
  /** Free-text tokens (same matching semantics as the existing search bar). */
  text?: string;
  /** The existing Sound Space character filter semantics. */
  characterFilter?: SoundSpaceCharFilter;
  /** The reference sample id; it is excluded from the results (includeSelf=false). */
  referenceSampleId?: string;
  /** Result cap: clamped to [1, DISCOVERY_MAX_LIMIT]; default DISCOVERY_DEFAULT_LIMIT. */
  limit?: number;
}

/** One discovery row: a candidate sample + the arithmetic that explains it. */
export interface DiscoveryResultRow {
  sampleId: string;
  /** Combined score in [0, 1], rounded to 4dp. Bounded + deterministic. */
  score: number;
  /** Always DISCOVERY_MATCH_LABEL ("Match"). */
  label: string;
  /** Active-source reasons in canonical order (text, character, similar). */
  reasons: DiscoveryReason[];
  /** Present when the text source is active: the SearchEngine's score, 2dp+ source truth. */
  searchScore?: number;
  /** Present when the reference source is active: the rankSimilar score. */
  similarity?: number;
  /** Present when the reference source is active: 1 - similarity. */
  distance?: number;
  /** Present when the reference source is active: shared-dimension count. */
  sharedDimensionCount?: number;
}

/** The run context: the existing systems consumed read-only. */
export interface DiscoveryRunOptions {
  /** The app-wide SearchEngine instance (text source). */
  search: SearchEngine;
}

/** Frozen display labels for each reason kind. */
export const DISCOVERY_REASON_LABELS: Record<DiscoveryReasonType, string> = {
  "text-match": "Matches search",
  "character-match": "Matches filter",
  "similar-to-reference": "Similar",
};

/** Clamp a requested limit to [1, DISCOVERY_MAX_LIMIT]; default on invalid input. */
export function sanitizeDiscoveryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DISCOVERY_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n <= 0) return DISCOVERY_DEFAULT_LIMIT;
  return Math.min(n, DISCOVERY_MAX_LIMIT);
}

/** Whether a query has at least one active criterion (text trimmed, filter, or reference). */
export function hasDiscoveryCriterion(query: DiscoveryQuery): boolean {
  if (query.text !== undefined && query.text.trim().length > 0) return true;
  if (isFilterActive(query.characterFilter ?? {})) return true;
  if (query.referenceSampleId !== undefined && query.referenceSampleId.length > 0) {
    return true;
  }
  return false;
}

/** Round a value to 4dp (matches the SearchEngine's own rounding). */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Run a discovery query over an index snapshot.
 *
 * @param records The full index snapshot (e.g. `IndexStore.getAll()`). Never
 *        mutated; deduplicated by `sampleId` (first occurrence wins), mirroring
 *        the index's uniqueness contract defensively.
 * @returns Deterministic rows, score DESC then sampleId ASC, capped to `limit`.
 */
export async function discoverSamples(
  query: DiscoveryQuery,
  records: readonly SampleIndexRecord[],
  options: DiscoveryRunOptions,
): Promise<DiscoveryResultRow[]> {
  const limit = sanitizeDiscoveryLimit(query.limit);

  const textCriteria = query.text !== undefined && query.text.trim().length > 0;
  const filterCriteria = isFilterActive(query.characterFilter ?? {});
  const referenceCriteria =
    query.referenceSampleId !== undefined && query.referenceSampleId.length > 0;

  // Completeness rule: a discovery run needs at least one active criterion.
  if (!textCriteria && !filterCriteria && !referenceCriteria) return [];

  // Index snapshot deduped by sampleId (first occurrence wins) + the analyzed
  // status gate that mirrors the SearchEngine's default projection.
  const pool = new Map<string, SampleIndexRecord>();
  for (const rec of records) {
    if (rec.status !== "analyzed") continue;
    if (!pool.has(rec.sampleId)) pool.set(rec.sampleId, rec);
  }
  if (pool.size === 0) return [];

  // ---- TEXT SOURCE (existing SearchEngine, read-only, async) ----
  const textScoreById = new Map<string, number>();
  if (textCriteria) {
    const hits = await options.search.search({
      text: query.text,
      statuses: ["analyzed"],
    });
    for (const hit of hits) {
      // The candidate pool, not the engine's internal store, is authoritative.
      if (!pool.has(hit.record.sampleId)) continue;
      if (!textScoreById.has(hit.record.sampleId)) {
        textScoreById.set(hit.record.sampleId, hit.score);
      }
    }
  }

  // ---- CHARACTER SOURCE (existing SoundSpaceFilter predicate) ----
  const filterMatched = new Set<string>();
  if (filterCriteria) {
    const filter = query.characterFilter ?? {};
    for (const rec of pool.values()) {
      if (recordMatchesFilter(rec, filter)) filterMatched.add(rec.sampleId);
    }
  }

  // ---- CANDIDATE SET: TEXT ∧ FILTER (intersection), a dominated source, or the
  //      full pool (reference-only). At this point at least one criterion is
  //      active, so the final `else` only runs for reference-only discovery.
  let candidates = new Set<string>();
  if (textCriteria && filterCriteria) {
    for (const id of textScoreById.keys()) {
      if (filterMatched.has(id)) candidates.add(id);
    }
  } else if (textCriteria) {
    candidates = new Set(textScoreById.keys());
  } else if (filterCriteria) {
    candidates = new Set(filterMatched);
  } else {
    candidates = new Set(pool.keys());
  }

  // ---- REFERENCE SOURCE (existing rankSimilar, ranking — never a filter) ----
  let refResult: SimilarityResult[] | undefined;
  if (referenceCriteria) {
    const refId = query.referenceSampleId as string;
    const refRecord = records.find((r) => r.sampleId === refId) ?? pool.get(refId);
    if (refRecord && resolveQueryCharacter(refRecord)) {
      const ranked = rankSimilar(
        refRecord,
        [...candidates].map((id) => pool.get(id) as SampleIndexRecord),
        { limit: candidates.size, includeSelf: false },
      );
      if (ranked.length > 0) refResult = ranked;
    }
  }

  // When a reference is active the result IS the similarity ranking of the
  // candidate set: only similarity-rankable candidates participate.
  let ordered: string[];
  if (refResult) {
    ordered = refResult.map((r) => r.sampleId);
  } else if (referenceCriteria && !textCriteria && !filterCriteria) {
    // Reference-only discovery with a missing/unrankable reference: nothing to
    // order, nothing to show (the UI reports "Select a sample to use as a
    // reference."). With text/filter present the reference just falls back to
    // those sources' natural ordering.
    return [];
  } else {
    ordered = [...candidates];
  }

  const similarityById = new Map<string, SimilarityResult>();
  for (const r of refResult ?? []) similarityById.set(r.sampleId, r);

  // ---- COMBINED SCORE (bounded weighted mean over ACTIVE sources) ----
  const rows: DiscoveryResultRow[] = [];
  for (const id of ordered) {
    const record = pool.get(id);
    if (!record) continue;

    const reasons: DiscoveryReason[] = [];
    let weightedSum = 0;
    let weightSum = 0;

    if (textCriteria) {
      const value = textScoreById.get(id) ?? 0;
      weightedSum += DISCOVERY_WEIGHTS.text * value;
      weightSum += DISCOVERY_WEIGHTS.text;
      reasons.push({ type: "text-match", label: DISCOVERY_REASON_LABELS["text-match"] });
    }
    if (filterCriteria) {
      const value = filterMatched.has(id) ? 1 : 0;
      weightedSum += DISCOVERY_WEIGHTS.character * value;
      weightSum += DISCOVERY_WEIGHTS.character;
      reasons.push({ type: "character-match", label: DISCOVERY_REASON_LABELS["character-match"] });
    }
    const sim = similarityById.get(id);
    if (sim) {
      weightedSum += DISCOVERY_WEIGHTS.similarity * sim.similarity;
      weightSum += DISCOVERY_WEIGHTS.similarity;
      reasons.push({ type: "similar-to-reference", label: DISCOVERY_REASON_LABELS["similar-to-reference"] });
    }

    const score = weightSum > 0 ? weightedSum / weightSum : 0;

    const row: DiscoveryResultRow = {
      sampleId: id,
      score: round4(score),
      label: DISCOVERY_MATCH_LABEL,
      reasons,
    };
    if (textCriteria) row.searchScore = textScoreById.get(id);
    if (sim) {
      row.similarity = round4(sim.similarity);
      row.distance = round4(sim.distance);
      row.sharedDimensionCount = sim.sharedDimensionCount;
    }
    rows.push(row);
  }

  // Deterministic order: score DESC, then sampleId ASC (code-unit order).
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.sampleId < b.sampleId) return -1;
    if (a.sampleId > b.sampleId) return 1;
    return 0;
  });

  return rows.slice(0, limit);
}