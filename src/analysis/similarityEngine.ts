/**
 * V2 (STEP 20) SimilarityEngine — the similarity-space boundary.
 *
 * Pure, deterministic, audio-free: operates ONLY on SoundCharacter vectors
 * (`toSimilarityVector`), never on audio bytes, IndexedDB, DOM or UI.
 *
 * Distance: WEIGHTED EUCLIDEAN over shared dimensions, with the shared weights
 * renormalized to sum 1 (missing dimensions are ignored, never treated as 0).
 * Because every present dimension is in [0, 1], the normalized distance is in
 * [0, 1] and similarity = 1 - distance is in [0, 1].
 *
 * Identities (contract, unit-tested):
 *   - self-similarity is exactly 1
 *   - symmetry: similarity(a, b) === similarity(b, a)
 *   - 0 shared dimensions -> `null` (safe-state, never 0)
 */
import {
  SOUND_CHARACTER_DIMENSIONS,
  V2_SIMILARITY_WEIGHTS,
  assertsWellFormedWeights,
} from "./config";
import type { SoundCharacter } from "./soundCharacter";
import { toSimilarityVector, type SoundCharacterVector } from "./soundCharacter";

/** Versions every V2 similarity result pins (independent of map/analysis versions). */
export const SIMILARITY_ALGORITHM_VERSION = "2.0.0" as const;

/** Configuration of one similarity engine instance. Weights are fixed per V2.0. */
export interface SimilarityConfig {
  algorithmVersion: typeof SIMILARITY_ALGORITHM_VERSION;
  /** Length-8 weights over SOUND_CHARACTER_DIMENSIONS, summing to 1. */
  weights: readonly number[];
}

/** The pure, deterministic similarity-space boundary. */
export interface SimilarityEngine {
  /** The immutable config this engine was created with. */
  config: SimilarityConfig;
  /**
   * Similarity of two sound characters in [0, 1] (`null` = no shared
   * dimension, safe-state). self = 1, symmetric.
   */
  similarity(a: SoundCharacter, b: SoundCharacter): number | null;
}

/**
 * Weighted Euclidean similarity over shared dimensions.
 * `null` dims (either side) are skipped and the weights of the shared dims are
 * renormalized. Returns `null` when no dimension is shared.
 */
export function weightedEuclideanSimilarity(
  a: SoundCharacterVector,
  b: SoundCharacterVector,
  weights: readonly number[],
): number | null {
  if (a.length !== b.length || a.length !== weights.length) {
    throw new RangeError(
      `weightedEuclideanSimilarity: expected equal lengths, got ${a.length}, ${b.length}, ${weights.length}`,
    );
  }
  let weightSum = 0;
  let weightedSq = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i];
    const vb = b[i];
    if (va === null || vb === null) continue;
    const w = weights[i];
    weightSum += w;
    const d = va - vb;
    weightedSq += w * d * d;
  }
  if (!(weightSum > 0)) return null;
  // sqrt(weighted mean of squared diffs) is in [0, 1] because |d| <= 1 and the
  // weights are normalized by weightSum.
  const distance = Math.sqrt(weightedSq / weightSum);
  return 1 - distance;
}

/** Create a deterministic similarity engine over the canonical dimension order. */
export function createSimilarityEngine(
  config?: Partial<SimilarityConfig>,
): SimilarityEngine {
  const weights = config?.weights ?? V2_SIMILARITY_WEIGHTS;
  assertsWellFormedWeights(weights, "similarityConfig.weights");
  const engineConfig: SimilarityConfig = {
    algorithmVersion: SIMILARITY_ALGORITHM_VERSION,
    weights: SOUND_CHARACTER_DIMENSIONS.map((_, i) => weights[i]),
  };
  return {
    config: engineConfig,
    similarity(a, b) {
      return weightedEuclideanSimilarity(
        toSimilarityVector(a),
        toSimilarityVector(b),
        engineConfig.weights,
      );
    },
  };
}

/** The canonical V2.0 configuration used by default everywhere in V2. */
export const V2_SIMILARITY_CONFIG: SimilarityConfig = {
  algorithmVersion: SIMILARITY_ALGORITHM_VERSION,
  weights: V2_SIMILARITY_WEIGHTS,
};