import { describe, it, expect } from "vitest";
import {
  toSampleName,
  isSampleName,
  sampleIdFromName,
  SAMPLE_NAME_PREFIX,
} from "./sampleRef";
import { makeSampleMeta } from "./test-helpers";

describe("AudiotoolSampleReference (sampleRef)", () => {
  it("maps a SampleMeta to its canonical samples/{uuid} name", () => {
    const meta = makeSampleMeta("samples/abc-123");
    expect(toSampleName(meta)).toBe("samples/abc-123");
  });

  it("maps a plain string already in samples/ form unchanged", () => {
    expect(toSampleName("samples/xyz")).toBe("samples/xyz");
  });

  it("prefixes a bare uuid with samples/", () => {
    expect(toSampleName("abc-123")).toBe("samples/abc-123");
  });

  it("validates well-formed sample names", () => {
    expect(isSampleName("samples/abc")).toBe(true);
    expect(isSampleName(SAMPLE_NAME_PREFIX + "A1B2_C.d~-e")).toBe(true);
  });

  it("rejects malformed names", () => {
    expect(isSampleName("abc")).toBe(false);
    expect(isSampleName("samples/ with spaces")).toBe(false);
    expect(isSampleName("")).toBe(false);
  });

  it("extracts the bare id from a sample name", () => {
    expect(sampleIdFromName("samples/abc-123")).toBe("abc-123");
    expect(sampleIdFromName("not-a-name")).toBeUndefined();
  });

  it("round-trips through toSampleName and sampleIdFromName", () => {
    const meta = makeSampleMeta("samples/uuid-1");
    const name = toSampleName(meta);
    expect(sampleIdFromName(name)).toBe("uuid-1");
  });
});
