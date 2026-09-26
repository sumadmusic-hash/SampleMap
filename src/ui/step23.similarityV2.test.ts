/**
 * STEP23 — V2 Similarity Product Surface (Find Similar).
 *
 * Covers the pure view-models (`./view.ts` STEP23 helpers) and the app-level
 * integration (`SampleMapApp.openFindSimilarV2` / `closeFindSimilarV2`) against
 * a REAL IndexedDB index + REAL `SampleMapSearchEngine` + REAL STEP22
 * `rankSimilar`. Fixtures are FIXTURE-class (STEP21 corpus, `analyzeCorpus`) —
 * never real recorded audio (§16).
 */
import { describe, it, expect, afterEach } from "vitest";
import { SampleMapApp, emptySimilarityState } from "./app";
import type { SampleMapAppDeps, SimilarityState } from "./app";
import { openTestDatabase, makeSample } from "../persistence/test-helpers";
import type { DatabaseHandle } from "../persistence/db";
import { SampleMapSearchEngine } from "../search/searchEngine";
import { PreviewService } from "../preview/previewService";
import type { SampleMapMachinisteService } from "../machiniste/machinisteService";
import { createMemoryEp7ConsentStore } from "./ep7Consent";
import {
  rankSimilar,
  RANKING_DEFAULT_LIMIT,
} from "../analysis/similarityRanking";
import { ANALYSIS_VERSION } from "../analysis/sampleAnalysisV2";
import type { SampleAnalysisV2 } from "../analysis/sampleAnalysisV2";
import {
  computeSoundCharacter,
  computeSoundCharacterQuality,
} from "../analysis/soundCharacter";
import type { SoundCharacter } from "../analysis/soundCharacter";
import { analyzeCorpus } from "../audio/v2Fixtures";
import type { SampleIndexRecord } from "../persistence/indexStore";
import {
  similarityV2Header,
  similarityV2ScoreLabel,
  similarityV2LimitedLabel,
  similarityV2StatusText,
} from "./view";

const openHandles: DatabaseHandle[] = [];
async function openDb(): Promise<DatabaseHandle> {
  const h = await openTestDatabase();
  openHandles.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(
    openHandles
      .splice(0)
      .map((h) => h.db.close().catch(() => undefined)),
  );
});

/** Deterministic STEP21-corpus V2 records (FIXTURE-class evidence). */
const _analysis = new Map<string, SampleAnalysisV2>();
function corpusAnalysis(name: string): SampleAnalysisV2 {
  let a = _analysis.get(name);
  if (!a) {
    const features = analyzeCorpus(name, 44100);
    const soundCharacter = computeSoundCharacter(features);
    a = {
      analysisVersion: ANALYSIS_VERSION,
      features,
      soundCharacter,
      quality: computeSoundCharacterQuality(soundCharacter),
    };
    _analysis.set(name, a);
  }
  return a;
}
function v2Record(id: string, corpusName: string): SampleIndexRecord {
  return makeSample(id, { analysisV2: corpusAnalysis(corpusName) });
}
/** A record with a hand-built SoundCharacter (for partial/shared-dim tests). */
function charRecord(id: string, soundCharacter: SoundCharacter): SampleIndexRecord {
  return makeSample(id, {
    analysisV2: {
      analysisVersion: ANALYSIS_VERSION,
      features: analyzeCorpus("pureTone440", 44100),
      soundCharacter,
      quality: computeSoundCharacterQuality(soundCharacter),
    },
  });
}

const granted = () => {
  const store = createMemoryEp7ConsentStore();
  store.grant();
  return store;
};

interface Rig {
  app: SampleMapApp;
  db: { close(): Promise<void> };
  search: SampleMapSearchEngine;
  index: import("../persistence/indexStore").IndexStore;
}

async function rig(
  records: readonly SampleIndexRecord[],
  over: Partial<SampleMapAppDeps> = {},
  depsIndex = true,
): Promise<Rig> {
  const handle = await openDb();
  const index = depsIndex ? handle.index : undefined;
  if (index) for (const r of records) await index.put(r);
  const search = new SampleMapSearchEngine(handle.index);
  const preview = {} as unknown as PreviewService;
  const machiniste = {} as unknown as SampleMapMachinisteService;
  const createRunner = (() => ({
    start: async () => undefined,
    pause: () => undefined,
    isRunning: () => false,
    isPaused: () => false,
  })) as unknown as SampleMapAppDeps["createRunner"];
  const deps: SampleMapAppDeps = {
    queue: { enqueue: async () => "added", countByStatus: async () => 0 } as never,
    index,
    search,
    preview,
    machiniste,
    createRunner,
    fetchPage: async () => ({ samples: [], nextPageToken: undefined }),
    known: { getUpdatedAt: async () => undefined },
    previewUrlFor: () => undefined,
    analysisBuild: "build-step23",
    ep7Consent: granted(),
    ...over,
  };
  const app = new SampleMapApp(deps);
  if (index) await app.refreshSearch();
  return { app, db: handle.db, search, index: handle.index };
}

/** The canonical snapshot a fresh open on `queryId` must reproduce. */
function expectedIds(records: readonly SampleIndexRecord[], queryId: string): string[] {
  const query = records.find((r) => r.sampleId === queryId)!;
  return rankSimilar(query, records, {
    limit: RANKING_DEFAULT_LIMIT,
    includeSelf: false,
  }).map((r) => r.sampleId);
}

describe("STEP23 view-models (pure)", () => {
  it("similarityV2Header shows the query sample name (snapshot, not focus)", () => {
    expect(similarityV2Header("Kick A")).toBe("Similar to: Kick A");
    expect(similarityV2Header(undefined)).toBe("Similar to: —");
  });

  it("similarityV2ScoreLabel renders 'Similarity NN%', never 'Confidence'", () => {
    expect(similarityV2ScoreLabel(0.96)).toBe("Similarity 96%");
    expect(similarityV2ScoreLabel(1)).toBe("Similarity 100%");
    expect(similarityV2ScoreLabel(0)).toBe("Similarity 0%");
    expect(similarityV2ScoreLabel(1.5)).toBe("Similarity 100%"); // clamped
    expect(similarityV2ScoreLabel(-0.2)).toBe("Similarity 0%"); // clamped
  });

  it("similarityV2LimitedLabel appears only when data-backed on a ready snapshot", () => {
    const base: SimilarityState = {
      ...emptySimilarityState(),
      open: true,
      status: "ready",
      queryLimited: true,
    };
    expect(similarityV2LimitedLabel(base)).toBe("Limited analysis");
    expect(similarityV2LimitedLabel({ ...base, queryLimited: false })).toBeUndefined();
    const notReady = { ...base, status: "empty" as const };
    expect(similarityV2LimitedLabel(notReady)).toBeUndefined();
  });

  it("similarityV2StatusText maps each status deterministically", () => {
    const idle: SimilarityState = { ...emptySimilarityState(), open: true };
    expect(similarityV2StatusText(idle)).toBeUndefined();
    const ready = { ...idle, status: "ready" as const, results: [{ sampleId: "x" }] as never };
    expect(similarityV2StatusText(ready)).toBeUndefined();
    const readyEmpty = { ...idle, status: "ready" as const, results: [] as never };
    expect(similarityV2StatusText(readyEmpty)).toBe("No similar samples found.");
    const empty = { ...idle, status: "empty" as const, error: "no v2" };
    expect(similarityV2StatusText(empty)).toBe("no v2");
    const error = { ...idle, status: "error" as const, error: "boom" };
    expect(similarityV2StatusText(error)).toBe("boom");
    expect(similarityV2StatusText({ ...error, error: undefined })).toBe("Find Similar failed.");
  });
});

describe("STEP23 open/close semantics", () => {
  const CORPUS = [
    "pureTone440",
    "sustainedTone",
    "lowSine110",
    "whiteNoise",
    "impulse",
    "highSine2000",
  ] as const;

  it("opens into an empty state when nothing is focused", async () => {
    const { app } = await rig([]);
    await app.openFindSimilarV2();
    expect(app.similarityV2.open).toBe(true);
    expect(app.similarityV2.status).toBe("empty");
    expect(app.similarityV2.results).toEqual([]);
    expect(app.similarityV2.error).toMatch(/Select a sample/);
  });

  it("a focused V1-only record yields an empty state and is NEVER auto-analyzed (§47)", async () => {
    const v1 = makeSample("samples/v1only");
    const { app, index: rigIndex } = await rig([v1]);
    app.selectSample(v1);
    await app.openFindSimilarV2();
    expect(app.similarityV2.open).toBe(true);
    expect(app.similarityV2.status).toBe("empty");
    expect(app.similarityV2.error).toMatch(/no V2 sound-character/);
    expect(v1.analysisV2).toBeUndefined();
    expect((await rigIndex.get("samples/v1only"))!.analysisV2).toBeUndefined();
  });

  it("index unavailable surfaces status error (infrastructure, not empty)", async () => {
    const { app } = await rig([], {}, false);
    const rec = v2Record("samples/query", "pureTone440");
    app.selectSample(rec);
    await app.openFindSimilarV2();
    expect(app.similarityV2.open).toBe(true);
    expect(app.similarityV2.status).toBe("error");
    expect(app.similarityV2.error).toMatch(/index unavailable/);
  });

  it("ranks deterministically via the REAL rankSimilar and excludes the query", async () => {
    const records = CORPUS.map((c, i) => v2Record(`samples/c${i}`.padEnd(9, "0"), c));
    records[0] = v2Record("samples/query", "pureTone440");
    const { app } = await rig(records);
    app.selectSample(records[0]);
    await app.openFindSimilarV2();

    expect(app.similarityV2.status).toBe("ready");
    expect(app.similarityV2.querySampleId).toBe("samples/query");
    expect(app.similarityV2.open).toBe(true);

    const expected = rankSimilar(records[0], records, {
      limit: RANKING_DEFAULT_LIMIT,
      includeSelf: false,
    });
    const rows = app.similarityV2.results;
    expect(rows.map((r) => r.sampleId)).toEqual(expected.map((e) => e.sampleId));
    expect(rows).not.toContainEqual(
      expect.objectContaining({ sampleId: "samples/query" }),
    );
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i].similarity).toBe(expected[i].similarity);
      expect(rows[i].sharedDimensionCount).toBe(expected[i].sharedDimensionCount);
      expect(rows[i].record.sampleId).toBe(rows[i].sampleId);
      expect(rows[i].similarity).toBeGreaterThan(0);
      expect(rows[i].similarity).toBeLessThanOrEqual(1);
    }
  });

  it("the open surface is a SNAPSHOT tied to its query; focus change never re-ranks (§29/§30)", async () => {
    const records = CORPUS.map((c, i) => v2Record(`samples/c${i}`.padEnd(9, "0"), c));
    records[0] = v2Record("samples/queryA", "pureTone440");
    records[1] = v2Record("samples/queryB", "whiteNoise");
    const { app } = await rig(records);
    app.selectSample(records[0]);
    await app.openFindSimilarV2();
    const snapshot = JSON.parse(JSON.stringify(app.similarityV2)) as SimilarityState;
    expect(snapshot.querySampleId).toBe("samples/queryA");

    app.selectSample(records[1]);
    expect(app.similarityV2).toEqual(snapshot);

    await app.openFindSimilarV2();
    expect(app.similarityV2.querySampleId).toBe("samples/queryB");
    expect(app.similarityV2.results.map((r) => r.sampleId)).toEqual(
      expectedIds(records, "samples/queryB"),
    );
  });

  it("close drops the snapshot entirely; reopen recomputes fresh and deterministic", async () => {
    const records = CORPUS.map((c, i) => v2Record(`samples/c${i}`.padEnd(9, "0"), c));
    records[0] = v2Record("samples/query", "lowSine110");
    const { app } = await rig(records);
    app.selectSample(records[0]);
    await app.openFindSimilarV2();
    const first = app.similarityV2.results.map((r) => r.sampleId);
    expect(first.length).toBeGreaterThan(0);

    app.closeFindSimilarV2();
    expect(app.similarityV2).toEqual(emptySimilarityState());

    await app.openFindSimilarV2();
    expect(app.similarityV2.status).toBe("ready");
    expect(app.similarityV2.results.map((r) => r.sampleId)).toEqual(first);
  });
});

describe("STEP23 mixed library: 70 V2 + 30 V1-only (all browsable, only V2 ranks)", () => {
  const NAMES = [
    "pureTone440",
    "sustainedTone",
    "lowSine110",
    "whiteNoise",
    "pinkNoise",
    "impulse",
    "shortClick",
    "highSine2000",
    "detunedHarmonic",
    "bellLike",
  ];

  function buildLibrary(): SampleIndexRecord[] {
    const records: SampleIndexRecord[] = [];
    for (let i = 0; i < 70; i++) {
      records.push(
        v2Record(`samples/v2-${String(i).padStart(3, "0")}`, NAMES[i % NAMES.length]),
      );
    }
    for (let i = 0; i < 30; i++) {
      records.push(
        makeSample(`samples/v1-${String(i).padStart(3, "0")}`, { name: "V1 Only" }),
      );
    }
    return records;
  }

  it("all 100 samples are browsable through the V1 search surface", async () => {
    const { app } = await rig(buildLibrary());
    expect(app.results.length).toBe(100);
  });

  it("find-similar results come exclusively from the V2 subset; V1-only never ranks", async () => {
    const records = buildLibrary();
    const { app } = await rig(records);
    const query = records[0]; // v2-000
    app.selectSample(query);
    await app.openFindSimilarV2();

    expect(app.similarityV2.status).toBe("ready");
    const rows = app.similarityV2.results;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(RANKING_DEFAULT_LIMIT);
    for (const r of rows) {
      expect(r.sampleId).toMatch(/^samples\/v2-/);
      expect(r.sampleId).not.toBe(query.sampleId);
      expect(r.similarity).toBeGreaterThan(0);
      expect(r.similarity).toBeLessThanOrEqual(1);
    }
    expect(rows.some((r) => r.sampleId.startsWith("samples/v1-"))).toBe(false);
    expect(rows.map((r) => r.sampleId)).toEqual(expectedIds(records, query.sampleId));
  });

  it("focusing a V1-only sample in the mixed library yields an honest empty state", async () => {
    const records = buildLibrary();
    const { app } = await rig(records);
    const v1 = records[70];
    app.selectSample(v1);
    await app.openFindSimilarV2();
    expect(app.similarityV2.status).toBe("empty");
    expect(app.similarityV2.results).toEqual([]);
    expect(app.similarityV2.querySampleId).toBeUndefined();
  });
});

describe("STEP23 partial data — shared-dimension semantics (§35)", () => {
  const emptyChar = (): SoundCharacter => ({
    brightness: null,
    density: null,
    transient: null,
    duration: null,
    tonality: null,
    noisiness: null,
    dynamics: null,
    complexity: null,
  });

  it("a partial query ranks candidates sharing >=1 dim and excludes zero-shared ones", async () => {
    const query = charRecord("samples/q", {
      ...emptyChar(),
      brightness: 0.5,
      tonality: 0.8,
    });
    const shareOne = charRecord("samples/one", {
      ...emptyChar(),
      brightness: 0.5,
    });
    const shareBoth = charRecord("samples/both", {
      ...emptyChar(),
      brightness: 0.5,
      tonality: 0.8,
    });
    const zeroShared = charRecord("samples/zero", {
      ...emptyChar(),
      density: 0.9,
      transient: 0.9,
      duration: 0.2,
    });
    const records = [query, shareOne, shareBoth, zeroShared];
    const { app } = await rig(records);
    app.selectSample(query);
    await app.openFindSimilarV2();

    const rows = app.similarityV2.results;
    expect(app.similarityV2.status).toBe("ready");
    const ids = rows.map((r) => r.sampleId);
    expect(ids).toContain("samples/one");
    expect(ids).toContain("samples/both");
    expect(ids).not.toContain("samples/zero");
    // zero-shared excluded by the null policy, never surfaced as 0.
    expect(rows.every((r) => r.similarity > 0)).toBe(true);
    const exact = rows.find((r) => r.sampleId === "samples/both")!;
    expect(exact.similarity).toBe(1); // identical on both shared dims
    expect(rows.find((r) => r.sampleId === "samples/one")!.similarity).toBeCloseTo(1, 5);
  });
});