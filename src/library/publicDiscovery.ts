/**
 * STEP80 — Incremental public Audiotool sample DISCOVERY.
 *
 * PURPOSE
 *   Complement the existing background indexing with a bounded, paginated walk
 *   over the PUBLIC Audiotool Sample Library (`samples.list`), so publicly
 *   available samples that are not part of the user's own library feed enter
 *   the EXISTING pipeline:
 *
 *     public discovery (this file)
 *       → existing QueueStore.enqueue        (idempotent analysis jobs)
 *       → existing JobRunner / AnalysisPipeline
 *       → existing IndexStore records
 *       → existing GlobalPublishQueue        (via publishPublicAnalyses below)
 *       → existing D1 global index
 *
 *   This is deliberately NOT a second pipeline: it never fetches audio, never
 *   decodes, never analyzes and never publishes payloads itself. It only turns
 *   listing pages into queue entries + candidate enqueues through the existing
 *   abstractions.
 *
 * BOUNDARIES
 *  - NO POPULARITY LOGIC (yet): `numFavorites`/`numUsages` are NEVER used as a
 *    filter or ranking signal here — relevance signals belong to the STEP38
 *    analysis-eligibility gate for the OWN scan only. Discovery ranks nothing;
 *    ranking/popularity selection is a later, separate decision.
 *  - The existing STEP38 eligibility rules are NOT changed and NOT reused for
 *    public discovery: foreign zero-signal samples must stay ineligible for the
 *    OWN auto-enqueue path while remaining discoverable + publishable here.
 *  - NO AUDIO PERSISTENCE: every write goes through stores that already enforce
 *    `assertNoAudioBytes`; this module itself holds metadata only, transiently.
 *  - BOUNDED: hard page budget + hard sample budget per round (see constants).
 *    Never unbounded pagination, never the full library per startup.
 *  - INCREMENTAL: deduplication is driven by persisted state (index records +
 *    job rows + the publish marker), so repeated rounds enqueue nothing twice
 *    and re-analyze nothing. The resumable `nextPageToken` cursor lives in a
 *    dedicated meta store (discovery state ONLY — no sample data, no audio).
 */
import type { SampleMeta } from "@audiotool/nexus/api";
import type { ElasticDB } from "../persistence/elasticdb";
import { STORES } from "../persistence/db";
import type { IndexStore } from "../persistence/indexStore";
import type { QueueStore } from "../persistence/queueStore";
import { createPublishCandidate, PublishCandidateError } from "../global/publish";
import type { GlobalPublishQueue } from "../global/publishQueue";
import type { PageFetcher } from "./libraryScanner";

// ─────────────────────────────────────────────────────────────────────────────
// Budgets (single source of truth)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pages fetched per discovery round (server page size × this value bounds the
 * volume one round can reach). Keeps a round short enough to run alongside the
 * serial analysis JobRunner without starving it.
 */
export const PUBLIC_DISCOVERY_PAGE_BUDGET = 5;

/**
 * Hard ceiling on how many listing entries ONE discovery round may look at.
 * A backstop independent of the page budget (smaller-than-requested pages
 * cannot push a round past this many samples).
 */
export const PUBLIC_DISCOVERY_SAMPLE_BUDGET = 200;

/** Default server-side page size for discovery listing calls. */
export const PUBLIC_DISCOVERY_PAGE_SIZE = 40;

// ─────────────────────────────────────────────────────────────────────────────
// Discovery cursor meta record (discovery state ONLY)
// ─────────────────────────────────────────────────────────────────────────────

/** Meta-store key holding the singleton discovery cursor record. */
export const DISCOVERY_META_KEY = "public-discovery-v1";

/**
 * Schema/version marker for the cursor semantics. If the meaning of the stored
 * token ever changes, bump this value: a mismatch makes the next round discard
 * the old token and restart from the first page instead of mis-resuming.
 */
export const DISCOVERY_CURSOR_VERSION = 1;

/**
 * The persisted resume state of public discovery. Deliberately tiny:
 *  - `lastPageToken` — the `nextPageToken` to continue from ("" = at the start;
 *    a round that exhausted the listing also resets to "").
 *  - `rounds`        — completed rounds (diagnostics).
 *  - `lastRoundAt`   — ISO timestamp of the last completed round.
 *
 * NO sample ids, NO metadata values, NO audio — pure discovery bookkeeping.
 */
export interface PublicDiscoveryCursor {
  kind: "public-discovery";
  cursorVersion: number;
  lastPageToken: string;
  rounds: number;
  lastRoundAt?: string;
}

async function readCursor(db: ElasticDB): Promise<PublicDiscoveryCursor | undefined> {
  const raw = await db.get<unknown>(STORES.meta, DISCOVERY_META_KEY);
  if (
    typeof raw === "object" &&
    raw !== null &&
    (raw as Partial<PublicDiscoveryCursor>).kind === "public-discovery" &&
    (raw as Partial<PublicDiscoveryCursor>).cursorVersion === DISCOVERY_CURSOR_VERSION &&
    typeof (raw as Partial<PublicDiscoveryCursor>).lastPageToken === "string"
  ) {
    return raw as PublicDiscoveryCursor;
  }
  return undefined;
}

async function writeCursor(db: ElasticDB, cursor: PublicDiscoveryCursor): Promise<void> {
  await db.put(STORES.meta, cursor, DISCOVERY_META_KEY);
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligible-public predicate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A listing entry is suitable for the PUBLIC GLOBAL population iff its
 * visibility is exactly `"public"`. `unlisted`, missing or unknown visibility
 * never enters the global pool. Pure function, no I/O.
 */
export function isPublicListable(meta: Pick<SampleMeta, "visibility">): boolean {
  return meta.visibility === "public";
}

// ─────────────────────────────────────────────────────────────────────────────
// Round 1 — discover & enqueue analysis jobs (existing queue path)
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoverPublicOptions {
  /** Server page size for each `samples.list` call. Default: PUBLIC_DISCOVERY_PAGE_SIZE. */
  pageSize?: number;
  /** Max pages fetched this round. Default: PUBLIC_DISCOVERY_PAGE_BUDGET. */
  maxPages?: number;
  /** Max listing entries inspected this round. Default: PUBLIC_DISCOVERY_SAMPLE_BUDGET. */
  maxSamples?: number;
  /** Deterministic clock for the cursor timestamp (tests). */
  now?: () => string;
}

export type DiscoveryStopReason = "exhausted" | "budget";

export interface DiscoveryRoundResult {
  /** Listing entries inspected this round (all visibilities, before the gate). */
  seenCount: number;
  /** Entries that passed the public-visibility gate. */
  publicCount: number;
  /** New public samples enqueued into the existing analysis queue ("added"). */
  newlyEnqueued: number;
  /** Public samples already known locally (index row or job row) — skipped. */
  alreadyKnown: number;
  /** Non-public entries skipped by the visibility gate. */
  skippedNonPublic: number;
  /** Pages actually fetched this round. */
  pagesFetched: number;
  stoppedReason: DiscoveryStopReason;
  /** Cursor state after this round. */
  cursor: PublicDiscoveryCursor;
}

/**
 * Run ONE bounded public-discovery round:
 *  1. resume at the persisted `nextPageToken` (or the first page),
 *  2. page through `samples.list` via the EXISTING `PageFetcher` abstraction,
 *  3. keep only `visibility === "public"` entries,
 *  4. skip anything already known locally (index record OR job row — both mean
 *     "registered"; the queue/job idempotency plus the pipeline's
 *     "already analyzed for build" skip guarantee that nothing is re-analyzed),
 *  5. enqueue the rest through the EXISTING `QueueStore.enqueue` — the same
 *     path the own-library scan uses, so the existing JobRunner picks them up,
 *  6. persist the updated cursor and stop at the budget.
 *
 * Metadata-only: no audio is touched anywhere in this function.
 */
export async function discoverPublicSamples(
  deps: {
    fetchPage: PageFetcher;
    index: IndexStore;
    queue: QueueStore;
    db: ElasticDB;
  },
  analysisBuild: string,
  opts: DiscoverPublicOptions = {},
): Promise<DiscoveryRoundResult> {
  const pageSize = opts.pageSize ?? PUBLIC_DISCOVERY_PAGE_SIZE;
  const maxPages = opts.maxPages ?? PUBLIC_DISCOVERY_PAGE_BUDGET;
  const maxSamples = opts.maxSamples ?? PUBLIC_DISCOVERY_SAMPLE_BUDGET;
  const nowIso = opts.now ?? (() => new Date().toISOString());

  const previous = await readCursor(deps.db);
  let pageToken: string | undefined =
    previous !== undefined && previous.lastPageToken.length > 0
      ? previous.lastPageToken
      : undefined;

  let seenCount = 0;
  let publicCount = 0;
  let newlyEnqueued = 0;
  let alreadyKnown = 0;
  let skippedNonPublic = 0;
  let pagesFetched = 0;
  let stoppedReason: DiscoveryStopReason = "exhausted";

  for (;;) {
    if (pagesFetched >= maxPages || seenCount >= maxSamples) {
      // Budget reached BEFORE the listing ran out: keep the CURRENT token so
      // the next round resumes exactly here.
      stoppedReason = "budget";
      break;
    }
    const page = await deps.fetchPage({ pageSize, pageToken });
    pagesFetched++;

    for (const meta of page.samples) {
      seenCount++;
      if (!isPublicListable(meta)) {
        skippedNonPublic++;
        continue;
      }
      publicCount++;
      // Already-known check FIRST: a local index record or an existing job row
      // means this sample is registered (and possibly already analyzed) — never
      // enqueue it again.
      const knownIndex = await deps.index.get(meta.name);
      if (knownIndex !== undefined) {
        alreadyKnown++;
        continue;
      }
      const knownJob = await deps.queue.get(meta.name);
      if (knownJob !== undefined) {
        alreadyKnown++;
        continue;
      }
      const outcome = await deps.queue.enqueue(meta.name, analysisBuild);
      if (outcome === "added") newlyEnqueued++;
      else alreadyKnown++;
    }

    const next = page.nextPageToken;
    if (next === undefined || next.length === 0 || page.samples.length === 0) {
      // Listing exhausted: the NEXT round starts again at the first page.
      // Deduplication against the local stores keeps repeat rounds cheap and
      // duplicate-free (the deliberate fallback to a persistent token, which
      // Audiotool pagination semantics do not guarantee to be long-lived).
      pageToken = undefined;
      stoppedReason = "exhausted";
      break;
    }
    pageToken = next;
  }

  const cursor: PublicDiscoveryCursor = {
    kind: "public-discovery",
    cursorVersion: DISCOVERY_CURSOR_VERSION,
    lastPageToken: stoppedReason === "budget" ? pageToken ?? "" : "",
    rounds: (previous?.rounds ?? 0) + 1,
    lastRoundAt: nowIso(),
  };
  await writeCursor(deps.db, cursor);

  return {
    seenCount,
    publicCount,
    newlyEnqueued,
    alreadyKnown,
    skippedNonPublic,
    pagesFetched,
    stoppedReason,
    cursor,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Round 2 — hand finished public analyses to the EXISTING publish queue
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicPublishPassResult {
  /** Analyzed public records considered in this pass. */
  candidatesSeen: number;
  /** Newly handed to the GlobalPublishQueue ("queued"). */
  enqueued: number;
  /** Rejected duplicates — already queued/succeeded in the publish queue. */
  duplicates: number;
  /** Records not structurally publishable (e.g. Missing-V2 position). */
  skippedNotPublishable: number;
  /** Marker records written (delivery "pending"). */
  marked: number;
}

/**
 * Scan the local index for ANALYZED, PUBLIC records and feed each through the
 * EXISTING publish adapter chain:
 *
 *   SampleIndexRecord → createPublishCandidate() → GlobalPublishQueue.enqueue()
 *
 * Semantics preserved (NOT modified):
 *  - `GlobalPublishQueue.enqueue` is sample-level idempotent (a second attempt
 *    for the same sampleId returns "duplicate"), so published/queued samples
 *    are never re-published by a repeat pass.
 *  - Content-level dedup stays server-side in the existing contract.
 *  - The Option-A delivery marker (`globalPublish`) is written with EXACTLY the
 *    same shape the 16H usage-acceptance path uses, so the existing
 *    publish-status surface and `reconstructPending()` see these records
 *    uniformly. Records that already carry a marker are NEVER overwritten —
 *    their original `usageAcceptedAt` and delivery state stay untouched; only
 *    genuinely unmarked records get the fresh "pending" marker.
 *  - Candidates without a persisted V2 map position are Missing-V2 and are
 *    honestly skipped (never published, never faked).
 *
 * Read/write separation holds: this pass never triggers analysis and never
 * flushes the network itself — flushing stays owned by the existing
 * `flushPendingPublications()` caller path.
 */
export async function publishPublicAnalyses(
  deps: {
    index: IndexStore;
    publishQueue: GlobalPublishQueue;
    /** Restrict consideration to these sampleIds (e.g. one discovery round's adds). */
    onlySampleIds?: readonly string[];
    /** Deterministic clock for the marker timestamp (tests). */
    now?: () => string;
  },
): Promise<PublicPublishPassResult> {
  const nowIso = deps.now ?? (() => new Date().toISOString());
  const records = await deps.index.getAll();
  const scope =
    deps.onlySampleIds !== undefined ? new Set(deps.onlySampleIds) : undefined;

  const result: PublicPublishPassResult = {
    candidatesSeen: 0,
    enqueued: 0,
    duplicates: 0,
    skippedNotPublishable: 0,
    marked: 0,
  };

  for (const record of records) {
    if (record.status !== "analyzed") continue;
    if (record.visibility !== "public") continue;
    if (scope !== undefined && !scope.has(record.sampleId)) continue;
    result.candidatesSeen++;

    let candidate;
    try {
      candidate = createPublishCandidate(record);
    } catch (e) {
      if (e instanceof PublishCandidateError) {
        result.skippedNotPublishable++;
        continue;
      }
      throw e;
    }

    const outcome = deps.publishQueue.enqueue(candidate);
    if (outcome === "duplicate") {
      result.duplicates++;
      continue;
    }
    result.enqueued++;
    // Option-A marker (same shape as the usage-acceptance path): accepted for
    // publication, delivery pending until the existing flush succeeds. An
    // EXISTING marker is never overwritten — its original acceptance time and
    // delivery state ("pending" or "published") must survive this pass.
    if (record.globalPublish === undefined) {
      await deps.index.put({
        ...record,
        globalPublish: { usageAcceptedAt: nowIso(), delivery: "pending" },
      });
      result.marked++;
    }
  }

  return result;
}
