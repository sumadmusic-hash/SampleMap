/**
 * STEP28 — CollectionStore IndexedDB adapter tests (spec §52). These exercise
 * REAL IndexedDB (fake-indexeddb) — the store contract: create/list/get/update/
 * delete/reload/multiple/same-name, corrupt and unsupported-version surfacing,
 * duplicate handling, no-audio enforcement and store isolation. CONSTRUCTED
 * fixtures — never real audio.
 */
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { openTestDatabase, makeSample } from "./test-helpers";
import { openDatabase, STORES } from "./db";
import { ElasticDB } from "./elasticdb";
import { IndexedDBCollectionStore, type CollectionListRow } from "./collectionStore";
import {
  COLLECTION_PERSISTENCE_SCHEMA_VERSION,
  createPersistedCollection,
  withUpdatedCollection,
  type PersistedSoundCollection,
} from "../analysis/collectionPersistence";

const FIXED_NOW = 1_700_000_000_000;

function collection(id: string, updatedAt: number): PersistedSoundCollection {
  const c = createPersistedCollection({
    name: `Collection ${id}`,
    id,
    sampleIds: ["samples/a", "samples/b"],
  });
  return withUpdatedCollection(c, {}, updatedAt);
}

function validRows(rows: readonly CollectionListRow[]): PersistedSoundCollection[] {
  return rows.filter((r): r is Extract<CollectionListRow, { ok: true }> => r.ok)
    .map((r) => r.collection);
}

describe("STEP28 CollectionStore — CRUD", () => {
  it("S-01 put then get returns the exact persisted collection (order preserved)", async () => {
    const { collections, db } = await openTestDatabase();
    try {
      const c = collection("col-a", FIXED_NOW);
      await collections.put(c);
      const got = await collections.get("col-a");
      expect(got).toBeDefined();
      if (!got?.ok) throw new Error("expected valid row");
      expect(got.collection).toEqual(c);
      expect(got.collection.sampleIds).toEqual(["samples/a", "samples/b"]);
    } finally {
      await db.close();
    }
  });

  it("S-02 list on an empty database returns []", async () => {
    const { collections, db } = await openTestDatabase();
    try {
      expect(await collections.list()).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("S-03 list is deterministic: updatedAt DESC, id ASC tiebreak", async () => {
    const { collections, db } = await openTestDatabase();
    try {
      await collections.put(collection("col-b", 200));
      await collections.put(collection("col-a", 200));
      await collections.put(collection("col-c", 100));
      await collections.put(collection("col-d", 300));
      const ids = validRows(await collections.list()).map((c) => c.id);
      // 300 first; 200 ties broken by id asc; then 100.
      expect(ids).toEqual(["col-d", "col-a", "col-b", "col-c"]);
    } finally {
      await db.close();
    }
  });

  it("S-04 updating a collection overwrites in place (still one row)", async () => {
    const { collections, db } = await openTestDatabase();
    try {
      const a = collection("col-a", 100);
      await collections.put(a);
      const renamed = withUpdatedCollection(a, { name: "Renamed Pack" }, 900);
      await collections.put(renamed);
      const rows = validRows(await collections.list());
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("Renamed Pack");
      expect(rows[0].updatedAt).toBe(900);
      expect(rows[0].createdAt).toBe(a.createdAt);
    } finally {
      await db.close();
    }
  });

  it("S-05 delete removes the collection; deleting a missing id is a no-op", async () => {
    const { collections, db } = await openTestDatabase();
    try {
      await collections.put(collection("col-a", 100));
      await collections.delete("col-a");
      expect(await collections.get("col-a")).toBeUndefined();
      // Deleting a never-existed id resolves successfully.
      await expect(collections.delete("col-nope")).resolves.toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("S-06 multiple collections may share a name (no uniqueness constraint)", async () => {
    const { collections, db } = await openTestDatabase();
    try {
      const a = collection("col-a", 100);
      const b = { ...withUpdatedCollection(a, {}, 200), id: "col-b", createdAt: 100 };
      await collections.put(a);
      await collections.put(b);
      const rows = validRows(await collections.list());
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.name === a.name)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("S-07 reload: data persists across a close/reopen of the same database", async () => {
    const name = `col-reload-${Date.now()}`;
    const first = await openDatabase(name, 3);
    try {
      await first.collections.put(collection("col-a", 123));
      await first.collections.put(collection("col-b", 124));
    } finally {
      await first.db.close();
    }

    const second = await openDatabase(name, 3);
    try {
      const ids = validRows(await second.collections.list()).map((c) => c.id);
      expect(ids).toEqual(["col-b", "col-a"]);
      const got = await second.collections.get("col-a");
      expect(got?.ok && got.collection.sampleIds).toEqual(["samples/a", "samples/b"]);
    } finally {
      await second.db.close();
    }
  });
});

describe("STEP28 CollectionStore — corrupt & unsupported data", () => {
  it("S-08 a corrupt row is surfaced (never silently dropped or deleted)", async () => {
    const { db, collections } = await openTestDatabase();
    try {
      await collections.put(collection("col-good", 100));
      await db.put(STORES.collections, {
        id: "col-broken",
        sampleIds: ["samples/x"],
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        version: COLLECTION_PERSISTENCE_SCHEMA_VERSION,
        // missing "name"
      });
      await db.put(STORES.collections, {
        id: "col-too-big",
        sampleIds: ["samples/x", "samples/y"],
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        version: COLLECTION_PERSISTENCE_SCHEMA_VERSION,
        name: "",
      });

      const rows = await collections.list();
      const valid = validRows(rows);
      expect(valid.map((c) => c.id)).toEqual(["col-good"]);
      const bad = rows.filter((r) => !r.ok);
      expect(bad).toHaveLength(2);
      expect(bad.every((r) => !r.ok && r.invalid.kind === "corrupt")).toBe(true);

      const gotBroken = await collections.get("col-broken");
      expect(gotBroken && !gotBroken.ok).toBe(true);
      // The corrupt row is PRESERVED in storage (never deleted by reads).
      expect(await db.get(STORES.collections, "col-broken")).toBeDefined();
    } finally {
      await db.close();
    }
  });

  it("S-08 put refuses to persist an invalid model (corrupt writes rejected)", async () => {
    const { collections, db } = await openTestDatabase();
    try {
      const bad = { ...collection("col-a", 100), name: "   " } as PersistedSoundCollection;
      await expect(collections.put(bad)).rejects.toThrow();
      // Nothing was written for the refused document.
      expect(await collections.list()).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("S-09 an unsupported version is surfaced and NEVER deleted or mutated", async () => {
    const { db, collections } = await openTestDatabase();
    try {
      const raw = {
        id: "col-v2",
        name: "Older Collection",
        sampleIds: ["samples/a"],
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        version: "2.0.0",
      };
      await db.put(STORES.collections, raw);

      const rows = await collections.list();
      const match = rows.find((r) => !r.ok && r.invalid.id === "col-v2");
      expect(match && !match.ok && match.invalid.kind).toBe("unsupported-version");
      if (!match || match.ok) return;
      expect(match.invalid.unknownVersion).toBe("2.0.0");

      const got = await collections.get("col-v2");
      expect(got && !got.ok && got.invalid.kind).toBe("unsupported-version");

      // Still present after reads — never deleted, never guessed.
      const stored = await db.get(STORES.collections, "col-v2");
      expect((stored as Record<string, unknown>).version).toBe("2.0.0");
    } finally {
      await db.close();
    }
  });
});

describe("STEP28 CollectionStore — isolation & no-audio", () => {
  it("S-10 collection ops never touch the samples/jobs stores", async () => {
    const { db, collections, index, queue } = await openTestDatabase();
    try {
      await index.put(makeSample("samples/keep"));
      await queue.enqueue("samples/keep", "build-v1");
      await collections.put(collection("col-a", 100));

      // List/update/delete collections do not alter other stores.
      const renamed = withUpdatedCollection(collection("col-a", 100), { name: "X" }, 200);
      await collections.put(renamed);
      await collections.delete("col-b");
      expect(await index.get("samples/keep")).toBeDefined();
      expect(await queue.get("samples/keep")).toBeDefined();
      expect((await index.getAll()).map((r) => r.sampleId)).toEqual(["samples/keep"]);
    } finally {
      await db.close();
    }
  });

  it("S-10 deleting a collection never deletes index/library records", async () => {
    const { db, collections, index } = await openTestDatabase();
    try {
      await index.put(makeSample("samples/a"));
      await collections.put({ ...collection("col-a", 100), sampleIds: ["samples/a"] });
      await collections.delete("col-a");
      expect(await index.get("samples/a")).toBeDefined();
      expect(await collections.list()).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("S-10 persisted collections are REFERENCES ONLY — audio bytes rejected on put", async () => {
    const { collections, db } = await openTestDatabase();
    try {
      const c = collection("col-a", 100);
      const smuggled = { ...c, audio: new Blob(["bytes"]) } as unknown as PersistedSoundCollection;
      await expect(collections.put(smuggled)).rejects.toThrow(/audio byte container/);
      // Nothing persisted for the rejected document.
      expect(await collections.list()).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

describe("STEP28 CollectionStore — write failure is surfaced (no silent success)", () => {
  it("S-11 a failed put rejects and propagates the underlying error", async () => {
    class FailingElasticDB extends ElasticDB {
      constructor() {
        super("col-failing", 1, () => {});
      }
      override async put(): Promise<IDBValidKey> {
        throw new Error("quota exceeded (simulated)");
      }
    }
    const store = new IndexedDBCollectionStore(new FailingElasticDB());
    await expect(store.put(collection("col-a", 100))).rejects.toThrow(/quota exceeded/);
  });
});