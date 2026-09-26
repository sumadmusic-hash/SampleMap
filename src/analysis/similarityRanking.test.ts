import { describe, it, expect } from "vitest";
import type { SoundCharacter } from "./soundCharacter";
import { emptySoundCharacter, computeSoundCharacterQuality } from "./soundCharacter";
import {
  rankSimilar,
  sortAndLimitSimilarityResults,
  sanitizeRankingLimit,
  resolveQueryCharacter,
  extractCandidateCharacter,
  SIMILARITY_RANKING_VERSION,
  RANKING_DEFAULT_LIMIT,
  RANKING_MAX_LIMIT,
  RANKING_SUPPORTED_ANALYSIS_VERSION,
  type SimilarityResult,
} from "./similarityRanking";
import { ANALYSIS_VERSION, type SampleAnalysisV2 } from "./sampleAnalysisV2";
import { SIMILARITY_ALGORITHM_VERSION, createSimilarityEngine } from "./similarityEngine";
import { analyzeCorpus } from "../audio/v2Fixtures";
import { makeSample } from "../persistence/test-helpers";

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

describe("rankSimilar — productized ranking over the frozen STEP20 engine", () => {
  it("is deterministic and stays within [0,1] with consistent distance/shared counts", () => {
    const query = record("q", full);
    const candidates = [
      record("a", char({ ...full, brightness: 0.9 })),
      record("b", char({ ...full, brightness: 0.2, tonality: 0.9 })),
      record("c", full),
    ];
    const first = rankSimilar(query, candidates);
    const second = rankSimilar(query, candidates);
    expect(second).toEqual(first);
    for (const r of first) {
      expect(r.similarity).toBeGreaterThanOrEqual(0);
      expect(r.similarity).toBeLessThanOrEqual(1);
      expect(r.distance).toBeCloseTo(1 - r.similarity, 10);
      expect(r.sharedDimensionCount).toBeGreaterThanOrEqual(1);
      expect(r.sharedDimensionCount).toBeLessThanOrEqual(8);
    }
    // The identical candidate is the only 1.0 and sits first.
    expect(first[0]).toEqual({ sampleId: "c", similarity: 1, distance: 0, sharedDimensionCount: 8 });
  });

  it("excludes the query record by default (includeSelf=false) and includes it with includeSelf=true", () => {
    const candidates = [record("q", full), record("other", char({ ...full, brightness: 0.1 }))];
    const excluded = rankSimilar(record("q", full), candidates);
    expect(excluded.map((r) => r.sampleId)).toEqual(["other"]);
    const included = rankSimilar(record("q", full), candidates, { includeSelf: true });
    expect(included[0].sampleId).toBe("q");
    expect(included[0].similarity).toBe(1);
    expect(included[0].sharedDimensionCount).toBe(8);
  });

  it("deduplicates candidates by sampleId (first occurrence wins, no duplicate output id)", () => {
    const dupes = [record("dup", full), record("dup", char({ ...full, brightness: 1 }))];
    const out = rankSimilar(record("q", full), dupes);
    expect(out).toHaveLength(1);
    expect(out[0].sampleId).toBe("dup");
    const ids = rankSimilar(record("q", full), [...dupes, record("dup", full)]).map((r) => r.sampleId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("breaks ties by sampleId ASC at equal similarity", () => {
    const candidates = [record("zeta", full), record("alpha", full), record("mid", full)];
    const out = rankSimilar(record("q", full), candidates);
    expect(out.map((r) => r.sampleId)).toEqual(["alpha", "mid", "zeta"]);
    expect(new Set(out.map((r) => r.similarity))).toEqual(new Set([1]));
  });

  it("returns the top-K by limit and defaults to RANKING_DEFAULT_LIMIT", () => {
    const candidates = Array.from({ length: 25 }, (_, i) =>
      record(`s${String(i).padStart(2, "0")}`, char({ ...full, brightness: i / 25 })),
    );
    // Default limit.
    const all = rankSimilar(record("q", full), candidates);
    expect(all).toHaveLength(RANKING_DEFAULT_LIMIT);
    // Explicit increasing global-limit -> strictly ordered subset (similarity DESC).
    const top3 = rankSimilar(record("q", full), candidates, { limit: 3 });
    expect(top3).toHaveLength(3);
    const sims = all.map((r) => r.similarity);
    for (let i = 1; i < sims.length; i++) expect(sims[i - 1]).toBeGreaterThanOrEqual(sims[i]);
    expect(top3[0].sampleId).toBe(all[0].sampleId);
    expect(top3[0].similarity).toBeGreaterThanOrEqual(top3[1].similarity);
  });

  it("clamps out-of-range limits via sanitizeRankingLimit (never throws)", () => {
    expect(sanitizeRankingLimit(undefined)).toBe(RANKING_DEFAULT_LIMIT);
    expect(sanitizeRankingLimit(0)).toBe(RANKING_DEFAULT_LIMIT);
    expect(sanitizeRankingLimit(-5)).toBe(RANKING_DEFAULT_LIMIT);
    expect(sanitizeRankingLimit(NaN)).toBe(RANKING_DEFAULT_LIMIT);
    expect(sanitizeRankingLimit(Infinity)).toBe(RANKING_DEFAULT_LIMIT);
    expect(sanitizeRankingLimit(2.7)).toBe(2);
    expect(sanitizeRankingLimit(1000)).toBe(RANKING_MAX_LIMIT);
    expect(RANKING_MAX_LIMIT).toBe(100);
    // rankSimilar with a huge limit still caps at RANKING_MAX_LIMIT results.
    const out = rankSimilar(record("q", full), Array.from({ length: 120 }, (_, i) => record(`s${i}`, full)), {
      limit: 1000,
    });
    expect(out.length).toBeLessThanOrEqual(RANKING_MAX_LIMIT);
  });

  it("accepts a bare SampleAnalysisV2 as the query (no sampleId => no self-exclusion)", () => {
    const queryAnalysis = analysis(full);
    const candidates = [record("a", full), record("b", char({ ...full, brightness: 0.05 }))];
    const out = rankSimilar(queryAnalysis, candidates);
    expect(out).toHaveLength(2); // nothing shares the query's (absent) sampleId
    expect(out[0].sampleId).toBe("a");
    expect(out[0].similarity).toBe(1);
  });

  it("returns [] for a record query without a valid analysisV2 (nothing to rank by)", () => {
    expect(rankSimilar(makeSample("q"), [record("a", full)])).toEqual([]);
    expect(resolveQueryCharacter(makeSample("q"))).toBeUndefined();
  });
});

describe("shared-dimension behavior and null policy (§38 ladder 8/7/4/2/1/0)", () => {
  it("reports exact shared counts and excludes the zero-shared-dim candidate (never 0)", () => {
    const query = record("q", full);
    const candidates = [
      record("c8", full),
      record("c7", char({ ...full, complexity: null })),
      record("c4", char({ brightness: 0.5, density: 0.4, transient: 0.6, duration: 0.55 })),
      record("c2", char({ brightness: 0.5, tonality: 0.7 })),
      record("c1", char({ brightness: 0.5 })),
      // All-null character: structurally valid but shares ZERO dimensions with
      // the query -> engine returns null -> excluded (never a 0 score).
      record("c0", char({})),
    ];
    const out = rankSimilar(query, candidates);
    const byId = new Map(out.map((r) => [r.sampleId, r]));
    expect(byId.has("c0")).toBe(false); // 0 shared dims -> null -> excluded, not 0
    expect([...byId.values()].map((r) => r.sharedDimensionCount)).toEqual([1, 2, 4, 7, 8]);
    for (const r of out) expect(r.similarity).toBe(1); // all shared dims equal
  });

  it("renormalizes shared-dimension weights: a single shared dim is the whole comparison", () => {
    const query = record("q", char({ brightness: 1 }));
    const candidates = [
      record("same", char({ brightness: 1 })),
      record("far", char({ brightness: 0 })),
      record("near", char({ brightness: 0.99 })),
    ];
    const out = rankSimilar(query, candidates);
    const byId = new Map(out.map((r) => [r.sampleId, r]));
    expect(byId.get("same")!.sharedDimensionCount).toBe(1);
    expect(byId.get("same")!.similarity).toBe(1);
    expect(byId.get("far")!.similarity).toBe(0); // maximal distance on the one shared dim
    expect(byId.get("near")!.similarity).toBeGreaterThan(0.9);
  });

  it("a one-dim difference ranks closer than an all-dims difference", () => {
    const near = char({ ...full, complexity: 0.55 });
    const far = char({ ...full, brightness: 0, density: 0, transient: 1, tonality: 0 });
    const out = rankSimilar(record("q", full), [record("near", near), record("far", far)]);
    expect(out[0].sampleId).toBe("near");
  });
});

describe("version policy (explicit rejection, never a silent cross-version compare)", () => {
  it("excludes candidates whose analysisV2.analysisVersion is not 2.0.0", () => {
    const oldVersion = record("oldv", full, "1.0.0");
    expect(extractCandidateCharacter(oldVersion)).toBeUndefined();
    const out = rankSimilar(record("q", full), [oldVersion, record("ok", full)]);
    expect(out.map((r) => r.sampleId)).toEqual(["ok"]);
  });

  it("treats an unsupported-version query record as unrankable ([]) and pins the constants", () => {
    expect(SIMILARITY_RANKING_VERSION).toBe("1.0.0");
    expect(RANKING_SUPPORTED_ANALYSIS_VERSION).toBe(ANALYSIS_VERSION);
    expect(ANALYSIS_VERSION).toBe("2.0.0");
    expect(SIMILARITY_ALGORITHM_VERSION).toBe("2.0.0"); // math version untouched by STEP22
    const inflated = { ...makeSample("q"), analysisV2: analysis(full, "2.1.0") };
    expect(rankSimilar(inflated, [record("a", full)])).toEqual([]);
  });

  it("excludes a candidate with a structurally invalid SoundCharacter", () => {
    const bad = { ...full, brightness: 2 }; // out of [0,1]
    const out = rankSimilar(record("q", full), [record("bad", bad as SoundCharacter), record("ok", full)]);
    expect(out.map((r) => r.sampleId)).toEqual(["ok"]);
  });
});

describe("minFeatureCoverage quality gate (§28 optional; default OFF = pure similarity)", () => {
  const partial = char({ brightness: 0.5 }); // coverage 1/8 = 0.125
  const gate = 0.5;

  it("is OFF by default: partial and full candidates both rank", () => {
    const out = rankSimilar(record("q", full), [record("partial", partial), record("full", full)]);
    expect(out.map((r) => r.sampleId)).toEqual(["full", "partial"]);
  });

  it("excludes candidates below the gate when enabled", () => {
    const out = rankSimilar(record("q", full), [record("partial", partial), record("full", full)], {
      minFeatureCoverage: gate,
    });
    expect(out.map((r) => r.sampleId)).toEqual(["full"]);
  });

  it("gates the query too: a below-gate query ranks nothing", () => {
    const out = rankSimilar(record("q", partial), [record("a", full)], { minFeatureCoverage: gate });
    expect(out).toEqual([]);
  });

  it("throws on an out-of-range coverage option", () => {
    expect(() => rankSimilar(record("q", full), [], { minFeatureCoverage: 2 })).toThrow(RangeError);
    expect(() => rankSimilar(record("q", full), [], { minFeatureCoverage: -1 })).toThrow(RangeError);
    expect(() => rankSimilar(record("q", full), [], { minFeatureCoverage: NaN })).toThrow(RangeError);
  });
});

describe("edge cases", () => {
  it("empty candidate list -> []", () => {
    expect(rankSimilar(record("q", full), [])).toEqual([]);
  });

  it("zero shared dims with the query -> no result rows (null safety, not 0)", () => {
    const disjointQuery = record("q", char({ brightness: 1, tonality: 1 }));
    const candidate = record("c", char({ density: 0.5, dynamics: 0.5 }));
    const engine = createSimilarityEngine();
    expect(engine.similarity(disjointQuery.analysisV2!.soundCharacter, candidate.analysisV2!.soundCharacter)).toBeNull();
    expect(rankSimilar(disjointQuery, [candidate])).toEqual([]);
  });

  it("an all-null candidate is structurally rankable (char returned) yet never ranks (0 shared dims)", () => {
    const c = record("e", char({}));
    expect(extractCandidateCharacter(c)).toEqual(char({})); // valid, just empty
    expect(rankSimilar(record("q", full), [c])).toEqual([]); // null similarity -> excluded
  });

  it("empty sampleId still ranks deterministically (ties break by code-unit order)", () => {
    const out = sortAndLimitSimilarityResults(
      [
        { sampleId: "", similarity: 0.8, distance: 0.2, sharedDimensionCount: 8 },
        { sampleId: "b", similarity: 0.8, distance: 0.2, sharedDimensionCount: 8 },
        { sampleId: "a", similarity: 0.9, distance: 0.1, sharedDimensionCount: 8 },
      ],
      10,
    );
    expect(out.map((r) => r.sampleId)).toEqual(["a", "", "b"]);
  });

  it("does not mutate the input candidate array", () => {
    const candidates = [record("a", full), record("b", char({ ...full, brightness: 0.2 }))];
    const snapshot = candidates.slice();
    rankSimilar(record("q", full), candidates);
    expect(candidates).toEqual(snapshot);
  });
});

describe("SimilarityResult payload invariants", () => {
  it("every result carries similarity, distance, and the shared-dimension count", () => {
    const out: SimilarityResult[] = rankSimilar(
      record("q", full),
      [record("a", char({ ...full, brightness: 0.8 })), record("b", char({ ...full, tonality: 0.1 }))],
    );
    for (const r of out) {
      expect(r).toHaveProperty("sampleId");
      expect(typeof r.similarity).toBe("number");
      expect(typeof r.distance).toBe("number");
      expect(Number.isInteger(r.sharedDimensionCount)).toBe(true);
    }
  });
});