import { describe, it, expect } from "vitest";
import type {
  GlobalSampleIndex,
  GlobalPublishResult,
  GlobalPublishBatch,
  GlobalAnalysisResult,
  GlobalSampleLookupHit,
  GlobalContentLookupHit,
  GlobalMapViewportResult,
  GlobalIndexError,
  MapViewportQuery,
  GlobalPublishOutcome,
} from "./contract";
import {
  validatePublishResult,
  isPublishBatchValid,
  mapVersion,
  SIMILARITY_VERSION,
} from "./validation";
import { makeContentIdentity, contentIdentityKey } from "../identity/audioContentIdentity";
import { makeFeatures } from "../classify/test-helpers";
import { computeSimilarityFingerprint } from "../similarity/similarityFingerprint";
import {
  SOUND_CHARACTER_CODEC_VERSION,
  encodeSoundCharacterToBase64,
} from "./soundCharacterCodec";
import { SIMILARITY_ALGORITHM_VERSION } from "../analysis/similarityEngine";
import { SOUND_SPACE_ALGORITHM_VERSION } from "../analysis/soundSpaceProjector";
import { emptySoundCharacter } from "../analysis/soundCharacter";
import { assertNoAudioBytes } from "../persistence/indexStore";
import type { GlobalSoundCharacterKnowledge } from "./contract";
import type { SoundCharacter } from "../analysis/soundCharacter";

// ─────────────────────────────────────────────────────────────────────────────
// Step 16A — Global Index Contract
//
// Contract-only tests. These prove the *shape* of the boundary (types, values,
// audio-free invariant, version independence, batching) WITHOUT any backend.
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_A = "samples/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SAMPLE_B = "samples/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const HASH_1 = "a".repeat(64);

function makeResult(overrides: Partial<GlobalAnalysisResult> = {}): GlobalAnalysisResult {
  const features = makeFeatures();
  const fp = computeSimilarityFingerprint(features);
  return {
    contentIdentity: makeContentIdentity(HASH_1, "pcm-v1"),
    classificationVersion: "heuristic-v1",
    primaryClass: "kick",
    confidence: 0.9,
    secondaryClasses: [{ class: "toms", confidence: 0.08 }],
    analysisVersion: "features-v1",
    analysisBuild: "build-v1",
    // V2: map is a PERSISTED analysis result (computed once from decoded audio),
    // NOT a value reconstructed from features downstream.
    map: { mapVersion, x: 0.4, y: 0.6 },
    similarity: fp,
    analysisSourceFormat: "wav",
    gatePassed: true,
    audioFeatures: features,
    ...overrides,
  };
}

function makePublish(
  sampleId: string = SAMPLE_A,
  overrides: Partial<GlobalAnalysisResult> = {},
): GlobalPublishResult {
  return {
    sampleId,
    contentIdentity: makeContentIdentity(HASH_1, "pcm-v1"),
    analysis: makeResult(overrides),
    features: makeFeatures(),
  };
}

function makeBatch(...results: GlobalPublishResult[]): GlobalPublishBatch {
  return results;
}

// ─── Sample lookup (discriminated union) ────────────────────────────────────

describe("GlobalSampleLookupHit", () => {
  it("distinguishes known from unknown structurally (no null semantics)", () => {
    const known: GlobalSampleLookupHit = {
      status: "known",
      sampleId: SAMPLE_A,
      contentIdentity: makeContentIdentity(HASH_1, "pcm-v1"),
      analysis: makeResult(),
    };
    const unknown: GlobalSampleLookupHit = {
      status: "unknown",
      sampleId: SAMPLE_A,
    };
    // Discriminated on `status` — both are exhaustive and non-ambiguous.
    const summarize = (h: GlobalSampleLookupHit[]) =>
      h.map((x) => (x.status === "known" ? "known" : "unknown"));
    expect(summarize([known, unknown])).toEqual(["known", "unknown"]);
  });

  it("a known hit carries an explicit contentIdentity + analysis; unknown carries none", () => {
    const known: GlobalSampleLookupHit = {
      status: "known",
      sampleId: SAMPLE_A,
      contentIdentity: makeContentIdentity(HASH_1, "pcm-v1"),
      analysis: makeResult(),
    };
    if (known.status === "known") {
      expect(known.contentIdentity.contentHash).toBe(HASH_1);
      expect(known.analysis.primaryClass).toBe("kick");
    }
    const unknown: GlobalSampleLookupHit = { status: "unknown", sampleId: SAMPLE_A };
    if (unknown.status === "unknown") {
      // unknown has no analysis — the fast path can immediately fall through
      expect("analysis" in unknown).toBe(false);
    }
  });
});

// ─── Content lookup (sample_ref → content) ──────────────────────────────────

describe("GlobalContentLookupHit — sample_ref → content", () => {
  it("represents multiple sampleIds mapping to one content identity (AAA/BBB → XYZ)", () => {
    const identity = makeContentIdentity(HASH_1, "pcm-v1");
    const hit: GlobalContentLookupHit = {
      contentIdentity: identity,
      analysis: makeResult(),
      sampleIds: [SAMPLE_A, SAMPLE_B],
      representativeSampleId: SAMPLE_A,
    };
    expect(hit.sampleIds).toEqual([SAMPLE_A, SAMPLE_B]);
    expect(contentIdentityKey(hit.contentIdentity)).toBe(`pcm-v1:${HASH_1}`);
    expect(hit.representativeSampleId).toBe(SAMPLE_A); // lex smallest
  });
});

// ─── Publish payload — no audio bytes ───────────────────────────────────────

describe("GlobalPublishResult — no audio bytes (audio-byte safety)", () => {
  it("a valid publish payload passes (metadata/hashes/fingerprints only)", () => {
    expect(validatePublishResult(makePublish())).toEqual([]);
    expect(isPublishBatchValid(makeBatch(makePublish()))).toBe(true);
  });

  it("throws when the payload carries a byte container (e.g. ArrayBuffer)", () => {
    const bad = makePublish();
    (bad as unknown as { bytes: ArrayBuffer }).bytes = new ArrayBuffer(16);
    expect(() => validatePublishResult(bad)).toThrow(/audio byte container/);
  });

  it("throws when the payload carries raw PCM typed array (Uint8Array)", () => {
    const bad = makePublish();
    (bad as unknown as { pcm: Uint8Array }).pcm = new Uint8Array(4);
    expect(() => validatePublishResult(bad)).toThrow(/typed array/);
  });

  it("throws when a Blob is present", () => {
    const bad = makePublish();
    (bad as unknown as { blob: Blob }).blob = new Blob(["x"]);
    expect(() => validatePublishResult(bad)).toThrow(/audio byte container/);
  });

  it("global publish payload is structurally distinct from an audio-bearing object", () => {
    // Contract types expose no `audio`/`bytes`/`blob`/`audioUrl` field.
    const r = makePublish();
    const keys = Object.keys(r);
    expect(keys).not.toContain("audio");
    expect(keys).not.toContain("bytes");
    expect(keys).not.toContain("blob");
    expect(keys).not.toContain("audioUrl");
  });
});

// ─── Publish shape & required identity fields ───────────────────────────────

describe("GlobalPublishResult validation", () => {
  it("accepts a valid result (required identity + version fields present)", () => {
    expect(validatePublishResult(makePublish())).toEqual([]);
  });

  it("rejects a malformed contentHash (not 64 hex)", () => {
    const r = makePublish();
    r.contentIdentity = makeContentIdentity("short", "pcm-v1");
    r.analysis.contentIdentity = makeContentIdentity("short", "pcm-v1");
    const issues = validatePublishResult(r);
    expect(issues.some((i) => i.path === "contentIdentity.contentHash")).toBe(true);
  });

  it("rejects a publish whose top-level contentIdentity contradicts the analysis", () => {
    const r = makePublish();
    r.contentIdentity = makeContentIdentity("b".repeat(64), "pcm-v1");
    expect(
      validatePublishResult(r).some((i) => i.path === "contentIdentity"),
    ).toBe(true);
  });

  it("rejects an unknown primaryClass", () => {
    const r = makePublish(SAMPLE_A, { primaryClass: "not-a-class" as "kick" });
    expect(validatePublishResult(r).some((i) => i.path === "analysis.primaryClass")).toBe(true);
  });

  it("rejects confidence out of [0,1]", () => {
    const r = makePublish(SAMPLE_A, { confidence: 1.5 });
    expect(validatePublishResult(r).some((i) => i.path === "analysis.confidence")).toBe(true);
  });

  it("rejects map coordinates out of [0,1]", () => {
    const r = makePublish();
    r.analysis.map = { mapVersion, x: 1.2, y: -0.1 };
    const issues = validatePublishResult(r);
    expect(issues.some((i) => i.path === "analysis.map.x")).toBe(true);
    expect(issues.some((i) => i.path === "analysis.map.y")).toBe(true);
  });

  it("rejects a gate that did not pass (gatePassed must be true)", () => {
    const r = makePublish(SAMPLE_A, { gatePassed: false as true });
    expect(validatePublishResult(r).some((i) => i.path === "analysis.gatePassed")).toBe(true);
  });

  it("rejects a non-lossless analysisSourceFormat", () => {
    const r = makePublish(SAMPLE_A, { analysisSourceFormat: "mp3" as "wav" });
    expect(validatePublishResult(r).some((i) => i.path === "analysis.analysisSourceFormat")).toBe(true);
  });

  it("rejects an unsupported similarityVersion", () => {
    const r = makePublish();
    r.analysis.similarity = { similarityVersion: "similarity-v2" as "similarity-v1", values: [0, 0, 0, 0, 0, 0, 0, 0] };
    expect(validatePublishResult(r).some((i) => i.path === "analysis.similarity.similarityVersion")).toBe(true);
  });
});

// ─── V2 map = persisted result (NOT feature-derivable) ──────────────────────

describe("V2 map position is a persisted result, not feature-recomputed", () => {
  it("validation accepts a map coordinate that is independent of the submitted features", () => {
    // Under V2 the map was computed once at analysis time from DECODED AUDIO,
    // so it is not reproducible from the submitted audioFeatures. Validation
    // reads the persisted coordinates without cross-checking them against
    // features (no recompute).
    const r = makePublish();
    r.analysis.map = { mapVersion, x: 0.4, y: 0.6 };
    expect(validatePublishResult(r)).toEqual([]);
  });

  it("validation rejects a similarity fingerprint that contradicts the submitted features", () => {
    const r = makePublish();
    r.analysis.similarity = {
      similarityVersion: SIMILARITY_VERSION,
      values: r.analysis.similarity.values.map((v) => 1 - v),
    };
    const issues = validatePublishResult(r);
    expect(issues.some((i) => i.path === "analysis.similarity")).toBe(true);
  });

  it("does NOT recalculate the map from features (no derived-map cross-check)", () => {
    // Publish payload carries no decoded audio; the persisted map must stand on
    // its own. There is no derive-from-features path in validation.
    const r = makePublish();
    expect(r.features).toBeDefined();
    expect(r.analysis.map.mapVersion).toBe(mapVersion);
  });
});

// ─── Identity: two sampleIds → same content identity ────────────────────────

describe("identity — two sampleIds → same content identity", () => {
  it("publishing two sampleIds with the same content identity is one key", () => {
    const batch = makeBatch(makePublish(SAMPLE_A), makePublish(SAMPLE_B));
    // Batch valid & idempotent-relevant: both reference the same content key.
    expect(isPublishBatchValid(batch)).toBe(true);
    expect(batch[0].contentIdentity).toEqual(batch[1].contentIdentity);
    expect(contentIdentityKey(batch[0].contentIdentity)).toBe(
      contentIdentityKey(batch[1].contentIdentity),
    );
  });
});

// ─── Batching ───────────────────────────────────────────────────────────────

describe("batching", () => {
  it("a batch of multiple lookup entries type-checks as an array of hits", () => {
    const hits: GlobalSampleLookupHit[] = [
      { status: "known", sampleId: SAMPLE_A, contentIdentity: makeContentIdentity(HASH_1, "pcm-v1"), analysis: makeResult() },
      { status: "unknown", sampleId: SAMPLE_B },
    ];
    expect(hits).toHaveLength(2);
    expect(hits.filter((h) => h.status === "known")).toHaveLength(1);
  });

  it("a batch of multiple publish entries is accepted", () => {
    const batch = makeBatch(makePublish(SAMPLE_A), makePublish(SAMPLE_B));
    expect(isPublishBatchValid(batch)).toBe(true);
  });

  it("batch outcome reports one item per submitted entry and an accepted flag", () => {
    const outcome: GlobalPublishOutcome = {
      items: [{ status: "stored" }, { status: "already-known" }],
      accepted: true,
    };
    expect(outcome.accepted).toBe(true);
    expect(outcome.items).toHaveLength(2);
  });
});

// ─── Viewport ───────────────────────────────────────────────────────────────

describe("MapViewportQuery / GlobalMapViewportResult", () => {
  it("a valid viewport query has bounded x/y ranges + version (no 'get everything')", () => {
    const q: MapViewportQuery = {
      mapVersion,
      xMin: 0,
      xMax: 1,
      yMin: 0,
      yMax: 1,
      zoom: 2,
      primaryClass: "kick",
      limit: 100,
      cursor: "abc",
    };
    expect(q.mapVersion).toBe("map-v2");
    expect(q.xMax - q.xMin).toBe(1);
  });

  it("viewport result returns points + optional nextCursor (pagination)", () => {
    const res: GlobalMapViewportResult = {
      mapVersion,
      points: [
        {
          contentIdentity: makeContentIdentity(HASH_1, "pcm-v1"),
          x: 0.5,
          y: 0.5,
          representativeSampleId: SAMPLE_A,
          primaryClass: "kick",
        },
      ],
      nextCursor: "page-2",
    };
    expect(res.points).toHaveLength(1);
    expect(res.nextCursor).toBe("page-2");
  });
});

// ─── Error semantics ────────────────────────────────────────────────────────

describe("GlobalIndexError semantics", () => {
  const errors: GlobalIndexError[] = [
    { kind: "not-found" },
    { kind: "validation-rejected", reason: "confidence > 1" },
    { kind: "version-incompatible", detail: "similarity-v2 unsupported" },
    { kind: "conflict", detail: "already exists" },
    { kind: "rate-limited" },
    { kind: "temporary-unavailable" },
  ];

  it("distinguishes the six backend-agnostic error kinds", () => {
    expect(errors.map((e) => e.kind)).toEqual([
      "not-found",
      "validation-rejected",
      "version-incompatible",
      "conflict",
      "rate-limited",
      "temporary-unavailable",
    ]);
  });

  it("carries no HTTP status codes (backend-agnostic)", () => {
    const sample = errors[1];
    expect("status" in sample).toBe(false);
    expect("statusCode" in sample).toBe(false);
  });
});

// ─── The contract interface (operations shape) ──────────────────────────────

describe("GlobalSampleIndex contract operations", () => {
  it("declares the four batch-shaped, audio-free operations", () => {
    const contract: GlobalSampleIndex = {
      lookupSamples: async () => [],
      lookupContentIdentities: async () => [],
      publishAnalysisResults: async (batch) => ({
        items: batch.map(() => ({ status: "stored" }) as const),
        accepted: true,
      }),
      queryMapViewport: async () => ({ mapVersion, points: [] }),
    };
    // The interface is satisfied by a provider-ish fake — no backend needed.
    expect(typeof contract.lookupSamples).toBe("function");
    expect(typeof contract.lookupContentIdentities).toBe("function");
    expect(typeof contract.publishAnalysisResults).toBe("function");
    expect(typeof contract.queryMapViewport).toBe("function");
  });

  it("publishAnalysisResults maps each item to an outcome", async () => {
    const contract: GlobalSampleIndex = {
      lookupSamples: async () => [],
      lookupContentIdentities: async () => [],
      publishAnalysisResults: async (batch) => ({
        items: batch.map((r) =>
          r.sampleId === "bad" ? { status: "rejected" as const, reason: "x" } : { status: "stored" as const },
        ),
        accepted: true,
      }),
      queryMapViewport: async () => ({ mapVersion, points: [] }),
    };
    const out = await contract.publishAnalysisResults([
      makePublish(SAMPLE_A),
      makePublish("bad"),
    ]);
    expect(out.items[0].status).toBe("stored");
    expect(out.items[1].status).toBe("rejected");
  });
});

// ─── STEP41 — compact V2 knowledge block (contract shape + no-audio) ─────────

function knowledgeBlock(overrides: Partial<GlobalSoundCharacterKnowledge> = {}): GlobalSoundCharacterKnowledge {
  const char: SoundCharacter = {
    ...emptySoundCharacter(),
    brightness: 0.4,
    density: 0.6,
    transient: 0.5,
    duration: null,
    tonality: 0.7,
    noisiness: 0.2,
    dynamics: 0.3,
    complexity: 0.8,
  };
  return {
    codecVersion: SOUND_CHARACTER_CODEC_VERSION,
    packed: encodeSoundCharacterToBase64(char),
    analysisVersion: "2.0.0",
    similarityVersion: SIMILARITY_ALGORITHM_VERSION,
    soundSpaceVersion: SOUND_SPACE_ALGORITHM_VERSION,
    classificationVersion: "heuristic-v1",
    confidence: 0.9,
    durationMs: 400,
    ...overrides,
  };
}

describe("STEP41 — GlobalAnalysisResult.soundCharacterV2", () => {
  it("is OPTIONAL and ADDITIVE: a V1-style result carries none", () => {
    expect(makeResult().soundCharacterV2).toBeUndefined();
  });

  it("is carried verbatim when present and passes validation", () => {
    const result = makeResult({ soundCharacterV2: knowledgeBlock() });
    expect(result.soundCharacterV2!.codecVersion).toBe("V2.SC-v1");
    // The block travels the contract and survives the no-audio audit (strings/numbers).
    expect(() => assertNoAudioBytes(result)).not.toThrow();
  });

  it("rejects a structurally broken block at the publish rule set", () => {
    const good = makePublish(SAMPLE_A);
    const brokenBlock = knowledgeBlock({ packed: "not-base64" });
    const bad = makePublish(SAMPLE_A, { soundCharacterV2: brokenBlock } as Partial<GlobalAnalysisResult>);
    const issuesGood = validatePublishResult(good);
    const issuesBad = validatePublishResult(bad);
    expect(issuesGood).toEqual([]);
    expect(issuesBad.some((i) => i.path === "analysis.soundCharacterV2.packed")).toBe(true);
  });

  it("rejects a block that disagrees with the analysis confidence", () => {
    const bad = makePublish(SAMPLE_A, {
      soundCharacterV2: knowledgeBlock({ confidence: 0.1 }),
    } as Partial<GlobalAnalysisResult>);
    const issues = validatePublishResult(bad);
    expect(issues.some((i) => i.path === "analysis.soundCharacterV2.confidence")).toBe(true);
  });

  it("rejects a block whose duration disagrees with features.duration", () => {
    const bad = makePublish(SAMPLE_A, {
      soundCharacterV2: knowledgeBlock({ durationMs: 999_000 }),
    } as Partial<GlobalAnalysisResult>);
    const issues = validatePublishResult(bad);
    expect(issues.some((i) => i.path === "analysis.soundCharacterV2.durationMs")).toBe(true);
  });
});
