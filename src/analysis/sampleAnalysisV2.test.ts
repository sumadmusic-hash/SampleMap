import { describe, it, expect } from "vitest";
import {
  ANALYSIS_VERSION,
  validateSampleAnalysisV2,
  serializeSampleAnalysisV2,
  parseSampleAnalysisV2,
  type SampleAnalysisV2,
} from "./sampleAnalysisV2";
import { computeSoundCharacter, computeSoundCharacterQuality } from "./soundCharacter";
import { PURE_TONE, WHITE_NOISE, SILENCE } from "./fixtures";
import type { AudioFeaturesV2 } from "./audioFeaturesV2";

function buildAnalysis(features: AudioFeaturesV2): SampleAnalysisV2 {
  const soundCharacter = computeSoundCharacter(features);
  return {
    analysisVersion: ANALYSIS_VERSION,
    features,
    soundCharacter,
    quality: computeSoundCharacterQuality(soundCharacter),
  };
}

describe("SampleAnalysisV2 aggregate", () => {
  it("is valid for every fixture (REAL derivation, not hardcoded)", () => {
    for (const features of [PURE_TONE, WHITE_NOISE, SILENCE]) {
      const analysis = buildAnalysis(features);
      expect(validateSampleAnalysisV2(analysis).valid).toBe(true);
      expect(analysis.analysisVersion).toBe("2.0.0");
    }
  });

  it("rejects a non-V2 analysis version (independent version contract)", () => {
    const analysis = buildAnalysis(PURE_TONE);
    const result = validateSampleAnalysisV2({ ...analysis, analysisVersion: "1.0.0" });
    expect(result.valid).toBe(false);
    expect(result.errors.join(";")).toContain("analysisVersion");
  });

  it("rejects NaN quality and malformed sound character", () => {
    const analysis = buildAnalysis(PURE_TONE);
    expect(
      validateSampleAnalysisV2({
        ...analysis,
        quality: { ...analysis.quality, overall: NaN },
      }).valid,
    ).toBe(false);
    expect(
      validateSampleAnalysisV2({
        ...analysis,
        soundCharacter: { ...analysis.soundCharacter, brightness: 2 },
      }).valid,
    ).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateSampleAnalysisV2(null).valid).toBe(false);
    expect(validateSampleAnalysisV2("x").valid).toBe(false);
  });

  it("supports a lossless JSON round-trip (numbers, nulls, quality, version, character preserved)", () => {
    for (const features of [PURE_TONE, WHITE_NOISE, SILENCE]) {
      const analysis = buildAnalysis(features);
      const roundtrip = parseSampleAnalysisV2(serializeSampleAnalysisV2(analysis));
      expect(roundtrip).toEqual(analysis);
      expect(roundtrip).toBeDefined();
    }
  });

  it("serialization survives nested nulls exactly (null != 0)", () => {
    const analysis = buildAnalysis(SILENCE);
    const roundtrip = parseSampleAnalysisV2(serializeSampleAnalysisV2(analysis));
    expect(roundtrip!.features.spectralCentroidHz).toBeNull();
    expect(roundtrip!.features.pitchConfidence).toBeNull();
    expect(roundtrip!.soundCharacter.tonality).toBeNull();
    expect(roundtrip!.soundCharacter.brightness).toBeNull();
    expect(roundtrip!.quality.featureCoverage).toBe(0.5);
  });

  it("parse returns undefined for garbage or structurally invalid JSON", () => {
    expect(parseSampleAnalysisV2("not json")).toBeUndefined();
    expect(parseSampleAnalysisV2('{"analysisVersion":"9.0.0"}')).toBeUndefined();
  });
});

describe("quality semantics", () => {
  it("PURE_TONE is fully covered; SILENCE is half-covered (documented)", () => {
    const pure = buildAnalysis(PURE_TONE);
    const silence = buildAnalysis(SILENCE);
    expect(pure.quality.featureCoverage).toBe(1);
    expect(silence.quality.featureCoverage).toBe(0.5);
    expect(pure.quality.overall).toBeGreaterThan(0);
  });
});