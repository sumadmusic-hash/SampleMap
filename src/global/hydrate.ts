/**
 * Step 16L — Global → Local Hydration.
 *
 * Turns a globally-known, compatible analysis (the canonical, audio-free
 * GlobalAnalysisResult) plus sample metadata into a persisted local
 * `SampleIndexRecord`, so the existing LOCAL SearchEngine can find it.
 *
 * This module is PURE (deterministic, auditable) and reuses the SAME record
 * shape the 16J analysis-reuse path writes — it does NOT invent a second
 * analysis pipeline, a second record model, or a second search engine. It
 * performs NO audio fetch, NO decode, NO feature extraction, NO classification
 * (the global analysis already contains all content-level results).
 *
 * Invariants preserved:
 *  - content identity = (contentHashVersion, contentHash), copied verbatim.
 *  - metadata-only — never audio bytes (`assertNoAudioBytes` guards the store).
 *  - idempotent at the sampleId level (IndexStore.put / sampleId key).
 */
import type { SampleMeta } from "@audiotool/nexus/api";
import type {
  GlobalAnalysisResult,
} from "./contract";
import type { SampleIndexRecord, SampleVisibility } from "../persistence/indexStore";
import { reconcileSemanticClassification } from "../classify/semanticClassification";
import { fromV1AudioFeatures } from "../analysis/audioFeaturesV2";
import { computeSoundCharacterQuality } from "../analysis/soundCharacter";
import { ANALYSIS_VERSION, type SampleAnalysisV2 } from "../analysis/sampleAnalysisV2";
import { decodeSoundCharacterFromBase64 } from "./soundCharacterCodec";

/** A local record built from a globally-known analysis + sample metadata. */
export interface HydratedRecord {
  record: SampleIndexRecord;
  /** True when the record is fully hydrated (metadata resolved from Audiotool). */
  resolved: boolean;
}

/** Deterministic "seen" timestamp for a hydrated record (default: now). */
export type NowFn = () => string;

/**
 * Build a local `SampleIndexRecord` from a globally-known compatible analysis.
 *
 * `meta` may be a resolved Audiotool sample (richer: name/owner/tags/visibility)
 * or `undefined` (a global-only point with no resolvable library sample — the
 * record still carries the canonical content-level analysis so it is searchable
 * by class/confidence and usable for similarity, but has fallback metadata).
 *
 * The record is metadata-only and keyed on `sampleId` for idempotent hydration.
 */
export function buildRecordFromGlobalAnalysis(
  sampleId: string,
  meta: SampleMeta | undefined,
  globalAnalysis: GlobalAnalysisResult,
  analysisBuild: string,
  now: NowFn = () => new Date().toISOString(),
): HydratedRecord {
  const resolved = meta !== undefined;

  // STEP41 — hydrate the compact canonical V2 knowledge (16-bit packed
  // SoundCharacter) into a complete local `analysisV2`, so Find Similar
  // (`rankSimilar` over the 8D SoundCharacter) and the Sound Space map work on
  // a globally-reused record WITHOUT re-analyzing audio. Metadata-only: the
  // V1 `audioFeatures` (already carried on the global analysis) are adapted to
  // the V2 feature shape (`fromV1AudioFeatures`), the packed character is
  // decoded verbatim, and `quality` is recomputed by the single existing
  // authority. A corrupt block is treated as absent (never fabricated).
  let analysisV2: SampleAnalysisV2 | undefined;
  const v2Knowledge = globalAnalysis.soundCharacterV2;
  if (v2Knowledge !== undefined) {
    const soundCharacter = decodeSoundCharacterFromBase64(v2Knowledge.packed);
    if (soundCharacter) {
      analysisV2 = {
        analysisVersion: ANALYSIS_VERSION,
        features: {
          ...fromV1AudioFeatures(globalAnalysis.audioFeatures),
          // The block's integer duration (ms) is the compact authority; the
          // adapted V1 duration equals it within validation tolerance.
          durationSec: v2Knowledge.durationMs / 1000,
        },
        soundCharacter,
        quality: computeSoundCharacterQuality(soundCharacter),
      };
    }
  }

  const record: SampleIndexRecord = {
    sampleId,
    owner: resolved && meta ? meta.ownerName ?? "unknown" : "global",
    visibility: resolved && meta ? mapVisibility(meta.visibility) : "unknown",
    name: resolved && meta ? meta.displayName ?? meta.name : sampleId,
    kind: resolved && meta ? meta.kind ?? "unknown" : "unknown",
    originalTags: resolved && meta ? (meta.tags ? [...meta.tags] : []) : [],
    // METADATA SLICE — flat Audiotool source/community fields, copied verbatim
    // from the resolved meta (same semantics as analysisPipeline.buildRecord).
    // `resolved` ensures global-only points (no library meta) stay undefined
    // rather than poisoned with zeros.
    bpm: resolved && meta ? meta.bpm : undefined,
    numFavorites: resolved && meta ? meta.numFavorites : undefined,
    numUsages: resolved && meta ? meta.numUsages : undefined,
    primaryClass: globalAnalysis.primaryClass,
    confidence: globalAnalysis.confidence,
    secondaryClasses: [...globalAnalysis.secondaryClasses],
    classificationVersion: globalAnalysis.classificationVersion,
    // STEP38 — additive semantic classification derived from the global
    // analysis class + the local meta's tags (same semantics as the local
    // pipeline; tags are evidence, never overriding the audio family).
    semanticClassification: reconcileSemanticClassification(
      {
        primaryClass: globalAnalysis.primaryClass,
        confidence: globalAnalysis.confidence,
        secondaryClasses: [...globalAnalysis.secondaryClasses],
      },
      resolved && meta ? (meta.tags ? meta.tags : []) : [],
    ),
    audioFeatures: globalAnalysis.audioFeatures,
    // V2 (STEP 16Q): the global analysis carries the persisted map position
    // (its authoritative result). Copy it verbatim — no feature recompute.
    mapPosition: { x: globalAnalysis.map.x, y: globalAnalysis.map.y },
    analysisVersion: globalAnalysis.analysisVersion,
    analyzedAt: now(),
    analysisBuild,
    status: "analyzed",
    analysisSourceFormat: globalAnalysis.analysisSourceFormat,
    contentHash: globalAnalysis.contentIdentity.contentHash,
    contentHashVersion: globalAnalysis.contentIdentity.contentHashVersion,
    similarityFingerprint: globalAnalysis.similarity,
    // STEP41 — the hydrated V2 analysis (present only when the global block
    // was present and decoded cleanly; absent = V1-style reuse record).
    ...(analysisV2 ? { analysisV2 } : {}),
  };
  return { record, resolved };
}

function mapVisibility(v: SampleMeta["visibility"]): SampleVisibility {
  if (v === "public" || v === "unlisted" || v === "private") return v;
  return "unknown";
}
