/**
 * Global / My Samples — two INDEPENDENT visibility modes over ONE shared 2D
 * sound space.
 *
 * SCOPE / SEMANTICS
 *   The Map stays a single 2D Sound Space (`renderSampleMap`, one `<circle>`
 *   per point). This module is a pure, side-effect-free VISIBILITY layer that
 *   decides which already-persisted records may become map points, and it
 *   never touches the Sound Space coordinate computation
 *   (`mapPosition` is read as-is, never recomputed).
 *
 *   The two toggles are independent, so all four states are meaningful and
 *   the visible set is the UNION, never the intersection:
 *
 *       global OFF / mine OFF -> {}
 *       global ON  / mine OFF -> global
 *       global OFF / mine ON  -> mine
 *       global ON  / mine ON  -> global ∪ mine
 *
 *   DEDUPLICATION (§2): a sample that belongs to BOTH sets yields EXACTLY ONE
 *   point. Membership survives as `isGlobal` / `isMine` so the overlap stays
 *   observable instead of being collapsed away. Identity is the stable
 *   `sampleId`; content-identity grouping inside `mapPoints()` is untouched.
 *
 * DATA SOURCES (no invented metric)
 *   - `mine`  : `SampleIndexRecord.owner` vs. the authenticated user's stable
 *               account id. Both are canonical `users/{slug}` resource names
 *               (the persisted record carries `users/...`, and
 *               `resolveAuthenticatedUserId` returns the same form), so this
 *               is a real comparison — never a display-name guess and never a
 *               popularity/threshold heuristic. No favorites/usages weighting.
 *   - `global`: membership in the EXISTING global sample set, i.e. the
 *               content identities the global index already reports
 *               (`GlobalMapPoint.contentIdentity`). No new popularity metric,
 *               no quality score, no arbitrary threshold is introduced.
 *
 *   HONEST SCOPE LIMITS (documented, not worked around):
 *   - `mineSampleIds` covers EVERY known record regardless of analysis status,
 *     so it is neither viewport-bounded nor limited to analyzed samples. A
 *     record without `audioFeatures` has no `mapPosition` and therefore cannot
 *     produce a point; the membership SET stays complete while the RENDERED
 *     points are the positioned subset.
 *   - The global side reflects whatever the global index reports for the
 *     current viewport page — the pre-existing, deliberately bounded behavior
 *     of `queryMapViewport`. This step does not change that.
 */
import type { GlobalMapPoint } from "../../global/contract";
import { contentIdentityKey } from "../../identity/audioContentIdentity";
import type { SampleIndexRecord } from "../../persistence/indexStore";

/** Per-sample membership in the two visibility sets. Both flags may be true. */
export interface SampleMembership {
  /** The sample is part of the existing global sample set. */
  readonly isGlobal: boolean;
  /** The sample belongs to the authenticated user. */
  readonly isMine: boolean;
}

/** The two independent toggles. */
export interface VisibilityToggles {
  readonly global: boolean;
  readonly mine: boolean;
}

/**
 * Canonical `users/{slug}` guard — rejects blank and whitespace-only identities.
 *
 * Trimming matters: a whitespace-only owner must never compare equal to a
 * whitespace-only authenticated id and be reported as "mine".
 */
function isCanonicalIdentity(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * True iff `owner` is the authenticated user.
 *
 * Both sides must be present and non-empty: an unknown identity yields `false`
 * (never a wrongly claimed "mine"). Mirrors the STEP38 rule that `undefined`
 * means "own detection unavailable" rather than "foreign".
 */
export function isOwnedByAuthenticatedUser(
  owner: string | undefined,
  authenticatedUserId: string | undefined,
): boolean {
  if (!isCanonicalIdentity(owner) || !isCanonicalIdentity(authenticatedUserId)) return false;
  return owner === authenticatedUserId;
}

/**
 * The COMPLETE set of the authenticated user's known samples.
 *
 * Derived from all persisted records in ANY analysis status — deliberately not
 * limited to analyzed records and not limited to the current map viewport.
 */
export function mineSampleIds(
  records: readonly SampleIndexRecord[],
  authenticatedUserId: string | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!isCanonicalIdentity(authenticatedUserId)) return out;
  for (const r of records) {
    if (isOwnedByAuthenticatedUser(r.owner, authenticatedUserId)) out.add(r.sampleId);
  }
  return out;
}

/** Content identities the existing global sample set currently reports. */
export function globalContentIdentities(
  globalPoints: readonly GlobalMapPoint[] | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const p of globalPoints ?? []) out.add(contentIdentityKey(p.contentIdentity));
  return out;
}

/**
 * The global points handed to the map renderer for the current toggle state.
 *
 * The existing global pool contributes points only while Global is on; My
 * Samples alone must not drag in global-only samples. With both toggles off the
 * map gets no global points at all.
 */
export function visibleGlobalPoints(
  globalPoints: readonly GlobalMapPoint[] | undefined,
  toggles: Pick<VisibilityToggles, "global">,
): readonly GlobalMapPoint[] {
  return toggles.global ? (globalPoints ?? []) : [];
}

/** A record's content-identity key, matching the `mapPoints()` grouping rule. */
function recordContentKey(record: SampleIndexRecord): string {
  return record.contentHash
    ? contentIdentityKey({
        contentHash: record.contentHash,
        contentHashVersion: record.contentHashVersion ?? "unknown",
      })
    : `legacy:${record.sampleId}`;
}

export interface MapVisibility {
  /**
   * The records that may become map points, deduplicated by stable `sampleId`
   * with the input order preserved (first occurrence wins).
   */
  readonly visibleRecords: readonly SampleIndexRecord[];
  /** Membership for every VISIBLE record, keyed by `sampleId`. */
  readonly membership: ReadonlyMap<string, SampleMembership>;
  /** Membership for every INPUT record, keyed by `sampleId` (visible or not). */
  readonly membershipAll: ReadonlyMap<string, SampleMembership>;
}

/**
 * Resolve the visible map records for the current toggle state.
 *
 * `records` is whatever the search stage produced (see the pipeline order:
 * full index -> text search -> THIS visibility step -> map dedup -> render).
 * Records outside the toggles are still reported in `membershipAll`, so a
 * sample that is not currently on the map remains findable and inspectable.
 */
export function resolveMapVisibility(
  records: readonly SampleIndexRecord[],
  globalPoints: readonly GlobalMapPoint[] | undefined,
  toggles: VisibilityToggles,
  authenticatedUserId: string | undefined,
): MapVisibility {
  const globalIds = globalContentIdentities(globalPoints);
  const mineIds = mineSampleIds(records, authenticatedUserId);

  const membershipAll = new Map<string, SampleMembership>();
  const visibleRecords: SampleIndexRecord[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    const m: SampleMembership = {
      isGlobal: globalIds.has(recordContentKey(record)),
      isMine: mineIds.has(record.sampleId),
    };
    membershipAll.set(record.sampleId, m);

    const visible = (toggles.global && m.isGlobal) || (toggles.mine && m.isMine);
    if (!visible) continue;
    // Deduplicate by the stable sampleId: one sample => at most one point,
    // even when it is a member of both sets.
    if (seen.has(record.sampleId)) continue;
    seen.add(record.sampleId);
    visibleRecords.push(record);
  }

  const membership = new Map<string, SampleMembership>();
  for (const r of visibleRecords) membership.set(r.sampleId, membershipAll.get(r.sampleId)!);

  return { visibleRecords, membership, membershipAll };
}
