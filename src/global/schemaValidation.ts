/**
 * Global Record Schema — structural validation (Step 16B).
 *
 * Pure, schema-level checks for the stored records (`sample_ref`, `content`). It
 * reuses the no-audio authority (`assertNoAudioBytes`) but does NOT reimplement
 * audio validation. Without audio the schema cannot prove a `contentHash`
 * actually belongs to the Audiotool audio — that boundary is respected here.
 *
 * These checks are "what makes a record structurally valid", not backend logic.
 */
import { assertNoAudioBytes } from "../persistence/indexStore";
import {
  isSampleName,
  type AudiotoolSampleReference,
} from "../library/sampleRef";
import { isAnalysisSourceFormat } from "../audio/sourceFormat";
import { ALL_CLASSES } from "../classify/taxonomy";
import { SIMILARITY_VERSION } from "./schema";
import { contentIdentityKey } from "../identity/audioContentIdentity";
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
  GlobalSampleRefRecord,
  GlobalContentRecord,
} from "./schema";

export interface SchemaValidationIssue {
  path: string;
  message: string;
}

/** SHA-256 hex digest = 64 lowercase hex chars. */
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
/** Version-token: letters/digits/hyphens (e.g. "pcm-v1", "similarity-v2"). */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
/** ISO-8601-ish timestamp string. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function isValidContentHash(value: string): boolean {
  return CONTENT_HASH_RE.test(value);
}

export function isValidVersionToken(value: string): boolean {
  return VERSION_RE.test(value);
}

/** SampleId must be a well-formed `samples/{uuid}` Audiotool reference. */
export function isValidSampleId(value: string): value is AudiotoolSampleReference {
  return isSampleName(value);
}

function inRange(v: number, lo: number, hi: number): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
}

function isKnownClass(value: string): boolean {
  return (ALL_CLASSES as readonly string[]).includes(value);
}

function validateContentIdentity(
  ci: { contentHash: string; contentHashVersion: string },
  path: string,
  issues: SchemaValidationIssue[],
): void {
  if (!isValidContentHash(ci.contentHash)) {
    issues.push({
      path: `${path}.contentHash`,
      message: "contentHash must be a 64-char lowercase hex SHA-256",
    });
  }
  if (!isValidVersionToken(ci.contentHashVersion)) {
    issues.push({
      path: `${path}.contentHashVersion`,
      message: "contentHashVersion must be a version token",
    });
  }
}

/**
 * Validate a stored `sample_ref` record. Throws on any audio byte container.
 */
export function validateSampleRefRecord(
  ref: GlobalSampleRefRecord,
): SchemaValidationIssue[] {
  // Absolute invariant: no audio anywhere in the record (throws).
  assertNoAudioBytes(ref);

  const issues: SchemaValidationIssue[] = [];
  if (!isValidSampleId(ref.sampleId)) {
    issues.push({
      path: "sampleId",
      message: "sampleId must be a well-formed samples/{uuid} reference",
    });
  }
  validateContentIdentity(ref.contentIdentity, "contentIdentity", issues);
  if (!ISO_RE.test(ref.publishedAt)) {
    issues.push({
      path: "publishedAt",
      message: "publishedAt must be an ISO-8601 timestamp",
    });
  }
  return issues;
}

/**
 * Validate a stored `content` record. Throws on any audio byte container.
 */
export function validateContentRecord(
  record: GlobalContentRecord,
): SchemaValidationIssue[] {
  // Absolute invariant: no audio anywhere in the record (throws).
  assertNoAudioBytes(record);

  const issues: SchemaValidationIssue[] = [];

  validateContentIdentity(record.contentIdentity, "contentIdentity", issues);

  const a = record.analysis;
  // Version independence: no field may mutate the content identity.
  if (record.contentIdentity.contentHashVersion !== record.versions.contentHashVersion) {
    issues.push({
      path: "versions.contentHashVersion",
      message: "must match contentIdentity.contentHashVersion",
    });
  }
  if (record.analysis.classification.classificationVersion !== record.versions.classificationVersion) {
    issues.push({
      path: "versions.classificationVersion",
      message: "must match analysis.classificationVersion",
    });
  }
  if (a.analysisVersion !== record.versions.analysisVersion) {
    issues.push({
      path: "versions.analysisVersion",
      message: "must match analysis.analysisVersion",
    });
  }
  if (a.analysisBuild !== record.versions.analysisBuild) {
    issues.push({
      path: "versions.analysisBuild",
      message: "must match analysis.analysisBuild",
    });
  }
  if (a.map.mapVersion !== record.versions.mapVersion) {
    issues.push({
      path: "versions.mapVersion",
      message: "must match analysis.map.mapVersion",
    });
  }
  if (a.similarity.similarityVersion !== record.versions.similarityVersion) {
    issues.push({
      path: "versions.similarityVersion",
      message: "must match analysis.similarityVersion",
    });
  }
  if (!isValidVersionToken(record.versions.representativeVersion)) {
    issues.push({
      path: "versions.representativeVersion",
      message: "representativeVersion must be a version token",
    });
  }

  // Classification shape / range.
  if (!isKnownClass(a.classification.primaryClass)) {
    issues.push({
      path: "analysis.classification.primaryClass",
      message: "not a known taxonomy class",
    });
  }
  if (!inRange(a.classification.confidence, 0, 1)) {
    issues.push({
      path: "analysis.classification.confidence",
      message: "confidence must be in [0,1]",
    });
  }

  // Map: version + finite, bounded position.
  if (!isValidVersionToken(a.map.mapVersion)) {
    issues.push({
      path: "analysis.map.mapVersion",
      message: "mapVersion must be a version token",
    });
  }
  if (!inRange(a.map.position.x, 0, 1)) {
    issues.push({
      path: "analysis.map.position.x",
      message: "map.x must be in [0,1]",
    });
  }
  if (!inRange(a.map.position.y, 0, 1)) {
    issues.push({
      path: "analysis.map.position.y",
      message: "map.y must be in [0,1]",
    });
  }

  // Similarity: version + bounded fingerprint values.
  if (a.similarity.similarityVersion !== SIMILARITY_VERSION) {
    issues.push({
      path: "analysis.similarity.similarityVersion",
      message: `unsupported similarityVersion (supported: ${SIMILARITY_VERSION})`,
    });
  }
  if (!Array.isArray(a.similarity.values) || a.similarity.values.length === 0) {
    issues.push({
      path: "analysis.similarity.values",
      message: "similarity fingerprint must be a non-empty array",
    });
  } else if (!a.similarity.values.every((v) => inRange(v, 0, 1))) {
    issues.push({
      path: "analysis.similarity.values",
      message: "similarity fingerprint values must be in [0,1]",
    });
  }

  // Source format + gate.
  if (!isAnalysisSourceFormat(a.analysisSourceFormat)) {
    issues.push({
      path: "analysis.analysisSourceFormat",
      message: "analysisSourceFormat must be one of wav|flac",
    });
  }
  if (a.gatePassed !== true) {
    issues.push({
      path: "analysis.gatePassed",
      message: "eligible global results must have gatePassed true",
    });
  }

  // STEP41 — optional compact V2 knowledge block: structurally validated when
  // present (codec/version pins, packed-layout integrity, cross-field
  // consistency with the stored analysis). Absent = additive no-op.
  const v2Knowledge = a.soundCharacterV2;
  if (v2Knowledge !== undefined) {
    issues.push(...validateSoundCharacterV2Record(v2Knowledge, record));
  }

  // Provenance.
  if (!ISO_RE.test(record.firstPublishedAt)) {
    issues.push({
      path: "firstPublishedAt",
      message: "firstPublishedAt must be an ISO-8601 timestamp",
    });
  }
  if (record.updatedAt !== undefined && !ISO_RE.test(record.updatedAt)) {
    issues.push({
      path: "updatedAt",
      message: "updatedAt must be an ISO-8601 timestamp",
    });
  }
  if (record.fileHash !== undefined && !isValidContentHash(record.fileHash)) {
    issues.push({
      path: "fileHash",
      message: "fileHash must be a 64-char lowercase hex SHA-256",
    });
  }

  // No-op guard: the identity key must be consistent with its own fields.
  if (contentIdentityKey(record.contentIdentity) !==
      `${record.contentIdentity.contentHashVersion}:${record.contentIdentity.contentHash}`) {
    issues.push({
      path: "contentIdentity",
      message: "content identity key is inconsistent",
    });
  }

  return issues;
}

/**
 * Structural validation of a stored STEP41 V2 knowledge block against its
 * owning content record (mirrors the publish-path rule set). Additive: absent
 * blocks contribute nothing; present-but-broken blocks are flagged so a corrupt
 * row is visible to inspection rather than silently trusted.
 */
function validateSoundCharacterV2Record(
  knowledge: import("./contract").GlobalSoundCharacterKnowledge,
  record: GlobalContentRecord,
): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
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
    if (!char || !validateSoundCharacter(char).valid) {
      issues.push({
        path: `${base}.packed`,
        message: "packed does not decode to a valid SoundCharacter",
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
  if (knowledge.classificationVersion !== record.analysis.classification.classificationVersion) {
    issues.push({
      path: `${base}.classificationVersion`,
      message: "block classificationVersion disagrees with analysis.classification.classificationVersion",
    });
  }
  if (!inRange(knowledge.confidence, 0, 1)) {
    issues.push({
      path: `${base}.confidence`,
      message: "confidence must be in [0,1]",
    });
  } else if (knowledge.confidence !== record.analysis.classification.confidence) {
    issues.push({
      path: `${base}.confidence`,
      message: "block confidence disagrees with analysis.classification.confidence",
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
  }

  return issues;
}
