import { describe, it, expect, vi, afterEach } from "vitest";
import type { SampleMeta } from "@audiotool/nexus/api";
import type { SampleIndexRecord } from "../persistence/indexStore";
import { openTestDatabase, makeSample } from "../persistence/test-helpers";
import type { DatabaseHandle } from "../persistence/db";
import { SampleMapSearchEngine, type SearchResult } from "../search/searchEngine";
import { PreviewService } from "../preview/previewService";
import { SampleMapMachinisteService } from "../machiniste/machinisteService";
import type { JobRunner, RunProgress, AnalysisBudget } from "../pipeline/jobRunner";
import type { GlobalSampleIndex, GlobalMapPoint, MapViewportQuery } from "../global/contract";
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
} from "./map/mapView";
import { assertNoAudioBytes } from "../persistence/indexStore";

/**
 * Step 16K — Global Map Integration Tests (A–O)
 *
 * Tests A–C:  Pure map-point conversion and dedup (mapView)
 * Tests D–F:  Controller-level KNOWN/UNKNOWN/UNAVAILABLE flows
 * Tests G–L:  Camera, selection, inspector, preview, similarity, machiniste
 * Tests M–O:  No-audio-bytes, viewport bounds, identity
 */

const BUILD = "build-16k";

/** STEP19A E-P7 — granted in-memory consent store (shared rig default). */
function grantedEp7() {
  const store = createMemoryEp7ConsentStore();
  store.grant();
  return store;
}

// ── Shared test data ──────────────────────────────────────────────────────

function makeFeatures(overrides: Partial<{ tonalNoiseRatio: number; spectralCentroid: number }> = {}) {
  return {
    duration: 0.5, sampleRate: 44100, channels: 2, rms: 0.3, peak: 0.8,
    transientDensity: 12, spectralCentroid: overrides.spectralCentroid ?? 2000,
    spectralBandwidth: 400, spectralRolloff: 5000, zeroCrossingRate: 0.03,
    spectralFlatness: 0.1, attack: 0.002, tonalNoiseRatio: overrides.tonalNoiseRatio ?? 0.5,
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

// ── Fake deps helpers ─────────────────────────────────────────────────────

const openHandles: DatabaseHandle[] = [];
function openDb(): Promise<DatabaseHandle> {
  return openTestDatabase().then((h) => { openHandles.push(h); return h; });
}
afterEach(async () => {
  const handles = openHandles.splice(0);
  await Promise.all(handles.map((h) => h.db.close().catch(() => {})));
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function defaultProgress(over: Partial<RunProgress> = {}): RunProgress {
  return { analyzed: 0, failed: 0, skipped: 0, gone: 0, stoppedReason: undefined, ...over };
}

function makeFakeRunner(progress: RunProgress) {
  let resolveStart: ((p: RunProgress) => void) | undefined;
  const runner = {
    start: () => new Promise<RunProgress>((res) => { resolveStart = res; }),
    pause: () => {},
    isRunning: () => true,
    isPaused: () => false,
    progressSnapshot: () => progress,
    lastStoppedReason: () => undefined,
    lastErrorReason: () => undefined,
  } as unknown as JobRunner;
  const settle = (p?: RunProgress) => { resolveStart?.(p ?? progress); return flush(); };
  return { runner, settle };
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

/** Step 16L: a canonical GlobalAnalysisResult for inspection/hydration tests. */
function makeGlobalAnalysis(
  over: Partial<import("../global/contract").GlobalAnalysisResult> = {},
): import("../global/contract").GlobalAnalysisResult {
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

/** A minimal GlobalSampleIndex that returns the given inspection analysis. */
function inspectionIndex(
  analysis: import("../global/contract").GlobalAnalysisResult = makeGlobalAnalysis(),
  over: Partial<GlobalSampleIndex> = {},
): GlobalSampleIndex {
  return {
    queryMapViewport: async () => ({ mapVersion: MAP_VERSION, points: [GLOBAL_POINT_A] }),
    lookupContentIdentities: async () => [{
      contentIdentity: analysis.contentIdentity,
      analysis,
      sampleIds: [analysis.contentIdentity.contentHash],
      representativeSampleId: analysis.contentIdentity.contentHash,
    }],
    ...over,
  } as unknown as GlobalSampleIndex;
}

async function mkApp(over: Partial<SampleMapAppDeps> = {}) {
  const handle = await openDb();
  const search = { search: vi.fn(async (): Promise<SearchResult[]> => []) };
  const searchEngine = search as unknown as SampleMapSearchEngine;
  const { runner, settle } = makeFakeRunner(defaultProgress({ stoppedReason: "budget" }));
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
    ep7Consent: grantedEp7(),
    ...over,
  };
  const app = new SampleMapApp(deps);
  return { app, handle, search, createRunner, settle };
}

// ═══════════════════════════════════════════════════════════════════════════
// A — Global Map Data: global result → MapPoint conversion
// ═══════════════════════════════════════════════════════════════════════════
describe("16K A — Global Map Data", () => {
  it("converts GlobalMapPoint[] to MapPoint[] with correct fields", () => {
    const pts = globalMapPoints([GLOBAL_POINT_A]);
    expect(pts).toHaveLength(1);
    const p = pts[0];
    expect(p.sampleId).toBe("samples/global-a");
    expect(p.contentIdentity).toEqual(GLOBAL_POINT_A.contentIdentity);
    expect(p.x).toBe(0.3);
    expect(p.y).toBe(0.7);
    expect(p.primaryClass).toBe("kick");
    expect(p.origin).toBe("global");
  });

  it("preserves content identity from global data", () => {
    const pts = globalMapPoints([GLOBAL_POINT_A, GLOBAL_POINT_B]);
    expect(pts[0].contentIdentity.contentHash).toBe(CONTENT_HASH_A);
    expect(pts[1].contentIdentity.contentHash).toBe(CONTENT_HASH_B);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B — Content Dedup: local + global same contentHash → 1 point
// ═══════════════════════════════════════════════════════════════════════════
describe("16K B — Content Dedup (local + global same hash → 1 point)", () => {
  it("local point takes precedence over global for same content identity", () => {
    const local = mapPoints([localRecord("samples/local-a")]);
    const global = globalMapPoints([GLOBAL_POINT_A]); // same contentHash
    const merged = mergeMapPoints(local, global);
    expect(merged).toHaveLength(1);
    expect(merged[0].origin).toBe("local");
    expect(merged[0].name).toBe("Hard Kick 01"); // local metadata
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C — Different Content: different hashes → 2 points
// ═══════════════════════════════════════════════════════════════════════════
describe("16K C — Different Content (different hashes → 2 points)", () => {
  it("local + global with different contentHash produce 2 merged points", () => {
    const local = mapPoints([localRecord("samples/local-a")]);
    const global = globalMapPoints([GLOBAL_POINT_B]); // different contentHash
    const merged = mergeMapPoints(local, global);
    expect(merged).toHaveLength(2);
    const origins = merged.map((p) => p.origin).sort();
    expect(origins).toEqual(["global", "local"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D — KNOWN: global known sample appears without local analysis
// ═══════════════════════════════════════════════════════════════════════════
describe("16K D — KNOWN (global known sample appears on map)", () => {
  it("global points appear on the map even without local records", async () => {
    const { app, handle } = await mkApp({
      globalIndex: { queryMapViewport: async () => ({ mapVersion: MAP_VERSION, points: [GLOBAL_POINT_A] }) } as unknown as GlobalSampleIndex,
    });
    try {
      await app.refreshGlobalPoints();
      expect(app.globalPoints).toHaveLength(1);
      expect(app.globalPoints[0].representativeSampleId).toBe("samples/global-a");
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16L-2/E — GLOBAL INSPECTION: selecting a global point loads the canonical
// analysis WITHOUT running the local analysis pipeline (Phase 2).
// ═══════════════════════════════════════════════════════════════════════════
describe("16L E — Global Inspection (no auto-analysis on selection)", () => {
  it("selectGlobalPoint inspects a global point instead of auto-running analysis", async () => {
    const analysis = makeGlobalAnalysis();
    const resolveSample = vi.fn(async () => META_GLOBAL);
    const createRunner = vi.fn();
    const fakeQueue = {
      enqueue: vi.fn(async () => "added" as const),
    };
    const { app, handle } = await mkApp({
      globalIndex: inspectionIndex(analysis),
      resolveSample,
      queue: fakeQueue as never,
      createRunner: createRunner as never,
    });
    try {
      const fakePoint = {
        sampleId: "samples/global-a", sampleIds: ["samples/global-a"],
        contentIdentity: analysis.contentIdentity,
        name: "samples/global-a", owner: "global", primaryClass: "kick",
        confidence: 1.0, originalTags: [], x: 0.3, y: 0.7, origin: "global" as const,
      };
      await app.selectGlobalPoint(fakePoint);

      // Phase 2: inspection loaded; NO analysis pipeline ran (16L rule).
      expect(app.globalInspection?.sampleId).toBe("samples/global-a");
      expect(app.globalInspection?.analysis.primaryClass).toBe("kick");
      expect(app.globalInspection?.analysis.confidence).toBe(0.96);
      expect(createRunner).not.toHaveBeenCalled();
      expect(fakeQueue.enqueue).not.toHaveBeenCalled();
      // resolveSample is only used to enrich metadata, not to run analysis.
      expect(resolveSample).toHaveBeenCalledWith("samples/global-a");
    } finally {
      await handle.db.close();
    }
  });

  it("inspection marks UNKNOWN when no global analysis exists", async () => {
    const { app, handle } = await mkApp({
      globalIndex: {
        queryMapViewport: async () => ({ mapVersion: MAP_VERSION, points: [] }),
        lookupContentIdentities: async () => [],
      } as unknown as GlobalSampleIndex,
    });
    try {
      const fakePoint = {
        sampleId: "samples/global-zz", sampleIds: ["samples/global-zz"],
        contentIdentity: { contentHash: CONTENT_HASH_B, contentHashVersion: "pcm-v1" },
        name: "samples/global-zz", owner: "global", primaryClass: "snare",
        confidence: 1.0, originalTags: [], x: 0.8, y: 0.2, origin: "global" as const,
      };
      await app.inspectGlobalPoint(fakePoint);
      expect(app.globalInspection?.error).toBe("unknown");
    } finally {
      await handle.db.close();
    }
  });

  it("inspection marks UNAVAILABLE (not UNKNOWN) on backend error", async () => {
    const { app, handle } = await mkApp({
      globalIndex: {
        queryMapViewport: async () => ({ mapVersion: MAP_VERSION, points: [] }),
        lookupContentIdentities: async () => { throw new Error("network"); },
      } as unknown as GlobalSampleIndex,
    });
    try {
      const fakePoint = {
        sampleId: "samples/global-aa", sampleIds: ["samples/global-aa"],
        contentIdentity: { contentHash: CONTENT_HASH_A, contentHashVersion: "pcm-v1" },
        name: "samples/global-aa", owner: "global", primaryClass: "kick",
        confidence: 1.0, originalTags: [], x: 0.3, y: 0.7, origin: "global" as const,
      };
      await app.inspectGlobalPoint(fakePoint);
      expect(app.globalInspection?.error).toBe("unavailable");
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F — UNAVAILABLE: backend failure doesn't block local functionality
// ═══════════════════════════════════════════════════════════════════════════
describe("16K F — UNAVAILABLE (backend failure → graceful degradation)", () => {
  it("refreshGlobalPoints swallows errors, keeps previous state", async () => {
    const { app, handle } = await mkApp({
      globalIndex: {
        queryMapViewport: async () => { throw new Error("network timeout"); },
      } as unknown as GlobalSampleIndex,
    });
    try {
      expect(app.globalPoints).toEqual([]);
      await app.refreshGlobalPoints();
      // Error swallowed, state unchanged.
      expect(app.globalPoints).toEqual([]);
    } finally {
      await handle.db.close();
    }
  });

  it("local search still works when globalIndex is unavailable", async () => {
    const { app, handle, search } = await mkApp({
      globalIndex: {
        queryMapViewport: async () => { throw new Error("unavailable"); },
      } as unknown as GlobalSampleIndex,
    });
    try {
      search.search.mockResolvedValueOnce([]);
      await app.refreshSearch();
      expect(app.results).toEqual([]);
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G — Camera: global reload doesn't change zoom/pan
// ═══════════════════════════════════════════════════════════════════════════
describe("16K G — Camera (global reload preserves zoom/pan)", () => {
  it("refreshGlobalPoints does not alter mapCamera", async () => {
    const { app, handle } = await mkApp({
      globalIndex: { queryMapViewport: async () => ({ mapVersion: MAP_VERSION, points: [GLOBAL_POINT_A] }) } as unknown as GlobalSampleIndex,
    });
    try {
      app.zoomMapBy(2);
      const afterZoom = { ...app.mapCamera };
      await app.refreshGlobalPoints();
      expect(app.mapCamera.zoom).toBe(afterZoom.zoom);
      expect(app.mapCamera.panX).toBe(afterZoom.panX);
      expect(app.mapCamera.panY).toBe(afterZoom.panY);
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H — Selection: global point can be selected
// ═══════════════════════════════════════════════════════════════════════════
describe("16K H — Selection (global point selection)", () => {
  it("selectGlobalPoint selects the local record when it already exists", async () => {
    const record = localRecord("samples/global-a");
    const { app, handle, search } = await mkApp();
    try {
      search.search.mockResolvedValueOnce([{ record, score: 1 }]);
      await app.refreshSearch();
      expect(app.focusedSampleId).toBeNull();

      const fakePoint = {
        sampleId: "samples/global-a", sampleIds: ["samples/global-a"],
        contentIdentity: record.contentHash ? { contentHash: record.contentHash, contentHashVersion: record.contentHashVersion! } : { contentHash: "", contentHashVersion: "" },
        name: record.name, owner: record.owner, primaryClass: record.primaryClass,
        confidence: record.confidence, originalTags: record.originalTags,
        x: 0.3, y: 0.7, origin: "global" as const,
      };
      await app.selectGlobalPoint(fakePoint);
      expect(app.focusedSampleId).toBe("samples/global-a");
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I — Inspector: global point displays in inspector
// ═══════════════════════════════════════════════════════════════════════════
describe("16K I — Inspector (global point in inspector)", () => {
  it("selected local record from global point has all inspector fields", async () => {
    const record = localRecord("samples/global-a", { name: "Global Kick" });
    const { app, handle, search } = await mkApp();
    try {
      search.search.mockResolvedValueOnce([{ record, score: 1 }]);
      await app.refreshSearch();
      app.selectSample(record);
      expect(app.focusedRecord).toBeDefined();
      expect(app.focusedRecord!.name).toBe("Global Kick");
      expect(app.focusedRecord!.primaryClass).toBe("kick");
      expect(app.focusedRecord!.audioFeatures).toBeDefined();
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J — Preview: global sample plays via Audiotool reference
// ═══════════════════════════════════════════════════════════════════════════
describe("16K J — Preview (global sample via Audiotool reference)", () => {
  it("previewUrlFor returns the Audiotool preview URL for a local record", async () => {
    const record = localRecord("samples/global-a");
    const previewUrlFor = vi.fn((r: SampleIndexRecord) => `https://cdn/${r.sampleId}-preview.mp3`);
    const { app, handle } = await mkApp({ previewUrlFor });
    try {
      app.selectSample(record);
      const url = (app as any).deps.previewUrlFor(record);
      expect(url).toBe("https://cdn/samples/global-a-preview.mp3");
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// K — Similarity: global sample as similarity query
// ═══════════════════════════════════════════════════════════════════════════
describe("16K K — Similarity (global sample as similarity query)", () => {
  it("findSimilar works with a global sample's fingerprint as query", () => {
    const queryFingerprint = computeSimilarityFingerprint(makeFeatures({ tonalNoiseRatio: 0.2 }));
    const targetRecord = localRecord("samples/target", {
      audioFeatures: makeFeatures({ tonalNoiseRatio: 0.8 }),
      contentHash: "different-hash-target",
    });
    targetRecord.similarityFingerprint = computeSimilarityFingerprint(targetRecord.audioFeatures);

    const results = findSimilar({
      contentIdentity: { contentHash: CONTENT_HASH_A, contentHashVersion: "pcm-v1" },
      fingerprint: queryFingerprint,
      records: [targetRecord],
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0].similarityScore).toBeGreaterThan(0);
    expect(results[0].similarityScore).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L — Machiniste: global sample transfers via existing logic
// ═══════════════════════════════════════════════════════════════════════════
describe("16K L — Machiniste (global sample via existing Machiniste logic)", () => {
  it("selected local record can be sent to Machiniste (existing flow)", async () => {
    const record = localRecord("samples/global-a");
    const machinisteSend = vi.fn(async () => ({
      slots: [{ slot: 0, applied: true, readBackMatches: true, errors: [] }],
    }));
    const { app, handle, search } = await mkApp({
      machiniste: { send: machinisteSend } as unknown as SampleMapMachinisteService,
    });
    try {
      search.search.mockResolvedValueOnce([{ record, score: 1 }]);
      await app.refreshSearch();
      app.toggleMultiSelect(record);
      await app.sendToMachiniste("machiniste-123", 0);
      expect(machinisteSend).toHaveBeenCalledWith(["samples/global-a"], "machiniste-123", [0]);
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M — No Audio Bytes: global model contains no audio bytes
// ═══════════════════════════════════════════════════════════════════════════
describe("16K M — No Audio Bytes", () => {
  it("globalMapPoints produces no audio byte containers", () => {
    const pts = globalMapPoints([GLOBAL_POINT_A, GLOBAL_POINT_B]);
    expect(() => assertNoAudioBytes(pts, "$global")).not.toThrow();
  });

  it("mergeMapPoints produces no audio byte containers", () => {
    const local = mapPoints([localRecord("samples/local-a")]);
    const global = globalMapPoints([GLOBAL_POINT_B]);
    const merged = mergeMapPoints(local, global);
    expect(() => assertNoAudioBytes(merged, "$merged")).not.toThrow();
  });

  it("local MapPoints have origin 'local'", () => {
    const pts = mapPoints([localRecord("samples/local-a")]);
    expect(pts[0].origin).toBe("local");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// N — Viewport Bound: map doesn't load unbounded global points
// ═══════════════════════════════════════════════════════════════════════════
describe("16K N — Viewport Bound (bounded global loading)", () => {
  it("refreshGlobalPoints queries with bounded limit", async () => {
    const queryFn = vi.fn(async (_q: MapViewportQuery) => ({ mapVersion: MAP_VERSION, points: [] as GlobalMapPoint[] }));
    const { app, handle } = await mkApp({
      globalIndex: { queryMapViewport: queryFn } as unknown as GlobalSampleIndex,
    });
    try {
      await app.refreshGlobalPoints();
      expect(queryFn).toHaveBeenCalledTimes(1);
      const query = queryFn.mock.calls[0][0];
      expect(query.limit).toBeLessThanOrEqual(500);
      expect(query.xMin).toBeGreaterThanOrEqual(0);
      expect(query.xMax).toBeLessThanOrEqual(1);
      expect(query.yMin).toBeGreaterThanOrEqual(0);
      expect(query.yMax).toBeLessThanOrEqual(1);
    } finally {
      await handle.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O — Identity: same contentHash → no second point
// ═══════════════════════════════════════════════════════════════════════════
describe("16K O — Identity (same contentHash → no second point)", () => {
  it("two global points with same contentHash produce one MapPoint", () => {
    const dup: GlobalMapPoint = {
      ...GLOBAL_POINT_A,
      representativeSampleId: "samples/global-a-copy",
    };
    const pts = globalMapPoints([GLOBAL_POINT_A, dup]);
    const merged = mergeMapPoints([], pts);
    expect(merged).toHaveLength(1);
  });

  it("local + two global with same hash produce one merged point", () => {
    const local = mapPoints([localRecord("samples/local-a")]);
    const dup: GlobalMapPoint = {
      ...GLOBAL_POINT_A,
      representativeSampleId: "samples/global-a-copy",
    };
    const global = globalMapPoints([GLOBAL_POINT_A, dup]);
    const merged = mergeMapPoints(local, global);
    expect(merged).toHaveLength(1);
    expect(merged[0].origin).toBe("local");
  });
});
