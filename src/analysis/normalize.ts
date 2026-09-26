/**
 * V2 (STEP 20) normalization helpers shared by the SoundCharacter derivation,
 * the similarity engine and the map projector.
 *
 * All helpers are pure and deterministic. NaN/Infinity are NEVER silently
 * coerced: they are inputs to validation (`validateAudioFeatures`) which
 * rejects them outright, and `null` (not `0` or `NaN`) is the single marker for
 * "not determinable".
 */

/** A normalization range: linear or log-compressed over [lo, hi]. */
export interface NormalizeRange {
  lo: number;
  hi: number;
  log: boolean;
}

/** Clamp a finite value into the inclusive [0, 1] range. */
export function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Linear normalization of `value` from [lo, hi] into [0, 1] (clamped).
 * A degenerate range (`hi <= lo`) is a programming error: it yields 0 instead
 * of NaN so callers can never leak a non-finite value.
 */
export function normalize(value: number, lo: number, hi: number): number {
  if (!(hi > lo)) return 0;
  return clamp01((value - lo) / (hi - lo));
}

/**
 * Log-compressed normalization of `value` from [lo, hi] into [0, 1] (clamped).
 * Skewed physical ranges (durations, frequencies) are log-mapped. Requires
 * `lo > 0`; a degenerate range yields 0 instead of NaN.
 */
export function logNormalize(value: number, lo: number, hi: number): number {
  if (!(lo > 0) || !(hi > lo)) return 0;
  const logValue = Math.log10(Math.max(value, lo));
  const logLo = Math.log10(lo);
  const logHi = Math.log10(hi);
  return clamp01((logValue - logLo) / (logHi - logLo));
}

/**
 * Map every present field through `apply`, preserving `null` entries verbatim.
 * Used to normalize feature fields before they enter `weightedMean` without
 * ever turning an absent (`null`) value into a numeric one.
 */
export function mapPresentFields(
  fields: readonly (number | null)[],
  apply: (value: number) => number,
): Array<number | null> {
  return fields.map((v) => (v === null ? null : apply(v)));
}

/**
 * Weighted mean of present fields. `null` entries are skipped and the weights
 * of the remaining fields are renormalized (missing dimensions are never
 * treated as 0). Returns `null` when every field is absent — the safe-state
 * contract used by the similarity engine and quality computation.
 */
export function weightedMean(
  values: readonly (number | null)[],
  weights: readonly number[],
): number | null {
  if (values.length !== weights.length) {
    throw new RangeError(
      `weightedMean: expected ${weights.length} fields, got ${values.length}`,
    );
  }
  let weightSum = 0;
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    weightSum += weights[i];
    acc += weights[i] * v;
  }
  if (!(weightSum > 0)) return null;
  return clamp01(acc / weightSum);
}