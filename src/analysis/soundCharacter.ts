/**
 * V2 (STEP 20) SoundCharacter — the perceptual 8-dimensional view of a sample.
 *
 * Each dimension value is in [0, 1], or `null` when NOT determinable (null is
 * never substituted with 0). The derivation below is the V2.0 DETERMINISTIC
 * BASELINE mapping — transparent formulas, subject to future calibration in
 * STEP21 ("Sound Character Engine Calibration / Productization").
 *
 * Layer rule: SoundCharacter is derived from RAW DSP FEATURES
 * (`AudioFeaturesV2`) and consumed by SIMILARITY and MAP projection; it never
 * touches audio bytes and never reads persistence.
 */
import {
  SOUND_CHARACTER_DIMENSIONS,
  V2_SIMILARITY_WEIGHTS,
} from "./config";
import { clamp01, logNormalize, normalize, weightedMean, type NormalizeRange } from "./normalize";
import type { AudioFeaturesV2 } from "./audioFeaturesV2";

/** One perceptual dimension in [0, 1]; `null` = "not determinable". */
export interface SoundCharacter {
  brightness: number | null;
  density: number | null;
  transient: number | null;
  duration: number | null;
  tonality: number | null;
  noisiness: number | null;
  dynamics: number | null;
  complexity: number | null;
}

/** Perceptual fingerprint of the derived character, both in [0, 1]. */
export interface SoundCharacterQuality {
  /**
   * Weighted (V2 similarity weights) mean of the PRESENT dimension values —
   * a deterministic overall perceptual-strength score in [0, 1]. `0` when no
   * dimension is determinable.
   */
  overall: number;
  /** Fraction of the 8 dimensions that are determinable (0..1). */
  featureCoverage: number;
}

/**
 * Build a fully-`null` SoundCharacter (safe-state / "nothing determinable").
 */
export function emptySoundCharacter(): SoundCharacter {
  return {
    brightness: null,
    density: null,
    transient: null,
    duration: null,
    tonality: null,
    noisiness: null,
    dynamics: null,
    complexity: null,
  };
}

/** Fixed normalization ranges for the V2.0 baseline mappings. */
const RANGES = {
  centroidHz: { lo: 100, hi: 10000, log: true },
  rolloffHz: { lo: 1000, hi: 15000, log: false },
  flux: { lo: 0, hi: 2, log: false },
  zcr: { lo: 0, hi: 0.5, log: false },
  transientStrength: { lo: 0, hi: 20, log: false },
  crest: { lo: 1, hi: 20, log: false },
  durationSec: { lo: 0.01, hi: 60, log: true },
  attackSec: { lo: 0.0005, hi: 0.05, log: false },
  decaySec: { lo: 0.001, hi: 5, log: false },
  spreadHz: { lo: 50, hi: 5000, log: false },
  flatness: { lo: 0, hi: 1, log: false },
} as const;

type RangeKey = (typeof RANGES)[keyof typeof RANGES];

function norm(value: number | null, range: RangeKey & NormalizeRange): number | null {
  if (value === null) return null;
  return range.log ? logNormalize(value, range.lo, range.hi) : normalize(value, range.lo, range.hi);
}

/**
 * Derive the perceptual SoundCharacter from raw V2 features.
 *
 * V2.0 deterministic baseline formulas (see table in report §4). Every input is
 * independently null-aware: a dimension whose source fields are all `null`
 * becomes `null` rather than 0.
 *
 *   brightness <- centroidHz (log) / rolloffHz
 *   density    <- spectralFlux / zeroCrossingRate / transientStrength
 *   transient  <- 1 - attack (fast onset = transient) / transientStrength / crest
 *   duration   <- log-mapped durationSec
 *   tonality   <- harmonicity (primary) / pitchConfidence (corroborating)
 *   noisiness  <- spectralFlatness / (1 - harmonicity) / zeroCrossingRate
 *   dynamics   <- crestFactor / decayTimeSec
 *   complexity <- spectralFlux / zeroCrossingRate / spectralSpreadHz
 *
 * STEP88 — `tonality` is weighted on `harmonicity` (0.8) over
 * `pitchConfidence` (0.2). `harmonicity` is the best-lag normalized
 * autocorrelation peak, accumulated for every frame in which a lag was found
 * (`v2Dsp.ts`), so it is ungated and spans its full [0, 1] range. The derived
 * YIN/CMNDF `pitchConfidence` is acceptance-gated — it exists only for frames
 * whose CMNDF dip passed `pitchCmndfThreshold` — so its usable range is the
 * truncated (0.7, 1]. It still measures real voicing and is kept, but only as a
 * secondary cue. `spectralFlatness` is deliberately NOT part of `tonality`:
 * its normalization range is still the uncalibrated `{lo: 0, hi: 1}` of
 * `noisiness`, which no real-audio value approaches, so an inverted term would
 * be a near-constant ~1.0 rather than a discriminator. Recalibrating it is out
 * of scope here so that this change stays isolated on the tonality input.
 */
export function computeSoundCharacter(f: AudioFeaturesV2): SoundCharacter {
  const brightness = weightedMean(
    [norm(f.spectralCentroidHz, RANGES.centroidHz), norm(f.spectralRolloffHz, RANGES.rolloffHz)],
    [0.6, 0.4],
  );
  const density = weightedMean(
    [
      norm(f.spectralFlux, RANGES.flux),
      norm(f.zeroCrossingRate, RANGES.zcr),
      norm(f.transientStrength, RANGES.transientStrength),
    ],
    [0.4, 0.3, 0.3],
  );
  const attackInv = f.attackTimeSec === null ? null : 1 - clamp01(norm(f.attackTimeSec, RANGES.attackSec)!);
  const transient = weightedMean(
    [
      attackInv,
      norm(f.transientStrength, RANGES.transientStrength),
      norm(f.crestFactor, RANGES.crest),
    ],
    [0.5, 0.3, 0.2],
  );
  const duration = f.durationSec === null ? null : logNormalize(f.durationSec, RANGES.durationSec.lo, RANGES.durationSec.hi);
  // Tonality = degree of acoustic periodicity, measured on the UNGATED
  // normalized-autocorrelation peak (`harmonicity`). `pitchConfidence` only
  // corroborates it at a low weight: it is `1 - bestCm` and is recorded solely
  // for frames that already passed `bestCm < pitchCmndfThreshold` (0.3), so any
  // value it HAS is > 0.7 by construction. Weighting it at 0.6 therefore planted
  // an artificial tonality floor of 0.42 on every record that had a detected
  // pitch, which compressed the "Noisy <-> Tonal" axis into its right half.
  const tonality = weightedMean([f.harmonicity, f.pitchConfidence], [0.8, 0.2]);
  const flat = norm(f.spectralFlatness, RANGES.flatness);
  const noiseInv = f.harmonicity === null ? null : 1 - f.harmonicity;
  const noisiness = weightedMean(
    [flat, noiseInv, norm(f.zeroCrossingRate, RANGES.zcr)],
    [0.1, 0.6, 0.3],
  );
  const dynamics = weightedMean(
    [norm(f.crestFactor, RANGES.crest), norm(f.decayTimeSec, RANGES.decaySec)],
    [0.6, 0.4],
  );
  const complexity = weightedMean(
    [
      norm(f.spectralFlux, RANGES.flux),
      norm(f.zeroCrossingRate, RANGES.zcr),
      norm(f.spectralSpreadHz, RANGES.spreadHz),
    ],
    [0.5, 0.3, 0.2],
  );

  return { brightness, density, transient, duration, tonality, noisiness, dynamics, complexity };
}

/**
 * Quality of a derived character:
 *   - `overall`: the V2-weight-weighted mean of the PRESENT dimension values
 *     (a deterministic overall perceptual strength). A character whose dims are
 *     fully determinable computes over every dimension; a fully-indeterminate
 *     one scores `overall === 0`.
 *   - `featureCoverage`: fraction of the 8 dimensions that are determinable.
 */
export function computeSoundCharacterQuality(char: SoundCharacter): SoundCharacterQuality {
  const dims = SOUND_CHARACTER_DIMENSIONS.map((d) => char[d]);
  const present = dims.filter((v) => v !== null).length;
  const overall = weightedMean(dims, V2_SIMILARITY_WEIGHTS) ?? 0;
  return { overall, featureCoverage: present / SOUND_CHARACTER_DIMENSIONS.length };
}

/** The bound + dimensionality check: present dims live in [0, 1], absent ones are null. */
export function validateSoundCharacter(value: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { valid: false, errors: ["SoundCharacter: not an object"] };
  }
  const c = value as Record<string, unknown>;
  for (const dim of SOUND_CHARACTER_DIMENSIONS) {
    const v = c[dim];
    if (v === undefined) errors.push(`soundCharacter.${dim}: missing`);
    else if (v === null) {
      // allowed
    } else if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      errors.push(`soundCharacter.${dim}: must be a finite number in [0,1] or null`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/** An 8-vector in canonical dimension order; `null` dims = not determinable. */
export type SoundCharacterVector = ReadonlyArray<number | null>;

/**
 * Canonical SoundCharacter -> 8-vector mapping in the STABLE dimension order
 * (`brightness, density, transient, duration, tonality, noisiness, dynamics,
 * complexity`). `null` dims stay `null` — the similarity engine renormalizes.
 */
export function toSimilarityVector(char: SoundCharacter): SoundCharacterVector {
  return SOUND_CHARACTER_DIMENSIONS.map((d) => {
    const v = char[d];
    return v === null || v === undefined ? null : v;
  });
}