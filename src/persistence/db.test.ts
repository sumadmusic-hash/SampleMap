import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { openDatabase, SCHEMA_VERSION, STORES } from "./db";
import { makeSample } from "./test-helpers";

describe("Database schema & migrations", () => {
  it("opens at the current schema version and exposes both stores", async () => {
    const handle = await openDatabase(`db-current-${Date.now()}`, SCHEMA_VERSION);
    try {
      expect(handle.index).toBeDefined();
      expect(handle.queue).toBeDefined();
      await handle.index.put(makeSample("samples/a"));
      expect(await handle.index.count()).toBe(1);
      await handle.queue.enqueue("samples/a", "build-v1");
      expect(await handle.queue.countByStatus("queued")).toBe(1);
    } finally {
      await handle.db.close();
    }
  });

  it("preserves existing records across a schema upgrade (v1 -> v2)", async () => {
    const name = `db-migrate-${Date.now()}`;
    // Open at v1 (SCHEMA_VERSION 2 would skip the migration; open explicitly at v1).
    // NOTE: our openDatabase() uses one upgrade callback that builds the full
    // schema on oldVersion < 1, so to simulate a true upgrade we open at v1.
    const v1 = await openDatabase(name, 1);
    await v1.index.put(makeSample("samples/keep", { name: "kept" }));
    const indexNamesBefore = await storeIndexNames(name, STORES.samples);
    expect(indexNamesBefore).not.toContain("owner");
    await v1.db.close();

    // Upgrade to v2: adds the "owner" index, existing data preserved.
    const v2 = await openDatabase(name, 2);
    try {
      const got = await v2.index.get("samples/keep");
      expect(got?.name).toBe("kept");
      const indexNamesAfter = await storeIndexNames(name, STORES.samples);
      expect(indexNamesAfter).toContain("owner");
    } finally {
      await v2.db.close();
    }
  });
});

// Vitest declares fake-indexeddb/auto; drop a reference so it stays required.

async function storeIndexNames(
  dbName: string,
  store: string,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(store, "readonly");
      const names = Array.from(tx.objectStore(store).indexNames);
      db.close();
      resolve(names);
    };
    req.onerror = () => reject(req.error ?? new Error("open failed"));
  });
}
