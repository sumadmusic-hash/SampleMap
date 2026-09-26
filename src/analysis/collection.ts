/**
 * STEP27 — V2 Sound Collections: a session-local, user-curated curation layer.
 *
 * A Collection is:
 *   - session-local (never persisted, never in the URL, no IndexedDB writes)
 *   - explicitly user-controlled (never auto-populated, never auto-sorted)
 *   - duplicate-safe (a sampleId exists at most once)
 *   - insertion-ordered (the explicit add order; re-add moves to the end)
 *   - hard-capped at COLLECTION_MAX_SAMPLES (adds past the cap are no-ops; the
 *     user must Remove/Clear first — no automatic eviction)
 *
 * The boundary below is 100% PURE: every function is immutable (new state for a
 * real change, the same object for a no-op), deterministic, and free of any
 * dependency on the DOM, the app, or persistence. Membership is exclusively by
 * `sampleId` (§26) — never by name, index position, or object identity.
 *
 * `summarizeCollection` is the pure character summary: for each canonical
 * SoundCharacter dimension it computes the arithmetic mean over PRESENT values
 * (null/absent are ignored, never treated as 0); a dimension with no present
 * value anywhere is `null` ("—" in the UI). O(8N), no pairwise work, no audio,
 * no DSP, no ML.
 *
 * STEP27 consumes the frozen V2 systems read-only (SoundCharacter + config);
 * it never mutates them.
 */
import { SOUND_CHARACTER_DIMENSIONS } from "./config";
import type { SoundCharacter } from "./soundCharacter";
import type { SampleIndexRecord } from "../persistence/indexStore";

/** Pins the STEP27 collection layer (separate from the frozen V1/V2 versions). */
export const COLLECTION_VERSION = "1.0.0" as const;

/** Hard collection cap (§8): adds past this count are no-ops. */
export const COLLECTION_MAX_SAMPLES = 50;

/** The 8 canonical SoundCharacter dim keys as a tuple (config-owned order). */
export type SoundCharacterDimensionKey =
  (typeof SOUND_CHARACTER_DIMENSIONS)[number];

/**
 * The pure collection model. `sampleIds` is the EXPLICIT insertion order;
 * `open` is the panel visibility. Session-local only.
 */
export interface SoundCollectionState {
  readonly sampleIds: readonly string[];
  readonly open: boolean;
}

/** The safe initial collection (closed, empty). */
export function emptyCollectionState(): SoundCollectionState {
  return { sampleIds: [], open: false };
}

/** Whether `sampleId` is a collection member (identity is the id, §26). */
export function collectionContains(
  collection: SoundCollectionState,
  sampleId: string,
): boolean {
  return collection.sampleIds.includes(sampleId);
}

/** Whether the collection is at the hard cap (adds are then no-ops). */
export function isCollectionFull(collection: SoundCollectionState): boolean {
  return collection.sampleIds.length >= COLLECTION_MAX_SAMPLES;
}

/**
 * Add a sample: append to the END of the explicit order. A duplicate re-add
 * MOVES the member to the end (order refresh — never a duplicate); an add past
 * the hard cap is a no-op (no automatic removal — §8). Immutable.
 */
export function addToCollection(
  collection: SoundCollectionState,
  sampleId: string,
): SoundCollectionState {
  if (!collectionContains(collection, sampleId)) {
    if (isCollectionFull(collection)) return collection;
    return { ...collection, sampleIds: [...collection.sampleIds, sampleId] };
  }
  // Re-add: move to the end of the explicit order. Already last → same state.
  if (collection.sampleIds[collection.sampleIds.length - 1] === sampleId) {
    return collection;
  }
  return {
    ...collection,
    sampleIds: [...collection.sampleIds.filter((id) => id !== sampleId), sampleId],
  };
}

/**
 * Remove a sample (all occurrences — duplicates cannot exist, so at most one).
 * Remaining members keep their relative explicit order. Unknown id → no-op.
 * Immutable.
 */
export function removeFromCollection(
  collection: SoundCollectionState,
  sampleId: string,
): SoundCollectionState {
  if (!collectionContains(collection, sampleId)) return collection;
  return {
    ...collection,
    sampleIds: collection.sampleIds.filter((id) => id !== sampleId),
  };
}

/**
 * Toggle membership: present → remove; absent → add (cap still applies). Only
 * the collection may observe this — focus/selection/preview/etc. are untouched.
 */
export function toggleCollectionSample(
  collection: SoundCollectionState,
  sampleId: string,
): SoundCollectionState {
  return collectionContains(collection, sampleId)
    ? removeFromCollection(collection, sampleId)
    : addToCollection(collection, sampleId);
}

/**
 * Empty the collection. `open` (panel visibility) survives. Empty → no-op
 * (returns the same collection). Immutable.
 */
export function clearCollection(
  collection: SoundCollectionState,
): SoundCollectionState {
  if (collection.sampleIds.length === 0) return collection;
  return { ...collection, sampleIds: [] };
}

/**
 * The arithmetic-mean character summary of the given records, dimension by
 * dimension, PRESENT VALUES ONLY. For each canonical dim:
 *   mean(present values)   // null/absent records are ignored, never 0
 * A dim with no present value anywhere is `null` ("—"). When NO dimension has
 * ANY present value across the whole collection (or there are no records), the
 * summary itself is `null` (the surface renders "—"). Deterministic (record
 * order → accumulation order), O(8N), read-only.
 */
export type SoundCharacterSummary = {
  [K in SoundCharacterDimensionKey]: number | null;
};

export function summarizeCollection(
  records: readonly SampleIndexRecord[],
): SoundCharacterSummary | null {
  const out = {} as SoundCharacterSummary;
  let anyPresent = false;
  for (const dim of SOUND_CHARACTER_DIMENSIONS) {
    let sum = 0;
    let count = 0;
    for (const rec of records) {
      const ch: SoundCharacter | null | undefined =
        rec.analysisV2?.soundCharacter;
      const v = ch?.[dim] ?? null;
      if (v !== null && Number.isFinite(v)) {
        sum += v;
        count += 1;
        anyPresent = true;
      }
    }
    out[dim] = count === 0 ? null : sum / count;
  }
  if (!anyPresent) return null;
  return out;
}

/** SoundCharacter view of a record, or null when there is none (§25 nulls). */
export function collectionCharacterOf(
  record: SampleIndexRecord | undefined,
): SoundCharacter | null {
  return record?.analysisV2?.soundCharacter ?? null;
}