/**
 * STEP47 — One-Shot Classification Product & Data Integrity Audit (targeted tests).
 *
 * AUDIT-FIRST: nothing here tunes accuracy, adds rules, or changes production
 * behavior. These tests pin the PRODUCT/DATA invariants verified during the
 * STEP47 audit so future drift is caught. Each group maps to report sections:
 *   A. structure & duration bands (§4)     B. hierarchy coherence (§5/§6)
 *   C. metadata never classification (§7)  D. acoustic-only coordinates (§8/§9)
 *   E. popularity not a filter (§10)       F. persistence no-audio-bytes (§12)
 *   G. ambiguity honesty contract (§11)
 */
import { describe, it, expect } from "vitest";
import type { AudioFeatures, IndexStore, SampleIndexRecord } from "./persistence/indexStore";
import { assertNoAudioBytes } from "./persistence/indexStore";
import type { AudioFeaturesV2 } from "./analysis/audioFeaturesV2";
import { ALL_CLASSES } from "./classify/taxonomy";
import { classifyHier } from "./classify/hier/classify";
import { classifyStructure } from "./classify/hier/structure";
import {
  FAMILY_TYPES,
  HIER_CLASSIFICATION_VERSION,
  UNKNOWN_TYPE,
  type HierClassification,
  type SoundFamily,
} from "./classify/hier/types";
import { familyOfType } from "./classify/hier/evidence";
import { computeAnalysisEligibility } from "./analysis/eligibility";
import { computePosition, flatnessToX, centroidToY, mapVersion } from "./map/mapPosition";
import type { DecodedAudio } from "./audio/decodedAudio";
import { SampleMapSearchEngine } from "./search/searchEngine";
import { makeFeatures, kickFeatures, bassFeatures, noiseFeatures } from "./classify/test-helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function v2(overrides: Partial<AudioFeaturesV2> = {}): AudioFeaturesV2 {
  return {
    durationSec: 1.0,
    sampleRate: 44100,
    channels: 1,
    rms: 0.3,
    peak: 0.9,
    crestFactor: 3,
    transientStrength: null,
    zeroCrossingRate: 0.02,
    spectralCentroidHz: 1500,
    spectralSpreadHz: 2500,
    spectralRolloffHz: 7000,
    spectralFlatness: 0.5,
    spectralFlux: 0.4,
    spectralSlope: 0,
    attackTimeSec: 0.02,
    decayTimeSec: 0.05,
    pitchHz: null,
    pitchConfidence: null,
    harmonicity: null,
    inharmonicity: null,
    ...overrides,
  };
}

const kickV2 = v2({
  durationSec: 0.3,
  transientStrength: 6,
  zeroCrossingRate: 0.01,
  spectralCentroidHz: 140,
  spectralSpreadHz: 220,
  spectralFlatness: 0.12,
  spectralFlux: 1.2,
  attackTimeSec: 0.001,
  decayTimeSec: 0.1,
});

const voiceV2 = v2({
  durationSec: 1.0,
  pitchHz: 300,
  pitchConfidence: 0.9,
  harmonicity: 0.7,
  spectralCentroidHz: 900,
  spectralFlatness: 0.5,
  attackTimeSec: 0.05,
});

const fxV2 = v2({
  durationSec: 2.0,
  transientStrength: 8,
  spectralCentroidHz: 5200,
  spectralSpreadHz: 6000,
  spectralFlatness: 0.8,
  spectralFlux: 1.5,
  inharmonicity: 0.8,
  attackTimeSec: 0.02,
});

const weakPitchV2 = v2({
  durationSec: 1.6,
  transientStrength: 0.1,
  crestFactor: 2,
  spectralCentroidHz: 900,
  spectralSpreadHz: 2000,
  spectralFlatness: 0.38,
  spectralFlux: 0.2,
  attackTimeSec: 0.05,
  decayTimeSec: 0.3,
  pitchHz: 300,
  pitchConfidence: 0.4,
  harmonicity: 0.4,
});

/** Ultra-short ambiguous drum hit (≤0.35s, sub-decisive subtype margin). */
const ultraShortDrum = (): AudioFeatures =>
  makeFeatures({
    duration: 0.3,
    transientDensity: 12,
    spectralCentroid: 1800,
    spectralBandwidth: 2500,
    spectralRolloff: 6500,
    zeroCrossingRate: 0.1,
    spectralFlatness: 0.5,
    attack: 0.004,
    rms: 0.25,
    peak: 0.9,
  });

const ultraShortDrumV2 = v2({
  durationSec: 0.3,
  transientStrength: 4,
  spectralCentroidHz: 1800,
  spectralSpreadHz: 2500,
  spectralFlatness: 0.5,
  spectralFlux: 1.0,
  zeroCrossingRate: 0.1,
  attackTimeSec: 0.004,
  decayTimeSec: 0.05,
});

function run(
  name: string,
  features: AudioFeatures,
  duration: number,
  v2z?: AudioFeaturesV2,
  tags: readonly string[] = [],
): ReturnType<typeof classifyHier> {
  return classifyHier({
    features,
    meta: { kind: "one-shot", durationSeconds: duration, name, tags },
    v2: v2z,
  });
}

// ---------------------------------------------------------------------------
// A. Structure & duration bands (§4)
// ---------------------------------------------------------------------------

describe("STEP47 §4 — structure identity: authoritative kind, duration never flips kind", () => {
  it("covers the audit duration bands without hidden threshold drift", () => {
    // band ≤0.35 / 0.35–0.5 / 0.5–0.6 / >0.6 / >2.5
    for (const d of [0.2, 0.45, 0.55, 0.65, 2.6]) {
      expect(classifyStructure({ kind: "one-shot", durationSeconds: d })).toBe("one-shot");
    }
    // sustained-phrase only above the explicit 4s rule
    expect(classifyStructure({ kind: "one-shot", durationSeconds: 4.0 })).toBe("one-shot");
    expect(classifyStructure({ kind: "one-shot", durationSeconds: 4.1 })).toBe("sustained-phrase");
  });

  it("a loop stays a loop even shorter than 2.5s (old duration>2.5 race removed)", () => {
    expect(classifyStructure({ kind: "loop", durationSeconds: 1.5 })).toBe("loop");
    expect(classifyStructure({ kind: "loop", durationSeconds: 6.0 })).toBe("loop");
  });

  it("unknown kind defaults to one-shot", () => {
    expect(classifyStructure({ kind: "unknown", durationSeconds: 0.5 })).toBe("one-shot");
  });
});

// ---------------------------------------------------------------------------
// B. Hierarchy coherence (§5/§6)
// ---------------------------------------------------------------------------

describe("STEP47 §5 — hierarchy: family↔type coherence is guaranteed at runtime", () => {
  it("FAMILY_TYPES table is consistent with familyOfType", () => {
    for (const family of Object.keys(FAMILY_TYPES) as Exclude<SoundFamily, "unknown">[]) {
      for (const t of FAMILY_TYPES[family]) {
        expect(familyOfType(t)).toBe(family);
      }
    }
  });

  it("classifier outputs stay coherent across every family + the ambiguous/unknown edges", () => {
    const cases: Array<{ label: string; h: HierClassification }> = [
      { label: "kick anchor", h: run("kick 808", kickFeatures(), 0.3, kickV2).hier },
      { label: "bass anchor", h: run("deep sub", bassFeatures(), 2.0, undefined).hier },
      {
        label: "vocal anchor",
        h: run(
          "vocal chop",
          makeFeatures({ duration: 1.0, transientDensity: 2, spectralCentroid: 900, spectralFlatness: 0.5, attack: 0.05 }),
          1.0,
          voiceV2,
        ).hier,
      },
      {
        label: "fx anchor",
        h: run("riser", makeFeatures({ duration: 2.0, transientDensity: 8, spectralCentroid: 5200, spectralBandwidth: 6000, spectralFlatness: 0.8, attack: 0.02 }), 2.0, fxV2).hier,
      },
      { label: "noise bed anchor", h: run("hiss bed", noiseFeatures(), 2.0, undefined).hier },
      { label: "insufficient evidence", h: run("generic material", makeFeatures({ duration: 1.6, transientDensity: 1, spectralCentroid: 900, spectralBandwidth: 2000, spectralFlatness: 0.38, attack: 0.05, rms: 0.3, peak: 0.6 }), 1.6, weakPitchV2).hier },
      { label: "tag/name adoption path", h: run("bassline 808", ultraShortDrum(), 0.3, ultraShortDrumV2).hier },
    ];

    for (const { label, h } of cases) {
      const mismatch = h.type !== UNKNOWN_TYPE && familyOfType(h.type) !== h.family;
      expect(HIER_CLASSIFICATION_VERSION).toBe("hier-v1");
      expect(h.classificationVersion).toBe(HIER_CLASSIFICATION_VERSION);
      // Confidence stays within the decision-confidence bounds (cap 0.95 / floor 0.05).
      expect(h.confidence).toBeGreaterThanOrEqual(0.05);
      expect(h.confidence).toBeLessThanOrEqual(0.95);
      // Unknown family is the ONLY "other" producer; "other" is the ONLY
      // documented exception to familyOfType(type) === family.
      if (h.family === "unknown") expect(h.type).toBe(UNKNOWN_TYPE);
      expect(mismatch, `${label}: family=${h.family} type=${h.type}`).toBe(false);
    }
  });

  it("metadata adoption keeps family following the decided type (TAG-SUPPORTED path)", () => {
    const r = run("bassline 808", ultraShortDrum(), 0.3, ultraShortDrumV2);
    expect(r.hier.reconciliation.status).toBe("TAG-SUPPORTED");
    expect(r.hier.type).toBe("bass");
    expect(r.hier.family).toBe("musical");
    expect(familyOfType(r.hier.type)).toBe(r.hier.family);
  });

  it("surfaces only the legacy ClassId vocabulary (SC11) — search groups unaffected", () => {
    const r = run("kick 808", kickFeatures(), 0.3, kickV2);
    expect(ALL_CLASSES).toContain(r.surface.primaryClass);
  });

  it("is deterministic (identical audio+meta ⇒ identical hier)", () => {
    const a = run("kick 808", kickFeatures(), 0.3, kickV2);
    const b = run("kick 808", kickFeatures(), 0.3, kickV2);
    expect(b.hier).toEqual(a.hier);
    expect(b.surface).toEqual(a.surface);
  });
});

// ---------------------------------------------------------------------------
// C/G. Metadata never classification + ambiguity honesty (§7/§11)
// ---------------------------------------------------------------------------

describe("STEP47 §7/§11 — metadata is never acoustic truth; ambiguity is honest", () => {
  it("an 'other' unknown result is the honest 'insufficient acoustic evidence' contract", () => {
    const r = run("generic material", makeFeatures({ duration: 1.6, transientDensity: 1, spectralCentroid: 900, spectralBandwidth: 2000, spectralFlatness: 0.38, attack: 0.05, rms: 0.3, peak: 0.6 }), 1.6, weakPitchV2);
    expect(r.hier.family).toBe("unknown");
    expect(r.hier.type).toBe(UNKNOWN_TYPE);
    expect(r.hier.ambiguous).toBe(true);
    expect(r.surface.primaryClass).toBe(UNKNOWN_TYPE);
  });

  it("still fires a classification (reconciliation 'UNKNOWN' stays a record), never blocks the pipeline", () => {
    const r = run("generic material", makeFeatures({ duration: 1.6, transientDensity: 1, spectralCentroid: 900, spectralBandwidth: 2000, spectralFlatness: 0.38, attack: 0.05, rms: 0.3, peak: 0.6 }), 1.6, weakPitchV2);
    expect(r.hier.reconciliation.status).toBe("UNKNOWN");
    expect(r.hier.reconciliation.winningSource).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// D. Acoustic-only coordinates (§8/§9)
// ---------------------------------------------------------------------------

describe("STEP47 §8/§9 — map position & projections are acoustic-only", () => {
  const tone = (sec: number): Float32Array => {
    const n = Math.floor(sec * 44100);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
    return out;
  };
  const lcgNoise = (sec: number): Float32Array => {
    const n = Math.floor(sec * 44100);
    const out = new Float32Array(n);
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) % 2147483648;
      out[i] = (s / 1073741824) - 1;
    }
    return out;
  };
  const audio = (mono: Float32Array): DecodedAudio => ({
    sampleRate: 44100,
    channels: 1,
    mono,
    durationSeconds: mono.length / 44100,
  });

  it("map-v2 is the pinned position version", () => {
    expect(mapVersion).toBe("map-v2");
  });

  it("coordinate functions are monotone acoustic axes", () => {
    // X: high flatness → low SNR → LOW x (noisy pole), low flatness → HIGH x (tonal pole).
    expect(flatnessToX(0.05)).toBeGreaterThan(flatnessToX(0.9));
    expect(centroidToY(120)).toBeLessThan(centroidToY(9000));
  });

  it("computePosition consumes ONLY features + decoded audio — tags/name/popularity are not inputs", () => {
    const f = makeFeatures({ spectralCentroid: 1000 });
    const tonal = computePosition(f, audio(tone(0.5)));
    const noisy = computePosition(f, audio(lcgNoise(0.5)));
    expect(tonal.x).toBeGreaterThan(noisy.x); // tonal → low flatness → high x
    const a = computePosition(f, audio(tone(0.5)));
    expect(a).toEqual(tonal); // deterministic; no corpus/metadata dependence
  });
});

// ---------------------------------------------------------------------------
// E. Popularity is not a search/filter input (§10)
// ---------------------------------------------------------------------------

describe("STEP47 §10 — filtering & relevance never use community counters", () => {
  function rec(
    sampleId: string,
    over: Partial<SampleIndexRecord> = {},
  ): SampleIndexRecord {
    return {
      sampleId,
      owner: "u",
      visibility: "public",
      name: sampleId,
      kind: "one-shot",
      originalTags: [],
      primaryClass: "kick",
      confidence: 0.9,
      secondaryClasses: [],
      classificationVersion: "heuristic-v1",
      audioFeatures: makeFeatures(),
      analysisVersion: "2.0.0",
      analyzedAt: "2026-01-01T00:00:00.000Z",
      analysisBuild: "audit",
      status: "analyzed",
      ...over,
    };
  }

  const stub = (records: SampleIndexRecord[]): IndexStore =>
    ({ getAll: async () => records }) as unknown as IndexStore;

  it("default status filter excludes non-analyzed rows", async () => {
    const engine = new SampleMapSearchEngine(
      stub([rec("a"), rec("b", { status: "gone" })]),
    );
    const res = await engine.search({ classes: ["kick"] });
    expect(res.map((r) => r.record.sampleId)).toEqual(["a"]);
  });

  it("class filter accepts group names and single classes (OR), matching primary or secondary", async () => {
    const engine = new SampleMapSearchEngine(
      stub([
        rec("kickA"),
        rec("snareB", { primaryClass: "snare" }),
        rec("otherC", { primaryClass: "other" }),
      ]),
    );
    const drums = await engine.search({ classes: ["drums"] });
    expect(drums.map((r) => r.record.sampleId).sort()).toEqual(["kickA", "snareB"]);
    const other = await engine.search({ classes: ["other"] });
    expect(other.map((r) => r.record.sampleId)).toEqual(["otherC"]);
  });

  it("numFavorites/numUsages never change match or relevance score", async () => {
    const plain = rec("a", { name: "kick 808" });
    const popular = rec("b", { name: "kick 808", numFavorites: 9999, numUsages: 77 });
    const engine = new SampleMapSearchEngine(stub([plain, popular]));
    const res = await engine.search({ text: "808", classes: ["kick"] });
    expect(res).toHaveLength(2);
    expect(res[0].score).toBe(res[1].score);
  });
});

// ---------------------------------------------------------------------------
// G. Eligibility: popularity is a gate-only signal (§3/§7)
// ---------------------------------------------------------------------------

describe("STEP47 §3/§7 — popularity signals drive ONLY the analysis gate", () => {
  it("reasons are stable and own-detection is never wrongly claimed", () => {
    expect(
      computeAnalysisEligibility({ owner: "u", authenticatedUserId: "u", numFavorites: 0, numUsages: 0 }).reason,
    ).toBe("own");
    expect(
      computeAnalysisEligibility({ owner: "v", authenticatedUserId: "u", numFavorites: 250, numUsages: 2000 }).reason,
    ).toBe("foreign-favorite-and-usage");
    expect(
      computeAnalysisEligibility({ owner: "v", authenticatedUserId: "u", numFavorites: 250, numUsages: 0 }).reason,
    ).toBe("foreign-favorite");
    expect(
      computeAnalysisEligibility({ owner: "v", authenticatedUserId: "u", numFavorites: 0, numUsages: 2000 }).reason,
    ).toBe("foreign-usage");
    expect(
      computeAnalysisEligibility({ owner: "v", authenticatedUserId: "u", numFavorites: 0, numUsages: 0 }).reason,
    ).toBe("foreign-no-signal");
    expect(
      computeAnalysisEligibility({ owner: "v", authenticatedUserId: undefined, numFavorites: 0, numUsages: 0 }).reason,
    ).toBe("identity-unavailable");
  });

  it("undefined counters are never coerced positive (eligibility needs a real signal)", () => {
    expect(
      computeAnalysisEligibility({ owner: "v", authenticatedUserId: "u", numFavorites: undefined, numUsages: undefined }).eligible,
    ).toBe(false);
    expect(
      computeAnalysisEligibility({ owner: "v", authenticatedUserId: undefined, numFavorites: 250, numUsages: 0 }).reason,
    ).toBe("foreign-favorite");
  });

  it("classification cannot observe community counters (they are not HierClassifyInput fields)", () => {
    // §7: popularity is NEVER an acoustic/classification/map input. Two runs of
    // identical audio+meta are structurally identical because popularity is
    // absent from the classifier contract; the eligibility decision above is
    // the ONLY place counters are read (gate-only).
    const a = run("kick 808", kickFeatures(), 0.3, kickV2);
    const b = run("kick 808", kickFeatures(), 0.3, kickV2);
    expect(b.hier).toEqual(a.hier);
  });
});

// ---------------------------------------------------------------------------
// F. Persistence: no audio bytes, metadata-only records (§12)
// ---------------------------------------------------------------------------

describe("STEP47 §12 — persistence & serialization invariants", () => {
  it("assertNoAudioBytes rejects byte containers and non-embedding typed arrays", () => {
    expect(() => assertNoAudioBytes({ bytes: new ArrayBuffer(4) })).toThrow(/prohibited/);
    expect(() => assertNoAudioBytes({ f64: new Float64Array(2) })).toThrow(/prohibited/);
    if (typeof Blob !== "undefined") {
      expect(() => assertNoAudioBytes({ blob: new Blob(["x"]) })).toThrow(/prohibited/);
    }
  });

  it("accepts the Float32Array embedding exception", () => {
    expect(() => assertNoAudioBytes({ embedding: new Float32Array(4) })).not.toThrow();
  });

  it("a full hier-v1 record (classifier output + additive fields) is metadata-only", () => {
    const kick = run("kick 808", kickFeatures(), 0.3, kickV2);
    const record = {
      sampleId: "s",
      owner: "u",
      primaryClass: kick.surface.primaryClass,
      confidence: kick.hier.confidence,
      secondaryClasses: kick.surface.secondaryClasses,
      classificationVersion: HIER_CLASSIFICATION_VERSION,
      hier: kick.hier,
      analysisV2: { features: kickV2, soundCharacter: {}, quality: {} },
      mapPosition: { x: 0.1, y: 0.9 },
      semanticClassification: {
        version: "semantic-v1",
        family: "kick",
        subtype: "kick",
        confidence: 0.9,
        source: "audio",
        conflict: false,
        tagEvidence: [],
      },
    };
    expect(() => assertNoAudioBytes(record)).not.toThrow();
  });
});