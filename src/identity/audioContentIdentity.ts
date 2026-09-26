/**
 * Audio Content Identity (Step 15I §3).
 *
 * Two Audiotool samples represent the SAME audio content if and only if they
 * share the same (contentHashVersion, contentHash) pair. This identity is
 * derived solely from the canonicalized decoded audio — never from sample
 * names, URLs, metadata, tags, or file hashes.
 *
 * The identity is versioned: any change to the canonical PCM spec
 * (CANONICAL_PCM_VERSION in canonicalPcm.ts) automatically changes the
 * contentHash, so existing identities remain valid under the old version.
 */

/** Versioned content identity of decoded audio. */
export interface AudioContentIdentity {
  /** The SHA-256 hex digest of the canonicalized PCM. */
  contentHash: string;
  /** Pins the canonical-PCM spec that produced contentHash (e.g. "pcm-v1"). */
  contentHashVersion: string;
}

/** Create an identity (thin constructor — no validation needed). */
export function makeContentIdentity(
  contentHash: string,
  contentHashVersion: string,
): AudioContentIdentity {
  return { contentHash, contentHashVersion };
}

/** Identity key for Map/grouping use (stable string, order-independent). */
export function contentIdentityKey(id: AudioContentIdentity): string {
  return `${id.contentHashVersion}:${id.contentHash}`;
}

/**
 * Versioned representative-selection algorithm.
 *
 * When multiple Audiotool samples share the same Audio Content Identity,
 * exactly one is chosen as the "representative" — the sample whose metadata
 * (name, owner, tags, classification) is displayed on the Map Point.
 *
 * Rule: **lexicographically smallest sampleId** (deterministic, reproducible,
 * order-independent).
 *
 * This is deliberately simple and explicit. A future version can change the
 * rule by bumping REPRESENTATIVE_VERSION without breaking existing data.
 */
export const REPRESENTATIVE_VERSION = "representative-v1";

/**
 * Select the representative sample from a set of sample IDs that share the
 * same content identity. Returns the lexicographically smallest sampleId.
 *
 * The input array MUST contain at least one element and MUST NOT be empty.
 */
export function selectRepresentative(sampleIds: readonly string[]): string {
  let best = sampleIds[0];
  for (let i = 1; i < sampleIds.length; i++) {
    if (sampleIds[i] < best) best = sampleIds[i];
  }
  return best;
}