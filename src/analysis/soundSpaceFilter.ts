/**
 * STEP25 — pure Sound Space filter boundary.
 *
 * This module knows NOTHING about rendering, IndexedDB, the app's selection,
 * or the projector math. It is a pure, deterministic predicate layer over
 * (records, SoundCharacter) that answers one question:
 *
 *   "Does this record pass the currently active Sound Space filter?"
 *
 * Semantics (STEP25 §6/§7/§8):
 *   - Each of the eight canonical SoundCharacter dimensions has an optional
 *     inclusive [min,max] range.
 *   - A dimension's default range [0, 1] is INACTIVE (an "all pass" noop) —
 *     the filter is present but narrows nothing.
 *   - A record matches an active dimension only when its value is within
 *     [min, max] inclusive.
 *   - A dimension that is `null` / missing on the record fails the filter for
 *     that dimension (§8: "Fall out of the filter" — never fabricate).
 *   - The record must match EVERY active dimension (AND semantics over the set
 *     of active dims).
 *   - Coordinates are NEVER touched; the projection is orthogonal.
 *
 * Empty-result behavior: when nothing matches, the Sound Space renders an
 * "All samples / N of M samples" empty-line plus the SECTION header — never a
 * crash, never a LATENT second truth (the downstream surface keeps the
 * original Snapshot).
 */
import type { SoundCharacter } from "./soundCharacter";
import type { SampleIndexRecord } from "../persistence/indexStore";
import type { SoundSpacePoint } from "./soundSpaceProjector";

/** One inclusive numeric range. */
export interface RangeFilter {
  min: number;
  max: number;
}

/**
 * The filter shape: keyed by the canonical SoundCharacter dimension names.
 * A missing key means the dimension is not part of the active filter.
 */
export type SoundSpaceCharFilter = Partial<
  Record<
    "brightness" | "density" | "transient" | "duration" | "tonality" | "noisiness" | "dynamics" | "complexity",
    RangeFilter
  >
>;

/** Canonical names of the eight dims, in canonical order. */
export const SOUND_SPACE_DIM_NAMES = [
  "brightness",
  "density",
  "transient",
  "duration",
  "tonality",
  "noisiness",
  "dynamics",
  "complexity",
] as const;

/** The neutral, all-passing identity filter. */
export function emptySoundSpaceFilter(): SoundSpaceCharFilter {
  return {};
}

/**
 * A range is ACTIVE only when it narrows beyond [0, 1]. A range that covers
 * the full unit interval is present-but-inactive (a noop).
 */
export function isRangeActive(r: RangeFilter | undefined): boolean {
  if (!r) return false;
  return r.min > 0 || r.max < 1;
}

/** Whether any dimension of the filter is active at all. */
export function isFilterActive(filter: SoundSpaceCharFilter): boolean {
  return SOUND_SPACE_DIM_NAMES.some((d) => isRangeActive(filter[d]));
}

/**
 * The pure predicate: does a SoundCharacter pass the filter?
 *
 * Rules per dimension (STEP25 §7/§8):
 *   1. If a dimension is missing or null on the record → record fails the
 *      dimension.
 *   2. If a dimension on the record is a number within [min, max] (inclusive)
 *      → pass.
 *   3. A dimension with the inactive default range always passes.
 *
 * The filter is silent on out-of-band dims — they pass (they fail no
 * dimension).
 */
export function matchesSoundCharacter(
  char: SoundCharacter,
  filter: SoundSpaceCharFilter,
): boolean {
  for (const dim of SOUND_SPACE_DIM_NAMES) {
    const range = filter[dim];
    if (!isRangeActive(range)) continue;
    const v = char[dim];
    // Missing dims fail the filter (null stays missing — no silent 0).
    if (v === null || v === undefined) return false;
    if (v < range!.min || v > range!.max) return false;
  }
  return true;
}

/**
 * Whether a record passes the filter. Records without a valid V2
 * soundCharacter behave exactly like their character dictates — no V2 → not
 * projectable in the Sound Space anyway, so they answer via their character
 * alone; the visible-point pipeline must not create a synthetic entry.
 */
export function recordMatchesFilter(
  record: SampleIndexRecord,
  filter: SoundSpaceCharFilter,
): boolean {
  if (!record.analysisV2 || record.analysisV2.soundCharacter === undefined) {
    // A V1-only record has no character: with an active filter the row fails
    // every dimension (§8 — missing dims fail).
    return SOUND_SPACE_DIM_NAMES.every((d) => !isRangeActive(filter[d]));
  }
  return matchesSoundCharacter(record.analysisV2.soundCharacter, filter);
}

/**
 * Filter a Sound Space snapshot's points by projectable index records.
 *
 * The projection is never recomputed — we filter AT the point level using
 * the records behind the points (same snapshot). Candidate ordering and
 * output ordering mirror the input.
 */
export function filterSoundSpacePoints(
  points: SoundSpacePoint[],
  recordsById: ReadonlyMap<string, SampleIndexRecord>,
  filter: SoundSpaceCharFilter,
  searchIds?: ReadonlySet<string>,
): SoundSpacePoint[] {
  return points.filter((p) => {
    const rec = recordsById.get(p.sampleId);
    if (!rec) return false;
    if (searchIds && !searchIds.has(p.sampleId)) return false;
    return recordMatchesFilter(rec, filter);
  });
}

/** Clamp a nominal [min,max] pair into a valid inclusive range in [0,1]. */
export function normalizeRange(min: number, max: number): RangeFilter {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return {
    min: lo < 0 ? 0 : lo > 1 ? 1 : lo,
    max: hi > 1 ? 1 : hi < 0 ? 0 : hi,
  };
}
