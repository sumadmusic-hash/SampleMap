/**
 * Global contract structural validation (Step 16A).
 *
 * These are pure, contract-level checks that make server-side validation
 * POSSIBLE from the data structure alone — they are NOT backend logic and do
 * NOT implement any provider. They reuse the existing authorities:
 *   - `assertNoAudioBytes` (indexStore) — the no-audio invariant.
 *   - `computeSimilarityFingerprint` (similarity) — the pure function that lets
 *     a validator cross-check the fingerprint from the submitted `features`
 *     WITHOUT audio.
 *
 * The map position is a PERSISTED V2 analysis result (STEP 16Q): it is NOT
 * recomputable from `features`, so validation checks it structurally (version
 * token present; x/y present, finite, in [0,1]) instead of re-deriving it.
 *
 * No duplicate hash/map/similarity/classification logic lives here.
 */
import { assertNoAudioBytes } from "../persistence/indexStore";
import { mapVersion } from "../map/mapPosition";
import {
  computeSimilarityFingerprint,
  SIMILARITY_VERSION,
} from "../similarity/similarityFingerprint";
import { isAnalysisSourceFormat } from "../audio/sourceFormat";
import { ALL_CLASSES } from "../classify/taxonomy";
import { SIMILARITY_ALGORITHM_VERSION } from "../analysis/similarityEngine";
import { SOUND_SPACE_ALGORITHM_VERSION } from "../analysis/soundSpaceProjector";
import { ANALYSIS_VERSION } from "../analysis/sampleAnalysisV2";
import { validateSoundCharacter } from "../analysis/soundCharacter";
import {
  SOUND_CHARACTER_CODEC_VERSION,
  decodeSoundCharacterPacked,
  base64ToPacked,
  PACKED_SOUND_CHARACTER_BYTES,
} from "./soundCharacterCodec";
import type {
  GlobalPublishResult,
  GlobalPublishBatch,
} from "./contract";

/** SHA-256 hex digest = 64 lowercase hex chars. */
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
/** Version-token: letters/digits/hyphens (e.g. "pcm-v1", "similarity-v2"). */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export interface GlobalValidationIssue {
  path: string;
  message: string;
}

function inTaggedNumberRange(
  v: number,
  lo: number,
  hi: number,
  finite = true,
): boolean {
  if (typeof v !== "number" || Number.isNaN(v)) return false;
  if (finite && !Number.isFinite(v)) return false;
  return v >= lo && v <= hi;
}

function isKnownClass(value: string): boolean {
  return (ALL_CLASSES as readonly string[]).includes(value);
}

/**
 * Validate a single publish result structurally. Throws on the presence of any
 * audio byte container (reuses `assertNoAudioBytes`); returns a list of
 * non-fatal structural issues (empty when valid).
 *
 * NOT a full backend validation — it checks shape/version/enum/range/consistency
 * that are derivable without audio.
 */
export function validatePublishResult(
  result: GlobalPublishResult,
): GlobalValidationIssue[] {
  // Absolute invariant: no audio bytes anywhere in the payload (throws).
  assertNoAudioBytes(result);

  const issues: GlobalValidationIssue[] = [];

  if (!result.sampleId || result.sampleId.length === 0) {
    issues.push({ path: "sampleId", message: "sampleId must be non-empty" });
  }
  // The top-level `contentIdentity` (sample_ref edge) must agree with the
  // canonical `analysis.contentIdentity` (single content-of-record).
  if (
    !sameContentIdentity(result.contentIdentity, result.analysis.contentIdentity)
  ) {
    issues.push({
      path: "contentIdentity",
      message: "publish contentIdentity disagrees with analysis.contentIdentity",
    });
  }
  const versionIssue = validateVersionFingerprints(
    result.contentIdentity.contentHashVersion,
    result.analysis,
  );
  issues.push(...versionIssue);

  // STEP41 — optional V2 knowledge block: structurally validated when present
  // (codec/version pins, packed-layout integrity, cross-field consistency).
  // Absent = additive no-op (a pre-V2 publish stays valid).
  const v2Knowledge = result.analysis.soundCharacterV2;
  if (v2Knowledge !== undefined) {
    issues.push(...validateSoundCharacterV2Knowledge(v2Knowledge, result));
  }

  // Derived-value cross-check WITHOUT audio: only the similarity fingerprint is
  // a pure function of features. The map position is a PERSISTED V2 analysis
  // result and is validated structurally (presence/range) in
  // `validateVersionFingerprints`; it is NOT recomputed from features here.
  const derivedFp = computeSimilarityFingerprint(result.features);
  if (result.analysis.similarity.similarityVersion === SIMILARITY_VERSION) {
    if (fingerprintEqual(derivedFp, result.analysis.similarity) === false) {
      issues.push({
        path: "analysis.similarity",
        message: "similarity fingerprint is inconsistent with the submitted features",
      });
    }
  }

  return issues;
}

function validateVersionFingerprints(
  contentHashVersion: string,
  analysis: GlobalPublishResult["analysis"],
): GlobalValidationIssue[] {
  const issues: GlobalValidationIssue[] = [];

  if (!VERSION_RE.test(contentHashVersion)) {
    issues.push({
      path: "contentIdentity.contentHashVersion",
      message: "contentHashVersion must be a version token",
    });
  }
  if (!CONTENT_HASH_RE.test(analysis.contentIdentity.contentHash)) {
    issues.push({
      path: "contentIdentity.contentHash",
      message: "contentHash must be a 64-char lowercase hex SHA-256",
    });
  }
  if (!VERSION_RE.test(analysis.analysisVersion)) {
    issues.push({
      path: "analysis.analysisVersion",
      message: "analysisVersion must be a version token",
    });
  }
  if (!VERSION_RE.test(analysis.analysisBuild)) {
    issues.push({
      path: "analysis.analysisBuild",
      message: "analysisBuild must be a version token",
    });
  }
  if (!VERSION_RE.test(analysis.classificationVersion)) {
    issues.push({
      path: "analysis.classificationVersion",
      message: "classificationVersion must be a version token",
    });
  }
  if (!VERSION_RE.test(analysis.map.mapVersion)) {
    issues.push({
      path: "analysis.map.mapVersion",
      message: "mapVersion must be a version token",
    });
  }
  if (!isAnalysisSourceFormat(analysis.analysisSourceFormat)) {
    issues.push({
      path: "analysis.analysisSourceFormat",
      message: "analysisSourceFormat must be one of wav|flac",
    });
  }
  if (analysis.gatePassed !== true) {
    issues.push({
      path: "analysis.gatePassed",
      message: "eligible global results must have gatePassed true",
    });
  }
  if (!isKnownClass(analysis.primaryClass)) {
    issues.push({
      path: "analysis.primaryClass",
      message: "primaryClass is not a known taxonomy class",
    });
  }
  if (!inTaggedNumberRange(analysis.confidence, 0, 1)) {
    issues.push({
      path: "analysis.confidence",
      message: "confidence must be in [0,1]",
    });
  }
  if (
    analysis.map.x === undefined ||
    !inTaggedNumberRange(analysis.map.x, 0, 1)
  ) {
    issues.push({
      path: "analysis.map.x",
      message: "map.x must be in [0,1]",
    });
  }
  if (
    analysis.map.y === undefined ||
    !inTaggedNumberRange(analysis.map.y, 0, 1)
  ) {
    issues.push({
      path: "analysis.map.y",
      message: "map.y must be in [0,1]",
    });
  }
  if (analysis.similarity.similarityVersion !== SIMILARITY_VERSION) {
    issues.push({
      path: "analysis.similarity.similarityVersion",
      message: `unsupported similarityVersion (supported: ${SIMILARITY_VERSION})`,
    });
  }

  return issues;
}

/** True when `a` is a valid publish batch (every item passes; no audio). */
export function isPublishBatchValid(batch: GlobalPublishBatch): boolean {
  return (
    Array.isArray(batch) &&
    batch.every((r) => validatePublishResult(r).length === 0)
  );
}

function sameContentIdentity(
  a: { contentHash: string; contentHashVersion: string },
  b: { contentHash: string; contentHashVersion: string },
): boolean {
  return (
    a.contentHash === b.contentHash &&
    a.contentHashVersion === b.contentHashVersion
  );
}

/** Tolerance for range checks (avoids false positives from FP arithmetic). */
function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

function fingerprintEqual(
  a: { similarityVersion: string; values: number[] },
  b: { similarityVersion: string; values: number[] },
): boolean {
  if (a.similarityVersion !== b.similarityVersion) return false;
  if (a.values.length !== b.values.length) return false;
  for (let i = 0; i < a.values.length; i++) {
    if (!close(a.values[i], b.values[i])) return false;
  }
  return true;
}

/**
 * The supported map version (single source of truth: map module).
 * In V2 the map position is a persisted analysis result (not a function of
 * `AudioFeatures`), so no feature-based `deriveMapPosition` is exposed.
 */
export { mapVersion };

/** The supported similarity version (single source of truth: similarity module). */
export { SIMILARITY_VERSION };

/**
 * Structural validation of a STEP41 V2 knowledge block. Returns issues when the
 * block is present but corrupt, mismatched, or inconsistent with the analysis
 * it travels with — rejects (never ignores) a declared-but-broken block so the
 * global index can never store malformed V2 knowledge. Additive: an absent
 * block contributes nothing.
 */
function validateSoundCharacterV2Knowledge(
  knowledge: import("./contract").GlobalSoundCharacterKnowledge,
  result: GlobalPublishResult,
): GlobalValidationIssue[] {
  const issues: GlobalValidationIssue[] = [];
  const base = "analysis.soundCharacterV2";

  if (knowledge.codecVersion !== SOUND_CHARACTER_CODEC_VERSION) {
    issues.push({
      path: `${base}.codecVersion`,
      message: `unsupported codecVersion (supported: ${SOUND_CHARACTER_CODEC_VERSION})`,
    });
  }

  const packed = base64ToPacked(knowledge.packed);
  if (!packed) {
    issues.push({
      path: `${base}.packed`,
      message: "packed must be valid base64",
    });
  } else {
    if (packed.byteLength !== PACKED_SOUND_CHARACTER_BYTES) {
      issues.push({
        path: `${base}.packed`,
        message: `packed must decode to ${PACKED_SOUND_CHARACTER_BYTES} bytes (V2.SC-v1)`,
      });
    }
    const char = decodeSoundCharacterPacked(packed);
    if (!char) {
      issues.push({
        path: `${base}.packed`,
        message: "packed does not decode to a SoundCharacter",
      });
    } else if (!validateSoundCharacter(char).valid) {
      issues.push({
        path: `${base}.packed`,
        message: "decoded SoundCharacter is structurally invalid",
      });
    }
  }

  if (knowledge.analysisVersion !== ANALYSIS_VERSION) {
    issues.push({
      path: `${base}.analysisVersion`,
      message: `unsupported V2 analysisVersion (supported: ${ANALYSIS_VERSION})`,
    });
  }
  if (knowledge.similarityVersion !== SIMILARITY_ALGORITHM_VERSION) {
    issues.push({
      path: `${base}.similarityVersion`,
      message: `unsupported V2 similarityVersion (supported: ${SIMILARITY_ALGORITHM_VERSION})`,
    });
  }
  if (knowledge.soundSpaceVersion !== SOUND_SPACE_ALGORITHM_VERSION) {
    issues.push({
      path: `${base}.soundSpaceVersion`,
      message: `unsupported soundSpaceVersion (supported: ${SOUND_SPACE_ALGORITHM_VERSION})`,
    });
  }
  if (knowledge.classificationVersion !== result.analysis.classificationVersion) {
    issues.push({
      path: `${base}.classificationVersion`,
      message: "block classificationVersion disagrees with analysis.classificationVersion",
    });
  }
  if (!close(knowledge.confidence, result.analysis.confidence)) {
    issues.push({
      path: `${base}.confidence`,
      message: "block confidence disagrees with analysis.confidence",
    });
  }
  if (
    !Number.isFinite(knowledge.durationMs) ||
    !Number.isInteger(knowledge.durationMs) ||
    knowledge.durationMs <= 0
  ) {
    issues.push({
      path: `${base}.durationMs`,
      message: "durationMs must be a positive integer",
    });
  } else {
    // Both describe the same lossless container: block durationMs (ms) must
    // match the V1 features `duration` (s) within 2 ms.
    const durMs = result.features.duration * 1000;
    if (Math.abs(durMs - knowledge.durationMs) > 2) {
      issues.push({
        path: `${base}.durationMs`,
        message: "block durationMs disagrees with features.duration",
      });
    }
  }

  return issues;
}
