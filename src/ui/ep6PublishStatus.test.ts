import { describe, expect, it } from "vitest";
import {
  publishStatusFor,
  publishStatusLabel,
  publishDeliveryLabel,
  newestPublishItem,
  type PublishStatus,
} from "./view";
import type { PublishQueueItem } from "../global/publishQueue";
import type { GlobalPublishCandidate } from "../global/publish";
import type { GlobalPublishItemOutcome } from "../global/contract";
import type { SampleIndexRecord } from "../persistence/indexStore";

/**
 * STEP16R E-P6 — publish-status projection tests.
 *
 * Validates the precedence rule (STEP16T §4): the CURRENT queue outcome wins
 * over the persisted marker; terminal states (conflict / rejected /
 * temporary-unavailable) are ONLY derived from a concrete queue outcome and
 * NEVER inferred from `delivery: "pending"` alone; a published marker is never
 * overridden by a stale pending queue item. Pure functions only — the UI never
 * mutates the queue.
 */

function item(over: Partial<PublishQueueItem>): PublishQueueItem {
  return {
    id: "1",
    sampleId: "samples/a",
    contentKey: "v1:abc",
    candidate: {} as GlobalPublishCandidate,
    status: "pending",
    attempts: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function outcome(status: GlobalPublishItemOutcome["status"], reason?: string) {
  return reason !== undefined
    ? { status, reason }
    : { status };
}

const marker = (delivery: "pending" | "published" = "pending") => ({
  usageAcceptedAt: "2026-01-01T00:00:00.000Z",
  delivery,
});

const none: SampleIndexRecord["globalPublish"] = undefined;

describe("STEP16R E-P6 : newestPublishItem (BUG #1 / STEP16V)", () => {
  it("returns undefined when the snapshot has no item for the sampleId", () => {
    const snap = [
      item({ id: "1", sampleId: "samples/a", status: "succeeded" }),
      item({ id: "2", sampleId: "samples/b", status: "failed" }),
    ];
    expect(newestPublishItem(snap, "samples/zzz")).toBeUndefined();
    expect(newestPublishItem([], "samples/a")).toBeUndefined();
  });

  it("returns the single matching item", () => {
    const snap = [
      item({ id: "1", sampleId: "samples/a", status: "succeeded" }),
      item({ id: "2", sampleId: "samples/b", status: "pending" }),
    ];
    expect(newestPublishItem(snap, "samples/b")?.id).toBe("2");
  });

  it("the NEWEST item wins when several share the sampleId (append order)", () => {
    const snap = [
      item({ id: "1", sampleId: "samples/a", status: "failed" }),
      item({ id: "2", sampleId: "samples/c", status: "retryable" }),
      item({ id: "3", sampleId: "samples/a", status: "succeeded" }),
    ];
    const newest = newestPublishItem(snap, "samples/a");
    expect(newest?.id).toBe("3");
    expect(newest?.status).toBe("succeeded");
  });

  it("TG1: conflict → re-accept → success projects Stored, never the stale Conflict", () => {
    // Older conflict item + newer succeeded item for the same sample.
    const staleConflict = item({
      id: "1",
      sampleId: "samples/a",
      status: "failed",
      lastOutcome: outcome("rejected", "conflict: already exists") as NonNullable<
        PublishQueueItem["lastOutcome"]
      >,
    });
    const newerSucceeded = item({
      id: "2",
      sampleId: "samples/a",
      status: "succeeded",
      lastOutcome: outcome("stored") as NonNullable<
        PublishQueueItem["lastOutcome"]
      >,
    });

    const newest = newestPublishItem([staleConflict, newerSucceeded], "samples/a");
    expect(publishStatusFor(marker("published"), newest)).toBe("stored");

    // Reverse order: newest is the conflict → conflict (still a concrete outcome).
    const newestConflict = newestPublishItem([newerSucceeded, staleConflict], "samples/a");
    expect(publishStatusFor(marker("published"), newestConflict)).toBe("conflict");
  });
});

describe("STEP16R E-P6 : publishStatusFor precedence", () => {
  it("none when there is no marker and no queue item", () => {
    expect(publishStatusFor(none, undefined)).toBe("none");
  });

  it("pending from a marker delivery: pending and no queue item", () => {
    expect(publishStatusFor(marker("pending"), undefined)).toBe("pending");
  });

  it("stored from a marker delivery: published and no queue item", () => {
    expect(publishStatusFor(marker("published"), undefined)).toBe("stored");
  });

  it("pending queue item without an outcome does not fabricate a terminal state", () => {
    expect(publishStatusFor(none, item({ status: "pending" }))).toBe("none");
    // An in-flight item is still "no concrete outcome yet".
    expect(publishStatusFor(none, item({ status: "in-flight" }))).toBe("none");
  });

  it("pending queue item with marker pending stays pending (never an error)", () => {
    expect(
      publishStatusFor(marker("pending"), item({ status: "pending" })),
    ).toBe("pending");
  });

  it("stored outcome → stored (even though marker says pending)", () => {
    const itm = item({
      status: "succeeded",
      lastOutcome: outcome("stored") as NonNullable<PublishQueueItem["lastOutcome"]>,
    });
    expect(publishStatusFor(marker("pending"), itm)).toBe("stored");
  });

  it("already-known outcome → known, never stored", () => {
    const itm = item({
      status: "succeeded",
      lastOutcome: outcome("already-known") as NonNullable<
        PublishQueueItem["lastOutcome"]
      >,
    });
    expect(publishStatusFor(marker("pending"), itm)).toBe("known");
  });

  it("conflict rejection → conflict, and stays terminal even with published marker", () => {
    const itm = item({
      status: "failed",
      lastOutcome: outcome("rejected", "conflict: already exists") as NonNullable<
        PublishQueueItem["lastOutcome"]
      >,
    });
    expect(publishStatusFor(marker("published"), itm)).toBe("conflict");
    expect(publishStatusFor(none, itm)).toBe("conflict");
  });

  it("rejected (validation) → rejected, terminal", () => {
    const itm = item({
      status: "failed",
      lastOutcome: outcome("rejected", "validation-rejected") as NonNullable<
        PublishQueueItem["lastOutcome"]
      >,
    });
    expect(publishStatusFor(marker("published"), itm)).toBe("rejected");
  });

  it("temporary-unavailable rejection → retryable, temporary-unavailable", () => {
    const itm = item({
      status: "retryable",
      lastOutcome: outcome("rejected", "temporary-unavailable") as NonNullable<
        PublishQueueItem["lastOutcome"]
      >,
    });
    expect(publishStatusFor(none, itm)).toBe("temporary-unavailable");
  });

  it("rate-limited rejection → retryable, temporary-unavailable", () => {
    const itm = item({
      status: "retryable",
      lastOutcome: outcome("rejected", "rate-limited") as NonNullable<
        PublishQueueItem["lastOutcome"]
      >,
    });
    expect(publishStatusFor(none, itm)).toBe("temporary-unavailable");
  });

  it("transport failure without a per-item outcome → failed → temporary-unavailable", () => {
    const itm = item({ status: "failed", lastError: "fetch failed" });
    expect(publishStatusFor(none, itm)).toBe("temporary-unavailable");
  });

  it("cancelled item is NOT a backend outcome → falls through to the marker (frozen #9)", () => {
    const itm = item({ status: "failed", lastError: "cancelled" });
    expect(publishStatusFor(none, itm)).toBe("none");
    expect(publishStatusFor(marker("pending"), itm)).toBe("pending");
    expect(publishStatusFor(marker("published"), itm)).toBe("stored");
  });

  it("published marker is never overridden by a stale pending queue item", () => {
    const itm = item({ status: "pending" });
    expect(publishStatusFor(marker("published"), itm)).toBe("stored");
  });
});

describe("STEP16R E-P6 : labels", () => {
  it("status labels match the product copy", () => {
    const expected: Record<PublishStatus, string> = {
      pending: "Pending",
      stored: "Stored",
      known: "Known",
      conflict: "Conflict",
      rejected: "Rejected",
      "temporary-unavailable": "Temporary unavailable",
      none: "None",
    };
    for (const [s, label] of Object.entries(expected)) {
      expect(publishStatusLabel(s as PublishStatus)).toBe(label);
    }
  });

  it("delivery labels distinguish offline vs live", () => {
    expect(publishDeliveryLabel("offline")).toBe(
      "Offline / waiting for live provider",
    );
    expect(publishDeliveryLabel("live")).toBe("Live worker");
  });
});