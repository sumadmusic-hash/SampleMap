/**
 * Global Sample Index — Backend-agnostic contract (Step 16A).
 *
 * This is the abstraction boundary between the SampleMap core and a later
 * global backend (Cloudflare D1 / Supabase / Neon / …). The core depends ONLY
 * on this contract; a backend adapter resolves the concrete provider.
 *
 * Design source: STEP16_DESIGN.md (§20 Global Index Contract, §7 identity,
 * §11 versioning, §14 global map, §17 batching/idempotency).
 *
 * Hard invariants (enforced/encoded here):
 *  - The contract describes WHAT is possible, not HOW (no provider terms:
 *    no `fetch`, `D1`, `Postgres`, HTTP status codes, auth).
 *  - NO raw audio anywhere: no `ArrayBuffer`, `Uint8Array`, `Blob` of audio, no
 *    audio URLs as a stand-in for uploading audio. Only metadata, hashes,
 *    fingerprints, versions.
 *  - Independent version constants are preserved; they are NEVER merged into a
 *    single global version (bumping `similarity-v2` must not imply `pcm-v2`).
 *
 * No backend, API, database, or adapter is implemented here.
 */
import type { AudioContentIdentity } from "../identity/audioContentIdentity";
import type { AnalysisSourceFormat } from "../audio/sourceFormat";
import type {
  AudioFeatures,
  ClassId,
  SecondaryClass,
} from "../persistence/indexStore";
import type { SimilarityFingerprint } from "../similarity/similarityFingerprint";
import { SOUND_CHARACTER_CODEC_VERSION } from "./soundCharacterCodec";
import { SIMILARITY_ALGORITHM_VERSION } from "../analysis/similarityEngine";
import { SOUND_SPACE_ALGORITHM_VERSION } from "../analysis/soundSpaceProjector";

// ─────────────────────────────────────────────────────────────────────────────
// V2 Global Knowledge (STEP41)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * STEP41 — the compact canonical V2 knowledge block bound to a content identity.
 *
 * D1 stores ONLY this block (plus the existing V1 metadata columns) and a local
 * client hydrates from it — so Find Similar (8D SoundCharacter ranking) and the
 * Sound Space map work WITHOUT re-analyzing audio.
 *
 * The essential payload is the 16-bit packed `SoundCharacter` (V2.SC-v1, 17
 * bytes, base64 for JSON transport — see `soundCharacterCodec.ts`). `packed` is
 * authoritative for the character; every other field is carried so a hydrator
 * can build a complete, version-gated local `analysisV2` without inventing
 * data. `durationMs` is the compact integer duration (V1 `audioFeatures.duration`
 * is seconds; both describe the same lossless container).
 *
 * This is OPTIONAL and ADDITIVE: publish under an older client omits it and the
 * row remains fully valid; re-publish with knowledge backfills it only when the
 * stored row has none (never a last-write-wins clobber). All fields are
 * metadata — `packed` is a string, so `assertNoAudioBytes` passes.
 */
export interface GlobalSoundCharacterKnowledge {
  /** The packed-layout version token — always `V2.SC-v1`. */
  codecVersion: typeof SOUND_CHARACTER_CODEC_VERSION;
  /** Base64 encoding of the 17-byte packed SoundCharacter (V2.SC-v1). */
  packed: string;
  /** The V2 analysis version the character was produced under ("2.0.0"). */
  analysisVersion: string;
  /** Independent V2 similarity-algorithm version ("2.0.0"). */
  similarityVersion: typeof SIMILARITY_ALGORITHM_VERSION;
  /** Independent Sound Space projection-algorithm version ("1.0.0"). */
  soundSpaceVersion: typeof SOUND_SPACE_ALGORITHM_VERSION;
  /** Classification model version (single source: `GlobalAnalysisResult`). */
  classificationVersion: string;
  /** Classification confidence in [0, 1] (single source: `GlobalAnalysisResult`). */
  confidence: number;
  /** Duration of the lossless container in milliseconds (integer, > 0). */
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Global Analysis Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical, reusable analysis result bound to an audio CONTENT identity.
 *
 * This is the shared knowledge clients reuse instead of re-analyzing audio. It
 * deliberately carries NO sample-specific, volatile metadata (name, owner,
 * tags, visibility) and NO audio bytes.
 *
 * `gatePassed` is the structural flag: only results the local pipeline could
 * have produced (lossless-only, gate passed) are structurally valid for the
 * global index.
 */
export interface GlobalAnalysisResult {
  /** The content identity (contentHash contentHashVersion). */
  contentIdentity: AudioContentIdentity;
  /** Classification model version (independent of contentHash). */
  classificationVersion: string;
  primaryClass: ClassId;
  confidence: number;
  secondaryClasses: SecondaryClass[];
  /** Feature-set version (`analysisVersion`), e.g. "features-v1". */
  analysisVersion: string;
  /** Build id used to derive the result (`analysisBuild`). */
  analysisBuild: string;
  /** Map projection version + position (independent version). V2: PERSISTED analysis result, not derivable from features. */
  map: {
    mapVersion: string;
    x: number;
    y: number;
  };
  /** Versioned similarity fingerprint (independent version). */
  similarity: SimilarityFingerprint;
  /**
   * STEP41 — the compact canonical V2 knowledge (16-bit packed SoundCharacter),
   * OPTIONAL and ADDITIVE. When present, a hydrating client can rebuild a local
   * `analysisV2` and rank Find Similar without re-analyzing audio. It does NOT
   * duplicate the V1 fingerprint above; each is independently versioned.
   */
  soundCharacterV2?: GlobalSoundCharacterKnowledge;
  /** The lossless container actually analyzed ("wav" | "flac"). */
  analysisSourceFormat: AnalysisSourceFormat;
  /** Structural flag — always true for a valid global publish. */
  gatePassed: true;
  /**
   * Step 16J: the audio features used to derive the similarity fingerprint.
   * Carried so a reuse consumer can build a complete local SampleIndexRecord
   * without re-analyzing audio. (In V2 the map position is NOT derived from
   * these; it is carried verbatim in `map`.) Metadata only — never audio bytes.
   */
  audioFeatures: AudioFeatures;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sample Lookup (fast-path)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of a `lookupSamples` for a single sampleId.
 *
 * Uses an explicit `known | unknown` discriminated union (never bare
 * null/undefined semantics) so the two outcomes are structurally unambiguous.
 */
export type GlobalSampleLookupHit =
  | {
      status: "known";
      sampleId: string;
      contentIdentity: AudioContentIdentity;
      analysis: GlobalAnalysisResult;
    }
  | {
      status: "unknown";
      sampleId: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Content Identity Lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of a `lookupContentIdentities` for a single content identity.
 *
 * Reflects the `sample_ref → content` relationship: one content identity may
 * be referenced by many sampleIds (AAA/BBB → same content). The representative
 * is selected by the established `representative-v1` rule (lex smallest
 * sampleId) over the GLOBAL union of sampleIds — NOT recomputed here (see
 * `selectRepresentative` in identity, which stays the single authority).
 */
export interface GlobalContentLookupHit {
  contentIdentity: AudioContentIdentity;
  analysis: GlobalAnalysisResult;
  /** All known sampleIds referencing this content identity. */
  sampleIds: string[];
  representativeSampleId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Publish
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One publishable result: a sampleId reference PLUS its canonical analysis.
 *
 * `features` is included so a future server can cross-check the derived
 * similarity fingerprint against it (a pure function of `AudioFeatures`). The
 * map position, however, is a PERSISTED V2 analysis result carried in
 * `analysis.map` — it is NOT recomputable from `features` (its authoritative
 * computation requires decoded audio). This is structural data, never audio.
 */
export interface GlobalPublishResult {
  /** The sampleId being published (the `sample_ref`). */
  sampleId: string;
  contentIdentity: AudioContentIdentity;
  /** The canonical analysis for this content identity. */
  analysis: GlobalAnalysisResult;
  /**
   * Feature-derived quantities needed to recompute the similarity fingerprint
   * without re-downloading audio. Metadata only — never audio bytes.
   * (Map position is not derivable from features in V2.)
   */
  features: AudioFeatures;
}

/** Batch publish input (metadata only, audio-free). */
export type GlobalPublishBatch = GlobalPublishResult[];

/**
 * Per-item publish outcome. Publish is idempotent: re-publishing an already
 * known content identity is `already-known` (no duplicate canonical record),
 * not an error. Structural rejection is a distinct outcome.
 */
export type GlobalPublishItemOutcome =
  | { status: "stored" }
  | { status: "already-known" }
  | { status: "rejected"; reason: string };

export interface GlobalPublishOutcome {
  /** One outcome per submitted item, aligned with input order. */
  items: GlobalPublishItemOutcome[];
  /** True only if every item was `stored` or `already-known`. */
  accepted: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Global Map Query (viewport / bbox — no "get everything")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Viewport / bounding-box map query (Tier-1, STEP16_DESIGN §14). The global map
 * is query-oriented and bounded — there is deliberately NO `getAllSamples()` /
 * `getAllMapPoints()` on the contract.
 */
export interface MapViewportQuery {
  mapVersion: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** Optional zoom/level for future clustering (Tier-2). */
  zoom?: number;
  /** Optional classification filter. */
  primaryClass?: ClassId;
  /** Optional bounded result limit (server/provider may cap further). */
  limit?: number;
  /** Opaque pagination cursor for subsequent pages. */
  cursor?: string;
}

/** A single map point on the global map (one point per content identity). */
export interface GlobalMapPoint {
  contentIdentity: AudioContentIdentity;
  x: number;
  y: number;
  representativeSampleId: string;
  primaryClass: ClassId;
}

export interface GlobalMapViewportResult {
  mapVersion: string;
  points: GlobalMapPoint[];
  /** Present when more pages exist. */
  nextCursor?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Semantics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Backend-agnostic error taxonomy. Distinct, data-driven outcomes — but NO HTTP
 * status codes (a provider adapter maps these later).
 */
export type GlobalIndexError =
  | { kind: "not-found" }
  | { kind: "validation-rejected"; reason: string }
  | { kind: "version-incompatible"; detail: string }
  | { kind: "conflict"; detail: string }
  | { kind: "rate-limited" }
  | { kind: "temporary-unavailable" };

// ─────────────────────────────────────────────────────────────────────────────
// The Contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Global Sample Index contract.
 *
 * Async, read-oriented, batch-shaped, audio-free. The SampleMap core knows only
 * this interface; a backend adapter (later step, e.g. D1/Supabase/Neon)
 * implements it against a concrete provider.
 *
 * All operations are batch-shaped to keep request counts low (STEP16_DESIGN
 * §17). This interface does NOT implement the backend — it only defines it.
 */
export interface GlobalSampleIndex {
  /**
   * Fast-path: are these sampleIds already known globally? On a `known` hit,
   * the caller can reuse the canonical analysis WITHOUT downloading/decoding
   * audio.
   */
  lookupSamples(sampleIds: readonly string[]): Promise<GlobalSampleLookupHit[]>;

  /**
   * Content-level lookup: given `(contentHash, contentHashVersion)` identities,
   * return the canonical analysis + all sample references. Enables content-level
   * dedup (different sampleIds → same audio content).
   */
  lookupContentIdentities(
    identities: readonly AudioContentIdentity[],
  ): Promise<GlobalContentLookupHit[]>;

  /**
   * Publish locally produced, gate-passed analyses (metadata only, no audio).
   * Idempotent: duplicate content identities collapse, never duplicate rows.
   */
  publishAnalysisResults(batch: GlobalPublishBatch): Promise<GlobalPublishOutcome>;

  /**
   * Bounded viewport/bbox map query. Never returns the whole map.
   */
  queryMapViewport(query: MapViewportQuery): Promise<GlobalMapViewportResult>;
}
