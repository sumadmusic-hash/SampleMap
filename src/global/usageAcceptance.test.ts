import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import type { SampleIndexRecord } from "../persistence/indexStore";
import { openDatabase } from "../persistence/db";
import type {
  GlobalSampleIndex,
  GlobalPublishResult,
  GlobalPublishOutcome,
  GlobalPublishItemOutcome,
} from "./contract";
import { mapVersion } from "../map/mapPosition";
import { computeSimilarityFingerprint } from "../similarity/similarityFingerprint";
import { makeFeatures } from "../classify/test-helpers";
import { GlobalPublishQueue } from "./publishQueue";
import {
  acceptUsageAndEnqueue,
  flushPendingPublications,
  reconstructPending,
  markDelivered,
  isSendSlotAccepted,
  isPocAccepted,
  isUsageAccepted,
} from "./usageAcceptance";
import type { TransferEvidence } from "./usageAcceptance";

// ─────────────────────────────────────────────────────────────────────────────
// Step 16H — Usage Acceptance → Global Publish Orchestration
//
// Tests cover the 16G success boundary against the REAL existing result types:
//   A  verified transfer → accepted + enqueued
//   B  failed transfer (not committed) → NOT accepted
//   C  read-back failure → NOT accepted
//   D  publish failure → retained as pending (marker), no crash
//   E  restart → reconstructPending re-enqueues idempotently (Offline-first)
//   F  idempotency (same verified transfer twice) → no duplicate queue item
//   G  already-known (provider) → marked published (success)
//   H  conflict → terminal, local marker NOT overwritten to published
//   I  same contentHash, B not transferred → B NOT implicitly accepted
//   J  no-audio invariants preserved end-to-end
// Plus the plural path exercises `send()` slot-level acceptance.
// No backend, no network, no audio.
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_AAA = "samples/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SAMPLE_BBB = "samples/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const HASH_XYZ = "f".repeat(64);
const NOW_ISO = "2026-03-01T00:00:00.000Z";

let dbCounter = 0;
async function newDbHandle() {
  dbCounter += 1;
  return openDatabase(`usage-acceptance-${process.pid}-${dbCounter}-${Date.now()}`);
}

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
    analysisBuild: "build-16h-test",
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
// Fake provider
// ─────────────────────────────────────────────────────────────────────────────

class FakeGlobalSampleIndex implements GlobalSampleIndex {
  public publishCalls: GlobalPublishResult[][] = [];
  private readonly outcomePerItem: (item: GlobalPublishResult) => GlobalPublishItemOutcome;
  constructor(
    outcomePerItem: (item: GlobalPublishResult) => GlobalPublishItemOutcome = () => ({
      status: "stored",
    }),
  ) {
    this.outcomePerItem = outcomePerItem;
  }
  async lookupSamples() { return []; }
  async lookupContentIdentities() { return []; }
  async queryMapViewport() { return { mapVersion, points: [] }; }
  async publishAnalysisResults(batch: GlobalPublishResult[]): Promise<GlobalPublishOutcome> {
    this.publishCalls.push([...batch]);
    const items = batch.map((item) => this.outcomePerItem(item));
    const accepted = items.every(
      (i) => i.status === "stored" || i.status === "already-known",
    );
    return { items, accepted };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence helpers — using the REAL result shapes
// ─────────────────────────────────────────────────────────────────────────────

function pocEvidence(
  overrides: Partial<{
    directReferenceApplied: boolean;
    readBackMatches: boolean;
    created: boolean;
    errors: string[];
  }> = {},
): Extract<TransferEvidence, { kind: "poc" }> {
  return {
    kind: "poc",
    result: {
      sample: { name: SAMPLE_AAA, displayName: "AAA", durationSeconds: 1 } as never,
      sampleEntityId: "sample-1",
      machinisteId: "mach-1",
      channelSampleEntityId: "sample-1",
      directReferenceApplied: true,
      readBackMatches: true,
      created: true,
      errors: [],
      ...overrides,
    },
  };
}

function sendEvidence(
  sampleId: string,
  slotOverrides: Partial<{
    applied: boolean;
    readBackMatches: boolean;
    errors: string[];
  }> = {},
  resultOverrides: Partial<{ committed: boolean; errors: string[] }> = {},
): TransferEvidence {
  const slot = {
    slot: 0,
    sampleName: sampleId,
    applied: true,
    readBackMatches: true,
    sampleEntityId: "sample-1",
    errors: [],
    ...slotOverrides,
  };
  return {
    kind: "send",
    sampleId,
    result: {
      machinisteId: "mach-1",
      committed: true,
      slots: [slot],
      errors: [],
      ...resultOverrides,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A — Verified transfer → accepted + enqueued
// ─────────────────────────────────────────────────────────────────────────────

describe("A — verified transfer → accepted + publish enqueued", () => {
  it("poc: direct reference + read-back + created + no errors → accepted and queued", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord());
      const queue = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      const outcome = await acceptUsageAndEnqueue(
        { index: db.index, queue, now: () => NOW_ISO },
        pocEvidence(),
      );
      expect(outcome.accepted).toBe(true);
      if (outcome.accepted) {
        expect(outcome.enqueued).toBe("queued");
        expect(outcome.delivery).toBe("pending");
        expect(outcome.usageAcceptedAt).toBe(NOW_ISO);
      }
      expect(queue.pendingCount).toBe(1);
      const record = await db.index.get(SAMPLE_AAA);
      expect(record?.globalPublish).toEqual({
        usageAcceptedAt: NOW_ISO,
        delivery: "pending",
      });
    } finally {
      await db.db.close();
    }
  });

  it("send: committed + slot applied + read-back + no errors → accepted", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord());
      const queue = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      const outcome = await acceptUsageAndEnqueue(
        { index: db.index, queue, now: () => NOW_ISO },
        sendEvidence(SAMPLE_AAA),
      );
      expect(outcome.accepted).toBe(true);
      expect(queue.pendingCount).toBe(1);
    } finally {
      await db.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — Failed transfer (not committed) → NOT accepted
// ─────────────────────────────────────────────────────────────────────────────

describe("B — failed transfer → NOT accepted / never enqueued", () => {
  it("send: committed=false → not accepted, nothing queued, no marker", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord());
      const queue = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      const outcome = await acceptUsageAndEnqueue(
        { index: db.index, queue, now: () => NOW_ISO },
        sendEvidence(SAMPLE_AAA, {}, { committed: false }),
      );
      if (outcome.accepted) throw new Error("should not be accepted");
      expect(outcome.reason).toBe("transfer-not-committed");
      expect(queue.pendingCount).toBe(0);
      expect((await db.index.get(SAMPLE_AAA))?.globalPublish).toBeUndefined();
    } finally {
      await db.db.close();
    }
  });

  it("poc: directReferenceApplied=false → not accepted (apply failed)", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord());
      const queue = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      const outcome = await acceptUsageAndEnqueue(
        { index: db.index, queue, now: () => NOW_ISO },
        pocEvidence({ directReferenceApplied: false }),
      );
      if (outcome.accepted) throw new Error("should not be accepted");
      expect(outcome.reason).toBe("transfer-apply-failed");
      expect(queue.pendingCount).toBe(0);
    } finally {
      await db.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Read-back failure → NOT accepted
// ─────────────────────────────────────────────────────────────────────────────

describe("C — read-back failure → NOT accepted", () => {
  it("poc: readBackMatches=false (but applied) → not accepted", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord());
      const queue = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      const outcome = await acceptUsageAndEnqueue(
        { index: db.index, queue, now: () => NOW_ISO },
        pocEvidence({ readBackMatches: false }),
      );
      if (outcome.accepted) throw new Error("should not be accepted");
      expect(outcome.reason).toBe("transfer-readback-failed");
      expect(queue.pendingCount).toBe(0);
    } finally {
      await db.db.close();
    }
  });

  it("send: slot readBackMatches=false → not accepted", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord());
      const queue = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      const outcome = await acceptUsageAndEnqueue(
        { index: db.index, queue, now: () => NOW_ISO },
        sendEvidence(SAMPLE_AAA, { readBackMatches: false }),
      );
      if (outcome.accepted) throw new Error("should not be accepted");
      expect(outcome.reason).toBe("transfer-readback-failed");
      expect(queue.pendingCount).toBe(0);
    } finally {
      await db.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D — Publish failure → retained as pending (marker), no crash
// ─────────────────────────────────────────────────────────────────────────────

describe("D — publish failure → retained pending, retryable via queue", () => {
  it("provider unavailable → flush leaves item pending/retryable, marker stays pending", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord());
      const provider = new FakeGlobalSampleIndex(() => ({
        status: "rejected",
        reason: "temporary-unavailable",
      }));
      const queue = new GlobalPublishQueue(provider);
      const outcome = await acceptUsageAndEnqueue(
        { index: db.index, queue, now: () => NOW_ISO },
        pocEvidence(),
      );
      expect(outcome.accepted).toBe(true);

      const result = await flushPendingPublications({ index: db.index, queue }, NOW_ISO);
      expect(result.flush.retryable).toBe(1);
      expect(result.flush.succeeded).toBe(0);
      // Marker remains "pending" (not published) — retained for retry.
      expect((await db.index.get(SAMPLE_AAA))?.globalPublish?.delivery).toBe("pending");
      expect(queue.pendingCount).toBe(1);
    } finally {
      await db.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E — Restart reconstruction (persisted marker, idempotent, offline-first)
// ─────────────────────────────────────────────────────────────────────────────

describe("E — restart reconstruction (Option A persistence)", () => {
  it("reopening the DB preserves the marker and reconstructPending re-enqueues without a provider", async () => {
    const name = `usage-acceptance-restart-${process.pid}-${Date.now()}`;
    // First "session": put an accepted-pending record.
    const db1 = await openDatabase(name);
    await db1.index.put({
      ...makeLocalRecord(),
      globalPublish: { usageAcceptedAt: NOW_ISO, delivery: "pending" },
    });
    await db1.db.close();

    // Second "session": a fresh in-memory queue + reopened DB (same name).
    const db2 = await openDatabase(name);
    try {
      const queue = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      const enqueued = await reconstructPending({ index: db2.index, queue });
      expect(enqueued).toBe(1);
      expect(queue.pendingCount).toBe(1);
      expect(queue.snapshot()[0].sampleId).toBe(SAMPLE_AAA);
    } finally {
      await db2.db.close();
    }
  });

  it("records already marked published are NOT re-enqueued on restart", async () => {
    const name = `usage-acceptance-published-${process.pid}-${Date.now()}`;
    const db1 = await openDatabase(name);
    await db1.index.put({
      ...makeLocalRecord(),
      globalPublish: { usageAcceptedAt: NOW_ISO, delivery: "published" },
    });
    await db1.db.close();

    const db2 = await openDatabase(name);
    try {
      const queue = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      const enqueued = await reconstructPending({ index: db2.index, queue });
      expect(enqueued).toBe(0);
      expect(queue.pendingCount).toBe(0);
    } finally {
      await db2.db.close();
    }
  });

  it("records without any marker are not considered pending", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord());
      const queue = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      const enqueued = await reconstructPending({ index: db.index, queue });
      expect(enqueued).toBe(0);
      expect(queue.pendingCount).toBe(0);
    } finally {
      await db.db.close();
    }
  });

  it("TG2/STEP16V Fall C: a terminal Conflict is IN-MEMORY ONLY — after restart it re-pends, never a stale conflict", async () => {
    const name = `usage-acceptance-restart-conflict-${process.pid}-${Date.now()}`;
    // Session 1: the sample is accepted and the provider conflicts → the queue
    // item turns terminal `failed`, but only `pending|published` (the marker) is
    // persisted; the terminal item lives in memory only.
    const db1 = await openDatabase(name);
    await db1.index.put(makeLocalRecord());
    const conflictQueue = new GlobalPublishQueue(
      new FakeGlobalSampleIndex(() => ({
        status: "rejected",
        reason: "conflict: already exists",
      })),
    );
    const accepted1 = await acceptUsageAndEnqueue(
      { index: db1.index, queue: conflictQueue, now: () => NOW_ISO },
      pocEvidence(),
    );
    expect(accepted1.accepted).toBe(true);
    await flushPendingPublications({ index: db1.index, queue: conflictQueue }, NOW_ISO);
    expect(conflictQueue.itemsByStatus("failed")).toHaveLength(1);
    expect(conflictQueue.itemsByStatus("failed")[0].lastError).toContain("conflict");
    await db1.db.close();

    // Session 2: fresh queue (the terminal conflict item is gone) + the same
    // persisted marker → reconstructPending re-pends; the stale conflict never
    // resurrects into a terminal state on restart.
    const db2 = await openDatabase(name);
    try {
      const live = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      const enqueued = await reconstructPending({ index: db2.index, queue: live });
      expect(enqueued).toBe(1);
      const r2 = await db2.index.get(SAMPLE_AAA);
      const item = live.snapshot()[0];
      expect(item?.status).toBe("pending");
      expect(item?.lastError).toBeUndefined();
      expect(item?.lastOutcome).toBeUndefined();
      expect(r2?.globalPublish?.delivery).toBe("pending");
    } finally {
      await db2.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F — Idempotency (same verified transfer twice → one queue item)
// ─────────────────────────────────────────────────────────────────────────────

describe("F — idempotency of repeated verified acceptance", () => {
  it("accepting the same verified transfer twice yields one queue item", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord());
      const queue = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      const deps = { index: db.index, queue, now: () => NOW_ISO };
      const evidence = pocEvidence();

      const first = await acceptUsageAndEnqueue(deps, evidence);
      const second = await acceptUsageAndEnqueue(deps, evidence);

      expect(first.accepted).toBe(true);
      expect(second.accepted).toBe(true);
      expect(queue.pendingCount).toBe(1); // dedup at queue level
      expect(queue.snapshot()).toHaveLength(1);
    } finally {
      await db.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G — already-known is success → marked published
// ─────────────────────────────────────────────────────────────────────────────

describe("G — already-known counts as success → published", () => {
  it("provider returns already-known → flush succeeds and marker becomes published", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord());
      const queue = new GlobalPublishQueue(
        new FakeGlobalSampleIndex(() => ({ status: "already-known" })),
      );
      await acceptUsageAndEnqueue({ index: db.index, queue, now: () => NOW_ISO }, pocEvidence());
      const result = await flushPendingPublications({ index: db.index, queue }, NOW_ISO);
      expect(result.flush.succeeded).toBe(1);
      expect(result.markedPublished).toBe(1);
      expect((await db.index.get(SAMPLE_AAA))?.globalPublish?.delivery).toBe("published");
      expect(queue.pendingCount).toBe(0);
    } finally {
      await db.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H — conflict → terminal, local marker NOT overwritten to published
// ─────────────────────────────────────────────────────────────────────────────

describe("H — conflict is terminal; marker stays pending", () => {
  it("provider returns conflict → rejected, marker never overwritten to published", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord());
      const queue = new GlobalPublishQueue(
        new FakeGlobalSampleIndex(() => ({
          status: "rejected",
          reason: "conflict: sample mapped to different content",
        })),
      );
      await acceptUsageAndEnqueue({ index: db.index, queue, now: () => NOW_ISO }, pocEvidence());
      const result = await flushPendingPublications({ index: db.index, queue }, NOW_ISO);
      expect(result.flush.rejected).toBe(1);
      expect(result.flush.succeeded).toBe(0);
      expect(result.markedPublished).toBe(0);
      expect((await db.index.get(SAMPLE_AAA))?.globalPublish?.delivery).toBe("pending");
      expect(queue.itemsByStatus("failed")).toHaveLength(1);
    } finally {
      await db.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I — same contentHash, B not transferred → B NOT implicitly accepted
// ─────────────────────────────────────────────────────────────────────────────

describe("I — acceptance is sampleId-level, not content-level", () => {
  it("A accepted+published; B shares contentHash but B has no marker and is not enqueued", async () => {
    const db = await newDbHandle();
    try {
      // AAA accepted; BBB shares the SAME contentHash (same canonical content).
      await db.index.put(makeLocalRecord({ sampleId: SAMPLE_AAA }));
      await db.index.put(makeLocalRecord({ sampleId: SAMPLE_BBB }));

      const queue = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      const deps = { index: db.index, queue, now: () => NOW_ISO };

      // Only AAA is transferred + verified.
      const aOutcome = await acceptUsageAndEnqueue(
        deps,
        sendEvidence(SAMPLE_AAA),
      );
      expect(aOutcome.accepted).toBe(true);

      // BBB was never transferred → no acceptance, no marker, not enqueued.
      const bRecord = await db.index.get(SAMPLE_BBB);
      expect(bRecord?.globalPublish).toBeUndefined();
      expect(queue.pendingCount).toBe(1); // only AAA
      expect(queue.snapshot()[0].sampleId).toBe(SAMPLE_AAA);
    } finally {
      await db.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J — no-audio invariants preserved end-to-end
// ─────────────────────────────────────────────────────────────────────────────

describe("J — no-audio invariants preserved", () => {
  it("indexStore rejects a record carrying an embedded audio buffer even with globalPublish", () => {
    const record = makeLocalRecord();
    (record as unknown as Record<string, unknown>).audioBuffer = new ArrayBuffer(16);
    record.globalPublish = { usageAcceptedAt: NOW_ISO, delivery: "pending" };
    const dbPromise = newDbHandle();
    return dbPromise.then(async (db) => {
      try {
        await expect(db.index.put(record)).rejects.toThrow(/prohibited/);
      } finally {
        await db.db.close();
      }
    });
  });

  it("serialized queue snapshot from accepted evidence is audio-free", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord());
      const queue = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      await acceptUsageAndEnqueue({ index: db.index, queue, now: () => NOW_ISO }, pocEvidence());
      const text = JSON.stringify(queue.snapshot());
      expect(text).not.toContain("ArrayBuffer");
      expect(text).not.toContain("Uint8Array");
      expect(text).not.toContain("Blob");
      expect(text).not.toContain("AudioBuffer");
      // Marker is metadata-only.
      const recordText = JSON.stringify(await db.index.get(SAMPLE_AAA));
      expect(recordText).not.toContain("ArrayBuffer");
    } finally {
      await db.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Predicates (unit-level, direct real types)
// ─────────────────────────────────────────────────────────────────────────────

describe("acceptance predicates", () => {
  it("isPocAccepted matches the 16G single-sample boundary", () => {
    expect(isPocAccepted(pocEvidence().result)).toBe(true);
    expect(isPocAccepted(pocEvidence({ created: false }).result)).toBe(false);
    expect(isPocAccepted(pocEvidence({ errors: ["x"] }).result)).toBe(false);
    expect(isPocAccepted(pocEvidence({ readBackMatches: false }).result)).toBe(false);
  });

  it("isSendSlotAccepted matches the 16G plural boundary", () => {
    expect(isSendSlotAccepted(sendEvidence(SAMPLE_AAA).result as never, SAMPLE_AAA)).toBe(true);
    expect(
      isSendSlotAccepted(
        sendEvidence(SAMPLE_AAA, { applied: false }).result as never,
        SAMPLE_AAA,
      ),
    ).toBe(false);
    expect(
      isSendSlotAccepted(
        sendEvidence(SAMPLE_AAA, {}, { committed: false }).result as never,
        SAMPLE_AAA,
      ),
    ).toBe(false);
  });

  it("isUsageAccepted dispatches on evidence kind", () => {
    expect(isUsageAccepted(pocEvidence())).toBe(true);
    expect(isUsageAccepted(pocEvidence({ readBackMatches: false }))).toBe(false);
    expect(isUsageAccepted(sendEvidence(SAMPLE_AAA))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plural path via real sample-name routing through send evidence
// ─────────────────────────────────────────────────────────────────────────────

describe("plural send evidence routes acceptance per sampleName", () => {
  it("a slot for BBB in a multi-slot result is not misattributed to AAA", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord({ sampleId: SAMPLE_AAA }));
      const result = {
        machinisteId: "mach-1",
        committed: true,
        slots: [
          { slot: 0, sampleName: SAMPLE_AAA, applied: true, readBackMatches: true, sampleEntityId: "e1", errors: [] },
          { slot: 1, sampleName: SAMPLE_BBB, applied: true, readBackMatches: false, sampleEntityId: "e2", errors: [] },
        ],
        errors: [],
      };
      const queue = new GlobalPublishQueue(new FakeGlobalSampleIndex());
      // AAA slot is clean and verified.
      const outcome = await acceptUsageAndEnqueue(
        { index: db.index, queue, now: () => NOW_ISO },
        { kind: "send", sampleId: SAMPLE_AAA, result } as never,
      );
      expect(outcome.accepted).toBe(true);
      expect(queue.pendingCount).toBe(1);
      expect(queue.snapshot()[0].sampleId).toBe(SAMPLE_AAA);
      // BBB (read-back failed) is not enqueued/enqueued because it was never accepted.
    } finally {
      await db.db.close();
    }
  });
});

// markDelivered direct coverage
describe("markDelivered", () => {
  it("upgrades an accepted-pending marker to published without changing acceptance", async () => {
    const db = await newDbHandle();
    try {
      await db.index.put(makeLocalRecord({ globalPublish: { usageAcceptedAt: NOW_ISO, delivery: "pending" } }));
      const count = await markDelivered(db.index, [SAMPLE_AAA], "2026-03-02T00:00:00.000Z");
      expect(count).toBe(1);
      const record = await db.index.get(SAMPLE_AAA);
      expect(record?.globalPublish?.delivery).toBe("published");
      expect(record?.globalPublish?.usageAcceptedAt).toBe(NOW_ISO);
    } finally {
      await db.db.close();
    }
  });
});
