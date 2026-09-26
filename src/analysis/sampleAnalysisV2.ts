/**
 * V2 (STEP 20) `SampleAnalysisV2` — the canonical V2 analysis result.
 *
 * Aggregate of the RAW FEATURES, the PERCEPTUAL SOUND CHARACTER, its QUALITY
 * and the analysis version. It is metadata-only (numbers, strings, plain
 * arrays) — NEVER audio bytes — so it can round-trip through IndexedDB, JSON
 * and (as part of a worker response) structured clone.
 *
 * Persistence contract: `SampleIndexRecord.analysisV2?` is OPTIONAL and
 * ADDITIVE — V1 records without a V2 analysis stay fully valid, are never
 * auto-migrated and never force a re-analysis.
 */
import type { AudioFeaturesV2 } from "./audioFeaturesV2";
import { validateAudioFeaturesV2 } from "./audioFeaturesV2";
import type { SoundCharacter } from "./soundCharacter";
import { validateSoundCharacter } from "./soundCharacter";
import type { SoundCharacterQuality } from "./soundCharacter";

/** Version every V2 analysis result pins (independent of map/similarity versions). */
export const ANALYSIS_VERSION = "2.0.0" as const;

export interface SampleAnalysisV2 {
  analysisVersion: typeof ANALYSIS_VERSION;
  features: AudioFeaturesV2;
  soundCharacter: SoundCharacter;
  quality: SoundCharacterQuality;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Structural + numeric validation of a complete V2 analysis record. */
export function validateSampleAnalysisV2(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { valid: false, errors: ["SampleAnalysisV2: not an object"] };
  }
  const a = value as Record<string, unknown>;
  if (a.analysisVersion !== ANALYSIS_VERSION) {
    errors.push(`SampleAnalysisV2.analysisVersion: expected "${ANALYSIS_VERSION}"`);
  }
  const featureCheck = validateAudioFeaturesV2(a.features);
  errors.push(...featureCheck.errors.map((e) => `SampleAnalysisV2.${e}`));
  const charCheck = validateSoundCharacter(a.soundCharacter);
  errors.push(...charCheck.errors.map((e) => `SampleAnalysisV2.${e}`));
  const q = a.quality as Record<string, unknown> | undefined;
  if (typeof q !== "object" || q === null || Array.isArray(q)) {
    errors.push("SampleAnalysisV2.quality: expected an object");
  } else {
    if (typeof q.overall !== "number" || !Number.isFinite(q.overall) || q.overall < 0 || q.overall > 1) {
      errors.push("SampleAnalysisV2.quality.overall: must be a finite number in [0,1]");
    }
    if (
      typeof q.featureCoverage !== "number" ||
      !Number.isFinite(q.featureCoverage) ||
      q.featureCoverage < 0 ||
      q.featureCoverage > 1
    ) {
      errors.push("SampleAnalysisV2.quality.featureCoverage: must be a finite number in [0,1]");
    }
  }
  return { valid: errors.length === 0, errors };
}

export function isWellFormedSampleAnalysisV2(value: unknown): value is SampleAnalysisV2 {
  return validateSampleAnalysisV2(value).valid;
}

/**
 * Lossless JSON round-trip serialization (numbers, nulls, quality, version,
 * SoundCharacter, weights). No Float32Array, no audio bytes.
 */
export function serializeSampleAnalysisV2(analysis: SampleAnalysisV2): string {
  return JSON.stringify(analysis);
}

/** Parse + structurally validate a serialized V2 analysis. `undefined` when invalid. */
export function parseSampleAnalysisV2(json: string): SampleAnalysisV2 | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    return isWellFormedSampleAnalysisV2(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}