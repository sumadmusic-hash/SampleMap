/**
 * STEP25 — V2 Sound Space Interaction, Filtering & Compare — app-level
 * integration tests against a REAL IndexedDB index + REAL SearchEngine
 * (step24-style). Fixtures are FIXTURE-class (STEP21 corpus via
 * `analyzeCorpus`) or CONSTRUCTED — never real recorded audio (§16).
 */
import { describe, it, expect, afterEach } from "vitest";
import { SampleMapApp, emptySoundSpaceState } from "./app";
import type { SampleMapAppDeps } from "./app";
import { openTestDatabase, makeSample } from "../persistence/test-helpers";
import type { DatabaseHandle } from "../persistence/db";
import { SampleMapSearchEngine } from "../search/searchEngine";
import { PreviewService } from "../preview/previewService";
import type { SampleMapMachinisteService } from "../machiniste/machinisteService";
import { createMemoryEp7ConsentStore } from "./ep7Consent";
import { rankSimilar, RANKING_DEFAULT_LIMIT } from "../analysis/similarityRanking";
import { ANALYSIS_VERSION } from "../analysis/sampleAnalysisV2";
import type { SampleAnalysisV2 } from "../analysis/sampleAnalysisV2";
import { computeSoundCharacter, computeSoundCharacterQuality } from "../analysis/soundCharacter";
import { analyzeCorpus } from "../audio/v2Fixtures";
import type { SampleIndexRecord } from "../persistence/indexStore";
import type { IndexStore } from "../persistence/indexStore";
import {
  soundSpaceVisibleLabel,
  characterValueLabel,
  compareEntryLabel,
  COMPARE_MAX,
  visibleSoundSpacePoints,
} from "./view";
import {
  matchesSoundCharacter,
  isFilterActive,
  isRangeActive,
  normalizeRange,
  emptySoundSpaceFilter,
  SOUND_SPACE_DIM_NAMES,
} from "../analysis/soundSpaceFilter";
import type { SoundSpaceCharFilter } from "../analysis/soundSpaceFilter";

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

function charOf(name: string): ReturnType<typeof computeSoundCharacter> {
  return corpusAnalysis(name).soundCharacter;
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
    analysisBuild: "build-step25",
    ep7Consent: granted(),
  };
  const app = new SampleMapApp(deps);
  for (const r of records) await handle.index.put(r);
  await app.refreshSearch();
  return { app, db: handle.db, index: handle.index };
}

/** Resolve a known record for selection via the populated results list. */
function knownRecord(app: SampleMapApp, id: string): SampleIndexRecord {
  const found = app.results.find((r) => r.record.sampleId === id);
  if (!found) throw new Error(`record ${id} not found in results`);
  return found.record;
}

const TONE_ID = "samples/pureTone440";
const NOISE_ID = "samples/whiteNoise";
const TONE_CHAR = { tonality: { min: 0.9, max: 1 } } satisfies SoundSpaceCharFilter;

describe("STEP25 view-models (pure)", () => {
  it("soundSpaceVisibleLabel shows All samples / N of M", () => {
    expect(soundSpaceVisibleLabel(4, 4)).toBe("All samples");
    expect(soundSpaceVisibleLabel(0, 4)).toBe("0 of 4 samples");
    expect(soundSpaceVisibleLabel(2, 9)).toBe("2 of 9 samples");
  });
  it("characterValueLabel renders null/undefined as em dash, numbers to 2dp", () => {
    expect(characterValueLabel(null)).toBe("—");
    expect(characterValueLabel(undefined)).toBe("—");
    expect(characterValueLabel(0)).toBe("0.00");
    expect(characterValueLabel(0.9944)).toBe("0.99");
  });
  it("compareEntryLabel keeps a name, fallback em dash; COMPARE_MAX=4", () => {
    expect(compareEntryLabel("pure tone")).toBe("pure tone");
    expect(compareEntryLabel("   ")).toBe("—");
    expect(compareEntryLabel("")).toBe("—");
    expect(COMPARE_MAX).toBe(4);
  });
  it("filter primitives: active-range & active-filter semantics", () => {
    expect(isRangeActive(undefined)).toBe(false);
    expect(isRangeActive({ min: 0, max: 1 })).toBe(false);
    expect(isRangeActive({ min: 0, max: 0.9 })).toBe(true);
    expect(isRangeActive({ min: 0.1, max: 1 })).toBe(true);
    expect(isFilterActive({})).toBe(false);
    expect(isFilterActive({ tonality: { min: 0, max: 1 } })).toBe(false);
    expect(isFilterActive({ tonality: { min: 0.5, max: 1 } })).toBe(true);
    expect(emptySoundSpaceFilter()).toEqual({});
    expect(normalizeRange(0.9, 0.1)).toEqual({ min: 0.1, max: 0.9 });
  });

  it("matchesSoundCharacter: AND semantics, null dims fail, inactive dims pass", () => {
    const char = charOf("pureTone440");
    expect(matchesSoundCharacter(char, {})).toBe(true);
    expect(matchesSoundCharacter(char, { tonality: { min: 0, max: 1 } })).toBe(true);
    expect(matchesSoundCharacter(char, { tonality: { min: 0.999, max: 1 } })).toBe(false);
    // Missing dim: an ACTIVE range fails on null; an inactive range is a noop.
    const m = { ...char, tonality: null } as typeof char;
    expect(matchesSoundCharacter(m, { tonality: { min: 0.99, max: 1 } })).toBe(false);
    expect(matchesSoundCharacter(m, { tonality: { min: 0, max: 1 } })).toBe(true);
    // AND: a second active dim must also pass.
    expect(matchesSoundCharacter(char, { tonality: { min: 0.9, max: 1 }, noisiness: { min: 0, max: 0.2 } })).toBe(true);
    expect(matchesSoundCharacter(char, { tonality: { min: 0.9, max: 1 }, noisiness: { min: 0.9, max: 1 } })).toBe(false);
  });

  it("visibleSoundSpacePoints never mutates and stays order-preserving", () => {
    const pt = [TONE_ID, NOISE_ID].map((sampleId, i) => ({ sampleId, x: i / 10, y: 1 - i / 10 }));
    const recordsById = new Map<string, SampleIndexRecord>([
      [TONE_ID, v2Record(TONE_ID, "pureTone440")],
      [NOISE_ID, v2Record(NOISE_ID, "whiteNoise")],
    ]);
    const src = pt.map((p) => ({ ...p }));
    const out = visibleSoundSpacePoints({ points: pt, recordsById }, TONE_CHAR);
    expect(out.map((p) => p.sampleId)).toEqual([TONE_ID]);
    expect(pt).toEqual(src); // no mutation
    expect(visibleSoundSpacePoints({ points: pt, recordsById }, {}).length).toBe(2);
    const narrowed = visibleSoundSpacePoints(
      { points: pt, recordsById },
      {},
      new Set([TONE_ID]),
    );
    expect(narrowed.map((p) => p.sampleId)).toEqual([TONE_ID]);
  });

  it("all eight canonical dims are labeled in canonical order", () => {
    expect(SOUND_SPACE_DIM_NAMES).toEqual([
      "brightness",
      "density",
      "transient",
      "duration",
      "tonality",
      "noisiness",
      "dynamics",
      "complexity",
    ]);
  });
});

describe("STEP25 filter state", () => {
  it("setSoundSpaceFilter replaces state; clearSoundSpaceFilter resets; session-local", async () => {
    const { app } = await rig([
      v2Record(TONE_ID, "pureTone440"),
      v2Record(NOISE_ID, "whiteNoise"),
    ]);
    expect(app.soundSpaceFilter).toEqual({});
    app.setSoundSpaceFilter(TONE_CHAR);
    expect(app.soundSpaceFilter).toEqual(TONE_CHAR);
    app.clearSoundSpaceFilter();
    expect(app.soundSpaceFilter).toEqual({});
  });

  it("filtering does not delete or move points — projection snapshot untouched", async () => {
    const { app } = await rig([
      v2Record(TONE_ID, "pureTone440"),
      v2Record(NOISE_ID, "whiteNoise"),
    ]);
    await app.openSoundSpace();
    const before = app.soundSpace.points.map((p) => ({ ...p }));
    app.setSoundSpaceFilter(TONE_CHAR);
    expect(app.soundSpace.points.map((p) => ({ ...p }))).toEqual(before);
    const visible = visibleSoundSpacePoints(
      { points: app.soundSpace.points, recordsById: app.soundSpace.recordsById },
      app.soundSpaceFilter,
    );
    expect(visible.map((p) => p.sampleId)).toEqual([TONE_ID]);
    // points.length still the full snapshot AFTER the filter was applied.
    expect(app.soundSpace.points.length).toBe(2);
  });

  it("empty result under an active filter keeps the point list but no visible rows", async () => {
    const { app } = await rig([v2Record(TONE_ID, "pureTone440")]);
    await app.openSoundSpace();
    app.setSoundSpaceFilter({ tonality: { min: 0, max: 0.5 } });
    const visible = visibleSoundSpacePoints(
      { points: app.soundSpace.points, recordsById: app.soundSpace.recordsById },
      app.soundSpaceFilter,
    );
    expect(visible.length).toBe(0);
    expect(app.soundSpace.points.length).toBe(1);
  });

  it("focus survives applying and clearing the filter", async () => {
    const { app } = await rig([
      v2Record(TONE_ID, "pureTone440"),
      v2Record(NOISE_ID, "whiteNoise"),
    ]);
    await app.openSoundSpace();
    app.focusSampleById(NOISE_ID);
    app.setSoundSpaceFilter(TONE_CHAR);
    expect(app.focusedSampleId).toBe(NOISE_ID);
    app.clearSoundSpaceFilter();
    expect(app.focusedSampleId).toBe(NOISE_ID);
  });

  it("search + filter compose via the existing SearchEngine result set", async () => {
    const { app } = await rig([
      makeSample(TONE_ID, { analysisV2: corpusAnalysis("pureTone440"), name: "pure tone 440" }),
      makeSample(NOISE_ID, { analysisV2: corpusAnalysis("whiteNoise"), name: "white noise" }),
    ]);
    await app.openSoundSpace();
    // SearchState with text that narrows to the noise record.
    app.searchState.text = "white noise";
    await app.refreshSearch();
    const searchIds = new Set(app.results.map((r) => r.record.sampleId));
    expect(searchIds.has(NOISE_ID)).toBe(true);
    expect(searchIds.has(TONE_ID)).toBe(false);
    app.setSoundSpaceFilter(TONE_CHAR);
    const visible = visibleSoundSpacePoints(
      { points: app.soundSpace.points, recordsById: app.soundSpace.recordsById },
      app.soundSpaceFilter,
      searchIds,
    );
    expect(visible.length).toBe(0); // noise filtered out by tonality too.
    app.clearSoundSpaceFilter();
    const afterClear = visibleSoundSpacePoints(
      { points: app.soundSpace.points, recordsById: app.soundSpace.recordsById },
      app.soundSpaceFilter,
      searchIds,
    );
    expect(afterClear.map((p) => p.sampleId)).toEqual([NOISE_ID]);
  });
});

describe("STEP25 Compare surface", () => {
  async function openSoundSpaceWith(records: SampleIndexRecord[]) {
    const rigged = await rig(records);
    await rigged.app.openSoundSpace();
    return rigged;
  }

  it("openSoundSpaceCompare with <2 selected keeps compare closed", async () => {
    const { app } = await openSoundSpaceWith([
      v2Record(TONE_ID, "pureTone440"),
      v2Record(NOISE_ID, "whiteNoise"),
    ]);
    app.openSoundSpaceCompare();
    expect(app.soundSpaceCompare.open).toBe(false);
    app.toggleMultiSelect(knownRecord(app, TONE_ID));
    app.openSoundSpaceCompare();
    expect(app.soundSpaceCompare.open).toBe(false);
    expect(app.soundSpaceCompare.sampleIds).toEqual([]);
  });

  it("openSoundSpaceCompare with 2..4 selected opens and reuses the selection order", async () => {
    const { app } = await openSoundSpaceWith([
      v2Record(TONE_ID, "pureTone440"),
      v2Record(NOISE_ID, "whiteNoise"),
    ]);
    app.toggleMultiSelect(knownRecord(app, NOISE_ID));
    app.toggleMultiSelect(knownRecord(app, TONE_ID));
    app.openSoundSpaceCompare();
    expect(app.soundSpaceCompare.open).toBe(true);
    expect(app.soundSpaceCompare.sampleIds).toEqual([NOISE_ID, TONE_ID]);
    expect(app.soundSpaceCompareCharacters.length).toBe(2);
  });

  it("compare is capped at 4 even when more are selected", async () => {
    const ids = ["a", "b", "c", "d", "e"].map((id) => v2Record(`samples/${id}`, "pureTone440"));
    const { app } = await openSoundSpaceWith(ids);
    for (const id of ["a", "b", "c", "d", "e"]) {
      app.toggleMultiSelect(knownRecord(app, `samples/${id}`));
    }
    expect(app.selectedSampleIds.length).toBe(5);
    app.openSoundSpaceCompare();
    expect(app.soundSpaceCompare.open).toBe(true);
    expect(app.soundSpaceCompare.sampleIds.length).toBe(COMPARE_MAX);
    expect(app.soundSpaceCompareCharacters.length).toBe(COMPARE_MAX);
  });

  it("compare is non-mutating: opening/closing leaves the selection untouched", async () => {
    const { app } = await openSoundSpaceWith([
      v2Record(TONE_ID, "pureTone440"),
      v2Record(NOISE_ID, "whiteNoise"),
    ]);
    app.toggleMultiSelect(knownRecord(app, TONE_ID));
    app.toggleMultiSelect(knownRecord(app, NOISE_ID));
    const selBefore = [...app.selectedSampleIds];
    app.openSoundSpaceCompare();
    expect(app.selectedSampleIds).toEqual(selBefore);
    app.closeSoundSpaceCompare();
    expect(app.soundSpaceCompare.open).toBe(false);
    expect(app.selectedSampleIds).toEqual(selBefore);
  });

  it("compareCharacters exposes all 8 dims; null dims stay null (never 0)", async () => {
    const { app } = await openSoundSpaceWith([
      v2Record(TONE_ID, "pureTone440"),
      v2Record(NOISE_ID, "whiteNoise"),
    ]);
    app.toggleMultiSelect(knownRecord(app, TONE_ID));
    app.toggleMultiSelect(knownRecord(app, NOISE_ID));
    app.openSoundSpaceCompare();
    for (const entry of app.soundSpaceCompareCharacters) {
      expect(entry.character).not.toBeNull();
      for (const dim of SOUND_SPACE_DIM_NAMES) {
        const v = (entry.character as unknown as Record<string, number | null>)[dim];
        expect(v === null || (typeof v === "number" && v >= 0 && v <= 1)).toBe(true);
      }
    }
  });

  it("compare surfaces find-similar via the existing STEP23 engine for a compared id", async () => {
    const records = [
      v2Record(TONE_ID, "pureTone440"),
      v2Record("samples/sustainedTone", "sustainedTone"),
      v2Record(NOISE_ID, "whiteNoise"),
    ];
    const { app } = await openSoundSpaceWith(records);
    app.toggleMultiSelect(knownRecord(app, TONE_ID));
    app.toggleMultiSelect(knownRecord(app, NOISE_ID));
    app.openSoundSpaceCompare();
    await app.findSimilarForId(TONE_ID);
    expect(app.similarityV2.status).toBe("ready");
    expect(app.similarityV2.querySampleId).toBe(TONE_ID);
    const expected = rankSimilar(records[0], records, {
      limit: RANKING_DEFAULT_LIMIT,
      includeSelf: false,
    }).map((r) => r.sampleId);
    expect(app.similarityV2.results.map((r) => r.sampleId)).toEqual(expected);
  });

  it("compare focuses a compared sample without altering the selection", async () => {
    const { app } = await openSoundSpaceWith([
      v2Record(TONE_ID, "pureTone440"),
      v2Record(NOISE_ID, "whiteNoise"),
    ]);
    app.toggleMultiSelect(knownRecord(app, NOISE_ID));
    app.toggleMultiSelect(knownRecord(app, TONE_ID));
    const selBefore = [...app.selectedSampleIds];
    app.openSoundSpaceCompare();
    app.focusSampleById(TONE_ID);
    expect(app.focusedSampleId).toBe(TONE_ID);
    expect(app.selectedSampleIds).toEqual(selBefore);
  });

  it("togglePreviewById resolves a compared sample (no URL -> preview error, no crash)", async () => {
    const { app } = await openSoundSpaceWith([
      v2Record(TONE_ID, "pureTone440"),
      v2Record(NOISE_ID, "whiteNoise"),
    ]);
    app.toggleMultiSelect(knownRecord(app, TONE_ID));
    app.toggleMultiSelect(knownRecord(app, NOISE_ID));
    app.openSoundSpaceCompare();
    await app.togglePreviewById(TONE_ID);
    expect(app.previewError).toBe("no preview url available");
    expect(app.previewSampleId).toBeUndefined();
  });
});

describe("STEP25 snapshot semantics", () => {
  it("focus / filter / compare never re-project: coordinates byte-identical", async () => {
    const { app } = await rig([
      v2Record(TONE_ID, "pureTone440"),
      v2Record(NOISE_ID, "whiteNoise"),
      v2Record("samples/pinkNoise", "pinkNoise"),
      v2Record("samples/sustainedTone", "sustainedTone"),
    ]);
    await app.openSoundSpace();
    const first = app.soundSpace.points.map((p) => ({ ...p }));
    app.focusSampleById(NOISE_ID);
    app.setSoundSpaceFilter(TONE_CHAR);
    app.toggleMultiSelect(knownRecord(app, TONE_ID));
    app.toggleMultiSelect(knownRecord(app, NOISE_ID));
    app.openSoundSpaceCompare();
    expect(app.soundSpace.points.map((p) => ({ ...p }))).toEqual(first);
    expect(first.every((p) => p.algorithmVersion === "1.0.0")).toBe(true);
    // close+reopen recomputes (same deterministic projection) == identical.
    app.closeSoundSpace();
    expect(app.soundSpace).toEqual(emptySoundSpaceState());
    await app.openSoundSpace();
    expect(app.soundSpace.points.map((p) => ({ ...p }))).toEqual(first);
  });
});