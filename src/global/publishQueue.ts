/**
 * Global Publish Queue — Write Semantics (Step 16D).
 *
 * 16A/16C defined the READ side (`GlobalLookup`). 16D defines the WRITE side:
 * this module owns the publish queue that deduplicates, batches, and hands
 * locally produced analysis results to an injected `GlobalSampleIndex` via the
 * existing `publishAnalysisResults(...)` contract (16A).
 *
 * Architecture:
 *
 *   Local Analysis Result
 *         │
 *         ▼
 *   GlobalPublishCandidate          (src/global/publish.ts)
 *         │
 *         ▼
 *   GlobalPublishQueue.enqueue()    (this file)
 *         │
 *         ▼ deduplicate / pending
 *         │
 *   GlobalPublishQueue.flush()      (this file)
 *         │
 *         ▼ batch
 *         │
 *   GlobalSampleIndex.publishAnalysisResults(batch)  (provider, injected)
 *         │
 *         ▼
 *   global index
 *
 * Key semantics:
 *  - SAMPLE-LEVEL idempotency: enqueue(candidate for sampleId X) twice
 *    produces ONE queue item (duplicate rejected). Idempotency key = sampleId.
 *  - CONTENT-LEVEL dedup is handled server-side by the existing contract:
 *    `publishAnalysisResults` returns `already-known` for a content identity
 *    already present, while still registering a new sample reference. The queue
 *    sends full payloads; the server collapses content-level redundancy.
 *  - BATCHING: `flush(batchSize)` drains up to `batchSize` pending items and
 *    submits them in a single `publishAnalysisResults(batch)` call.
 *  - ERROR CLASSIFICATION: per-item `rejected` outcomes and transport errors
 *    are classified as retryable or terminal. `conflict` is always surfaced
 *    visibly, never silently overwritten.
 *  - OFFLINE FIRST: the queue can exist and accumulate items without a
 *    provider. `flush()` only works when a provider is available.
 *  - NO AUDIO: all queue items are audio-free (enforced at candidate level;
 *    `assertNoAudioBytes` on the queue write path).
 *  - READ / WRITE separation: enqueuing never triggers a read; flushing never
 *    triggers a local analysis. The local index is NEVER mutated.
 */
import type {
  GlobalSampleIndex,
  GlobalPublishResult,
  GlobalPublishOutcome,
  GlobalPublishItemOutcome,
  GlobalIndexError,
} from "./contract";
import type { GlobalPublishCandidate } from "./publish";

// ─────────────────────────────────────────────────────────────────────────────
// Queue item status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal, deterministic state machine for a queue item.
 *
 *   pending ──► in-flight ──► succeeded
 *                  │
 *                  ├──► retryable (will be re-queued up to maxAttempts)
 *                  │
 *                  └──► failed (terminal — non-retryable rejection)
 */
export type PublishQueueItemStatus =
  | "pending"
  | "in-flight"
  | "succeeded"
  | "retryable"
  | "failed";

// ─────────────────────────────────────────────────────────────────────────────
// Queue item
// ─────────────────────────────────────────────────────────────────────────────

export interface PublishQueueItem {
  /** Monotonic internal id (for ordering). */
  readonly id: string;
  /** The sample reference being published. */
  readonly sampleId: string;
  /** Content identity key (for diagnostics, not used as primary dedup key). */
  readonly contentKey: string;
  /** The full candidate payload. */
  readonly candidate: GlobalPublishCandidate;
  status: PublishQueueItemStatus;
  /** Number of attempts so far (transport errors + rejected items count). */
  attempts: number;
  /** Last error message, if any. */
  lastError?: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
  /** ISO-8601 next-retry timestamp (only when status is "retryable"). */
  nextRetryAt?: string;
  /** Per-item outcome from the last failed batch submission. */
  lastOutcome?: GlobalPublishItemOutcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue options
// ─────────────────────────────────────────────────────────────────────────────

export interface PublishQueueOptions {
  /** Maximum number of items in a single batch. Default: 50. */
  batchSize?: number;
  /** Maximum attempts before a retryable item becomes terminal. Default: 3. */
  maxAttempts?: number;
  /** Base backoff in ms for retryable items. Default: 1000. */
  backoffMs?: number;
  /** Maximum retry jitter in ms. Default: backoffMs. */
  retryJitterMs?: number;
  /**
   * Classify a rejected reason string as retryable. Defaults to treating
   * `temporary-unavailable` and `rate-limited` as retryable; everything else
   * as terminal.
   */
  isRetryableReason?: (reason: string) => boolean;
  /** Deterministic clock (ms epoch) for tests. */
  now?: () => number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flush result
// ─────────────────────────────────────────────────────────────────────────────

export interface FlushResult {
  /** Number of items that were submitted in this flush. */
  submitted: number;
  /** Number of items that succeeded (stored + already-known). */
  succeeded: number;
  /** Number of items rejected (terminal). */
  rejected: number;
  /** Number of items that are retryable. */
  retryable: number;
  /** The raw provider outcome, if a batch was submitted. */
  outcome?: GlobalPublishOutcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error types
// ─────────────────────────────────────────────────────────────────────────────

export class PublishConflictError extends Error {
  constructor(
    public readonly detail: string,
  ) {
    super(`conflict: ${detail}`);
    this.name = "PublishConflictError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default retryable-reason classifier
// ─────────────────────────────────────────────────────────────────────────────

const RETRYABLE_REASONS: readonly string[] = [
  "temporary-unavailable",
  "rate-limited",
];

function defaultIsRetryableReason(reason: string): boolean {
  const lower = reason.toLowerCase();
  return RETRYABLE_REASONS.some((r) => lower.includes(r));
}

/** `true` iff the thrown value is a `GlobalIndexError` transport object. */
function isGlobalIndexError(e: unknown): e is GlobalIndexError {
  return (
    e !== null &&
    typeof e === "object" &&
    "kind" in (e as object) &&
    typeof (e as { kind?: unknown }).kind === "string"
  );
}

/**
 * Serialize a batch-level `GlobalIndexError` into a reason string that keeps the
 * semantic kind (BUG #3 / STEP16V): the queue's retry classifier and the E-P6
 * projection both read `lastError`/`lastOutcome.reason`, so a plain
 * `String({kind,...}) === "[object Object]"` would lose the classification.
 */
function describeGlobalIndexError(e: GlobalIndexError): string {
  switch (e.kind) {
    case "not-found":
      return e.kind;
    case "validation-rejected":
      return `${e.kind}: ${e.reason}`;
    case "version-incompatible":
      return `${e.kind}: ${e.detail}`;
    case "conflict":
      return `conflict: ${e.detail}`;
    case "rate-limited":
      return e.kind;
    case "temporary-unavailable":
      return e.kind;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 1000;

/**
 * The global publish queue. An in-memory, domain-level queue that deduplicates
 * candidates, batches them, and flushes via the injected `GlobalSampleIndex`.
 *
 * This is NOT the local analysis `QueueStore` (src/persistence/queueStore.ts)
 * which tracks per-sample analysis jobs. The publish queue tracks per-sample-ref
 * publish operations — a semantically distinct concern (§28).
 *
 * Persistence is explicitly deferred to a later step (§40). The queue currently
 * operates in-memory; a future persistence layer can reconstitute it without
 * changing the domain API.
 */
export class GlobalPublishQueue {
  private readonly provider: GlobalSampleIndex;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly retryJitterMs: number;
  private readonly isRetryableReason: (reason: string) => boolean;
  private readonly nowFn: () => number;
  private nextId = 1;
  private readonly items: PublishQueueItem[] = [];

  constructor(
    provider: GlobalSampleIndex,
    opts: PublishQueueOptions = {},
  ) {
    this.provider = provider;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.retryJitterMs = opts.retryJitterMs ?? opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.isRetryableReason = opts.isRetryableReason ?? defaultIsRetryableReason;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  private isoNow(): string {
    return new Date(this.nowFn()).toISOString();
  }

  private generateId(): string {
    return String(this.nextId++);
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  /** Number of items in any non-terminal state (pending + retryable). */
  get pendingCount(): number {
    return this.items.filter(
      (i) => i.status === "pending" || i.status === "retryable",
    ).length;
  }

  /** All items (for diagnostics and tests). */
  snapshot(): readonly PublishQueueItem[] {
    return [...this.items];
  }

  /** Items in a given status. */
  itemsByStatus(status: PublishQueueItemStatus): readonly PublishQueueItem[] {
    return this.items.filter((i) => i.status === status);
  }

  // ─── Write: Enqueue ───────────────────────────────────────────────────────

  /**
   * Enqueue a publish candidate. Idempotent at the SAMPLE-LEVEL: if a
   * non-terminal item for the same `sampleId` already exists, the enqueue is
   * a no-op and returns `"duplicate"`. A `succeeded` item is also treated as a
   * duplicate (the sample reference is already globally known — re-publishing
   * the same sampleId would duplicate domain work).
   *
   * A candidate for a NEW sampleId pointing to an already-queued content
   * identity IS accepted (this is the AAA/BBB → same content case; each
   * sample reference is a separate queue item).
   */
  enqueue(candidate: GlobalPublishCandidate): "queued" | "duplicate" {
    const existing = this.items.find(
      (i) =>
        i.sampleId === candidate.sampleId &&
        i.status !== "failed",
    );
    if (existing) return "duplicate";

    const contentKey = `${candidate.contentIdentity.contentHashVersion}:${candidate.contentIdentity.contentHash}`;

    const item: PublishQueueItem = {
      id: this.generateId(),
      sampleId: candidate.sampleId,
      contentKey,
      candidate,
      status: "pending",
      attempts: 0,
      createdAt: this.isoNow(),
      updatedAt: this.isoNow(),
    };
    this.items.push(item);
    return "queued";
  }

  // ─── Write: Flush ─────────────────────────────────────────────────────────

  /**
   * Drain up to `batchSize` pending items (oldest first), submit them as a
   * single batch to the provider, and transition each item according to the
   * per-item outcome.
   *
   * Items whose `nextRetryAt` is in the future are skipped (rate-limited by
   * backoff).
   *
   * Returns `undefined` when there is nothing to flush (empty batch).
   */
  async flush(): Promise<FlushResult> {
    const now = this.nowFn();
    const due = this.items.filter((i) => {
      if (i.status === "pending") return true;
      if (i.status === "retryable" && i.nextRetryAt) {
        return new Date(i.nextRetryAt).getTime() <= now;
      }
      return false;
    });

    const batch = due.slice(0, this.batchSize);
    if (batch.length === 0) {
      return { submitted: 0, succeeded: 0, rejected: 0, retryable: 0 };
    }

    // Mark as in-flight.
    for (const item of batch) {
      item.status = "in-flight";
      item.updatedAt = this.isoNow();
    }

    // Mark in-flight on the provider side.
    const payloads: GlobalPublishResult[] = batch.map((i) => i.candidate);
    let outcome: GlobalPublishOutcome;
    try {
      outcome = await this.provider.publishAnalysisResults(payloads);
    } catch (e) {
      // Transport error. A structured `GlobalIndexError` (the worker contract's
      // HTTP failure body, thrown by the browser adapter) is classified
      // EXACTLY like a provider rejection (conflict → terminal, rate-limited /
      // temporary-unavailable → retryable, validation-rejected /
      // version-incompatible → terminal) and keeps its semantic `reason` for the
      // E-P6 projection (BUG #3 / STEP16V). An unknown/network error keeps the
      // original behavior: retryable up to maxAttempts.
      if (isGlobalIndexError(e)) {
        const reason = describeGlobalIndexError(e);
        let rejected = 0;
        let retryable = 0;
        for (const item of batch) {
          item.lastOutcome = { status: "rejected", reason };
          const next = this.applyRejection(item, reason);
          if (next === "retryable") retryable++;
          else rejected++;
        }
        return {
          submitted: batch.length,
          succeeded: 0,
          rejected,
          retryable,
        };
      }
      const msg = e instanceof Error ? e.message : String(e);
      for (const item of batch) {
        item.attempts++;
        item.lastError = msg;
        if (item.attempts >= this.maxAttempts) {
          item.status = "failed";
        } else {
          item.status = "retryable";
          item.nextRetryAt = this.scheduleRetry(item.attempts);
        }
        item.updatedAt = this.isoNow();
      }
      return {
        submitted: batch.length,
        succeeded: 0,
        rejected: 0,
        retryable: batch.length,
      };
    }

    // Process per-item outcomes.
    let succeeded = 0;
    let rejected = 0;
    let retryable = 0;

    for (let idx = 0; idx < batch.length; idx++) {
      const item = batch[idx];
      const itemOutcome = outcome.items[idx];
      item.lastOutcome = itemOutcome;
      item.updatedAt = this.isoNow();

      if (
        itemOutcome.status === "stored" ||
        itemOutcome.status === "already-known"
      ) {
        item.status = "succeeded";
        succeeded++;
      } else {
        // "rejected" — shared classification (conflict terminal / retryable /
        // non-retryable terminal), identical to the transport-error path.
        const next = this.applyRejection(item, itemOutcome.reason);
        if (next === "retryable") retryable++;
        else rejected++;
      }
    }

    return {
      submitted: batch.length,
      succeeded,
      rejected,
      retryable,
      outcome,
    };
  }

  // ─── Write: Cancel / Clear ────────────────────────────────────────────────

  /**
   * Cancel a pending or retryable item, moving it to `failed` with a message.
   * In-flight items cannot be cancelled (they are already submitted).
   */
  cancel(sampleId: string): boolean {
    const item = this.items.find(
      (i) =>
        i.sampleId === sampleId &&
        (i.status === "pending" || i.status === "retryable"),
    );
    if (!item) return false;
    item.status = "failed";
    item.lastError = "cancelled";
    item.updatedAt = this.isoNow();
    return true;
  }

  /** Remove all terminal items (succeeded + failed). */
  pruneSucceededAndFailed(): number {
    const before = this.items.length;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].status === "succeeded" || this.items[i].status === "failed") {
        this.items.splice(i, 1);
      }
    }
    return before - this.items.length;
  }

  /** Clear all items (for tests/reset). */
  clear(): void {
    this.items.length = 0;
    this.nextId = 1;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private scheduleRetry(attempts: number): string {
    const delay =
      this.backoffMs * 2 ** (attempts - 1) +
      Math.random() * this.retryJitterMs;
    return new Date(this.nowFn() + delay).toISOString();
  }

  /**
   * Apply a rejected outcome (per-item provider rejection OR a batch-level
   * transport `GlobalIndexError`) to one item. Conflict is always terminal,
   * retryable reasons back off up to `maxAttempts`, everything else is
   * terminal. Shared so provider and transport paths classify identically.
   */
  private applyRejection(
    item: PublishQueueItem,
    reason: string,
  ): "failed" | "retryable" {
    item.lastError = reason;
    item.attempts++;
    if (reason.toLowerCase().includes("conflict")) {
      item.status = "failed";
      item.updatedAt = this.isoNow();
      return "failed";
    }
    if (this.isRetryableReason(reason)) {
      if (item.attempts >= this.maxAttempts) {
        item.status = "failed";
        item.updatedAt = this.isoNow();
        return "failed";
      }
      item.status = "retryable";
      item.nextRetryAt = this.scheduleRetry(item.attempts);
      item.updatedAt = this.isoNow();
      return "retryable";
    }
    item.status = "failed";
    item.updatedAt = this.isoNow();
    return "failed";
  }
}
