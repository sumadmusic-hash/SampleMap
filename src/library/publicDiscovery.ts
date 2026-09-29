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
 *  - STEP81 POPULARITY: the two documented objective Audiotool signals
 *    (`numFavorites`, `numUsages`) are now used as a SERVER-SIDE sort order
 *    only — never combined into an invented score. There is NO weighting, NO
 *    normalization and NO locally computed ranking formula anywhere in this
 *    file. See `PUBLIC_DISCOVERY_LANES` below.
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
// STEP81 — Popularity lanes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two documented objective popularity signals, each requested as its OWN
 * single-field server-side sort order.
 *
 * WHY TWO LANES INSTEAD OF ONE COMBINED ORDER (verified against the installed
 * `@audiotool/nexus@0.0.17` contract, see `SampleListOptions.orderBy`):
 *   - `orderBy` is typed as a single `string` (SDK option AND the protobuf
 *     `ListSamplesRequest.order_by` field 5),
 *   - it is documented only in the singular form, e.g. `"sample.create_time desc"`,
 *   - and NOTHING in the shipped package documents a separator or a grammar for
 *     combining several sort fields.
 * Multi-field ordering is therefore NOT confirmed, so it is NOT assumed. Instead
 * each signal gets its own deterministic lane, which needs no unverified
 * assumption and keeps both signals observable.
 *
 * `sample.num_favorites` and `sample.num_usages` are documented fields in the
 * same list as the other supported `orderBy` fields, and both are forwarded
 * verbatim to the server.
 *
 * NO invented formula: these strings are pure pass-through orderings. This file
 * never adds, weights, normalizes or otherwise combines the two values locally.
 */
export const PUBLIC_DISCOVERY_LANES = [
  { key: "favorites", orderBy: "sample.num_favorites desc" },
  { key: "usages", orderBy: "sample.num_usages desc" },
] as const;

export type PublicDiscoveryLaneKey = (typeof PUBLIC_DISCOVERY_LANES)[number]["key"];

// ─────────────────────────────────────────────────────────────────────────────
// Discovery cursor meta record (discovery state ONLY)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Meta-store key holding the singleton discovery cursor record.
 *
 * STABLE on purpose across cursor versions: `readCursor()` finds the existing
 * record, sees the `cursorVersion` mismatch and discards it. Changing the key
 * instead would orphan the old record forever.
 */
export const DISCOVERY_META_KEY = "public-discovery-v1";

/**
 * Schema/version marker for the cursor semantics. If the meaning of the stored
 * token ever changes, bump this value: a mismatch makes the next round discard
 * the old token and restart from the first page instead of mis-resuming.
 *
 * STEP81: v1 → v2. The single `lastPageToken` is replaced by ONE token PER
 * popularity lane, because each lane walks its own independently ordered
 * listing and therefore has its own pagination position. A v1 token refers to
 * an un-ordered listing walk and is NOT reusable in a lane, so it is discarded
 * deterministically (the version check below) rather than being silently
 * reinterpreted as a lane token.
 */
export const DISCOVERY_CURSOR_VERSION = 2;

/**
 * The persisted resume state of public discovery. Deliberately tiny:
 *  - `laneTokens`     — per-lane `nextPageToken` to continue from ("" = at the
 *    start; a lane that exhausted the listing resets to ""). Order is the
 *    server's, so a lane's token is ONLY valid for that same lane.
 *  - `rounds`         — completed rounds (diagnostics).
 *  - `lastRoundAt`    — ISO timestamp of the last completed round.
 *
 * NO sample ids, NO metadata values, NO popularity values, NO audio — pure
 * discovery bookkeeping.
 */
export interface PublicDiscoveryCursor {
  kind: "public-discovery";
  cursorVersion: number;
  /** Per-lane resume token. Missing keys are treated as "start at page one". */
  laneTokens: Partial<Record<PublicDiscoveryLaneKey, string>>;
  rounds: number;
  lastRoundAt?: string;
}

function laneTokenOf(
  cursor: PublicDiscoveryCursor | undefined,
  lane: PublicDiscoveryLaneKey,
): string | undefined {
  const token = cursor?.laneTokens?.[lane];
  return token !== undefined && token.length > 0 ? token : undefined;
}

async function readCursor(db: ElasticDB): Promise<PublicDiscoveryCursor | undefined> {
  const raw = await db.get<unknown>(STORES.meta, DISCOVERY_META_KEY);
  if (
    typeof raw === "object" &&
    raw !== null &&
    (raw as Partial<PublicDiscoveryCursor>).kind === "public-discovery" &&
    (raw as Partial<PublicDiscoveryCursor>).cursorVersion === DISCOVERY_CURSOR_VERSION &&
    typeof (raw as Partial<PublicDiscoveryCursor>).laneTokens === "object" &&
    (raw as Partial<PublicDiscoveryCursor>).laneTokens !== null
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

/** Per-lane outcome of one round (diagnostics; the queue is shared). */
export interface DiscoveryLaneResult {
  lane: PublicDiscoveryLaneKey;
  /** The server-side `orderBy` string sent for this lane. */
  orderBy: string;
  /** Listing entries inspected in this lane (all visibilities, before the gate). */
  seenCount: number;
  /** Entries that passed the public-visibility gate. */
  publicCount: number;
  /** New public samples enqueued in this lane. */
  newlyEnqueued: number;
  /** Pages actually fetched in this lane. */
  pagesFetched: number;
  stoppedReason: DiscoveryStopReason;
  /** Resume token stored for the next round ("" = restart at page one). */
  nextPageToken: string;
}

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
  /** Pages actually fetched this round (sum over lanes). */
  pagesFetched: number;
  stoppedReason: DiscoveryStopReason;
  /** Cursor state after this round. */
  cursor: PublicDiscoveryCursor;
  /** STEP81 — per-lane breakdown, in the fixed `PUBLIC_DISCOVERY_LANES` order. */
  lanes: DiscoveryLaneResult[];
}

/**
 * Run ONE bounded public-discovery round over EVERY popularity lane:
 *  1. resume each lane at ITS OWN persisted `nextPageToken` (or the first page),
 *  2. page through `samples.list` via the EXISTING `PageFetcher` abstraction,
 *     with the lane's own server-side `orderBy`,
 *  3. keep only `visibility === "public"` entries,
 *  4. skip anything already known locally (index record OR job row — both mean
 *     "registered"; the queue/job idempotency plus the pipeline's
 *     "already analyzed for build" skip guarantee that nothing is re-analyzed).
 *     This is also what deduplicates ACROSS lanes: a sample the favorites lane
 *     just enqueued already has a job row, so the usages lane skips it,
 *  5. enqueue the rest through the EXISTING `QueueStore.enqueue` — the same
 *     path the own-library scan uses, so the existing JobRunner picks them up.
 *     Lanes only page differently; they share ONE queue and ONE analysis
 *     pipeline, which is why no second pipeline is introduced,
 *  6. persist the updated per-lane cursor and stop at the budget.
 *
 * The page/sample budgets are split EVENLY across the lanes, so the total work
 * of a round stays exactly as bounded as it was with a single lane.
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

  // Split the per-round budget evenly across the lanes (>=1 page per lane so a
  // lane never gets a zero budget and silently stops progressing).
  const laneCount = PUBLIC_DISCOVERY_LANES.length;
  const laneMaxPages = Math.max(1, Math.floor(maxPages / laneCount));
  const laneMaxSamples = Math.max(1, Math.floor(maxSamples / laneCount));

  let seenCount = 0;
  let publicCount = 0;
  let newlyEnqueued = 0;
  let alreadyKnown = 0;
  let skippedNonPublic = 0;
  let pagesFetched = 0;
  let stoppedReason: DiscoveryStopReason = "exhausted";
  const lanes: DiscoveryLaneResult[] = [];
  const laneTokens: PublicDiscoveryCursor["laneTokens"] = {};

  for (const lane of PUBLIC_DISCOVERY_LANES) {
    let pageToken = laneTokenOf(previous, lane.key);
    let laneSeen = 0;
    let lanePublic = 0;
    let laneEnqueued = 0;
    let lanePages = 0;
    let laneStopped: DiscoveryStopReason = "exhausted";

    for (;;) {
      if (lanePages >= laneMaxPages || laneSeen >= laneMaxSamples) {
        // Budget reached BEFORE the listing ran out: keep the CURRENT token so
        // the next round resumes this lane exactly here.
        laneStopped = "budget";
        break;
      }
      const page = await deps.fetchPage({
        pageSize,
        pageToken,
        orderBy: lane.orderBy,
      });
      lanePages++;

      for (const meta of page.samples) {
        laneSeen++;
        if (!isPublicListable(meta)) {
          skippedNonPublic++;
          continue;
        }
        lanePublic++;
        // Already-known check FIRST: a local index record or an existing job row
        // means this sample is registered (and possibly already analyzed) — never
        // enqueue it again. This also dedups across lanes.
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
        if (outcome === "added") laneEnqueued++;
        else alreadyKnown++;
      }

      const next = page.nextPageToken;
      if (next === undefined || next.length === 0 || page.samples.length === 0) {
        // Listing exhausted: the NEXT round starts this lane again at the first
        // page. Deduplication against the local stores keeps repeat rounds cheap
        // and duplicate-free (the deliberate fallback to a persistent token,
        // which Audiotool pagination semantics do not guarantee to be long-lived).
        pageToken = undefined;
        laneStopped = "exhausted";
        break;
      }
      pageToken = next;
    }

    seenCount += laneSeen;
    publicCount += lanePublic;
    newlyEnqueued += laneEnqueued;
    pagesFetched += lanePages;
    if (laneStopped === "budget") stoppedReason = "budget";
    laneTokens[lane.key] = laneStopped === "budget" ? pageToken ?? "" : "";
    lanes.push({
      lane: lane.key,
      orderBy: lane.orderBy,
      seenCount: laneSeen,
      publicCount: lanePublic,
      newlyEnqueued: laneEnqueued,
      pagesFetched: lanePages,
      stoppedReason: laneStopped,
      nextPageToken: laneTokens[lane.key] ?? "",
    });
  }

  const cursor: PublicDiscoveryCursor = {
    kind: "public-discovery",
    cursorVersion: DISCOVERY_CURSOR_VERSION,
    laneTokens,
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
    lanes,
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
