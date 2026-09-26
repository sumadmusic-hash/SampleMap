import { describe, it, expect } from "vitest";
import type { SoundCharacter } from "./soundCharacter";
import { emptySoundCharacter } from "./soundCharacter";
import {
  createSimilarityEngine,
  weightedEuclideanSimilarity,
  V2_SIMILARITY_CONFIG,
  SIMILARITY_ALGORITHM_VERSION,
} from "./similarityEngine";
import { V2_SIMILARITY_WEIGHTS, SOUND_CHARACTER_DIMENSIONS } from "./config";
import {
  SILENCE,
  PURE_TONE,
  WHITE_NOISE,
  IMPULSE,
  SHORT_PERCUSSION,
} from "./fixtures";
import { computeSoundCharacter } from "./soundCharacter";

function char(values: Partial<SoundCharacter>): SoundCharacter {
  return { ...emptySoundCharacter(), ...values };
}

describe("V2 similarity config", () => {
  it("has 8 weights in canonical order that sum to 1", () => {
    expect(V2_SIMILARITY_WEIGHTS).toHaveLength(SOUND_CHARACTER_DIMENSIONS.length);
    const sum = V2_SIMILARITY_WEIGHTS.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThanOrEqual(1e-9);
  });
  it("pins the canonical engine + algorithm versions to 2.0.0", () => {
    expect(V2_SIMILARITY_CONFIG.algorithmVersion).toBe(SIMILARITY_ALGORITHM_VERSION);
    expect(SIMILARITY_ALGORITHM_VERSION).toBe("2.0.0");
  });
});

describe("SimilarityEngine", () => {
  const engine = createSimilarityEngine();
  const chars = {
    SILENCE: computeSoundCharacter(SILENCE),
    PURE_TONE: computeSoundCharacter(PURE_TONE),
    WHITE_NOISE: computeSoundCharacter(WHITE_NOISE),
    IMPULSE: computeSoundCharacter(IMPULSE),
    SHORT_PERCUSSION: computeSoundCharacter(SHORT_PERCUSSION),
  };

  it("self-similarity is exactly 1 for every fixture", () => {
    for (const name in chars) {
      expect(engine.similarity(chars[name as keyof typeof chars], chars[name as keyof typeof chars])).toBe(1);
    }
  });

  it("is symmetric", () => {
    const pairs: Array<[keyof typeof chars, keyof typeof chars]> = [
      ["PURE_TONE", "WHITE_NOISE"],
      ["IMPULSE", "SHORT_PERCUSSION"],
      ["SILENCE", "PURE_TONE"],
    ];
    for (const [a, b] of pairs) {
      expect(engine.similarity(chars[a], chars[b])).toBe(engine.similarity(chars[b], chars[a]));
    }
  });

  it("stays in [0,1] for every fixture pair (REAL cross-fixture scores)", () => {
    const names = Object.keys(chars) as Array<keyof typeof chars>;
    for (const a of names) {
      for (const b of names) {
        const s = engine.similarity(chars[a], chars[b]);
        expect(s).not.toBeNull();
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is deterministic", () => {
    expect(engine.similarity(chars.PURE_TONE, chars.WHITE_NOISE)).toBe(
      engine.similarity(chars.PURE_TONE, chars.WHITE_NOISE),
    );
  });

  it("returns null (safe-state) when no dimension is shared", () => {
    const onlyA = char({ brightness: 1 });
    const onlyB = char({ tonality: 1 });
    expect(engine.similarity(onlyA, onlyB)).toBeNull();
    expect(engine.similarity(char({}), char({}))).toBeNull();
  });

  it("renormalizes shared-dimension weights (missing dims are not 0)", () => {
    // Only brightness is shared; max difference -> distance 1 -> similarity 0.
    expect(engine.similarity(char({ brightness: 1 }), char({ brightness: 0 }))).toBe(0);
    expect(engine.similarity(char({ brightness: 0.5 }), char({ brightness: 0.5 }))).toBe(1);
    // A small diff on the single shared dim.
    const near = engine.similarity(char({ brightness: 0.5 }), char({ brightness: 0.51 }));
    expect(near).toBeGreaterThan(0.9);
  });

  it("a one-dim change is closer than an all-dims change", () => {
    const base = char({
      brightness: 0.5,
      density: 0.5,
      transient: 0.5,
      duration: 0.5,
      tonality: 0.5,
      noisiness: 0.5,
      dynamics: 0.5,
      complexity: 0.5,
    });
    const near = char({ ...base, complexity: 0.55 } as SoundCharacter);
    const far = char({ ...base, complexity: 0, brightness: 0, density: 0, transient: 1 } as SoundCharacter);
    const sNear = engine.similarity(base, near) as number;
    const sFar = engine.similarity(base, far) as number;
    expect(sNear).toBeGreaterThan(sFar);
  });

  it("rejects an ill-formed weights config at construction", () => {
    expect(() => createSimilarityEngine({ weights: [1] })).toThrow(RangeError);
    expect(() => createSimilarityEngine({ weights: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] })).toThrow(
      RangeError,
    );
  });
});

describe("weightedEuclideanSimilarity (pure primitive)", () => {
  const w = V2_SIMILARITY_WEIGHTS;
  it("computes 1 - weighted distance for full vectors", () => {
    const a = [0, 0, 0, 0, 0, 0, 0, 0];
    const b = [1, 1, 1, 1, 1, 1, 1, 1];
    expect(weightedEuclideanSimilarity(a, b, w)).toBe(0);
    expect(weightedEuclideanSimilarity(a, a, w)).toBe(1);
  });
  it("is invariant to a shared-dim reweighting (missing dims ignored)", () => {
    const a: Array<number | null> = [0.2, null, null, null, null, null, null, null];
    const b: Array<number | null> = [0.8, null, null, null, null, null, null, null];
    expect(weightedEuclideanSimilarity(a, b, w)).toBe(1 - Math.abs(0.2 - 0.8));
  });
  it("returns null for zero shared dims", () => {
    expect(weightedEuclideanSimilarity([null, null, null, null, null, null, null, null], [1, 1, 1, 1, 1, 1, 1, 1], w)).toBeNull();
  });
  it("throws on length mismatch", () => {
    expect(() => weightedEuclideanSimilarity([1], [1, 1], w)).toThrow(RangeError);
  });
});