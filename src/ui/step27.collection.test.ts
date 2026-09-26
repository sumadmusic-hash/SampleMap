/**
 * STEP27 — V2 Sound Collections — app-level integration tests against a REAL
 * IndexedDB index + REAL SearchEngine (step24/25/26-style). Fixtures are
 * FIXTURE-class (STEP21 corpus via `analyzeCorpus`) or CONSTRUCTED — never
 * real recorded audio.
 *
 * Coverage (§39–§41): session-local boundary (initial state, counter, cap 50,
 * no eviction), duplicate-safe add, re-add-to-end, removal preserving order,
 * clear, cross-source add (Search / Discovery / Sound Space all share the SAME
 * pure boundary), independence from focus/selection/preview/discovery, Compare
 * (<2 closed, 2–4 all, >4 first 4 in collection order, never mutating),
 * Select All (bounded to the existing batch), the arithmetic-mean Collection
 * average (nulls ignored, all-null → null), stale members (record removed from
 * the index → "Unavailable sample" without dropping or crashing) and the
 * index-refresh-never-clears guarantee.
 */
import { describe, it, expect, afterEach } from "vitest";
import { SampleMapApp } from "./app";
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
import { MAX_BATCH_SLOTS } from "../machiniste/machinisteService";
import {
  COLLECTION_FULL_TEXT,
  COLLECTION_AVG_LABEL,
  collectionCounterLabel,
} from "./view";
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
  return CORPUS.map((c) =>
    makeSample(c.id, {
      name: c.name,
      analysisV2: corpusAnalysis(c.corpus),
    }),
  );
}

/** CONSTRUCTED — a record whose SoundCharacter is entirely null (not determinable). */
function nullCharacterRecord(id: string, name: string): SampleIndexRecord {
  const a = corpusAnalysis("whiteNoise");
  const char = { ...a.soundCharacter };
  for (const k of Object.keys(char) as Array<keyof typeof char>) char[k] = null;
  return makeSample(id, {
    name,
    analysisV2: { ...a, soundCharacter: char },
  });
}

interface Rig {
  app: SampleMapApp;
  db: { close(): Promise<void> };
  index: IndexStore;
}

async function rig(records: readonly SampleIndexRecord[]): Promise<Rig> {
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
    index: handle.index,
    search,
    preview,
    machiniste,
    createRunner,
    fetchPage: async () => ({ samples: [], nextPageToken: undefined }),
    known: { getUpdatedAt: async () => undefined },
    previewUrlFor: () => undefined,
    analysisBuild: "build-step27",
    ep7Consent: granted(),
  };
  const app = new SampleMapApp(deps);
  for (const r of records) await handle.index.put(r);
  await app.refreshSearch();
  return { app, db: handle.db, index: handle.index };
}

const KICK = "samples/kick-heavy";
const HAT = "samples/hat-airy";
const BASS = "samples/kick-soft";
const LEAD = "samples/lead-ohm";
const NOISE = "samples/noise-sweep";

describe("STEP27 app — session-local collection boundary", () => {
  it("initial state: closed + empty; counter is My Sounds · 0; summary null", async () => {
    const { app } = await rig([]);
    expect(app.collection.open).toBe(false);
    expect(app.collection.sampleIds).toEqual([]);
    expect(app.isCollectionMember(KICK)).toBe(false);
    expect(collectionCounterLabel(app.collection.sampleIds.length)).toBe("My Sounds · 0");
    expect(app.collectionMembers).toEqual([]);
    expect(app.collectionSummary).toBeNull();
  });

  it("add registers one member, increments counter, keeps insertion order", async () => {
    const records = corpusRecords();
    const { app } = await rig(records);
    const rec = app.recordForSample(KICK)!;
    await app.addToCollection(KICK, rec);
    expect(app.collection.sampleIds).toEqual([KICK]);
    expect(app.isCollectionMember(KICK)).toBe(true);
    expect(app.collectionMembers).toHaveLength(1);
    expect(app.collectionMembers[0].sampleId).toBe(KICK);
    expect(app.collectionMembers[0].available).toBe(true);
    await app.addToCollection(HAT, app.recordForSample(HAT));
    expect(app.collection.sampleIds).toEqual([KICK, HAT]);
    expect(collectionCounterLabel(app.collection.sampleIds.length)).toBe("My Sounds · 2");
  });

  it("duplicate adds are no-ops (id-identity); Added label holds", async () => {
    const { app } = await rig(corpusRecords());
    await app.addToCollection(KICK, app.recordForSample(KICK));
    // Duplicate: same id, different record object — still a no-op.
    const rec = app.recordForSample(KICK)!;
    await app.addToCollection(KICK, rec);
    expect(app.collection.sampleIds).toEqual([KICK]);
    expect(await app.isCollectionMember(KICK)).toBe(true);
  });

  it("re-adding a member MOVES IT TO THE END (updates, never duplicates)", async () => {
    const { app } = await rig(corpusRecords());
    await app.addToCollection(KICK, app.recordForSample(KICK));
    await app.addToCollection(HAT, app.recordForSample(HAT));
    await app.addToCollection(BASS, app.recordForSample(BASS));
    expect(app.collection.sampleIds).toEqual([KICK, HAT, BASS]);
    await app.addToCollection(KICK, app.recordForSample(KICK));
    expect(app.collection.sampleIds).toEqual([HAT, BASS, KICK]);
  });

  it("remove preserves order; clear empties; clear keeps the open flag", async () => {
    const { app } = await rig(corpusRecords());
    await app.addToCollection(KICK, app.recordForSample(KICK));
    await app.addToCollection(HAT, app.recordForSample(HAT));
    await app.addToCollection(BASS, app.recordForSample(BASS));
    await app.removeFromCollection(HAT);
    expect(app.collection.sampleIds).toEqual([KICK, BASS]);
    await app.openCollection();
    await app.clearCollection();
    expect(app.collection.sampleIds).toEqual([]);
    expect(app.collection.open).toBe(true);
    expect(app.collectionMembers).toEqual([]);
  });

  it("hard cap 50: the 51st add is a no-op, nothing is evicted", async () => {
    const many = Array.from({ length: 55 }, (_, i) =>
      makeSample(`samples/s${i}`, {
        name: `Sample ${i}`,
        analysisV2: corpusAnalysis("whiteNoise"),
      }),
    );
    const { app } = await rig(many);
    for (let i = 0; i < 55; i++) {
      await app.addToCollection(`samples/s${i}`, app.recordForSample(`samples/s${i}`));
    }
    expect(app.collection.sampleIds).toHaveLength(50);
    expect(app.collection.sampleIds[0]).toBe("samples/s0");
    expect(app.collection.sampleIds[49]).toBe("samples/s49");
    expect(
      app.collection.sampleIds.filter((id) => id === "samples/s50" || id === "samples/s51"),
    ).toEqual([]);
    // Full status copy is reachable (app never auto-evicts).
    expect(COLLECTION_FULL_TEXT).toBe("Collection is full.");
  });

  it("toggleCollectionSample adds when absent and removes when present", async () => {
    const { app } = await rig(corpusRecords());
    await app.toggleCollectionSample(KICK, app.recordForSample(KICK));
    expect(app.isCollectionMember(KICK)).toBe(true);
    await app.toggleCollectionSample(KICK, app.recordForSample(KICK));
    expect(app.isCollectionMember(KICK)).toBe(false);
  });
});

describe("STEP27 app — isolation: collection never mutates anything else", () => {
  it("add/remove/toggle leave focus, selection, preview and discovery untouched", async () => {
    const { app } = await rig(corpusRecords());
    app.focusSampleById(KICK);
    app.toggleMultiSelect(app.recordForSample(HAT)!);
    await app.setDiscoveryTextDraft("hat");
    await app.runDiscovery();
    expect(app.previewSampleId).toBeUndefined();
    expect(app.discovery.status).toBe("ready");
    const discoverySnapshot = app.discovery.results.map((r) => r.sampleId);

    const before = {
      focus: app.focusedSampleId,
      selection: [...app.selectedSampleIds],
      preview: app.previewSampleId,
      discovery: discoverySnapshot,
    };
    await app.addToCollection(KICK, app.recordForSample(KICK));
    await app.toggleCollectionSample(BASS, app.recordForSample(BASS));
    await app.removeFromCollection(BASS);
    expect(app.focusedSampleId).toBe(before.focus);
    expect([...app.selectedSampleIds]).toEqual(before.selection);
    expect(app.previewSampleId).toBe(before.preview);
    expect(app.discovery.results.map((r) => r.sampleId)).toEqual(before.discovery);
  });

  it("collection is independent of the Sound Space filter", async () => {
    const { app } = await rig(corpusRecords());
    app.setSoundSpaceFilter({ brightness: { min: 0.5, max: 1 } });
    await app.addToCollection(KICK, app.recordForSample(KICK));
    expect(app.soundSpaceFilter).toEqual({ brightness: { min: 0.5, max: 1 } });
    expect(app.isCollectionMember(KICK)).toBe(true);
  });
});

describe("STEP27 app — Compare over the collection", () => {
  it("<2 members: compare keeps closed and never mutates collection/selection", async () => {
    const { app } = await rig(corpusRecords());
    await app.addToCollection(KICK, app.recordForSample(KICK));
    const before = [...app.selectedSampleIds];
    app.openCollectionCompare();
    expect(app.collectionCompare.open).toBe(false);
    expect(app.collectionCompare.sampleIds).toEqual([]);
    expect(app.collection.sampleIds).toEqual([KICK]);
    expect([...app.selectedSampleIds]).toEqual(before);
  });

  it("2–4 members: compares all in collection order", async () => {
    const { app } = await rig(corpusRecords());
    await app.addToCollection(BASS, app.recordForSample(BASS));
    await app.addToCollection(KICK, app.recordForSample(KICK));
    await app.addToCollection(HAT, app.recordForSample(HAT));
    app.openCollectionCompare();
    expect(app.collectionCompare.open).toBe(true);
    expect(app.collectionCompare.sampleIds).toEqual([BASS, KICK, HAT]);
    const chars = app.collectionCompareCharacters.map((c) => c.id);
    expect(chars).toEqual([BASS, KICK, HAT]);
    // Close never alters the collection.
    app.closeCollectionCompare();
    expect(app.collection.sampleIds).toEqual([BASS, KICK, HAT]);
    expect(app.collectionCompare.open).toBe(false);
  });

  it(">4 members: compares the first 4 IN COLLECTION ORDER only", async () => {
    const { app } = await rig(corpusRecords());
    for (const id of [HAT, KICK, LEAD, NOISE, BASS]) {
      await app.addToCollection(id, app.recordForSample(id));
    }
    app.openCollectionCompare();
    expect(app.collectionCompare.sampleIds).toEqual([HAT, KICK, LEAD, NOISE]);
    // The compare surface never inspects the batch selection.
    expect(app.selectedSampleIds).toEqual([]);
  });

  it("compare characters resolve names/soundcharacters through the registry", async () => {
    const { app } = await rig(corpusRecords());
    await app.addToCollection(KICK, app.recordForSample(KICK));
    await app.addToCollection(HAT, app.recordForSample(HAT));
    app.openCollectionCompare();
    const chars = app.collectionCompareCharacters;
    expect(chars[0].name).toBe("Kick Heavy 80");
    expect(chars[1].name).toBe("Airy Hat Shimmer");
    expect(chars[0].character).not.toBeNull();
  });
});

describe("STEP27 app — Select All (explicit, bounded)", () => {
  it("replaces the batch selection with the collection in order", async () => {
    const { app } = await rig(corpusRecords());
    app.toggleMultiSelect(app.recordForSample(NOISE)!);
    await app.addToCollection(KICK, app.recordForSample(KICK));
    await app.addToCollection(HAT, app.recordForSample(HAT));
    app.selectCollection();
    expect([...app.selectedSampleIds]).toEqual([KICK, HAT]);
  });

  it("bounds the replacement to MAX_BATCH_SLOTS and never auto-runs", async () => {
    const { app } = await rig(corpusRecords());
    for (const id of [KICK, HAT, BASS, LEAD, NOISE]) {
      await app.addToCollection(id, app.recordForSample(id));
    }
    app.selectCollection();
    expect(app.selectedSampleIds.length).toBeLessThanOrEqual(MAX_BATCH_SLOTS);
    expect(app.selectedSampleIds.length).toBe(Math.min(5, MAX_BATCH_SLOTS));
    // Explicit only — the collection itself is untouched.
    expect(app.collection.sampleIds.length).toBe(5);
  });
});

describe("STEP27 app — Collection average (honest, arithmetic mean)", () => {
  it("summary = per-dim mean over PRESENT values; 1 member == its character", async () => {
    const { app } = await rig(corpusRecords());
    await app.addToCollection(KICK, app.recordForSample(KICK));
    const summary = app.collectionSummary!;
    const char = app.recordForSample(KICK)!.analysisV2!.soundCharacter;
    for (const [k, v] of Object.entries(char)) {
      const s = summary as unknown as Record<string, number | null>;
      expect(s[k]).toBe(v);
    }
  });

  it("multi-member mean ignores null dims entirely (never counts as 0)", async () => {
    const records = [corpusRecords()[0], nullCharacterRecord("samples/x-null", "Null Char")];
    const { app } = await rig(records);
    await app.addToCollection(KICK, app.recordForSample(KICK));
    await app.addToCollection("samples/x-null", app.recordForSample("samples/x-null"));
    const summary = app.collectionSummary!;
    const a = app.recordForSample(KICK)!.analysisV2!.soundCharacter;
    const s = summary as unknown as Record<string, number | null>;
    for (const [k, v] of Object.entries(a)) {
      // The null member contributes nothing, so the mean equals the present value.
      expect(s[k]).toBeCloseTo(v as number, 12);
    }
  });

  it("no present values anywhere → summary is null (UI '—'); label is Collection average", async () => {
    const records = [
      nullCharacterRecord("samples/n1", "Null One"),
      nullCharacterRecord("samples/n2", "Null Two"),
    ];
    const { app } = await rig(records);
    await app.addToCollection("samples/n1", app.recordForSample("samples/n1"));
    await app.addToCollection("samples/n2", app.recordForSample("samples/n2"));
    expect(app.collectionSummary).toBeNull();
    expect(COLLECTION_AVG_LABEL).toBe("Collection average");
  });

  it("partial records: dimension with values in SOME members averages those only", async () => {
    const nullRec = nullCharacterRecord("samples/x-null", "Null Char");
    const heavy = corpusRecords()[0];
    const a = heavy.analysisV2!.soundCharacter;
    const { app } = await rig([heavy, nullRec]);
    await app.addToCollection(KICK, app.recordForSample(KICK));
    await app.addToCollection("samples/x-null", app.recordForSample("samples/x-null"));
    const s = app.collectionSummary as unknown as Record<string, number | null>;
    expect(s.brightness).toBeCloseTo(a.brightness as number, 12);
  });
});

describe("STEP27 app — stale members + index-refresh guarantee", () => {
  it("a member whose record is deleted from the index stays listed, available=false, never crash", async () => {
    const { app, index } = await rig(corpusRecords());
    await app.addToCollection(KICK, app.recordForSample(KICK));
    await app.addToCollection(HAT, app.recordForSample(HAT));
    expect(app.collectionMembers.every((m) => m.available)).toBe(true);

    await index.delete(KICK);
    // Re-sync the availability snapshot via a source collision surface.
    await app.openCollection();
    await app.openCollection();

    expect(app.collection.sampleIds).toEqual([KICK, HAT]);
    const members = app.collectionMembers;
    expect(members[0].sampleId).toBe(KICK);
    expect(members[0].available).toBe(false);
    expect(members[0].record).toBeUndefined();
    expect(members[1].available).toBe(true);
  });

  it("index refresh (search/scan) never clears or drops the collection", async () => {
    const { app } = await rig(corpusRecords());
    await app.addToCollection(KICK, app.recordForSample(KICK));
    // Search refresh upserts records but NEVER removes collection members.
    await app.refreshSearch();
    expect(app.collection.sampleIds).toEqual([KICK]);
    // A re-add via the search surface keeps availability true.
    await app.addToCollection(HAT, app.recordForSample(HAT));
    expect(app.collectionMembers.every((m) => m.available)).toBe(true);
  });
});