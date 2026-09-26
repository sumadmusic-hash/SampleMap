import { describe, it, expect } from "vitest";
import type { AudioFeatures } from "../persistence/indexStore";
import {
  validateAudioFeaturesV2,
  fromV1AudioFeatures,
} from "./audioFeaturesV2";
import { PURE_TONE, WHITE_NOISE, SILENCE } from "./fixtures";

describe("validateAudioFeaturesV2", () => {
  it("accepts every deterministic fixture", () => {
    expect(validateAudioFeaturesV2(PURE_TONE).valid).toBe(true);
    expect(validateAudioFeaturesV2(WHITE_NOISE).valid).toBe(true);
    expect(validateAudioFeaturesV2(SILENCE).valid).toBe(true);
  });

  it("rejects non-object input", () => {
    expect(validateAudioFeaturesV2(null).valid).toBe(false);
    expect(validateAudioFeaturesV2(42).valid).toBe(false);
    expect(validateAudioFeaturesV2(undefined).valid).toBe(false);
  });

  it("rejects NaN and Infinity on present fields", () => {
    expect(validateAudioFeaturesV2({ ...PURE_TONE, rms: NaN }).valid).toBe(false);
    expect(validateAudioFeaturesV2({ ...PURE_TONE, rms: Infinity }).valid).toBe(false);
    expect(validateAudioFeaturesV2({ ...PURE_TONE, spectralFlux: NaN }).valid).toBe(false);
    expect(validateAudioFeaturesV2({ ...PURE_TONE, spectralFlux: Infinity }).valid).toBe(false);
  });

  it("rejects null on required (non-nullable) fields", () => {
    const bad = { ...PURE_TONE, rms: null };
    const result = validateAudioFeaturesV2(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.join(";")).toContain("rms");
  });

  it("accepts null on nullable fields without rewriting it", () => {
    const result = validateAudioFeaturesV2({ ...PURE_TONE, spectralCentroidHz: null });
    expect(result.valid).toBe(true);
  });

  it("rejects out-of-range normalized fields", () => {
    expect(validateAudioFeaturesV2({ ...PURE_TONE, harmonicity: 1.5 }).valid).toBe(false);
    expect(validateAudioFeaturesV2({ ...PURE_TONE, harmonicity: -0.1 }).valid).toBe(false);
    expect(validateAudioFeaturesV2({ ...PURE_TONE, crestFactor: 0.5 }).valid).toBe(false);
    expect(validateAudioFeaturesV2({ ...PURE_TONE, sampleRate: 0 }).valid).toBe(false);
    expect(validateAudioFeaturesV2({ ...PURE_TONE, channels: 0 }).valid).toBe(false);
  });

  it("reports missing required fields", () => {
    const { rms: _omit, ...rest } = PURE_TONE;
    const result = validateAudioFeaturesV2(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.join(";")).toContain("rms");
  });
});

describe("fromV1AudioFeatures (V1 -> V2 adaptor)", () => {
  function v1(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
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

  it("maps equivalent V1 fields to their V2 names (compatibility, not rename)", () => {
    const adapted = fromV1AudioFeatures(v1());
    expect(adapted.durationSec).toBe(0.4);
    expect(adapted.sampleRate).toBe(44100);
    expect(adapted.channels).toBe(2);
    expect(adapted.rms).toBe(0.2);
    expect(adapted.peak).toBe(0.9);
    expect(adapted.zeroCrossingRate).toBe(0.02);
    expect(adapted.spectralCentroidHz).toBe(1200);
    expect(adapted.spectralSpreadHz).toBe(300);
    expect(adapted.spectralRolloffHz).toBe(5000);
    expect(adapted.spectralFlatness).toBe(0.2);
    expect(adapted.attackTimeSec).toBe(0.001);
  });

  it("derives crestFactor from the equivalent V1 peak/rms pair", () => {
    expect(fromV1AudioFeatures(v1()).crestFactor).toBeCloseTo(0.9 / 0.2, 12);
  });

  it("leaves crestFactor null when V1 RMS <= 0 (not determinable, never 0)", () => {
    expect(fromV1AudioFeatures(v1({ rms: 0 })).crestFactor).toBeNull();
    expect(fromV1AudioFeatures(v1({ peak: 0 })).crestFactor).toBeNull();
  });

  it("carries V1-only quantities as null instead of fabricating them", () => {
    const adapted = fromV1AudioFeatures(v1());
    expect(adapted.transientStrength).toBeNull();
    expect(adapted.decayTimeSec).toBeNull();
    expect(adapted.spectralFlux).toBeNull();
    expect(adapted.spectralSlope).toBeNull();
    expect(adapted.pitchHz).toBeNull();
    expect(adapted.pitchConfidence).toBeNull();
    expect(adapted.harmonicity).toBeNull();
  });

  it("does not mutate the V1 record and produces a valid V2 record", () => {
    const src = v1();
    const copy = { ...src };
    const adapted = fromV1AudioFeatures(src);
    expect(src).toEqual(copy);
    expect(validateAudioFeaturesV2(adapted).valid).toBe(true);
  });
});