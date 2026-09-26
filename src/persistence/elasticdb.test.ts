import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import { ElasticDB } from "./elasticdb";

/** A self-contained ElasticDB over a throw-away generic key-value store. */
function makeKvDb() {
  const name = `kv-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const db = new ElasticDB(name, 1, (idb) => {
    idb.createObjectStore("kv", { keyPath: "key" });
  });
  return { db, store: "kv" };
}

describe("ElasticDB", () => {
  it("persists and reads a record by key", async () => {
    const { db, store } = makeKvDb();
    try {
      const value = { key: "a", n: 42 };
      await db.put(store, value);
      const got = await db.get<{ key: string; n: number }>(store, "a");
      expect(got).toEqual({ key: "a", n: 42 });
    } finally {
      await db.close();
    }
  });

  it("overwrites on put with the same key", async () => {
    const { db, store } = makeKvDb();
    try {
      await db.put(store, { key: "a", v: 1 });
      await db.put(store, { key: "a", v: 2 });
      const got = await db.get<{ key: string; v: number }>(store, "a");
      expect(got?.v).toBe(2);
    } finally {
      await db.close();
    }
  });

  it("deletes and clears a store", async () => {
    const { db, store } = makeKvDb();
    try {
      await db.put(store, { key: "a" });
      await db.put(store, { key: "b" });
      await db.delete(store, "a");
      expect(await db.get(store, "a")).toBeUndefined();
      expect(await db.count(store)).toBe(1);
      await db.clear(store);
      expect(await db.count(store)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("counts stored records", async () => {
    const { db, store } = makeKvDb();
    try {
      expect(await db.count(store)).toBe(0);
      await db.put(store, { key: "a" });
      await db.put(store, { key: "b" });
      expect(await db.count(store)).toBe(2);
    } finally {
      await db.close();
    }
  });

  it("exposes an instance for decorating", () => {
    const db = new ElasticDB("elasticdb-validation", 1, () => {});
    expect(db).toBeInstanceOf(ElasticDB);
  });
});
