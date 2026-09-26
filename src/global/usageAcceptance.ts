/**
 * Step 16H — Usage Acceptance → Global Publish Orchestration.
 *
 * Wires a VERIFIED Machiniste transfer to the existing publish path
 * (`GlobalPublishQueue` / `createPublishCandidate`), so global publication
 * happens ONLY after a real, verified usage acceptance (STEP16G_DESIGN the
 * success boundary).
 *
 * This module is the seam 16H creates between the Machiniste transfer result
 * (acceptance evidence) and the existing 16A/16D publish pipeline. It is
 * provider-agnostic: it does NOT construct providers, `GlobalSampleIndex`, or
 * `GlobalPublishQueue` policy — those are injected so the module stays pure and
 * fully testable.
 *
 * Rules enforced here (mirrors STEP16G):
 *  - Acceptance is SAMPLE-LEVEL only (per `sampleId`). B is NOT implicitly
 *    accepted just because B shares the contentHash of an accepted A; B gets its
 *    own marker only when B is itself transferred + verified.
 *  - Transfer and publish are NOT atomic: accepted-but-publish-failed stays
 *    "pending" and is retried idempotently via the existing queue.
 *  - `stored` / `already-known` → success. `conflict` → terminal (don't
 *    overwrite). temporary/rate-limited → retryable. That classification is
 *    owned by `GlobalPublishQueue`; this module only reflects delivery state.
 *  - Offline-first: acceptance can persist and enqueue without a live provider;
 *    delivery flush runs whenever the caller supplies a provider.
 *  - The local index is NEVER mutated by a publish; the marker is the only local
 *    write, and it only carries acceptance/delivery state (Option A durability).
 */
import type { IndexStore } from "../persistence/indexStore";
import type { MachinisteSendResult, MachinisteSlotResult } from "../machiniste/machinisteService";
import type { MachinisteTestResult } from "../machiniste";
import type { GlobalPublishQueue, FlushResult } from "./publishQueue";
import { createPublishCandidate } from "./publish";

// ─────────────────────────────────────────────────────────────────────────────
// Acceptance evidence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The real, existing transfer results accepted as usage-acceptance evidence.
 * Both the multi-slot service result (`send`) and the single-sample POC
 * helper result (`poc`) are supported; no new merged type is invented — the
 * underlying result types/fields are used verbatim.
 */
export type TransferEvidence =
  | { kind: "send"; sampleId: string; result: MachinisteSendResult }
  | { kind: "poc"; result: MachinisteTestResult };

export type TransferRejectReason =
  | "transfer-not-committed"
  | "transfer-apply-failed"
  | "transfer-readback-failed"
  | "transfer-errors"
  | "slot-not-found"
  | "sample-not-resolved"
  | "sample-not-analyzed";

/**
 * Outcome of the acceptance → enqueue orchestration.
 */
export type UsageAcceptanceOutcome =
  | {
      accepted: true;
      sampleId: string;
      enqueued: "queued" | "duplicate";
      delivery: "pending";
      usageAcceptedAt: string;
    }
  | { accepted: false; sampleId: string; reason: TransferRejectReason };

// ─────────────────────────────────────────────────────────────────────────────
// Acceptance predicates (the 16G success boundary)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True iff a single slot of `SampleMapMachinisteService.send()` verifies the
 * 16G boundary: the transaction committed AND this slot applied AND read-back
 * matched AND no per-slot errors.
 */
export function isSendSlotAccepted(result: MachinisteSendResult, sampleId: string): boolean {
  if (result.committed !== true || (result.errors?.length ?? 0) > 0) {
    return false;
  }
  const slot: MachinisteSlotResult | undefined = result.slots.find(
    (s) => s.sampleName === sampleId,
  );
  if (!slot) return false;
  return slot.applied === true && slot.readBackMatches === true && slot.errors.length === 0;
}

/**
 * True iff the single-sample POC helper result verifies the 16G boundary:
 * direct reference applied AND read-back matched AND created AND no errors.
 */
export function isPocAccepted(result: MachinisteTestResult): boolean {
  return (
    result.directReferenceApplied === true &&
    result.readBackMatches === true &&
    result.created === true &&
    (result.errors?.length ?? 0) === 0
  );
}

/**
 * Normalize arbitrary transfer evidence into a single verdict.
 */
export function isUsageAccepted(evidence: TransferEvidence): boolean {
  if (evidence.kind === "send") {
    return isSendSlotAccepted(evidence.result, evidence.sampleId);
  }
  return isPocAccepted(evidence.result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────────

export interface UsageAcceptanceDeps {
  index: IndexStore;
  queue: GlobalPublishQueue;
  /** Deterministic clock (ISO string) for tests; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * Given verified transfer evidence, load the analyzed local record, persist the
 * Option-A acceptance marker, and enqueue the publish candidate (idempotent via
 * the queue). Returns a structured outcome; on failure it never enqueues.
 *
 * This is the 16H wiring point: "publish ONLY after a verified transfer".
 */
export async function acceptUsageAndEnqueue(
  deps: UsageAcceptanceDeps,
  evidence: TransferEvidence,
): Promise<UsageAcceptanceOutcome> {
  const sampleId = evidence.kind === "send" ? evidence.sampleId : evidence.result.sample.name;
  const acceptedAt = deps.now ? deps.now() : new Date().toISOString();

  if (!isUsageAccepted(evidence)) {
    const reason = rejectReason(evidence);
    return { accepted: false, sampleId, reason };
  }

  const record = await deps.index.get(sampleId);
  if (!record) {
    return { accepted: false, sampleId, reason: "sample-not-resolved" };
  }
  if (record.status !== "analyzed") {
    return { accepted: false, sampleId, reason: "sample-not-analyzed" };
  }

  const candidate = createPublishCandidate(record);
  const enqueued = deps.queue.enqueue(candidate);

  await deps.index.put({
    ...record,
    globalPublish: { usageAcceptedAt: acceptedAt, delivery: "pending" },
  });

  return { accepted: true, sampleId, enqueued, delivery: "pending", usageAcceptedAt: acceptedAt };
}

function rejectReason(evidence: TransferEvidence): TransferRejectReason {
  if (evidence.kind === "send") {
    const r = evidence.result;
    if (r.committed !== true) return "transfer-not-committed";
    const slot = r.slots.find((s) => s.sampleName === evidence.sampleId);
    if (!slot) return "slot-not-found";
    if (slot.applied !== true) return "transfer-apply-failed";
    if (slot.errors.length > 0 || (r.errors?.length ?? 0) > 0) return "transfer-errors";
    if (slot.readBackMatches !== true) return "transfer-readback-failed";
    return "transfer-errors";
  }
  const r = evidence.result;
  if (r.created !== true || r.directReferenceApplied !== true) return "transfer-apply-failed";
  if (r.errors?.length > 0) return "transfer-errors";
  if (r.readBackMatches !== true) return "transfer-readback-failed";
  return "transfer-errors";
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery helpers (Option A durability + offline-first restart)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * After a successful flush, mark the accepted samples as locally "published"
 * (best-effort local flag; the GlobalSampleIndex remains authoritative).
 */
export async function markDelivered(
  index: IndexStore,
  sampleIds: readonly string[],
  when?: string,
): Promise<number> {
  const stamp = when ?? new Date().toISOString();
  let marked = 0;
  for (const sampleId of sampleIds) {
    const record = await index.get(sampleId);
    if (!record) continue;
    if (record.status !== "analyzed") continue;
    const prev: string | undefined = record.globalPublish?.usageAcceptedAt;
    await index.put({
      ...record,
      globalPublish: { usageAcceptedAt: prev ?? stamp, delivery: "published" },
    });
    marked++;
  }
  return marked;
}

/**
 * Drain the queue via its provider and reflect delivery state on the local
 * markers for every item that the provider accepted.
 *
 * Returns a combined result: the queue's flush result plus how many local
 * markers were upgraded to "published".
 */
export async function flushPendingPublications(
  deps: { index: IndexStore; queue: GlobalPublishQueue },
  when?: string,
): Promise<{ flush: FlushResult; markedPublished: number }> {
  const flush = await deps.queue.flush();
  const succeeded = deps.queue.itemsByStatus("succeeded").map((i) => i.sampleId);
  const markedPublished = await markDelivered(deps.index, succeeded, when);
  return { flush, markedPublished };
}

/**
 * Restart reconstruction (offline-first, idempotent): scan all local records,
 * re-enqueue publish candidates for those already usage-accepted but not yet
 * locally marked "published", WITHOUT re-analyzing audio and WITHOUT a live
 * provider. The queue's sampleId-level dedup makes repeats safe.
 *
 * Returns the number of records that were pending and (re)enqueued.
 */
export async function reconstructPending(
  deps: { index: IndexStore; queue: GlobalPublishQueue },
): Promise<number> {
  const records = await deps.index.getAll();
  let enqueued = 0;
  for (const record of records) {
    if (record.status !== "analyzed") continue;
    if (!record.globalPublish) continue;
    if (record.globalPublish.delivery === "published") continue;
    const candidate = createPublishCandidate(record);
    deps.queue.enqueue(candidate);
    enqueued++;
  }
  return enqueued;
}
