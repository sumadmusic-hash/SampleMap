import { describe, it, expect } from "vitest";
import {
  SIMILARITY_VERSION,
  computeSimilarityFingerprint,
  getWeights,
  type SimilarityFingerprint,
} from "./similarityFingerprint";
import {
  similarityDistance,
  similarityScore,
} from "./similarityDistance";
import {
  findSimilar,
  sanitizeSimilarLimit,
  DEFAULT_SIMILAR_LIMIT,
  SIMILAR_LIMITS,
} from "./similaritySearch";
import type { AudioFeatures, SampleIndexRecord } from "../persistence/indexStore";
import { makeSample } from "../persistence/test-helpers";
import { makeFeatures } from "../classify/test-helpers";
import { assertNoAudioBytes } from "../persistence/indexStore";
import { contentIdentityKey, makeContentIdentity } from "../identity/audioContentIdentity";

// ─────────────────────────────────────────────────────────────────────────────
// Step 15J — Perceptual Similarity / Find Similar
//
// Prove the design invariants from STEP15J_DESIGN.md and the task §20 (A–N).
// ─────────────────────────────────────────────────────────────────────────────

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a SampleIndexRecord with a given contentHash and fingerprint values. */
function rec(
  sampleId: string,
  contentHash: string,
  fingerprintValues: number[],
  overrides: Partial<SampleIndexRecord> = {},
): SampleIndexRecord {
  const fp: SimilarityFingerprint = {
    similarityVersion: SIMILARITY_VERSION,
    values: fingerprintValues,
  };
  return makeSample(sampleId, {
    contentHash,
    contentHashVersion: "pcm-v1",
    similarityFingerprint: fp,
    ...overrides,
  });
}

function fp(values: number[]): SimilarityFingerprint {
  return { similarityVersion: SIMILARITY_VERSION, values };
}

/** A full layer of zeros (all normalized components at minimum). */
const ZEROS = [0, 0, 0, 0, 0, 0, 0, 0];
/** A full layer of ones (all normalized components at maximum). */
const ONES = [1, 1, 1, 1, 1, 1, 1, 1];

// ─── A — Fingerprint determinism ─────────────────────────────────────────────

describe("similarity fingerprint determinism (A)", () => {
  it("same features twice → exactly identical fingerprint", () => {
    const features = makeFeatures();
    const a = computeSimilarityFingerprint(features);
    const b = computeSimilarityFingerprint(features);
    expect(a).toEqual(b);
    expect(a.values).toEqual(b.values);
  });

  it("re-running extraction over the same DecodedAudio yields identical values", () => {
    const featuresA = makeFeatures({ duration: 0.5, spectralCentroid: 2000 });
    const featuresB = makeFeatures({ duration: 0.5, spectralCentroid: 2000 });
    expect(computeSimilarityFingerprint(featuresA)).toEqual(
      computeSimilarityFingerprint(featuresB),
    );
  });

  it("different features generally produce different fingerprints", () => {
    const kick = computeSimilarityFingerprint(kickFeatures());
    const hat = computeSimilarityFingerprint(hatFeatures());
    expect(kick.values).not.toEqual(hat.values);
  });
});

// ─── B — Version ─────────────────────────────────────────────────────────────

describe("similarity version (B)", () => {
  it("SIMILARITY_VERSION is similarity-v1", () => {
    expect(SIMILARITY_VERSION).toBe("similarity-v1");
  });

  it("computed fingerprints carry similarity-v1", () => {
    const f = computeSimilarityFingerprint(makeFeatures());
    expect(f.similarityVersion).toBe("similarity-v1");
  });

  it("fingerprint has exactly 8 components", () => {
    const f = computeSimilarityFingerprint(makeFeatures());
    expect(f.values).toHaveLength(8);
  });

  it("weights sum to 1.0 and have length 8", () => {
    const w = getWeights();
    expect(w).toHaveLength(8);
    const sum = w.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(1e-9);
  });
});

// ─── C — Normalization ───────────────────────────────────────────────────────

describe("similarity normalization (C)", () => {
  // For log-compressed features, an input at the lower/upper bound maps to 0/1.
  it("duration at lower bound → 0, at upper bound → 1", () => {
    expect(computeSimilarityFingerprint(makeFeatures({ duration: 0.01 })).values[0]).toBe(0);
    expect(computeSimilarityFingerprint(makeFeatures({ duration: 60 })).values[0]).toBe(1);
  });

  it("values outside bounds clamp to [0,1]", () => {
    // duration below lower bound (0.001 < 0.01) clamps to 0.
    expect(computeSimilarityFingerprint(makeFeatures({ duration: 0.001 })).values[0]).toBe(0);
    // duration above upper bound (120 > 60) clamps to 1.
    expect(computeSimilarityFingerprint(makeFeatures({ duration: 120 })).values[0]).toBe(1);
  });

  it("direct-clamp features (zeroCrossingRate) map exactly", () => {
    expect(computeSimilarityFingerprint(makeFeatures({ zeroCrossingRate: 0 })).values[1]).toBe(0);
    expect(computeSimilarityFingerprint(makeFeatures({ zeroCrossingRate: 0.5 })).values[1]).toBe(0.5);
    expect(computeSimilarityFingerprint(makeFeatures({ zeroCrossingRate: 1 })).values[1]).toBe(1);
  });

  it("spectralCentroid uses log scaling 100..8000 (same axis as map)", () => {
    expect(computeSimilarityFingerprint(makeFeatures({ spectralCentroid: 100 })).values[4]).toBe(0);
    expect(computeSimilarityFingerprint(makeFeatures({ spectralCentroid: 8000 })).values[4]).toBe(1);
  });

  it("tonalNoiseRatio direct clamp", () => {
    expect(computeSimilarityFingerprint(makeFeatures({ tonalNoiseRatio: 0 })).values[7]).toBe(0);
    expect(computeSimilarityFingerprint(makeFeatures({ tonalNoiseRatio: 1 })).values[7]).toBe(1);
  });
});

// ─── D — Distance (golden value) ─────────────────────────────────────────────

describe("similarity distance golden value (D)", () => {
  it("zero distance for identical fingerprints", () => {
    expect(similarityDistance(fp(ZEROS), fp(ZEROS))).toBe(0);
    expect(similarityDistance(fp(ONES), fp(ONES))).toBe(0);
  });

  it("hand-computed weighted Euclidean distance", () => {
    // A = all zeros; B differs only at index 4 (weight 0.2) = 1.
    // d = sqrt(0.2 * (0-1)^2) / sqrt(sum w=1) = sqrt(0.2)
    const expected = Math.sqrt(0.2);
    const d = similarityDistance(fp(ZEROS), fp([0, 0, 0, 0, 1, 0, 0, 0]));
    expect(Math.abs(d - expected)).toBeLessThan(1e-12);
  });

  it("distance is symmetric", () => {
    const a = fp([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const b = fp([0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]);
    expect(similarityDistance(a, b)).toBe(similarityDistance(b, a));
  });

  it("max-distance fingerprints (all-zeros vs all-ones) are within [0,1]", () => {
    const d = similarityDistance(fp(ZEROS), fp(ONES));
    // d = sqrt(sum w_i * 1^2) = sqrt(1.0) = 1
    expect(Math.abs(d - 1)).toBeLessThan(1e-12);
  });
});

// ─── E — Similarity = 1 - d ──────────────────────────────────────────────────

describe("similarity score = 1 - d (E)", () => {
  it("identical fingerprints → similarity 1", () => {
    expect(similarityScore(fp(ZEROS), fp(ZEROS))).toBe(1);
    expect(similarityScore(fp(ONES), fp(ONES))).toBe(1);
  });

  it("score equals 1 - distance", () => {
    const a = fp([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const b = fp([0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0]);
    const d = similarityDistance(a, b);
    expect(similarityScore(a, b)).toBeCloseTo(1 - d, 12);
  });

  it("score stays within [0,1] for extreme inputs", () => {
    const s = similarityScore(fp(ZEROS), fp(ONES));
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

// ─── F & G — Identical vs different fingerprints ─────────────────────────────

describe("identical vs different fingerprints (F, G)", () => {
  it("identical fingerprints give maximal similarity (F)", () => {
    const v = [0.2, 0.4, 0.6, 0.8, 0.1, 0.3, 0.5, 0.7];
    expect(similarityScore(fp(v), fp(v))).toBe(1);
  });

  it("different fingerprints yield expected lower similarity (G)", () => {
    const s = similarityScore(fp([0, 0, 0, 0, 0, 0, 0, 0]), fp([1, 1, 1, 1, 1, 1, 1, 1]));
    expect(1 - s).toBeCloseTo(Math.sqrt(1.0), 12);
  });
});

// ─── M — Version incompatibility ─────────────────────────────────────────────

describe("version incompatibility (M)", () => {
  it("distance throws when versions differ", () => {
    const a = { similarityVersion: "similarity-v1", values: ZEROS };
    const b = { similarityVersion: "similarity-v2", values: ZEROS };
    expect(() => similarityDistance(a, b)).toThrow(/incompatible/);
  });

  it("distance throws for unsupported versions", () => {
    const a = { similarityVersion: "similarity-x", values: ZEROS };
    expect(() => similarityDistance(a, a)).toThrow(/unsupported/);
  });

  it("distance throws on length mismatch", () => {
    const a = fp([1, 2, 3]);
    const b = fp([1, 2, 3, 4]);
    expect(() => similarityDistance(a, b)).toThrow(/length mismatch/);
  });
});

// ─── Search: query exclusion, dedup, ordering, limit (H–L) ─────────────────

describe("findSimilar query semantics (H, I, J, K, L)", () => {
  const queryHash = "query-hash";
  const queryIdentity = makeContentIdentity(queryHash, "pcm-v1");
  const queryFp = computeSimilarityFingerprint(makeFeatures());

  it("H — the query is never its own result", () => {
    const records = [rec("samples/QQ", queryHash, ZEROS)];
    const out = findSimilar({
      contentIdentity: queryIdentity,
      fingerprint: queryFp,
      records,
    });
    expect(out).toEqual([]);
  });

  it("I — multiple sampleIds with the same identity appear once", () => {
    const records = [
      rec("samples/AAA", "hash-x", ZEROS, { name: "A" }),
      rec("samples/BBB", "hash-x", ZEROS, { name: "B" }),
    ];
    const out = findSimilar({
      contentIdentity: queryIdentity,
      fingerprint: queryFp,
      records,
    });
    expect(out).toHaveLength(1);
    expect(out[0].representativeSampleId).toBe("samples/AAA"); // lex smallest
  });

  it("J — exact duplicate (same contentHash) is not a similar result", () => {
    const records = [rec("samples/DUP", queryHash, ZEROS)];
    const out = findSimilar({
      contentIdentity: queryIdentity,
      fingerprint: queryFp,
      records,
    });
    expect(out).toEqual([]);
  });

  it("K — equal scores break deterministically by contentIdentityKey ASC", () => {
    const records = [
      rec("samples/B", "hash-b", ZEROS),
      rec("samples/A", "hash-a", ZEROS),
    ];
    const out = findSimilar({
      contentIdentity: queryIdentity,
      fingerprint: queryFp,
      records,
    });
    // Both have score 1 - d(ZEROS, ZEROS) which... actually the fingerprints
    // here are ZEROS for candidates and the queryFp for the query — scores
    // differ. Instead, make all candidate fingerprints identical to the query
    // so scores tie, then confirm the ASC tie-break. See next test.
    expect(out).toHaveLength(2);
    // deterministically ordered by key even without a guaranteed tie:
    const keys = out.map((r) => contentIdentityKey(r.contentIdentity));
    expect(keys[0]).toBe("pcm-v1:hash-a");
    expect(keys[1]).toBe("pcm-v1:hash-b");
  });

  it("K — deterministic tie-break: equal scores sort by key ASC", () => {
    // Query fingerprint equals ALL-ZEROS; candidates a & b both all-zeros →
    // identical scores → tie broken by contentIdentityKey.
    const records = [
      rec("samples/B", "hash-b", ZEROS),
      rec("samples/A", "hash-a", ZEROS),
    ];
    const out = findSimilar({
      contentIdentity: { contentHash: "query-hash", contentHashVersion: "pcm-v1" },
      fingerprint: fp(ZEROS),
      records,
    });
    expect(out).toHaveLength(2);
    expect(out[0].representativeSampleId).toBe("samples/A");
    expect(out[1].representativeSampleId).toBe("samples/B");
  });

  it("L — result limit applies (default 10)", () => {
    const records = Array.from({ length: 15 }, (_, i) =>
      rec(`samples/s${i}`, `hash-${i}`, [i * 0.01, 0, 0, 0, 0, 0, 0, 0]),
    );
    const out = findSimilar({
      contentIdentity: queryIdentity,
      fingerprint: queryFp,
      records,
    });
    expect(out.length).toBe(10);
  });

  it("L — custom limit of 5 / 20 respected; invalid falls back to default", () => {
    const records = Array.from({ length: 25 }, (_, i) =>
      rec(`samples/s${i}`, `hash-l${i}`, [i * 0.005, 0, 0, 0, 0, 0, 0, 0]),
    );
    expect(
      findSimilar({ contentIdentity: queryIdentity, fingerprint: queryFp, records, limit: 5 }).length,
    ).toBe(5);
    expect(
      findSimilar({ contentIdentity: queryIdentity, fingerprint: queryFp, records, limit: 20 }).length,
    ).toBe(20);
    expect(
      findSimilar({ contentIdentity: queryIdentity, fingerprint: queryFp, records, limit: 7 }).length,
    ).toBe(DEFAULT_SIMILAR_LIMIT);
  });

  it("L — sanitizeSimilarLimit clamps to allowed set", () => {
    expect(sanitizeSimilarLimit(5)).toBe(5);
    expect(sanitizeSimilarLimit(10)).toBe(10);
    expect(sanitizeSimilarLimit(20)).toBe(20);
    expect(sanitizeSimilarLimit(7)).toBe(DEFAULT_SIMILAR_LIMIT);
    expect(sanitizeSimilarLimit(undefined)).toBe(DEFAULT_SIMILAR_LIMIT);
    expect(SIMILAR_LIMITS).toEqual([5, 10, 20]);
  });

  it("search sorts by similarity descending", () => {
    const records = [
      rec("samples/far", "hash-far", ONES),   // very different from query
      rec("samples/near", "hash-near", ZEROS), // identical to a zero query won't tie with ONES
    ];
    // query is ZEROS-based → sample "near" (ZEROS) is most similar.
    const out = findSimilar({
      contentIdentity: { contentHash: "query-hash", contentHashVersion: "pcm-v1" },
      fingerprint: fp(ZEROS),
      records,
    });
    expect(out[0].representativeSampleId).toBe("samples/near");
    expect(out[1].representativeSampleId).toBe("samples/far");
  });

  it("records without a compatible fingerprint are skipped", () => {
    const records = [
      makeSample("samples/nofp", { contentHash: "hash-nofp" }), // no fingerprint
      rec("samples/withfp", "hash-withfp", ZEROS),
    ];
    const out = findSimilar({
      contentIdentity: queryIdentity,
      fingerprint: queryFp,
      records,
    });
    expect(out).toHaveLength(1);
    expect(out[0].representativeSampleId).toBe("samples/withfp");
  });

  it("incompatible similarityVersion records are never mixed in", () => {
    const records = [
      makeSample("samples/v2", {
        contentHash: "hash-v2",
        similarityFingerprint: {
          similarityVersion: "similarity-v2",
          values: ZEROS,
        } as unknown as SimilarityFingerprint,
      }),
      rec("samples/v1", "hash-v1", ZEROS),
    ];
    const out = findSimilar({
      contentIdentity: queryIdentity,
      fingerprint: queryFp,
      records,
    });
    expect(out).toHaveLength(1);
    expect(out[0].representativeSampleId).toBe("samples/v1");
  });

  it("non-analyzed records are excluded", () => {
    const records = [
      makeSample("samples/pending", {
        contentHash: "hash-pending",
        status: "pending",
        similarityFingerprint: fp(ZEROS),
      }),
    ];
    const out = findSimilar({
      contentIdentity: queryIdentity,
      fingerprint: queryFp,
      records,
    });
    expect(out).toEqual([]);
  });
});

// ─── N — No audio persistence / fingerprint is plain data ───────────────────

describe("fingerprint storage invariant (N)", () => {
  it("fingerprint + full record passes assertNoAudioBytes", () => {
    const record = rec("samples/safe", "hash-safe", [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    expect(() => assertNoAudioBytes(record)).not.toThrow();
    expect(() => assertNoAudioBytes(record.similarityFingerprint)).not.toThrow();
  });

  it("fingerprint is compact plain data (string + number[])", () => {
    const f = computeSimilarityFingerprint(makeFeatures());
    const json = JSON.stringify(f);
    expect(json.length).toBeLessThan(200);
    const parsed = JSON.parse(json) as SimilarityFingerprint;
    expect(parsed.values).toEqual(f.values);
    expect(parsed.similarityVersion).toBe(SIMILARITY_VERSION);
  });
});

// ─── Feature fixture wrappers for the fingerprint tests ─────────────────────

function kickFeatures(): AudioFeatures {
  return makeFeatures({
    duration: 0.3,
    transientDensity: 18,
    spectralCentroid: 180,
    spectralFlatness: 0.1,
    attack: 0.001,
  });
}

function hatFeatures(): AudioFeatures {
  return makeFeatures({
    duration: 0.2,
    transientDensity: 15,
    spectralCentroid: 9000,
    spectralFlatness: 0.7,
    attack: 0.001,
  });
}
