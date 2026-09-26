/**
 * V2 (STEP 20) raw DSP feature contract — `AudioFeaturesV2`.
 *
 * Layer separation (STEP 20 architecture rule): RAW DSP FEATURES are kept
 * strictly separate from the PERCEPTUAL SOUND CHARACTER, the SIMILARITY SPACE
 * and the MAP PROJECTION. This module defines the raw feature record only.
 *
 * Null semantics (hard contract):
 *   - A field typed `number | null` is `null` when the value is NOT
 *     determinable for that signal (e.g. pitch of unvoiced content).
 *   - `null` is NEVER substituted with `0` (and never with NaN/Infinity).
 *   - Physical magnitudes are `>= 0`; dimensionless ratios live in [0, 1];
 *     `spectralSlope` is a signed coefficient (not a magnitude).
 *   - NaN and Infinity are invalid values and rejected by validation.
 */
import type { AudioFeatures } from "../persistence/indexStore";

/** Physical magnitudes (>= 0) vs normalized ratios ([0, 1]) are documented per field. */
export interface AudioFeaturesV2 {
  /** Total duration in seconds (>= 0). */
  durationSec: number;
  /** Sample rate in Hz (> 0). */
  sampleRate: number;
  /** Channel count (>= 1). */
  channels: number;
  /** Root-mean-square amplitude (>= 0). */
  rms: number;
  /** Peak amplitude (>= 0). */
  peak: number;
  /** Peak-to-RMS crest factor (>= 1); null when RMS <= 0 (not determinable). */
  crestFactor: number | null;
  /** Relative transient strength (>= 0); null when no transients are detectable. */
  transientStrength: number | null;
  /** Zero-crossing rate (0..1 theoretical max 0.5, >= 0). */
  zeroCrossingRate: number;
  /** Spectral centroid in Hz (>= 0); null when no spectral content is present. */
  spectralCentroidHz: number | null;
  /** Spectral spread (bandwidth) in Hz (>= 0); null when not determinable. */
  spectralSpreadHz: number | null;
  /** Spectral rolloff frequency in Hz (>= 0); null when not determinable. */
  spectralRolloffHz: number | null;
  /** Spectral flatness (0..1, 1 = noise-flat); null when not determinable. */
  spectralFlatness: number | null;
  /** Spectral flux (frame-to-frame spectral change, >= 0); null when not determinable. */
  spectralFlux: number | null;
  /** Spectral slope (signed spectral-tilt coefficient, dimensionless). */
  spectralSlope: number | null;
  /** Attack time in seconds (>= 0); null when no onset is present. */
  attackTimeSec: number | null;
  /** Decay time in seconds (>= 0); null when no envelope decay is present. */
  decayTimeSec: number | null;
  /** Fundamental pitch in Hz (>= 0); null when the content is unvoiced. */
  pitchHz: number | null;
  /** Pitch-estimation confidence (0..1); null when no pitch was estimated. */
  pitchConfidence: number | null;
  /** Harmonic vs inharmonic content share (0..1); null when not determinable. */
  harmonicity: number | null;
  /**
   * Inharmonicity (0..1): RMS fractional deviation of the significant spectral
   * partials from the nearest integer multiple of the estimated pitch. `null`
   * when no harmonic structure is provable (no pitch, or fewer than two
   * partials measurable) — never fabricated for noise.
   */
  inharmonicity: number | null;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNullableFinite(v: unknown): boolean {
  return v === null || isFiniteNumber(v);
}

/**
 * Structural + numeric validation of an `AudioFeaturesV2` record.
 * NaN/Infinity are NEVER accepted on any present field; `null` is accepted only
 * on nullable fields and is never rewritten; non-finite present values are
 * always rejected. Non-V2-shaped input is invalid.
 */
export function validateAudioFeaturesV2(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { valid: false, errors: ["AudioFeaturesV2: not an object"] };
  }
  const f = value as Record<string, unknown>;

  const required = (
    key: keyof AudioFeaturesV2 | string,
    pred: (v: number) => boolean,
    what: string,
  ) => {
    const v = f[key];
    if (v === undefined) errors.push(`audioFeaturesV2.${key}: missing`);
    else if (!isFiniteNumber(v) || !pred(v)) errors.push(`audioFeaturesV2.${key}: ${what}`);
  };
  const nullable = (
    key: keyof AudioFeaturesV2 | string,
    what: string,
    extra?: (v: number) => boolean,
  ) => {
    const v = f[key];
    if (v === undefined) errors.push(`audioFeaturesV2.${key}: missing`);
    else if (!isNullableFinite(v)) errors.push(`audioFeaturesV2.${key}: must be ${what} or null`);
    else if (isFiniteNumber(v) && extra && !extra(v))
      errors.push(`audioFeaturesV2.${key}: ${what}`);
  };

  required("durationSec", (v) => v >= 0, "finite number >= 0");
  required("sampleRate", (v) => v > 0, "finite number > 0");
  required("channels", (v) => v >= 1, "finite number >= 1");
  required("rms", (v) => v >= 0, "finite number >= 0");
  required("peak", (v) => v >= 0, "finite number >= 0");
  required("zeroCrossingRate", (v) => v >= 0, "finite number >= 0");

  nullable("crestFactor", "finite number >= 1", (v) => v >= 1);
  nullable("transientStrength", "finite number >= 0", (v) => v >= 0);
  nullable("spectralCentroidHz", "finite number >= 0", (v) => v >= 0);
  nullable("spectralSpreadHz", "finite number >= 0", (v) => v >= 0);
  nullable("spectralRolloffHz", "finite number >= 0", (v) => v >= 0);
  nullable("spectralFlatness", "finite number in [0,1]", (v) => v >= 0 && v <= 1);
  nullable("spectralFlux", "finite number >= 0", (v) => v >= 0);
  nullable("spectralSlope", "finite number");
  nullable("attackTimeSec", "finite number >= 0", (v) => v >= 0);
  nullable("decayTimeSec", "finite number >= 0", (v) => v >= 0);
  nullable("pitchHz", "finite number >= 0", (v) => v >= 0);
  nullable("pitchConfidence", "finite number in [0,1]", (v) => v >= 0 && v <= 1);
  nullable("harmonicity", "finite number in [0,1]", (v) => v >= 0 && v <= 1);
  nullable("inharmonicity", "finite number in [0,1]", (v) => v >= 0 && v <= 1);

  return { valid: errors.length === 0, errors };
}

/**
 * Best-effort V1 -> V2 adaptor (STEP 20 §5 compatibility rule).
 *
 * Equivalent V1 fields are carried across under their V2 names; genuinely
 * different quantities (e.g. V1 `transientDensity` vs V2 `transientStrength`,
 * V1 `tonalNoiseRatio` vs V2 `harmonicity`) become `null` ("not determinable")
 * instead of being fabricated. `crestFactor` is derived from the equivalent
 * V1 peak/rms pair when RMS > 0. V1 records are never mutated.
 */
export function fromV1AudioFeatures(f: AudioFeatures): AudioFeaturesV2 {
  return {
    durationSec: f.duration,
    sampleRate: f.sampleRate,
    channels: f.channels,
    rms: f.rms,
    peak: f.peak,
    crestFactor: f.rms > 0 && f.peak > 0 && f.peak / f.rms >= 1 ? f.peak / f.rms : null,
    transientStrength: null,
    zeroCrossingRate: f.zeroCrossingRate,
    spectralCentroidHz: f.spectralCentroid,
    spectralSpreadHz: f.spectralBandwidth,
    spectralRolloffHz: f.spectralRolloff,
    spectralFlatness: f.spectralFlatness,
    spectralFlux: null,
    spectralSlope: null,
    attackTimeSec: f.attack,
    decayTimeSec: null,
    pitchHz: null,
    pitchConfidence: null,
    harmonicity: null,
    inharmonicity: null,
  };
}