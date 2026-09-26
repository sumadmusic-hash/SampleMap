/**
 * STEP49 — One-Shot Classification & Map UI Product Verification (targeted tests).
 *
 * NOT a rewritten classifier, filter, or map. These tests pin the product-level
 * guarantees that the UI's CLASS filters behave coherently for real users:
 *
 *  - §9 / AC2  A drum-class filter can never surface a record via METADATA WORDS
 *              (nothing but the persisted classification decides filter
 *              membership) — a loop named/tagged "kick snare clap" is excluded
 *              from a kick/snare/drums filter.
 *  - §10D/AC6  STEP48 cross-family hardening holds at the SEARCH layer: a
 *              metadata-adopted musical/bass sample (no drum secondaries) is
 *              NOT included under drum filters; same-family samples still match
 *              via their documented secondary classes.
 *  - §10B/AC3  Class filters consume the AUTHORITATIVE persisted
 *              classification (primaryClass + secondaryClasses written by the
 *              analysis pipeline), never a recomputed UI-side classifier.
 *
 * Reuses the STUB index pattern from step47Integrity.test.ts. Nothing here
 * invents new filter semantics.
 */
import { describe, it, expect } from "vitest";
import type { SampleIndexRecord } from "./persistence/indexStore";
import { makeSample } from "./persistence/test-helpers";
import { SampleMapSearchEngine } from "./search/searchEngine";
import { classifyHier } from "./classify/hier/classify";
import { familyOfType } from "./classify/hier/evidence";
import { makeFeatures } from "./classify/test-helpers";
import type { AudioFeaturesV2 } from "./analysis/audioFeaturesV2";

const storeOf = (records: readonly SampleIndexRecord[]) => ({
  getAll: async (): Promise<SampleIndexRecord[]> => [...records],
});

const engine = (records: readonly SampleIndexRecord[]) =>
  new SampleMapSearchEngine(storeOf(records) as never);

const ids = (rows: Array<{ record: SampleIndexRecord }>): string[] =>
  rows.map((r) => r.record.sampleId);

// ---------------------------------------------------------------------------
// §9 / AC2 — class filters are driven by classification, never by metadata words
// ---------------------------------------------------------------------------

describe("STEP49 §9 — drum filters never fire on metadata words", () => {
  // A loop whose name/tags are full of drum words but whose AUTHORITATIVE
  // persisted classification is "other" (legacy loop surface) must stay out of
  // every drum filter.
  const loop = makeSample("samples/loop-sfx", {
    name: "Kick Snare Clap Hihat Loop",
    originalTags: ["kick", "snare", "clap", "hihat", "loop"],
    primaryClass: "other",
    secondaryClasses: [],
    confidence: 0.4,
  });
  // A musical record whose metadata happens to say "kick".
  const wordyBass = makeSample("samples/wordy-bass", {
    name: "Kick Bass 01",
    originalTags: ["snare", "kick"],
    primaryClass: "bass",
    secondaryClasses: [],
    confidence: 0.8,
  });

  it("a kick filter excludes a loop whose metadata only contains the word 'kick'", async () => {
    // Neither the loop (primaryClass "other") nor the wordy musical record
    // (primaryClass "bass") is a drum class — both must stay out of every drum
    // filter, regardless of the drum words in their name/tags.
    for (const classes of [["kick"], ["snare"], ["clap"], ["drums"]]) {
      const rows = await engine([loop, wordyBass]).search({ classes });
      expect(ids(rows), `classes=${classes.join(",")}`).toEqual([]);
    }
  });

  it("loop + hihat content never enters a hihat filter without a persisted hihat class", async () => {
    const rows = await engine([loop]).search({ classes: ["hihat"] });
    expect(rows).toEqual([]);
  });

  it("the same record IS returned under its persisted class (bass / other)", async () => {
    const bassRows = await engine([loop, wordyBass]).search({ classes: ["bass"] });
    expect(ids(bassRows)).toEqual(["samples/wordy-bass"]);
    const otherRows = await engine([loop, wordyBass]).search({ classes: ["other"] });
    expect(ids(otherRows)).toEqual(["samples/loop-sfx"]);
  });
});

// ---------------------------------------------------------------------------
// §10D / AC6 + §10B/AC3 — STEP48 cross-family integrity holds at the search
// layer; class filters consume the authoritative persisted classification.
// ---------------------------------------------------------------------------

describe("STEP49 §10D — STEP48 cross-family integrity at the search layer", () => {
  // Reuse the STEP48 cross-family fixture: acoustic drums + "bassline 808" name
  // -> TAG-SUPPORTED adoption to musical/bass with NO drum secondaries.
  const v2 = (o: Partial<AudioFeaturesV2> = {}): AudioFeaturesV2 => ({
    durationSec: 1.0, sampleRate: 44100, channels: 1, rms: 0.3, peak: 0.9,
    crestFactor: 3, transientStrength: null, zeroCrossingRate: 0.02,
    spectralCentroidHz: 1500, spectralSpreadHz: 2500, spectralRolloffHz: 7000,
    spectralFlatness: 0.5, spectralFlux: 0.4, spectralSlope: 0,
    attackTimeSec: 0.02, decayTimeSec: 0.05, pitchHz: null, pitchConfidence: null,
    harmonicity: null, inharmonicity: null, ...o,
  });
  const ultraShortDrum = makeFeatures({
    duration: 0.3, transientDensity: 12, spectralCentroid: 1800,
    spectralBandwidth: 2500, spectralRolloff: 6500, zeroCrossingRate: 0.1,
    spectralFlatness: 0.5, attack: 0.004, rms: 0.25, peak: 0.9,
  });
  const ultraShortDrumV2 = v2({
    durationSec: 0.3, transientStrength: 4, spectralCentroidHz: 1800,
    spectralSpreadHz: 2500, spectralFlatness: 0.5, spectralFlux: 1.0,
    zeroCrossingRate: 0.1, attackTimeSec: 0.004, decayTimeSec: 0.05,
  });
  const adopted = classifyHier({
    features: ultraShortDrum,
    meta: { kind: "one-shot", durationSeconds: 0.3, name: "bassline 808", tags: [] },
    v2: ultraShortDrumV2,
  });

  it("fixture sanity: adopted sample is musical/bass with zero secondaries (STEP48)", () => {
    expect(adopted.hier.family).toBe("musical");
    expect(adopted.surface.primaryClass).toBe("bass");
    expect(adopted.surface.secondaryClasses).toEqual([]);
    for (const [family, type] of [[adopted.hier.family, adopted.hier.type]] as const) {
      expect(familyOfType(type)).toBe(family);
    }
  });

  it("a musical/bass record adopted from drum audio is absent from drum filters (no stale secondaries)", async () => {
    const rec = makeSample("samples/adopted-bass", {
      name: "bassline 808",
      primaryClass: "bass",
      secondaryClasses: adopted.surface.secondaryClasses,
      confidence: adopted.surface.confidence,
    });
    for (const classes of [["kick"], ["snare"], ["clap"], ["tom"], ["drums"]]) {
      const rows = await engine([rec]).search({ classes });
      expect(rows, `classes=${classes.join(",")}`).toEqual([]);
    }
    const bassRows = await engine([rec]).search({ classes: ["bass"] });
    expect(ids(bassRows)).toEqual(["samples/adopted-bass"]);
  });

  it("same-family records still match via their documented secondary classes", async () => {
    const snareWithClap = makeSample("samples/snare-2", {
      name: "Snare 02",
      primaryClass: "snare",
      secondaryClasses: [{ class: "clap", confidence: 0.28 }],
      confidence: 0.71,
    });
    const clapRows = await engine([snareWithClap]).search({ classes: ["clap"] });
    expect(ids(clapRows)).toEqual(["samples/snare-2"]);
    const kickRows = await engine([snareWithClap]).search({ classes: ["kick"] });
    expect(kickRows).toEqual([]);
  });

  it("class filters read the persisted record — no UI-side classification exists", async () => {
    // The engine is constructed around a bare { getAll } stub: it has no
    // classifier, no audio, no features. If a UI-side classifier had been
    // consulted, this would be impossible to satisfy.
    const rec = makeSample("samples/kick-909", { primaryClass: "kick", secondaryClasses: [] });
    const rows = await engine([rec]).search({ classes: ["kick"] });
    expect(ids(rows)).toEqual(["samples/kick-909"]);
  });
});