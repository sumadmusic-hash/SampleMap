/**
 * Global Record Schema (Step 16B) — the stored, serializable data model for the
 * global SampleMap index.
 *
 * 16A defined the *contract* (what operations are possible). 16B defines the
 * *record schema* (the concrete entities a backend stores for those operations).
 *
 * Central modelling (from STEP16_DESIGN §8):
 *
 *   sample_ref  ──(sampleId)──►  content  ──►  analysis (classification/map/similarity)
 *
 *   Audiotool Sample Reference  →  Audio Content Identity  →  versioned Analysis
 *
 * This is a *fachliches / serializable* record schema — deliberately NOT a SQL /
 * provider schema (no CREATE TABLE, no D1/Supabase/Neon migration). The concrete
 * database modelling comes later.
 *
 * Hard invariants:
 *  - backend-agnostic (no provider/infra terms)
 *  - JSON-serializable, portable data only (no DOM/audio/class-instance/Maps)
 *  - NO raw audio anywhere (assertNoAudioBytes is respected)
 *  - content identity = (contentHash, contentHashVersion); versions stay
 *    independent
 */
import type { AudioContentIdentity } from "../identity/audioContentIdentity";
import {
  contentIdentityKey,
  REPRESENTATIVE_VERSION,
  selectRepresentative,
} from "../identity/audioContentIdentity";
import type { AnalysisSourceFormat } from "../audio/sourceFormat";
import type {
  AudioFeatures,
  ClassId,
  SecondaryClass,
} from "../persistence/indexStore";
import type { SimilarityFingerprint } from "../similarity/similarityFingerprint";
import { SIMILARITY_VERSION } from "../similarity/similarityFingerprint";
import type { MapPosition } from "../map/mapPosition";
import { mapVersion } from "../map/mapPosition";
import type { GlobalSoundCharacterKnowledge } from "./contract";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS — supported versions (single sources of truth re-exported)
// ─────────────────────────────────────────────────────────────────────────────

/** The supported map projection version. */
export { mapVersion };
/** The supported similarity fingerprint version. */
export { SIMILARITY_VERSION };
/** The supported representative-selection version. */
export { REPRESENTATIVE_VERSION };

// ─────────────────────────────────────────────────────────────────────────────
// Level 1 — sample_ref
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A stored reference to one Audiotool sample (`samples/{uuid}`) and the content
 * identity its audio maps to.
 *
 * `sampleId` is the primary key. `contentIdentity` is the FK edge to a
 * `content` record (the deduplication level). Because audio content per sample
 * is immutable (verified in STEP15G), this edge is stable for the sample's
 * lifetime; it is treated as a validated cache (OQ-2), reconciled on conflict.
 *
 * `publishedAt` is client-agnostic provenance (ISO-8601 string, JSON-safe).
 */
export interface GlobalSampleRefRecord {
  readonly kind: "sample_ref";
  /** Audiotool `samples/{uuid}` — the primary key of this reference. */
  sampleId: string;
  /** The content identity the sample's audio produces. */
  contentIdentity: AudioContentIdentity;
  /** ISO-8601 timestamp when this reference was published. */
  publishedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Level 2 — analysis (classification / map / similarity / version metadata)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The analysis layer of a content record — the globally reusable result.
 *
 * Reuses the established types for classification, map position, similarity
 * fingerprint and features. `contentIdentity` is NOT repeated here: the owning
 * `content` record provides it (single source, avoids the redundancy seen in the
 * 16A transport shape).
 *
 * Immutability split (STEP16_DESIGN §12, task §23):
 *  - classification / map / similarity / analysisVersion / analysisBuild are
 *    *versioned results*: a later compatible version may replace them without
 *    changing the content identity.
 *  - `contentHash` / `contentHashVersion` are NOT here — they are the content
 *    identity (immutable).
 */
export interface GlobalAnalysisRecord {
  classification: {
    classificationVersion: string;
    primaryClass: ClassId;
    confidence: number;
    secondaryClasses: SecondaryClass[];
  };
  /** Map projection: version + position (independent version). */
  map: {
    mapVersion: string;
    position: MapPosition;
  };
  /** Versioned similarity fingerprint (independent version). */
  similarity: SimilarityFingerprint;
  /** STEP41 — compact canonical V2 knowledge (16-bit packed SoundCharacter),
   *  OPTIONAL + ADDITIVE (a pre-V2 record simply omits it). Reuses the 16A
   *  transport shape; the block pins its own independent version dimensions
   *  (analysis / similarity-algorithm / sound-space). */
  soundCharacterV2?: GlobalSoundCharacterKnowledge;
  /** Feature-set version (`features-v1`). NOT the same as `build`. */
  analysisVersion: string;
  /** Build / implementation identity used to derive this result (idempotency). */
  analysisBuild: string;
  /** The lossless container actually analyzed ("wav" | "flac"). */
  analysisSourceFormat: AnalysisSourceFormat;
  /** Structural flag — only gate-passed, lossless results are eligible. */
  gatePassed: true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Level 3 — content
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The set of all independent versions a content record carries. Bumping one must
 * NOT cascade into another (a `similarity-v2` must not imply `pcm-v2`).
 */
export interface GlobalVersionSet {
  contentHashVersion: string;
  analysisVersion: string;
  analysisBuild: string;
  classificationVersion: string;
  mapVersion: string;
  similarityVersion: string;
  representativeVersion: string;
}

/**
 * A stored content record — the canonical, deduplicated analysis keyed by
 * content identity. PRIMARY KEY = `contentIdentityKey(contentIdentity)` =
 * `contentHashVersion:contentHash`.
 *
 * Populated from a publish once; duplicate publishes of the same identity are a
 * no-op for the canonical analysis (idempotent), with new `sample_ref`s appended.
 *
 * `features` are stored so a future projection upgrade (map-v2, similarity-v2)
 * can recompute WITHOUT re-downloading audio (STEP16_DESIGN §11.3). `fileHash`
 * is OPTIONAL provenance for the source file (see §fileHash rationale below).
 *
 * The reverse `content → sampleIds[]` is NOT denormalised here (it is a query
 * over the `sample_ref` FK); see `collectSampleIds`.
 */
export interface GlobalContentRecord {
  readonly kind: "content";
  /** THE key: content identity (contentHash contentHashVersion). */
  contentIdentity: AudioContentIdentity;
  /** The canonical, reusable analysis result. */
  analysis: GlobalAnalysisRecord;
  /**
   * Feature-derived quantities needed to recompute projections without audio.
   * Metadata only — never audio bytes.
   */
  features: AudioFeatures;
  /**
   * OPTIONAL file-level provenance: SHA-256 of the exact source container bytes.
   * See fileHash rationale (STEP16B_IMPLEMENTATION §fileHash). Not required for
   * content identity or for another user's analysis reuse.
   */
  fileHash?: string;
  /** All the independent versions this record was produced under. */
  versions: GlobalVersionSet;
  /** ISO-8601 timestamp of first publish of this identity. */
  firstPublishedAt: string;
  /** ISO-8601 timestamp of last update (projection refresh), if any. */
  updatedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived relationships (no duplication of representative logic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reverse mapping `content identity → sampleIds[]` from a set of `sample_ref`
 * records. Enables the `contentXYZ → [AAA, BBB]` shape without denormalising a
 * list onto the content record.
 */
export function collectSampleIds(
  refs: readonly GlobalSampleRefRecord[],
): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const ref of refs) {
    const key = contentIdentityKey(ref.contentIdentity);
    const list = byKey.get(key) ?? [];
    if (!list.includes(ref.sampleId)) list.push(ref.sampleId);
    byKey.set(key, list);
  }
  return byKey;
}

/**
 * Given the `sample_ref` set for one content identity, derive its representative
 * sampleId using the established `selectRepresentative` (representative-v1,
 * lex-smallest). This is a thin projection that DELEGATES to the single
 * authority — it does NOT reimplement the rule.
 *
 * The representative is a *derived* value (a function of which sampleIds are
 * known), so the content record does not store it; the global representative
 * differs from any local representative by design (STEP16_DESIGN §8.2).
 */
export function deriveRepresentative(
  refs: readonly GlobalSampleRefRecord[],
): string | undefined {
  if (refs.length === 0) return undefined;
  const ids: string[] = [];
  for (const r of refs) {
    if (!ids.includes(r.sampleId)) ids.push(r.sampleId);
  }
  return selectRepresentative(ids);
}

// ─────────────────────────────────────────────────────────────────────────────
// Conflict detection (data-level; resolution is a later step)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A detected sampleId-level conflict: the SAME sampleId was published under two
 * DIFFERENT content identities (e.g. User A → AAA→XYZ, User B → AAA→ABC).
 *
 * This is structurally detectable from `sample_ref` records and must NOT be
 * silently accepted. Resolution is explicitly a later step (task §24); 16B only
 * exposes the detectable signal.
 */
export interface SampleIdentityConflict {
  sampleId: string;
  contentIdentities: AudioContentIdentity[];
}

/**
 * Detect sampleIds that map to more than one distinct content identity within an
 * authoritative `sample_ref` set. Returns one entry per conflicting sampleId,
 * with every distinct identity observed. Empty when consistent.
 */
export function detectSampleIdConflicts(
  refs: readonly GlobalSampleRefRecord[],
): SampleIdentityConflict[] {
  const bySample = new Map<string, AudioContentIdentity[]>();
  for (const ref of refs) {
    const list = bySample.get(ref.sampleId) ?? [];
    const key = contentIdentityKey(ref.contentIdentity);
    if (!list.some((c) => contentIdentityKey(c) === key)) {
      list.push(ref.contentIdentity);
    }
    bySample.set(ref.sampleId, list);
  }
  const conflicts: SampleIdentityConflict[] = [];
  for (const [sampleId, identities] of bySample) {
    if (identities.length > 1) {
      conflicts.push({ sampleId, contentIdentities: identities });
    }
  }
  return conflicts;
}
