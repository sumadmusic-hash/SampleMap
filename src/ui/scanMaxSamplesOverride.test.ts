import { describe, expect, it } from "vitest";

import { readScanMaxSamplesOverride } from "./bootstrap";

describe("STEP76 POC — scan budget override (?scanMaxSamples=)", () => {
  it("keeps the standard 200 budget without the parameter", () => {
    expect(readScanMaxSamplesOverride("")).toBe(200);
    expect(readScanMaxSamplesOverride("?other=1")).toBe(200);
  });

  it("accepts the explicit POC value used for the controlled test", () => {
    expect(readScanMaxSamplesOverride("?scanMaxSamples=1000")).toBe(1000);
  });

  it("reads the parameter alongside other query parameters", () => {
    expect(readScanMaxSamplesOverride("?foo=bar&scanMaxSamples=1000&x=1")).toBe(1000);
  });

  it("falls back to the standard budget for unusable values", () => {
    for (const bad of [
      "?scanMaxSamples=",
      "?scanMaxSamples=abc",
      "?scanMaxSamples=0",
      "?scanMaxSamples=-5",
      "?scanMaxSamples=NaN",
      "?scanMaxSamples=Infinity",
      "?scanMaxSamples=1.5e400",
      "?scanMaxSamples=999999",
    ]) {
      expect(readScanMaxSamplesOverride(bad), bad).toBe(200);
    }
  });

  it("never exceeds the hard ceiling (no unbounded scan)", () => {
    expect(readScanMaxSamplesOverride("?scanMaxSamples=5000")).toBe(5000);
    expect(readScanMaxSamplesOverride("?scanMaxSamples=5001")).toBe(200);
  });

  it("truncates a fractional value instead of trusting it", () => {
    expect(readScanMaxSamplesOverride("?scanMaxSamples=1000.9")).toBe(1000);
  });
});
