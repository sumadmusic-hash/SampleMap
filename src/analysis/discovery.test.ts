import { describe, it, expect } from "vitest";
import type { SoundCharacter } from "./soundCharacter";
import { emptySoundCharacter, computeSoundCharacterQuality } from "./soundCharacter";
import { ANALYSIS_VERSION, type SampleAnalysisV2 } from "./sampleAnalysisV2";
import { SampleMapSearchEngine } from "../search/searchEngine";
import type { IndexStore } from "../persistence/indexStore";
import { analyzeCorpus } from "../audio/v2Fixtures";
import { makeSample } from "../persistence/test-helpers";
import {
  discoverSamples,
  sanitizeDiscoveryLimit,
  hasDiscoveryCriterion,
  DISCOVERY_ALGORITHM_VERSION,
  DISCOVERY_DEFAULT_LIMIT,
  DISCOVERY_MAX_LIMIT,
  DISCOVERY_MATCH_LABEL,
  DISCOVERY_REASON_LABELS,
  DISCOVERY_WEIGHTS,
  type DiscoveryQuery,
  type DiscoveryResultRow,
} from "./discovery";

function char(values: Partial<SoundCharacter>): SoundCharacter {
  return { ...emptySoundCharacter(), ...values };
}

/** Valid V2 analysis wrapper over any SoundCharacter (features are a valid belt). */
const _features = analyzeCorpus("pureTone440", 44100); // one DSP pass, reused
function analysis(c: SoundCharacter, version?: string): SampleAnalysisV2 {
  return {
    analysisVersion: (version ?? ANALYSIS_VERSION) as typeof ANALYSIS_VERSION,
    features: _features,
    soundCharacter: c,
    quality: computeSoundCharacterQuality(c),
  };
}

function record(id: string, c: SoundCharacter, version?: string) {
  return makeSample(id, { analysisV2: analysis(c, version) });
}

function v1Record(id: string, name: string) {
  // makeSample carries no analysisV2 by default => a valid V1-only analyzed record.
  return makeSample(id, { name });
}

function named(id: string, name: string, c: SoundCharacter) {
  return makeSample(id, { name, analysisV2: analysis(c) });
}

const full = char({
  brightness: 0.5,
  density: 0.4,
  transient: 0.6,
  duration: 0.55,
  tonality: 0.7,
  noisiness: 0.3,
  dynamics: 0.45,
  complexity: 0.6,
});

/** Shared corpus (all analyzed). */
function corpus(): ReturnType<typeof makeSample>[] {
  return [
    named("kick-a", "Kick Alpha 01", full),
    named("kick-b", "Kick Beta 909", full),
    named("bright-hat", "Bright Hat Airy", char({ ...full, brightness: 1 })),
    named("dark-bass", "Dark Bass Deep", char({ ...full, brightness: 0, tonality: 0.1 })),
    v1Record("v1-dark", "Kick Old School"),
  ];
}

function engineFor(records: readonly ReturnType<typeof makeSample>[]) {
  return new SampleMapSearchEngine({ getAll: async () => [...records] } as unknown as IndexStore);
}

function run(query: DiscoveryQuery, records: readonly ReturnType<typeof makeSample>[]) {
  return discoverSamples(query, records, { search: engineFor(records) });
}

function ids(rows: DiscoveryResultRow[]): string[] {
  return rows.map((r) => r.sampleId);
}

describe("STEP26 discovery core — boundaries and constants", () => {
  it("D16 pins the versioned constants and the frozen reason labels", () => {
    expect(DISCOVERY_ALGORITHM_VERSION).toBe("1.0.0");
    expect(DISCOVERY_MATCH_LABEL).toBe("Match");
    expect(DISCOVERY_REASON_LABELS).toEqual({
      "text-match": "Matches search",
      "character-match": "Matches filter",
      "similar-to-reference": "Similar",
    });
    expect(DISCOVERY_WEIGHTS.text + DISCOVERY_WEIGHTS.character + DISCOVERY_WEIGHTS.similarity).toBe(1);
    expect(DISCOVERY_WEIGHTS.text).toBeGreaterThan(0);
    expect(DISCOVERY_WEIGHTS.character).toBeGreaterThan(0);
    expect(DISCOVERY_WEIGHTS.similarity).toBeGreaterThan(0);
    expect(DISCOVERY_DEFAULT_LIMIT).toBe(10);
    expect(DISCOVERY_MAX_LIMIT).toBe(100);
  });

  it("D16 sanitizes limits (never throws): default 10, max 100", () => {
    expect(sanitizeDiscoveryLimit(undefined)).toBe(DISCOVERY_DEFAULT_LIMIT);
    expect(sanitizeDiscoveryLimit(0)).toBe(DISCOVERY_DEFAULT_LIMIT);
    expect(sanitizeDiscoveryLimit(-5)).toBe(DISCOVERY_DEFAULT_LIMIT);
    expect(sanitizeDiscoveryLimit(NaN)).toBe(DISCOVERY_DEFAULT_LIMIT);
    expect(sanitizeDiscoveryLimit(Infinity)).toBe(DISCOVERY_DEFAULT_LIMIT);
    expect(sanitizeDiscoveryLimit(2.7)).toBe(2);
    expect(sanitizeDiscoveryLimit(200)).toBe(DISCOVERY_MAX_LIMIT);
    expect(sanitizeDiscoveryLimit(1000)).toBe(DISCOVERY_MAX_LIMIT);
  });

  it("D16 hasDiscoveryCriterion gates on trimmed text / active filter / reference", () => {
    expect(hasDiscoveryCriterion({ text: "   " })).toBe(false);
    expect(hasDiscoveryCriterion({ text: "kick" })).toBe(true);
    expect(hasDiscoveryCriterion({ characterFilter: {} })).toBe(false);
    expect(hasDiscoveryCriterion({ characterFilter: { brightness: { min: 0, max: 1 } } })).toBe(false);
    expect(hasDiscoveryCriterion({ characterFilter: { brightness: { min: 0.5, max: 1 } } })).toBe(true);
    expect(hasDiscoveryCriterion({ referenceSampleId: "kick-a" })).toBe(true);
    expect(hasDiscoveryCriterion({ referenceSampleId: "" })).toBe(false);
  });

  it("D01 empty index and empty query both yield []", async () => {
    expect(await run({ text: "kick" }, [])).toEqual([]);
    expect(await run({ text: "kick", referenceSampleId: "x" }, [])).toEqual([]);
    expect(await run({}, corpus())).toEqual([]);
    expect(await run({ text: "   " }, corpus())).toEqual([]);
  });
});

describe("STEP26 discovery — single-source semantics", () => {
  it("D02 text-only: existing SearchEngine matches, score mirror, only analyzed pool", async () => {
    const rows = await run({ text: "kick" }, corpus());
    // Engine matches kick-a/kick-b/v1-dark by name; pending records are excluded.
    expect(ids(rows)).toEqual(["kick-a", "kick-b", "v1-dark"]);
    for (const r of rows) {
      expect(r.label).toBe("Match");
      expect(r.reasons).toEqual([{ type: "text-match", label: "Matches search" }]);
      expect(r.searchScore).toBeGreaterThan(0);
      expect(r.score).toBe(r.searchScore); // text-only => score == engine score
      expect(r.similarity).toBeUndefined();
    }
    expect(rows[0].score).toBeGreaterThan(0);
    expect(rows.every((r) => r.score >= 0 && r.score <= 1)).toBe(true);
  });

  it("D03 filter-only: existing SoundSpace filter predicate, sampleId ASC, score 1", async () => {
    const bright = await run({ characterFilter: { brightness: { min: 0.8, max: 1 } } }, corpus());
    expect(ids(bright)).toEqual(["bright-hat"]);
    expect(bright[0].reasons).toEqual([{ type: "character-match", label: "Matches filter" }]);
    expect(bright[0].score).toBe(1);

    const mid = await run({ characterFilter: { brightness: { min: 0.4, max: 0.6 } } }, corpus());
    expect(ids(mid).sort()).toEqual(["kick-a", "kick-b"]);
    expect(mid[0].score).toBe(1);
  });

  it("D04 reference-only: rankSimilar over the analyzed pool, self excluded, similarity order", async () => {
    const rows = await run({ referenceSampleId: "kick-a" }, corpus());
    // kick-a is the reference (excluded), v1-dark is not rankable.
    expect(ids(rows)).not.toContain("kick-a");
    expect(ids(rows)).not.toContain("v1-dark");
    // Identical kick-b ranks 1st (similarity 1).
    expect(rows[0].sampleId).toBe("kick-b");
    expect(rows[0].similarity).toBe(1);
    expect(rows[0].score).toBe(rows[0].similarity);
    // Bright-hat differs in one dim, dark-bass in two => monotonic similarity.
    const simOf = new Map(rows.map((r) => [r.sampleId, r.similarity as number]));
    expect(simOf.get("bright-hat") as number).toBeGreaterThan(simOf.get("dark-bass") as number);
    for (const r of rows) {
      expect(r.reasons).toEqual([{ type: "similar-to-reference", label: "Similar" }]);
      expect(r.similarity).toBeGreaterThanOrEqual(0);
      expect(r.similarity).toBeLessThanOrEqual(1);
      expect(r.distance).toBeCloseTo(1 - (r.similarity as number), 5);
      expect(r.sharedDimensionCount).toBeGreaterThanOrEqual(1);
    }
  });

  it("D04b reference-only ties break by sampleId ASC", async () => {
    const records = [
      record("kick-z", full),
      record("kick-a", full),
      record("kick-m", full),
      record("ref", full),
    ];
    const rows = await run({ referenceSampleId: "ref" }, records);
    expect(ids(rows)).toEqual(["kick-a", "kick-m", "kick-z"]);
  });
});

describe("STEP26 discovery — combined-source semantics", () => {
  it("D05 text AND filter = intersection (each source must pass)", async () => {
    const rows = await run(
      { text: "kick", characterFilter: { brightness: { min: 0.4, max: 0.6 } } },
      corpus(),
    );
    // kick-a/kick-b match text AND the brightness window; bright-hat fails text,
    // v1-dark fails the character window.
    expect(ids(rows)).toEqual(["kick-a", "kick-b"]);
    for (const r of rows) {
      expect(r.reasons).toEqual([
        { type: "text-match", label: "Matches search" },
        { type: "character-match", label: "Matches filter" },
      ]);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("D06 text AND reference: similarity ranks within the text matches", async () => {
    const rows = await run({ text: "kick", referenceSampleId: "kick-a" }, corpus());
    // Text matches = kick-a/kick-b/v1-dark; kick-a is the reference (excluded),
    // v1-dark is not similarity-rankable => only kick-b remains.
    expect(ids(rows)).toEqual(["kick-b"]);
    expect(rows[0].reasons).toEqual([
      { type: "text-match", label: "Matches search" },
      { type: "similar-to-reference", label: "Similar" },
    ]);
    expect(rows[0].similarity).toBe(1);
  });

  it("D07 text + filter + reference: triple intersection, all reasons present", async () => {
    const rows = await run(
      {
        text: "kick",
        characterFilter: { brightness: { min: 0.4, max: 0.6 } },
        referenceSampleId: "kick-a",
      },
      corpus(),
    );
    expect(ids(rows)).toEqual(["kick-b"]);
    expect(rows[0].reasons).toEqual([
      { type: "text-match", label: "Matches search" },
      { type: "character-match", label: "Matches filter" },
      { type: "similar-to-reference", label: "Similar" },
    ]);
  });
});

describe("STEP26 discovery — identity, bounds, determinism", () => {
  it("D08 self-exclusion: the reference sample never appears (includeSelf=false)", async () => {
    for (const query of [
      { referenceSampleId: "kick-a" },
      { text: "kick", referenceSampleId: "kick-a" },
      {
        text: "kick",
        characterFilter: { brightness: { min: 0.4, max: 0.6 } },
        referenceSampleId: "kick-a",
      },
    ]) {
      const rows = await run(query, corpus());
      expect(ids(rows)).not.toContain("kick-a");
    }
  });

  it("D09 duplicates by sampleId are emitted once (first occurrence wins)", async () => {
    const dupRecords = [
      named("kick-a", "Kick Alpha 01", full),
      // Second occurrence with a bright char must NOT win the pool.
      named("kick-b", "Kick Beta 909", char({ ...full, brightness: 1 })),
      named("kick-b", "Kick Beta 909", full),
      named("bright-hat", "Bright Hat Airy", char({ ...full, brightness: 1 })),
    ];
    const rows = await run({ text: "kick" }, dupRecords);
    expect(new Set(ids(rows)).size).toBe(ids(rows).length);
    // kick-b is deduped to its FIRST char (brightness 1): a 0.4..0.6 filter
    // leaves kick-b out, keeping only kick-a.
    const filtered = await run(
      { characterFilter: { brightness: { min: 0.4, max: 0.6 } } },
      dupRecords,
    );
    expect(ids(filtered)).toEqual(["kick-a"]);
  });

  it("D10 limit: default 10, explicit cap clamped to 100", async () => {
    const many = [
      record("ref", full),
      ...Array.from({ length: 25 }, (_, i) => record(`s${String(i).padStart(2, "0")}`, full)),
    ];
    // Default limit -> top 10 of 25 rankable (reference excluded).
    expect((await run({ referenceSampleId: "ref" }, many)).length).toBe(DISCOVERY_DEFAULT_LIMIT);
    // Explicit 3 -> exactly 3 rows (similarity DESC).
    expect((await run({ referenceSampleId: "ref", limit: 3 }, many)).length).toBe(3);

    const lots = [
      record("ref", full),
      ...Array.from({ length: 150 }, (_, i) => record(`s${String(i).padStart(3, "0")}`, full)),
    ];
    // 149 rankable; limit 1000 clamps to DISCOVERY_MAX_LIMIT and never throws.
    const capped = await run({ referenceSampleId: "ref", limit: 1000 }, lots);
    expect(capped.length).toBe(DISCOVERY_MAX_LIMIT);
    const cappedIds = ids(capped);
    expect(new Set(cappedIds).size).toBe(cappedIds.length);
  });

  it("D11 determinism: identical snapshot+query and shuffled input give identical rows", async () => {
    const records = corpus();
    const query: DiscoveryQuery = {
      text: "kick",
      characterFilter: { brightness: { min: 0.4, max: 0.6 } },
      referenceSampleId: "kick-a",
    };
    const first = await run(query, records);
    const second = await run(query, records);
    expect(second).toEqual(first);

    const shuffled = [...records].sort((a, b) => (a.sampleId < b.sampleId ? 1 : -1));
    expect(await run(query, shuffled)).toEqual(first);
  });

  it("D17 every combined score stays in [0,1], 4dp-roundable, labeled Match", async () => {
    const queries: DiscoveryQuery[] = [
      { text: "kick" },
      { characterFilter: { brightness: { min: 0.4, max: 0.6 } } },
      { referenceSampleId: "kick-a" },
      { text: "kick", characterFilter: { brightness: { min: 0.4, max: 0.6 } } },
      { text: "kick", referenceSampleId: "kick-a" },
      {
        text: "kick",
        characterFilter: { brightness: { min: 0.4, max: 0.6 } },
        referenceSampleId: "kick-a",
      },
    ];
    for (const q of queries) {
      for (const r of await run(q, corpus())) {
        expect(r.label).toBe("Match");
        expect(Number.isFinite(r.score)).toBe(true);
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
        expect(Math.round(r.score * 10000)).toBeCloseTo(r.score * 10000, 5);
      }
    }
  });
});

describe("STEP26 discovery — version, V1, missing reference, safety", () => {
  it("D12 V1-only: searchable by text, fails an active filter, not similarity-rankable", async () => {
    expect(ids(await run({ text: "kick" }, corpus()))).toContain("v1-dark");
    expect(ids(await run({ characterFilter: { brightness: { min: 0.4, max: 0.6 } } }, corpus()))).not.toContain("v1-dark");
    expect(ids(await run({ referenceSampleId: "kick-a" }, corpus()))).not.toContain("v1-dark");
  });

  it("D13 partial-V2: a null covered dim fails the filter; similarity uses shared dims", async () => {
    const corpusWithPartial = [
      ...corpus(),
      named("partial", "Partial One", char({ ...full, brightness: null })),
    ];
    // brightness null on the record => fails the active brightness window.
    const filtered = await run(
      { characterFilter: { brightness: { min: 0.4, max: 0.6 } } },
      corpusWithPartial,
    );
    expect(ids(filtered)).not.toContain("partial");
    // Reference-only: partial shares 7 dims => rankable.
    const ranked = await run({ referenceSampleId: "kick-a" }, corpusWithPartial);
    expect(ids(ranked)).toContain("partial");
  });

  it("D14 missing/unrankable reference: reference-only -> [], text/filter fall back", async () => {
    expect(await run({ referenceSampleId: "nope" }, corpus())).toEqual([]);
    expect(await run({ referenceSampleId: "v1-dark" }, corpus())).toEqual([]);
    // With text/filter present, a missing reference degrades to those sources.
    const rows = await run({ text: "kick", referenceSampleId: "nope" }, corpus());
    expect(ids(rows)).toEqual(["kick-a", "kick-b", "v1-dark"]);
    expect(rows.every((r) => !r.reasons.some((x) => x.type === "similar-to-reference"))).toBe(true);
  });

  it("D15 no mutation of records, query or filter", async () => {
    const records = corpus();
    const snapshot = structuredClone(records);
    const filter = { brightness: { min: 0.4, max: 0.6 } };
    const filterSnapshot = structuredClone(filter);
    await run({ text: "kick", characterFilter: filter, referenceSampleId: "kick-a" }, records);
    expect(records).toEqual(snapshot);
    expect(filter).toEqual(filterSnapshot);
  });

  it("D18 perf smoke at 10k records: reference-only completes, bounded rows", async () => {
    const n = 10_000;
    const records = Array.from({ length: n }, (_, i) =>
      named(`s${String(i).padStart(5, "0")}`, `Sample ${i}`, char({ ...full, brightness: i % 2 })),
    );
    const started = performance.now();
    const rows = await run({ referenceSampleId: "s00000" }, records);
    const elapsed = performance.now() - started;
    expect(rows.length).toBe(DISCOVERY_DEFAULT_LIMIT);
    expect(new Set(ids(rows)).size).toBe(rows.length);
    expect(ids(rows)).not.toContain("s00000");
    // Generous bound to avoid CI flakiness; the report carries the measured table.
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("STEP26 discovery — weight arithmetic is explicit", () => {
  it("text+filter+reference scores equal the documented weighted mean", async () => {
    const rows = await run(
      {
        text: "kick",
        characterFilter: { brightness: { min: 0.4, max: 0.6 } },
        referenceSampleId: "kick-a",
      },
      corpus(),
    );
    const row = rows[0];
    const expected =
      (DISCOVERY_WEIGHTS.text * (row.searchScore as number) +
        DISCOVERY_WEIGHTS.character * 1 +
        DISCOVERY_WEIGHTS.similarity * (row.similarity as number)) /
      1;
    expect(row.score).toBeCloseTo(expected, 2);
  });
});