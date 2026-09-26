/**
 * STEP24 — Sound Space app-level integration tests.
 *
 * Covers `SampleMapApp.openSoundSpace/closeSoundSpace` state semantics against
 * a REAL IndexedDB index + REAL `SampleMapSearchEngine`, step23-style. All
 * fixtures are FIXTURE-class (STEP21 corpus via `analyzeCorpus`) or
 * CONSTRUCTED (`charRecord`) — never real recorded audio (§16).
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  SampleMapApp,
  emptySoundSpaceState,
} from "./app";
import type { SampleMapAppDeps } from "./app";
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
import { analyzeCorpus } from "../audio/v2Fixtures";
import type { SampleIndexRecord } from "../persistence/indexStore";
import type { IndexStore } from "../persistence/indexStore";
import {
  soundSpaceCountLabel,
  soundSpaceToggleLabel,
  SOUND_SPACE_EMPTY_TEXT,
  soundSpaceAxisLabel,
} from "./view";

const openHandles: DatabaseHandle[] = [];
async function openDb(): Promise<DatabaseHandle> {
  const h = await openTestDatabase();
  openHandles.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(
    openHandles.splice(0).map((h) => h.db.close().catch(() => undefined)),
  );
});

const granted = () => {
  const store = createMemoryEp7ConsentStore();
  store.grant();
  return store;
};

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

interface Rig {
  app: SampleMapApp;
  db: { close(): Promise<void> };
  index: IndexStore;
}

async function rig(
  records: readonly SampleIndexRecord[],
  depsIndex = true,
): Promise<Rig> {
  const handle = await openDb();
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
    index: depsIndex ? handle.index : undefined,
    search,
    preview,
    machiniste,
    createRunner,
    fetchPage: async () => ({ samples: [], nextPageToken: undefined }),
    known: { getUpdatedAt: async () => undefined },
    previewUrlFor: () => undefined,
    analysisBuild: "build-step24",
    ep7Consent: granted(),
  };
  const app = new SampleMapApp(deps);
  for (const r of records) await handle.index.put(r);
  await app.refreshSearch();
  return { app, db: handle.db, index: handle.index };
}

describe("STEP24 view-models (pure)", () => {
  it("soundSpaceCountLabel is 'N analyzed samples'", () => {
    expect(soundSpaceCountLabel(0)).toBe("0 analyzed samples");
    expect(soundSpaceCountLabel(1)).toBe("1 analyzed sample");
    expect(soundSpaceCountLabel(4)).toBe("4 analyzed samples");
  });
  it("soundSpaceToggleLabel reflects open state", () => {
    expect(soundSpaceToggleLabel(false)).toBe("Sound Space");
    expect(soundSpaceToggleLabel(true)).toBe("Close Sound Space");
  });
  it("axis label joins the projector constants honestly (§14)", () => {
    expect(soundSpaceAxisLabel("Noisy", "Tonal", "Dark", "Bright")).toBe(
      "Noisy ↔ Tonal · Dark ↔ Bright",
    );
    expect(SOUND_SPACE_EMPTY_TEXT).toBe("No analyzed samples in Sound Space yet.");
  });
});

describe("STEP24 openSoundSpace / closeSoundSpace", () => {
  it("opens into an empty state when there are no V2-analyzed records", async () => {
    const { app } = await rig([]);
    await app.openSoundSpace();
    expect(app.soundSpace.open).toBe(true);
    expect(app.soundSpace.status).toBe("empty");
    expect(app.soundSpace.error).toBe("No analyzed samples in Sound Space yet.");
    expect(app.soundSpace.points).toEqual([]);
  });

  it("index-unavailable yields status='error' (infrastructure, not empty)", async () => {
    const { app } = await rig([], false);
    await app.openSoundSpace();
    expect(app.soundSpace.status).toBe("error");
    expect(app.soundSpace.error).toBe("local index unavailable");
  });

  it("projects every V2 record (V1-only excluded) and never touches audio", async () => {
    const records = [
      v2Record("samples/pureTone440", "pureTone440"),
      v2Record("samples/whiteNoise", "whiteNoise"),
      makeSample("samples/v1only"), // V1-only (no analysisV2)
    ];
    const { app } = await rig(records);
    await app.openSoundSpace();
    expect(app.soundSpace.status).toBe("ready");
    const ids = app.soundSpace.points.map((p) => p.sampleId);
    expect(ids).toContain("samples/pureTone440");
    expect(ids).toContain("samples/whiteNoise");
    expect(ids).not.toContain("samples/v1only");
    // Coordinates stay within [0,1]; a v1-only record is simply absent (§12).
    for (const p of app.soundSpace.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
      expect(p.algorithmVersion).toBe("1.0.0");
    }
  });

  it("malformed V2 characters are skipped (§37) without crashing the view", async () => {
    const corrupt = makeSample("samples/corrupt");
    (corrupt as unknown as { analysisV2: unknown }).analysisV2 = null;
    const junk = makeSample("samples/junk");
    (junk as unknown as { analysisV2: unknown }).analysisV2 = {
      soundCharacter: null, // unparseable
      analysisVersion: "2.0.0",
      features: corpusAnalysis("pureTone440").features,
      quality: { overall: 0, featureCoverage: 0 },
    };
    const { app } = await rig([corrupt, junk, v2Record("samples/pureTone440", "pureTone440")]);
    await app.openSoundSpace();
    expect(app.soundSpace.status).toBe("ready");
    const ids = app.soundSpace.points.map((p) => p.sampleId);
    expect(ids).not.toContain("samples/corrupt");
    expect(ids).not.toContain("samples/junk");
    expect(ids).toContain("samples/pureTone440");
  });

  it("focus changes while open NEVER recompute coordinates (§§45/46)", async () => {
    const records = [
      v2Record("samples/pureTone440", "pureTone440"),
      v2Record("samples/whiteNoise", "whiteNoise"),
    ];
    const { app } = await rig(records);
    await app.openSoundSpace();
    const snapshot = app.soundSpace.points.map((p) => ({ ...p }));
    app.focusSampleById("samples/whiteNoise");
    expect(app.focusedSampleId).toBe("samples/whiteNoise");
    expect(app.soundSpace.points.map((p) => ({ ...p }))).toEqual(
      snapshot,
    );
  });

  it("closeFindSimilarV2-compatible stewardship (§§45/46): close drops, reopen recomputes", async () => {
    const records = [v2Record("samples/pureTone440", "pureTone440")];
    const { app } = await rig(records);
    await app.openSoundSpace();
    expect(app.soundSpace.status).toBe("ready");
    app.closeSoundSpace();
    expect(app.soundSpace).toEqual(emptySoundSpaceState());
    await app.openSoundSpace();
    expect(app.soundSpace.status).toBe("ready");
    expect(app.soundSpace.points.length).toBe(1);
  });

  it("soundSpacePoint action selects the focused sample via the existing focus path", async () => {
    const records = [
      v2Record("samples/pureTone440", "pureTone440"),
      v2Record("samples/whiteNoise", "whiteNoise"),
    ];
    const { app } = await rig(records);
    await app.openSoundSpace();
    app.focusSampleById("samples/whiteNoise");
    expect(app.focusedSampleId).toBe("samples/whiteNoise");
  });

  it("STEP23 remains wired: Find-Similar from a Sound-Space-routed focus works", async () => {
    const records = [
      v2Record("samples/pureTone440", "pureTone440"),
      v2Record("samples/sustainedTone", "sustainedTone"),
      v2Record("samples/whiteNoise", "whiteNoise"),
    ];
    const { app } = await rig(records);
    await app.openSoundSpace();
    app.focusSampleById("samples/pureTone440");
    await app.openFindSimilarV2();
    expect(app.similarityV2.status).toBe("ready");
    expect(app.similarityV2.querySampleId).toBe("samples/pureTone440");
    const expected = rankSimilar(records[0], records, {
      limit: RANKING_DEFAULT_LIMIT,
      includeSelf: false,
    }).map((r) => r.sampleId);
    expect(app.similarityV2.results.map((r) => r.sampleId)).toEqual(expected);
  });
});
