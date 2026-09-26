/**
 * Test fixtures for the 16F provider tests.
 *
 * Builds STRUCTURALLY VALID `GlobalPublishResult` objects. The map position is a
 * PERSISTED V2 analysis result (computed at analysis time from decoded audio),
 * so the fixture supplies a fixed in-range coordinate; it is NOT derived from
 * `AudioFeatures` (V2 consumers read the persisted position, never recompute).
 * Similarity fingerprint is still derived from the real `AudioFeatures` fixture
 * via the same pure authority the validator cross-checks against. Metadata
 * only; no audio bytes.
 */
import {
  type GlobalPublishResult,
  type GlobalAnalysisResult,
  type GlobalSoundCharacterKnowledge,
} from "../../../src/global/contract";
import { makeFeatures } from "../../../src/classify/test-helpers";
import { mapVersion } from "../../../src/map/mapPosition";
import { computeSimilarityFingerprint } from "../../../src/similarity/similarityFingerprint";
import {
  SOUND_CHARACTER_CODEC_VERSION,
  encodeSoundCharacterToBase64,
} from "../../../src/global/soundCharacterCodec";
import { SIMILARITY_ALGORITHM_VERSION } from "../../../src/analysis/similarityEngine";
import { SOUND_SPACE_ALGORITHM_VERSION } from "../../../src/analysis/soundSpaceProjector";
import { ANALYSIS_VERSION } from "../../../src/analysis/sampleAnalysisV2";
import { emptySoundCharacter, type SoundCharacter } from "../../../src/analysis/soundCharacter";

export interface ValidPublishOverrides {
  contentHash?: string;
  contentHashVersion?: string;
  sampleId?: string;
  primaryClass?: string;
  features?: ReturnType<typeof makeFeatures>;
  soundCharacterV2?: GlobalSoundCharacterKnowledge;
}

const HASH_64 = "a".repeat(64);

/** Build a V2.SC-v1 knowledge block consistent with the fixture features (0.4 s). */
export function makeV2Block(
  soundCharacter?: SoundCharacter,
): GlobalSoundCharacterKnowledge {
  const char = soundCharacter ?? {
    ...emptySoundCharacter(),
    brightness: 0.4,
    density: 0.6,
    transient: 0.5,
    duration: null,
    tonality: 0.7,
    noisiness: 0.2,
    dynamics: 0.3,
    complexity: 0.8,
  };
  return {
    codecVersion: SOUND_CHARACTER_CODEC_VERSION,
    packed: encodeSoundCharacterToBase64(char),
    analysisVersion: ANALYSIS_VERSION,
    similarityVersion: SIMILARITY_ALGORITHM_VERSION,
    soundSpaceVersion: SOUND_SPACE_ALGORITHM_VERSION,
    classificationVersion: "heuristic-v1",
    confidence: 0.9,
    durationMs: 400,
  };
}

/** Build a valid publish result that passes structural validation. */
export function makeValidPublish(
  overrides: ValidPublishOverrides = {},
): GlobalPublishResult {
  const features = overrides.features ?? makeFeatures();
  const contentIdentity = {
    contentHash: overrides.contentHash ?? HASH_64,
    contentHashVersion: overrides.contentHashVersion ?? "pcm-v1",
  };
  const similarity = computeSimilarityFingerprint(features);
  const analysis: GlobalAnalysisResult = {
    contentIdentity,
    classificationVersion: "heuristic-v1",
    primaryClass: overrides.primaryClass ?? "kick",
    confidence: 0.9,
    secondaryClasses: [{ class: "toms", confidence: 0.08 }],
    analysisVersion: "features-v1",
    analysisBuild: "build-16f-test",
    // V2 persisted map position (in-range analysis result).
    map: { mapVersion, x: 0.4, y: 0.6 },
    similarity,
    analysisSourceFormat: "wav",
    gatePassed: true,
    audioFeatures: features,
    ...(overrides.soundCharacterV2 ? { soundCharacterV2: overrides.soundCharacterV2 } : {}),
  };
  return {
    sampleId: overrides.sampleId ?? "samples/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    contentIdentity,
    analysis,
    features,
  };
}
