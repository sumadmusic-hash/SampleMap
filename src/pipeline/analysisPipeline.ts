import type { SampleMeta } from "@audiotool/nexus/api";
import type { AudioDecoder, DecodedAudio } from "../audio/decodedAudio";
import type { AudioFeatures } from "../audio/featureExtractor";
import {
  canonicalizePcm,
  CANONICAL_PCM_VERSION,
} from "../audio/canonicalPcm";
import {
  contentHashOf,
  fileHashOf,
} from "../audio/audioHash";
import {
  GATE_REJECT,
  validateAudioContainer,
  validateDecodedAudio,
} from "./qualityGate";
import { selectLosslessSource, type LosslessSource } from "./sourceSelection";
import type {
  Classifier,
  ClassOutput,
} from "../classify/classifier";
import { HIER_CLASSIFICATION_VERSION } from "../classify/hier/types";
import type { HierClassifyInput, HierClassification, HierResult } from "../classify/hier/types";
import { reconcileSemanticClassification } from "../classify/semanticClassification";
import type { IndexStore, SampleIndexRecord, SampleVisibility } from "../persistence/indexStore";
import { computeSimilarityFingerprint, SIMILARITY_VERSION, type SimilarityFingerprint } from "../similarity/similarityFingerprint";
import { computePosition, mapVersion, type MapPosition } from "../map/mapPosition";
import { GlobalLookup, type SupportedVersions } from "../global/lookup";
import { buildRecordFromGlobalAnalysis } from "../global/hydrate";
import { analyzeAudio } from "../audio/v2Dsp";
import { fromDecodedAudio } from "../audio/v2Input";
import {
  computeSoundCharacter,
  computeSoundCharacterQuality,
} from "../analysis/soundCharacter";
import {
  ANALYSIS_VERSION,
  validateSampleAnalysisV2,
  type SampleAnalysisV2,
} from "../analysis/sampleAnalysisV2";

/**
 * AnalysisPipeline — the per-job full flow (§5 / §20.8), Step 15H.
 *
 *   job → resolve sample metadata → select lossless source (wav→flac) →
 *   fetch audio (transient) → container gate (real bytes) → fileHash →
 *   decode → decoded-PCM gate → canonical PCM → contentHash →
 *   extractFeatures → classify → index.upsert → release audio → outcome
 *
 * Step 15H invariants:
 *  - the analysis source is LOSSLESS ONLY (`wavUrl || flacUrl`); MP3/preview
 *    are playback-only and are never used for analysis (§3–§4)
 *  - the technical gate admits or rejects BEFORE analysis; a rejection emits
 *    a machine-readable reason and NEVER persists an analyzed record (§6–§9)
 *  - fileHash + contentHash are computed transiently and persisted with the
 *    minimal added fields; audio BYTES are never persisted (§1.1 / §13–§15)
 *  - idempotency is still keyed on (sampleId, analysisBuild) (§17)
 *
 * Audio bytes live only in local variables for one job and are released in a
 * `finally`, so they are NEVER written to IndexedDB (which stores
 * metadata/analysis only, and is independently guarded by `assertNoAudioBytes`).
 */

/** Result of fetching a sample's audio bytes for analysis. */
export interface FetchedAudio {
  /** Raw encoded audio bytes. Transient — never persisted. */
  bytes: ArrayBuffer;
  /** Release the transient bytes / references. Must be idempotent. */
  release(): void;
}

/** Outcome of a single analysis job. */
export type AnalysisOutcome =
  | { status: "analyzed" }
  | { status: "failed"; error: string }
  | { status: "gone"; error: string }
  | { status: "skipped"; error: string };

/** Resolve a sample's metadata by id (scanner / library provider). */
export type ResolveSample = (sampleId: string) => Promise<SampleMeta | undefined>;

/**
 * The default supported versions for the local consumer. When no explicit
 * `supportedVersions` are provided, these are used. They match the versions
 * the pipeline actually implements, so a globally published result at these
 * versions is always reusable.
 */
export const DEFAULT_SUPPORTED_VERSIONS: SupportedVersions = {
  contentHashVersion: CANONICAL_PCM_VERSION,
  analysisVersion: "features-v1",
  classificationVersion: "heuristic-v1",
  mapVersion,
  similarityVersion: SIMILARITY_VERSION,
};

/**
 * STEP36 — the canonical V2 analysis of a decoded sample, assembled from the
 * existing V2 DSP chain (`analyzeAudio` → `computeSoundCharacter` → quality)
 * and pinned to the canonical `ANALYSIS_VERSION` ("2.0.0"). Pure,
 * deterministic, metadata-only output. This is the SAME chain the e2e harness
 * used under fixture control; it now ships in the production pipeline so real
 * production-analyzed samples receive the canonical V2 analysis.
 */
export function canonicalV2Analysis(decoded: DecodedAudio): SampleAnalysisV2 {
  const features = analyzeAudio(fromDecodedAudio(decoded));
  const soundCharacter = computeSoundCharacter(features);
  return {
    analysisVersion: ANALYSIS_VERSION,
    features,
    soundCharacter,
    quality: computeSoundCharacterQuality(soundCharacter),
  };
}

export interface AnalysisPipelineDeps {
  /**
   * Fetch the resolved lossless analysis source's bytes.
   * `source.format` identifies the container for the gate.
   */
  fetchAudio: (sample: SampleMeta, source: LosslessSource) => Promise<FetchedAudio>;
  /** Decode raw bytes into PCM (§ audioDecode contract). Injected per environment. */
  decode: AudioDecoder;
  /** Feature extraction (§6), pure. */
  extract: (audio: DecodedAudio) => AudioFeatures;
  /** Classification (§7), via the stable Classifier interface (id + version). */
  classifier: Classifier;
  classifyHier?: (input: HierClassifyInput) => Promise<HierResult>;
  /** Metadata lookup by sampleId. */
  resolveSample: ResolveSample;
  /** Persisted index — metadata/analysis only, never audio bytes. */
  index: IndexStore;
  /** Feature-set version recorded on the index record. */
  analysisVersion?: string;
  /**
   * STEP36 — V2 analysis of a decoded sample. Defaults to the canonical chain
   * (`canonicalV2Analysis`: `analyzeAudio` → `computeSoundCharacter` →
   * quality, version "2.0.0"). The result is validated with
   * `validateSampleAnalysisV2` before persistence; an invalid V2 output fails
   * the job and is NEVER silently persisted (a V1-only record must not be
   * produced by the V2-enabled pipeline).
   */
  analyzeV2?: (decoded: DecodedAudio) => SampleAnalysisV2;
  /** Deterministic clock (tests). */
  now?: () => Date;
  /** Step 16J: optional global lookup for analysis reuse. When present and the sample is globally known with compatible versions, the local audio analysis chain is skipped entirely. */
  globalLookup?: GlobalLookup;
  /**
   * Step 16J: the versions the local consumer supports for global reuse.
   * A global result is reusable only when every dimension matches one of these.
   * Defaults to `DEFAULT_SUPPORTED_VERSIONS` when omitted.
   */
  supportedVersions?: SupportedVersions;
}

export class AnalysisPipeline {
  private readonly fetchAudio: (sample: SampleMeta, source: LosslessSource) => Promise<FetchedAudio>;
  private readonly decode: AudioDecoder;
  private readonly extract: (audio: DecodedAudio) => AudioFeatures;
  private readonly classifier: Classifier;
  private readonly classifyHier: ((input: HierClassifyInput) => Promise<HierResult>) | undefined;
  private readonly resolveSample: ResolveSample;
  private readonly index: IndexStore;
  private readonly analysisVersion: string;
  private readonly now: () => Date;
  private readonly globalLookup: GlobalLookup | undefined;
  private readonly analyzeV2: (decoded: DecodedAudio) => SampleAnalysisV2;

  constructor(deps: AnalysisPipelineDeps) {
    this.fetchAudio = deps.fetchAudio;
    this.decode = deps.decode;
    this.extract = deps.extract;
    this.classifier = deps.classifier;
    this.classifyHier = deps.classifyHier;
    this.resolveSample = deps.resolveSample;
    this.index = deps.index;
    this.analysisVersion = deps.analysisVersion ?? "features-v1";
    this.now = deps.now ?? (() => new Date());
    this.globalLookup = deps.globalLookup;
    this.analyzeV2 = deps.analyzeV2 ?? canonicalV2Analysis;
  }

  /**
   * Run one analysis job end-to-end.
   * Audio bytes are scoped to this method and released in `finally` on every
   * path (success, rejection or error), per invariant §1.1 / §5.1.
   */
  async run(sampleId: string, analysisBuild: string): Promise<AnalysisOutcome> {
    const existing = await this.index.get(sampleId);
    if (
      existing &&
      existing.analysisBuild === analysisBuild &&
      existing.status === "analyzed"
    ) {
      return { status: "skipped", error: "already analyzed for build" };
    }

    // Step 16J: Global Lookup → Analysis Reuse.
    // When a globally known result with compatible versions exists, reuse it
    // directly — no audio download, no decode, no feature extraction, no
    // classification. Any error from the lookup (network, backend, timeout)
    // falls through to the full local pipeline; a transient backend failure
    // must never be mistaken for "unknown".
    if (this.globalLookup) {
      try {
        const [hit] = await this.globalLookup.lookupSamples([sampleId]);
        if (hit && hit.state === "known" && hit.decision.status === "reuse") {
          const meta = await this.resolveSample(sampleId);
          if (!meta) {
            return { status: "gone", error: "sample metadata not found" };
          }
          await this.index.put(this.buildRecordFromGlobal(meta, hit.bundle.analysis, analysisBuild));
          return { status: "analyzed" };
        }
      } catch {
        // UNAVAILABLE / transient error → fall through to local analysis.
        // Must NOT be classified as "unknown".
      }
    }

    let fetched: FetchedAudio | undefined;
    try {
      const meta = await this.resolveSample(sampleId);
      if (!meta) {
        return { status: "gone", error: "sample metadata not found" };
      }

      const source = selectLosslessSource(meta);
      if (!source) {
        return { status: "skipped", error: GATE_REJECT.NO_LOSSLESS_SOURCE };
      }

      fetched = await this.fetchAudio(meta, source);
      const container = validateAudioContainer(source.format, fetched.bytes);
      if (!container.accepted) {
        return { status: "skipped", error: container.reason };
      }
      const fileHash = await fileHashOf(fetched.bytes);

      let decoded: DecodedAudio;
      try {
        decoded = await this.decode(fetched.bytes);
      } catch (e) {
        return {
          status: "skipped",
          error: GATE_REJECT.DECODE_FAILED,
        };
      }
      const pcm = validateDecodedAudio(decoded);
      if (!pcm.accepted) {
        return { status: "skipped", error: pcm.reason };
      }

      const canonical = canonicalizePcm(decoded);
      const contentHashValue = await contentHashOf(canonical);

      const features = this.extract(decoded);
      // STEP36 — production V2 integration: every genuinely analyzed sample
      // receives the canonical V2 analysis (sound character + raw V2 features
      // + quality), computed over the SAME transient decoded audio and
      // validated before persistence. An invalid V2 output is REJECTED — the
      // job fails and nothing is persisted (a V1-only record must never be
      // silently produced by the V2-enabled pipeline).
      const analysisV2 = this.analyzeV2(decoded);
      const v2Validation = validateSampleAnalysisV2(analysisV2);
      if (!v2Validation.valid) {
        return {
          status: "failed",
          error: `V2_ANALYSIS_INVALID: ${v2Validation.errors.join("; ")}`,
        };
      }
      // STEP44 — hierarchical classification (additive). When wired, the FULL
      // metadata + V2 evidence classification runs and its surface REPLACES the
      // plain feature-only `classifier.classify()` output on the record (SC11),
      // with `classificationVersion = "hier-v1"`. Legacy `heuristic-v1` records
      // are untouched (SC12); no migration ever runs.
      const hierEnabled = this.classifyHier !== undefined;
      const hier = hierEnabled
        ? await this.classifyHier!({
            features,
            meta: {
              kind: meta.kind ?? "unknown",
              durationSeconds: features.duration,
              name: meta.displayName ?? meta.name,
              tags: meta.tags ? [...meta.tags] : [],
            },
            v2: analysisV2.features,
          })
        : undefined;
      const classification = hier !== undefined ? hier.surface : await this.classifier.classify(features);
      const classificationVersion = hier !== undefined ? HIER_CLASSIFICATION_VERSION : this.classifier.version;
      const similarityFingerprint = computeSimilarityFingerprint(features);
      // V2 (STEP 16Q): the authoritative map position is computed ONCE here
      // while decoded audio is available (whole-sample flatness), then
      // persisted. Downstream consumers read the persisted position; they
      // never reconstruct it from features (see ADOPTED ARCHITECTURE DECISION).
      const mapPositionV2 = computePosition(features, decoded);

      const record = this.buildRecord(
        meta,
        source,
        features,
        classification,
        classificationVersion,
        analysisBuild,
        { fileHash, contentHash: contentHashValue },
        similarityFingerprint,
        mapPositionV2,
        analysisV2,
        hier?.hier,
      );
      await this.index.put(record);

      return { status: "analyzed" };
    } catch (e) {
      return {
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      // Guaranteed release of transient audio, even on error.
      if (fetched) fetched.release();
    }
  }

  /**
   * Step 16J: build a local `SampleIndexRecord` from a globally reused analysis
   * result. The record is metadata-only (no audio bytes) and carries the same
   * fields as a locally produced record, sourced from the global canonical data.
   *
   * NOTE: sample-specific metadata (owner, name, tags, visibility) is resolved
   * from the local SampleMeta, not from the global index — the global index
   * carries only content-level analysis data.
   */
  private buildRecordFromGlobal(
    meta: SampleMeta,
    globalAnalysis: import("../global/contract").GlobalAnalysisResult,
    analysisBuild: string,
  ): SampleIndexRecord {
    return buildRecordFromGlobalAnalysis(
      meta.name,
      meta,
      globalAnalysis,
      analysisBuild,
      () => this.now().toISOString(),
    ).record;
  }

  private buildRecord(
    meta: SampleMeta,
    source: LosslessSource,
    features: AudioFeatures,
    classification: ClassOutput,
    classificationVersion: string,
    analysisBuild: string,
    hashes: { fileHash: string; contentHash: string },
    similarityFingerprint: SimilarityFingerprint,
    mapPositionV2: MapPosition,
    analysisV2: SampleAnalysisV2,
    hier?: HierClassification,
  ): SampleIndexRecord {
    const timestamp = this.now().toISOString();
    return {
      sampleId: meta.name,
      owner: meta.ownerName ?? "unknown",
      visibility: mapVisibility(meta.visibility),
      name: meta.displayName ?? meta.name,
      kind: meta.kind ?? "unknown",
      originalTags: meta.tags ? [...meta.tags] : [],
      // METADATA SLICE — flat Audiotool source/community fields, copied
      // verbatim from the SampleMeta (preserving `bpm` even when 0 + counter
      // values). Same semantics as buildRecordFromGlobalAnalysis.
      bpm: meta.bpm,
      numFavorites: meta.numFavorites,
      numUsages: meta.numUsages,
      primaryClass: classification.primaryClass,
      confidence: classification.confidence,
      secondaryClasses: classification.secondaryClasses,
      classificationVersion,
      // STEP44 — additive hierarchical classification (structure/family/type/
      // subtype + evidence + reconciliation). Optional: records analyzed before
      // this field existed simply omit it and stay fully readable (SC12).
      hier,
      // STEP38 — additive semantic classification (audio family + tag
      // evidence → fine-grained subtype). Pure consumption of the classifier
      // output + original tags; tags are preserved, never overwritten; the
      // legacy primaryClass/confidence above are untouched.
      semanticClassification: reconcileSemanticClassification(
        classification,
        meta.tags ? meta.tags : [],
      ),
      audioFeatures: features,
      // V2 persisted map position (analysis result — not recomputed downstream).
      mapPosition: mapPositionV2,
      // STEP36 — the canonical validated V2 analysis (metadata-only, additive).
      analysisV2,
      analysisVersion: this.analysisVersion,
      analyzedAt: timestamp,
      analysisBuild,
      status: "analyzed",
      // Step 15H: minimal identity/persistence fields (never audio bytes).
      analysisSourceFormat: source.format,
      fileHash: hashes.fileHash,
      contentHash: hashes.contentHash,
      contentHashVersion: CANONICAL_PCM_VERSION,
      // Step 15J: versioned similarity fingerprint (never audio bytes).
      similarityFingerprint,
    };
  }
}

function mapVisibility(v: SampleMeta["visibility"]): SampleVisibility {
  if (v === "public" || v === "unlisted" || v === "private") return v;
  return "unknown";
}