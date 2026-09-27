import { describe, it, expect, afterEach } from "vitest";
import type { SampleMeta } from "@audiotool/nexus/api";
import { SampleMapApp, BACKGROUND_INDEXING_BUDGET } from "./app";
import type { SampleMapAppDeps } from "./app";
import { createMemoryEp7ConsentStore } from "./ep7Consent";
import { makeSample, openTestDatabase } from "../persistence/test-helpers";
import type { DatabaseHandle } from "../persistence/db";
import { SampleMapSearchEngine } from "../search/searchEngine";
import { JobRunner } from "../pipeline/jobRunner";
import type { AnalysisBudget } from "../pipeline/jobRunner";
import type { AnalysisPipeline } from "../pipeline/analysisPipeline";
import type { LibraryScanResult } from "../library/libraryScanner";
import { mapPoints } from "./map/mapView";
import { makeFeatures } from "../classify/test-helpers";

const BUILD = "build-v1";

/**
 * AUTOMATIC background indexing (`SampleMapApp.startBackgroundIndexing`).
 *
 * Opening the app must be enough to index it: scan first, then analyse whatever
 * is due, without the user pressing "Start Scan" / "Analyse N" and without the
 * mount waiting for it.
 *
 * Pinned here:
 *  1. the automatic run is triggered EXACTLY ONCE per app instance,
 *  2. already persisted local results are visible before/while it runs,
 *  3. the scan runs BEFORE the automatic analysis,
 *  4. the automatic budget is 1000 (an INV-3 budget, still bounded),
 *  5. no second parallel background run (nor a parallel manual scan/run),
 *  6. already analysed samples are not analysed again (queue idempotency),
 *  7. the run does not block the caller, and a scan that enqueued nothing and
 *     left nothing due starts no run at all.
 *
 * The REAL `JobRunner` drives the REAL `QueueStore`; only the analysis
 * PIPELINE is doubled, so "was anything analysed?" is answered by the pipeline
 * call itself rather than by a stubbed progress number.
 */

const openHandles: DatabaseHandle[] = [];
function openDb(): Promise<DatabaseHandle> {
  return openTestDatabase().then((h) => {
    openHandles.push(h);
    return h;
  });
}
afterEach(async () => {
  const handles = openHandles.splice(0);
  await Promise.all(
    handles.map((h) =>
      h.db.close().catch(() => {
        // Closing an already-closed connection is safe.
      }),
    ),
  );
});

/** A record shaped like the pipeline's persisted output (has a map position). */
function analyzedRecord(sampleId: string) {
  return makeSample(sampleId, {
    analysisBuild: BUILD,
    audioFeatures: makeFeatures(),
    mapPosition: { x: 0.4, y: 0.5 },
  });
}

function meta(name: string): SampleMeta {
  return {
    name,
    ownerName: "users/alice",
    bpm: 120,
    numFavorites: 1,
    numUsages: 1,
  } as unknown as SampleMeta;
}

interface PipelineDouble {
  pipeline: AnalysisPipeline;
  /** Sample ids the pipeline was asked to analyse, in call order. */
  analysed: string[];
  /** Keep the run in flight until released, to observe the running state. */
  hold: () => void;
  release: () => void;
}

function makePipelineDouble(index: {
  put: (r: ReturnType<typeof analyzedRecord>) => Promise<void>;
}): PipelineDouble {
  const analysed: string[] = [];
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  const pipeline = {
    run: async (sampleId: string) => {
      analysed.push(sampleId);
      if (gate) await gate;
      // Mirror the real pipeline: it persists each finished record itself.
      await index.put(analyzedRecord(sampleId));
      return { status: "analyzed" as const };
    },
  } as unknown as AnalysisPipeline;
  return {
    pipeline,
    analysed,
    hold: () => {
      gate = new Promise<void>((res) => {
        open = res;
      });
    },
    release: () => {
      gate = undefined;
      open?.();
    },
  };
}

interface Rig {
  app: SampleMapApp;
  db: DatabaseHandle;
  /** Budgets the runner was created with, in call order. */
  budgets: AnalysisBudget[];
  /** Ordered log of the orchestrated steps. */
  order: string[];
  pd: PipelineDouble;
  scanCalls: () => number;
  /** Pin the scan open so a parallel scan can be attempted. */
  holdScan: () => void;
  releaseScan: () => void;
  /** Wait until no analysis run is in flight. */
  settle: () => Promise<void>;
}

const flush = async () => {
  for (let i = 0; i < 64; i++) await Promise.resolve();
};

/**
 * Wait for a condition that is reached through real IndexedDB round trips.
 * A microtask flush is not enough here: fake-indexeddb answers through the
 * event loop, so the scan -> enqueue -> nextDue -> run chain needs real ticks.
 */
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`waitFor timed out: ${pred()}`);
}

async function rig(
  opts: { scan?: LibraryScanResult; hold?: boolean } = {},
): Promise<Rig> {
  const handle = await openDb();
  const budgets: AnalysisBudget[] = [];
  const order: string[] = [];
  const pd = makePipelineDouble(handle.index as never);
  if (opts.hold) pd.hold();

  const scanResult: LibraryScanResult = opts.scan ?? {
    added: [meta("samples/new-1")],
    changed: [],
    unchangedCount: 0,
    seenSampleIds: ["samples/new-1"],
    pageCount: 1,
    latestKnown: "2026-01-01T00:00:00.000Z",
    fullScan: true,
  };
  let scanCalls = 0;
  // Lets a test pin the SCAN open, to attempt a parallel scan while the
  // automatic one is still running.
  let scanGate: Promise<void> | undefined;
  let openScan: (() => void) | undefined;

  const consent = createMemoryEp7ConsentStore();
  consent.grant();

  const deps: Partial<SampleMapAppDeps> = {
    queue: handle.queue,
    index: handle.index,
    // The REAL search engine over the REAL index, so `results` and the map are
    // derived from genuinely persisted records.
    search: new SampleMapSearchEngine(handle.index) as never,
    preview: { dispose: () => undefined } as never,
    machiniste: { send: () => undefined } as never,
    createRunner: ((budget: AnalysisBudget) => {
      budgets.push(budget);
      order.push("analyze");
      return new JobRunner({
        pipeline: pd.pipeline,
        queue: handle.queue,
        analysisBuild: BUILD,
        budget,
      });
    }) as SampleMapAppDeps["createRunner"],
    scanFn: (async () => {
      scanCalls++;
      order.push("scan");
      if (scanGate) await scanGate;
      return scanResult;
    }) as never,
    fetchPage: (async () => ({ samples: [], nextPageToken: "" })) as never,
    known: { getUpdatedAt: async () => undefined },
    previewUrlFor: () => undefined,
    analysisBuild: BUILD,
    authenticatedUserId: "users/alice",
    ep7Consent: consent,
  };
  const app = new SampleMapApp(deps as SampleMapAppDeps);

  return {
    app,
    db: handle,
    budgets,
    order,
    pd,
    scanCalls: () => scanCalls,
    holdScan: () => {
      scanGate = new Promise<void>((res) => {
        openScan = res;
      });
    },
    releaseScan: () => {
      scanGate = undefined;
      openScan?.();
    },
    settle: async () => {
      for (let i = 0; i < 400; i++) {
        if (app.analysis.status !== "running") return;
        await new Promise((r) => setTimeout(r, 2));
      }
      throw new Error("analysis run did not settle");
    },
  };
}

const emptyScan: LibraryScanResult = {
  added: [],
  changed: [],
  unchangedCount: 3,
  seenSampleIds: ["samples/a", "samples/b", "samples/c"],
  pageCount: 1,
  latestKnown: "2026-01-01T00:00:00.000Z",
  fullScan: true,
};

describe("automatic background indexing", () => {
  it("1. starts exactly once, even when triggered repeatedly", async () => {
    const r = await rig();
    try {
      // Concurrent AND sequential repeats must all collapse into one run.
      await Promise.all([
        r.app.startBackgroundIndexing(),
        r.app.startBackgroundIndexing(),
      ]);
      await r.app.startBackgroundIndexing();
      await r.app.startBackgroundIndexing();
      await r.settle();

      expect(r.scanCalls()).toBe(1);
      expect(r.budgets).toEqual([BACKGROUND_INDEXING_BUDGET]);
      expect(r.app.backgroundIndexingTriggered).toBe(true);
    } finally {
      await r.db.db.close();
    }
  });

  it("2. keeps already persisted local results visible before and during the run", async () => {
    const r = await rig();
    try {
      await r.db.index.put(analyzedRecord("samples/old-1"));
      await r.app.refreshSearch();

      // Present BEFORE the background work starts.
      expect(r.app.results.map((x) => x.record.sampleId)).toEqual([
        "samples/old-1",
      ]);
      expect(mapPoints(r.app.results.map((x) => x.record))).toHaveLength(1);

      r.pd.hold();
      const started = r.app.startBackgroundIndexing();
      await waitFor(() => r.app.analysis.status === "running");

      // Still visible while the automatic analysis is in flight — the
      // background workflow never blanks the map.
      expect(r.app.analysis.status).toBe("running");
      expect(r.app.results.map((x) => x.record.sampleId)).toContain(
        "samples/old-1",
      );

      r.pd.release();
      await started;
      await r.settle();
      expect(r.app.results.map((x) => x.record.sampleId)).toContain(
        "samples/old-1",
      );
    } finally {
      await r.db.db.close();
    }
  });

  it("3. scans before starting the automatic analysis", async () => {
    const r = await rig();
    try {
      await r.app.startBackgroundIndexing();
      await r.settle();
      expect(r.order).toEqual(["scan", "analyze"]);
    } finally {
      await r.db.db.close();
    }
  });

  it("4. uses the controlled budget 1000 (never unbounded)", async () => {
    const r = await rig();
    try {
      await r.app.startBackgroundIndexing();
      await r.settle();
      expect(BACKGROUND_INDEXING_BUDGET).toBe(1000);
      expect(r.budgets).toEqual([1000]);
      expect(r.app.analysis.budget).toBe(1000);
    } finally {
      await r.db.db.close();
    }
  });

  it("5. starts no second parallel scan and no second parallel run", async () => {
    const r = await rig();
    try {
      // (a) Parallel SCAN: a manual "Start Scan" while the automatic scan is
      // still running must not start a second scan.
      r.holdScan();
      const first = r.app.startBackgroundIndexing();
      await waitFor(() => r.app.scan.status === "scanning");
      await r.app.startScan();
      expect(r.scanCalls()).toBe(1);
      r.releaseScan();

      // The automatic run starts once the scan finished enqueueing.
      await first;
      r.pd.hold();
      await waitFor(() => r.app.analysis.status === "running");

      // (b) Parallel ANALYSIS: a repeated automatic start and a manual
      // "Analyse 10" arrive while the automatic run is in flight.
      const repeat = r.app.startBackgroundIndexing();
      const manualRun = r.app.analyze(10);
      await repeat;
      await flush();

      // No second run, and the manual budget did NOT hijack the automatic one.
      expect(r.budgets).toEqual([1000]);
      expect(r.app.analysis.budget).toBe(1000);
      expect(r.app.analysis.status).toBe("running");
      // The manual call got the EXISTING runner back instead of a new one.
      expect(manualRun).toBeTruthy();

      r.pd.release();
      await r.settle();
      expect(r.budgets).toEqual([1000]);
    } finally {
      r.pd.release();
      r.releaseScan();
      await r.db.db.close();
    }
  });

  it("6. does not analyse already analysed samples again (existing queue idempotency)", async () => {
    const r = await rig({ scan: emptyScan });
    try {
      // A completed job of the SAME build: the scan sees the sample as
      // unchanged, and re-enqueueing it is a no-op in QueueStore.
      await r.db.queue.enqueue("samples/done-1", BUILD);
      const job = await r.db.queue.get("samples/done-1");
      await r.db.queue.markAnalyzed(job!);

      await r.app.startBackgroundIndexing();
      await r.settle();

      // Nothing is due -> no run at all -> the pipeline is never entered.
      expect(r.pd.analysed).toEqual([]);
      expect(r.budgets).toEqual([]);
      expect(await r.db.queue.get("samples/done-1")).toMatchObject({
        status: "analyzed",
      });
    } finally {
      await r.db.db.close();
    }
  });

  it("7. does not block its caller: it resolves while the analysis is still running", async () => {
    const r = await rig();
    try {
      r.pd.hold();
      // The awaited promise settles after the SCAN, not after the run.
      const started = r.app.startBackgroundIndexing();
      await started;
      await waitFor(() => r.app.analysis.status === "running");
      expect(r.app.analysis.status).toBe("running");
      expect(r.app.backgroundIndexingTriggered).toBe(true);
      r.pd.release();
      await r.settle();
    } finally {
      r.pd.release();
      await r.db.db.close();
    }
  });

  it("8. picks up jobs a previous session left behind (reopen finishes the work)", async () => {
    const r = await rig({ scan: emptyScan });
    try {
      // Nothing new to discover, but a queued job survived the last session.
      await r.db.queue.enqueue("samples/left-over", BUILD);

      await r.app.startBackgroundIndexing();
      await r.settle();

      expect(r.scanCalls()).toBe(1);
      expect(r.budgets).toEqual([1000]);
      expect(r.pd.analysed).toEqual(["samples/left-over"]);
      expect(r.app.analysis.analyzed).toBe(1);
      // And the result is really persisted + searchable afterwards.
      expect(await r.db.index.get("samples/left-over")).toBeTruthy();
      expect(r.app.results.map((x) => x.record.sampleId)).toContain(
        "samples/left-over",
      );
    } finally {
      await r.db.db.close();
    }
  });

  it("9. starts no run when the scan found nothing and nothing is due", async () => {
    const r = await rig({ scan: emptyScan });
    try {
      await r.app.startBackgroundIndexing();
      await r.settle();
      expect(r.scanCalls()).toBe(1);
      expect(r.budgets).toEqual([]);
      expect(r.app.analysis.status).toBe("idle");
    } finally {
      await r.db.db.close();
    }
  });

  it("10. leaves the queue to a manual scan that is already in flight", async () => {
    const r = await rig();
    try {
      // A manual scan won the race: the automatic start must not analyse a
      // half-discovered queue on top of it.
      const manual = r.app.startScan();
      const automatic = r.app.startBackgroundIndexing();
      await Promise.all([manual, automatic]);
      await r.settle();

      expect(r.scanCalls()).toBe(1);
      expect(r.budgets).toEqual([]);
    } finally {
      await r.db.db.close();
    }
  });
});
