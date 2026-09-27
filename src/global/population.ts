/**
 * Step 70 — Automatic Global Population: analysis → publish queue.
 *
 * The entire publish path existed (16A contract → 16D candidate + queue → 16H
 * orchestration → 16F worker), but NOTHING fed it from the analysis pipeline:
 * a publication only ever entered the queue through a verified Machiniste
 * transfer (`acceptUsageAndEnqueue`), so a library that is merely analyzed
 * never reached the global index. This module is the missing connection —
 * and deliberately contains NO new policy:
 *
 *   - Eligibility: `createPublishCandidate` (16D) is the single gate. Only
 *     `status === "analyzed"` records with a valid content identity, a
 *     persisted V2 `mapPosition` and a fully validated analysis produce a
 *     candidate; anything else is skipped (it recorded WHY via the thrown
 *     `PublishCandidateError`, which the caller may count but never chokes
 *     on).
 *   - No audio: the candidate path reuses `assertNoAudioBytes`; population
 *     reads persisted records only — it never fetches, decodes or analyzes
 *     audio "for publish".
 *   - Dedup: sampleId-level dedup is owned by `GlobalPublishQueue.enqueue`;
 *     content-identity dedup (representative selection) stays server-side via
 *     `already-known` (16A). A record already marked `delivery: "published"`
 *     is never re-enqueued.
 *   - Offline-first: population is pure enqueue + local marker persistence;
 *     it needs no provider and never blocks the analysis run (the caller is
 *     expected to fire it AFTER a completed run / at startup, not in the
 *     per-job hot path; §2 "the existing analysis must not get slower").
 *
 * Marker durability (16H Option A, unchanged shape): a successfully enqueued
 * record that had NO `globalPublish` marker yet gets
 * `{ usageAcceptedAt: <now>, delivery: "pending" }` persisted. With automatic
 * population the marker means "this record entered the publish pipeline"
 * (see the updated field comment in `indexStore.ts`); records that entered
 * through a verified usage keep their original acceptance timestamp — the
 * marker is never overwritten once set. The marker is what makes
 * `reconstructPending` / EP6 status / restart-retry work, so it is REQUIRED
 * here for offline-first correctness.
 */
import type { IndexStore } from "../persistence/indexStore";
import { PublishCandidateError, createPublishCandidate } from "./publish";
import type { GlobalPublishQueue } from "./publishQueue";

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

export interface PopulatePublishQueueResult {
  /** Number of local records scanned. */
  scanned: number;
  /** Candidates newly added to the queue. */
  enqueued: number;
  /** Candidates the queue already tracked (sampleId-level dedup). */
  duplicates: number;
  /** Records without `status === "analyzed"`. */
  skippedNotAnalyzed: number;
  /** Analyzed records that failed publish eligibility / no-audio checks. */
  skippedIneligible: number;
  /** Analyzed records already locally marked `delivery: "published"`. */
  alreadyPublished: number;
  /** Analyzed+eligible records that had NO marker and got `delivery: "pending"`. */
  markedPending: number;
}

export interface PopulatePublishQueueDeps {
  index: IndexStore;
  queue: GlobalPublishQueue;
  /** Deterministic clock (ISO string) for tests. */
  now?: () => string;
}

/**
 * Enqueue every analyzed, publish-eligible local record into the existing
 * publish queue and persist the pending marker for records that had none.
 *
 * Idempotent: queue dedup (sampleId) + the published-marker skip make repeated
 * runs safe. NEVER throws on ineligible records — they are counted and moved
 * past, so a single bad record cannot strand the rest of the library.
 */
export async function populatePublishQueue(
  deps: PopulatePublishQueueDeps,
): Promise<PopulatePublishQueueResult> {
  const now = () => (deps.now ? deps.now() : new Date().toISOString());
  const records = await deps.index.getAll();

  const result: PopulatePublishQueueResult = {
    scanned: records.length,
    enqueued: 0,
    duplicates: 0,
    skippedNotAnalyzed: 0,
    skippedIneligible: 0,
    alreadyPublished: 0,
    markedPending: 0,
  };

  for (const record of records) {
    if (record.status !== "analyzed") {
      result.skippedNotAnalyzed++;
      continue;
    }
    // Already delivered: the local marker is best-effort, but re-sending a
    // record the server already stored would only ever come back
    // `already-known` — skip the noise (the server remains authoritative and
    // still dedups content-level on any slip-through).
    if (record.globalPublish?.delivery === "published") {
      result.alreadyPublished++;
      continue;
    }

    let candidate;
    try {
      candidate = createPublishCandidate(record);
    } catch (e) {
      // PublishCandidateError (eligibility) and assertNoAudioBytes violations
      // both mean "not publishable" — skip, never block the library.
      if (e instanceof PublishCandidateError || e instanceof Error) {
        result.skippedIneligible++;
        continue;
      }
      throw e;
    }

    const outcome = deps.queue.enqueue(candidate);
    if (outcome === "queued") result.enqueued++;
    else result.duplicates++;

    // Persist the delivery-pending marker exactly once (Option A durability):
    // an existing marker (from a verified usage acceptance or an earlier
    // population run) keeps its original timestamp.
    if (record.globalPublish === undefined) {
      await deps.index.put({
        ...record,
        globalPublish: { usageAcceptedAt: now(), delivery: "pending" },
      });
      result.markedPending++;
    }
  }

  return result;
}
