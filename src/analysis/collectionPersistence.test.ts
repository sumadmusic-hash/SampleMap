/**
 * STEP28 — persistence core unit tests (spec §51, P01..P17). The pure boundary
 * in `collectionPersistence.ts` is 100% DOM/IndexedDB-free; everything here is
 * CONSTRUCTED fixtures (never real audio). Persistence itself is tested against
 * real (fake-)IndexedDB in `src/persistence/collectionStore.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  COLLECTION_PERSISTENCE_SCHEMA_VERSION,
  COLLECTION_NAME_MAX_CODE_POINTS,
  DEFAULT_COLLECTION_NAME,
  createPersistedCollection,
  newCollectionId,
  normalizeCollectionName,
  serializeCollection,
  validatePersistedCollection,
  withUpdatedCollection,
  type PersistedSoundCollection,
} from "./collectionPersistence";
import { COLLECTION_MAX_SAMPLES } from "./collection";

const FIXED_NOW = 1_700_000_000_000;
const now = () => FIXED_NOW;

function fixture(overrides: Partial<PersistedSoundCollection> = {}): PersistedSoundCollection {
  return {
    id: "col-1",
    name: "My Kick Pack",
    sampleIds: ["samples/a", "samples/b", "samples/c"],
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    version: COLLECTION_PERSISTENCE_SCHEMA_VERSION,
    ...overrides,
  };
}

describe("STEP28 persistence core — valid serialization (P01, P02, P03)", () => {
  it("P01 serializes valid collections deterministically (same input -> same output)", () => {
    const a = serializeCollection(fixture());
    const b = serializeCollection(fixture());
    expect(a).toEqual(b);
    expect(a).not.toBe(fixture());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("P02 round-trips exactly: validate(serialize(c)) preserves every field and order", () => {
    const c = fixture({ sampleIds: ["samples/z", "samples/a", "samples/m"] });
    const result = validatePersistedCollection(serializeCollection(c));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.collection).toEqual(c);
    expect(result.collection.sampleIds).toEqual(["samples/z", "samples/a", "samples/m"]);
  });

  it("P03 createPersistedCollection: default name, empty membership, fresh timestamps", () => {
    const c = createPersistedCollection({ name: DEFAULT_COLLECTION_NAME, now });
    expect(c).toEqual({
      id: expect.any(String) as string,
      name: DEFAULT_COLLECTION_NAME,
      sampleIds: [],
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      version: COLLECTION_PERSISTENCE_SCHEMA_VERSION,
    });
  });

  it("P03 createPersistedCollection normalizes the supplied name", () => {
    const c = createPersistedCollection({ name: "  My Pack  ", now });
    expect(c.name).toBe("My Pack");
  });
});

describe("STEP28 persistence core — size/duplicate gates (P04, P05, P06)", () => {
  it("P04 a 50-member collection validates at the hard boundary", () => {
    const c = fixture({
      sampleIds: Array.from({ length: COLLECTION_MAX_SAMPLES }, (_, i) => `samples/s${i}`),
    });
    expect(validatePersistedCollection(c).ok).toBe(true);
  });

  it("P05 a 51-member collection is INVALID (corrupt) and refuses serialization, never truncated", () => {
    const ids = Array.from({ length: COLLECTION_MAX_SAMPLES + 1 }, (_, i) => `samples/s${i}`);
    const result = validatePersistedCollection(fixture({ sampleIds: ids }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalid.kind).toBe("corrupt");
    expect(result.invalid.reason).toContain(String(COLLECTION_MAX_SAMPLES));
    expect(() => serializeCollection(fixture({ sampleIds: ids }))).toThrow(TypeError);
  });

  it("P06 a duplicate sample id is INVALID (corrupt), never silently deduplicated", () => {
    const result = validatePersistedCollection(
      fixture({ sampleIds: ["samples/a", "samples/b", "samples/a"] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalid.kind).toBe("corrupt");
    expect(result.invalid.reason).toContain("duplicate");
    expect(() =>
      serializeCollection(fixture({ sampleIds: ["samples/a", "samples/b", "samples/a"] })),
    ).toThrow(TypeError);
  });
});

describe("STEP28 persistence core — shape validation (P07, P08, P11, P12)", () => {
  it("P07 rejects invalid collection ids (non-string / empty)", () => {
    for (const id of [undefined, null, 42, "", "  "]) {
      const bad = { ...fixture(), id: id as unknown as string };
      const result = validatePersistedCollection(bad);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.invalid.kind).toBe("corrupt");
    }
  });

  it("P08 rejects invalid names (non-string, empty, whitespace-only)", () => {
    for (const name of [undefined, null, 7, "", "   "]) {
      const bad = { ...fixture(), name: name as unknown as string };
      expect(validatePersistedCollection(bad).ok).toBe(false);
    }
  });

  it("P11 rejects records with any missing required field as corrupt", () => {
    const { version: _v, ...noVersion } = fixture();
    expect(validatePersistedCollection(noVersion).ok).toBe(false);
    const { id: _i, ...noId } = fixture();
    expect(validatePersistedCollection(noId).ok).toBe(false);
    const { name: _n, ...noName } = fixture();
    expect(validatePersistedCollection(noName).ok).toBe(false);
    const { sampleIds: _s, ...noIds } = fixture();
    expect(validatePersistedCollection(noIds).ok).toBe(false);
    const { createdAt: _c, ...noCreated } = fixture();
    expect(validatePersistedCollection(noCreated).ok).toBe(false);
    const { updatedAt: _u, ...noUpdated } = fixture();
    expect(validatePersistedCollection(noUpdated).ok).toBe(false);
  });

  it("P12 rejects non-finite timestamps (NaN, Infinity, strings)", () => {
    for (const t of [NaN, Infinity, -Infinity, "2026-01-01T00:00:00.000Z", true]) {
      const bad = { ...fixture(), createdAt: t as unknown as number };
      expect(validatePersistedCollection(bad).ok).toBe(false);
      const bad2 = { ...fixture(), updatedAt: t as unknown as number };
      expect(validatePersistedCollection(bad2).ok).toBe(false);
    }
  });
});

describe("STEP28 persistence core — name normalization (P09)", () => {
  it("P09 trims surrounding whitespace and preserves interior spacing", () => {
    expect(validatePersistedCollection(fixture({ name: "  My Pack  " })).ok).toBe(true);
    const result = validatePersistedCollection(fixture({ name: "  My Pack  " }));
    if (!result.ok) return;
    expect(result.collection.name).toBe("My Pack");
  });

  it("P09 accepts exactly 100 Unicode code points and rejects 101", () => {
    const hundred = "a".repeat(COLLECTION_NAME_MAX_CODE_POINTS);
    expect(hundred.length).toBe(100);
    expect(validatePersistedCollection(fixture({ name: hundred })).ok).toBe(true);
    expect(validatePersistedCollection(fixture({ name: "a".repeat(101) })).ok).toBe(false);
  });

  it("P09 counts Unicode CODE POINTS (surrogate pairs), not UTF-16 units", () => {
    // 51 emoji = 51 code points but 102 UTF-16 units; still valid (≤100 points).
    const emoji = "🎧".repeat(51);
    expect(Array.from(emoji).length).toBe(51);
    expect(validatePersistedCollection(fixture({ name: emoji })).ok).toBe(true);
    // 101 emoji = 101 code points → invalid.
    expect(validatePersistedCollection(fixture({ name: "🎧".repeat(101) })).ok).toBe(false);
  });
});

describe("STEP28 persistence core — version gate (P10)", () => {
  it("P10 an unknown version is rejected as unsupported-version, carrying the raw version", () => {
    const unknown = fixture({ version: "99.0.0" });
    const result = validatePersistedCollection(unknown);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalid.kind).toBe("unsupported-version");
    expect(result.invalid.unknownVersion).toBe("99.0.0");
    expect(result.invalid.id).toBe("col-1");
  });

  it("P10 unsupported-version records are never mutated, deleted or rewritten", () => {
    const before = JSON.stringify(fixture({ version: "2.0.0" }));
    const result = validatePersistedCollection(JSON.parse(before));
    expect(result.ok).toBe(false);
    // The raw record is left untouched.
    expect(JSON.stringify(JSON.parse(before))).toBe(before);
    expect(() => serializeCollection(fixture({ version: "2.0.0" }))).toThrow(TypeError);
  });

  it("P10 a missing version is classified corrupt (NOT unsupported)", () => {
    const { version: _v, ...rest } = fixture();
    const result = validatePersistedCollection(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalid.kind).toBe("corrupt");
  });
});

describe("STEP28 persistence core — order, stale ids (P13, P14)", () => {
  it("P13 explicit insertion order is authoritative and preserved exactly", () => {
    const ids = ["samples/a", "samples/zz", "samples/b", "samples/01"];
    const c = fixture({ sampleIds: ids });
    const serialized = serializeCollection(c);
    expect(serialized.sampleIds).toEqual(ids);
    const validated = validatePersistedCollection(serialized);
    if (!validated.ok) return;
    expect(validated.collection.sampleIds).toEqual(ids);
  });

  it("P14 stale sample ids are PRESERVED, not dropped or repaired (references only)", () => {
    const ids = ["samples/gone", "samples/a", "samples/never-scanned"];
    const result = validatePersistedCollection(fixture({ sampleIds: ids }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.collection.sampleIds).toEqual(ids);
    expect(result.collection.sampleIds[0]).toBe("samples/gone");
  });
});

describe("STEP28 persistence core — immutability (P15)", () => {
  it("P15 validation returns a fresh copy (no aliasing of persisted storage)", () => {
    const c = fixture();
    const result = validatePersistedCollection(c);
    if (!result.ok) return;
    expect(result.collection).not.toBe(c);
    (result.collection.sampleIds as string[]).push("samples/x");
    result.collection.name = "mutated";
    expect(c.sampleIds).toEqual(["samples/a", "samples/b", "samples/c"]);
    expect(c.name).toBe("My Kick Pack");
  });

  it("P15 mutating the caller's input array is invisible to the validated result", () => {
    const c = fixture();
    const ids = [...c.sampleIds];
    const result = validatePersistedCollection(c);
    ids.splice(0, ids.length, "samples/late");
    if (!result.ok) return;
    expect(result.collection.sampleIds).toEqual(["samples/a", "samples/b", "samples/c"]);
  });

  it("P15 serializeCollection output is a detached plain copy", () => {
    const c = fixture();
    const out = serializeCollection(c);
    expect(out).not.toBe(c);
    (out.sampleIds as string[]).push("samples/x");
    expect(c.sampleIds).toEqual(["samples/a", "samples/b", "samples/c"]);
  });
});

describe("STEP28 persistence core — updates (P16)", () => {
  it("P16 withUpdatedCollection stamps a fresh updatedAt and preserves id/createdAt/version", () => {
    const c = withUpdatedCollection(fixture(), { sampleIds: ["samples/a", "samples/b"] }, 500);
    expect(c.updatedAt).toBe(500);
    expect(c.createdAt).toBe(FIXED_NOW);
    expect(c.id).toBe("col-1");
    expect(c.version).toBe(COLLECTION_PERSISTENCE_SCHEMA_VERSION);
    expect(c.sampleIds).toEqual(["samples/a", "samples/b"]);
  });

  it("P16 renaming normalizes the new name and never mutates the source", () => {
    const src = fixture();
    const c = withUpdatedCollection(src, { name: "  Renamed  " }, 600);
    expect(c.name).toBe("Renamed");
    expect(src.name).toBe("My Kick Pack");
    expect(c.updatedAt).toBe(600);
  });

  it("P16 no patch still advances updatedAt (a metadata-only touch is a real update)", () => {
    const c = withUpdatedCollection(fixture(), {}, 700);
    expect(c.updatedAt).toBe(700);
    expect(c.sampleIds).toEqual(["samples/a", "samples/b", "samples/c"]);
  });

  it("P16 invalid updates throw (contract violation — never a corrupt write)", () => {
    const c = fixture();
    expect(() => withUpdatedCollection(c, { name: "   " })).toThrow(TypeError);
    expect(() => withUpdatedCollection(c, { name: "a".repeat(101) })).toThrow(TypeError);
    expect(() =>
      withUpdatedCollection(c, { sampleIds: ["samples/a", "samples/a"] }),
    ).toThrow(TypeError);
    expect(() =>
      withUpdatedCollection(c, { sampleIds: ["samples/a", ""] }),
    ).toThrow(TypeError);
    expect(() =>
      withUpdatedCollection(c, {
        sampleIds: Array.from({ length: 51 }, (_, i) => `s${i}`),
      }),
    ).toThrow(TypeError);
  });
});

describe("STEP28 persistence core — creation guards + ids (P17)", () => {
  it("P17 createPersistedCollection throws on invalid names and invalid membership", () => {
    expect(() => createPersistedCollection({ name: "" })).toThrow(TypeError);
    expect(() => createPersistedCollection({ name: "   " })).toThrow(TypeError);
    expect(() => createPersistedCollection({ name: "a".repeat(101) })).toThrow(TypeError);
    expect(() =>
      createPersistedCollection({ name: "ok", sampleIds: [""] }),
    ).toThrow(TypeError);
    expect(() =>
      createPersistedCollection({ name: "ok", sampleIds: ["a", "a"] }),
    ).toThrow(TypeError);
    expect(() =>
      createPersistedCollection({
        name: "ok",
        sampleIds: Array.from({ length: 51 }, (_, i) => `s${i}`),
      }),
    ).toThrow(TypeError);
  });

  it("P17 injection of a supplied id and fresh timestamps works", () => {
    const c = createPersistedCollection({ name: "Given", id: "col-x", now });
    expect(c.id).toBe("col-x");
    expect(c.createdAt).toBe(FIXED_NOW);
    expect(c.updatedAt).toBe(FIXED_NOW);
    expect(c.name).toBe("Given");
  });

  it("P17 newCollectionId is unique, non-empty and NOT derived from name/count/time alone", () => {
    const a = newCollectionId();
    const b = newCollectionId();
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
    // Same timestamp instant yields different ids (entropy, not just clock).
    const c = newCollectionId();
    const d = newCollectionId();
    expect(c).not.toBe(d);
  });

  it("P17 normalizeCollectionName rejects empty/oversized and returns trimmed names", () => {
    expect(normalizeCollectionName("   ")).toBeNull();
    expect(normalizeCollectionName("a".repeat(101))).toBeNull();
    expect(normalizeCollectionName("  Drums  ")).toBe("Drums");
  });
});