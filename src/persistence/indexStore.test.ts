import { describe, it, expect } from "vitest";
import { assertNoAudioBytes, isWellFormedIndexRecord } from "./indexStore";
import { openTestDatabase, makeSample } from "./test-helpers";
import { STORES } from "./db";

describe("IndexStore CRUD", () => {
  it("puts and reads back a record", async () => {
    const { index, db } = await openTestDatabase();
    try {
      const rec = makeSample("samples/a");
      await index.put(rec);
      const got = await index.get("samples/a");
      expect(got).toEqual(rec);
    } finally {
      await db.close();
    }
  });

  it("returns undefined for a missing record", async () => {
    const { index, db } = await openTestDatabase();
    try {
      expect(await index.get("samples/missing")).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("counts and clears", async () => {
    const { index, db } = await openTestDatabase();
    try {
      await index.put(makeSample("samples/a"));
      await index.put(makeSample("samples/b"));
      expect(await index.count()).toBe(2);
      await index.clear();
      expect(await index.count()).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("deletes a record", async () => {
    const { index, db } = await openTestDatabase();
    try {
      await index.put(makeSample("samples/a"));
      await index.delete("samples/a");
      expect(await index.get("samples/a")).toBeUndefined();
    } finally {
      await db.close();
    }
  });
});

describe("IndexStore metadata slice (bpm/numFavorites/numUsages)", () => {
  it("roundtrips bpm (including 0 as a preserved source value)", async () => {
    const { index, db } = await openTestDatabase();
    try {
      await index.put(makeSample("samples/bpm", { bpm: 0 }));
      const rec = await index.get("samples/bpm");
      expect(rec).toBeDefined();
      expect(rec!.bpm).toBe(0);
      await index.put(makeSample("samples/bpm", { bpm: 128 }));
      const rec2 = await index.get("samples/bpm");
      expect(rec2!.bpm).toBe(128);
    } finally {
      await db.close();
    }
  });

  it("roundtrips numFavorites", async () => {
    const { index, db } = await openTestDatabase();
    try {
      await index.put(makeSample("samples/fav", { numFavorites: 42 }));
      expect((await index.get("samples/fav"))!.numFavorites).toBe(42);
    } finally {
      await db.close();
    }
  });

  it("roundtrips numUsages", async () => {
    const { index, db } = await openTestDatabase();
    try {
      await index.put(makeSample("samples/use", { numUsages: 187 }));
      expect((await index.get("samples/use"))!.numUsages).toBe(187);
    } finally {
      await db.close();
    }
  });

  it("reads a legacy record that omits the metadata fields", async () => {
    const { index, db } = await openTestDatabase();
    try {
      const legacy = makeSample("samples/legacy");
      legacy.bpm = undefined;
      legacy.numFavorites = undefined;
      legacy.numUsages = undefined;
      await index.put(legacy);
      const rec = await index.get("samples/legacy");
      expect(rec).toBeDefined();
      expect(rec!.bpm).toBeUndefined();
      expect(rec!.numFavorites).toBeUndefined();
      expect(rec!.numUsages).toBeUndefined();
      expect(rec!.primaryClass).toBe("kick");
      expect(rec!.confidence).toBe(0.9);
      expect(rec!.audioFeatures).toBeDefined();
      expect(rec!.mapPosition).toEqual({ x: 0.62, y: 0.42 });
      expect(() => assertNoAudioBytes(rec!)).not.toThrow();
    } finally {
      await db.close();
    }
  });
});

describe("IndexStore query", () => {
  it("filters by primary class, matching secondary classes too", async () => {
    const { index, db } = await openTestDatabase();
    try {
      await index.put(makeSample("samples/kick", { primaryClass: "kick" }));
      await index.put(
        makeSample("samples/clap", {
          primaryClass: "clap",
          secondaryClasses: [{ class: "percussion", confidence: 0.1 }],
        }),
      );
      await index.put(makeSample("samples/tom", { primaryClass: "toms" }));
      const kicks = await index.query({ primaryClass: "kick" });
      expect(kicks.map((r) => r.sampleId)).toEqual(["samples/kick"]);
      const percussion = await index.query({ primaryClass: "percussion" });
      expect(percussion.map((r) => r.sampleId)).toEqual(["samples/clap"]);
    } finally {
      await db.close();
    }
  });

  it("filters by owner, status and duration range", async () => {
    const { index, db } = await openTestDatabase();
    try {
      await index.put(
        makeSample("samples/a", { owner: "alice", status: "analyzed" }),
      );
      await index.put(
        makeSample("samples/b", { owner: "bob", status: "pending" }),
      );
      await index.put(
        makeSample("samples/c", {
          owner: "alice",
          status: "analyzed",
          audioFeatures: { ...makeSample("x").audioFeatures, duration: 2 },
        }),
      );
      const aliceAnalyzed = await index.query({
        owner: "alice",
        status: "analyzed",
      });
      expect(aliceAnalyzed.map((r) => r.sampleId).sort()).toEqual([
        "samples/a",
        "samples/c",
      ]);
      const long = await index.query({ minDuration: 1 });
      expect(long.map((r) => r.sampleId)).toEqual(["samples/c"]);
    } finally {
      await db.close();
    }
  });

  it("searches by name and original tags (case-insensitive)", async () => {
    const { index, db } = await openTestDatabase();
    try {
      await index.put(
        makeSample("samples/1", { name: "Deep Kick", originalTags: ["pierre"] }),
      );
      await index.put(
        makeSample("samples/2", {
          name: "Snappy Clap",
          originalTags: ["perc"],
        }),
      );
      const byName = await index.query({ search: "deep kick" });
      expect(byName.map((r) => r.sampleId)).toEqual(["samples/1"]);
      const byTag = await index.query({ search: "perc" });
      expect(byTag.map((r) => r.sampleId)).toEqual(["samples/2"]);
    } finally {
      await db.close();
    }
  });

  it("sorts by confidence descending by default and applies a limit", async () => {
    const { index, db } = await openTestDatabase();
    try {
      await index.put(makeSample("samples/l", { confidence: 0.5, name: "B" }));
      await index.put(makeSample("samples/h", { confidence: 0.98, name: "A" }));
      await index.put(makeSample("samples/m", { confidence: 0.7, name: "C" }));
      const all = await index.query({});
      expect(all.map((r) => r.confidence)).toEqual([0.98, 0.7, 0.5]);
      const top2 = await index.query({ limit: 2 });
      expect(top2.length).toBe(2);
      expect(top2[0].confidence).toBe(0.98);
    } finally {
      await db.close();
    }
  });
});

describe("Persistence invariant (no audio bytes)", () => {
  it("accepts a valid SampleMap record (metadata only)", () => {
    expect(() => assertNoAudioBytes(makeSample("samples/a"))).not.toThrow();
  });

  it("accepts an optional Float32Array embedding", () => {
    const rec = makeSample("samples/a");
    rec.embedding = new Float32Array([0.1, 0.2]);
    expect(() => assertNoAudioBytes(rec)).not.toThrow();
  });

  it("rejects Blob", () => {
    expect(() =>
      assertNoAudioBytes({ sampleId: "x", blob: new Blob(["x"]) }),
    ).toThrow(/audio byte container/);
  });

  it("rejects ArrayBuffer", () => {
    expect(() =>
      assertNoAudioBytes({ data: new ArrayBuffer(4) }),
    ).toThrow(/audio byte container/);
  });

  it("rejects non-embedding typed arrays (e.g. Int16Array audio PCM)", () => {
    expect(() => assertNoAudioBytes({ pcm: new Int16Array(4) })).toThrow(
      /non-embedding typed array/,
    );
  });

  it("rejects nested byte containers inside arrays/objects", () => {
    expect(() =>
      assertNoAudioBytes({ list: [{ inner: new Uint8Array(2) }] }),
    ).toThrow(/(audio byte container|non-embedding typed array)/);
  });

  it("enforces the invariant when writing through the store", async () => {
    const { index, db } = await openTestDatabase();
    try {
      const rec = makeSample("samples/a") as unknown as {
        [k: string]: unknown;
      };
      // Inject a forbidden byte container into the record shape.
      rec.audioFeatures = new Uint8Array(4) as unknown as never;
      await expect(index.put(rec as never)).rejects.toThrow(/typed array/);
    } finally {
      await db.close();
    }
  });
});

describe("IndexStore read-path validation (corrupt records)", () => {
  /** Seed a structurally-invalid row directly, bypassing the typed `put`. */
  function seedCorrupt(db: { put: (store: string, value: unknown) => Promise<IDBValidKey> }, row: unknown) {
    return db.put(STORES.samples, row);
  }

  it("isWellFormedIndexRecord accepts a full production record and rejects malformed shapes", () => {
    expect(isWellFormedIndexRecord(makeSample("samples/a"))).toBe(true);
    expect(isWellFormedIndexRecord(null)).toBe(false);
    expect(isWellFormedIndexRecord(undefined)).toBe(false);
    expect(isWellFormedIndexRecord({})).toBe(false);
    expect(isWellFormedIndexRecord("nope")).toBe(false);
    // structural violations
    expect(
      isWellFormedIndexRecord({ ...makeSample("samples/a"), status: "broken" }),
    ).toBe(false);
    expect(
      isWellFormedIndexRecord({ ...makeSample("samples/a"), confidence: NaN }),
    ).toBe(false);
    expect(
      isWellFormedIndexRecord({ ...makeSample("samples/a"), name: undefined }),
    ).toBe(false);
    expect(
      isWellFormedIndexRecord({
        ...makeSample("samples/a"),
        secondaryClasses: [{ class: "toms" }],
      }),
    ).toBe(false);
    expect(
      isWellFormedIndexRecord({
        ...makeSample("samples/a"),
        audioFeatures: { duration: NaN, sampleRate: 44100 },
      }),
    ).toBe(false);
    expect(
      isWellFormedIndexRecord({ ...makeSample("samples/a"), originalTags: ["ok", 5] }),
    ).toBe(false);
  });

  it("get treats a corrupt record as absent (undefined) instead of crashing", async () => {
    const { index, db } = await openTestDatabase();
    try {
      await seedCorrupt(db, { sampleId: "samples/broken", name: 123 });
      expect(await index.get("samples/broken")).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("getAll and query exclude corrupt records while keeping valid rows", async () => {
    const { index, db } = await openTestDatabase();
    try {
      await index.put(makeSample("samples/ok"));
      await seedCorrupt(db, { sampleId: "samples/broken", name: 123 });
      await seedCorrupt(db, makeSample("samples/nan", { confidence: NaN }));
      const all = await index.getAll();
      expect(all.map((r) => r.sampleId)).toEqual(["samples/ok"]);
      const q = await index.query({});
      expect(q.map((r) => r.sampleId)).toEqual(["samples/ok"]);
      // search must not throw and must not match the corrupt rows
      const s = await index.query({ search: "broken" });
      expect(s.map((r) => r.sampleId)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("reconstructPending (publish reconstruction) never sees corrupt rows", async () => {
    const { index, db } = await openTestDatabase();
    try {
      await index.put(
        makeSample("samples/pending", {
          globalPublish: { usageAcceptedAt: "2026-01-01T00:00:00.000Z", delivery: "pending" },
        }),
      );
      await seedCorrupt(db, {
        sampleId: "samples/brokenpub",
        name: "x",
        globalPublish: { usageAcceptedAt: "2026-01-01T00:00:00.000Z", delivery: "pending" },
      });
      const all = await index.getAll();
      expect(all.map((r) => r.sampleId)).toEqual(["samples/pending"]);
    } finally {
      await db.close();
    }
  });
});
