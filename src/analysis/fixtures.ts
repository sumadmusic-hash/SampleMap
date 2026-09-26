/**
 * V2 (STEP 20) DETERMINISTIC FIXTURES.
 *
 * Five handcrafted `AudioFeaturesV2` records whose invariant properties are
 * asserted in `fixtures.test.ts` and used across the V2 unit tests. They are
 * FIXTURE-class evidence (they are not produced by a DSP extractor, which is
 * STEP21+ scope) — invariant-based, relative assertions are preferred over
 * hardcoded expectations.
 *
 * Invariant design (documented, asserted):
 *   - SILENCE          : lowest RMS/peak; spectral + pitch + envelope fields
 *                        null (nothing determinable); noise-floor flatness.
 *   - PURE_TONE        : highest tonality, lowest noisiness; steady envelope
 *                        (low dynamics/transient/density/complexity).
 *   - WHITE_NOISE      : highest noisiness, lowest tonality; broad spectrum.
 *   - IMPULSE          : shortest duration, strongest transient/dynamics.
 *   - SHORT_PERCUSSION : short, strong transient, moderate density.
 */
import type { AudioFeaturesV2 } from "./audioFeaturesV2";

/** Near-silent signal: energy floor only, most analysis null. */
export const SILENCE: AudioFeaturesV2 = {
  durationSec: 2.0,
  sampleRate: 44100,
  channels: 1,
  rms: 0.0001,
  peak: 0.002,
  crestFactor: null,
  transientStrength: null,
  zeroCrossingRate: 0.0005,
  spectralCentroidHz: null,
  spectralSpreadHz: null,
  spectralRolloffHz: null,
  spectralFlatness: 1.0,
  spectralFlux: null,
  spectralSlope: null,
  attackTimeSec: null,
  decayTimeSec: null,
  pitchHz: null,
  pitchConfidence: null,
  harmonicity: null,
  inharmonicity: null,
};

/** 440 Hz steady sine: crisp, tonal, quiet-spectral. */
export const PURE_TONE: AudioFeaturesV2 = {
  durationSec: 1.5,
  sampleRate: 44100,
  channels: 1,
  rms: 0.35,
  peak: 0.5,
  crestFactor: 0.5 / 0.35,
  transientStrength: 0.2,
  zeroCrossingRate: 0.02,
  spectralCentroidHz: 440,
  spectralSpreadHz: 60,
  spectralRolloffHz: 660,
  spectralFlatness: 0.01,
  spectralFlux: 0.002,
  spectralSlope: -0.5,
  attackTimeSec: 0.01,
  decayTimeSec: 0.05,
  pitchHz: 440,
  pitchConfidence: 0.99,
  harmonicity: 0.95,
  inharmonicity: null,
};

/** Full-spectrum noise burst: brightest/noisiest. */
export const WHITE_NOISE: AudioFeaturesV2 = {
  durationSec: 1.0,
  sampleRate: 44100,
  channels: 1,
  rms: 0.3,
  peak: 1.0,
  crestFactor: 1.0 / 0.3,
  transientStrength: 1.5,
  zeroCrossingRate: 0.5,
  spectralCentroidHz: 11025,
  spectralSpreadHz: 12000,
  spectralRolloffHz: 22000,
  spectralFlatness: 0.99,
  spectralFlux: 0.9,
  spectralSlope: 0.0,
  attackTimeSec: 0.005,
  decayTimeSec: 0.005,
  pitchHz: null,
  pitchConfidence: null,
  harmonicity: 0.05,
  inharmonicity: null,
};

/** Sub-100ms click: maximal transient/dynamics, minimal duration. */
export const IMPULSE: AudioFeaturesV2 = {
  durationSec: 0.05,
  sampleRate: 44100,
  channels: 1,
  rms: 0.05,
  peak: 1.0,
  crestFactor: 1.0 / 0.05,
  transientStrength: 20,
  zeroCrossingRate: 0.45,
  spectralCentroidHz: 5000,
  spectralSpreadHz: 15000,
  spectralRolloffHz: 20000,
  spectralFlatness: 0.6,
  spectralFlux: 2.0,
  spectralSlope: 1.0,
  attackTimeSec: 0.0005,
  decayTimeSec: 0.002,
  pitchHz: null,
  pitchConfidence: null,
  harmonicity: 0.1,
  inharmonicity: null,
};

/** Short percussive hit (e.g. kick): short, strong transient, moderate density. */
export const SHORT_PERCUSSION: AudioFeaturesV2 = {
  durationSec: 0.2,
  sampleRate: 44100,
  channels: 1,
  rms: 0.35,
  peak: 1.0,
  crestFactor: 1.0 / 0.35,
  transientStrength: 8,
  zeroCrossingRate: 0.12,
  spectralCentroidHz: 900,
  spectralSpreadHz: 2500,
  spectralRolloffHz: 4000,
  spectralFlatness: 0.25,
  spectralFlux: 1.4,
  spectralSlope: 0.6,
  attackTimeSec: 0.002,
  decayTimeSec: 0.08,
  pitchHz: 95,
  pitchConfidence: 0.4,
  harmonicity: 0.5,
  inharmonicity: null,
};

/** The five fixtures keyed by canonical name (stable order). */
export const V2_FIXTURES = {
  SILENCE,
  PURE_TONE,
  WHITE_NOISE,
  IMPULSE,
  SHORT_PERCUSSION,
} as const;

export type V2FixtureName = keyof typeof V2_FIXTURES;

/** All fixture names in the canonical invariant-test order. */
export const V2_FIXTURE_NAMES: readonly V2FixtureName[] = [
  "SILENCE",
  "PURE_TONE",
  "WHITE_NOISE",
  "IMPULSE",
  "SHORT_PERCUSSION",
] as const;