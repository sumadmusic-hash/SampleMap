/**
 * Global Publish — Candidate & Eligibility (Step 16D).
 *
 * 16A/16C defined the READ side (`GlobalLookup`). 16D defines the WRITE side:
 * turning a locally produced analysis result into a publishable candidate
 * (`GlobalPublishResult`) that the publish queue can deduplicate, batch and
 * hand to an injected `GlobalSampleIndex.publishAnalysisResults(...)`.
 *
 * The candidate is DOMAIN-level and provider-agnostic. It is NOT a queue item
 * and NOT a batch; it is "this local result is allowed to be published".
 *
 * This file owns:
 *  - `GlobalPublishCandidate` — alias for the existing 16A transport shape
 *    (reuses, not duplicated).
 *  - `createPublishCandidate(record)` — thin adapter from the persisted
 *    `SampleIndexRecord` (the pipeline's output) into a candidate, WITHOUT
 *    re-analyzing audio and WITHOUT inventing data the local record does not
 *    carry.
 *  - `validatePublishCandidate(...)` — eligibility: delegates to the existing
 *    `validatePublishResult` (the single set of rules).
 *
 * Hard invariants (enforced here, mirroring the rest of Step 16):
 *  - NO audio bytes: candidate / queue item / batch / payload are audio-free.
 *    Reuses `assertNoAudioBytes` (the single existing authority).
 *  - No re-analysis: a publish never re-downloads/decodes audio; it only reads
 *    the already-persisted local analysis result.
 *  - Content identity = (contentHash, contentHashVersion), read verbatim from
 *    the local record — never reconstructed from features/map/similarity.
 *  - The local index is NEVER mutated by a publish (§28).
 */
import type { SampleIndexRecord } from "../persistence/indexStore";
import { assertNoAudioBytes } from "../persistence/indexStore";
import type { GlobalPublishResult } from "./contract";
import { validatePublishResult } from "./validation";
import { mapVersion } from "../map/mapPosition";
import {
  SOUND_CHARACTER_CODEC_VERSION,
  encodeSoundCharacterToBase64,
} from "./soundCharacterCodec";
import { SIMILARITY_ALGORITHM_VERSION } from "../analysis/similarityEngine";
import { SOUND_SPACE_ALGORITHM_VERSION } from "../analysis/soundSpaceProjector";

// ─────────────────────────────────────────────────────────────────────────────
// Publish Candidate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The write-side input: a locally produced, gate-passed analysis prepared for
 * global publication. Uses the same shape the 16A contract already consumes
 * via `GlobalPublishResult` — no parallel type is introduced.
 *
 * It carries ONLY metadata:
 *   - `sampleId`       → the `sample_ref`
 *   - `contentIdentity` → `(contentHash, contentHashVersion)`
 *   - `analysis`       → classification / map / similarity / versions / source format
 *   - `features`       → feature-derived quantities (for recomputation, never audio)
 *
 * NO `AudioBuffer`, `ArrayBuffer`, `Blob`, PCM, WAV/FLAC/MP3 bytes anywhere.
 */
export type GlobalPublishCandidate = GlobalPublishResult;

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of eligibility validation for a publish candidate.
 *
 * `ok: true`  → the candidate is structurally eligible to be queued/published.
 * `ok: false` → the candidate is NOT eligible; `issues` lists why (missing
 *               required global data, quality gate not passed, inconsistencies,
 *               or the presence of prohibited audio bytes → throws, see below).
 */
export type PublishEligibility =
  | { ok: true }
  | { ok: false; issues: string[] };

/**
 * Check whether a candidate may be published. Reuses the existing
 * `validatePublishResult` (16A) for all structural / version / derived-value /
 * no-audio checks, so there is exactly ONE set of rules.
 */
export function validatePublishCandidate(
  candidate: GlobalPublishCandidate,
): PublishEligibility {
  const issues = validatePublishResult(candidate).map((i) => i.message);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter from the local index record
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when `createPublishCandidate` is given an ineligible local record. */
export class PublishCandidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishCandidateError";
  }
}

/**
 * Build a publish candidate from the persisted local `SampleIndexRecord`
 * WITHOUT re-analyzing audio. This is the thin adapter the design invites: the
 * local pipeline already produced all data the global index needs.
 *
 * Required local fields (else throws `PublishCandidateError`, never publishes):
 *   - `status === "analyzed"` (only an analyzed local result is eligible)
 *   - `contentHash`, `contentHashVersion` (the authoritative content identity)
 *   - `analysisSourceFormat` (lossless container type)
 *   - `similarityFingerprint` (versioned fingerprint)
 *   - `mapPosition` (persisted V2 map position — a Missing-V2 record is not publishable)
 *   - classification fields (`primaryClass`, `confidence`, `secondaryClasses`,
 *     `classificationVersion`) + `audioFeatures`
 *
 * The V2 map position is a PERSISTED analysis result (STEP 16Q): it is read
 * verbatim, never recomputed from `audioFeatures`. This is the granted
 * exception to §26 ("recompute, not re-analyze") scoped to map position, whose
 * authoritative computation requires decoded audio (not available on publish).
 */
export function createPublishCandidate(
  record: SampleIndexRecord,
): GlobalPublishCandidate {
  assertNoAudioBytes(record);

  if (record.status !== "analyzed") {
    throw new PublishCandidateError(
      `local record ${record.sampleId} is ${record.status}; only analyzed records are publishable`,
    );
  }
  if (record.contentHash === undefined || record.contentHashVersion === undefined) {
    throw new PublishCandidateError(
      `local record ${record.sampleId} is missing content identity`,
    );
  }
  if (record.analysisSourceFormat === undefined) {
    throw new PublishCandidateError(
      `local record ${record.sampleId} is missing analysisSourceFormat`,
    );
  }
  if (record.similarityFingerprint === undefined) {
    throw new PublishCandidateError(
      `local record ${record.sampleId} is missing similarity fingerprint`,
    );
  }

  // V2 (STEP 16Q): the map position is a PERSISTED analysis result. Read it
  // verbatim — it is NEVER recomputed from audioFeatures (its authoritative
  // computation requires decoded audio, unavailable here). A record without a
  // persisted V2 position is a Missing-V2 state and is not publishable; there
  // is deliberately NO V1 fallback.
  if (record.mapPosition === undefined) {
    throw new PublishCandidateError(
      `local record ${record.sampleId} is missing a persisted V2 mapPosition (mapVersion ${mapVersion})`,
    );
  }
  const pos = record.mapPosition;

  const candidate: GlobalPublishCandidate = {
    sampleId: record.sampleId,
    contentIdentity: {
      contentHash: record.contentHash,
      contentHashVersion: record.contentHashVersion,
    },
    analysis: {
      contentIdentity: {
        contentHash: record.contentHash,
        contentHashVersion: record.contentHashVersion,
      },
      classificationVersion: record.classificationVersion,
      primaryClass: record.primaryClass,
      confidence: record.confidence,
      secondaryClasses: record.secondaryClasses,
      analysisVersion: record.analysisVersion,
      analysisBuild: record.analysisBuild,
      map: { mapVersion, x: pos.x, y: pos.y },
      similarity: record.similarityFingerprint,
      analysisSourceFormat: record.analysisSourceFormat,
      gatePassed: true,
      audioFeatures: record.audioFeatures,
    },
    features: record.audioFeatures,
  };

  // STEP41 — carry the compact canonical V2 knowledge (packed SoundCharacter)
  // when the local record has a V2 analysis. OPTIONAL + ADDITIVE: records
  // without `analysisV2` publish with the block omitted (an older V1-style
  // publish stays valid), and `validatePublishCandidate` below rejects a
  // broken block. The block pins its independent version dimensions and the
  // duration (ms) that must match `audioFeatures.duration`.
  if (record.analysisV2 !== undefined) {
    candidate.analysis.soundCharacterV2 = {
      codecVersion: SOUND_CHARACTER_CODEC_VERSION,
      packed: encodeSoundCharacterToBase64(record.analysisV2.soundCharacter),
      analysisVersion: record.analysisV2.analysisVersion,
      similarityVersion: SIMILARITY_ALGORITHM_VERSION,
      soundSpaceVersion: SOUND_SPACE_ALGORITHM_VERSION,
      classificationVersion: record.classificationVersion,
      confidence: record.confidence,
      durationMs: Math.round(record.audioFeatures.duration * 1000),
    };
  }

  const elig = validatePublishCandidate(candidate);
  if (!elig.ok) {
    throw new PublishCandidateError(
      `local record ${record.sampleId} is not publishable: ${elig.issues.join("; ")}`,
    );
  }
  return candidate;
}
