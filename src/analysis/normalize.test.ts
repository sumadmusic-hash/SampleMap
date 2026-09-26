import { describe, it, expect } from "vitest";
import {
  clamp01,
  normalize,
  logNormalize,
  mapPresentFields,
  weightedMean,
} from "./normalize";

describe("clamp01", () => {
  it("clamps into [0,1]", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(2)).toBe(1);
  });
  it("returns 0 for NaN (defensive, never NaN output)", () => {
    expect(clamp01(NaN)).toBe(0);
  });
});

describe("normalize", () => {
  it("linearly normalizes into [0,1] and clamps outside the range", () => {
    expect(normalize(5, 0, 10)).toBe(0.5);
    expect(normalize(-5, 0, 10)).toBe(0);
    expect(normalize(15, 0, 10)).toBe(1);
  });
  it("degenerate range yields 0 instead of NaN/Infinity", () => {
    expect(normalize(5, 10, 10)).toBe(0);
    expect(normalize(5, 10, 5)).toBe(0);
    expect(Number.isFinite(normalize(5, 10, 5))).toBe(true);
  });
});

describe("logNormalize", () => {
  it("log-compresses skewed ranges into [0,1]", () => {
    expect(logNormalize(1, 1, 100)).toBe(0);
    expect(logNormalize(100, 1, 100)).toBe(1);
    const mid = logNormalize(10, 1, 100);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
  it("clamps out-of-range values", () => {
    expect(logNormalize(0.01, 1, 100)).toBe(0);
    expect(logNormalize(1000, 1, 100)).toBe(1);
  });
  it("rejects a non-positive lo without producing NaN", () => {
    expect(logNormalize(5, 0, 100)).toBe(0);
    expect(Number.isNaN(logNormalize(5, 0, 100))).toBe(false);
  });
});

describe("mapPresentFields", () => {
  it("transforms present values and preserves nulls verbatim", () => {
    expect(mapPresentFields([null, 2, null, 4], (v) => v * 2)).toEqual([
      null,
      4,
      null,
      8,
    ]);
  });
});

describe("weightedMean", () => {
  const weights = [0.5, 0.5];
  it("computes a plain weighted mean when everything is present", () => {
    expect(weightedMean([0, 1], weights)).toBe(0.5);
    expect(weightedMean([0.2, 0.8], weights)).toBe(0.5);
  });
  it("renormalizes the surviving weights when some fields are null (missing != 0)", () => {
    expect(weightedMean([1, null], weights)).toBe(1);
    expect(weightedMean([null, 0], weights)).toBe(0);
    expect(weightedMean([0.2, null], weights)).toBe(0.2);
    expect(weightedMean([null, null, 0.5, 1], [0.1, 0.2, 0.3, 0.4])).toBeCloseTo(
      (0.3 * 0.5 + 0.4 * 1) / 0.7,
      12,
    );
  });
  it("returns null when nothing is present (safe-state)", () => {
    expect(weightedMean([null, null], weights)).toBeNull();
  });
  it("clamps the result into [0,1]", () => {
    expect(weightedMean([2, -1], weights)).toBe(0.5);
  });
  it("throws on length mismatch (config bug)", () => {
    expect(() => weightedMean([1], weights)).toThrow(RangeError);
  });
});