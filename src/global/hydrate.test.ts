import { describe, it, expect } from "vitest";
import type { GlobalAnalysisResult, GlobalSoundCharacterKnowledge } from "./contract";
import { buildRecordFromGlobalAnalysis } from "./hydrate";
import { makeContentIdentity } from "../identity/audioContentIdentity";
import { makeFeatures } from "../classify/test-helpers";
import { computeSimilarityFingerprint } from "../similarity/similarityFingerprint";
import { mapVersion } from "../map/mapPosition";
import {
  SOUND_CHARACTER_CODEC_VERSION,
  encodeSoundCharacterToBase64,
} from "./soundCharacterCodec";
import { SIMILARITY_ALGORITHM_VERSION } from "../analysis/similarityEngine";
import { SOUND_SPACE_ALGORITHM_VERSION } from "../analysis/soundSpaceProjector";
import { emptySoundCharacter, type SoundCharacter } from "../analysis/soundCharacter";
import { ANALYSIS_VERSION } from "../analysis/sampleAnalysisV2";
import { rankSimilar, extractCandidateCharacter } from "../analysis/similarityRanking";
import { assertNoAudioBytes } from "../persistence/indexStore";

const SAMPLE_A = "samples/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SAMPLE_B = "samples/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOW = "2026-01-01T00:00:00.000Z";

function charNear(): SoundCharacter {
  return {
    ...emptySoundCharacter(),
    brightness: 0.4,
    density: 0.6,
    transient: 0.5,
    duration: null, // null from analysis-time → stays null through pack/hydrate
    tonality: 0.7,
    noisiness: 0.2,
    dynamics: 0.3,
    complexity: 0.8,
  };
}

/** A different but overlapping character (shared dims except duration). */
function charOther(): SoundCharacter {
  return {
    ...emptySoundCharacter(),
    brightness: 0.42,
    density: 0.58,
    transient: 0.51,
    duration: null,
    tonality: 0.71,
    noisiness: 0.19,
    dynamics: 0.31,
    complexity: 0.79,
  };
}

function makeBlock(char: SoundCharacter, overrides: Partial<GlobalSoundCharacterKnowledge> = {}): GlobalSoundCharacterKnowledge {
  return {
    codecVersion: SOUND_CHARACTER_CODEC_VERSION,
    packed: encodeSoundCharacterToBase64(char),
    analysisVersion: ANALYSIS_VERSION,
    similarityVersion: SIMILARITY_ALGORITHM_VERSION,
    soundSpaceVersion: SOUND_SPACE_ALGORITHM_VERSION,
    classificationVersion: "heuristic-v1",
    confidence: 0.9,
    durationMs: 400, // matches makeFeatures().duration = 0.4s
    ...overrides,
  };
}

function makeGlobal(
  hash: string,
  block?: GlobalSoundCharacterKnowledge,
  overrides: Partial<GlobalAnalysisResult> = {},
): GlobalAnalysisResult {
  const features = makeFeatures();
  return {
    contentIdentity: makeContentIdentity(hash, "pcm-v1"),
    classificationVersion: "heuristic-v1",
    primaryClass: "kick",
    confidence: 0.9,
    secondaryClasses: [{ class: "toms", confidence: 0.08 }],
    analysisVersion: "features-v1",
    analysisBuild: "build-v1",
    map: { mapVersion, x: 0.4, y: 0.6 },
    similarity: computeSimilarityFingerprint(features),
    ...(block ? { soundCharacterV2: block } : {}),
    analysisSourceFormat: "wav",
    gatePassed: true,
    audioFeatures: features,
    ...overrides,
  };
}

describe("STEP41 — hydrate the compact V2 knowledge into a local record", () => {
  it("hydrates a valid V2 block into a Find-Similar-ready analysisV2", () => {
    const global = makeGlobal(HASH_A, makeBlock(charNear()));
    const { record, resolved } = buildRecordFromGlobalAnalysis(
      SAMPLE_A,
      undefined,
      global,
      "build-hydrate",
      () => NOW,
    );

    expect(resolved).toBe(false);
    expect(record.analysisV2).toBeDefined();
    const v2 = record.analysisV2!;
    expect(v2.analysisVersion).toBe(ANALYSIS_VERSION);
    expect(v2.soundCharacter.brightness).toBeCloseTo(0.4, 4);
    expect(v2.soundCharacter.duration).toBeNull(); // null survived pack/hydrate
    expect(record.analysisV2!.quality.featureCoverage).toBe(7 / 8);
    // The compact duration (ms) is the authority for the hydrated features.
    expect(v2.features.durationSec).toBe(0.4);
    expect(record.analysisV2!.quality.overall).toBeGreaterThan(0);
  });

  it("hydrates WITHOUT analysisV2 when the global block is absent (V1-style reuse)", () => {
    const global = makeGlobal(HASH_A);
    const { record } = buildRecordFromGlobalAnalysis(SAMPLE_A, undefined, global, "b", () => NOW);
    expect(record.analysisV2).toBeUndefined();
  });

  it("hydrates WITHOUT analysisV2 when the block is corrupt (never fabricated)", () => {
    const global = makeGlobal(HASH_A, makeBlock(charNear(), { packed: "!!!bad!!!" }));
    const { record } = buildRecordFromGlobalAnalysis(SAMPLE_A, undefined, global, "b", () => NOW);
    expect(record.analysisV2).toBeUndefined();
  });

  it("stays metadata-only: assertNoAudioBytes passes on the hydrated record", () => {
    const global = makeGlobal(HASH_A, makeBlock(charNear()));
    const { record } = buildRecordFromGlobalAnalysis(SAMPLE_A, undefined, global, "b", () => NOW);
    expect.assertions(1);
    expect(() => assertNoAudioBytes(record)).not.toThrow();
  });

  it("preserves STEP38 semantic classification + existing reuse fields", () => {
    const global = makeGlobal(HASH_A, makeBlock(charNear()));
    const { record } = buildRecordFromGlobalAnalysis(SAMPLE_A, undefined, global, "b", () => NOW);
    expect(record.semanticClassification).toBeDefined();
    expect(record.mapPosition).toEqual({ x: 0.4, y: 0.6 });
    expect(record.contentHash).toBe(HASH_A);
    expect(record.similarityFingerprint).toBeDefined();
  });
});

describe("STEP41 — Find Similar works on hydrated records (no re-analysis)", () => {
  it("rankSimilar scores a hydrated candidate against a hydrated query", () => {
    const nearBlock = makeBlock(charNear());
    const otherBlock = makeBlock(charOther());
    const recA = buildRecordFromGlobalAnalysis(SAMPLE_A, undefined, makeGlobal(HASH_A, nearBlock), "b", () => NOW).record;
    const recB = buildRecordFromGlobalAnalysis(SAMPLE_B, undefined, makeGlobal(HASH_B, otherBlock), "b", () => NOW).record;

    const ranked = rankSimilar(recA, [recB]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].sampleId).toBe(SAMPLE_B);
    expect(ranked[0].similarity).toBeGreaterThan(0.9); // near vectors are near
    expect(ranked[0].sharedDimensionCount).toBe(7); // duration null on both sides
    expect(ranked[0].distance).toBeCloseTo(1 - ranked[0].similarity, 9);
  });

  it("self is excluded by default (query record not ranked)", () => {
    const recA = buildRecordFromGlobalAnalysis(SAMPLE_A, undefined, makeGlobal(HASH_A, makeBlock(charNear())), "b", () => NOW).record;
    expect(rankSimilar(recA, [recA])).toEqual([]);
  });

  it("an unsupported/absent block is NOT rankable (version gate at the engine)", () => {
    const recA = buildRecordFromGlobalAnalysis(SAMPLE_A, undefined, makeGlobal(HASH_A, makeBlock(charNear())), "b", () => NOW).record;
    const recLegacy = buildRecordFromGlobalAnalysis(SAMPLE_B, undefined, makeGlobal(HASH_B), "b", () => NOW).record;
    // extractCandidateCharacter returns undefined for a legacy record.
    expect(extractCandidateCharacter(recLegacy)).toBeUndefined();
    expect(rankSimilar(recA, [recLegacy])).toEqual([]);
  });

  it("a globally-reused record ranks identically to its locally-analyzed twin", () => {
    // Hydration must produce the SAME character the packer consumed, so
    // similarity against a locally-analyzed clone is ~1 (within 1 LSB/slot).
    const near = charNear();
    const hydrated = buildRecordFromGlobalAnalysis(
      SAMPLE_A,
      undefined,
      makeGlobal(HASH_A, makeBlock(near)),
      "b",
      () => NOW,
    ).record;
    const localTwin: typeof hydrated = {
      ...hydrated,
      sampleId: SAMPLE_B,
      analysisV2: {
        analysisVersion: ANALYSIS_VERSION,
        features: hydrated.analysisV2!.features,
        soundCharacter: near,
        quality: hydrated.analysisV2!.quality,
      },
    };
    const ranked = rankSimilar(hydrated, [localTwin]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].similarity).toBeGreaterThan(0.999);
  });
});