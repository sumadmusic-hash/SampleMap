/**
 * STEP28 — Collection persistence performance envelope (§55). Uses REAL
 * fake-indexeddb. Exercises create, save 50, load, list 100 and delete — each
 * under the target latency envelope. Never real audio.
 */
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { openTestDatabase } from "./test-helpers";
import { IndexedDBCollectionStore } from "./collectionStore";
import {
  createPersistedCollection,
  type PersistedSoundCollection,
} from "../analysis/collectionPersistence";

const SAMPLE_IDS_50: string[] = Array.from({ length: 50 }, (_, i) => `samples/s${i}`);

function makeCollection(
  name: string,
  sampleIds: readonly string[] = [],
  id?: string,
): PersistedSoundCollection {
  return createPersistedCollection({ name, sampleIds, id });
}

describe("STEP28 collection persistence — performance envelope", () => {
  it("create (empty) < 100ms", async () => {
    const handle = await openTestDatabase();
    const store = new IndexedDBCollectionStore(handle.db);
    const start = performance.now();
    await store.put(makeCollection("Perf Empty", [], "perf-1"));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    await handle.db.close();
  });

  it("save 50-member collection < 100ms", async () => {
    const handle = await openTestDatabase();
    const store = new IndexedDBCollectionStore(handle.db);
    const c = makeCollection("Pack 50", SAMPLE_IDS_50, "perf-2");
    const start = performance.now();
    await store.put(c);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    await handle.db.close();
  });

  it("load (get) < 100ms", async () => {
    const handle = await openTestDatabase();
    const store = new IndexedDBCollectionStore(handle.db);
    await store.put(makeCollection("Load Target", SAMPLE_IDS_50, "perf-load"));
    const start = performance.now();
    const row = await store.get("perf-load");
    const elapsed = performance.now() - start;
    expect(row?.ok).toBe(true);
    expect(elapsed).toBeLessThan(100);
    await handle.db.close();
  });

  it("list 100 collections < 250ms", async () => {
    const handle = await openTestDatabase();
    const store = new IndexedDBCollectionStore(handle.db);
    for (let i = 0; i < 100; i++) {
      await store.put(makeCollection(`List ${i}`, [], `list-${i}`));
    }
    const start = performance.now();
    const rows = await store.list();
    const elapsed = performance.now() - start;
    expect(rows).toHaveLength(100);
    expect(elapsed).toBeLessThan(250);
    await handle.db.close();
  });

  it("delete < 100ms", async () => {
    const handle = await openTestDatabase();
    const store = new IndexedDBCollectionStore(handle.db);
    await store.put(makeCollection("Delete Me", SAMPLE_IDS_50, "del"));
    const start = performance.now();
    await store.delete("del");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    const remaining = await store.list();
    expect(remaining).toHaveLength(0);
    await handle.db.close();
  });
});