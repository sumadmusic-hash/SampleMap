/**
 * V2 (STEP 20) shared constants for the SampleMap analysis domain.
 *
 * The SoundCharacter is the single perceptual 8-dimensional view of a sample
 * that similarity, quality and map projection all consume. Keeping the
 * canonical dimension order and the V2.0 baseline weights in this leaf module
 * (it imports nothing) guarantees `toSimilarityVector`'s order can never drift
 * from the weights array used by the distance engine or the quality score.
 *
 * All dimension values are in [0, 1] (or `null` = "not determinable"; see
 * `src/analysis/soundCharacter.ts` for the null semantics).
 */

/** Canonical SoundCharacter dimension order — the `toSimilarityVector` contract. */
export const SOUND_CHARACTER_DIMENSIONS = [
  "brightness",
  "density",
  "transient",
  "duration",
  "tonality",
  "noisiness",
  "dynamics",
  "complexity",
] as const;

export type SoundCharacterDimension = (typeof SOUND_CHARACTER_DIMENSIONS)[number];

/**
 * V2.0 similarity weights, aligned with `SOUND_CHARACTER_DIMENSIONS`.
 * Values are the STEP 20 design weights; the exact sum (1.0) is verified by the
 * SimilarityEngine at construction time (FP-tolerant).
 */
export const V2_SIMILARITY_WEIGHTS: readonly number[] = [
  0.16, 0.12, 0.18, 0.08, 0.12, 0.12, 0.10, 0.12,
];

/** FP-tolerant tolerance used for "weights sum to 1" checks. */
export const WEIGHT_SUM_TOLERANCE = 1e-9;

/** Fails when `weights` does not cover every SoundCharacter dimension with sum ~1. */
export function assertsWellFormedWeights(
  weights: readonly number[],
  name = "weights",
): void {
  if (weights.length !== SOUND_CHARACTER_DIMENSIONS.length) {
    throw new RangeError(
      `${name}: expected ${SOUND_CHARACTER_DIMENSIONS.length} weights, got ${weights.length}`,
    );
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new RangeError(`${name}: weights must sum to 1 (got ${sum})`);
  }
}