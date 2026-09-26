/**
 * Similarity Fingerprint (Step 15J).
 *
 * Computes a deterministic, versioned fingerprint from audio features.
 * The fingerprint is a pure function of AudioFeatures — no I/O, no persistence.
 *
 * Version: similarity-v1 (8 components, fixed weights and normalization bounds).
 */

import type { AudioFeatures } from "../persistence/indexStore";

/** Version constant for the similarity fingerprint. */
export const SIMILARITY_VERSION = "similarity-v1" as const;

/** The 8-component similarity fingerprint. */
export interface SimilarityFingerprint {
  similarityVersion: typeof SIMILARITY_VERSION;
  values: number[];
}

/**
 * Normalization bounds for each component (from design §D).
 * Log-transform is applied to skewed features; others use direct clamp.
 */
const BOUNDS = {
  duration: { lo: 0.01, hi: 60, log: true },
  zeroCrossingRate: { lo: 0, hi: 1, log: false },
  transientDensity: { lo: 0, hi: 20, log: false },
  attack: { lo: 0.001, hi: 1, log: true },
  spectralCentroid: { lo: 100, hi: 8000, log: true },
  spectralBandwidth: { lo: 50, hi: 5000, log: true },
  spectralRolloff: { lo: 100, hi: 10000, log: true },
  tonalNoiseRatio: { lo: 0, hi: 1, log: false },
} as const;

/** Weights for each component (sum = 1.0, from design §C). */
const WEIGHTS = [0.1, 0.1, 0.15, 0.1, 0.2, 0.15, 0.1, 0.1] as const;

/**
 * Normalize a value to [0, 1] using log-compression for skewed features.
 */
function normalize(value: number, bounds: { lo: number; hi: number; log: boolean }): number {
  if (bounds.log) {
    const logVal = Math.log10(Math.max(value, 1e-10));
    const logLo = Math.log10(bounds.lo);
    const logHi = Math.log10(bounds.hi);
    return clamp01((logVal - logLo) / (logHi - logLo));
  } else {
    return clamp01((value - bounds.lo) / (bounds.hi - bounds.lo));
  }
}

/**
 * Clamp a value to [0, 1].
 */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Compute the similarity fingerprint from audio features.
 *
 * The fingerprint is deterministic: same features always produce the same fingerprint.
 * It contains 8 normalized components in fixed order (duration, zeroCrossingRate,
 * transientDensity, attack, spectralCentroid, spectralBandwidth, spectralRolloff,
 * tonalNoiseRatio).
 */
export function computeSimilarityFingerprint(features: AudioFeatures): SimilarityFingerprint {
  const values = [
    normalize(features.duration, BOUNDS.duration),
    normalize(features.zeroCrossingRate, BOUNDS.zeroCrossingRate),
    normalize(features.transientDensity, BOUNDS.transientDensity),
    normalize(features.attack, BOUNDS.attack),
    normalize(features.spectralCentroid, BOUNDS.spectralCentroid),
    normalize(features.spectralBandwidth, BOUNDS.spectralBandwidth),
    normalize(features.spectralRolloff, BOUNDS.spectralRolloff),
    normalize(features.tonalNoiseRatio, BOUNDS.tonalNoiseRatio),
  ];

  return {
    similarityVersion: SIMILARITY_VERSION,
    values,
  };
}

/**
 * Get the weights for the similarity distance calculation.
 */
export function getWeights(): readonly number[] {
  return WEIGHTS;
}