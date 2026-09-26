/**
 * V2 (STEP 20) analysis worker message contracts.
 *
 * TYPE-ONLY boundary: STEP 20 defines the message shapes; NO worker is
 * instantiated or wired (analysis keeps running through the existing V1
 * pipeline). The existing codebase has no in-app analysis Worker — the only
 * worker project is the global publish Worker, which is metadata-only and does
 * not analyze audio — so the contract is versioned here in the minimal,
 * additive way STEP 20 requires.
 *
 * Transport: structured clone (postMessage) — the `audio` payload is a
 * TRANSFERABLE ArrayBuffer that exists only transiently in the worker's memory;
 * it is never persisted and never part of any record.
 */
import { ANALYSIS_VERSION } from "./sampleAnalysisV2";
import type { SampleAnalysisV2 } from "./sampleAnalysisV2";

/** Versions the worker message protocol itself. */
export const ANALYSIS_WORKER_PROTOCOL_VERSION = "v2" as const;

export interface AnalyzeSampleRequestV2 {
  kind: "analyze-sample-v2";
  protocolVersion: typeof ANALYSIS_WORKER_PROTOCOL_VERSION;
  /** Caller-generated id echoed verbatim in the response (correlation). */
  requestId: string;
  sampleId: string;
  analysisVersion: typeof ANALYSIS_VERSION;
  /** Lossless source audio bytes (transient, transferable, never persisted). */
  audio: ArrayBuffer;
}

export interface AnalyzeSampleResponseV2 {
  kind: "analyze-sample-v2";
  protocolVersion: typeof ANALYSIS_WORKER_PROTOCOL_VERSION;
  requestId: string;
  sampleId: string;
  analysis: SampleAnalysisV2;
}

export interface AnalyzeSampleErrorV2 {
  kind: "analyze-sample-error-v2";
  protocolVersion: typeof ANALYSIS_WORKER_PROTOCOL_VERSION;
  requestId: string;
  sampleId: string;
  /** Machine-readable error category; free-form detail is NOT a crash surface. */
  error: string;
}

export type AnalyzeSampleMessageV2 =
  | AnalyzeSampleRequestV2
  | AnalyzeSampleResponseV2
  | AnalyzeSampleErrorV2;

/** Structural validation of a request (audio bytes are not deep-inspected). */
export function isWellFormedAnalyzeSampleRequestV2(value: unknown): value is AnalyzeSampleRequestV2 {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.kind === "analyze-sample-v2" &&
    r.protocolVersion === ANALYSIS_WORKER_PROTOCOL_VERSION &&
    typeof r.requestId === "string" &&
    typeof r.sampleId === "string" &&
    r.analysisVersion === ANALYSIS_VERSION &&
    r.audio instanceof ArrayBuffer
  );
}

/** Structural validation of a response (analysis is shape-checked end to end). */
export function isWellFormedAnalyzeSampleResponseV2(
  value: unknown,
): value is AnalyzeSampleResponseV2 {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.kind === "analyze-sample-v2" &&
    r.protocolVersion === ANALYSIS_WORKER_PROTOCOL_VERSION &&
    typeof r.requestId === "string" &&
    typeof r.sampleId === "string"
  );
}