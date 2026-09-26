import type { AudioFeatures } from "../persistence/indexStore";

/** Feature fixture builder with sensible defaults, override per scenario. */
export function makeFeatures(
  overrides: Partial<AudioFeatures> = {},
): AudioFeatures {
  return {
    duration: 0.4,
    sampleRate: 44100,
    channels: 2,
    rms: 0.2,
    peak: 0.9,
    transientDensity: 12,
    spectralCentroid: 1200,
    spectralBandwidth: 300,
    spectralRolloff: 5000,
    zeroCrossingRate: 0.02,
    spectralFlatness: 0.2,
    attack: 0.001,
    tonalNoiseRatio: 0.8,
    ...overrides,
  };
}

/** A strong kick-ish profile: short, transient, dark, tonal thump. */
export function kickFeatures(): AudioFeatures {
  return makeFeatures({
    duration: 0.3,
    transientDensity: 18,
    spectralCentroid: 180,
    spectralFlatness: 0.1,
    attack: 0.001,
  });
}

/** A strong hi-hat profile: short, transient, bright, noisy. */
export function hatFeatures(): AudioFeatures {
  return makeFeatures({
    duration: 0.2,
    transientDensity: 15,
    spectralCentroid: 9000,
    spectralFlatness: 0.7,
    attack: 0.001,
  });
}

/** A sustained tonal low profile (bass/pad): long, dark-ish, low flatness. */
export function bassFeatures(): AudioFeatures {
  return makeFeatures({
    duration: 2.0,
    transientDensity: 1,
    spectralCentroid: 150,
    spectralFlatness: 0.06,
    attack: 0.1,
  });
}

/** Broadband sustained noise: high flatness, high bandwidth. */
export function noiseFeatures(): AudioFeatures {
  return makeFeatures({
    duration: 2.0,
    transientDensity: 0.5,
    spectralCentroid: 4000,
    spectralBandwidth: 8000,
    spectralFlatness: 0.9,
    attack: 0.1,
  });
}
