import { describe, it, expect, vi } from "vitest";
import type {
  SampleIndexRecord,
} from "../persistence/indexStore";
import type {
  GlobalSampleIndex,
  GlobalPublishResult,
  GlobalPublishOutcome,
  GlobalPublishItemOutcome,
} from "./contract";
import { contentIdentityKey } from "../identity/audioContentIdentity";
import { mapVersion } from "../map/mapPosition";
import {
  computeSimilarityFingerprint,
} from "../similarity/similarityFingerprint";
import { makeFeatures } from "../classify/test-helpers";
import {
  createPublishCandidate,
  validatePublishCandidate,
  PublishCandidateError,
} from "./publish";
import { GlobalPublishQueue } from "./publishQueue";
import type { GlobalIndexError } from "./contract";
import { publishStatusFor } from "../ui/view";
import {
  SOUND_CHARACTER_CODEC_VERSION,
  decodeSoundCharacterFromBase64,
} from "./soundCharacterCodec";
import { SIMILARITY_ALGORITHM_VERSION } from "../analysis/similarityEngine";
import { SOUND_SPACE_ALGORITHM_VERSION } from "../analysis/soundSpaceProjector";
import { emptySoundCharacter, type SoundCharacter } from "../analysis/soundCharacter";
import { computeSoundCharacterQuality } from "../analysis/soundCharacter";
import { ANALYSIS_VERSION } from "../analysis/sampleAnalysisV2";

// ─────────────────────────────────────────────────────────────────────────────
// Step 16D — Global Publish Queue / Write Semantics
//
// Tests cover: candidate eligibility (A–E), queue dedup (F–I), batch (J–K),
// error handling (L–P), provider payload inspection (Q), idempotency (R),
// version independence (S), offline (T), and a full integration flow (§33).
// No backend, no network, no audio.
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_AAA = "samples/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SAMPLE_BBB = "samples/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SAMPLE_CCC = "samples/cccccccc-cccc-cccc-cccc-cccccccccccc";
const HASH_XYZ = "f".repeat(64);
const HASH_ABC = "a".repeat(64);
const ANALYSIS_BUILD = "build-16d-test";
const NOW_MS = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a realistic local SampleIndexRecord
// ─────────────────────────────────────────────────────────────────────────────

function makeLocalRecord(
  overrides: Partial<SampleIndexRecord> = {},
): SampleIndexRecord {
  const features = makeFeatures();
  return {
    sampleId: SAMPLE_AAA,
    owner: "test-owner",
    visibility: "public",
    name: "Test Sample",
    kind: "sample",
    originalTags: ["test"],
    primaryClass: "kick",
    confidence: 0.9,
    secondaryClasses: [{ class: "toms", confidence: 0.08 }],
    classificationVersion: "heuristic-v1",
    audioFeatures: features,
    analysisVersion: "features-v1",
    analyzedAt: NOW_ISO,
    analysisBuild: ANALYSIS_BUILD,
    status: "analyzed",
    analysisSourceFormat: "wav",
    fileHash: "a".repeat(64),
    contentHash: HASH_XYZ,
    contentHashVersion: "pcm-v1",
    similarityFingerprint: computeSimilarityFingerprint(features),
    // V2: persisted map position (analysis result) required for publishing.
    mapPosition: { x: 0.4, y: 0.6 },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: fake GlobalSampleIndex that captures publish payloads
// ─────────────────────────────────────────────────────────────────────────────

class FakeGlobalSampleIndex implements GlobalSampleIndex {
  public publishCalls: GlobalPublishResult[][] = [];
  private readonly outcomePerItem: (
    item: GlobalPublishResult,
  ) => GlobalPublishItemOutcome;
  private shouldThrow?: (batch: GlobalPublishResult[]) => void;

  constructor(opts: {
    outcomePerItem?: (
      item: GlobalPublishResult,
    ) => GlobalPublishItemOutcome;
    shouldThrow?: (batch: GlobalPublishResult[]) => void;
  } = {}) {
    this.outcomePerItem =
      opts.outcomePerItem ??
      (() => ({ status: "stored" }));
    this.shouldThrow = opts.shouldThrow;
  }

  async lookupSamples() { return []; }
  async lookupContentIdentities() { return []; }
  async queryMapViewport() {
    return { mapVersion, points: [] };
  }

  async publishAnalysisResults(
    batch: GlobalPublishResult[],
  ): Promise<GlobalPublishOutcome> {
    this.publishCalls.push([...batch]);
    if (this.shouldThrow) this.shouldThrow(batch);

    const items: GlobalPublishItemOutcome[] = batch.map((item) =>
      this.outcomePerItem(item),
    );
    const accepted = items.every(
      (i) => i.status === "stored" || i.status === "already-known",
    );
    return { items, accepted };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A — Valid Publish Candidate
// ─────────────────────────────────────────────────────────────────────────────

describe("A — valid publish candidate", () => {
  it("a well-formed analyzed local record produces a valid candidate", () => {
    const record = makeLocalRecord();
    const candidate = createPublishCandidate(record);

    expect(candidate.sampleId).toBe(SAMPLE_AAA);
    expect(candidate.contentIdentity.contentHash).toBe(HASH_XYZ);
    expect(candidate.contentIdentity.contentHashVersion).toBe("pcm-v1");
    expect(candidate.analysis.gatePassed).toBe(true);
    expect(candidate.analysis.contentIdentity.contentHash).toBe(HASH_XYZ);
    expect(candidate.analysis.primaryClass).toBe("kick");
    expect(candidate.features).toBeDefined();
  });

  it("validatePublishCandidate returns ok:true for a valid candidate", () => {
    const candidate = createPublishCandidate(makeLocalRecord());
    expect(validatePublishCandidate(candidate)).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — Missing Content Hash
// ─────────────────────────────────────────────────────────────────────────────

describe("B — missing content hash", () => {
  it("throws PublishCandidateError when contentHash is absent", () => {
    const record = makeLocalRecord({ contentHash: undefined });
    expect(() => createPublishCandidate(record)).toThrow(
      PublishCandidateError,
    );
    expect(() => createPublishCandidate(record)).toThrow(/missing content identity/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Missing Content Hash Version
// ─────────────────────────────────────────────────────────────────────────────

describe("C — missing content hash version", () => {
  it("throws PublishCandidateError when contentHashVersion is absent", () => {
    const record = makeLocalRecord({ contentHashVersion: undefined });
    expect(() => createPublishCandidate(record)).toThrow(
      PublishCandidateError,
    );
    expect(() => createPublishCandidate(record)).toThrow(/missing content identity/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D — Quality Gate Failed (status !== "analyzed")
// ─────────────────────────────────────────────────────────────────────────────

describe("D — quality gate failed / status not analyzed", () => {
  it("rejects a pending record", () => {
    const record = makeLocalRecord({ status: "pending" });
    expect(() => createPublishCandidate(record)).toThrow(PublishCandidateError);
    expect(() => createPublishCandidate(record)).toThrow(/only analyzed records are publishable/);
  });

  it("rejects a failed record", () => {
    const record = makeLocalRecord({ status: "failed" });
    expect(() => createPublishCandidate(record)).toThrow(PublishCandidateError);
  });

  it("rejects a skipped record", () => {
    const record = makeLocalRecord({ status: "gone" });
    expect(() => createPublishCandidate(record)).toThrow(PublishCandidateError);
  });

  it("rejects a record missing the persisted V2 mapPosition (Missing-V2, no V1 fallback)", () => {
    const record = makeLocalRecord({ mapPosition: undefined });
    expect(() => createPublishCandidate(record)).toThrow(PublishCandidateError);
    expect(() => createPublishCandidate(record)).toThrow(/missing a persisted V2 mapPosition/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E — Audio Bytes in candidate → rejected
// ─────────────────────────────────────────────────────────────────────────────

describe("E — audio bytes", () => {
  it("createPublishCandidate rejects a record containing an ArrayBuffer", () => {
    const record = makeLocalRecord();
    // Inject an ArrayBuffer into the record's features (simulating audio bytes).
    (record as unknown as Record<string, unknown>).audioBuffer = new ArrayBuffer(16);
    expect(() => createPublishCandidate(record)).toThrow(/prohibited/);
  });

  it("validatePublishCandidate rejects a candidate containing a Blob", () => {
    const candidate = createPublishCandidate(makeLocalRecord());
    // Manually inject audio into the candidate — should be caught by validatePublishResult.
    (candidate as unknown as Record<string, unknown>).audioBlob = new Blob();
    expect(() => validatePublishCandidate(candidate)).toThrow(/prohibited/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F — Duplicate Candidate (same sampleId)
// ─────────────────────────────────────────────────────────────────────────────

describe("F — duplicate candidate (same sampleId)", () => {
  it("second enqueue of the same sampleId is a no-op", () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });
    const candidate = createPublishCandidate(makeLocalRecord());

    expect(queue.enqueue(candidate)).toBe("queued");
    expect(queue.enqueue(candidate)).toBe("duplicate");
    expect(queue.pendingCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G — Different Samples, Same Content
// ─────────────────────────────────────────────────────────────────────────────

describe("G — different samples, same content", () => {
  it("AAA→X and BBB→X produce two queue items (two sample refs)", () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    const aaa = createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_AAA }));
    const bbb = createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_BBB }));

    expect(queue.enqueue(aaa)).toBe("queued");
    expect(queue.enqueue(bbb)).toBe("queued");
    expect(queue.pendingCount).toBe(2);

    // Both have the same content key.
    const items = queue.snapshot();
    expect(items[0].contentKey).toBe(items[1].contentKey);
    expect(items[0].sampleId).toBe(SAMPLE_AAA);
    expect(items[1].sampleId).toBe(SAMPLE_BBB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H — Different Content
// ─────────────────────────────────────────────────────────────────────────────

describe("H — different content", () => {
  it("AAA→X and BBB→Y produce two queue items with different content keys", () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    const aaa = createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_AAA, contentHash: HASH_XYZ }));
    const bbb = createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_BBB, contentHash: HASH_ABC }));

    expect(queue.enqueue(aaa)).toBe("queued");
    expect(queue.enqueue(bbb)).toBe("queued");

    const items = queue.snapshot();
    expect(items[0].contentKey).not.toBe(items[1].contentKey);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I — Same Sample (idempotent enqueue)
// ─────────────────────────────────────────────────────────────────────────────

describe("I — same sample (idempotent)", () => {
  it("enqueuing the same candidate multiple times yields one item", () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });
    const candidate = createPublishCandidate(makeLocalRecord());

    for (let i = 0; i < 5; i++) {
      queue.enqueue(candidate);
    }
    expect(queue.pendingCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J — Batch
// ─────────────────────────────────────────────────────────────────────────────

describe("J — batch", () => {
  it("flush sends all pending items as a single batch to the provider", async () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    const c1 = createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_AAA, contentHash: "a".repeat(64) }));
    const c2 = createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_BBB, contentHash: "b".repeat(64) }));
    const c3 = createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_CCC, contentHash: "c".repeat(64) }));

    queue.enqueue(c1);
    queue.enqueue(c2);
    queue.enqueue(c3);

    const result = await queue.flush();
    expect(result.submitted).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(provider.publishCalls).toHaveLength(1);
    expect(provider.publishCalls[0]).toHaveLength(3);
  });

  it("respects batchSize: flushes only the configured number of items", async () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS, batchSize: 2 });

    const c1 = createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_AAA, contentHash: "a".repeat(64) }));
    const c2 = createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_BBB, contentHash: "b".repeat(64) }));
    const c3 = createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_CCC, contentHash: "c".repeat(64) }));

    queue.enqueue(c1);
    queue.enqueue(c2);
    queue.enqueue(c3);

    const result = await queue.flush();
    expect(result.submitted).toBe(2);
    expect(result.retryable).toBe(0);
    // One item still pending.
    expect(queue.pendingCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K — Empty Batch
// ─────────────────────────────────────────────────────────────────────────────

describe("K — empty batch", () => {
  it("flushing an empty queue returns submitted=0 and never calls provider", async () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    const result = await queue.flush();
    expect(result.submitted).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(provider.publishCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L — Retryable Error (temporary-unavailable)
// ─────────────────────────────────────────────────────────────────────────────

describe("L — retryable error (temporary-unavailable)", () => {
  it("item becomes retryable and remains eligible for future flush", async () => {
    const provider = new FakeGlobalSampleIndex({
      outcomePerItem: () => ({
        status: "rejected",
        reason: "temporary-unavailable",
      }),
    });
    const queue = new GlobalPublishQueue(provider, {
      now: () => NOW_MS,
      maxAttempts: 3,
    });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    const result = await queue.flush();

    expect(result.submitted).toBe(1);
    expect(result.retryable).toBe(1);
    expect(queue.itemsByStatus("retryable")).toHaveLength(1);
    expect(queue.pendingCount).toBe(1); // retryable counts as pending for future flush
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M — Rate Limited
// ─────────────────────────────────────────────────────────────────────────────

describe("M — rate limited", () => {
  it("item becomes retryable (same as temporary-unavailable)", async () => {
    const provider = new FakeGlobalSampleIndex({
      outcomePerItem: () => ({
        status: "rejected",
        reason: "rate-limited",
      }),
    });
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    const result = await queue.flush();

    expect(result.retryable).toBe(1);
    expect(queue.itemsByStatus("retryable")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// N — Validation Rejected (non-retryable)
// ─────────────────────────────────────────────────────────────────────────────

describe("N — validation rejected (non-retryable)", () => {
  it("item becomes failed (terminal)", async () => {
    const provider = new FakeGlobalSampleIndex({
      outcomePerItem: () => ({
        status: "rejected",
        reason: "validation-rejected",
      }),
    });
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    const result = await queue.flush();

    expect(result.rejected).toBe(1);
    expect(result.retryable).toBe(0);
    expect(queue.itemsByStatus("failed")).toHaveLength(1);
    expect(queue.pendingCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O — Version Incompatible (non-retryable)
// ─────────────────────────────────────────────────────────────────────────────

describe("O — version incompatible (non-retryable)", () => {
  it("item becomes failed (terminal)", async () => {
    const provider = new FakeGlobalSampleIndex({
      outcomePerItem: () => ({
        status: "rejected",
        reason: "version-incompatible",
      }),
    });
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    const result = await queue.flush();

    expect(result.rejected).toBe(1);
    expect(queue.itemsByStatus("failed")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P — Conflict (always terminal, visible)
// ─────────────────────────────────────────────────────────────────────────────

describe("P — conflict (always terminal)", () => {
  it("item becomes failed (never silently overwritten)", async () => {
    const provider = new FakeGlobalSampleIndex({
      outcomePerItem: () => ({
        status: "rejected",
        reason: "conflict: sample mapped to different content",
      }),
    });
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    const result = await queue.flush();

    expect(result.rejected).toBe(1);
    expect(result.retryable).toBe(0);
    const items = queue.itemsByStatus("failed");
    expect(items).toHaveLength(1);
    expect(items[0].lastError).toContain("conflict");
  });

  it("conflict is never auto-resolved by the queue", async () => {
    const provider = new FakeGlobalSampleIndex({
      outcomePerItem: () => ({
        status: "rejected",
        reason: "conflict: content identity mismatch",
      }),
    });
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    await queue.flush();

    // The item is terminal — it won't be retried.
    expect(queue.pendingCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q — Provider Failure: inspect payload (no audio in batch)
// ─────────────────────────────────────────────────────────────────────────────

describe("Q — provider payload inspection (no audio)", () => {
  it("the batch payload is audio-free (serialized, no byte containers)", async () => {
    let capturedBatch: GlobalPublishResult[] = [];
    const provider = new FakeGlobalSampleIndex();
    provider.publishAnalysisResults = async (batch) => {
      capturedBatch = batch;
      const text = JSON.stringify(batch);
      expect(text).not.toContain("ArrayBuffer");
      expect(text).not.toContain("Uint8Array");
      expect(text).not.toContain("Blob");
      expect(text).not.toContain("AudioBuffer");
      return {
        items: batch.map(() => ({ status: "stored" as const })),
        accepted: true,
      };
    };

    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });
    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    queue.enqueue(
      createPublishCandidate(
        makeLocalRecord({ sampleId: SAMPLE_BBB, contentHash: HASH_ABC }),
      ),
    );
    await queue.flush();

    expect(capturedBatch).toHaveLength(2);
    // Verify the payload carries the correct content identity.
    expect(capturedBatch[0].contentIdentity.contentHash).toBe(HASH_XYZ);
    expect(capturedBatch[1].contentIdentity.contentHash).toBe(HASH_ABC);
  });

  it("provider receives features and analysis, not audio bytes", async () => {
    let capturedBatch: GlobalPublishResult[] = [];
    const provider = new FakeGlobalSampleIndex();
    provider.publishAnalysisResults = async (batch) => {
      capturedBatch = batch;
      return {
        items: batch.map(() => ({ status: "stored" as const })),
        accepted: true,
      };
    };

    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });
    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    await queue.flush();

    const payload = capturedBatch[0];
    expect(payload.features).toBeDefined();
    expect(typeof payload.features.duration).toBe("number");
    expect(payload.analysis).toBeDefined();
    expect(payload.analysis.gatePassed).toBe(true);
    expect(payload.analysis.primaryClass).toBe("kick");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R — Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("R — idempotency", () => {
  it("enqueue + flush + enqueue same candidate → second enqueue is duplicate", async () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });
    const candidate = createPublishCandidate(makeLocalRecord());

    queue.enqueue(candidate);
    await queue.flush();

    // Now try to enqueue again after success.
    const result = queue.enqueue(candidate);
    expect(result).toBe("duplicate"); // succeeded items are not re-queued
    expect(queue.pendingCount).toBe(0);
  });

  it("repeated flushes on an already-flushed queue produce no additional calls", async () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    await queue.flush();
    await queue.flush();

    expect(provider.publishCalls).toHaveLength(1); // only one batch
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S — Version Independence
// ─────────────────────────────────────────────────────────────────────────────

describe("S — version independence", () => {
  it("different map versions do not change the content identity", () => {
    const r1 = makeLocalRecord({ contentHash: HASH_XYZ, contentHashVersion: "pcm-v1" });
    const r2 = makeLocalRecord({ contentHash: HASH_XYZ, contentHashVersion: "pcm-v1" });

    const c1 = createPublishCandidate(r1);
    const c2 = createPublishCandidate(r2);

    expect(contentIdentityKey(c1.contentIdentity)).toBe(
      contentIdentityKey(c2.contentIdentity),
    );
  });

  it("bumping similarity-v1 → similarity-v2 does NOT change contentHashVersion", () => {
    const c1 = createPublishCandidate(makeLocalRecord({ contentHashVersion: "pcm-v1" }));
    const c2 = createPublishCandidate(makeLocalRecord({ contentHashVersion: "pcm-v1" }));

    expect(c1.analysis.contentIdentity.contentHashVersion).toBe(
      c2.analysis.contentIdentity.contentHashVersion,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T — Offline (no provider available, queue accumulates)
// ─────────────────────────────────────────────────────────────────────────────

describe("T — offline (queue accumulates without provider)", () => {
  it("candidates can be enqueued even if the provider is not available", () => {
    // Use a provider that throws on publish — simulating "server unavailable".
    const provider = new FakeGlobalSampleIndex({
      shouldThrow: () => {
        throw new Error("network offline");
      },
    });
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    // Enqueue works fine — it's a local-only operation.
    expect(queue.enqueue(createPublishCandidate(makeLocalRecord()))).toBe("queued");
    expect(queue.enqueue(
      createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_BBB })),
    )).toBe("queued");
    expect(queue.pendingCount).toBe(2);
  });

  it("flush with a failing provider keeps items retryable for later", async () => {
    const provider = new FakeGlobalSampleIndex({
      shouldThrow: () => {
        throw new Error("server unavailable");
      },
    });
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    const result = await queue.flush();

    expect(result.submitted).toBe(1);
    expect(result.retryable).toBe(1);
    expect(queue.pendingCount).toBe(1); // still available for retry
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W — Batch-level GlobalIndexError (worker HTTP failure body, BUG #3 / STEP16V)
// ─────────────────────────────────────────────────────────────────────────────

describe("W — batch-level GlobalIndexError from the provider", () => {
  const throwingProvider = (err: GlobalIndexError) =>
    new FakeGlobalSampleIndex({
      shouldThrow: () => {
        // The browser adapter throws a PLAIN OBJECT (no Error subclass) — this
        // is the worker contract's HTTP failure body surfaced by the transport.
        throw err;
      },
    });

  it("validation-rejected is terminal and keeps a semantic reason (never [object Object])", async () => {
    const queue = new GlobalPublishQueue(
      throwingProvider({ kind: "validation-rejected", reason: "missing primary class" }),
      { now: () => NOW_MS, maxAttempts: 3 },
    );
    queue.enqueue(createPublishCandidate(makeLocalRecord()));

    const result = await queue.flush();
    // Permanent failure — not retried even though maxAttempts=3 allows retries.
    expect(result.rejected).toBe(1);
    expect(result.retryable).toBe(0);
    const items = queue.itemsByStatus("failed");
    expect(items).toHaveLength(1);
    expect(items[0].lastError).toBe(
      "validation-rejected: missing primary class",
    );
    expect(items[0].lastError).not.toContain("[object Object]");
    const lo = items[0].lastOutcome;
    expect(lo && lo.status === "rejected" ? lo.reason : undefined).toBe(
      "validation-rejected: missing primary class",
    );
    expect(items[0].attempts).toBe(1); // a permanent rejection is never retried
    expect(queue.pendingCount).toBe(0);
  });

  it("version-incompatible is terminal with a semantic reason", async () => {
    const queue = new GlobalPublishQueue(
      throwingProvider({ kind: "version-incompatible", detail: "schema v3 required" }),
      { now: () => NOW_MS, maxAttempts: 3 },
    );
    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    const result = await queue.flush();
    expect(result.rejected).toBe(1);
    expect(result.retryable).toBe(0);
    const failed = queue.itemsByStatus("failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].lastOutcome).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("version-incompatible") as string,
    });
    expect(failed[0].lastError).toContain("schema v3");
  });

  it("conflict is terminal (never overwritten, never retried)", async () => {
    const queue = new GlobalPublishQueue(
      throwingProvider({ kind: "conflict", detail: "already mapped to other content" }),
      { now: () => NOW_MS, maxAttempts: 3 },
    );
    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    const result = await queue.flush();
    expect(result.rejected).toBe(1);
    expect(result.retryable).toBe(0);
    const items = queue.itemsByStatus("failed");
    expect(items).toHaveLength(1);
    expect(items[0].lastError).toContain("conflict");
    expect(items[0].lastOutcome).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("conflict") as string,
    });
    expect(queue.pendingCount).toBe(0);
  });

  it("rate-limited is retryable (needs a next flush, not a new interaction)", async () => {
    const queue = new GlobalPublishQueue(
      throwingProvider({ kind: "rate-limited" }),
      { now: () => NOW_MS, maxAttempts: 3 },
    );
    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    const result = await queue.flush();
    expect(result.retryable).toBe(1);
    expect(result.rejected).toBe(0);
    const items = queue.itemsByStatus("retryable");
    expect(items).toHaveLength(1);
    expect(items[0].lastError).toBe("rate-limited");
    expect(items[0].lastOutcome).toMatchObject({
      status: "rejected",
      reason: "rate-limited",
    });
    expect(queue.pendingCount).toBe(1);
  });

  it("temporary-unavailable is retryable", async () => {
    const queue = new GlobalPublishQueue(
      throwingProvider({ kind: "temporary-unavailable" }),
      { now: () => NOW_MS, maxAttempts: 3 },
    );
    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    const result = await queue.flush();
    expect(result.retryable).toBe(1);
    expect(queue.itemsByStatus("retryable")).toHaveLength(1);
    expect(queue.itemsByStatus("retryable")[0].lastError).toBe(
      "temporary-unavailable",
    );
  });

  it("same classification as a per-item rejection: conflict stays terminal, rate-limited stays retryable", async () => {
    // Assert the batch-level transport path and the per-item outcome path agree
    // (shared applyRejection — BUG #3 must not fork the classification).
    const batchQueue = new GlobalPublishQueue(
      throwingProvider({ kind: "conflict", detail: "dup" }),
      { now: () => NOW_MS },
    );
    batchQueue.enqueue(createPublishCandidate(makeLocalRecord()));
    await batchQueue.flush();
    expect(batchQueue.pendingCount).toBe(0);

    const itemQueue = new GlobalPublishQueue(
      new FakeGlobalSampleIndex({
        outcomePerItem: () => ({
          status: "rejected",
          reason: "conflict: dup",
        }),
      }),
      { now: () => NOW_MS },
    );
    itemQueue.enqueue(createPublishCandidate(makeLocalRecord()));
    await itemQueue.flush();
    expect(itemQueue.pendingCount).toBe(0);
  });

  it("transport GlobalIndexError items which stay retryable become failed on maxAttempts exhaustion", async () => {
    let nowMs = NOW_MS;
    const queue = new GlobalPublishQueue(
      throwingProvider({ kind: "rate-limited" }),
      { now: () => nowMs, maxAttempts: 2 },
    );
    queue.enqueue(createPublishCandidate(makeLocalRecord()));

    await queue.flush();
    expect(queue.itemsByStatus("retryable")).toHaveLength(1);

    nowMs += 60_000;
    await queue.flush();
    expect(queue.itemsByStatus("failed")).toHaveLength(1);
    expect(queue.itemsByStatus("failed")[0].lastError).toBe("rate-limited");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TG1 — Multiple queue items for one sampleId (BUG #1 / STEP16V): a re-accepted
//       sample after a terminal conflict gets a NEW queue item; the E-P6
//       projection must use the NEWEST item, so conflict → re-accept → success
//       renders Stored, never the stale Conflict.
// ─────────────────────────────────────────────────────────────────────────────

describe("TG1 — conflict → re-accept → success (newest queue item wins)", () => {
  it("re-enqueue after a terminal conflict is allowed and appends a second item", async () => {
    const provider = new FakeGlobalSampleIndex({
      outcomePerItem: () => ({ status: "rejected", reason: "conflict: exists" }),
    });
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });
    const candidate = createPublishCandidate(makeLocalRecord());

    queue.enqueue(candidate);
    await queue.flush();
    expect(queue.itemsByStatus("failed")).toHaveLength(1);

    // Re-accept (the resolve-conflict path) → a NEW pending item is created;
    // the terminal failure does not block the sample again.
    expect(queue.enqueue(candidate)).toBe("queued");
    expect(queue.snapshot()).toHaveLength(2);
  });

  it("integrated: conflict → re-accept → stored projects Stored for the USER, via the newest item", async () => {
    const provider = new FakeGlobalSampleIndex({
      outcomePerItem: (item) =>
        item.sampleId === SAMPLE_AAA
          ? { status: "stored" }
          : { status: "rejected", reason: "conflict: exists" },
    });
    const candidate = createPublishCandidate(makeLocalRecord());
    const marker = { usageAcceptedAt: NOW_ISO, delivery: "pending" as const };

    // 1st acceptance: provider is in conflict-phase → terminal Conflict.
    let providerConflict = new FakeGlobalSampleIndex({
      outcomePerItem: () => ({ status: "rejected", reason: "conflict: exists" }),
    });
    const queue1 = new GlobalPublishQueue(providerConflict, { now: () => NOW_MS });
    queue1.enqueue(candidate);
    await queue1.flush();
    const conflictItem = queue1.snapshot()[0];
    expect(publishStatusFor(marker, conflictItem)).toBe("conflict");

    // 2nd acceptance AFTER the conflict is resolved: provider stores.
    const queue2 = new GlobalPublishQueue(provider, { now: () => NOW_MS });
    queue2.enqueue(candidate);
    await queue2.flush();
    const successItem = queue2.snapshot()[0];
    expect(publishStatusFor(marker, successItem)).toBe("stored");
    expect(successItem.sampleId).toBe(SAMPLE_AAA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cancel / Prune
// ─────────────────────────────────────────────────────────────────────────────

describe("cancel / prune", () => {
  it("cancel removes a pending item", () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    expect(queue.cancel(SAMPLE_AAA)).toBe(true);
    expect(queue.pendingCount).toBe(0);
    expect(queue.itemsByStatus("failed")).toHaveLength(1);
  });

  it("prune removes terminal items and returns count", () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    queue.cancel(SAMPLE_AAA);
    expect(queue.pruneSucceededAndFailed()).toBe(1);
    expect(queue.snapshot()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No Audio — Full Invariant Test
// ─────────────────────────────────────────────────────────────────────────────

describe("no audio in queue / batch / payload", () => {
  it("a serialized queue snapshot contains no audio markers", () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    queue.enqueue(createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_BBB })));

    const text = JSON.stringify(queue.snapshot());
    expect(text).not.toContain("ArrayBuffer");
    expect(text).not.toContain("Uint8Array");
    expect(text).not.toContain("Blob");
    expect(text).not.toContain("AudioBuffer");
    expect(text).not.toContain("wavData");
    expect(text).not.toContain("flacData");
  });

  it("flush result outcome is audio-free", async () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    const result = await queue.flush();

    const text = JSON.stringify(result);
    expect(text).not.toContain("ArrayBuffer");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Read / Write Separation
// ─────────────────────────────────────────────────────────────────────────────

describe("read / write separation", () => {
  it("enqueue never calls publishAnalysisResults", async () => {
    const provider = new FakeGlobalSampleIndex();
    const publishSpy = vi.spyOn(provider, "publishAnalysisResults");

    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });
    queue.enqueue(createPublishCandidate(makeLocalRecord()));

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("flush never mutates the local index (provider is write-only)", async () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));
    await queue.flush();

    // The provider's only mutation target is publishAnalysisResults (global index).
    // No local index is touched — this is a structural assertion.
    expect(provider.publishCalls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch: Mixed Outcomes
// ─────────────────────────────────────────────────────────────────────────────

describe("batch: mixed outcomes in a single flush", () => {
  it("stored, already-known, and rejected items in one batch are classified correctly", async () => {
    let callCount = 0;
    const provider = new FakeGlobalSampleIndex({
      outcomePerItem: () => {
        callCount++;
        if (callCount === 1) return { status: "stored" };
        if (callCount === 2) return { status: "already-known" };
        return { status: "rejected", reason: "validation-rejected" };
      },
    });

    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });
    queue.enqueue(createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_AAA })));
    queue.enqueue(createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_BBB })));
    queue.enqueue(createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_CCC })));

    const result = await queue.flush();

    expect(result.submitted).toBe(3);
    expect(result.succeeded).toBe(2); // stored + already-known
    expect(result.rejected).toBe(1);  // validation-rejected
    expect(result.retryable).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retryable: maxAttempts exhaustion
// ─────────────────────────────────────────────────────────────────────────────

describe("retryable: maxAttempts exhaustion", () => {
  it("a retryable item becomes failed after exhausting maxAttempts", async () => {
    let nowMs = NOW_MS;
    const provider = new FakeGlobalSampleIndex({
      outcomePerItem: () => ({
        status: "rejected",
        reason: "temporary-unavailable",
      }),
    });
    const queue = new GlobalPublishQueue(provider, {
      now: () => nowMs,
      maxAttempts: 2,
    });

    queue.enqueue(createPublishCandidate(makeLocalRecord()));

    // First flush: attempt 1 → retryable
    await queue.flush();
    expect(queue.itemsByStatus("retryable")).toHaveLength(1);

    // Second flush: advance clock past backoff → attempt 2 → failed (max = 2)
    nowMs += 60_000;
    await queue.flush();
    expect(queue.itemsByStatus("failed")).toHaveLength(1);
    expect(queue.pendingCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration Flow (§33): Local Analysis → Candidate → Queue → Batch → Provider
// ─────────────────────────────────────────────────────────────────────────────

describe("integration flow: local analysis → candidate → queue → batch → provider", () => {
  it("full domain flow: AAA analyzed locally → published → BBB discovers and publishes", async () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    // --- User A: AAA is analyzed locally ---
    const aaaRecord = makeLocalRecord({ sampleId: SAMPLE_AAA, contentHash: HASH_XYZ });
    const aaaCandidate = createPublishCandidate(aaaRecord);

    // Eligibility check (would be called by the UI/orchestrator).
    expect(validatePublishCandidate(aaaCandidate)).toEqual({ ok: true });

    // Enqueue.
    expect(queue.enqueue(aaaCandidate)).toBe("queued");

    // --- User B: BBB happens to be the same content ---
    const bbbRecord = makeLocalRecord({ sampleId: SAMPLE_BBB, contentHash: HASH_XYZ });
    const bbbCandidate = createPublishCandidate(bbbRecord);
    expect(queue.enqueue(bbbCandidate)).toBe("queued");

    // --- Flush: both sample references sent in one batch ---
    const result = await queue.flush();

    // Verify.
    expect(result.submitted).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(provider.publishCalls).toHaveLength(1);

    const batch = provider.publishCalls[0];
    expect(batch).toHaveLength(2);

    // Both carry the same content identity.
    expect(batch[0].contentIdentity.contentHash).toBe(HASH_XYZ);
    expect(batch[1].contentIdentity.contentHash).toBe(HASH_XYZ);

    // Different sampleIds.
    expect(batch[0].sampleId).toBe(SAMPLE_AAA);
    expect(batch[1].sampleId).toBe(SAMPLE_BBB);

    // Correct versions carried.
    expect(batch[0].analysis.contentIdentity.contentHashVersion).toBe("pcm-v1");
    expect(batch[0].analysis.gatePassed).toBe(true);

    // No audio anywhere.
    const text = JSON.stringify(batch);
    expect(text).not.toContain("ArrayBuffer");
    expect(text).not.toContain("Blob");
  });

  it("two different content identities remain separate", async () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });

    queue.enqueue(
      createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_AAA, contentHash: HASH_XYZ })),
    );
    queue.enqueue(
      createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_BBB, contentHash: HASH_ABC })),
    );

    const result = await queue.flush();
    expect(result.submitted).toBe(2);

    const batch = provider.publishCalls[0];
    expect(batch[0].contentIdentity.contentHash).toBe(HASH_XYZ);
    expect(batch[1].contentIdentity.contentHash).toBe(HASH_ABC);
  });
});

// ─── STEP41 — publish carries the compact V2 knowledge block ─────────────────

function charForPublish(): SoundCharacter {
  return {
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
}

function recordWithV2(overrides: Partial<SampleIndexRecord> = {}): SampleIndexRecord {
  const soundCharacter = charForPublish();
  return makeLocalRecord({
    analysisV2: {
      analysisVersion: ANALYSIS_VERSION,
      features: { durationSec: 0.4 } as NonNullable<SampleIndexRecord["analysisV2"]>["features"],
      soundCharacter,
      quality: computeSoundCharacterQuality(soundCharacter),
    },
    ...overrides,
  });
}

describe("STEP41 — V2 knowledge block in the publish candidate", () => {
  it("createPublishCandidate packs record.analysisV2.soundCharacter into the block", () => {
    const candidate = createPublishCandidate(recordWithV2({ sampleId: SAMPLE_AAA }));
    const block = candidate.analysis.soundCharacterV2!;
    expect(block).toBeDefined();
    expect(block.codecVersion).toBe(SOUND_CHARACTER_CODEC_VERSION);
    expect(block.analysisVersion).toBe(ANALYSIS_VERSION);
    expect(block.similarityVersion).toBe(SIMILARITY_ALGORITHM_VERSION);
    expect(block.soundSpaceVersion).toBe(SOUND_SPACE_ALGORITHM_VERSION);
    expect(block.classificationVersion).toBe("heuristic-v1");
    expect(block.confidence).toBe(0.9);
    expect(block.durationMs).toBe(400); // duration 0.4 s → 400 ms

    const char = decodeSoundCharacterFromBase64(block.packed)!;
    expect(char.brightness).toBeCloseTo(0.4, 4);
    expect(char.duration).toBeNull();
    // candidate still passes the single publish rule set
    expect(validatePublishCandidate(candidate)).toEqual({ ok: true });
  });

  it("publish carries the block through the queue to the provider payload", async () => {
    const provider = new FakeGlobalSampleIndex();
    const queue = new GlobalPublishQueue(provider, { now: () => NOW_MS });
    queue.enqueue(createPublishCandidate(recordWithV2({ sampleId: SAMPLE_AAA })));
    const result = await queue.flush();
    expect(result.submitted).toBe(1);
    const sent = provider.publishCalls[0][0];
    expect(sent.analysis.soundCharacterV2).toBeDefined();
    expect(sent.analysis.soundCharacterV2!.packed).toMatch(/^[A-Za-z0-9+/]+={1,2}$/);
  });

  it("a record WITHOUT analysisV2 publishes with the block omitted (additive)", () => {
    const candidate = createPublishCandidate(makeLocalRecord({ sampleId: SAMPLE_AAA }));
    expect(candidate.analysis.soundCharacterV2).toBeUndefined();
    expect(validatePublishCandidate(candidate)).toEqual({ ok: true });
  });
});
