import { describe, it, expect } from "vitest";
import {
  createBaselineMapProjector,
  MAP_ALGORITHM_VERSION,
  NEUTRAL_POSITION,
} from "./mapProjector";
import type { SoundCharacter } from "./soundCharacter";
import { emptySoundCharacter } from "./soundCharacter";
import { computeSoundCharacter } from "./soundCharacter";
import {
  SILENCE,
  PURE_TONE,
  WHITE_NOISE,
  IMPULSE,
  SHORT_PERCUSSION,
} from "./fixtures";

function char(values: Partial<SoundCharacter>): SoundCharacter {
  return { ...emptySoundCharacter(), ...values };
}

describe("MapProjector boundary", () => {
  const projector = createBaselineMapProjector();
  const chars = {
    SILENCE: computeSoundCharacter(SILENCE),
    PURE_TONE: computeSoundCharacter(PURE_TONE),
    WHITE_NOISE: computeSoundCharacter(WHITE_NOISE),
    IMPULSE: computeSoundCharacter(IMPULSE),
    SHORT_PERCUSSION: computeSoundCharacter(SHORT_PERCUSSION),
  };

  it("pins the V2.0 algorithm version", () => {
    expect(projector.version).toBe(MAP_ALGORITHM_VERSION);
    expect(MAP_ALGORITHM_VERSION).toBe("2.0.0");
  });

  it("projects every fixture into the [0,1]^2 unit square", () => {
    for (const name in chars) {
      const p = projector.project(chars[name as keyof typeof chars]);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic: identical input -> identical output (no corpus dependence)", () => {
    for (const name in chars) {
      const a = projector.project(chars[name as keyof typeof chars]);
      const b = projector.project(chars[name as keyof typeof chars]);
      expect(a).toEqual(b);
    }
  });

  it("returns the neutral center when no dimension is determinable", () => {
    expect(projector.project(emptySoundCharacter())).toEqual(NEUTRAL_POSITION);
  });

  it("is bounded and monotone for one-dim control inputs", () => {
    const allMax = char({ brightness: 1 });
    const allMin = char({ brightness: 0 });
    const hi = projector.project(allMax);
    const lo = projector.project(allMin);
    expect(hi.x).toBe(1);
    expect(hi.y).toBe(1);
    expect(lo.x).toBe(0);
    expect(lo.y).toBe(0);
  });

  it("does not require a corpus or any shared state between calls", () => {
    const p1 = createBaselineMapProjector().project(chars.PURE_TONE);
    const p2 = createBaselineMapProjector().project(chars.PURE_TONE);
    expect(p1).toEqual(p2);
  });
});