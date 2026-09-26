import { describe, it, expect } from "vitest";
import { validateAudioFeaturesV2 } from "./audioFeaturesV2";
import { V2_FIXTURES, SILENCE, PURE_TONE, WHITE_NOISE, IMPULSE, SHORT_PERCUSSION } from "./fixtures";

describe("V2 deterministic fixtures (FIXTURE-class evidence)", () => {
  it("every fixture is a structurally valid AudioFeaturesV2 record", () => {
    for (const name of Object.keys(V2_FIXTURES) as Array<keyof typeof V2_FIXTURES>) {
      expect(validateAudioFeaturesV2(V2_FIXTURES[name]).valid).toBe(true);
    }
  });

  it("raw invariants: silence is the quietest and least determinable", () => {
    expect(SILENCE.rms).toBeLessThan(PURE_TONE.rms);
    expect(SILENCE.peak).toBeLessThan(PURE_TONE.peak);
    expect(SILENCE.transientStrength).toBeNull();
    expect(SILENCE.spectralCentroidHz).toBeNull();
    expect(SILENCE.pitchHz).toBeNull();
    expect(SILENCE.harmonicity).toBeNull();
  });

  it("raw invariants: pure tone is the most tonal / least noisy", () => {
    expect(PURE_TONE.pitchConfidence).toBeGreaterThan(SHORT_PERCUSSION.pitchConfidence as number);
    expect(PURE_TONE.harmonicity).toBeGreaterThan(SHORT_PERCUSSION.harmonicity as number);
    expect(PURE_TONE.spectralFlatness).toBeLessThan(WHITE_NOISE.spectralFlatness as number);
  });

  it("raw invariants: white noise is the noisiest and brightest", () => {
    expect(WHITE_NOISE.spectralFlatness).toBeGreaterThan(PURE_TONE.spectralFlatness as number);
    expect(WHITE_NOISE.spectralFlatness).toBeGreaterThan(SHORT_PERCUSSION.spectralFlatness as number);
    expect(WHITE_NOISE.pitchConfidence).toBeNull();
    expect(WHITE_NOISE.spectralCentroidHz as number).toBeGreaterThan(SHORT_PERCUSSION.spectralCentroidHz as number);
  });

  it("raw invariants: impulse is the shortest, strongest-transient, strongest-dynamics source", () => {
    expect(IMPULSE.durationSec).toBeLessThan(SHORT_PERCUSSION.durationSec);
    expect(IMPULSE.transientStrength as number).toBeGreaterThan(
      SHORT_PERCUSSION.transientStrength as number,
    );
    expect(IMPULSE.attackTimeSec as number).toBeLessThan(SHORT_PERCUSSION.attackTimeSec as number);
    expect(IMPULSE.crestFactor as number).toBeGreaterThan(SHORT_PERCUSSION.crestFactor as number);
  });

  it("raw invariants: short percussion is short with a strong transient and moderate density", () => {
    expect(SHORT_PERCUSSION.durationSec).toBeLessThan(PURE_TONE.durationSec);
    expect(SHORT_PERCUSSION.transientStrength as number).toBeGreaterThan(
      PURE_TONE.transientStrength as number,
    );
    expect(SHORT_PERCUSSION.spectralFlux as number).toBeGreaterThan(PURE_TONE.spectralFlux as number);
  });

  it("inharmonicity: null in every fixture (no provable harmonic-ladder structure)", () => {
    for (const name of Object.keys(V2_FIXTURES) as Array<keyof typeof V2_FIXTURES>) {
      expect(V2_FIXTURES[name].inharmonicity).toBeNull();
    }
  });
});