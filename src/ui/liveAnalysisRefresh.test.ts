import { describe, it, expect, vi, afterEach } from "vitest";
import { SampleMapApp } from "./app";
import type { SampleMapAppDeps } from "./app";
import { createMemoryEp7ConsentStore } from "./ep7Consent";
import { makeSample } from "../persistence/test-helpers";
import { SampleMapSearchEngine } from "../search/searchEngine";
import type { SearchQuery, SearchResult } from "../search/searchEngine";
import { JobRunner } from "../pipeline/jobRunner";
import type { AnalysisBudget, RunProgress } from "../pipeline/jobRunner";
import type { AnalysisOutcome } from "../pipeline/analysisPipeline";
import { openTestDatabase } from "../persistence/test-helpers";
import type { DatabaseHandle } from "../persistence/db";
import { mapPoints } from "./map/mapView";
import { makeFeatures } from "../classify/test-helpers";

const BUILD = "build-v1";

/**
 * Live result refresh during an analysis run.
 *
 * Regression cover for the audited defect: the analysis pipeline persists every
 * finished record immediately (`index.put(record)`), but the JobRunner only
 * resolved at the END of the whole run, so `app.results` — and with it the
 * result list and the map — stayed on the pre-run snapshot for the entire run.
 * After a reload all persisted records appeared, which made the missing live
 * update look like map data loss.
 *
 * Pinned here:
 *  1. a finished job reaches `app.results` while the run is still going,
 *  2. that happens COALESCED (time-bounded), never once per job,
 *  3. a stale, slower `refreshSearch()` cannot overwrite a newer snapshot.
 *
 * The JobRunner's own hook firing is covered by the second suite, which drives
 * the REAL runner against the REAL QueueStore.
 */

/** Mirrors the audited constant in app.ts; a coalescing window boundary. */
const LIVE_WINDOW_MS = 500;

const openHandles: DatabaseHandle[] = [];
function openDb(): Promise<DatabaseHandle> {
  return openTestDatabase().then((h) => {
    openHandles.push(h);
    return h;
  });
}
afterEach(async () => {
  vi.useRealTimers();
  const handles = openHandles.splice(0);
  await Promise.all(
    handles.map((h) =>
      h.db.close().catch(() => {
        // Closing an already-closed connection is safe.
      }),
    ),
  );
});

/** In-memory IndexStore source so the REAL search engine + mapPoints can run. */
function indexStub(records: () => ReturnType<typeof makeSample>[]) {
  return {
    getAll: async () => records(),
    get: async (id: string) => records().find((r) => r.sampleId === id),
  } as never;
}

/** A record shaped exactly like the pipeline's persisted output. */
function analyzedRecord(sampleId: string) {
  return makeSample(sampleId, {
    analysisBuild: BUILD,
    audioFeatures: makeFeatures(),
    mapPosition: { x: 0.4, y: 0.5 },
  });
}

/**
 * A runner double that reproduces the real JobRunner's observable contract for
 * the hook: it captures `onJobDone`, exposes a live progress snapshot, and
 * resolves `start()` only when the test ends the run.
 */
function makeLiveRunner() {
  const progress: RunProgress = {
    analyzed: 0,
    failed: 0,
    skipped: 0,
    gone: 0,
    stoppedReason: undefined,
  };
  let onJobDone: ((p: Readonly<RunProgress>) => void) | undefined;
  let resolveStart: ((p: RunProgress) => void) | undefined;
  let started = 0;

  const runner = {
    start: () => {
      started++;
      return new Promise<RunProgress>((res) => {
        resolveStart = res;
      });
    },
    pause: () => undefined,
    isRunning: () => true,
    isPaused: () => false,
    progressSnapshot: () => progress,
    lastStoppedReason: () => progress.stoppedReason,
    lastErrorReason: () => undefined,
  } as unknown as JobRunner;

  return {
    runner,
    startedCount: () => started,
    /** What bootstrap.ts forwards into the runner. */
    bind: (hook?: (p: Readonly<RunProgress>) => void) => {
      onJobDone = hook;
    },
    /** One job finished successfully; fires the hook exactly like the runner. */
    finishAnalyzed: (n = 1) => {
      progress.analyzed += n;
      onJobDone?.(progress);
    },
    /** One job failed. */
    finishFailed: (n = 1) => {
      progress.failed += n;
      onJobDone?.(progress);
    },
    /** The run ends -> start() resolves -> applyProgress(). */
    endRun: (stoppedReason: RunProgress["stoppedReason"] = "empty") => {
      progress.stoppedReason = stoppedReason;
      resolveStart?.(progress);
      return flush();
    },
  };
}

/**
 * Drains the pending microtask chain (the `start().then(applyProgress)` path
 * plus the search read). Uses microtasks rather than a timer so it works
 * unchanged under both real and fake timers.
 */
const flush = async () => {
  for (let i = 0; i < 32; i++) await Promise.resolve();
};

interface Rig {
  app: SampleMapApp;
  ctrl: ReturnType<typeof makeLiveRunner>;
  /** The persisted corpus the search engine reads from. */
  persisted: () => ReturnType<typeof analyzedRecord>[];
  searchCalls: () => number;
  mapPoints: () => number;
}

async function rig(
  opts: { searchImpl?: (q: SearchQuery) => Promise<SearchResult[]> } = {},
): Promise<Rig> {
  const records: ReturnType<typeof analyzedRecord>[] = [];
  const realSearch = new SampleMapSearchEngine(indexStub(() => records));
  const searchSpy = vi.fn(
    opts.searchImpl ?? ((q: SearchQuery) => realSearch.search(q)),
  );

  const ctrl = makeLiveRunner();
  const consent = createMemoryEp7ConsentStore();
  consent.grant();

  const deps: Partial<SampleMapAppDeps> = {
    queue: { enqueue: async () => "added" } as never,
    index: indexStub(() => records),
    search: { search: searchSpy } as never,
    preview: { dispose: () => undefined } as never,
    machiniste: { send: () => undefined } as never,
    createRunner: ((_budget: AnalysisBudget, onJobDone?: (p: Readonly<RunProgress>) => void) => {
      ctrl.bind(onJobDone);
      return ctrl.runner;
    }) as SampleMapAppDeps["createRunner"],
    fetchPage: (async () => ({ samples: [], nextPageToken: "" })) as never,
    known: { getUpdatedAt: async () => undefined },
    previewUrlFor: () => undefined,
    analysisBuild: BUILD,
    authenticatedUserId: "users/alice",
    ep7Consent: consent,
  };
  const app = new SampleMapApp(deps as SampleMapAppDeps);
  await app.refreshSearch();

  return {
    app,
    ctrl,
    persisted: () => records,
    searchCalls: () => searchSpy.mock.calls.length,
    mapPoints: () => mapPoints(app.results.map((r) => r.record)).length,
  };
}

describe("live result refresh during an analysis run", () => {
  it("shows a finished job while the run is still in flight (no waiting for run end)", async () => {
    vi.useFakeTimers();
    const r = await rig();

    void r.app.analyze(100);
    expect(r.app.analysis.status).toBe("running");

    // Job 1 finishes: the pipeline has already persisted the record.
    r.persisted().push(analyzedRecord("samples/a"));
    r.ctrl.finishAnalyzed();
    expect(r.persisted()).toHaveLength(1);

    // The run has NOT ended (start() still pending) — but the map catches up.
    expect(r.app.analysis.status).toBe("running");
    await vi.advanceTimersByTimeAsync(LIVE_WINDOW_MS);

    expect(r.app.results).toHaveLength(1);
    expect(r.mapPoints()).toBe(1);
    expect(r.app.analysis.status).toBe("running");
  });

  it("propagates progress counters to the app during the run", async () => {
    vi.useFakeTimers();
    const r = await rig();

    void r.app.analyze(100);
    r.persisted().push(analyzedRecord("samples/a"), analyzedRecord("samples/b"));
    r.ctrl.finishAnalyzed(2);

    expect(r.app.analysis.analyzed).toBe(2);
    expect(r.app.analysis.failed).toBe(0);
    expect(r.app.analysis.status).toBe("running");

    await vi.advanceTimersByTimeAsync(LIVE_WINDOW_MS);
    expect(r.app.results).toHaveLength(2);
  });

  it("coalesces back-to-back jobs into far fewer refreshes than jobs", async () => {
    vi.useFakeTimers();
    const r = await rig();
    const before = r.searchCalls();

    void r.app.analyze(1000);
    // 40 jobs finish back-to-back, all inside one coalescing window.
    for (let i = 0; i < 40; i++) {
      r.persisted().push(analyzedRecord(`samples/s${i}`));
      r.ctrl.finishAnalyzed();
    }
    const during = r.searchCalls() - before;
    expect(during).toBe(0); // nothing rendered mid-burst

    await vi.advanceTimersByTimeAsync(LIVE_WINDOW_MS);
    const after = r.searchCalls() - before;

    // One refresh for the whole burst — NOT one per job.
    expect(after).toBe(1);
    expect(r.app.results).toHaveLength(40);
    expect(r.mapPoints()).toBe(40);
  });

  it("does not let an older slow refreshSearch overwrite a newer snapshot", async () => {
    const order: string[] = [];
    const r = await rig({
      // The OLDER call resolves LAST; the newer one resolves first.
      searchImpl: async (q: SearchQuery) => {
        if (q.text === "old") {
          await new Promise((res) => setTimeout(res, 60));
          order.push("old");
          return [];
        }
        await new Promise((res) => setTimeout(res, 5));
        order.push("new");
        return ["n0", "n1", "n2"].map((id) => ({
          record: makeSample(`samples/${id}`),
          score: 1,
        }));
      },
    });

    // Ignore the rig's boot-time refresh; only the two racing calls matter.
    order.length = 0;
    const older = r.app.setSearch("old"); // slower, resolves last, 0 hits
    await new Promise((res) => setTimeout(res, 1));
    const newer = r.app.setSearch(""); // faster, resolves first, 3 hits
    await Promise.all([older, newer]);
    await new Promise((res) => setTimeout(res, 150));

    expect(order).toEqual(["new", "old"]); // the stale response arrived last...
    expect(r.app.results).toHaveLength(3); // ...and was discarded
  });

  it("fully syncs app.results to the persisted corpus when the run ends", async () => {
    vi.useFakeTimers();
    const r = await rig();

    void r.app.analyze(100);
    for (let i = 0; i < 7; i++) r.persisted().push(analyzedRecord(`samples/s${i}`));
    r.ctrl.finishAnalyzed(7);

    await vi.advanceTimersByTimeAsync(LIVE_WINDOW_MS);
    await r.ctrl.endRun();

    expect(r.app.analysis.status).toBe("stopped");
    expect(r.app.results).toHaveLength(r.persisted().length);
    expect(r.app.results).toHaveLength(7);
    expect(r.mapPoints()).toBe(7);
  });

  it("cancels a pending live refresh when the run ends (no late double render)", async () => {
    vi.useFakeTimers();
    const r = await rig();

    void r.app.analyze(100);
    r.persisted().push(analyzedRecord("samples/a"));
    r.ctrl.finishAnalyzed();

    // The run ends BEFORE the coalescing window elapses.
    await r.ctrl.endRun();
    expect(r.app.analysis.status).toBe("stopped");
    const afterEnd = r.searchCalls();

    // The cancelled timer must not fire later.
    await vi.advanceTimersByTimeAsync(LIVE_WINDOW_MS * 2);
    expect(r.searchCalls()).toBe(afterEnd);
    expect(r.app.results).toHaveLength(1);
  });

  it("ignores a late job hook that would move the progress display backwards", async () => {
    vi.useFakeTimers();
    const r = await rig();

    void r.app.analyze(100);
    r.persisted().push(analyzedRecord("samples/a"), analyzedRecord("samples/b"));
    r.ctrl.finishAnalyzed(2);
    await r.ctrl.endRun();
    expect(r.app.analysis.status).toBe("stopped");

    // A straggler callback after the run ended must not revive the run state.
    r.ctrl.finishAnalyzed();
    expect(r.app.analysis.status).toBe("stopped");
    expect(r.app.analysis.analyzed).toBe(2);
  });

  it("drops a pending live refresh on dispose (teardown safety)", async () => {
    vi.useFakeTimers();
    const r = await rig();

    void r.app.analyze(100);
    r.persisted().push(analyzedRecord("samples/a"));
    r.ctrl.finishAnalyzed();

    r.app.dispose();
    const afterDispose = r.searchCalls();
    await vi.advanceTimersByTimeAsync(LIVE_WINDOW_MS * 2);
    expect(r.searchCalls()).toBe(afterDispose);
  });
});

/** A pipeline double whose per-job completion the test releases, job by job. */
function gatedPipeline(index: { put: (r: unknown) => Promise<void> }) {
  const gates: Array<() => void> = [];
  const pipeline = {
    run: vi.fn(async (sampleId: string): Promise<AnalysisOutcome> => {
      await new Promise<void>((resolve) => gates.push(resolve));
      // Mirror production: the record is persisted BEFORE the job reports done.
      await index.put(analyzedRecord(sampleId));
      return { status: "analyzed" };
    }),
  };
  /** Waits until a job is actually blocked, then releases it. */
  const releaseNext = async () => {
    for (let i = 0; i < 500 && gates.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 1));
    }
    expect(gates.length).toBeGreaterThan(0);
    gates.shift()?.();
  };
  return { pipeline, releaseNext };
}

describe("JobRunner onJobDone hook (real runner, real QueueStore)", () => {
  it("fires once per job with the live progress snapshot", async () => {
    const handle = await openDb();
    const { pipeline, releaseNext } = gatedPipeline(handle.index as never);
    const seen: number[] = [];
    const runner = new JobRunner({
      pipeline: pipeline as never,
      queue: handle.queue as never,
      analysisBuild: BUILD,
      onJobDone: (p) => seen.push(p.analyzed),
    });
    for (let i = 0; i < 3; i++) await handle.queue.enqueue(`samples/s${i}`, BUILD);

    const run = runner.start();
    await releaseNext();
    await releaseNext();
    await releaseNext();
    await run;

    expect(seen).toEqual([1, 2, 3]);
    expect((await handle.index.getAll()).length).toBe(3);
  });

  it("does not let a throwing consumer break the queue (per-job isolation)", async () => {
    const handle = await openDb();
    const { pipeline, releaseNext } = gatedPipeline(handle.index as never);
    const runner = new JobRunner({
      pipeline: pipeline as never,
      queue: handle.queue as never,
      analysisBuild: BUILD,
      onJobDone: () => {
        throw new Error("consumer exploded");
      },
    });
    await handle.queue.enqueue("samples/a", BUILD);
    await handle.queue.enqueue("samples/b", BUILD);

    const run = runner.start();
    await releaseNext();
    await releaseNext();
    const progress = await run;

    expect(progress.analyzed).toBe(2);
  });

  it("keeps markFailed behaviour intact and still notifies", async () => {
    const handle = await openDb();
    const seen: Array<{ analyzed: number; failed: number }> = [];
    const run_ = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed" as const, error: "boom" })
      .mockResolvedValueOnce({ status: "analyzed" as const });
    const runner = new JobRunner({
      pipeline: { run: run_ } as never,
      queue: handle.queue as never,
      analysisBuild: BUILD,
      onJobDone: (p) => seen.push({ analyzed: p.analyzed, failed: p.failed }),
    });
    await handle.queue.enqueue("samples/a", BUILD);
    await handle.queue.enqueue("samples/b", BUILD);

    const progress = await runner.start();

    expect(progress.analyzed).toBe(1);
    expect(progress.failed).toBe(1);
    expect(seen).toEqual([
      { analyzed: 0, failed: 1 },
      { analyzed: 1, failed: 1 },
    ]);
    const failed = (await handle.queue.all()).find((j) => j.sampleId === "samples/a");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("boom");
  });
});
