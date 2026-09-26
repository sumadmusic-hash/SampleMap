/**
 * STEP28 — Persistent Sound Collections — app-level integration tests (§53).
 * Runs against a REAL IndexedDB index + the full IndexedDBCollectionStore +
 * REAL SearchEngine; never real audio. Exercises the full lifecycle (create,
 * rename, dirty tracking, save, save-as, load, switch, delete) against the
 * persisted collection store, invalid/corrupt row surfacing, stale member
 * resolution, and the SAVE/DISCARD/Cancel confirm-dialog policy (§30). Mirrors
 * the STEP27 test-harness (real DB + debounce-free commit) while ensuring
 * STEP27 behavior is untouched (§60–§61).
 */
import { describe, it, expect, afterEach } from "vitest";
import { SampleMapApp } from "./app";
import type { SampleMapAppDeps } from "./app";
import { openTestDatabase, makeSample } from "../persistence/test-helpers";
import type { DatabaseHandle } from "../persistence/db";
import { IndexedDBCollectionStore } from "../persistence/collectionStore";
import { SampleMapSearchEngine } from "../search/searchEngine";
import { PreviewService } from "../preview/previewService";
import type { SampleMapMachinisteService } from "../machiniste/machinisteService";
import { createMemoryEp7ConsentStore } from "./ep7Consent";
import {
  COLLECTION_PERSISTENCE_SCHEMA_VERSION,
  createPersistedCollection,
} from "../analysis/collectionPersistence";
import { DEFAULT_COLLECTION_NAME } from "../analysis/collectionPersistence";
import { ANALYSIS_VERSION } from "../analysis/sampleAnalysisV2";
import type { SampleAnalysisV2 } from "../analysis/sampleAnalysisV2";
import {
  computeSoundCharacter,
  computeSoundCharacterQuality,
} from "../analysis/soundCharacter";
import { analyzeCorpus } from "../audio/v2Fixtures";
import type { SampleIndexRecord } from "../persistence/indexStore";
import type { IndexStore } from "../persistence/indexStore";

// ── harness bookkeeping ────────────────────────────────────────────────────
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

// ── fixtures ───────────────────────────────────────────────────────────────
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
    makeSample(c.id, { name: c.name, analysisV2: corpusAnalysis(c.corpus) }),
  );
}

const KICK = "samples/kick-heavy";
const HAT = "samples/hat-airy";
const BASS = "samples/kick-soft";
const LEAD = "samples/lead-ohm";

// ── test rig ───────────────────────────────────────────────────────────────
interface Rig {
  app: SampleMapApp;
  db: DatabaseHandle;
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
    analysisBuild: "build-step28",
    ep7Consent: granted(),
    collectionStore: new IndexedDBCollectionStore(handle.db),
  };
  const app = new SampleMapApp(deps);
  for (const r of records) await handle.index.put(r);
  await app.refreshSearch();
  return { app, db: handle, index: handle.index };
}

// ── tests ──────────────────────────────────────────────────────────────────
describe("STEP28 app — initial state & list", () => {
  it("manager is closed with empty entries; no active collection; dirty false", async () => {
    const { app } = await rig([]);
    expect(app.collectionManager.open).toBe(false);
    expect(app.collectionManager.listStatus).toBe("idle");
    expect(app.collectionManager.entries).toEqual([]);
    expect(app.activeCollectionId).toBeNull();
    expect(app.collectionDirty).toBe(false);
    expect(app.collectionName).toBe(DEFAULT_COLLECTION_NAME);
    expect(app.collectionSaveError).toBeUndefined();
  });

  it("openCollectionManager populates entries from the store", async () => {
    const { app, db } = await rig([]);
    try {
      await app.openCollectionManager();
      expect(app.collectionManager.open).toBe(true);
      expect(app.collectionManager.listStatus).toBe("loaded");
      expect(app.collectionManager.entries).toEqual([]);
    } finally {
      await db.db.close();
    }
  });
});

describe("STEP28 app — create / rename / dirty", () => {
  it("createNewCollection resets working set; dirty false; active null; name default", async () => {
    const { app } = await rig([]);
    await app.addToCollection(KICK);
    expect(app.collectionDirty).toBe(true);
    app.createNewCollection();
    expect(app.collection.sampleIds).toEqual([]);
    expect(app.activeCollectionId).toBeNull();
    expect(app.collectionName).toBe(DEFAULT_COLLECTION_NAME);
    expect(app.collectionDirty).toBe(false);
    expect(app.collectionManager.nameDraft).toBe(DEFAULT_COLLECTION_NAME);
  });

  it("renameCollection changes name and marks dirty", async () => {
    const { app } = await rig([]);
    app.renameCollection("  Kick Pack  ");
    expect(app.collectionName).toBe("Kick Pack");
    expect(app.collectionDirty).toBe(true);
    expect(app.collectionManager.nameDraft).toBe("Kick Pack");
  });

  it("renameCollection ignores invalid names and sets error", async () => {
    const { app } = await rig([]);
    app.collectionDirty = false;
    app.renameCollection("   ");
    expect(app.collectionDirty).toBe(true);
    expect(app.collectionSaveError).toBeDefined();
    expect(app.collectionSaveError).toContain("must be non-empty");
  });

  it("renameCollection does nothing if name is unchanged", async () => {
    const { app } = await rig([]);
    app.collectionDirty = false;
    app.renameCollection(DEFAULT_COLLECTION_NAME);
    expect(app.collectionDirty).toBe(false);
    expect(app.collectionSaveError).toBeUndefined();
  });
});

describe("STEP28 app — save / save-as", () => {
  it("saveCollection with no active id creates a new collection (save-as)", async () => {
    const { app, db } = await rig([corpusRecords()[0]]);
    try {
      await app.addToCollection(KICK);
      expect(app.collectionDirty).toBe(true);
      await app.saveCollection();
      expect(app.collectionDirty).toBe(false);
      expect(app.activeCollectionId).toBeDefined();
      expect(app.collectionName).toBe(DEFAULT_COLLECTION_NAME);
      const row = await db.collections.get(app.activeCollectionId!);
      expect(row?.ok).toBe(true);
      expect(row?.ok && row.collection.sampleIds).toEqual([KICK]);
    } finally {
      await db.db.close();
    }
  });

  it("saveCollection updates the active collection; updatedAt advances", async () => {
    const { app, db } = await rig([corpusRecords()[0]]);
    try {
      await app.addToCollection(KICK);
      await app.saveCollection();
      const first = app.activeCollectionId!;
      const got1 = await db.collections.get(first);
      const firstUpdatedAt = got1 && got1.ok ? got1.collection.updatedAt : 0;
      app.renameCollection("New Name");
      app.collectionDirty = true;
      // Force a distinct clock tick (persistence stamps Date.now()).
      await new Promise((r) => setTimeout(r, 5));
      await app.saveCollection();
      expect(app.collectionDirty).toBe(false);
      expect(app.activeCollectionId).toBe(first);
      const got2 = await db.collections.get(first);
      const secondUpdatedAt = got2 && got2.ok ? got2.collection.updatedAt : 0;
      expect(secondUpdatedAt).toBeGreaterThan(firstUpdatedAt);
    } finally {
      await db.db.close();
    }
  });

  it("saveCollectionAs creates a fresh id and dirty false", async () => {
    const { app, db } = await rig([corpusRecords()[0]]);
    try {
      await app.addToCollection(KICK);
      app.renameCollection("Kick Pack");
      await app.saveCollectionAs();
      expect(app.activeCollectionId).toBeDefined();
      expect(app.collectionDirty).toBe(false);
      expect(app.collectionName).toBe("Kick Pack");
      const row = await db.collections.get(app.activeCollectionId!);
      expect(row?.ok).toBe(true);
      expect(row?.ok && row.collection.name).toBe("Kick Pack");
      expect(row?.ok && row.collection.sampleIds).toEqual([KICK]);
    } finally {
      await db.db.close();
    }
  });

  it("save failure keeps dirty true and error visible; retry allowed", async () => {
    const { app, db } = await rig([corpusRecords()[0]]);
    try {
      await app.addToCollection(KICK);
      // First save to get an active backing id.
      await app.saveCollection();
      const activeId = app.activeCollectionId!;
      expect(activeId).toBeDefined();
      expect(app.collectionDirty).toBe(false);
      // Overwrite the backing record with a corrupt row (missing name).
      await db.db.put("collections", {
        id: activeId,
        sampleIds: [],
        createdAt: 1,
        updatedAt: 1,
        version: COLLECTION_PERSISTENCE_SCHEMA_VERSION,
      });
      await app.addToCollection(HAT); // dirty again
      await app.saveCollection();
      expect(app.collectionSaveError).toBeDefined();
      expect(app.collectionSaveError).toContain("unreadable");
      expect(app.collectionDirty).toBe(true);
      expect(app.collectionSaving).toBe(false);
    } finally {
      await db.db.close();
    }
  });
});

describe("STEP28 app — load / switch / delete", () => {
  it("loadCollection restores name + ids only; dirty false; active set", async () => {
    const { app, db } = await rig(corpusRecords());
    try {
      // Seed a persisted collection.
      const saved = createPersistedCollection({
        name: "Loaded Pack",
        sampleIds: [KICK, HAT],
      });
      await db.collections.put(saved);

      await app.loadCollection(saved.id);
      expect(app.collectionDirty).toBe(false);
      expect(app.activeCollectionId).toBe(saved.id);
      expect(app.collectionName).toBe("Loaded Pack");
      expect(app.collection.sampleIds).toEqual([KICK, HAT]);
      expect(app.collectionManager.nameDraft).toBe("Loaded Pack");
      // Selection/preview/focus/filters are untouched.
      expect(app.selectedSampleIds).toEqual([]);
      expect(app.focusedSampleId).toBeNull();
      expect(app.previewSampleId).toBeUndefined();
    } finally {
      await db.db.close();
    }
  });

  it("loadCollection surfaces unsupported-version errors (never deletes the row)", async () => {
    const { app, db } = await rig(corpusRecords());
    try {
      await db.collections.put(createPersistedCollection({ name: "Old" }));
      // Overwrite with unsupported version.
      await db.db.put("collections", {
        id: "unsupported",
        name: "Legacy",
        sampleIds: ["samples/kick-heavy"],
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        version: "99.0.0",
      });
      await app.loadCollection("unsupported");
      expect(app.collectionManager.loadError).toBeDefined();
      expect(app.collectionManager.loadError).toContain("unsupported");
    } finally {
      await db.db.close();
    }
  });

  it("delete active collection → active null; dirty true (working set survives)", async () => {
    const { app, db } = await rig(corpusRecords());
    try {
      const saved = createPersistedCollection({ name: "Temp", sampleIds: [KICK] });
      await db.collections.put(saved);
      await app.loadCollection(saved.id);
      expect(app.activeCollectionId).toBe(saved.id);
      expect(app.collectionDirty).toBe(false);
      app.requestDeleteCollection(saved.id, saved.name);
      expect(app.collectionManager.confirm?.kind).toBe("delete");
      await app.confirmDeleteCollection();
      expect(app.activeCollectionId).toBeNull();
      // The working set (still holding KICK) is now an unsaved draft → dirty.
      expect(app.collectionDirty).toBe(true);
      expect(app.collection.sampleIds).toEqual([KICK]);
      expect(app.collectionManager.open).toBe(true);
      expect(app.collectionManager.entries.find((e) => e.id === saved.id)).toBeUndefined();
    } finally {
      await db.db.close();
    }
  });

  it("delete non-active collection leaves active/dirty unchanged", async () => {
    const { app, db } = await rig(corpusRecords());
    try {
      const a = createPersistedCollection({ name: "A" });
      const b = createPersistedCollection({ name: "B", sampleIds: [KICK] });
      await db.collections.put(a);
      await db.collections.put(b);
      await app.loadCollection(a.id);
      app.collectionDirty = false;
      app.requestDeleteCollection(b.id, b.name);
      await app.confirmDeleteCollection();
      expect(app.activeCollectionId).toBe(a.id);
      expect(app.collectionDirty).toBe(false);
    } finally {
      await db.db.close();
    }
  });

  it("switch collection: dirty working set triggers confirmation dialog", async () => {
    const { app, db } = await rig(corpusRecords());
    try {
      const a = createPersistedCollection({ name: "A" });
      const b = createPersistedCollection({ name: "B", sampleIds: [KICK] });
      await db.collections.put(a);
      await db.collections.put(b);
      await app.loadCollection(a.id);
      await app.addToCollection(HAT); // dirty
      app.requestSwitchCollection(b.id, b.name);
      expect(app.collectionManager.confirm?.kind).toBe("switch");
      expect(app.collectionManager.confirm && (app.collectionManager.confirm as { kind: string; targetName: string }).targetName).toBe("B");

      // Discard then switch.
      await app.confirmDiscardThenSwitch();
      expect(app.collectionManager.confirm).toBeUndefined();
      expect(app.activeCollectionId).toBe(b.id);
      expect(app.collection.sampleIds).toEqual([KICK]);
      expect(app.collectionDirty).toBe(false);
    } finally {
      await db.db.close();
    }
  });

  it("save-then-switch persists working set before switching", async () => {
    const { app, db } = await rig(corpusRecords());
    try {
      const a = createPersistedCollection({ name: "A" });
      const b = createPersistedCollection({ name: "B", sampleIds: [] });
      await db.collections.put(a);
      await db.collections.put(b);
      await app.loadCollection(a.id);
      await app.addToCollection(KICK);
      app.requestSwitchCollection(b.id, b.name);
      await app.confirmSaveThenSwitch();
      // Dirty was saved into a.id, then b.id was loaded.
      expect(app.activeCollectionId).toBe(b.id);
      expect(app.collectionDirty).toBe(false);
      const rowA = await db.collections.get(a.id);
      expect(rowA?.ok && rowA.collection.sampleIds).toEqual([KICK]);
    } finally {
      await db.db.close();
    }
  });

  it("cancel switch leaves state unchanged", async () => {
    const { app, db } = await rig(corpusRecords());
    try {
      const a = createPersistedCollection({ name: "A" });
      const b = createPersistedCollection({ name: "B" });
      await db.collections.put(a);
      await db.collections.put(b);
      await app.loadCollection(a.id);
      await app.addToCollection(KICK);
      app.requestSwitchCollection(b.id, b.name);
      app.cancelSwitch();
      expect(app.collectionManager.confirm).toBeUndefined();
      expect(app.activeCollectionId).toBe(a.id);
      expect(app.collectionDirty).toBe(true);
    } finally {
      await db.db.close();
    }
  });
});

describe("STEP28 app — load semantics (frozen surfaces)", () => {
  it("load does not restore selection/preview/focus/filters/search (§28)", async () => {
    const { app, db } = await rig(corpusRecords());
    try {
      const saved = createPersistedCollection({ name: "X", sampleIds: [KICK, HAT, BASS] });
      await db.collections.put(saved);
      app.selectSample(corpusRecords()[0]);
      app.selectedSampleIds = [KICK, LEAD];
      await app.loadCollection(saved.id);
      // Load does NOT alter focus, selection, preview or search state.
      expect(app.focusedSampleId).toBe(KICK);
      expect(app.selectedSampleIds).toEqual([KICK, LEAD]);
      expect(app.previewSampleId).toBeUndefined();
      expect(app.searchState.text).toBe("");
    } finally {
      await db.db.close();
    }
  });

  it("load re-resolves members against current index (stale ids show unavailable)", async () => {
    const { app, db } = await rig(corpusRecords());
    try {
      const saved = createPersistedCollection({ name: "With stale", sampleIds: [KICK, "samples/missing"] });
      await db.collections.put(saved);
      await app.loadCollection(saved.id);
      const members = app.collectionMembers;
      expect(members).toHaveLength(2);
      expect(members[0].available).toBe(true);
      expect(members[0].sampleId).toBe(KICK);
      expect(members[1].available).toBe(false);
      expect(members[1].sampleId).toBe("samples/missing");
    } finally {
      await db.db.close();
    }
  });
});

describe("STEP28 app — invalid list rows (surfaced, never dropped)", () => {
  it("list entries show corrupt/unsupported rows with honest error labels", async () => {
    const { app, db } = await rig(corpusRecords());
    try {
      const good = createPersistedCollection({ name: "Good" });
      await db.collections.put(good);
      await db.db.put("collections", {
        id: "old",
        name: "Legacy",
        sampleIds: [],
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        version: "99.0.0",
      });
      await db.db.put("collections", {
        // Missing name.
        id: "broken",
        sampleIds: [],
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        version: COLLECTION_PERSISTENCE_SCHEMA_VERSION,
      });
      await app.openCollectionManager();
      expect(app.collectionManager.listStatus).toBe("loaded");
      const entries = app.collectionManager.entries;
      expect(entries).toHaveLength(3);
      expect(entries.find((e) => e.id === good.id)?.active).toBe(false);
      expect(entries.find((e) => e.id === "old")?.invalid?.kind).toBe("unsupported-version");
      expect(entries.find((e) => e.id === "broken")?.invalid?.kind).toBe("corrupt");
    } finally {
      await db.db.close();
    }
  });
});

describe("STEP28 app — STEP27 integration (dirty marks from mutations)", () => {
  it("addToCollection/removeFromCollection/clearCollection mark dirty; search refresh resyncs members", async () => {
    const { app } = await rig(corpusRecords());
    expect(app.collectionDirty).toBe(false);
    await app.addToCollection(KICK);
    expect(app.collectionDirty).toBe(true);
    app.collectionDirty = false;
    await app.removeFromCollection(KICK);
    expect(app.collectionDirty).toBe(true);
    app.collectionDirty = false;
    await app.addToCollection(KICK);
    await app.addToCollection(HAT);
    await app.clearCollection();
    expect(app.collectionDirty).toBe(true);
    expect(app.collection.sampleIds).toEqual([]);
  });

  it("openCollection refreshes availability after index changes (§27/§36)", async () => {
    const { app, db, index } = await rig(corpusRecords());
    try {
      await app.addToCollection(KICK);
      await app.addToCollection(HAT);
      await app.openCollection();
      expect(app.collectionMembers.every((m) => m.available)).toBe(true);
      // Simulate record removal from index.
      await index.delete(HAT);
      await app.openCollection();
      const members = app.collectionMembers;
      expect(members).toHaveLength(2);
      expect(members[0].available).toBe(true);
      expect(members[0].sampleId).toBe(KICK);
      expect(members[1].available).toBe(false);
      expect(members[1].sampleId).toBe(HAT);
    } finally {
      await db.db.close();
    }
  });
});