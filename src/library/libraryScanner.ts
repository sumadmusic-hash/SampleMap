import type { SampleMeta } from "@audiotool/nexus/api";
import { toSampleName } from "./sampleRef";

/**
 * Delta-scan orchestration over the Audiotool sample library.
 *
 * Responsibilities (SAMPLEMAP_V1_SPEC §5.1 / §20):
 *  - page through `samples.list` via `nextPageToken`
 *  - classify each returned sample as added / changed / unchanged relative to
 *    the locally known state (`KnownProvider`)
 *  - track a `latestKnown` scan timestamp so a later run only processes new or
 *    modified samples (incremental indexing)
 *
 * "Gone" samples are intentionally NOT detected here: the pipeline marks them
 * `gone` when a later get()/download fails (see spec §5.1). This scanner stays
 * purely about what a listing returns.
 */

export interface SampleListPage {
  samples: SampleMeta[];
  nextPageToken?: string;
}

export type PageFetcher = (opts: {
  pageSize?: number;
  pageToken?: string;
  /**
   * STEP62 — optional server-side CEL filter forwarded verbatim to
   * `samples.list` (e.g. `sample.owner_name == "users/{id}"`). Undefined for
   * the unfiltered general scan (pre-STEP62 behavior unchanged).
   */
  filter?: string;
  /**
   * STEP81 — optional server-side sort order forwarded verbatim to
   * `samples.list` (e.g. `sample.num_favorites desc`). Undefined for the
   * own-library scan and for any caller that does not ask for a specific
   * order (pre-STEP81 behavior unchanged).
   */
  orderBy?: string;
}) => Promise<SampleListPage>;

/** Local knowledge of a sample's last-seen update time (ISO) or none if unknown. */
export interface KnownProvider {
  getUpdatedAt(sampleId: string): Promise<string | undefined>;
}

export interface LibraryScannerOptions {
  pageSize?: number;
  /** Stop after collecting this many samples in the scan. */
  maxSamples?: number;
  /** Stop after fetching this many pages. */
  maxPages?: number;
  /**
   * STEP62 — server-side CEL filter (e.g. own-upload owner filter). Passed to
   * every page fetch; the caller is responsible for the expression's correct
   * quoting.
   */
  filter?: string;
  /**
   * STEP62 — cooperative stop hook, consulted before each page fetch. When it
   * returns true the scan stops with `stoppedReason: "aborted"`; already
   * collected pages stay intact, so a later scan can resume cleanly (the queue
   * makes re-enqueueing idempotent).
   */
  shouldStop?: () => boolean;
  /** Deterministic clock for the latestKnown timestamp (tests). */
  dateNow?: () => Date;
}

export interface LibraryScanResult {
  added: SampleMeta[];
  changed: SampleMeta[];
  /** Count of samples that were already up to date (not retained in-memory). */
  unchangedCount: number;
  /** Every sampleId seen during this scan. */
  seenSampleIds: string[];
  pageCount: number;
  latestKnown: string;
  /** True unless the scan was cut short by maxSamples / maxPages / abort. */
  fullScan: boolean;
  stoppedReason?: "maxSamples" | "maxPages" | "exhausted" | "aborted";
}

export async function scanLibrary(
  fetchPage: PageFetcher,
  known: KnownProvider,
  opts: LibraryScannerOptions = {},
): Promise<LibraryScanResult> {
  const pageSize = opts.pageSize ?? 20;
  const dateNow = opts.dateNow ?? (() => new Date());
  const startedAt = dateNow();

  const added: SampleMeta[] = [];
  const changed: SampleMeta[] = [];
  let unchangedCount = 0;
  const seenSampleIds: string[] = [];

  let pageToken: string | undefined;
  let pageCount = 0;
  let stoppedReason: LibraryScanResult["stoppedReason"] = "exhausted";

  do {
    if (opts.shouldStop !== undefined && opts.shouldStop()) {
      stoppedReason = "aborted";
      break;
    }
    const page = await fetchPage({ pageSize, pageToken, filter: opts.filter });
    pageCount++;

    for (const sample of page.samples) {
      seenSampleIds.push(sample.name);
      const knownUpdatedAt = await known.getUpdatedAt(sample.name);
      if (knownUpdatedAt === undefined) {
        added.push(sample);
      } else if (isNewer(sample, knownUpdatedAt)) {
        changed.push(sample);
      } else {
        unchangedCount++;
      }
    }

    if (opts.maxSamples !== undefined && seenSampleIds.length >= opts.maxSamples) {
      stoppedReason = "maxSamples";
      break;
    }
    if (opts.maxPages !== undefined && pageCount >= opts.maxPages) {
      stoppedReason = "maxPages";
      break;
    }

    pageToken = page.nextPageToken;
    // STEP62 — defensive guard: some APIs keep yielding a token while the
    // enumeration is over. An empty page terminates the scan as "exhausted"
    // so an unbounded (own-upload) pass can never page forever.
    if (page.samples.length === 0) {
      stoppedReason = "exhausted";
      pageToken = undefined;
      break;
    }
  } while (pageToken && pageToken.length > 0);

  if (stoppedReason === "exhausted" && pageToken) {
    stoppedReason = "maxPages";
  }

  const result: LibraryScanResult = {
    added,
    changed,
    unchangedCount,
    seenSampleIds,
    pageCount,
    latestKnown: startedAt.toISOString(),
    fullScan: stoppedReason === "exhausted",
  };
  if (stoppedReason !== "exhausted") result.stoppedReason = stoppedReason;
  return result;
}

function isNewer(sample: SampleMeta, knownUpdatedAt: string): boolean {
  const sampleTime = sample.updateTime?.toISOString();
  if (sampleTime === undefined) return false;
  return sampleTime > knownUpdatedAt;
}

export function summarizeScan(r: LibraryScanResult): string {
  return `scan: +${r.added.length} changed:${r.changed.length} same:${r.unchangedCount} pages:${r.pageCount} full:${r.fullScan} latestKnown:${r.latestKnown}`;
}

// Reference the prefix helper so imports stay coherent for downstream consumers.
export { toSampleName };
