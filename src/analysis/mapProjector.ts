/**
 * V2 (STEP 20) MapProjector — the map projection boundary.
 *
 * A projector maps a SoundCharacter onto a deterministic 2D point in [0, 1]².
 * This is deliberately NOT a machine-learning projection: no UMAP, t-SNE or PCA
 * (and no corpus-level normalization / re-ranking) — the mapping is a pure
 * function of the sound character vector so identical input always yields
 * identical output, independent of any other samples.
 *
 * V2 does not support its own map rendering; this boundary and the
 * `BaselineProjector` below are the V2.0 FOUNDATION the map work builds on.
 * The V1 `map-v2` algorithm (persisted `mapPosition`) is untouched by STEP 20.
 */
import { assertsWellFormedWeights } from "./config";
import { weightedMean } from "./normalize";
import type { SoundCharacter, SoundCharacterVector } from "./soundCharacter";
import { toSimilarityVector } from "./soundCharacter";

/** Versions every V2 map projection result pins (independent of analysis/similarity versions). */
export const MAP_ALGORITHM_VERSION = "2.0.0" as const;

/** A deterministic 2D position in map space; both coordinates in [0, 1]. */
export interface MapProjectedPosition {
  x: number;
  y: number;
}

/** The map projection boundary. Pure, deterministic, audio-free. */
export interface MapProjector {
  /** The projection algorithm version (`MAP_ALGORITHM_VERSION` for V2.0). */
  version: string;
  /**
   * Project a SoundCharacter to [0, 1]². Same input + same version => same
   * output (never corpus-dependent).
   */
  project(soundCharacter: SoundCharacter): MapProjectedPosition;
}

/** Fallback point when NO dimension is determinable ("neutral center"). */
export const NEUTRAL_POSITION: MapProjectedPosition = { x: 0.5, y: 0.5 };

/** Baseline X-axis weights (sums to 1). */
const X_AXIS_WEIGHTS: readonly number[] = [
  0.2, 0.15, 0.15, 0.2, 0.1, 0.1, 0.05, 0.05,
];
/** Baseline Y-axis weights (sums to 1). */
const Y_AXIS_WEIGHTS: readonly number[] = [
  0.05, 0.05, 0.05, 0.1, 0.2, 0.2, 0.15, 0.2,
];

function projectVector(values: SoundCharacterVector, weights: readonly number[]): number {
  return weightedMean(values, weights) ?? NEUTRAL_POSITION.x;
}

/**
 * V2.0 baseline deterministic projector.
 *
 *   x = weighted mean of the vector over X_AXIS_WEIGHTS
 *   y = weighted mean of the vector over Y_AXIS_WEIGHTS
 *
 * Both weights arrays sum to 1, every vector component is in [0, 1] (or null),
 * so the result is always in [0, 1]². When every dimension is `null` the
 * neutral center (0.5, 0.5) is returned. Deterministic by construction and
 * subject to future calibration (STEP21); this is NOT a perceptual layout.
 */
export function createBaselineMapProjector(): MapProjector {
  assertsWellFormedWeights(X_AXIS_WEIGHTS, "baselineMapProjector.xWeights");
  assertsWellFormedWeights(Y_AXIS_WEIGHTS, "baselineMapProjector.yWeights");
  return {
    version: MAP_ALGORITHM_VERSION,
    project(soundCharacter) {
      const vector = toSimilarityVector(soundCharacter);
      return {
        x: projectVector(vector, X_AXIS_WEIGHTS),
        y: projectVector(vector, Y_AXIS_WEIGHTS),
      };
    },
  };
}