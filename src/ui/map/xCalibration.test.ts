import { describe, expect, it } from "vitest";
import { RAW_X_MAX, RAW_X_MIN, calibrateDisplayX } from "./xCalibration";

describe("calibrateDisplayX (STEP91)", () => {
  it("maps the measured corpus endpoints onto 0 and 1", () => {
    expect(calibrateDisplayX(RAW_X_MIN)).toBeCloseTo(0, 12);
    expect(calibrateDisplayX(RAW_X_MAX)).toBeCloseTo(1, 12);
  });

  it("clamps values outside the measured range", () => {
    expect(calibrateDisplayX(0)).toBe(0);
    expect(calibrateDisplayX(-1)).toBe(0);
    expect(calibrateDisplayX(0.2)).toBe(0);
    expect(calibrateDisplayX(1)).toBe(1);
    expect(calibrateDisplayX(2)).toBe(1);
  });

  it("is monotone non-decreasing and preserves sample order", () => {
    const raw = [
      0, 0.1, 0.39, RAW_X_MIN, 0.5, 0.6, 0.75, 0.85, 0.9, RAW_X_MAX, 1,
    ];
    for (let i = 1; i < raw.length; i++) {
      expect(calibrateDisplayX(raw[i]!)).toBeGreaterThanOrEqual(
        calibrateDisplayX(raw[i - 1]!),
      );
    }
  });

  it("stays within [0, 1] and matches the linear stretch", () => {
    const span = RAW_X_MAX - RAW_X_MIN;
    for (let i = 0; i <= 20; i++) {
      const rawX = i / 20;
      const out = calibrateDisplayX(rawX);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(1);
      const expected = Math.min(1, Math.max(0, (rawX - RAW_X_MIN) / span));
      expect(out).toBeCloseTo(expected, 12);
    }
  });

  it("is deterministic", () => {
    expect(calibrateDisplayX(0.77)).toBe(calibrateDisplayX(0.77));
  });
});
