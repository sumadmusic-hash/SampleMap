/**
 * Similarity Distance (Step 15J).
 *
 * Weighted Euclidean distance + similarity score (1 - d).
 * Both are pure, deterministic functions of two fingerprints.
 */

import {
  SIMILARITY_VERSION,
  getWeights,
} from "./similarityFingerprint";

/**
 * Compute the weighted Euclidean distance between two fingerprints.
 *
 * d = sqrt( sum_i w_i * (q_i - t_i)^2 ) / sqrt( sum_i w_i )
 *
 * With weights summing to 1, `sqrt(sum w_i) = 1` and d is in [0, 1].
 *
 * Throws if the fingerprints have incompatible versions or different lengths.
 */
export function similarityDistance(
  query: { similarityVersion: string; values: number[] },
  target: { similarityVersion: string; values: number[] },
): number {
  if (query.similarityVersion !== target.similarityVersion) {
    throw new Error(
      `incompatible similarity versions: ${query.similarityVersion} vs ${target.similarityVersion}`,
    );
  }
  if (query.similarityVersion !== SIMILARITY_VERSION) {
    throw new Error(
      `unsupported similarity version: ${query.similarityVersion}`,
    );
  }
  if (query.values.length !== target.values.length) {
    throw new Error(
      `fingerprint length mismatch: ${query.values.length} vs ${target.values.length}`,
    );
  }

  const weights = getWeights();
  if (weights.length !== query.values.length) {
    throw new Error(
      `weights length mismatch: ${weights.length} vs ${query.values.length}`,
    );
  }

  let sq = 0;
  let wsum = 0;
  for (let i = 0; i < query.values.length; i++) {
    const w = weights[i];
    sq += w * (query.values[i] - target.values[i]) ** 2;
    wsum += w;
  }

  return Math.sqrt(sq) / Math.sqrt(wsum);
}

/**
 * Compute the similarity score (0..1) between two fingerprints.
 * similarity = 1 - d
 */
export function similarityScore(
  query: { similarityVersion: string; values: number[] },
  target: { similarityVersion: string; values: number[] },
): number {
  const d = similarityDistance(query, target);
  return clamp01(1 - d);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}