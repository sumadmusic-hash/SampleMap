/**
 * Global Lookup & Reuse Semantics (Step 16C).
 *
 * 16A defined the *contract* (what operations exist on a `GlobalSampleIndex`).
 * 16B defined the *record schema* (what stored records look like). 16C defines
 * the *domain semantics*: how the SampleMap core decides whether a sample or a
 * content identity is already globally known and whether an existing analysis
 * result can be REUSED instead of re-analyzed.
 *
 * This is pure, provider-agnostic domain logic. It injects a `GlobalSampleIndex`
 * (a later adapter implements that against a concrete backend) and layers the
 * reuse semantics on top. It performs NO network, NO database, NO publish
 * (lookup is strictly read-only), and NO audio.
 *
 * Core decisions the domain makes (STEP16_DESIGN §6-§10, §17, §23):
 *   - sampleId fast-path: known → REUSE, unknown → (consumer must analyze).
 *   - contentIdentity path: known → REUSE, unknown → keep analysis.
 *   - version compatibility is PER-DIMENSION, not "all or nothing".
 *   - no voting / consensus / first-valid-wins is invented here.
 *
 * Content Identity is NEVER reconstructed from features/map/similarity; it is
 * only ever read from the authoritative stored `(contentHash, contentHashVersion)`.
 */
import type {
  GlobalSampleIndex,
  GlobalSampleLookupHit,
  GlobalContentLookupHit,
  GlobalAnalysisResult,
} from "./contract";
import type { AudioContentIdentity } from "../identity/audioContentIdentity";

// ─────────────────────────────────────────────────────────────────────────────
// Supported-versions policy (what the CONSUMER can reuse)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The set of versions the current consumer supports. A global result is fully
 * reusable when every dimension it depends on matches one of these supported
 * versions. Each version is independent (§9): bumping one does not change the
 * content identity.
 */
export interface SupportedVersions {
  contentHashVersion: string;
  analysisVersion: string;
  classificationVersion: string;
  mapVersion: string;
  similarityVersion: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reuse compatibility (per independent dimension)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-dimension compatibility of a globally-known analysis against the
 * consumer's `SupportedVersions`. Each dimension is judged independently, so a
 * `similarity-v2` consumer facing a `similarity-v1` global result is still fully
 * reusable for content/analysis/classification/map (partial reuse, §24).
 */
export interface ReuseCompatibility {
  content: boolean;
  analysis: boolean;
  classification: boolean;
  map: boolean;
  similarity: boolean;
}

/**
 * The full reuse decision for one known content identity / analysis bundle.
 */
export type ReuseDecision =
  | { status: "reuse"; compatibility: ReuseCompatibility }
  | {
      status: "incompatible";
      compatibility: ReuseCompatibility;
      /** The dimensions that are NOT reusable (empty implies "reuse"). */
      missing: Array<keyof ReuseCompatibility>;
    };

/**
 * Decide whether a globally-known analysis can be reused, judged per dimension
 * against the consumer's supported versions (§23, §24).
 *
 * Note: `contents` here refers to the content-identity dimension
 * (`contentHashVersion`), NOT the `content` entity. `similarityVersion` has no
 * influence on any other dimension's compatibility and never on the content
 * identity itself (§9, §34).
 */
export function decideReuse(
  analysis: GlobalAnalysisResult,
  supported: SupportedVersions,
): ReuseDecision {
  const compatibility: ReuseCompatibility = {
    content: analysis.contentIdentity.contentHashVersion === supported.contentHashVersion,
    analysis: analysis.analysisVersion === supported.analysisVersion,
    classification: analysis.classificationVersion === supported.classificationVersion,
    map: analysis.map.mapVersion === supported.mapVersion,
    similarity: analysis.similarity.similarityVersion === supported.similarityVersion,
  };
  const missing = (Object.keys(compatibility) as Array<keyof ReuseCompatibility>).filter(
    (k) => compatibility[k] === false,
  );
  if (missing.length === 0) {
    return { status: "reuse", compatibility };
  }
  return { status: "incompatible", compatibility, missing };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup result semantics
// ─────────────────────────────────────────────────────────────────────────────

/** The data needed to reuse an existing global result (no audio, no UI state). */
export interface GlobalReuseBundle {
  contentIdentity: AudioContentIdentity;
  /** The canonical analysis result (classification/map/similarity/metadata). */
  analysis: GlobalAnalysisResult;
  /** The representative sampleId for the content (existing authority). */
  representativeSampleId?: string;
  /** All known sampleIds referencing this content identity (when available). */
  sampleIds?: string[];
}

/**
 * Lookup semantics for a single sampleId fast-path.
 *
 *   known        → a compatible global result exists → REUSE (no analysis).
 *   incompatible → the sample is known but at least one required dimension is
 *                  not supported by this consumer (partial reuse possible).
 *   unknown      → the sampleId is NOT known on the fast-path. This does NOT
 *                  mean the content is unknown (§12): the consumer must learn
 *                  the content identity via local analysis, then use the
 *                  content path.
 */
export type GlobalSampleLookupResult =
  | {
      state: "known";
      sampleId: string;
      bundle: GlobalReuseBundle;
      decision: ReuseDecision;
    }
  | {
      state: "incompatible";
      sampleId: string;
      bundle: GlobalReuseBundle;
      decision: ReuseDecision;
    }
  | {
      state: "unknown";
      sampleId: string;
    };

/**
 * Lookup semantics for a single content identity path.
 */
export type GlobalContentLookupResult =
  | {
      state: "known";
      contentIdentity: AudioContentIdentity;
      bundle: GlobalReuseBundle;
      decision: ReuseDecision;
    }
  | {
      state: "incompatible";
      contentIdentity: AudioContentIdentity;
      bundle: GlobalReuseBundle;
      decision: ReuseDecision;
    }
  | {
      state: "unknown";
      contentIdentity: AudioContentIdentity;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Domain service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provider-agnostic lookup service. Wraps an injected `GlobalSampleIndex`
 * (any backend adapter) and adds the reuse semantics.
 *
 * All methods are READ-ONLY: they never mutate records and never call
 * `publishAnalysisResults` (LOOKUP and PUBLISH remain separate, §19–§20).
 * Results are deterministic and idempotent: identical input yields identical
 * output; duplicate request IDs are deduplicated, preserving first-occurrence
 * order (§17–§18).
 */
export class GlobalLookup {
  constructor(
    private readonly source: GlobalSampleIndex,
    private readonly supported: SupportedVersions,
  ) {}

  /**
   * Fast-path sampleId lookup (§7, §11). On `known`, the caller can reuse the
   * bundle WITHOUT downloading/decoding/analyzing audio.
   *
   * Batch semantics: returns one result per UNIQUE sampleId (first-occurrence
   * order preserved; duplicates ignored deterministically). An unknown element
   * does not mark the batch unknown (§18).
   */
  async lookupSamples(sampleIds: readonly string[]): Promise<GlobalSampleLookupResult[]> {
    const unique: string[] = [];
    for (const id of sampleIds) {
      if (!unique.includes(id)) unique.push(id);
    }
    if (unique.length === 0) return [];

    // The provider resolves the underlying hits; 16C layers semantics on top.
    const hits = await this.source.lookupSamples(unique);

    // Deterministic order: align to the deduplicated request order.
    const bySample = new Map<string, GlobalSampleLookupHit>();
    for (const hit of hits) bySample.set(hit.sampleId, hit);

    const results: GlobalSampleLookupResult[] = [];
    for (const id of unique) {
      const hit = bySample.get(id);
      if (!hit || hit.status === "unknown") {
        results.push({ state: "unknown", sampleId: id });
        continue;
      }
      const decision = decideReuse(hit.analysis, this.supported);
      const bundle: GlobalReuseBundle = {
        contentIdentity: hit.contentIdentity,
        analysis: hit.analysis,
      };
      results.push({
        state: decision.status === "reuse" ? "known" : "incompatible",
        sampleId: id,
        bundle,
        decision,
      });
    }
    return results;
  }

  /**
   * Content identity lookup (§8, §18). Used after local analysis has determined
   * the `contentHash`/`contentHashVersion`, enabling cross-user dedup (different
   * sampleIds → same content → reuse).
   *
   * Returns one result per UNIQUE content identity (first-occurrence order).
   * The content-level dedup rule (§16): a given `(contentHash, contentHashVersion)`
   * resolves to exactly ONE content record and its sample references.
   */
  async lookupContentIdentities(
    identities: readonly AudioContentIdentity[],
  ): Promise<GlobalContentLookupResult[]> {
    const unique = identities.filter(
      (id, i) =>
        identities.findIndex(
          (x) =>
            x.contentHash === id.contentHash &&
            x.contentHashVersion === id.contentHashVersion,
        ) === i,
    );
    if (unique.length === 0) return [];

    const hits = await this.source.lookupContentIdentities(unique);
    const byKey = new Map<string, GlobalContentLookupHit>();
    for (const hit of hits) {
      byKey.set(
        `${hit.contentIdentity.contentHashVersion}:${hit.contentIdentity.contentHash}`,
        hit,
      );
    }

    const results: GlobalContentLookupResult[] = [];
    for (const id of unique) {
      const key = `${id.contentHashVersion}:${id.contentHash}`;
      const hit = byKey.get(key);
      if (!hit) {
        results.push({ state: "unknown", contentIdentity: id });
        continue;
      }
      const decision = decideReuse(hit.analysis, this.supported);
      const bundle: GlobalReuseBundle = {
        contentIdentity: hit.contentIdentity,
        analysis: hit.analysis,
        sampleIds: [...hit.sampleIds],
        representativeSampleId: hit.representativeSampleId,
      };
      results.push({
        state: decision.status === "reuse" ? "known" : "incompatible",
        contentIdentity: id,
        bundle,
        decision,
      });
    }
    return results;
  }
}
