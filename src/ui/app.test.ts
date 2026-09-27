import { describe, it, expect, vi, afterEach } from "vitest";
import type { SampleMeta } from "@audiotool/nexus/api";
import type { SampleListPage } from "../library/libraryScanner";
import { SampleMapApp } from "./app";
import type { SampleMapAppDeps } from "./app";
import { createMemoryEp7ConsentStore, type Ep7ConsentStore } from "./ep7Consent";
import type { SampleIndexRecord } from "../persistence/indexStore";
import type { AudioFeatures } from "../persistence/indexStore";
import { openTestDatabase, makeSample } from "../persistence/test-helpers";
import type { DatabaseHandle } from "../persistence/db";
import { SampleMapSearchEngine } from "../search/searchEngine";
import type { SearchQuery, SearchResult } from "../search/searchEngine";
import { PreviewService } from "../preview/previewService";
import type { BlobUrlApi } from "../preview/previewService";
import { SampleMapMachinisteService } from "../machiniste/machinisteService";
import type { JobRunner, RunProgress, AnalysisBudget } from "../pipeline/jobRunner";
import { MAX_BATCH_SLOTS } from "../machiniste/machinisteService";
import type { LibraryScanResult } from "../library/libraryScanner";
import { mapPoints } from "./map/mapView";
import {
  defaultMapCamera,
  panBy,
  MAP_WIDTH,
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEP,
} from "./map/mapView";
import { computeSimilarityFingerprint } from "../similarity/similarityFingerprint";
import { kickFeatures, makeFeatures } from "../classify/test-helpers";
import { GlobalPublishQueue } from "../global/publishQueue";
import type { GlobalSampleIndex } from "../global/contract";

const BUILD = "build-v1";

/**
 * STEP19A E-P7 — a granted in-memory consent store. Shared by the general
 * rigs so existing send tests stay focused on the send; the E-P7 suite builds
 * deliberately ungranted stores.
 */
function grantedEp7Consent() {
  const store = createMemoryEp7ConsentStore();
  store.grant();
  return store;
}

/** Tracks every IndexedDB handle opened during tests so afterEach can close them. */
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
        // Closing an already-closed connection is safe; ignore any race here.
      }),
    ),
  );
});

function makeFakeBlobUrlApi() {
  let counter = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  const api: BlobUrlApi = {
    createObjectURL: () => `blob:fake-${counter++}`,
    revokeObjectURL: (u) => {
      revoked.push(u);
    },
  };
  return { api, created, revoked };
}

function makeFakePreview() {
  const calls: string[] = [];
  const { api, revoked } = makeFakeBlobUrlApi();
  const preview = new PreviewService({
    blobUrl: api,
    fetchFn: async (url) => {
      calls.push(url);
      return { blob: async () => ({ type: "audio/mpeg", size: 1 } as Blob) };
    },
    audioFactory: () => ({
      play: () => Promise.resolve(),
      pause: () => {},
      ended: false,
      onended: null,
      onerror: null,
      src: "",
    }),
  });
  return { preview, calls, revoked, api };
}

/** Controllable fake JobRunner; start() resolves only when we resolve it. */
function makeFakeRunner(progress: RunProgress) {
  const calls = { start: 0, pause: 0, budget: undefined as AnalysisBudget | undefined };
  let resolveStart: ((p: RunProgress) => void) | undefined;
  const runner = {
    start: () => {
      calls.start++;
      return new Promise<RunProgress>((res) => {
        resolveStart = res;
      });
    },
    pause: () => {
      calls.pause++;
    },
    isRunning: () => true,
    isPaused: () => false,
    progressSnapshot: () => progress,
    lastStoppedReason: () => undefined,
    lastErrorReason: () => undefined,
  } as unknown as JobRunner;
  const settle = (p?: RunProgress) => {
    resolveStart?.(p ?? progress);
    return flush();
  };
  return { runner, calls, settle };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function defaultProgress(over: Partial<RunProgress> = {}): RunProgress {
  return { analyzed: 0, failed: 0, skipped: 0, gone: 0, stoppedReason: undefined, ...over };
}

const META_A: SampleMeta = {
  name: "samples/a",
  displayName: "Kick A",
  description: "",
  ownerName: "users/alice",
  favoritedByUser: false,
  numFavorites: 0,
  numUsages: 0,
  bpm: 0,
  kind: "one-shot",
  visibility: "public",
  tags: ["kick"],
  createTime: undefined,
  updateTime: undefined,
  durationSeconds: 1,
  mp3Url: "https://cdn/a.mp3",
  wavUrl: "https://cdn/a.wav",
  flacUrl: "https://cdn/a.flac",
  previewMp3Url: "https://cdn/a-preview.mp3",
  getWaveformUrl: () => "https://cdn/a.wave",
};

interface Rig {
  app: SampleMapApp;
  search: { search: ReturnType<typeof vi.fn> };
  preview: ReturnType<typeof makeFakePreview>;
  machinisteSend: ReturnType<typeof vi.fn>;
  createRunnerCalls: AnalysisBudget[];
  index: SampleIndexSource;
  queue: RigQueue;
  db: { close(): Promise<void> };
}

interface SampleIndexSource {
  put(record: SampleIndexRecord): Promise<void>;
  get(id: string): Promise<SampleIndexRecord | undefined>;
}
interface RigQueue {
  enqueue(sampleId: string, analysisBuild: string, priorityGroup?: number): Promise<"added" | "existing">;
  countByStatus(status: string): Promise<number>;
}

const scanResult: LibraryScanResult = {
  added: [META_A],
  changed: [],
  unchangedCount: 0,
  seenSampleIds: ["samples/a"],
  pageCount: 1,
  latestKnown: "2026-01-01T00:00:00.000Z",
  fullScan: true,
};

/** fetchPage that respects the new filter option used by STEP62 own-pass. */
function defaultFetchPage(opts?: { filter?: string }): Promise<SampleListPage> {
  // When a filter is supplied, apply owner matching against the fixture samples.
  // The filter format is CEL: `sample.owner_name == "users/{slug}"`.
  // The test fixture has one sample (META_A) with ownerName "users/alice".
  if (opts?.filter) {
    const match = opts.filter.match(/sample\.owner_name\s*==\s*"([^"]+)"/);
    if (match) {
      const ownerName = match[1];
      // The fixture sample META_A has ownerName "users/alice".
      if (ownerName === "users/alice") return Promise.resolve({ samples: [META_A], nextPageToken: "" });
    }
    // Filter supplied but didn't match the known fixture — return empty.
    return Promise.resolve({ samples: [], nextPageToken: "" });
  }
  // No filter — return the default single-sample result.
  return Promise.resolve({ samples: [META_A], nextPageToken: "" });
}
    // Filter supplied but didn't match the known fixture — return empty.

async function mk(over: Partial<SampleMapAppDeps> = {}): Promise<Rig> {
  const handle = await openDb();
  const index: SampleIndexSource = handle.index;
  const queue: RigQueue = handle.queue;

  const search = {
    search: vi.fn(async (): Promise<SearchResult[]> => []),
  };
  const searchEngine = search as unknown as SampleMapSearchEngine;

  const preview = makeFakePreview();
  const machinisteSend = vi.fn();
  const machiniste = { send: machinisteSend } as unknown as SampleMapMachinisteService;

  const createRunnerCalls: AnalysisBudget[] = [];
  const mkRunner = vi.fn((budget: AnalysisBudget) => {
    createRunnerCalls.push(budget);
    return makeFakeRunner(defaultProgress({ stoppedReason: "budget" })).runner;
  });

const deps: SampleMapAppDeps = {
    queue: queue as never,
    index: index as never,
    search: searchEngine,
    preview: preview.preview,
    machiniste,
    createRunner: mkRunner as (budget: AnalysisBudget) => JobRunner,
    scanFn: async () => scanResult,
    fetchPage: async () => defaultFetchPage({}),
    known: { getUpdatedAt: async () => undefined },
    previewUrlFor: (r) => `https://cdn/${r.sampleId}.mp3`,
    analysisBuild: BUILD,
    scanMaxSamples: 200,
    authenticatedUserId: "users/alice",
    // STEP19A E-P7: existing sendToMachiniste tests exercise the send, so the
    // shared harness pre-grants the one-time consent (the guard is asserted
    // separately in the dedicated E-P7 suite with an explicit ungranted store).
    ep7Consent: grantedEp7Consent(),
    ...over,
  };
  const app = new SampleMapApp(deps);
  return { app, search, preview, machinisteSend, createRunnerCalls, index, queue, db: handle.db };
}

describe("SampleMap UI : start + empty state", () => {
  it("UI starts in a safe idle state with empty results (no crash)", async () => {
    const { app, db } = await mk();
    try {
      expect(app.scan.status).toBe("idle");
      expect(app.analysis.status).toBe("idle");
      expect(app.results).toEqual([]);
      expect(app.machiniste.error).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("handles empty search results cleanly", async () => {
    const { app, db, search } = await mk();
    try {
      search.search.mockResolvedValueOnce([]);
      await app.setSearch("nothing-matches");
      expect(app.results).toEqual([]);
      expect(app.results.length).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : library scan", () => {
  it("library scan can be started; it enqueues new samples into the queue", async () => {
    const { app, db, queue } = await mk();
    try {
      const enqueueSpy = vi.spyOn(queue, "enqueue");
      await app.startScan();
      expect(app.scan.status).toBe("done");
      expect(app.scan.foundCount).toBe(1);
      expect(enqueueSpy).toHaveBeenCalledWith("samples/a", BUILD, 0);
      expect(await queue.countByStatus("queued")).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("surfaces scan errors in scan state", async () => {
    const { app, db } = await mk({
      scanFn: async () => {
        throw new Error("library listing failed");
      },
    });
    try {
      await app.startScan();
      expect(app.scan.status).toBe("error");
      expect(app.scan.error).toMatch(/library listing failed/);
    } finally {
      await db.close();
    }
  });

  it("stopScan is a safe no-op when not scanning and stays idle", async () => {
    const { app, db } = await mk();
    try {
      app.stopScan();
      expect(app.scan.status).toBe("idle");
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : metadata-only refresh (bpm/numFavorites/numUsages)", () => {
  it("refreshes the metadata slice on an existing record, leaving analysis fields untouched", async () => {
    const existing = makeSample("samples/a", {
      bpm: 90,
      numFavorites: 3,
      numUsages: 5,
      primaryClass: "kick",
      confidence: 0.91,
    });
    existing.audioFeatures = { ...existing.audioFeatures };
    const frozen = {
      primaryClass: existing.primaryClass,
      confidence: existing.confidence,
      audioFeatures: existing.audioFeatures,
      mapPosition: existing.mapPosition,
      analyzedAt: existing.analyzedAt,
      analysisBuild: existing.analysisBuild,
    };

    const fresh: SampleMeta = {
      ...META_A,
      bpm: 128,
      numFavorites: 42,
      numUsages: 187,
    };
    const scanFn = vi.fn(
      async (): Promise<LibraryScanResult> => ({
        added: [],
        changed: [fresh],
        unchangedCount: 0,
        seenSampleIds: [fresh.name],
        pageCount: 1,
        latestKnown: "2026-02-01T00:00:00.000Z",
        fullScan: true,
      }),
    );

    const { app, db, index, queue, createRunnerCalls } = await mk({ scanFn });
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    try {
      await index.put(existing);
      const putSpy = vi.spyOn(index, "put");
      expect((await index.get("samples/a"))!.bpm).toBe(90);

      await app.startScan();
      expect(app.scan.status).toBe("done");

      const rec = await index.get("samples/a");
      // Metadata slice updated.
      expect(rec!.bpm).toBe(128);
      expect(rec!.numFavorites).toBe(42);
      expect(rec!.numUsages).toBe(187);
      // Analysis fields preserved verbatim — NO re-analysis.
      expect(rec!.primaryClass).toBe(frozen.primaryClass);
      expect(rec!.confidence).toBe(frozen.confidence);
      expect(rec!.audioFeatures).toEqual(frozen.audioFeatures);
      expect(rec!.mapPosition).toEqual(frozen.mapPosition);
      expect(rec!.analyzedAt).toBe(frozen.analyzedAt);
      expect(rec!.analysisBuild).toBe(frozen.analysisBuild);

      // NO analysis/re-fetch chain: startScan enqueues the changed sample by
      // design, but the metadata refresh itself never reaches the analysis
      // pipeline (no runner is ever created) and makes exactly ONE store write.
      expect(createRunnerCalls).toEqual([]);
      expect(enqueueSpy).toHaveBeenCalledWith("samples/a", BUILD, 0);
      expect(putSpy).toHaveBeenCalledTimes(1);
      expect(putSpy.mock.calls[0][0].bpm).toBe(128);
    } finally {
      await db.close();
    }
  });

  it("a partial fresh meta updates only the fields it carries (no data loss)", async () => {
    const existing = makeSample("samples/a", {
      bpm: 90,
      numFavorites: 3,
      numUsages: 5,
    });
    // Fresh meta carries ONLY bpm — favorites/usages are not refreshed and must
    // NOT be clobbered to undefined.
    const fresh: SampleMeta = {
      ...META_A,
      bpm: 111,
      numFavorites: undefined as never,
      numUsages: undefined as never,
    };
    const scanFn = vi.fn(
      async (): Promise<LibraryScanResult> => ({
        added: [],
        changed: [fresh],
        unchangedCount: 0,
        seenSampleIds: [fresh.name],
        pageCount: 1,
        latestKnown: "2026-02-01T00:00:00.000Z",
        fullScan: true,
      }),
    );

    const { app, db, index } = await mk({ scanFn });
    try {
      await index.put(existing);
      await app.startScan();
      const rec = await index.get("samples/a");
      expect(rec!.bpm).toBe(111);
      expect(rec!.numFavorites).toBe(3);
      expect(rec!.numUsages).toBe(5);
    } finally {
      await db.close();
    }
  });

  it("bpm 0 on a fresh meta is preserved as a source value after refresh", async () => {
    const existing = makeSample("samples/a", { bpm: 90, numFavorites: 2, numUsages: 4 });
    const fresh: SampleMeta = { ...META_A, bpm: 0, numFavorites: 2, numUsages: 4 };
    const scanFn = vi.fn(
      async (): Promise<LibraryScanResult> => ({
        added: [],
        changed: [fresh],
        unchangedCount: 0,
        seenSampleIds: [fresh.name],
        pageCount: 1,
        latestKnown: "2026-02-01T00:00:00.000Z",
        fullScan: true,
      }),
    );
    const { app, db, index } = await mk({ scanFn });
    try {
      await index.put(existing);
      await app.startScan();
      expect((await index.get("samples/a"))!.bpm).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : analysis budget mode (INV-3)", () => {
  it.each([10, 100, 1000] as AnalysisBudget[])("Analyse %i starts a runner with budget %i", async (budget) => {
    const { app, db, createRunnerCalls } = await mk();
    try {
      app.analyze(budget);
      expect(createRunnerCalls).toEqual([budget]);
      expect(app.analysis.budget).toBe(budget);
      expect(app.analysis.status).toBe("running");
    } finally {
      await db.close();
    }
  });

  it("reports analyzed/remaining after a budgeted run completes", async () => {
    const { db } = await mk();
    try {
      const fake = makeFakeRunner(defaultProgress({ analyzed: 10, stoppedReason: "budget" }));
      const app2 = new SampleMapApp({
        queue: (await openDb()).queue as never,
        search: {} as never,
        preview: new PreviewService(),
        machiniste: {} as never,
        createRunner: () => fake.runner,
        fetchPage: async () => ({ samples: [], nextPageToken: "" }),
        known: { getUpdatedAt: async () => undefined },
        previewUrlFor: () => undefined,
        analysisBuild: BUILD,
      });
      app2.analyze(100);
      await fake.settle();
      expect(app2.analysis.status).toBe("stopped");
      expect(app2.analysis.analyzed).toBe(10);
      expect(app2.remainingBudget).toBe(90);
      expect(app2.analysis.stoppedReason).toBe("budget");
    } finally {
      await db.close();
    }
  });

  // SM-AUDIT-005 regression: repeated analyze() while running must not create
  // concurrent runners.
  it("rapid repeated analyze() calls do not create concurrent runners", async () => {
    const { db } = await mk();
    try {
      const calls = { start: 0 };
      let resolveStart: ((p: RunProgress) => void) | undefined;
      const runner = {
        start: () => {
          calls.start++;
          return new Promise<RunProgress>((res) => { resolveStart = res; });
        },
        pause: () => {},
        isRunning: () => true,
        isPaused: () => false,
        progressSnapshot: () => defaultProgress(),
        lastStoppedReason: () => undefined,
        lastErrorReason: () => undefined,
      } as unknown as JobRunner;
      const createRunner = vi.fn(() => runner);
      const app2 = new SampleMapApp({
        queue: (await openDb()).queue as never,
        search: {} as never,
        preview: new PreviewService(),
        machiniste: {} as never,
        createRunner,
        fetchPage: async () => ({ samples: [], nextPageToken: "" }),
        known: { getUpdatedAt: async () => undefined },
        previewUrlFor: () => undefined,
        analysisBuild: BUILD,
      });
      // First call creates and starts the runner.
      const first = app2.analyze(10);
      expect(createRunner).toHaveBeenCalledTimes(1);
      expect(calls.start).toBe(1);
      // Second call while running returns the same runner without a new start().
      const second = app2.analyze(100);
      expect(second).toBe(first);
      expect(createRunner).toHaveBeenCalledTimes(1);
      expect(calls.start).toBe(1);
      // Third call also returns the same runner.
      const third = app2.analyze(1000);
      expect(third).toBe(first);
      expect(createRunner).toHaveBeenCalledTimes(1);
      resolveStart?.(defaultProgress({ analyzed: 5, stoppedReason: "budget" }));
      await flush();
      expect(app2.analysis.status).toBe("stopped");
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : pause / resume", () => {
  it("pause delegates to the job runner", async () => {
    const { db } = await mk();
    try {
      const fake = makeFakeRunner(defaultProgress({ stoppedReason: "pause" }));
      const app2 = new SampleMapApp({
        queue: (await openDb()).queue as never,
        search: {} as never,
        preview: new PreviewService(),
        machiniste: {} as never,
        createRunner: () => fake.runner,
        fetchPage: async () => ({ samples: [], nextPageToken: "" }),
        known: { getUpdatedAt: async () => undefined },
        previewUrlFor: () => undefined,
        analysisBuild: BUILD,
      });
      app2.analyze(10);
      app2.pause();
      expect(fake.calls.pause).toBe(1);
      await fake.settle(defaultProgress({ analyzed: 2, stoppedReason: "pause" }));
      expect(app2.analysis.status).toBe("paused");
    } finally {
      await db.close();
    }
  });

  it("resume starts a new run on the same runner (persisted queue continues)", async () => {
    const { db } = await mk();
    try {
      const fake = makeFakeRunner(defaultProgress());
      const app2 = new SampleMapApp({
        queue: (await openDb()).queue as never,
        search: {} as never,
        preview: new PreviewService(),
        machiniste: {} as never,
        createRunner: () => fake.runner,
        fetchPage: async () => ({ samples: [], nextPageToken: "" }),
        known: { getUpdatedAt: async () => undefined },
        previewUrlFor: () => undefined,
        analysisBuild: BUILD,
      });
      app2.analyze(10);
      await fake.settle(defaultProgress({ analyzed: 2, stoppedReason: "pause" }));
      await fake.settle(defaultProgress({ analyzed: 5, stoppedReason: "pause" }));
      app2.resume();
      expect(fake.calls.start).toBeGreaterThanOrEqual(2);
      await fake.settle(defaultProgress({ analyzed: 9, stoppedReason: "budget" }));
      expect(app2.analysis.status).toBe("stopped");
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : search / filter / sort delegation", () => {
  it("passes the text query to the SearchEngine", async () => {
    const { app, db, search } = await mk();
    try {
      await app.setSearch("kick 01");
      const q: SearchQuery = search.search.mock.calls[0][0];
      expect(q.text).toBe("kick 01");
    } finally {
      await db.close();
    }
  });

  it("passes the class filter to the SearchEngine", async () => {
    const { app, db, search } = await mk();
    try {
      await app.setClasses(["kick"]);
      await app.setClasses(["drums", "snare"]);
      const q: SearchQuery = search.search.mock.calls[1][0];
      expect(q.classes).toEqual(["drums", "snare"]);
    } finally {
      await db.close();
    }
  });

  it("passes the confidence filter to the SearchEngine", async () => {
    const { app, db, search } = await mk();
    try {
      await app.setMinConfidence(0.9);
      const q: SearchQuery = search.search.mock.calls[0][0];
      expect(q.minConfidence).toBe(0.9);
      await app.setMinConfidence(undefined);
      const q2: SearchQuery = search.search.mock.calls[1][0];
      expect(q2.minConfidence).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("passes sort to the SearchEngine", async () => {
    const { app, db, search } = await mk();
    try {
      await app.setSort("confidence", "desc");
      await app.setSort("name", "asc");
      const q: SearchQuery = search.search.mock.calls[1][0];
      expect(q.sortBy).toBe("name");
      expect(q.sortDir).toBe("asc");
    } finally {
      await db.close();
    }
  });

  it("drives the real SearchEngine over a seeded index (end-to-end filter)", async () => {
    const { index, db } = { ...(await openTestDatabase()) } as never as {
      index: SampleIndexSource;
      db: { close(): Promise<void> };
    };
    try {
      await index.put(makeSample("samples/kick1", { primaryClass: "kick", confidence: 0.95, name: "Hard Kick" }));
      await index.put(makeSample("samples/snare1", { primaryClass: "snare", confidence: 0.7, name: "Snap" }));
      const realSearch = new SampleMapSearchEngine(index as never);
      const app = new SampleMapApp({
        queue: (await openDb()).queue as never,
        search: realSearch,
        preview: new PreviewService(),
        machiniste: {} as never,
        createRunner: (() => makeFakeRunner(defaultProgress()).runner) as never,
        fetchPage: async () => ({ samples: [], nextPageToken: "" }),
        known: { getUpdatedAt: async () => undefined },
        previewUrlFor: () => undefined,
        analysisBuild: BUILD,
      });
      await app.setClasses(["kick"]);
      expect(app.results.map((r) => r.record.sampleId)).toEqual(["samples/kick1"]);
      await app.setMinConfidence(0.8);
      expect(app.results.map((r) => r.record.sampleId)).toEqual(["samples/kick1"]);
      await app.setMinConfidence(0.99);
      expect(app.results).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : details + preview", () => {
  it("focussing a sample shows it as the inspector target (focus source)", async () => {
    const { app, db } = await mk();
    try {
      const rec = makeSample("samples/a");
      app.selectSample(rec);
      expect(app.focusedSampleId).toBe("samples/a");
      expect(app.focusedRecord?.sampleId).toBe("samples/a");
      expect(app.selectedSampleIds).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("preview is triggered through PreviewService (which owns ObjectURLs)", async () => {
    const { app, db, preview } = await mk();
    try {
      const rec = makeSample("samples/a");
      await app.togglePreview(rec);
      expect(preview.calls).toContain("https://cdn/samples/a.mp3");
      expect(app.previewSampleId).toBe("samples/a");
      // Toggling again stops the current preview and revokes the ObjectURL.
      await app.togglePreview(rec);
      expect(app.previewSampleId).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("surfaces preview errors without crashing", async () => {
    const { app, db } = await mk({
      previewUrlFor: () => undefined,
    });
    try {
      await app.togglePreview(makeSample("samples/a"));
      expect(app.previewError).toMatch(/no preview url/);
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : send to machiniste", () => {
  it("send uses MachinisteService with mapped samples -> slots", async () => {
    const { app, db, machinisteSend } = await mk();
    try {
      const r1 = makeSample("samples/k1", { name: "K1" });
      const r2 = makeSample("samples/k2", { name: "K2" });
      app.toggleMultiSelect(r1);
      app.toggleMultiSelect(r2);
      await app.sendToMachiniste("mach-1", 0);
      expect(machinisteSend).toHaveBeenCalledWith(
        ["samples/k1", "samples/k2"],
        "mach-1",
        [0, 1],
      );
      expect(app.machiniste.error).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("never sends more than MAX_BATCH_SLOTS in one call", async () => {
    const { app, db, machinisteSend } = await mk();
    try {
      const many = Array.from({ length: MAX_BATCH_SLOTS + 3 }, (_, i) =>
        makeSample(`samples/extra${i}`),
      );
      for (const r of many) app.toggleMultiSelect(r);
      // the selection is capped at MAX_BATCH_SLOTS by the controller.
      expect(app.selectedSampleIds.length).toBe(MAX_BATCH_SLOTS);
      await app.sendToMachiniste("mach-1", 0);
      const argSamples = machinisteSend.mock.calls[0][0] as string[];
      const argSlots = machinisteSend.mock.calls[0][2] as number[];
      expect(argSamples.length).toBe(MAX_BATCH_SLOTS);
      expect(argSlots.length).toBe(MAX_BATCH_SLOTS);
    } finally {
      await db.close();
    }
  });

  it("displays a machiniste error when the service reports one", async () => {
    const { app, db, machinisteSend } = await mk();
    try {
      machinisteSend.mockResolvedValueOnce({
        machinisteId: "mach-1",
        committed: false,
        slots: [],
        errors: ["transaction rejected: nope"],
      });
      app.toggleMultiSelect(makeSample("samples/a"));
      await app.sendToMachiniste("mach-1", 0);
      expect(app.machiniste.lastResult?.errors).toContain("transaction rejected: nope");
      expect(app.machiniste.lastResult?.committed).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("displays a thrown machiniste error", async () => {
    const { app, db, machinisteSend } = await mk();
    try {
      machinisteSend.mockRejectedValueOnce(new Error("machiniste not found"));
      app.toggleMultiSelect(makeSample("samples/a"));
      await app.sendToMachiniste("mach-1", 0);
      expect(app.machiniste.error).toMatch(/machiniste not found/);
    } finally {
      await db.close();
    }
  });

  it("requires a selection before sending", async () => {
    const { app, db, machinisteSend } = await mk();
    try {
      await app.sendToMachiniste("mach-1", 0);
      expect(machinisteSend).not.toHaveBeenCalled();
      expect(app.machiniste.error).toMatch(/no sample selected/);
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : E-P7 one-time consent gate (STEP19A §19.5)", () => {
  /** A fresh, deliberately UN-granted store for the guard tests. */
  function newUngranted() {
    return createMemoryEp7ConsentStore();
  }

  it("E-P7-01: first send raises the dialog and performs NO send", async () => {
    const { app, db, machinisteSend } = await mk({ ep7Consent: newUngranted() });
    try {
      app.toggleMultiSelect(makeSample("samples/a"));
      await app.sendToMachiniste("mach-1", 0);
      expect(app.ep7ConsentRequired).toBe(true);
      expect(app.ep7ConsentError).toBeUndefined();
      expect(machinisteSend).not.toHaveBeenCalled();
      expect(app.machiniste.error).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("E-P7-02: acceptance persists the preference and resumes the send EXACTLY once", async () => {
    const consent = newUngranted();
    const { app, db, machinisteSend } = await mk({ ep7Consent: consent });
    try {
      const r1 = makeSample("samples/k1", { name: "K1" });
      const r2 = makeSample("samples/k2", { name: "K2" });
      app.toggleMultiSelect(r1);
      app.toggleMultiSelect(r2);
      await app.sendToMachiniste("mach-1", 0);
      expect(app.ep7ConsentRequired).toBe(true);

      app.grantEp7Consent();

      expect(consent.isGranted()).toBe(true);
      expect(app.ep7ConsentRequired).toBe(false);
      // The suspended call resumed with the SAME mapping.
      expect(machinisteSend).toHaveBeenCalledTimes(1);
      expect(machinisteSend).toHaveBeenCalledWith(
        ["samples/k1", "samples/k2"],
        "mach-1",
        [0, 1],
      );

      // A later send is not gated again (one-time).
      machinisteSend.mockClear();
      await app.sendToMachiniste("mach-1", 0);
      expect(app.ep7ConsentRequired).toBe(false);
      expect(machinisteSend).toHaveBeenCalledTimes(1);
    } finally {
      await db.close();
    }
  });

  it("E-P7-03: cancel drops the pending send (0 continuation) and grants nothing", async () => {
    const consent = newUngranted();
    const { app, db, machinisteSend } = await mk({ ep7Consent: consent });
    try {
      app.toggleMultiSelect(makeSample("samples/a"));
      await app.sendToMachiniste("mach-1", 0);
      expect(app.ep7ConsentRequired).toBe(true);

      app.denyEp7Consent();

      expect(app.ep7ConsentRequired).toBe(false);
      expect(consent.isGranted()).toBe(false);
      expect(machinisteSend).not.toHaveBeenCalled();
      expect(app.machiniste.error).toBeUndefined();

      // Retry re-raises the dialog (the gate is re-armed after cancel).
      await app.sendToMachiniste("mach-1", 0);
      expect(app.ep7ConsentRequired).toBe(true);
      expect(machinisteSend).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  });

  it("E-P7-04: a storage write failure keeps consent un-granted, keeps the dialog, never sends", async () => {
    const failing: Ep7ConsentStore = {
      isGranted: () => false,
      grant: () => {
        throw new Error("QuotaExceeded");
      },
      clear: () => {},
    };
    const { app, db, machinisteSend } = await mk({ ep7Consent: failing });
    try {
      app.toggleMultiSelect(makeSample("samples/a"));
      await app.sendToMachiniste("mach-1", 0);
      expect(app.ep7ConsentRequired).toBe(true);

      app.grantEp7Consent();

      // Still gated: no consent, dialog stays, action never executed.
      expect(app.ep7ConsentRequired).toBe(true);
      expect(app.ep7ConsentError).toMatch(/consent could not be stored/);
      expect(machinisteSend).not.toHaveBeenCalled();

      // The error is retryable — a later Cancel still clears cleanly.
      app.denyEp7Consent();
      expect(app.ep7ConsentRequired).toBe(false);
      expect(app.ep7ConsentError).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("E-P7-05: no selection short-circuits BEFORE the consent gate (even un-granted)", async () => {
    const { app, db, machinisteSend } = await mk({ ep7Consent: newUngranted() });
    try {
      await app.sendToMachiniste("mach-1", 0);
      expect(app.machiniste.error).toMatch(/no sample selected/);
      expect(app.ep7ConsentRequired).toBe(false);
      expect(machinisteSend).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  });

  it("E-P7-06: grant with no pending send only persists (idempotent); deny without a dialog is a no-op", async () => {
    const consent = newUngranted();
    const onChange = vi.fn();
    const { app, db } = await mk({ ep7Consent: consent, onChange });
    try {
      app.grantEp7Consent();
      expect(consent.isGranted()).toBe(true);
      expect(app.ep7ConsentRequired).toBe(false);

      onChange.mockClear();
      app.denyEp7Consent();
      expect(onChange).not.toHaveBeenCalled();
      expect(consent.isGranted()).toBe(true); // deny never touches a granted store
      expect(app.ep7ConsentRequired).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("E-P7-07: already-granted apps send without ever raising the dialog", async () => {
    const { app, db, machinisteSend } = await mk(); // mk() grants by default
    try {
      app.toggleMultiSelect(makeSample("samples/a"));
      await app.sendToMachiniste("mach-1", 0);
      expect(app.ep7ConsentRequired).toBe(false);
      expect(machinisteSend).toHaveBeenCalledTimes(1);
      expect(app.machiniste.error).toBeUndefined();
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : selection cap (BUG #2 / STEP16V)", () => {
  it("clicking an 8th+ sample never grows the selection: stays capped, still focused, render notified", async () => {
    const onChange = vi.fn();
    const { app, db } = await mk({ onChange });
    try {
      const many = Array.from({ length: MAX_BATCH_SLOTS + 2 }, (_, i) =>
        makeSample(`samples/cap${i}`),
      );
      for (const r of many.slice(0, MAX_BATCH_SLOTS)) app.toggleMultiSelect(r);
      const before = app.selectedSampleIds.length;
      expect(before).toBe(MAX_BATCH_SLOTS);
      onChange.mockClear();

      const extra = many[MAX_BATCH_SLOTS];
      app.toggleMultiSelect(extra);

      // Cap holds — the selection is untouched by the 9th add.
      expect(app.selectedSampleIds.length).toBe(MAX_BATCH_SLOTS);
      expect(app.selectedSampleIds).not.toContain(extra.sampleId);
      // Focus still follows the click (Cmd/Ctrl-click focuses the clicked sample).
      expect(app.focusedSampleId).toBe(extra.sampleId);
      // The render notification ALWAYS fires on a click, so the DOM checkbox can
      // never disagree with `selectedSampleIds` (BUG #2: no early return w/o render).
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      await db.close();
    }
  });

  it("at the cap, deselecting one frees a slot for the next add", async () => {
    const { app, db } = await mk();
    try {
      const many = Array.from({ length: MAX_BATCH_SLOTS + 1 }, (_, i) =>
        makeSample(`samples/free${i}`),
      );
      const first = many[0];
      for (const r of many.slice(0, MAX_BATCH_SLOTS)) app.toggleMultiSelect(r);

      // Deselect the first → slot freed.
      app.toggleMultiSelect(first);
      expect(app.selectedSampleIds.length).toBe(MAX_BATCH_SLOTS - 1);

      // Add the 9th sample → now accepted within the cap.
      app.toggleMultiSelect(many[MAX_BATCH_SLOTS]);
      expect(app.selectedSampleIds.length).toBe(MAX_BATCH_SLOTS);
      expect(app.selectedSampleIds).toContain(many[MAX_BATCH_SLOTS].sampleId);
      expect(app.selectedSampleIds).not.toContain(first.sampleId);
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : no audio bytes persisted (INV-1)", () => {
  it("scan only enqueues sampleId strings (never audio byte containers)", async () => {
    const { app, db, queue } = await mk();
    try {
      const enqueueSpy = vi.spyOn(queue, "enqueue");
      await app.startScan();
      for (const call of enqueueSpy.mock.calls) {
        const [sampleId, build, priorityGroup] = call as unknown as [string, string, number];
        expect(typeof sampleId).toBe("string");
        expect(sampleId.startsWith("samples/")).toBe(true);
        expect(build).toBe(BUILD);
        expect(typeof priorityGroup).toBe("number");
        expect(sampleId).not.toBeInstanceOf(ArrayBuffer);
      }
    } finally {
      await db.close();
    }
  });

  it("the index store still refuses audio byte containers (guard intact)", async () => {
    const { index, db } = { ...(await openTestDatabase()) } as never as {
      index: SampleIndexSource & { put(r: SampleIndexRecord): Promise<void> };
      db: { close(): Promise<void> };
    };
    try {
      const bad = makeSample("samples/a");
      (bad as unknown as { audio: ArrayBuffer }).audio = new ArrayBuffer(8);
      await expect(index.put(bad as never)).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : Step 15D search integration", () => {
  it("clearSearch resets every criterion and reloads a full result set", async () => {
    const { db } = await mk();
    try {
      // Seed two visible results through the real SearchEngine.
      const handle = await openDb();
      await handle.index.put(makeSample("samples/a", { primaryClass: "kick", name: "K A" }));
      await handle.index.put(makeSample("samples/b", { primaryClass: "bass", name: "Boost" }));
      const realSearch = new SampleMapSearchEngine(handle.index as never);
      const app2 = new SampleMapApp({
        queue: {} as never,
        search: realSearch,
        preview: new PreviewService(),
        machiniste: {} as never,
        createRunner: (() => makeFakeRunner(defaultProgress()).runner) as never,
        fetchPage: async () => ({ samples: [], nextPageToken: "" }),
        known: { getUpdatedAt: async () => undefined },
        previewUrlFor: () => undefined,
        analysisBuild: BUILD,
      });
      await app2.setSearch("K");
      expect(app2.results.map((r) => r.record.sampleId).sort()).toEqual(["samples/a"]);
      await app2.setMinConfidence(0.99);
      expect(app2.results).toEqual([]);
      await app2.clearSearch();
      expect(app2.searchState.text).toBe("");
      expect(app2.searchState.classes).toEqual([]);
      expect(app2.searchState.minConfidence).toBeUndefined();
      expect(app2.results.map((r) => r.record.sampleId).sort()).toEqual([
        "samples/a",
        "samples/b",
      ]);
    } finally {
      await db.close();
    }
  });

  it("search text is forwarded to the SearchEngine", async () => {
    const { app, db, search } = await mk();
    try {
      await app.setSearch("808");
      const q: SearchQuery = search.search.mock.calls[0][0];
      expect(q.text).toBe("808");
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : Step 15D selection vs filtering", () => {
  it("a selected sample hidden by a filter REMAINS selected (visibility ≠ selection)", async () => {
    const { db } = await mk();
    try {
      const kick = makeSample("samples/kick1", { primaryClass: "kick", name: "Hard Kick" });
      const bass = makeSample("samples/bass1", { primaryClass: "bass", name: "Bassline" });
      const handle = await openDb();
      await handle.index.put(kick);
      await handle.index.put(bass);
      const realSearch = new SampleMapSearchEngine(handle.index as never);
      const app2 = new SampleMapApp({
        queue: {} as never,
        search: realSearch,
        preview: new PreviewService(),
        machiniste: {} as never,
        createRunner: (() => makeFakeRunner(defaultProgress()).runner) as never,
        fetchPage: async () => ({ samples: [], nextPageToken: "" }),
        known: { getUpdatedAt: async () => undefined },
        previewUrlFor: () => undefined,
        analysisBuild: BUILD,
      });
      await app2.clearSearch();
      app2.selectSample(makeSample("samples/bass1", { primaryClass: "bass" }));
      app2.toggleMultiSelect(makeSample("samples/bass1", { primaryClass: "bass" }));
      expect(app2.focusedSampleId).toBe("samples/bass1");
      expect(app2.selectedSampleIds).toEqual(["samples/bass1"]);
      // Filtering to kick hides bass1 -> selection AND focus must NOT be cleared.
      await app2.setClasses(["kick"]);
      expect(app2.results.map((r) => r.record.sampleId)).toEqual(["samples/kick1"]);
      expect(app2.selectedSampleIds).toEqual(["samples/bass1"]);
      expect(app2.focusedSampleId).toBe("samples/bass1");
    } finally {
      await db.close();
    }
  });

  it("a focused sample that stays visible keeps its focus", async () => {
    const { db } = await mk();
    try {
      const kick = makeSample("samples/kick1", { primaryClass: "kick", name: "Hard Kick" });
      const handle = await openDb();
      await handle.index.put(kick);
      const realSearch = new SampleMapSearchEngine(handle.index as never);
      const app2 = new SampleMapApp({
        queue: {} as never,
        search: realSearch,
        preview: new PreviewService(),
        machiniste: {} as never,
        createRunner: (() => makeFakeRunner(defaultProgress()).runner) as never,
        fetchPage: async () => ({ samples: [], nextPageToken: "" }),
        known: { getUpdatedAt: async () => undefined },
        previewUrlFor: () => undefined,
        analysisBuild: BUILD,
      });
      await app2.clearSearch();
      app2.selectSample(makeSample("samples/kick1", { primaryClass: "kick" }));
      await app2.setClasses(["kick"]);
      expect(app2.focusedSampleId).toBe("samples/kick1");
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : Phase 1 focus vs selection contract", () => {
  it("1. single click focuses without selecting", async () => {
    const { app, db } = await mk();
    try {
      const a = makeSample("samples/a");
      app.selectSample(a);
      expect(app.focusedSampleId).toBe("samples/a");
      expect(app.selectedSampleIds).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("2. Cmd/Ctrl-click selects (and focuses)", async () => {
    const { app, db } = await mk();
    try {
      const a = makeSample("samples/a");
      app.toggleMultiSelect(a);
      expect(app.focusedSampleId).toBe("samples/a");
      expect(app.selectedSampleIds).toEqual(["samples/a"]);
    } finally {
      await db.close();
    }
  });

  it("3. Cmd/Ctrl-click toggles off", async () => {
    const { app, db } = await mk();
    try {
      const a = makeSample("samples/a");
      app.toggleMultiSelect(a);
      expect(app.selectedSampleIds).toEqual(["samples/a"]);
      app.toggleMultiSelect(a);
      expect(app.focusedSampleId).toBe("samples/a");
      expect(app.selectedSampleIds).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("4. focus can differ from selection", async () => {
    const { app, db } = await mk();
    try {
      const a = makeSample("samples/a");
      const b = makeSample("samples/b");
      app.toggleMultiSelect(a); // select A
      app.selectSample(b); // click B -> focus only
      expect(app.focusedSampleId).toBe("samples/b");
      expect(app.selectedSampleIds).toEqual(["samples/a"]);
    } finally {
      await db.close();
    }
  });

  it("5. multiple selection accumulates in order", async () => {
    const { app, db } = await mk();
    try {
      app.toggleMultiSelect(makeSample("samples/a"));
      app.toggleMultiSelect(makeSample("samples/b"));
      app.toggleMultiSelect(makeSample("samples/c"));
      expect(app.selectedSampleIds).toEqual(["samples/a", "samples/b", "samples/c"]);
    } finally {
      await db.close();
    }
  });

  it("6. selection is capped at MAX_BATCH_SLOTS (original 8 remain)", async () => {
    const { app, db } = await mk();
    try {
      const many = Array.from({ length: MAX_BATCH_SLOTS + 3 }, (_, i) =>
        makeSample(`samples/sel${i}`),
      );
      for (const r of many) app.toggleMultiSelect(r);
      const firstEight = many.slice(0, MAX_BATCH_SLOTS).map((r) => r.sampleId);
      expect(app.selectedSampleIds.length).toBe(MAX_BATCH_SLOTS);
      expect(app.selectedSampleIds).toEqual(firstEight);
    } finally {
      await db.close();
    }
  });

  it("7. search does not clear selection", async () => {
    const { db } = await mk();
    try {
      const a = makeSample("samples/a", { primaryClass: "kick", name: "Kick A" });
      const b = makeSample("samples/b", { primaryClass: "bass", name: "Boost" });
      const handle = await openDb();
      await handle.index.put(a);
      await handle.index.put(b);
      const realSearch = new SampleMapSearchEngine(handle.index as never);
      const app2 = new SampleMapApp({
        queue: {} as never,
        search: realSearch,
        preview: new PreviewService(),
        machiniste: {} as never,
        createRunner: (() => makeFakeRunner(defaultProgress()).runner) as never,
        fetchPage: async () => ({ samples: [], nextPageToken: "" }),
        known: { getUpdatedAt: async () => undefined },
        previewUrlFor: () => undefined,
        analysisBuild: BUILD,
      });
      await app2.clearSearch();
      app2.toggleMultiSelect(a);
      app2.toggleMultiSelect(b);
      expect(app2.selectedSampleIds).toEqual(["samples/a", "samples/b"]);
      await app2.setSearch("Kick");
      expect(app2.results.map((r) => r.record.sampleId)).toEqual(["samples/a"]);
      expect(app2.selectedSampleIds).toEqual(["samples/a", "samples/b"]);
    } finally {
      await db.close();
    }
  });

  it("8. zoom/pan does not clear selection", async () => {
    const { app, db } = await mk();
    try {
      app.toggleMultiSelect(makeSample("samples/a"));
      app.toggleMultiSelect(makeSample("samples/b"));
      app.zoomMapBy(ZOOM_STEP, { x: 200, y: 150 });
      app.setMapCamera({ zoom: 3, panX: 40, panY: -20 });
      app.resetMapView();
      expect(app.selectedSampleIds).toEqual(["samples/a", "samples/b"]);
    } finally {
      await db.close();
    }
  });

  it("9. Machiniste requires explicit selection (focus alone does NOT send)", async () => {
    const { app, db, machinisteSend } = await mk();
    try {
      app.selectSample(makeSample("samples/a"));
      expect(app.focusedSampleId).toBe("samples/a");
      expect(app.selectedSampleIds).toEqual([]);
      await app.sendToMachiniste("mach-1", 0);
      expect(machinisteSend).not.toHaveBeenCalled();
      expect(app.machiniste.error).toMatch(/no sample selected/);
    } finally {
      await db.close();
    }
  });

  it("10. Machiniste sends the selection, not the focused sample", async () => {
    const { app, db, machinisteSend } = await mk();
    try {
      const a = makeSample("samples/a");
      const b = makeSample("samples/b");
      const c = makeSample("samples/c");
      app.toggleMultiSelect(a);
      app.toggleMultiSelect(b);
      app.selectSample(c); // focus C, not part of the selection
      expect(app.focusedSampleId).toBe("samples/c");
      expect(app.selectedSampleIds).toEqual(["samples/a", "samples/b"]);
      await app.sendToMachiniste("mach-1", 0);
      expect(machinisteSend).toHaveBeenCalledWith(
        ["samples/a", "samples/b"],
        "mach-1",
        [0, 1],
      );
      expect(machinisteSend.mock.calls[0][0]).not.toContain("samples/c");
    } finally {
      await db.close();
    }
  });

  it("11. clearSelection (Esc) clears ONLY the selection, never focus/search", async () => {
    const { db } = await mk();
    try {
      const handle = await openDb();
      const a = makeSample("samples/a", { primaryClass: "kick", name: "Kick A" });
      const b = makeSample("samples/b", { primaryClass: "bass", name: "Boost" });
      await handle.index.put(a);
      await handle.index.put(b);
      const app2 = new SampleMapApp({
        queue: {} as never,
        search: new SampleMapSearchEngine(handle.index as never),
        preview: new PreviewService(),
        machiniste: {} as never,
        createRunner: (() => makeFakeRunner(defaultProgress()).runner) as never,
        fetchPage: async () => ({ samples: [], nextPageToken: "" }),
        known: { getUpdatedAt: async () => undefined },
        previewUrlFor: () => undefined,
        analysisBuild: BUILD,
      });
      await app2.setSearch("Kick"); // active search + filter state
      app2.toggleMultiSelect(a); // select A (also focuses A)
      app2.toggleMultiSelect(b); // select B (B is filtered OUT of results)
      app2.selectSample(a); // focus A (click = focus only)
      expect(app2.focusedSampleId).toBe("samples/a");
      expect(app2.selectedSampleIds).toEqual(["samples/a", "samples/b"]);

      app2.clearSelection();

      expect(app2.selectedSampleIds).toEqual([]);
      expect(app2.focusedSampleId).toBe("samples/a"); // focus kept
      expect(app2.searchState.text).toBe("Kick"); // search kept
      expect(app2.searchState.classes).toEqual([]); // untouched
      expect(app2.results.map((r) => r.record.sampleId)).toEqual(["samples/a"]);

      // Idempotent: calling again with nothing selected is a no-op.
      app2.clearSelection();
      expect(app2.selectedSampleIds).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : Step 15D position independence", () => {
  it("a sample keeps the exact same relative position regardless of result count", async () => {
    const { db } = await mk();
    try {
      const handle = await openDb();
      const recA = makeSample("samples/a", {
        primaryClass: "kick",
        // V2: the persisted map position is a fixed analysis result; A sits at
        // (0.25, 0.25) regardless of which other samples are in the result set.
        mapPosition: { x: 0.25, y: 0.25 },
      });
      const recB = makeSample("samples/b", { primaryClass: "snare" });
      const recC = makeSample("samples/c", { primaryClass: "bass" });
      const recD = makeSample("samples/d", { primaryClass: "hihat" });
      await handle.index.put(recA);
      await handle.index.put(recB);
      await handle.index.put(recC);
      await handle.index.put(recD);

      // Draw A against "[A]" alone.
      const solo = mapPoints([recA])[0];
      // Draw A against "[A, B, C, D]".
      const full = mapPoints([recA, recB, recC, recD])[0];

      expect(solo.sampleId).toBe("samples/a");
      expect(full.sampleId).toBe("samples/a");
      // Filtering must never change the relative position of a sample.
      expect(full.x).toBe(solo.x);
      expect(full.y).toBe(solo.y);
      expect(solo.x).toBeCloseTo(0.25, 12);
    } finally {
      await db.close();
    }
  });

  it("map position is never derived from the search score", async () => {
    const handle = await openTestDatabase();
    try {
      await handle.index.put(
        makeSample("samples/a", {
          audioFeatures: {
            ...makeSample("samples/a").audioFeatures,
            tonalNoiseRatio: 0.5,
            spectralCentroid: 1200,
          },
        }),
      );
      const search = new SampleMapSearchEngine(handle.index as never);
      const results = await search.search({});
      const rec = results[0].record;
      const pos = mapPoints([rec])[0];
      // Position equals the PERSISTED V2 mapPosition of this record — not score.
      expect(typeof results[0].score).toBe("number");
      expect(pos.x).toBe(rec.mapPosition!.x);
      expect(pos.y).toBe(rec.mapPosition!.y);
    } finally {
      await handle.db.close();
    }
  });
});

describe("SampleMap UI : Step 15E inspector preview lifecycle", () => {
  it("focussing a different sample stops a running preview of the previous one", async () => {
    const { app, db } = await mk();
    try {
      const a = makeSample("samples/a");
      const b = makeSample("samples/b");
      // Start preview on A.
      app.selectSample(a);
      await app.togglePreview(a);
      expect(app.previewSampleId).toBe("samples/a");
      // Focus B -> A's preview must be stopped (no longer the active preview).
      app.selectSample(b);
      expect(app.focusedSampleId).toBe("samples/b");
      expect(app.previewSampleId).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("filtering away a focused/selected sample does NOT clear it or stop its preview", async () => {
    const { db } = await mk();
    try {
      const kick = makeSample("samples/kick1", { primaryClass: "kick", name: "Hard Kick" });
      const bass = makeSample("samples/bass1", { primaryClass: "bass", name: "Bassline" });
      const handle = await openDb();
      await handle.index.put(kick);
      await handle.index.put(bass);
      const realSearch = new SampleMapSearchEngine(handle.index as never);
      const app2 = new SampleMapApp({
        queue: {} as never,
        search: realSearch,
        preview: new PreviewService({
          blobUrl: {
            createObjectURL: () => "blob:x",
            revokeObjectURL: () => undefined,
          },
          fetchFn: async () => ({ blob: async () => ({ type: "audio/mpeg", size: 1 } as Blob) }),
          audioFactory: () => ({
            play: () => Promise.resolve(),
            pause: () => {},
            ended: false,
            onended: null,
            onerror: null,
            src: "",
          }),
        }),
        machiniste: {} as never,
        createRunner: (() => makeFakeRunner(defaultProgress()).runner) as never,
        fetchPage: async () => ({ samples: [], nextPageToken: "" }),
        known: { getUpdatedAt: async () => undefined },
        previewUrlFor: (r) => `https://cdn/${r.sampleId}.mp3`,
        analysisBuild: BUILD,
      });
      await app2.clearSearch();
      app2.selectSample(bass);
      app2.toggleMultiSelect(bass);
      await app2.togglePreview(bass);
      expect(app2.previewSampleId).toBe("samples/bass1");
      expect(app2.selectedSampleIds).toEqual(["samples/bass1"]);
      // Filter to kick -> bass1 disappears -> focus, selection AND preview persist.
      await app2.setClasses(["kick"]);
      expect(app2.focusedSampleId).toBe("samples/bass1");
      expect(app2.selectedSampleIds).toEqual(["samples/bass1"]);
      expect(app2.previewSampleId).toBe("samples/bass1");
      expect(app2.results.map((r) => r.record.sampleId)).toEqual(["samples/kick1"]);
    } finally {
      await db.close();
    }
  });

  it("a preview error does not clear the focus or crash (inspector stays)", async () => {
    const { app, db } = await mk({ previewUrlFor: () => undefined });
    try {
      const rec = makeSample("samples/a");
      app.selectSample(rec);
      expect(app.focusedSampleId).toBe("samples/a");
      await app.togglePreview(rec);
      expect(app.previewError).toMatch(/no preview url/);
      // Focus still intact.
      expect(app.focusedSampleId).toBe("samples/a");
    } finally {
      await db.close();
    }
  });
});

// ─── SM-AUDIT-007: stale in-flight previews are discarded ────────────────────

describe("SampleMap UI : stale in-flight preview guard (SM-AUDIT-007)", () => {
  function makeDeferredPreview() {
    const calls: Array<{ url: string; resolve: () => void }> = [];
    const created: string[] = [];
    const revoked: string[] = [];
    const played: string[] = [];
    const preview = new PreviewService({
      blobUrl: {
        createObjectURL: () => {
          const u = `blob:race-${created.length}`;
          created.push(u);
          return u;
        },
        revokeObjectURL: (u) => revoked.push(u),
      },
      fetchFn: (url) =>
        new Promise((resolve) => {
          calls.push({
            url,
            resolve: () =>
              resolve({ blob: async () => ({ type: "audio/mpeg", size: 1 } as Blob) }),
          });
        }),
      audioFactory: (src) => {
        played.push(src);
        return {
          play: () => Promise.resolve(),
          pause: () => {},
          ended: false,
          onended: null,
          onerror: null,
          src,
        };
      },
    });
    return { preview, calls, created, revoked, played };
  }

  it("fetch resolving after a selection change is discarded: never adopted or played", async () => {
    const deferred = makeDeferredPreview();
    const { app, db } = await mk({ preview: deferred.preview });
    try {
      const a = makeSample("samples/a");
      const b = makeSample("samples/b");
      void app.togglePreview(a); // A's fetch is in-flight...
      expect(deferred.calls.length).toBe(1);
      app.selectSample(b); // ...user moves on (generation bumped).
      deferred.calls[0].resolve(); // A's fetch completes late.
      await flush();
      expect(app.previewSampleId).toBeUndefined();
      expect(deferred.created).toHaveLength(1);
      expect(deferred.revoked).toContain(deferred.created[0]); // URL revoked
      expect(deferred.played).toHaveLength(0); // never started playback
    } finally {
      await db.close();
    }
  });

  it("rapid replacement: the second preview wins, the stale first is discarded", async () => {
    const deferred = makeDeferredPreview();
    const { app, db } = await mk({ preview: deferred.preview });
    try {
      const a = makeSample("samples/a");
      const b = makeSample("samples/b");
      void app.togglePreview(a);
      void app.togglePreview(b);
      expect(deferred.calls.length).toBe(2);
      deferred.calls[0].resolve(); // A resolves late -> must be discarded
      await flush();
      expect(app.previewSampleId).toBeUndefined();
      deferred.calls[1].resolve(); // B resolves -> adopted
      await flush();
      expect(app.previewSampleId).toBe("samples/b");
      expect(deferred.played).toEqual([deferred.created[1]]);
      expect(deferred.revoked).toContain(deferred.created[0]);
      expect(deferred.revoked).not.toContain(deferred.created[1]);
    } finally {
      await db.close();
    }
  });

  it("stale fetch failure does not surface an error for the current (non-stale) intent", async () => {
    const deferred = makeDeferredPreview();
    const { app, db } = await mk({ preview: deferred.preview });
    try {
      const a = makeSample("samples/a");
      app.selectSample(a);
      void app.togglePreview(a); // in-flight
      app.selectSample(makeSample("samples/c")); // invalidates the request
      deferred.calls[0].resolve();
      await flush();
      expect(app.previewSampleId).toBeUndefined();
      expect(app.previewError).toBeUndefined();
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : map camera (Step 15F)", () => {
  it("starts at the default full-map view (zoom 1, no pan)", async () => {
    const { app, db } = await mk();
    try {
      expect(app.mapCamera).toEqual(defaultMapCamera());
    } finally {
      await db.close();
    }
  });

  it("zoomMapBy raises the zoom; repeated steps climb toward MAX_ZOOM", async () => {
    const { app, db } = await mk();
    try {
      app.zoomMapBy(ZOOM_STEP);
      expect(app.mapCamera.zoom).toBe(2);
      app.zoomMapBy(ZOOM_STEP);
      app.zoomMapBy(ZOOM_STEP);
      app.zoomMapBy(ZOOM_STEP);
      expect(app.mapCamera.zoom).toBe(MAX_ZOOM);
    } finally {
      await db.close();
    }
  });

  it("zoomMapBy with a pointer anchor keeps that base point fixed on screen", async () => {
    const { app, db } = await mk();
    try {
      const anchor = { x: 300, y: 200 };
      app.zoomMapBy(3, anchor);
      const baseX = (anchor.x - 0) / 1;
      const baseY = (anchor.y - 0) / 1;
      expect(baseX * app.mapCamera.zoom + app.mapCamera.panX).toBeCloseTo(anchor.x, 6);
      expect(baseY * app.mapCamera.zoom + app.mapCamera.panY).toBeCloseTo(anchor.y, 6);
    } finally {
      await db.close();
    }
  });

  it("setMapCamera honours clamped pan bounds", async () => {
    const { app, db } = await mk();
    try {
      app.setMapCamera({ zoom: 2, panX: -99999, panY: 99999 });
      expect(app.mapCamera.panX).toBe(MAP_WIDTH * (1 - 2));
      expect(app.mapCamera.panY).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("resetMapView restores the full map", async () => {
    const { app, db } = await mk();
    try {
      app.zoomMapBy(ZOOM_STEP, { x: 100, y: 90 });
      app.setMapCamera(panBy(app.mapCamera, 200, -150));
      app.resetMapView();
      expect(app.mapCamera).toEqual({ zoom: 1, panX: 0, panY: 0 });
    } finally {
      await db.close();
    }
  });

  it("zoom cannot leave [MIN_ZOOM, MAX_ZOOM]", async () => {
    const { app, db } = await mk();
    try {
      app.zoomMapBy(0.0001);
      expect(app.mapCamera.zoom).toBe(MIN_ZOOM);
      app.zoomMapBy(1e9);
      expect(app.mapCamera.zoom).toBe(MAX_ZOOM);
    } finally {
      await db.close();
    }
  });

  it("filtering changes the visible samples but NOT the camera", async () => {
    const { app, db } = await mk();
    try {
      app.zoomMapBy(ZOOM_STEP, { x: 200, y: 150 });
      const before = { ...app.mapCamera };
      await app.setClasses(["does-not-exist"]);
      expect(app.results).toEqual([]); // the filter changed the visible samples
      expect(app.mapCamera).toEqual(before); // the camera is untouched
      await app.clearSearch();
      expect(app.mapCamera).toEqual(before); // nor does clearing the filters
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : arrow-key point navigation (E-P5A T4)", () => {
  it("moves focus along the current result order and wraps at the ends", async () => {
    const { app, search, db } = await mk();
    try {
      const a = makeSample("samples/a", { name: "A" });
      const b = makeSample("samples/b", { name: "B" });
      const c = makeSample("samples/c", { name: "C" });
      search.search.mockResolvedValueOnce([
        { record: a, score: 1 },
        { record: b, score: 0.5 },
        { record: c, score: 0.2 },
      ]);
      await app.refreshSearch();
      expect(app.results.map((r) => r.record.sampleId)).toEqual([
        "samples/a",
        "samples/b",
        "samples/c",
      ]);

      // No focus yet: positive delta starts at the first result.
      app.focusAdjacent(1);
      expect(app.focusedSampleId).toBe("samples/a");
      app.focusAdjacent(1);
      expect(app.focusedSampleId).toBe("samples/b");
      app.focusAdjacent(1);
      expect(app.focusedSampleId).toBe("samples/c");
      app.focusAdjacent(1); // wraps to the first
      expect(app.focusedSampleId).toBe("samples/a");
      app.focusAdjacent(-1); // wraps to the last
      expect(app.focusedSampleId).toBe("samples/c");
    } finally {
      await db.close();
    }
  });

  it("enters at the last result when nothing is focused and the arrow is backward", async () => {
    const { app, search, db } = await mk();
    try {
      search.search.mockResolvedValueOnce([
        { record: makeSample("samples/a"), score: 1 },
        { record: makeSample("samples/b"), score: 0.5 },
      ]);
      await app.refreshSearch();
      app.focusAdjacent(-1);
      expect(app.focusedSampleId).toBe("samples/b");
    } finally {
      await db.close();
    }
  });

  it("never modifies the batch selection", async () => {
    const { app, search, db } = await mk();
    try {
      search.search.mockResolvedValueOnce([
        { record: makeSample("samples/a"), score: 1 },
        { record: makeSample("samples/b"), score: 0.5 },
      ]);
      await app.refreshSearch();
      app.focusAdjacent(1);
      app.focusAdjacent(1);
      app.focusAdjacent(-1);
      expect(app.focusedSampleId).toBe("samples/a");
      expect(app.selectedSampleIds).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("is a no-op when no records are visible", async () => {
    const { app, db } = await mk();
    try {
      app.focusAdjacent(1);
      app.focusAdjacent(-1);
      expect(app.focusedSampleId).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("a focus hidden by the current filter re-enters at the visible boundary", async () => {
    const { app, search, db } = await mk();
    try {
      const a = makeSample("samples/a");
      const b = makeSample("samples/b");
      search.search.mockResolvedValueOnce([
        { record: a, score: 1 },
        { record: b, score: 0.5 },
      ]);
      await app.refreshSearch();
      app.focusAdjacent(1);
      app.focusAdjacent(1);
      expect(app.focusedSampleId).toBe("samples/b");

      // The filter hides the focused sample; the next arrow re-enters visibly.
      search.search.mockResolvedValueOnce([{ record: a, score: 1 }]);
      await app.refreshSearch();
      expect(app.focusedSampleId).toBe("samples/b"); // focus never cleared
      app.focusAdjacent(1);
      expect(app.focusedSampleId).toBe("samples/a");
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : analysis runner rejection + fallback state", () => {
  it("a rejecting runner start ends in stopped status with an error (no crash)", async () => {
    const rejecting = {
      start: async () => {
        throw new Error("analysis crashed");
      },
      pause: () => {},
      isRunning: () => false,
      isPaused: () => false,
      progressSnapshot: () => defaultProgress(),
      lastStoppedReason: () => undefined,
      lastErrorReason: () => "analysis crashed",
    } as unknown as JobRunner;
    const { app, db } = await mk({ createRunner: () => rejecting });
    try {
      app.analyze(10);
      await flush();
      expect(app.analysis.status).toBe("stopped");
      expect(app.analysis.error).toMatch(/analysis crashed/);
      expect(app.analysis.analyzed).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("resume() on a rejecting runner also lands in stopped + error", async () => {
    let startCount = 0;
    const flaky = {
      start: async () => {
        startCount++;
        if (startCount === 1) return defaultProgress({ analyzed: 1, stoppedReason: "pause" });
        throw new Error("analysis crashed again");
      },
      pause: () => {},
      isRunning: () => false,
      isPaused: () => false,
      progressSnapshot: () => defaultProgress({ analyzed: 1, stoppedReason: "pause" }),
      lastStoppedReason: () => "pause",
      lastErrorReason: () => undefined,
    } as unknown as JobRunner;
    const { app, db } = await mk({ createRunner: () => flaky });
    try {
      app.analyze(10);
      await flush();
      expect(app.analysis.status).toBe("paused");
      app.resume();
      await flush();
      expect(app.analysis.status).toBe("stopped");
      expect(app.analysis.error).toMatch(/analysis crashed again/);
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : find similar guards and success path", () => {
  function withFingerprint(
    base: SampleIndexRecord,
    contentHash: string,
    features: AudioFeatures,
  ): SampleIndexRecord {
    return {
      ...base,
      contentHash,
      contentHashVersion: "pcm-v1",
      similarityFingerprint: computeSimilarityFingerprint(features),
    };
  }

  it("reports 'no sample selected' when nothing is focused", async () => {
    const { app, db } = await mk();
    try {
      await app.findSimilarForSelected();
      expect(app.similarError).toMatch(/no sample selected/);
      expect(app.similarResults).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("reports a missing similarity fingerprint precondition", async () => {
    const { app, db } = await mk();
    try {
      app.selectSample(makeSample("samples/a"));
      await app.findSimilarForSelected();
      expect(app.similarError).toMatch(/no similarity fingerprint/);
      expect(app.similarResults).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("reports an unanalyzable (missing content identity) precondition", async () => {
    const { app, db } = await mk();
    try {
      const rec = withFingerprint(makeSample("samples/a"), "hash-a", kickFeatures());
      delete (rec as unknown as Record<string, unknown>)["contentHash"];
      app.selectSample(rec);
      await app.findSimilarForSelected();
      expect(app.similarError).toBeDefined();
      expect(app.similarResults).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("populates similarResults for a selected analyzed record (query excluded)", async () => {
    const { app, index, db } = await mk();
    try {
      const features = kickFeatures();
      const a = withFingerprint(makeSample("samples/a"), "hash-a", features);
      const b = withFingerprint(makeSample("samples/b"), "hash-b", features);
      await index.put(a);
      await index.put(b);
      app.selectSample(a);
      expect(app.similarError).toBeUndefined();
      await app.findSimilarForSelected();
      expect(app.similarError).toBeUndefined();
      const ids = app.similarResults.map((r) => r.representativeSampleId);
      expect(ids).toContain("samples/b");
      expect(ids).not.toContain("samples/a");
      expect(app.similarResults[0].similarityScore).toBe(1);
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : scan eligibility gating (STEP38)", () => {
  const foreignZeroZero = (name = "samples/foreign-zero"): SampleMeta => ({
    ...META_A,
    name,
    displayName: "Foreign Zero",
    ownerName: "users/bob", // not the authenticated user
    numFavorites: 0,
    numUsages: 0,
  });

  const foreignFavorite = (name = "samples/foreign-fav"): SampleMeta => ({
    ...META_A,
    name,
    displayName: "Foreign Fav",
    ownerName: "users/bob",
    numFavorites: 3,
    numUsages: 0,
  });

  const foreignUsage = (name = "samples/foreign-use"): SampleMeta => ({
    ...META_A,
    name,
    displayName: "Foreign Use",
    ownerName: "users/bob",
    numFavorites: 0,
    numUsages: 4,
  });

  const foreignLoops = (name = "samples/foreign-loops"): SampleMeta => ({
    ...META_A,
    name,
    displayName: "Foreign Loops",
    ownerName: "users/bob",
    numFavorites: 7,
    numUsages: 9,
    kind: "loop",
  });

  function scanOf(...added: SampleMeta[]): LibraryScanResult {
    return {
      added,
      changed: [],
      unchangedCount: 0,
      seenSampleIds: added.map((m) => m.name),
      pageCount: 1,
      latestKnown: "2026-01-01T00:00:00.000Z",
      fullScan: true,
    };
  }

  it("foreign sample with zero favourites AND zero usages is gated (never enqueued)", async () => {
    const { app, db, queue } = await mk({
      authenticatedUserId: "users/alice",
      scanFn: async () => scanOf(foreignZeroZero()),
    });
    try {
      const enqueueSpy = vi.spyOn(queue, "enqueue");
      await app.startScan();
      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(app.scan.eligibleEnqueued).toBe(0);
      expect(app.scan.ineligibleSkipped).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("foreign sample with a favourite OR a usage is eligible and enqueued with its tier", async () => {
    const { app, db, queue } = await mk({
      authenticatedUserId: "users/alice",
      scanFn: async () => scanOf(foreignFavorite(), foreignUsage(), foreignLoops()),
    });
    try {
      const enqueueSpy = vi.spyOn(queue, "enqueue");
      await app.startScan();
      expect(enqueueSpy).toHaveBeenCalledTimes(3);
      const calls = enqueueSpy.mock.calls.map((c) => c as [string, string, number]);
      expect(calls.find(([id]) => id === "samples/foreign-fav")?.[2]).toBe(1); // other one-shot
      expect(calls.find(([id]) => id === "samples/foreign-use")?.[2]).toBe(1);
      expect(calls.find(([id]) => id === "samples/foreign-loops")?.[2]).toBe(3); // other loop
      expect(app.scan.eligibleEnqueued).toBe(3);
      expect(app.scan.ineligibleSkipped).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("own samples stay eligible with one-shot-first tier (tier 0)", async () => {
    const { app, db, queue } = await mk({
      authenticatedUserId: "users/alice",
      scanFn: async () =>
        scanOf(
          { ...META_A, numFavorites: 0, numUsages: 0 }, // own, zero signals
          { ...foreignLoops(), ownerName: "users/alice", name: "samples/own-loops" },
        ),
    });
    try {
      const enqueueSpy = vi.spyOn(queue, "enqueue");
      await app.startScan();
      const calls = enqueueSpy.mock.calls.map((c) => c as [string, string, number]);
      expect(calls.length).toBe(2);
      expect(calls.find(([id]) => id === "samples/a")?.[2]).toBe(0);
      expect(calls.find(([id]) => id === "samples/own-loops")?.[2]).toBe(2); // own loop
      expect(app.scan.eligibleEnqueued).toBe(2);
      expect(app.scan.ineligibleSkipped).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("without an authenticated user identity, foreign zero/zero samples are gated (never wrongly OWN)", async () => {
    const { app, db, queue } = await mk({
      authenticatedUserId: undefined,
      scanFn: async () =>
        scanOf(
          foreignZeroZero(),
          { ...META_A, ownerName: "users/alice" }, // would-be own, but identity unavailable
          foreignFavorite(),
        ),
    });
    try {
      const enqueueSpy = vi.spyOn(queue, "enqueue");
      await app.startScan();
      const calls = enqueueSpy.mock.calls.map((c) => c as [string, string, number]);
      expect(calls.map(([id]) => id)).toEqual(["samples/foreign-fav"]); // only the signalled foreign one
      expect(app.scan.eligibleEnqueued).toBe(1);
      expect(app.scan.ineligibleSkipped).toBe(2);
    } finally {
      await db.close();
    }
  });

  it("gating never re-analyzes already-analyzed records (eligibility is enqueue-only)", async () => {
    const { app, db, index, createRunnerCalls } = await mk({
      authenticatedUserId: "users/alice",
      scanFn: async () => scanOf({ ...META_A, numFavorites: 1 }),
    });
    try {
      const frozen = makeSample("samples/a", {
        primaryClass: "kick",
        confidence: 0.9,
        analyzedAt: "2026-01-01T00:00:00.000Z",
        analysisBuild: BUILD,
      });
      await index.put(frozen);
      await app.startScan();
      const rec = await index.get("samples/a");
      expect(rec!.primaryClass).toBe("kick");
      expect(rec!.confidence).toBe(0.9);
      expect(rec!.analyzedAt).toBe(frozen.analyzedAt);
      expect(createRunnerCalls).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

describe("SampleMap UI : automatic global population (Step 70)", () => {
  it("completed analysis run enqueues eligible analyzed records into publish queue", async () => {
    const handle = await openDb();
    const fake = makeFakeRunner(defaultProgress({ analyzed: 1 }));
    const publishProvider: GlobalSampleIndex = {
      async lookupSamples() { return []; },
      async lookupContentIdentities() { return []; },
      async queryMapViewport() { return { mapVersion: "v1", points: [] }; },
      async publishAnalysisResults() { return { items: [], accepted: true }; },
    };
    const publishQueue = new GlobalPublishQueue(publishProvider);

    const app = new SampleMapApp({
      queue: handle.queue as never,
      index: handle.index as never,
      search: { search: vi.fn(async () => []) } as never,
      preview: new PreviewService(),
      machiniste: {} as never,
      createRunner: () => fake.runner,
      fetchPage: async () => ({ samples: [], nextPageToken: "" }),
      known: { getUpdatedAt: async () => undefined },
      previewUrlFor: () => undefined,
      analysisBuild: BUILD,
      globalPublishQueue: publishQueue,
      globalPublishDelivery: "offline",
    });

    try {
      // Put a valid analyzed record in index
      const features = makeFeatures();
      await handle.index.put(makeSample("samples/a", {
        primaryClass: "kick",
        confidence: 0.9,
        analyzedAt: "2026-03-01T00:00:00.000Z",
        analysisBuild: BUILD,
        mapPosition: { x: 0.5, y: 0.5 },
        contentHash: "a".repeat(64),
        contentHashVersion: "pcm-v1",
        analysisSourceFormat: "wav",
        similarityFingerprint: computeSimilarityFingerprint(features),
        audioFeatures: features,
      }));

      expect(publishQueue.pendingCount).toBe(0);

      app.analyze(10);
      await fake.settle(defaultProgress({ analyzed: 1, stoppedReason: "complete" }));

      // Wait a tick for the async fire-and-forget population to complete
      await flush();
      await flush();

      expect(publishQueue.pendingCount).toBe(1);
      const items = publishQueue.snapshot();
      expect(items[0].sampleId).toBe("samples/a");

      const rec = await handle.index.get("samples/a");
      expect(rec?.globalPublish?.delivery).toBe("pending");
    } finally {
      await handle.db.close();
    }
  });
});
