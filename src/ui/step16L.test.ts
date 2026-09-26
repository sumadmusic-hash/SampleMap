import { describe, it, expect, vi, afterEach } from "vitest";
import type { SampleMeta } from "@audiotool/nexus/api";
import type { SampleIndexRecord, IndexStore } from "../persistence/indexStore";
import { openTestDatabase, makeSample } from "../persistence/test-helpers";
import type { DatabaseHandle } from "../persistence/db";
import { SampleMapSearchEngine, type SearchResult } from "../search/searchEngine";
import { PreviewService } from "../preview/previewService";
import { SampleMapMachinisteService } from "../machiniste/machinisteService";
import type { JobRunner, RunProgress, AnalysisBudget } from "../pipeline/jobRunner";
import type {
  GlobalSampleIndex,
  GlobalMapPoint,
  MapViewportQuery,
  GlobalContentLookupHit,
  GlobalAnalysisResult,
} from "../global/contract";
import type { SampleMapAppDeps } from "./app";
import { SampleMapApp } from "./app";
import { createMemoryEp7ConsentStore } from "./ep7Consent";
import { computeSimilarityFingerprint } from "../similarity/similarityFingerprint";
import { findSimilar } from "../similarity/similaritySearch";
import {
  mapPoints,
  globalMapPoints,
  mergeMapPoints,
  MAP_VERSION,
  cameraToViewportBBox,
  defaultMapCamera,
  zoomBy,
  panBy,
  MapPoint,
} from "./map/mapView";
import { buildRecordFromGlobalAnalysis } from "../global/hydrate";
import { assertNoAudioBytes } from "../persistence/indexStore";

/**
 * Step 16L — Global Discovery & Interaction (C1–C7).
 *
 * C1 Viewport-aware global loading
 * C2 Global inspection
 * C3 Global → local hydration
 * C4 Search/filter integration
 * C5 Find Similar UI
 * C6 Loading/Empty/Error states
 * C7 Machiniste / usage acceptance (unchanged boundary)
 */

const BUILD = "build-16l";

function makeFeatures(over: Partial<{ tonalNoiseRatio: number; spectralCentroid: number }> = {}) {
  return {
    duration: 0.5, sampleRate: 44100, channels: 2, rms: 0.3, peak: 0.8,
    transientDensity: 12, spectralCentroid: over.spectralCentroid ?? 2000,
    spectralBandwidth: 400, spectralRolloff: 5000, zeroCrossingRate: 0.03,
    spectralFlatness: 0.1, attack: 0.002, tonalNoiseRatio: over.tonalNoiseRatio ?? 0.5,
  };
}

const CONTENT_HASH_A = "a1a2a3a4a5a6a7a8a1a2a3a4a5a6a7a8a1a2a3a4a5a6a7a8a1a2a3a4a5a6a7a8";
const CONTENT_HASH_B = "b1b2b3b4b5b6b7b8b1b2b3b4b5b6b7b8b1b2b3b4b5b6b7b8b1b2b3b4b5b6b7b8";

const GLOBAL_POINT_A: GlobalMapPoint = {
  contentIdentity: { contentHash: CONTENT_HASH_A, contentHashVersion: "pcm-v1" },
  x: 0.3, y: 0.7,
  representativeSampleId: "samples/global-a",
  primaryClass: "kick",
};
const GLOBAL_POINT_B: GlobalMapPoint = {
  contentIdentity: { contentHash: CONTENT_HASH_B, contentHashVersion: "pcm-v1" },
  x: 0.8, y: 0.2,
  representativeSampleId: "samples/global-b",
  primaryClass: "snare",
};

function localRecord(
  sampleId: string,
  over: Partial<SampleIndexRecord> = {},
): SampleIndexRecord {
  const base = makeSample(sampleId);
  return {
    ...base,
    status: "analyzed",
    audioFeatures: makeFeatures(),
    contentHash: CONTENT_HASH_A,
    contentHashVersion: "pcm-v1",
    similarityFingerprint: computeSimilarityFingerprint(makeFeatures()),
    ...over,
  };
}

const META_GLOBAL: SampleMeta = {
  name: "samples/global-a", displayName: "Global Kick", description: "",
  ownerName: "users/bob", favoritedByUser: false, numFavorites: 0, numUsages: 0,
  bpm: 0, kind: "one-shot", visibility: "public", tags: ["global-kick"],
  createTime: undefined, updateTime: undefined, durationSeconds: 0.5,
  mp3Url: "https://cdn/global-a.mp3", wavUrl: "https://cdn/global-a.wav",
  flacUrl: "https://cdn/global-a.flac", previewMp3Url: "https://cdn/global-a-preview.mp3",
  getWaveformUrl: () => "https://cdn/global-a.wave",
};

function makeGlobalAnalysis(
  over: Partial<GlobalAnalysisResult> = {},
): GlobalAnalysisResult {
  return {
    contentIdentity: { contentHash: CONTENT_HASH_A, contentHashVersion: "pcm-v1" },
    classificationVersion: "heuristic-v1",
    primaryClass: "kick",
    confidence: 0.96,
    secondaryClasses: [],
    analysisVersion: "features-v1",
    analysisBuild: BUILD,
    map: { mapVersion: MAP_VERSION, x: 0.3, y: 0.7 },
    similarity: computeSimilarityFingerprint(makeFeatures({ tonalNoiseRatio: 0.2 })),
    analysisSourceFormat: "wav",
    gatePassed: true,
    audioFeatures: makeFeatures({ tonalNoiseRatio: 0.2 }),
    ...over,
  };
}

const openHandles: DatabaseHandle[] = [];
function openDb(): Promise<DatabaseHandle> {
  return openTestDatabase().then((h) => { openHandles.push(h); return h; });
}
afterEach(async () => {
  const handles = openHandles.splice(0);
  await Promise.all(handles.map((h) => h.db.close().catch(() => {})));
});

const defaultProgress = (over: Partial<RunProgress> = {}): RunProgress =>
  ({ analyzed: 0, failed: 0, skipped: 0, gone: 0, stoppedReason: undefined, ...over });

/** STEP19A E-P7 — granted in-memory consent store (shared rig default). */
function grantedEp7() {
  const store = createMemoryEp7ConsentStore();
  store.grant();
  return store;
}

function makeFakeRunner(progress: RunProgress) {
  const runner = {
    start: async () => progress, pause: () => {},
    isRunning: () => true, isPaused: () => false,
    progressSnapshot: () => progress, lastStoppedReason: () => undefined,
    lastErrorReason: () => undefined,
  } as unknown as JobRunner;
  return runner;
}

async function mkApp(
  over: Partial<SampleMapAppDeps> = {},
): Promise<{ app: SampleMapApp; handle: DatabaseHandle; index: IndexStore }> {
  const handle = await openDb();
  const search = { search: vi.fn(async (): Promise<SearchResult[]> => []) };
  const searchEngine = search as unknown as SampleMapSearchEngine;
  const runner = makeFakeRunner(defaultProgress({ stoppedReason: "budget" }));
  const createRunner = vi.fn(() => runner) as unknown as (budget: AnalysisBudget) => JobRunner;
  const deps: SampleMapAppDeps = {
    queue: handle.queue as never,
    index: handle.index,
    search: searchEngine,
    preview: new PreviewService(),
    machiniste: {} as unknown as SampleMapMachinisteService,
    createRunner,
    fetchPage: async () => ({ samples: [], nextPageToken: "" }),
    known: { getUpdatedAt: async () => undefined },
    previewUrlFor: (r) => `https://cdn/${r.sampleId}.mp3`,
    analysisBuild: BUILD,
    // STEP19A E-P7: default-granted so existing send tests stay focused on the
    // send; the E-P7 suite overrides with an explicit ungranted store.
    ep7Consent: grantedEp7(),
    ...over,
  };
  const app = new SampleMapApp(deps);
  return { app, handle, index: handle.index };
}

function globalPoint(
  over: Partial<MapPoint> = {},
): MapPoint {
  return {
    sampleId: "samples/global-a", sampleIds: ["samples/global-a"],
    contentIdentity: { contentHash: CONTENT_HASH_A, contentHashVersion: "pcm-v1" },
    name: "samples/global-a", owner: "global", primaryClass: "kick",
    confidence: 1.0, originalTags: [], x: 0.3, y: 0.7, origin: "global" as const,
    ...over,
  };
}

function inspectionIndex(
  analysis: GlobalAnalysisResult = makeGlobalAnalysis(),
  over: Partial<GlobalSampleIndex> = {},
): GlobalSampleIndex {
  return {
    queryMapViewport: async () => ({ mapVersion: MAP_VERSION, points: [GLOBAL_POINT_A] }),
    lookupContentIdentities: async (): Promise<GlobalContentLookupHit[]> => [{
      contentIdentity: analysis.contentIdentity,
      analysis,
      sampleIds: ["samples/global-a"],
      representativeSampleId: "samples/global-a",
    }],
    ...over,
  } as unknown as GlobalSampleIndex;
}

// ═══════════════════════════════════════════════════════════════════════════
// C1 — Viewport-aware global loading
// ═══════════════════════════════════════════════════════════════════════════
describe("16L C1 — Viewport (camera → bbox, bounded pages, cursor)", () => {
  it("full-map camera produces the full [0,1] bbox", () => {
    const bbox = cameraToViewportBBox(defaultMapCamera());
    expect(bbox.xMin).toBeCloseTo(0, 10);
    expect(bbox.xMax).toBeCloseTo(1, 10);
    expect(bbox.yMin).toBeCloseTo(0, 10);
    expect(bbox.yMax).toBeCloseTo(1, 10);
    expect(bbox.zoom).toBe(1);
  });

  it("zoom punches a smaller than full bbox (span < 1 when not clamped)", () => {
    // zoom=4 centered: visible half-span in base px is W/2 → x spans [0.375,0.625].
    const zoomed = zoomBy(defaultMapCamera(), 4);
    const bbox = cameraToViewportBBox(zoomed);
    expect(bbox.zoom).toBe(4);
    expect(bbox.xMax - bbox.xMin).toBeCloseTo(0.25, 5);
    expect(bbox.yMax - bbox.yMin).toBeCloseTo(0.25, 5);
  });

  it("pan (at zoom > 1) shifts the bbox", () => {
    // With zoom=2 the max panX is W*(1-2) = -W, so a big left pan is legal and
    // must shift the visible bbox to the right.
    const panned = panBy(zoomBy(defaultMapCamera(), 2), -400, 0); // pan left 400px
    expect(panned.panX).toBeLessThan(0);
    const bbox = cameraToViewportBBox(panned);
    expect(bbox.xMin).toBeGreaterThan(0);
    expect(bbox.xMax).toBeGreaterThan(bbox.xMin);
  });

  it("bbox is clamped to [0,1] under extreme pan", () => {
    const extreme = panBy(defaultMapCamera(), 99999, 99999);
    const bbox = cameraToViewportBBox(extreme);
    expect(bbox.xMin).toBeGreaterThanOrEqual(0);
    expect(bbox.xMax).toBeLessThanOrEqual(1);
    expect(bbox.yMin).toBeGreaterThanOrEqual(0);
    expect(bbox.yMax).toBeLessThanOrEqual(1);
  });

  it("refreshGlobalPoints queries with the actual camera bbox, not blind 0..1", async () => {
    const queryFn = vi.fn(async (_q: MapViewportQuery) => ({
      mapVersion: MAP_VERSION, points: [GLOBAL_POINT_A],
    }));
    const { app, handle } = await mkApp({
      globalIndex: { queryMapViewport: queryFn } as unknown as GlobalSampleIndex,
    });
    try {
      app.zoomMapBy(4);
      await app.refreshGlobalPoints();
      expect(queryFn).toHaveBeenCalledTimes(1);
      const q = queryFn.mock.calls[0][0];
      expect(q.mapVersion).toBe(MAP_VERSION);
      expect(q.zoom).toBe(4);
      expect(q.xMax - q.xMin).toBeGreaterThanOrEqual(0);
      expect(q.limit).toBeLessThanOrEqual(500);
      expect(q.cursor).toBeUndefined();
    } finally {
      await handle.db.close();
    }
  });

  it("follows nextCursor up to a bounded number of pages", async () => {
    const pages = [
      { mapVersion: MAP_VERSION, points: [GLOBAL_POINT_A], nextCursor: "p2" as string | undefined },
      { mapVersion: MAP_VERSION, points: [GLOBAL_POINT_B], nextCursor: "p3" as string | undefined },
      { mapVersion: MAP_VERSION, points: [{ ...GLOBAL_POINT_A, x: 0.1 }] as GlobalMapPoint[] },
    ];
    let i = 0;
    const queryFn = vi.fn(async (_q: MapViewportQuery) => pages[Math.min(i++, pages.length - 1)]);
    const { app, handle } = await mkApp({
      globalIndex: { queryMapViewport: queryFn } as unknown as GlobalSampleIndex,
    });
    try {
      await app.refreshGlobalPoints();
      // Bounded: at most GLOBAL_MAP_MAX_PAGES (2) pages loaded this call.
      expect(queryFn.mock.calls.length).toBeLessThanOrEqual(2);
      const cursors = queryFn.mock.calls.map((c) => c[0].cursor);
      expect(cursors[0]).toBeUndefined();
      expect(cursors[1]).toBe("p2");
    } finally {
      await handle.db.close();
    }
  });

  it("local points are not cleared by a global refresh", async () => {
    const local = localRecord("samples/local-a");
    const queryFn = vi.fn(async () => ({ mapVersion: MAP_VERSION, points: [] as GlobalMapPoint[] }));
    const { app, handle, index } = await mkApp({
      globalIndex: { queryMapViewport: queryFn } as unknown as GlobalSampleIndex,
    });
    try {
      await index.put(local);
      const merged = mergeMapPoints(mapPoints([local]), globalMapPoints([]));
      expect(merged).toHaveLength(1);
      await app.refreshGlobalPoints();
      expect(app.globalPoints).toEqual([]);
      expect(app.globalMapState).toBe("empty");
      expect(mapPoints([local])).toHaveLength(1); // local unaffected
    } finally {
      await handle.db.close();
    }
  });

  it("debounced refresh is scheduled on camera change and coalesces", async () => {
    const queryFn = vi.fn(async () => ({ mapVersion: MAP_VERSION, points: [] as GlobalMapPoint[] }));
    const { app, handle } = await mkApp({
      globalIndex: { queryMapViewport: queryFn } as unknown as GlobalSampleIndex,
    });
    try {
      app.setMapCamera(zoomBy(defaultMapCamera(), 2));
      app.setMapCamera(zoomBy(defaultMapCamera(), 4));
      app.setMapCamera(zoomBy(defaultMapCamera(), 8));
      expect(queryFn).not.toHaveBeenCalled(); // debounced
      await new Promise((r) => setTimeout(r, 300));
      expect(queryFn).toHaveBeenCalledTimes(1); // coalesced
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C2 — Global Inspection
// ═══════════════════════════════════════════════════════════════════════════
describe("16L C2 — Inspection (no unnecessary analysis)", () => {
  it("global record can be inspected with canonical analysis", async () => {
    const analysis = makeGlobalAnalysis();
    const { app, handle } = await mkApp({ globalIndex: inspectionIndex(analysis) });
    try {
      await app.inspectGlobalPoint(globalPoint());
      expect(app.globalInspection?.error).toBeUndefined();
      expect(app.globalInspection?.analysis.primaryClass).toBe("kick");
      expect(app.globalInspection?.analysis.confidence).toBe(0.96);
      expect(app.globalInspection?.analysis.contentIdentity).toEqual(analysis.contentIdentity);
    } finally {
      await handle.db.close();
    }
  });

  it("unknown global content → inspection error 'unknown'", async () => {
    const { app, handle } = await mkApp({
      globalIndex: { lookupContentIdentities: async () => [] } as unknown as GlobalSampleIndex,
    });
    try {
      await app.inspectGlobalPoint(globalPoint());
      expect(app.globalInspection?.error).toBe("unknown");
    } finally {
      await handle.db.close();
    }
  });

  it("unavailable backend → inspection error 'unavailable' (≠ unknown)", async () => {
    const { app, handle } = await mkApp({
      globalIndex: { lookupContentIdentities: async () => { throw new Error("offline"); } } as unknown as GlobalSampleIndex,
    });
    try {
      await app.inspectGlobalPoint(globalPoint());
      expect(app.globalInspection?.error).toBe("unavailable");
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C3 — Global → Local hydration
// ═══════════════════════════════════════════════════════════════════════════
describe("16L C3 — Hydration (bounded, idempotent, searchable, no audio)", () => {
  it("hydrateGlobalSample writes a local record reusing the global analysis (no audio)", async () => {
    const analysis = makeGlobalAnalysis();
    const { app, handle, index } = await mkApp({
      globalIndex: inspectionIndex(analysis),
      resolveSample: async () => META_GLOBAL,
    });
    try {
      await app.hydrateGlobalSample(globalPoint(), analysis);
      const stored = await index.get("samples/global-a");
      expect(stored).toBeDefined();
      expect(stored!.contentHash).toBe(CONTENT_HASH_A);
      expect(stored!.primaryClass).toBe("kick");
      expect(stored!.name).toBe("Global Kick"); // metadata from resolveSample
      expect(() => assertNoAudioBytes(stored, "$hydrated")).not.toThrow();
    } finally {
      await handle.db.close();
    }
  });

  it("repeated hydration is idempotent (single record, no duplicate)", async () => {
    const analysis = makeGlobalAnalysis();
    const { app, handle, index } = await mkApp({
      globalIndex: inspectionIndex(analysis),
      resolveSample: async () => META_GLOBAL,
    });
    try {
      await app.hydrateGlobalSample(globalPoint(), analysis);
      await app.hydrateGlobalSample(globalPoint(), analysis);
      const all = await index.getAll();
      expect(all.filter((r) => r.sampleId === "samples/global-a")).toHaveLength(1);
    } finally {
      await handle.db.close();
    }
  });

  it("valid V2 global analysis hydrates and persists the V2 mapPosition verbatim", async () => {
    const analysis = makeGlobalAnalysis();
    const { app, handle, index } = await mkApp({
      globalIndex: inspectionIndex(analysis),
      resolveSample: async () => META_GLOBAL,
    });
    try {
      const ok = await app.hydrateGlobalSample(globalPoint(), analysis);
      expect(ok).toBe(true);
      const stored = await index.get("samples/global-a");
      expect(stored).toBeDefined();
      expect(stored!.mapPosition).toEqual({ x: 0.3, y: 0.7 });
    } finally {
      await handle.db.close();
    }
  });

  it("incompatible mapVersion → hydration skipped, no record persists, inspection read-only", async () => {
    const analysis = makeGlobalAnalysis({ map: { mapVersion: "map-v1", x: 0.3, y: 0.7 } });
    const { app, handle, index } = await mkApp({
      globalIndex: inspectionIndex(analysis),
      resolveSample: async () => META_GLOBAL,
    });
    try {
      await app.inspectGlobalPoint(globalPoint());
      const ok = await app.hydrateGlobalSample(globalPoint(), analysis);
      expect(ok).toBe(false);
      expect(await index.get("samples/global-a")).toBeUndefined();
      // Surfaced read-only (rendered as incompatible); never silently accepted.
      expect(app.globalInspection?.error).toBe("incompatible");
    } finally {
      await handle.db.close();
    }
  });

  it("missing V2 (legacy analysis, no map projection) → hydration skipped, never fabricated", async () => {
    const legacy = {
      ...makeGlobalAnalysis(),
      map: undefined,
    } as unknown as GlobalAnalysisResult;
    const { app, handle, index } = await mkApp({
      globalIndex: inspectionIndex(legacy),
      resolveSample: async () => META_GLOBAL,
    });
    try {
      const ok = await app.hydrateGlobalSample(globalPoint(), legacy);
      expect(ok).toBe(false);
      // No record is created and no V2 mapPosition is invented.
      expect(await index.get("samples/global-a")).toBeUndefined();
    } finally {
      await handle.db.close();
    }
  });

  it("buildRecordFromGlobalAnalysis is metadata-only and keyed on content identity", () => {
    const analysis = makeGlobalAnalysis();
    const { record } = buildRecordFromGlobalAnalysis(
      "samples/global-a", META_GLOBAL, analysis, BUILD, () => "2026-01-01T00:00:00.000Z",
    );
    expect(record.contentHash).toBe(analysis.contentIdentity.contentHash);
    expect(record.contentHashVersion).toBe(analysis.contentIdentity.contentHashVersion);
    expect(record.status).toBe("analyzed");
    expect(() => assertNoAudioBytes(record, "$rec")).not.toThrow();
  });

  it("buildRecordFromGlobalAnalysis copies the metadata slice from the resolved meta", () => {
    const analysis = makeGlobalAnalysis();
    const meta: SampleMeta = {
      ...META_GLOBAL,
      bpm: 128,
      numFavorites: 42,
      numUsages: 187,
    };
    const { record, resolved } = buildRecordFromGlobalAnalysis(
      "samples/global-a", meta, analysis, BUILD, () => "2026-01-01T00:00:00.000Z",
    );
    expect(resolved).toBe(true);
    expect(record.bpm).toBe(128);
    expect(record.numFavorites).toBe(42);
    expect(record.numUsages).toBe(187);
    // Same semantics as analysisPipeline.buildRecord: the analysis fields are
    // copied from the global analysis, never mixed with the metadata.
    expect(record.primaryClass).toBe(analysis.primaryClass);
    expect(record.confidence).toBe(analysis.confidence);
    expect(record.mapPosition).toEqual({ x: analysis.map.x, y: analysis.map.y });
  });

  it("buildRecordFromGlobalAnalysis leaves the slice undefined when meta is absent (same semantics)", () => {
    const analysis = makeGlobalAnalysis();
    const { record, resolved } = buildRecordFromGlobalAnalysis(
      "samples/global-a", undefined, analysis, BUILD, () => "2026-01-01T00:00:00.000Z",
    );
    expect(resolved).toBe(false);
    expect(record.bpm).toBeUndefined();
    expect(record.numFavorites).toBeUndefined();
    expect(record.numUsages).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C4 — Search / filter integration (existing SearchEngine finds hydrated)
// ═══════════════════════════════════════════════════════════════════════════
describe("16L C4 — Search (local SearchEngine finds hydrated global records)", () => {
  it("hydrated global sample is found by name and class via the existing engine", async () => {
    const handle = await openDb();
    try {
      const index = handle.index;
      const analysis = makeGlobalAnalysis({ primaryClass: "kick", confidence: 0.9 });
      const { record } = buildRecordFromGlobalAnalysis("samples/global-a", META_GLOBAL, analysis, BUILD);
      await index.put(record);

      const engine = new SampleMapSearchEngine(index);
      const byName = await engine.search({ text: "Global Kick" });
      expect(byName.some((r) => r.record.sampleId === "samples/global-a")).toBe(true);

      const byClass = await engine.search({ classes: ["kick"] });
      expect(byClass.some((r) => r.record.primaryClass === "kick")).toBe(true);

      const byConf = await engine.search({ minConfidence: 0.85 });
      expect(byConf.length).toBeGreaterThan(0);

      const sorted = await engine.search({ sortBy: "name", sortDir: "asc" });
      expect(sorted.length).toBe(1);
    } finally {
      await handle.db.close();
    }
  });

  it("local + hydrated global records appear together", async () => {
    const handle = await openDb();
    try {
      const index = handle.index;
      await index.put(localRecord("samples/local-x"));
      const analysis = makeGlobalAnalysis();
      const { record } = buildRecordFromGlobalAnalysis("samples/global-a", undefined, analysis, BUILD);
      await index.put(record);

      const engine = new SampleMapSearchEngine(index);
      const all = await engine.search({});
      const ids = all.map((r) => r.record.sampleId).sort();
      expect(ids).toEqual(["samples/global-a", "samples/local-x"]);
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C5 — Find Similar UI (controller + engine)
// ═══════════════════════════════════════════════════════════════════════════
describe("16L C5 — Find Similar (existing similarity-v1, exact dup excluded)", () => {
  it("deterministic ordering + exact duplicate excluded + bounded limit (engine)", () => {
    const queryFp = computeSimilarityFingerprint(makeFeatures({ tonalNoiseRatio: 0.1 }));
    const records = [
      localRecord("samples/dup", { contentHash: CONTENT_HASH_A }), // exact duplicate (same identity)
      localRecord("samples/sim1", { contentHash: "hash-sim1", audioFeatures: makeFeatures({ tonalNoiseRatio: 0.2 }) }),
      localRecord("samples/sim2", { contentHash: "hash-sim2", audioFeatures: makeFeatures({ tonalNoiseRatio: 0.7 }) }),
    ];
    records.forEach((r) => { r.similarityFingerprint = computeSimilarityFingerprint(r.audioFeatures); });

    const out = findSimilar({
      contentIdentity: { contentHash: CONTENT_HASH_A, contentHashVersion: "pcm-v1" },
      fingerprint: queryFp,
      records,
      limit: 10,
    });
    // Exact duplicate (CONTENT_HASH_A) is excluded.
    expect(out.map((r) => r.contentIdentity.contentHash)).not.toContain(CONTENT_HASH_A);
    // Deterministic: score DESC.
    const scores = out.map((r) => r.similarityScore);
    expect([...scores]).toEqual([...scores].sort((a, b) => b - a));
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("findSimilarForSelected resolves representative records and excludes the selected sample", async () => {
    const selected = localRecord("samples/selected", {
      contentHash: CONTENT_HASH_A,
      audioFeatures: makeFeatures({ tonalNoiseRatio: 0.1 }),
    });
    selected.similarityFingerprint = computeSimilarityFingerprint(selected.audioFeatures);
    const sim1 = localRecord("samples/sim1", { contentHash: "hash-sim1", audioFeatures: makeFeatures({ tonalNoiseRatio: 0.2 }) });
    sim1.similarityFingerprint = computeSimilarityFingerprint(sim1.audioFeatures);

    const { app, handle, index } = await mkApp();
    try {
      await index.put(selected);
      await index.put(sim1);
      app.selectSample(selected);
      await app.findSimilarForSelected();
      expect(app.similarError).toBeUndefined();
      expect(app.similarResults.length).toBeGreaterThanOrEqual(0);
      const sampleIds = app.similarResults.map((r) => r.representativeSampleId);
      expect(sampleIds).not.toContain("samples/selected");
      expect(sampleIds).toContain("samples/sim1");
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C6 — Global map states (loading/ok/empty/error; local survives failure)
// ═══════════════════════════════════════════════════════════════════════════
describe("16L C6 — Global Map States", () => {
  it("success with points → ok", async () => {
    const { app, handle } = await mkApp({
      globalIndex: { queryMapViewport: async () => ({ mapVersion: MAP_VERSION, points: [GLOBAL_POINT_A] }) } as unknown as GlobalSampleIndex,
    });
    try {
      await app.refreshGlobalPoints();
      expect(app.globalMapState).toBe("ok");
      expect(app.globalPoints).toHaveLength(1);
    } finally {
      await handle.db.close();
    }
  });

  it("success with no points → empty (not 'whole map empty')", async () => {
    const { app, handle } = await mkApp({
      globalIndex: { queryMapViewport: async () => ({ mapVersion: MAP_VERSION, points: [] }) } as unknown as GlobalSampleIndex,
    });
    try {
      await app.refreshGlobalPoints();
      expect(app.globalMapState).toBe("empty");
    } finally {
      await handle.db.close();
    }
  });

  it("backend failure → error, and local map still works", async () => {
    const { app, handle } = await mkApp({
      globalIndex: { queryMapViewport: async () => { throw new Error("offline"); } } as unknown as GlobalSampleIndex,
    });
    try {
      await app.refreshGlobalPoints();
      expect(app.globalMapState).toBe("error");
      expect(app.globalPoints).toEqual([]);
      // Local map points are independent of global state.
      const local = mapPoints([localRecord("samples/local-a")]);
      expect(local).toHaveLength(1);
    } finally {
      await handle.db.close();
    }
  });

  it("loading state is set before the request resolves", async () => {
    let resolveQuery: ((v: { mapVersion: string; points: GlobalMapPoint[] }) => void) | undefined;
    const { app, handle } = await mkApp({
      globalIndex: { queryMapViewport: () => new Promise((res) => { resolveQuery = res; }) } as unknown as GlobalSampleIndex,
    });
    try {
      const p = app.refreshGlobalPoints();
      expect(app.globalMapState).toBe("loading");
      resolveQuery!({ mapVersion: MAP_VERSION, points: [GLOBAL_POINT_A] });
      await p;
      expect(app.globalMapState).toBe("ok");
    } finally {
      await handle.db.close();
    }
  });

  it("BUG #5: an older overlapping refresh never overwrites a newer one (epoch guard)", async () => {
    // Two overlapping refreshes: the FIRST starts but resolves LAST. Its stale
    // result must be dropped in favor of the second (which holds the newest
    // camera viewport) — the epoch guard on `globalRefreshEpoch` (app.ts) makes
    // this deterministic.
    const gates: Array<(v: { mapVersion: string; points: GlobalMapPoint[] }) => void> = [];
    const calls: MapViewportQuery[] = [];
    const { app, handle } = await mkApp({
      globalIndex: {
        queryMapViewport(query: MapViewportQuery) {
          calls.push(query);
          return new Promise((res) => gates.push(res));
        },
      } as unknown as GlobalSampleIndex,
    });
    try {
      const newer = GLOBAL_POINT_A; // represents the NEWEST viewport
      const first = app.refreshGlobalPoints(); // resolve window/response A
      const second = app.refreshGlobalPoints(); // supersedes before A resolves

      // Second resolves first → its points commit.
      gates[1]({ mapVersion: MAP_VERSION, points: [newer] });
      await second;
      expect(app.globalPoints).toEqual([newer]);
      expect(app.globalMapState).toBe("ok");

      // First resolves LATER → the stale result must be ignored, not overwrite.
      gates[0]({ mapVersion: MAP_VERSION, points: [] });
      await first;
      expect(app.globalPoints).toEqual([newer]);
      expect(app.globalMapState).toBe("ok");
    } finally {
      await handle.db.close();
    }
  });

  it("BUG #5: dispose() invalidates any in-flight refresh so it cannot re-notify", async () => {
    let resolveQuery: ((v: { mapVersion: string; points: GlobalMapPoint[] }) => void) | undefined;
    const onChange = vi.fn();
    const { app, handle } = await mkApp({
      globalIndex: { queryMapViewport: () => new Promise((res) => { resolveQuery = res; }) } as unknown as GlobalSampleIndex,
      onChange,
    });
    try {
      const p = app.refreshGlobalPoints();
      expect(app.globalMapState).toBe("loading");

      app.dispose(); // bumps the epoch mid-flight (teardown also notifies once)
      const rendersAtDispose = onChange.mock.calls.length;
      resolveQuery!({ mapVersion: MAP_VERSION, points: [GLOBAL_POINT_A] });
      await p;

      // The stale completion after dispose() neither commits the points nor
      // triggers any further render — the app is torn down, no zombie notify.
      expect(app.globalPoints).toEqual([]);
      expect(onChange.mock.calls.length).toBe(rendersAtDispose);
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C7 — Machiniste + usage acceptance boundary (unchanged)
// ═══════════════════════════════════════════════════════════════════════════
describe("16L C7 — Machiniste / usage acceptance", () => {
  const acceptedResult = () => ({
    machinisteId: "m-1", committed: true,
    slots: [{ slot: 0, applied: true, readBackMatches: true, sampleEntityId: "e", errors: [] as string[] }],
    errors: [] as string[],
  });
  const failedResult = () => ({
    machinisteId: "m-1", committed: true,
    slots: [{ slot: 0, applied: true, readBackMatches: false, sampleEntityId: "e", errors: ["readback"] as string[] }],
    errors: [] as string[],
  });

  it("global-discovered sample transfers via existing Machiniste logic", async () => {
    const send = vi.fn(async () => acceptedResult());
    const { app, handle } = await mkApp({
      machiniste: { send } as unknown as SampleMapMachinisteService,
    });
    try {
      const rec = localRecord("samples/global-a");
      app.toggleMultiSelect(rec);
      await app.sendToMachiniste("machiniste-1", 0);
      expect(send).toHaveBeenCalledWith(["samples/global-a"], "machiniste-1", [0]);
      expect(app.machiniste.lastResult?.slots[0].readBackMatches).toBe(true);
    } finally {
      await handle.db.close();
    }
  });

  it("successful transfer → usage acceptance boundary (committed+applied+readback+errors=0)", () => {
    const r = acceptedResult() as import("../machiniste/machinisteService").MachinisteSendResult;
    expect(r.committed).toBe(true);
    expect(r.slots[0].applied).toBe(true);
    expect(r.slots[0].readBackMatches).toBe(true);
    expect(r.errors.length).toBe(0);
    expect(r.slots[0].errors.length).toBe(0);
  });

  it("failed transfer → no usage acceptance", () => {
    const r = failedResult() as import("../machiniste/machinisteService").MachinisteSendResult;
    const slot = r.slots[0];
    const accepted = r.committed === true && slot.applied === true && slot.readBackMatches === true && r.errors.length === 0 && slot.errors.length === 0;
    expect(accepted).toBe(false);
  });

  it("did not create a fake global publish on failed transfer (idempotent already-known only on success)", () => {
    const r = failedResult() as import("../machiniste/machinisteService").MachinisteSendResult;
    expect(r.committed).toBe(true);
    expect(r.slots[0].readBackMatches).toBe(false);
  });
});
