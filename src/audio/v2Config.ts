/**
 * V2 (STEP 21) DSP configuration — the single source of truth for all magic
 * numbers of the deterministic feature extractor.
 *
 * Determinism & sample-rate independence rules:
 *   - Frequencies/Hz and durations stay PHYSICAL (Hz, seconds) everywhere.
 *     `sampleRate` is always read from the input (never a hardcoded "44.1k");
 *     normalized ratios ([0,1] and dimension-free features) are therefore
 *     sample-rate independent. Perceptual frequency ranges live in the
 *     SoundCharacter layer, not here.
 *   - A frame is `fftSize * hopSize` on the waveform. The window is Hann.
 */

export const V2_DSP_CONFIG = {
  /** FFT window size in samples (radix-2). */
  fftSize: 2048,
  /** Frame hop (samples). Frames cover the whole signal. */
  hopSize: 512,
  /** Fraction of total spectral energy used for the rolloff frequency. */
  rolloffFraction: 0.85,
  /** Hop used for the RMS envelope used by transient/attack/decay analysis. */
  envelopeHop: 512,
  /**
   * Reference scale for `transientStrength` (dimensionless). 20 maps a single
   * full-scale impulse onset onto the top of the SoundCharacter scale hi.
   */
  transientScale: 20,
  /** Envelope fraction considered "reached the peak" for the attack time. */
  attackFraction: 0.9,
  /** Envelope fraction (1/e) below which the decay is considered finished. */
  decayFraction: 0.37,
  /** YIN minimum pitch (Hz). Below this the period is "not a pitch". */
  pitchMinHz: 40,
  /** YIN maximum pitch (Hz). Above this the period is too short to trust. */
  pitchMaxHz: 4000,
  /**
   * YIN/CMNDF acceptance threshold: the *first* normalized-difference dip below
   * this value ([0,1], lower = more periodic) places a frame's pitch; frames
   * whose best dip is not below it are treated as unvoiced.
   */
  pitchCmnfThreshold: 0.3,
  /** Upper bound of pitch-analysis frames (performance cap, evenly sampled). */
  pitchMaxFrames: 96,
  /**
   * Minimum relative magnitude (fraction of the spectrum max) for a spectral
   * peak to qualify as a "partial" for the inharmonicity grid check.
   */
  partialMinRelativeMagnitude: 0.1,
  /** Magnitude floor used by log-domain and ratio operations (never a NaN). */
  spectralEpsilon: 1e-12,
  /** Absolute energy floor for gating a frame as "has content". */
  energyFloor: 1e-9,
} as const;

/** Hann window coefficients of length `n` (deterministic, double precision). */
export function makeHannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1 || 1)));
  }
  return w;
}

/** Smallest power of two >= `v`. */
export function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}