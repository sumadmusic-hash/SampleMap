import { describe, it, expect } from "vitest";
import {
  ANALYSIS_WORKER_PROTOCOL_VERSION,
  isWellFormedAnalyzeSampleRequestV2,
  isWellFormedAnalyzeSampleResponseV2,
  type AnalyzeSampleRequestV2,
  type AnalyzeSampleErrorV2,
} from "./workerContract";
import { ANALYSIS_VERSION } from "./sampleAnalysisV2";
import { computeSoundCharacter, computeSoundCharacterQuality } from "./soundCharacter";
import { PURE_TONE } from "./fixtures";
import type { AnalyzeSampleResponseV2 } from "./workerContract";

const REQUEST: AnalyzeSampleRequestV2 = {
  kind: "analyze-sample-v2",
  protocolVersion: ANALYSIS_WORKER_PROTOCOL_VERSION,
  requestId: "req-1",
  sampleId: "samples/a",
  analysisVersion: ANALYSIS_VERSION,
  audio: new ArrayBuffer(16),
};

const RESPONSE: AnalyzeSampleResponseV2 = {
  kind: "analyze-sample-v2",
  protocolVersion: ANALYSIS_WORKER_PROTOCOL_VERSION,
  requestId: "req-1",
  sampleId: "samples/a",
  analysis: {
    analysisVersion: ANALYSIS_VERSION,
    features: PURE_TONE,
    soundCharacter: computeSoundCharacter(PURE_TONE),
    quality: computeSoundCharacterQuality(computeSoundCharacter(PURE_TONE)),
  },
};

describe("AnalyzeSampleRequestV2 / ResponseV2 contracts (typed, unstructured-clone transport)", () => {
  it("accepts a well-formed request with transferable audio bytes", () => {
    expect(isWellFormedAnalyzeSampleRequestV2(REQUEST)).toBe(true);
    expect(REQUEST.protocolVersion).toBe("v2");
    expect(REQUEST.analysisVersion).toBe("2.0.0");
  });

  it("rejects malformed requests (wrong kind/version/missing audio)", () => {
    expect(isWellFormedAnalyzeSampleRequestV2({ ...REQUEST, kind: "nope" })).toBe(false);
    expect(
      isWellFormedAnalyzeSampleRequestV2({ ...REQUEST, protocolVersion: "v1" }),
    ).toBe(false);
    expect(
      isWellFormedAnalyzeSampleRequestV2({ ...REQUEST, audio: undefined }),
    ).toBe(false);
    expect(isWellFormedAnalyzeSampleRequestV2(null)).toBe(false);
  });

  it("round-trips through structured clone exactly (audio stays a transferable ArrayBuffer)", () => {
    const clone = structuredClone(REQUEST);
    expect(clone).toEqual(REQUEST);
    expect(clone.audio).toBeInstanceOf(ArrayBuffer);
    expect(clone.audio.byteLength).toBe(16);
  });

  it("round-trips a response through JSON without audio bytes", () => {
    const parsed = JSON.parse(JSON.stringify(RESPONSE)) as unknown;
    expect(isWellFormedAnalyzeSampleResponseV2(parsed)).toBe(true);
    expect(parsed).toEqual(RESPONSE);
  });

  it("is structurally distinct for the error variant", () => {
    const err: AnalyzeSampleErrorV2 = {
      kind: "analyze-sample-error-v2",
      protocolVersion: ANALYSIS_WORKER_PROTOCOL_VERSION,
      requestId: "req-1",
      sampleId: "samples/a",
      error: "quality-gate-rejected",
    };
    expect("analysisVersion" in err).toBe(false);
  });
});