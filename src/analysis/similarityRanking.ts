/**
 * V2 (STEP 22) SimilarityRanking — the productized ranking surface over the
 * frozen STEP20 `SimilarityEngine` math.
 *
 * `rankSimilar` takes ONE query (`SampleIndexRecord` or a bare `SampleAnalysisV2`)
 * and a candidate list of index records, and returns the top-K neighbours in the
 * canonical 8D SoundCharacter space, deterministically ordered.
 *
 * It does NOT change the STEP20 algorithm: it composes `createSimilarityEngine()`
 * (weighted Euclidean over shared dims, shared-weight renormalization,
 * `null` on zero shared dims, self = 1, symmetric). It adds only the
 * PRODUCTIZATION semantics below, each pinned by a named policy.
 *
 * Ranking policies (this module's contract, unit-tested in
 * `similarityRanking.test.ts`):
 *   1. Version policy — a candidate/query whose `analysisV2.analysisVersion`
 *      differs from `ANALYSIS_VERSION` ("2.0.0") is NEVER compared; it is
 *      excluded outright (explicit rejection, never a silent cross-version
 *      comparison). The math itself stays pinned to
 *      `SIMILARITY_ALGORITHM_VERSION = "2.0.0"`. `SIMILARITY_RANKING_VERSION`
 *      is the productization-layer version of THIS surface and only bumps on a
 *      ranking-semantics change, not on math refactors.
 *   2. Duplicate policy — candidates are deduplicated by `sampleId`
 *      (first occurrence in the input order wins; later duplicates are
 *      ignored). A sampleId is emitted at most once.
 *   3. Self policy — identity is `sampleId`. The query record is excluded by
 *      default (`includeSelf: false`). A bare `SampleAnalysisV2` has no
 *      sampleId, so self-exclusion cannot apply to it. `includeSelf: true`
 *      ranks the query record like any other candidate.
 *   4. Tie-break — `similarity DESC`, then `sampleId ASC` (code-unit
 *      lexicographic). The output is fully deterministic for a given input.
 *   5. Null policy — a candidate with ZERO shared dimensions (only
 *      `null`/missing opposite dims) yields `null` similarity and is EXCLUDED
 *      (never 0 = "maximally dissimilar").
 *   6. Coverage gate — optional `minFeatureCoverage` (fraction of the 8 dims
 *      determinable, `analysisV2.quality.featureCoverage` / computed from the
 *      character). Default: OFF (pure similarity). When set, it applies to the
 *      QUERY and every candidate.
 *   7. Limit policy — `limit` is bounded to [1, RANKING_MAX_LIMIT] and defaults
 *      to RANKING_DEFAULT_LIMIT (10); out-of-range/invalid values are clamped
 *      or defaulted, never throw.
 */
import {
  createSimilarityEngine,
  type SimilarityEngine,
} from "./similarityEngine";
import { ANALYSIS_VERSION, type SampleAnalysisV2 } from "./sampleAnalysisV2";
import {
  computeSoundCharacterQuality,
  toSimilarityVector,
  validateSoundCharacter,
  type SoundCharacter,
} from "./soundCharacter";
import type { SampleIndexRecord } from "../persistence/indexStore";

/** Productization-layer version of the ranking surface (not the math version). */
export const SIMILARITY_RANKING_VERSION = "1.0.0" as const;

/** Default top-K when `limit` is omitted (matches the product's previous default). */
export const RANKING_DEFAULT_LIMIT = 10;

/** Hard ceiling of the top-K (bounded scan, cheap deterministic ranking). */
export const RANKING_MAX_LIMIT = 100;

/** The only analysis version the ranking surface compares against. */
export const RANKING_SUPPORTED_ANALYSIS_VERSION = ANALYSIS_VERSION;

export interface SimilarityRankOptions {
  /** Top-K bound; clamped to [1, RANKING_MAX_LIMIT]; default RANKING_DEFAULT_LIMIT. */
  limit?: number;
  /** Rank the query record itself when it appears among the candidates. */
  includeSelf?: boolean;
  /**
   * Optional quality gate: only samples with at least this fraction of the 8
   * dimensions determinable participate. Applies to the query too. `undefined`
   * (default) = no quality gate — pure similarity.
   */
  minFeatureCoverage?: number;
}

/** One ranked neighbour: score + the arithmetic that produced it. */
export interface SimilarityResult {
  /** The candidate's `sampleId` (unique in the result list). */
  sampleId: string;
  /** Weighted-Euclidean similarity in [0, 1] (never null here — null is excluded). */
  similarity: number;
  /** 1 - similarity; the normalized weighted-Euclidean distance in [0, 1]. */
  distance: number;
  /** Number of dimensions shared (present on both sides) — basis of the score. */
  sharedDimensionCount: number;
}

/** The query forms `rankSimilar` accepts. */
export type SimilarityQuery = SampleIndexRecord | SampleAnalysisV2;

const engine: SimilarityEngine = createSimilarityEngine();

/**
 * Resolve the query's SoundCharacter from either accepted form.
 * `undefined` when the record carries no valid analysisV2 (nothing to rank by).
 */
export function resolveQueryCharacter(query: SimilarityQuery): SoundCharacter | undefined {
  if ("soundCharacter" in query) return query.soundCharacter;
  const analysis = query.analysisV2;
  if (!analysis) return undefined;
  return extractAnalysisCharacter(analysis);
}

/**
 * Extract a candidate's comparable SoundCharacter, applying the version +
 * structural gates. `undefined` = "not rankable" (missing analysisV2,
 * unsupported analysis version, or a malformed character).
 */
export function extractCandidateCharacter(record: SampleIndexRecord): SoundCharacter | undefined {
  return record.analysisV2 ? extractAnalysisCharacter(record.analysisV2) : undefined;
}

/** Version + structural gate shared by the query and candidate paths. */
function extractAnalysisCharacter(analysis: SampleAnalysisV2): SoundCharacter | undefined {
  if (analysis.analysisVersion !== RANKING_SUPPORTED_ANALYSIS_VERSION) return undefined;
  if (!validateSoundCharacter(analysis.soundCharacter).valid) return undefined;
  return analysis.soundCharacter;
}

/** Clamp a requested top-K to [1, RANKING_MAX_LIMIT]; default on invalid input. */
export function sanitizeRankingLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return RANKING_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n <= 0) return RANKING_DEFAULT_LIMIT;
  return Math.min(n, RANKING_MAX_LIMIT);
}

/** Throws on a `minFeatureCoverage` outside [0, 1] (programmer error). */
function assertCoverage(option: number | undefined): void {
  if (option !== undefined && (typeof option !== "number" || !Number.isFinite(option) || option < 0 || option > 1)) {
    throw new RangeError(
      `rankSimilar: minFeatureCoverage must be a finite number in [0, 1] (got ${option})`,
    );
  }
}

function sharedDimensionCount(a: SoundCharacter, b: SoundCharacter): number {
  const va = toSimilarityVector(a);
  const vb = toSimilarityVector(b);
  let count = 0;
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== null && vb[i] !== null) count++;
  }
  return count;
}

/**
 * Deterministic sort (`similarity DESC`, `sampleId ASC`) + bounded top-K.
 * Exported so the ordering contract is independently testable.
 */
export function sortAndLimitSimilarityResults(
  scored: readonly SimilarityResult[],
  limit?: number,
): SimilarityResult[] {
  return [...scored]
    .sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      if (a.sampleId < b.sampleId) return -1;
      if (a.sampleId > b.sampleId) return 1;
      return 0;
    })
    .slice(0, sanitizeRankingLimit(limit));
}

/**
 * Rank the candidates against ONE query by the canonical 8D SoundCharacter.
 *
 * Deterministic, audio-free, persistence-free, O(candidates × 8). Exclusions
 * (see module docstring): incompatible analysis version, malformed character,
 * duplicate sampleId (first wins), the query itself (unless `includeSelf`),
 * zero-shared-dimension `null` scores, and any candidate below the optional
 * `minFeatureCoverage` gate.
 */
export function rankSimilar(
  query: SimilarityQuery,
  candidates: readonly SampleIndexRecord[],
  options: SimilarityRankOptions = {},
): SimilarityResult[] {
  assertCoverage(options.minFeatureCoverage);

  const charA = resolveQueryCharacter(query);
  if (!charA) return [];

  const minCoverage = options.minFeatureCoverage;
  if (minCoverage !== undefined && computeSoundCharacterQuality(charA).featureCoverage < minCoverage) {
    return [];
  }

  const queryId = "sampleId" in query ? query.sampleId : undefined;
  const includeSelf = options.includeSelf === true;

  const seen = new Set<string>();
  const scored: SimilarityResult[] = [];
  for (const rec of candidates) {
    if (seen.has(rec.sampleId)) continue; // policy 2: first occurrence wins
    seen.add(rec.sampleId);
    if (!includeSelf && rec.sampleId === queryId) continue; // policy 3
    const charB = extractCandidateCharacter(rec);
    if (!charB) continue; // policy 1 + structural gate
    if (minCoverage !== undefined && computeSoundCharacterQuality(charB).featureCoverage < minCoverage) {
      continue; // policy 6
    }
    const similarity = engine.similarity(charA, charB);
    if (similarity === null) continue; // policy 5: 0 shared dims
    scored.push({
      sampleId: rec.sampleId,
      similarity,
      distance: 1 - similarity,
      sharedDimensionCount: sharedDimensionCount(charA, charB),
    });
  }

  return sortAndLimitSimilarityResults(scored, options.limit);
}