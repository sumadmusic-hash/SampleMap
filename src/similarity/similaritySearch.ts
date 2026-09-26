/**
 * Find Similar (Step 15J).
 *
 * V1 exhaustive scan over analyzed content identities. Deterministic,
 * local-only, no ANN/ML. Integrates with 15I content identity:
 *  - the query identity is excluded (never its own result)
 *  - results are deduplicated by content identity (one result per identity)
 *  - only compatible similarity-v1 fingerprints are compared
 */

import type { SampleIndexRecord } from "../persistence/indexStore";
import {
  contentIdentityKey,
  makeContentIdentity,
  selectRepresentative,
  type AudioContentIdentity,
} from "../identity/audioContentIdentity";
import {
  SIMILARITY_VERSION,
  type SimilarityFingerprint,
} from "./similarityFingerprint";
import { similarityScore } from "./similarityDistance";

/** Default result limit (design §I). */
export const DEFAULT_SIMILAR_LIMIT = 10;

/** Allowed result limits (design §I: 5 / 10 / 20). */
export const SIMILAR_LIMITS = [5, 10, 20] as const;

/** A single Find Similar result (one per content identity, design §G). */
export interface SimilarSampleResult {
  contentIdentity: AudioContentIdentity;
  representativeSampleId: string;
  similarityVersion: string;
  similarityScore: number; // 0..1
}

/** Clamp a requested limit to the allowed set; default to DEFAULT_SIMILAR_LIMIT. */
export function sanitizeSimilarLimit(limit: number | undefined): number {
  if (limit !== undefined && (SIMILAR_LIMITS as readonly number[]).includes(limit)) {
    return limit;
  }
  return DEFAULT_SIMILAR_LIMIT;
}

export interface FindSimilarInput {
  /** The query's content identity (used for exclusion and dedup). */
  contentIdentity: AudioContentIdentity;
  /** The query's similarity fingerprint (must be similarity-v1). */
  fingerprint: SimilarityFingerprint;
  /** Records to search over (the local index). */
  records: readonly SampleIndexRecord[];
  /** Optional result limit; clamped to {5,10,20}. */
  limit?: number;
}

/**
 * Find the most similar analyzed content identities to a query fingerprint.
 *
 * Rules (design §G / §10 of the task):
 *  - exclude the query content identity
 *  - exclude any non-analyzed records
 *  - skip records without a matchable fingerprint or with an incompatible
 *    similarityVersion (never mixed)
 *  - deduplicate by content identity (one result per identity; representative
 *    sample carried on the result)
 *  - sort by similarityScore DESC, then contentIdentityKey ASC (deterministic
 *    tie-breaker)
 *  - apply the sanitized limit
 */
export function findSimilar(input: FindSimilarInput): SimilarSampleResult[] {
  const limit = sanitizeSimilarLimit(input.limit);
  const queryKey = contentIdentityKey(input.contentIdentity);

  // Group analyzed candidate records by content identity (dedup by identity).
  const groups = new Map<string, SampleIndexRecord[]>();
  for (const r of input.records) {
    if (r.status !== "analyzed") continue;
    // Skip records with no contentHash (legacy) — they have no identity to match.
    if (!r.contentHash) continue;
    const key = contentIdentityKey({
      contentHash: r.contentHash,
      contentHashVersion: r.contentHashVersion ?? "unknown",
    });
    if (key === queryKey) continue; // exact duplicate / the query itself
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(r);
  }

  const results: SimilarSampleResult[] = [];
  for (const group of groups.values()) {
    // Use the first record in the group (they share identity) but mark the
    // representative so the UI can resolve metadata.
    const sampleIds = [...new Set(group.map((r) => r.sampleId))].sort();
    const representativeSampleId = selectRepresentative(sampleIds);

    // Select a representative fingerprint for the group. Prefer the
    // representative record's fingerprint if present and compatible.
    const representative = group.find(
      (r) =>
        r.similarityFingerprint &&
        r.similarityFingerprint.similarityVersion === SIMILARITY_VERSION,
    );
    const fp = representative?.similarityFingerprint;
    if (!fp) continue; // group has no compatible fingerprint to compare

    const candidate = representative ?? group[0];
    let score: number;
    try {
      score = similarityScore(input.fingerprint, fp);
    } catch {
      continue; // version mismatch — incompatible (should not happen after filter)
    }

    results.push({
      contentIdentity: makeContentIdentity(
        candidate.contentHash!,
        candidate.contentHashVersion ?? "unknown",
      ),
      representativeSampleId,
      similarityVersion: SIMILARITY_VERSION,
      similarityScore: score,
    });
  }

  // Deterministic ordering: similarity DESC, then contentIdentityKey ASC.
  results.sort((a, b) => {
    if (b.similarityScore !== a.similarityScore) {
      return b.similarityScore - a.similarityScore;
    }
    return contentIdentityKey(a.contentIdentity).localeCompare(
      contentIdentityKey(b.contentIdentity),
    );
  });

  return results.slice(0, limit);
}