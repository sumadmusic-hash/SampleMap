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
import { makeSampleMeta } from "../library/test-helpers";

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

/**
 * Same, for conditions that need a real IndexedDB round trip. A bare
 * `queue.get(...) !== undefined` would be a Promise (always truthy) and could
 * pass without the state ever having been reached.
 */
async function waitForAsync(
  pred: () => Promise<boolean>,
  ms = 3000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("waitForAsync timed out");
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

// ─────────────────────────────────────────────────────────────────────────────
// STEP80 — public discovery ↔ analysis coordination.
//
// Regression cover for the double-start bug in `runPublicDiscoveryRound()`:
// `analyze()` starts the JobRunner ITSELF, so the extra `runner.start()` threw
// "job runner is already running" and the follow-up analysis of newly
// discovered public jobs never happened.
//
// These tests use the REAL JobRunner over the REAL QueueStore + IndexStore on
// fake-indexeddb, the REAL `discoverPublicSamples()` (via a real `PageFetcher`),
// and only double the analysis PIPELINE — so "was something analysed?" and
// "how many runs were started?" are answered by real state, not by a stub.
// ─────────────────────────────────────────────────────────────────────────────

interface DiscoveryRig extends Rig {
  /** The public samples the fake `PageFetcher` will serve. */
  setListing: (metas: SampleMeta[]) => void;
  /** Max number of concurrently running pipelines observed. */
  maxParallelRuns: () => number;
  /** How often `start()` was called on a JobRunner (one per real run). */
  startCalls: () => number;
  /**
   * Pin the public listing open, so the discovery round can be made to finish
   * AFTER the automatic analysis run has already ended. This is the
   * deterministic trigger for the double start: no run is in flight any more,
   * so `runPublicDiscoveryRound()` takes its `analyze()` branch and — with the
   * bug — additionally calls `runner.start()` on the runner `analyze()` just
   * started itself.
   */
  holdDiscovery: () => void;
  releaseDiscovery: () => void;
}

async function discoveryRig(opts: { hold?: boolean } = {}): Promise<DiscoveryRig> {
  const handle = await openDb();
  const budgets: AnalysisBudget[] = [];
  const order: string[] = [];
  const pd = makePipelineDouble(handle.index as never);
  if (opts.hold) pd.hold();

  // Track real pipeline concurrency: `run()` is only entered while a runner is
  // actually working, so overlapping entries prove parallel analysis runs.
  let inFlight = 0;
  let maxParallel = 0;
  const inner = (pd.pipeline as unknown as { run: (id: string) => unknown }).run;
  (pd.pipeline as unknown as { run: (id: string) => unknown }).run = async (id: string) => {
    inFlight += 1;
    maxParallel = Math.max(maxParallel, inFlight);
    try {
      return await inner(id);
    } finally {
      inFlight -= 1;
    }
  };

  // Count `start()` invocations on the REAL JobRunner. A double start would
  // show up here as 2 starts for one run (and the real runner would throw
  // "job runner is already running").
  let starts = 0;

  // The public listing the REAL discovery module will walk.
  let listing: SampleMeta[] = [makeSampleMeta("samples/public-1")];
  // Lets a test hold the discovery round open (see `holdDiscovery`).
  let discoveryGate: Promise<void> | undefined;
  let openDiscovery: (() => void) | undefined;

  const scanResult: LibraryScanResult = {
    added: [meta("samples/new-1")],
    changed: [],
    unchangedCount: 0,
    seenSampleIds: ["samples/new-1"],
    pageCount: 1,
    latestKnown: "2026-01-01T00:00:00.000Z",
    fullScan: true,
  };
  let scanCalls = 0;

  const consent = createMemoryEp7ConsentStore();
  consent.grant();

  const deps: Partial<SampleMapAppDeps> = {
    queue: handle.queue,
    index: handle.index,
    // STEP80: enable the public discovery round with the REAL shared db handle
    // (the very same `ElasticDB` the stores use — no second database).
    dbForDiscovery: handle.db,
    search: new SampleMapSearchEngine(handle.index) as never,
    preview: { dispose: () => undefined } as never,
    machiniste: { send: () => undefined } as never,
    createRunner: ((budget: AnalysisBudget) => {
      budgets.push(budget);
      order.push("analyze");
      const runner = new JobRunner({
        pipeline: pd.pipeline,
        queue: handle.queue,
        analysisBuild: BUILD,
        budget,
      });
      const realStart = runner.start.bind(runner);
      runner.start = (() => {
        starts += 1;
        return realStart();
      }) as typeof runner.start;
      return runner;
    }) as SampleMapAppDeps["createRunner"],
    scanFn: (async () => {
      scanCalls++;
      order.push("scan");
      return scanResult;
    }) as never,
    // REAL `PageFetcher` contract, one page, no token → discovery exhausts.
    fetchPage: (async () => {
      if (discoveryGate) await discoveryGate;
      return { samples: listing, nextPageToken: "" };
    }) as never,
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
    holdScan: () => undefined,
    releaseScan: () => undefined,
    settle: async () => {
      for (let i = 0; i < 400; i++) {
        if (app.analysis.status !== "running") return;
        await new Promise((r) => setTimeout(r, 2));
      }
      throw new Error("analysis run did not settle");
    },
    setListing: (metas) => {
      listing = metas;
    },
    maxParallelRuns: () => maxParallel,
    startCalls: () => starts,
    holdDiscovery: () => {
      discoveryGate = new Promise<void>((res) => {
        openDiscovery = res;
      });
    },
    releaseDiscovery: () => {
      discoveryGate = undefined;
      openDiscovery?.();
    },
  };
}

describe("STEP80 public discovery ↔ analysis coordination", () => {
  it("A. starts the analysis exactly once (no double start of the runner)", async () => {
    const r = await discoveryRig();
    try {
      await r.app.startBackgroundIndexing();
      await r.settle();

      // One runner created, one analysis run. Both the own scan job and the
      // discovered public job were analysed by that single run.
      expect(r.budgets).toEqual([BACKGROUND_INDEXING_BUDGET]);
      expect(r.pd.analysed.sort()).toEqual(["samples/new-1", "samples/public-1"]);
      // The direct regression assertion: `start()` was called EXACTLY ONCE.
      // With the old code the discovery round started the runner a second time
      // (which the real JobRunner rejects with "job runner is already running").
      expect(r.startCalls()).toBe(1);
      expect(r.maxParallelRuns()).toBe(1);
      expect(r.app.analysis.analyzed).toBe(2);
    } finally {
      await r.db.db.close();
    }
  });

  it("A2. no double start when discovery finds due work AFTER a run already ended", async () => {
    // This is the exact shape of the STEP80 bug: the discovery round completes
    // while NO run is in flight, so it takes the `analyze()` branch — and with
    // the bug additionally called `runner.start()` on the very runner that
    // `analyze()` had just started itself.
    const r = await discoveryRig();
    try {
      r.holdDiscovery();

      await r.app.startBackgroundIndexing();
      // The automatic run for the own scan job runs and finishes while the
      // discovery round is still waiting on the listing.
      await waitFor(() => r.app.analysis.status !== "running");
      expect(r.pd.analysed).toEqual(["samples/new-1"]);
      expect(r.startCalls()).toBe(1);

      // Release discovery: it enqueues samples/public-1, no run is in flight,
      // so it starts exactly ONE run and must NOT start it a second time.
      r.releaseDiscovery();
      await waitFor(() =>
        r.pd.analysed.includes("samples/public-1"),
      );
      await r.settle();
      await flush();

      // Two runs total (one for the own job, one for the discovered job) and
      // exactly two `start()` calls — no extra, rejected second start.
      expect(r.startCalls()).toBe(2);
      expect(r.budgets).toEqual([
        BACKGROUND_INDEXING_BUDGET,
        BACKGROUND_INDEXING_BUDGET,
      ]);
      expect(r.maxParallelRuns()).toBe(1);
      expect((await r.db.queue.get("samples/public-1"))?.status).toBe("analyzed");
    } finally {
      r.releaseDiscovery();
      await r.db.db.close();
    }
  });

  it("B. discovery during a running analysis starts NO parallel run", async () => {
    const r = await discoveryRig({ hold: true });
    try {
      // Start the automatic workflow; the pipeline is HELD, so the background
      // run is genuinely in flight while discovery is still working.
      await r.app.startBackgroundIndexing();
      await waitFor(() => r.app.analysis.status === "running");
      await waitForAsync(
        async () => (await r.db.queue.get("samples/public-1")) !== undefined,
      );

      // The held run is still on samples/new-1; the discovered job is queued
      // but NOT yet consumed. Exactly one runner exists.
      expect(r.budgets).toEqual([BACKGROUND_INDEXING_BUDGET]);
      expect((await r.db.queue.get("samples/public-1"))?.status).toBe("queued");

      r.pd.release();
      await r.settle();
      await flush();

      // Never two runs at the same time, and still only one run: the running
      // one absorbed the discovered job through its own nextDue loop.
      expect(r.startCalls()).toBe(1);
      expect(r.maxParallelRuns()).toBe(1);
      expect(r.budgets).toEqual([BACKGROUND_INDEXING_BUDGET]);
      expect(r.pd.analysed.sort()).toEqual(["samples/new-1", "samples/public-1"]);
    } finally {
      r.pd.release();
      await r.db.db.close();
    }
  });

  it("B2. a run that ends with the discovered job still due triggers EXACTLY ONE follow-up", async () => {
    const r = await discoveryRig({ hold: true });
    try {
      await r.app.startBackgroundIndexing();
      await waitFor(() => r.app.analysis.status === "running");
      await waitForAsync(
        async () => (await r.db.queue.get("samples/public-1")) !== undefined,
      );

      // Pause the in-flight run so it stops WITHOUT consuming the discovered
      // job. This is the "run finished, discovery's job still due" window.
      r.app.pause();
      r.pd.release();
      await waitFor(() => r.app.analysis.status !== "running");

      // The discovered job is still due: exactly ONE follow-up run picks it up.
      await waitFor(() => r.pd.analysed.includes("samples/public-1"));
      await r.settle();
      await flush();

      // Two runs total (the paused one + exactly one follow-up), each started
      // exactly once, and never two at the same time.
      expect(r.startCalls()).toBe(2);
      expect(r.budgets).toEqual([
        BACKGROUND_INDEXING_BUDGET,
        BACKGROUND_INDEXING_BUDGET,
      ]);
      expect(r.maxParallelRuns()).toBe(1);
      expect((await r.db.queue.get("samples/public-1"))?.status).toBe("analyzed");
    } finally {
      r.pd.release();
      await r.db.db.close();
    }
  });

  it("C. discovery that adds no new jobs starts NO additional analysis run", async () => {
    const r = await discoveryRig();
    try {
      // The public sample is already known locally, so discovery enqueues
      // nothing: it must not trigger any extra run on top of the automatic one.
      await r.db.queue.enqueue("samples/public-1", BUILD);
      const job = await r.db.queue.get("samples/public-1");
      await r.db.queue.markAnalyzed(job!);

      await r.app.startBackgroundIndexing();
      await r.settle();
      await flush();

      // Only the own scan job produced a run; discovery added nothing.
      expect(r.startCalls()).toBe(1);
      expect(r.budgets).toEqual([BACKGROUND_INDEXING_BUDGET]);
      expect(r.pd.analysed).toEqual(["samples/new-1"]);
      expect(r.maxParallelRuns()).toBe(1);
    } finally {
      await r.db.db.close();
    }
  });

  it("D. a second automatic start creates NO additional parallel analysis run", async () => {
    const r = await discoveryRig({ hold: true });
    try {
      await Promise.all([
        r.app.startBackgroundIndexing(),
        r.app.startBackgroundIndexing(),
      ]);
      await r.app.startBackgroundIndexing();
      await waitFor(() => r.app.analysis.status === "running");
      // Wait until the held pipeline was really entered, so the concurrency
      // counter below has actually observed the run.
      await waitFor(() => r.pd.analysed.length > 0);

      // One scan, one runner, one start — the repeats collapsed into the same run.
      expect(r.scanCalls()).toBe(1);
      expect(r.startCalls()).toBe(1);
      expect(r.budgets).toEqual([BACKGROUND_INDEXING_BUDGET]);
      expect(r.maxParallelRuns()).toBe(1);

      r.pd.release();
      await r.settle();
      expect(r.startCalls()).toBe(1);
      expect(r.budgets).toEqual([BACKGROUND_INDEXING_BUDGET]);
      expect(r.pd.analysed.sort()).toEqual(["samples/new-1", "samples/public-1"]);
    } finally {
      r.pd.release();
      await r.db.db.close();
    }
  });

  it("E. does not re-analyze already analyzed samples (discovery + scan idempotency)", async () => {
    const r = await discoveryRig();
    try {
      // A completed job of the SAME build for the discovered public sample.
      await r.db.queue.enqueue("samples/public-1", BUILD);
      const done = await r.db.queue.get("samples/public-1");
      await r.db.queue.markAnalyzed(done!);

      await r.app.startBackgroundIndexing();
      await r.settle();
      await flush();

      // The public sample was never analysed again; only the new own sample.
      expect(r.startCalls()).toBe(1);
      expect(r.pd.analysed).toEqual(["samples/new-1"]);
      expect((await r.db.queue.get("samples/public-1"))?.status).toBe("analyzed");
      expect(r.budgets).toEqual([BACKGROUND_INDEXING_BUDGET]);
    } finally {
      await r.db.db.close();
    }
  });
});
