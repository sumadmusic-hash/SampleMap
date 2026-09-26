/**
 * STEP26 — V2 Discovery Intelligence — app-level integration tests against a
 * REAL IndexedDB index + REAL SearchEngine (step24/step25-style). Fixtures are
 * FIXTURE-class (STEP21 corpus via `analyzeCorpus`) or CONSTRUCTED — never
 * real recorded audio.
 *
 * Coverage (§39): open/close + session-local criteria, each single-source mode
 * (text / character / reference), the combined modes, reference pinning via the
 * focused sample (id-only, stable until "Clear reference" — which never touches
 * focus/selection), highlight derivation, empty/error/idle copy, and the
 * read-only guarantee (discovery never mutates the index or the search state).
 */
import { describe, it, expect, afterEach } from "vitest";
import { SampleMapApp, emptyDiscoveryState } from "./app";
import type { SampleMapAppDeps } from "./app";
import { openTestDatabase, makeSample } from "../persistence/test-helpers";
import type { DatabaseHandle } from "../persistence/db";
import { SampleMapSearchEngine } from "../search/searchEngine";
import { PreviewService } from "../preview/previewService";
import type { SampleMapMachinisteService } from "../machiniste/machinisteService";
import { createMemoryEp7ConsentStore } from "./ep7Consent";
import { ANALYSIS_VERSION } from "../analysis/sampleAnalysisV2";
import type { SampleAnalysisV2 } from "../analysis/sampleAnalysisV2";
import {
  computeSoundCharacter,
  computeSoundCharacterQuality,
} from "../analysis/soundCharacter";
import { analyzeCorpus } from "../audio/v2Fixtures";
import { rankSimilar } from "../analysis/similarityRanking";
import { recordMatchesFilter } from "../analysis/soundSpaceFilter";
import type { SoundSpaceCharFilter } from "../analysis/soundSpaceFilter";
import { discoveryStatusText, discoveryScoreLabel, discoveryReasonSummary } from "./view";
import type { SampleIndexRecord } from "../persistence/indexStore";
import type { IndexStore } from "../persistence/indexStore";

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

interface NamedV2 {
  id: string;
  name: string;
  corpus: string;
}
const CORPUS: NamedV2[] = [
  { id: "samples/kick-heavy", name: "Kick Heavy 80", corpus: "decayingTone90" },
  { id: "samples/kick-soft", name: "Soft Kick Dark", corpus: "lowThump" },
  { id: "samples/hat-airy", name: "Airy Hat Shimmer", corpus: "highThump" },
  { id: "samples/lead-ohm", name: "Bright Lead Ohm", corpus: "highSine2000" },
  { id: "samples/noise-sweep", name: "Noise Sweep Raw", corpus: "whiteNoise" },
];

function corpusRecords(): SampleIndexRecord[] {
  const out = CORPUS.map((c) =>
    makeSample(c.id, {
      name: c.name,
      analysisV2: corpusAnalysis(c.corpus),
    }),
  );
  out.push(makeSample("samples/v1-only", { name: "Old Kick Sample" }));
  return out;
}

interface Rig {
  app: SampleMapApp;
  db: { close(): Promise<void> };
  index: IndexStore;
}

async function rig(records: readonly SampleIndexRecord[], depsIndex = true): Promise<Rig> {
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
    analysisBuild: "build-step26",
    ep7Consent: granted(),
  };
  const app = new SampleMapApp(deps);
  for (const r of records) await handle.index.put(r);
  await app.refreshSearch();
  return { app, db: handle.db, index: handle.index };
}

const KICK_HEAVY = "samples/kick-heavy";

describe("STEP26 app — surface lifecycle (session-local)", () => {
  it("emptyDiscoveryState is closed+idle; open moves to idle without criteria", async () => {
    const { app } = await rig([]);
    expect(app.discovery).toEqual(emptyDiscoveryState());
    await app.openDiscovery();
    expect(app.discovery.open).toBe(true);
    expect(app.discovery.status).toBe("idle");
    expect(discoveryStatusText(app.discovery)).toBe("Find a sound");
    expect(app.discoveryHighlightedSampleIds.size).toBe(0);
  });

  it("close keeps criteria; reopen re-runs with the retained reference", async () => {
    const { app } = await rig(corpusRecords());
    app.focusSampleById(KICK_HEAVY);
    app.useFocusedSampleAsReference();
    await app.runDiscovery();
    expect(app.discovery.referenceSampleId).toBe(KICK_HEAVY);
    app.closeDiscovery();
    expect(app.discovery.open).toBe(false);
    // Criteria survive close; reopening re-runs (reference-only semantics).
    await app.openDiscovery();
    expect(app.discovery.open).toBe(true);
    expect(app.discovery.status).toBe("ready");
    expect(app.discovery.referenceSampleId).toBe(KICK_HEAVY);
    expect(app.discoveryHighlightedSampleIds.size).toBeGreaterThan(0);
  });
});

describe("STEP26 app — single-source discovery", () => {
  it("text-only: matches the frozen SearchEngine, V1 records included, rows resolved", async () => {
    const { app } = await rig(corpusRecords());
    app.setDiscoveryTextDraft("kick");
    await app.runDiscovery();
    expect(app.discovery.status).toBe("ready");
    const ids = app.discovery.results.map((r) => r.sampleId).sort();
    expect(ids).toEqual([
      "samples/kick-heavy",
      "samples/kick-soft",
      "samples/v1-only",
    ]);
    for (const r of app.discovery.results) {
      expect(r.record).toBeDefined();
      expect(r.record.sampleId).toBe(r.sampleId);
      expect(r.reasons).toEqual([{ type: "text-match", label: "Matches search" }]);
      expect(r.searchScore).toBeGreaterThan(0);
      expect(r.score).toBe(r.searchScore);
    }
  });

  it("character-only: equals the frozen recordMatchesFilter predicate (consumed read-only)", async () => {
    const records = corpusRecords();
    const { app } = await rig(records);
    const filter: SoundSpaceCharFilter = { brightness: { min: 0.5, max: 1 } };
    app.setSoundSpaceFilter(filter);
    await app.runDiscovery();
    expect(app.discovery.status).toBe("ready");
    const expected = records
      .filter((r) => recordMatchesFilter(r, filter))
      .map((r) => r.sampleId)
      .sort();
    expect(app.discovery.results.map((r) => r.sampleId).sort()).toEqual(expected);
    for (const r of app.discovery.results) {
      expect(r.reasons).toEqual([{ type: "character-match", label: "Matches filter" }]);
      expect(r.score).toBe(1);
    }
  });

  it("reference-only: rankSimilar order, self excluded, V1 excluded, Similar reasons", async () => {
    const records = corpusRecords();
    const { app } = await rig(records);
    const ref = records.find((r) => r.sampleId === KICK_HEAVY)!;
    app.focusSampleById(KICK_HEAVY);
    app.useFocusedSampleAsReference();
    await app.runDiscovery();
    expect(app.discovery.status).toBe("ready");
    const expected = rankSimilar(ref, records).map((r) => r.sampleId);
    expect(app.discovery.results.map((r) => r.sampleId)).toEqual(expected);
    expect(app.discovery.results.map((r) => r.sampleId)).not.toContain(KICK_HEAVY);
    expect(app.discovery.results.map((r) => r.sampleId)).not.toContain("samples/v1-only");
    for (const r of app.discovery.results) {
      expect(r.reasons).toEqual([{ type: "similar-to-reference", label: "Similar" }]);
      expect(r.similarity).toBe(r.score);
      expect(r.sharedDimensionCount).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("STEP26 app — reference pinning (id-only, stable until cleared)", () => {
  it("useFocusedSampleAsReference records only the id; focus/selection untouched", async () => {
    const { app } = await rig(corpusRecords());
    const rec = known(app, KICK_HEAVY);
    app.selectSample(rec);
    app.openSoundSpaceCompare?.(); // no-op guard: never touches reference
    app.toggleMultiSelect(rec);
    const selBefore = [...app.selectedSampleIds];
    const focusedBefore = app.focusedSampleId;

    app.useFocusedSampleAsReference();
    expect(app.discovery.referenceSampleId).toBe(KICK_HEAVY);
    expect(app.focusedSampleId).toBe(focusedBefore);
    expect(app.selectedSampleIds).toEqual(selBefore);

    app.clearDiscoveryReference();
    expect(app.discovery.referenceSampleId).toBeUndefined();
    expect(app.focusedSampleId).toBe(focusedBefore);
    expect(app.selectedSampleIds).toEqual(selBefore);
  });

  it("useFocusedSampleAsReference with nothing focused -> reference empty copy", async () => {
    const { app } = await rig(corpusRecords());
    expect(app.focusedSampleId).toBeNull();
    app.useFocusedSampleAsReference();
    expect(app.discovery.referenceSampleId).toBeUndefined();
    expect(app.discovery.status).toBe("empty");
    expect(discoveryStatusText(app.discovery)).toBe("Select a sample to use as a reference.");
  });

  it("reference-only with a V1-only reference -> 'Select a sample ...'", async () => {
    const { app } = await rig(corpusRecords());
    const v1 = known(app, "samples/v1-only");
    app.selectSample(v1);
    app.useFocusedSampleAsReference();
    await app.runDiscovery();
    expect(app.discovery.status).toBe("empty");
    expect(discoveryStatusText(app.discovery)).toBe("Select a sample to use as a reference.");
  });
});

describe("STEP26 app — combined modes + highlight", () => {
  it("text + filter + reference: all three reasons, deterministic across runs", async () => {
    const { app } = await rig(corpusRecords());
    app.setDiscoveryTextDraft("kick");
    app.setSoundSpaceFilter({ brightness: { min: 0.5, max: 1 } });
    app.focusSampleById(KICK_HEAVY);
    app.useFocusedSampleAsReference();
    await app.runDiscovery();
    const snapshot = () =>
      app.discovery.results.map((r) => [r.sampleId, r.score, r.reasons.map((x) => x.type)]);
    const first = snapshot();
    for (const r of app.discovery.results) {
      expect(r.reasons.map((x) => x.type)).toEqual([
        "text-match",
        "character-match",
        "similar-to-reference",
      ]);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    // Re-running the SAME criteria yields an identical snapshot (determinism).
    await app.runDiscovery();
    expect(snapshot()).toEqual(first);
  });

  it("highlight tracks the last ready run and clears on empty/close", async () => {
    const { app } = await rig(corpusRecords());
    app.setDiscoveryTextDraft("pureTone-nowhere"); // no match
    await app.runDiscovery();
    expect(app.discovery.status).toBe("empty");
    expect(app.discovery.error).toBe("No matching sounds found.");
    expect(app.discoveryHighlightedSampleIds.size).toBe(0);

    app.setDiscoveryTextDraft("kick");
    await app.runDiscovery();
    expect(app.discovery.status).toBe("ready");
    const ids = new Set(app.discovery.results.map((r) => r.sampleId));
    expect(app.discoveryHighlightedSampleIds).toEqual(ids);

    app.closeDiscovery();
    expect(app.discoveryHighlightedSampleIds.size).toBe(0);
  });

  it("no criteria -> idle, never an invented browse-order", async () => {
    const { app } = await rig(corpusRecords());
    app.setDiscoveryTextDraft("   ");
    await app.runDiscovery();
    expect(app.discovery.status).toBe("idle");
    expect(app.discovery.results).toEqual([]);
    expect(discoveryStatusText(app.discovery)).toBe("Find a sound");
  });
});

describe("STEP26 app — read-only + error paths", () => {
  it("index unavailable -> exact error copy", async () => {
    const { app } = await rig(corpusRecords(), false);
    app.setDiscoveryTextDraft("kick");
    await app.runDiscovery();
    expect(app.discovery.status).toBe("error");
    expect(discoveryStatusText(app.discovery)).toBe("Local sample index unavailable.");
  });

  it("run never mutates the global search results or the batch selection", async () => {
    const records = corpusRecords();
    const { app, index } = await rig(records);
    const resultsBefore = app.results.map((r) => r.record.sampleId);
    const indexBefore = await index.getAll();
    app.setDiscoveryTextDraft("kick");
    app.focusSampleById(KICK_HEAVY);
    app.useFocusedSampleAsReference();
    await app.runDiscovery();
    expect(app.results.map((r) => r.record.sampleId)).toEqual(resultsBefore);
    expect(app.selectedSampleIds).toEqual([]);
    const indexAfter = await index.getAll();
    expect(indexAfter.map((r) => r.sampleId)).toEqual(indexBefore.map((r) => r.sampleId));
  });

  it("discovery rows are resolvable for the canonical focus path (knownRecords)", async () => {
    const { app } = await rig(corpusRecords());
    app.setDiscoveryTextDraft("kick");
    await app.runDiscovery();
    const firstId = app.discovery.results[0].sampleId;
    app.focusSampleById(firstId);
    expect(app.focusedRecord?.sampleId).toBe(firstId);
    expect(app.sampleNameFor(firstId).length).toBeGreaterThan(0);
  });
});

describe("STEP26 app — view-model copy (exact strings)", () => {
  it("reason summary and score labels", () => {
    expect(discoveryScoreLabel(0.87)).toBe("Match 87%");
    expect(discoveryScoreLabel(0)).toBe("Match 0%");
    expect(discoveryScoreLabel(1)).toBe("Match 100%");
    expect(discoveryScoreLabel(1.5)).toBe("Match 100%");
    expect(discoveryScoreLabel(-0.5)).toBe("Match 0%");
    expect(
      discoveryReasonSummary([
        { label: "Matches search" },
        { label: "Matches filter" },
        { label: "Similar" },
      ]),
    ).toBe("Matches search · Matches filter · Similar");
    expect(discoveryReasonSummary([])).toBe("Match");
  });
});

function known(app: SampleMapApp, id: string): SampleIndexRecord {
  const found = app.results.find((r) => r.record.sampleId === id);
  if (!found) throw new Error(`record ${id} not found in results`);
  return found.record;
}