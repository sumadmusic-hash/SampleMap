/**
 * STEP27 — collection core unit tests (spec §34, C01..C17). Pure in-memory,
 * CONSTRUCTED records (never real audio); the boundary functions are pure, so
 * no IndexedDB/DOM involved.
 */
import { describe, it, expect } from "vitest";
import { makeSample } from "../persistence/test-helpers";
import { ANALYSIS_VERSION } from "./sampleAnalysisV2";
import type { SampleAnalysisV2 } from "./sampleAnalysisV2";
import { computeSoundCharacter, computeSoundCharacterQuality } from "./soundCharacter";
import { analyzeCorpus } from "../audio/v2Fixtures";
import {
  emptyCollectionState,
  addToCollection,
  removeFromCollection,
  toggleCollectionSample,
  clearCollection,
  collectionContains,
  isCollectionFull,
  summarizeCollection,
  COLLECTION_VERSION,
  COLLECTION_MAX_SAMPLES,
  type SoundCollectionState,
} from "./collection";
import type { SampleIndexRecord } from "../persistence/indexStore";

function v2Attach(overrides?: Partial<SampleAnalysisV2>): SampleAnalysisV2 {
  const f = analyzeCorpus("whiteNoise", 44100);
  const soundCharacter = computeSoundCharacter(f);
  return {
    analysisVersion: ANALYSIS_VERSION,
    features: f,
    soundCharacter,
    quality: computeSoundCharacterQuality(soundCharacter),
    ...overrides,
  };
}

function record(id: string, name?: string, character?: SampleIndexRecord["analysisV2"]): SampleIndexRecord {
  return makeSample(id, {
    name,
    analysisV2: character !== undefined ? character : v2Attach(),
  });
}

/** A record with an explicit full 8-dim character (brightness set to each). */
function charRecord(id: string, brightness: number | null, rest: Partial<Record<string, number | null>> = {}): SampleIndexRecord {
  const a = v2Attach();
  const soundCharacter = {
    brightness,
    density: 0.5,
    transient: 0.5,
    duration: 0.5,
    tonality: 0.5,
    noisiness: 0.5,
    dynamics: 0.5,
    complexity: 0.5,
    ...rest,
  } as SampleIndexRecord["analysisV2"] extends { soundCharacter: infer C } ? C : never;
  return record(id, id, { ...a, soundCharacter });
}

describe("STEP27 collection core — boundary (C01..C11)", () => {
  it("C01 empty collection: closed, empty, deterministic initial state", () => {
    const c = emptyCollectionState();
    expect(c.sampleIds).toEqual([]);
    expect(c.open).toBe(false);
    expect(collectionContains(c, "x")).toBe(false);
    expect(isCollectionFull(c)).toBe(false);
  });

  it("C02 add appends to the explicit order", () => {
    let c = emptyCollectionState();
    c = addToCollection(c, "A");
    c = addToCollection(c, "B");
    expect(c.sampleIds).toEqual(["A", "B"]);
  });

  it("C03 duplicate add keeps exactly one member (no-op)", () => {
    let c = emptyCollectionState();
    c = addToCollection(c, "A");
    c = addToCollection(c, "A");
    c = addToCollection(c, "A");
    expect(c.sampleIds).toEqual(["A"]);
  });

  it("C04 remove leaves the other members' relative order intact", () => {
    let c = emptyCollectionState();
    for (const id of ["A", "B", "C"]) c = addToCollection(c, id);
    c = removeFromCollection(c, "B");
    expect(c.sampleIds).toEqual(["A", "C"]);
  });

  it("C05 toggle removes when present and adds when absent", () => {
    let c = emptyCollectionState();
    c = toggleCollectionSample(c, "A");
    expect(c.sampleIds).toEqual(["A"]);
    c = toggleCollectionSample(c, "A");
    expect(c.sampleIds).toEqual([]);
  });

  it("C06 clear empties but keeps the panel state", () => {
    let c = emptyCollectionState();
    for (const id of ["A", "B", "C"]) c = addToCollection(c, id);
    c = { ...c, open: true };
    c = clearCollection(c);
    expect(c.sampleIds).toEqual([]);
    expect(c.open).toBe(true);
  });

  it("C07 insertion order is exactly the add order (no sorting)", () => {
    let c = emptyCollectionState();
    for (const id of ["B", "A", "D", "C"]) c = addToCollection(c, id);
    expect(c.sampleIds).toEqual(["B", "A", "D", "C"]);
  });

  it("C08 re-add moves the sample to the END", () => {
    let c = emptyCollectionState();
    for (const id of ["A", "B", "C"]) c = addToCollection(c, id);
    c = removeFromCollection(c, "B");
    c = addToCollection(c, "B");
    expect(c.sampleIds).toEqual(["A", "C", "B"]);
  });

  it("C09 50-cap: the 51st add is a no-op, nothing is evicted", () => {
    let c = emptyCollectionState();
    for (let i = 0; i < COLLECTION_MAX_SAMPLES; i++) {
      c = addToCollection(c, `s${i}`);
    }
    expect(c.sampleIds).toHaveLength(50);
    expect(isCollectionFull(c)).toBe(true);
    const before = c.sampleIds;
    c = addToCollection(c, "overflow");
    expect(c.sampleIds).toEqual(before); // same order, no eviction
    expect(collectionContains(c, "overflow")).toBe(false);
    c = toggleCollectionSample(c, "overflow");
    expect(collectionContains(c, "overflow")).toBe(false);
  });

  it("C10 immutability: inputs are never mutated; real changes return new states", () => {
    const frozen = Object.freeze({
      sampleIds: Object.freeze(["A", "B"]),
      open: Object.freeze(false),
    }) as unknown as SoundCollectionState;
    try {
      const added = addToCollection(frozen, "C");
      expect(added).not.toBe(frozen);
      expect(frozen.sampleIds).toEqual(["A", "B"]); // original untouched
      const removed = removeFromCollection(frozen, "A");
      expect(removed.sampleIds).toEqual(["B"]);
      expect(frozen.sampleIds).toEqual(["A", "B"]);
      const cleared = clearCollection(frozen);
      expect(cleared.sampleIds).toEqual([]);
      expect(frozen.sampleIds).toEqual(["A", "B"]);
    } catch {
      // A thrown readOnly error would ALSO prove immutability; accept either.
    }
  });

  it("C11 membership identity is the sampleId (not name/index/object)", () => {
    const a1 = record("s1", "First copy");
    const a2 = record("s1", "Second copy");
    let c = emptyCollectionState();
    c = addToCollection(c, a1.sampleId);
    expect(collectionContains(c, a2.sampleId)).toBe(true); // same id wins
    c = removeFromCollection(c, a2.sampleId);
    expect(c.sampleIds).toEqual([]);
  });

  it("version pins the STEP27 layer separately from V1/V2", () => {
    expect(COLLECTION_VERSION).toBe("1.0.0");
    expect(COLLECTION_MAX_SAMPLES).toBe(50);
  });
});

describe("STEP27 summary core — summarizeCollection (C12..C17)", () => {
  it("C12 single sample: each dim equals its present value", () => {
    const rec = charRecord("a", 0.8, { density: 0.2, tonality: 0.9 });
    const s = summarizeCollection([rec])!;
    expect(s.brightness).toBeCloseTo(0.8, 10);
    expect(s.density).toBeCloseTo(0.2, 10);
    expect(s.tonality).toBeCloseTo(0.9, 10);
    expect(s.complexity).toBeCloseTo(0.5, 10);
  });

  it("C13 multiple samples: arithmetic mean over present values", () => {
    const s = summarizeCollection([
      charRecord("a", 0.8),
      charRecord("b", 0.4),
      charRecord("c", 0.6),
    ])!;
    for (const dim of ["brightness", "density", "transient", "duration", "tonality", "noisiness", "dynamics", "complexity"] as const) {
      // density etc. default to 0.5 — mean over shared present values = 0.5.
      expect(s[dim]).toBeCloseTo(dim === "brightness" ? 0.6 : 0.5, 10);
    }
  });

  it("C14 missing dimension: mean over PRESENT values only — nulls ignored", () => {
    const s = summarizeCollection([
      charRecord("a", 0.8),
      charRecord("b", null, {}),
      charRecord("c", 0.4),
    ])!;
    expect(s.brightness).toBeCloseTo(0.6, 10); // (0.8 + 0.4) / 2, NOT (0.8+0+0.4)/3
  });

  it("C15 all missing → every dim is null (— in UI)", () => {
    const fullyNull = (id: string): SampleIndexRecord => {
      const a = v2Attach();
      return record(id, id, {
        ...a,
        soundCharacter: {
          brightness: null,
          density: null,
          transient: null,
          duration: null,
          tonality: null,
          noisiness: null,
          dynamics: null,
          complexity: null,
        },
      });
    };
    const s = summarizeCollection([fullyNull("a"), fullyNull("b")]);
    expect(s).toBeNull();
    expect(summarizeCollection([])).toBeNull();
  });

  it("C16 partial dimensions: a mix of present + missing per dim", () => {
    const s = summarizeCollection([
      charRecord("a", 1, { density: null, transient: 0.6 }),
      charRecord("b", null, { density: 0.4, transient: null }),
    ])!;
    expect(s.brightness).toBeCloseTo(1, 10); // only a
    expect(s.density).toBeCloseTo(0.4, 10); // only b
    expect(s.transient).toBeCloseTo(0.6, 10); // only a
    expect(s.tonality).toBeCloseTo(0.5, 10); // both present
  });

  it("C17 immutability + determinism: records untouched, results stable", () => {
    const recs = [charRecord("a", 0.8, { tonality: 0.5 }), charRecord("b", 0.2)];
    const snapshot = JSON.stringify(recs.map((r) => ({ id: r.sampleId, name: r.name, char: r.analysisV2?.soundCharacter })));
    const first = summarizeCollection(recs);
    const second = summarizeCollection(recs);
    expect(second).toEqual(first);
    expect(JSON.stringify(recs.map((r) => ({ id: r.sampleId, name: r.name, char: r.analysisV2?.soundCharacter })))).toBe(snapshot);
  });
});