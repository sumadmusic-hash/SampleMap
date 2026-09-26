/**
 * STEP38 — Analysis Eligibility, One-Shot-First Prioritization & Semantic
 * Classification: eligibility + deterministic priority ordering boundary.
 *
 * PURPOSE
 *   Analysis eligibility is a DISCOVERY/ACCOUNTING concern, distinct from
 *   discovery ranking and from map visibility. It decides whether a sample is
 *   AUTO-ENQUEUED for analysis during a library scan. It is:
 *
 *     - DETERMINISTIC and pure (side-effect free, never reads/writes stores).
 *     - USER-RELATIVE: eligibility to AUTO-ANALYZE depends on the authenticated
 *       Audiotool identity (the stable `users/{uuid}` account id, NOT the
 *       display name).
 *     - A GATE ONLY: it gates automatic queueing; it never deletes already
 *       analyzed records (no retroactive deletion, STEP38 §10) and never forces
 *       re-analysis on a metadata change.
 *     - RELEVANCE-SAFE (§22): `numFavorites` / `numUsages` are relevance
 *       signals used ONLY here (and in the metadata slice). They are NEVER
 *       folded into confidence, classification, similarity or map coordinates.
 *
 * RULES (§5 / §6):
 *   - OWN sample  (owner === authenticatedUserId, stable id)  → ALWAYS eligible.
 *   - FOREIGN sample → eligible iff `numFavorites >= 1` OR `numUsages >= 1`.
 *   - MISSING/undefined values are NEVER coerced positive: `undefined` is
 *     treated as 0 (a record without counters contributes exactly 0, so it can
 *     never unlock eligibility). Values are never clamped up.
 *   - When `authenticatedUserId` is undefined (identity not resolvable) OWN
 *     detection is UNAVAILABLE: the sample is evaluated under foreign rules —
 *     never wrongly promoted to own.
 *
 * PRIORITY (§11): eligible samples are enqueued with a deterministic
 * `priorityGroup` so the queue drains ONE-SHOTS BEFORE LOOPS, and OWN before
 * FOREIGN. The order is:
 *
 *     0  own  one-shot
 *     1  other one-shot
 *     2  own  loop
 *     3  other loop
 *     4  own  unknown
 *     5  other unknown
 *
 * The `kind` values are the persisted ones ("one-shot" | "loop" | "unknown");
 * the existing SampleKind is reused, no new dtype is introduced.
 */
import type { SampleMeta } from "@audiotool/nexus/api";
import type { SampleIndexRecord } from "../persistence/indexStore";

/** Version of the eligibility + prioritization semantics. */
export const ELIGIBILITY_ALGORITHM_VERSION = "1.0.0" as const;

/** Stable reason labels. Every outcome is one of these six. */
export type EligibilityReason =
  | "own"
  | "foreign-favorite-and-usage"
  | "foreign-favorite"
  | "foreign-usage"
  | "foreign-no-signal"
  | "identity-unavailable";

export interface AnalysisEligibility {
  /** Whether the sample may be auto-enqueued for analysis. */
  eligible: boolean;
  /** True iff this sample belongs to the authenticated user (stable id). */
  own: boolean;
  /** Stable, deterministic reason string (§5). */
  reason: EligibilityReason;
}

/** Primitive eligibility inputs — the pure contract (any producer fits). */
export interface EligibilityInput {
  /** Stable owner account id (`users/{uuid}`) — NOT a display name. */
  owner: string | undefined;
  /** Audiotool favorites counter; `undefined`/missing → treated as 0. */
  numFavorites: number | undefined;
  /** Audiotool usages counter; `undefined`/missing → treated as 0. */
  numUsages: number | undefined;
  /** Authenticated user's stable account id; `undefined` → own unknown. */
  authenticatedUserId: string | undefined;
}

/**
 * Pure, deterministic analysis-eligibility decision (§5/§6).
 *
 *   - OWN: owner === authenticatedUserId  → always eligible.
 *   - FOREIGN: eligible iff favorites >= 1 OR usage >= 1.
 *   - Missing/undefined counters are `0` — never coerced positive.
 *   - Missing identity → foreign rules (never wrongly claimed own).
 */
export function computeAnalysisEligibility(
  input: EligibilityInput,
): AnalysisEligibility {
  const { owner, numFavorites, numUsages, authenticatedUserId } = input;

  const own =
    owner !== undefined &&
    owner.length > 0 &&
    authenticatedUserId !== undefined &&
    authenticatedUserId.length > 0 &&
    owner === authenticatedUserId;

  if (own) {
    return { eligible: true, own: true, reason: "own" };
  }

  const favorites = typeof numFavorites === "number" && Number.isFinite(numFavorites) ? Math.max(0, numFavorites) : 0;
  const usage = typeof numUsages === "number" && Number.isFinite(numUsages) ? Math.max(0, numUsages) : 0;

  const favSignal = favorites >= 1;
  const usageSignal = usage >= 1;

  if (favSignal && usageSignal) {
    return { eligible: true, own: false, reason: "foreign-favorite-and-usage" };
  }
  if (favSignal) {
    return { eligible: true, own: false, reason: "foreign-favorite" };
  }
  if (usageSignal) {
    return { eligible: true, own: false, reason: "foreign-usage" };
  }

  // No foreign relevance signal: distinguish "no signal at all" from "identity
  // is unavailable so OWN cannot even be detected". Both are ineligible, but
  // the reason must stay honest (§6 — never wrongly claimed own).
  if (authenticatedUserId === undefined || authenticatedUserId.length === 0) {
    return { eligible: false, own: false, reason: "identity-unavailable" };
  }
  return { eligible: false, own: false, reason: "foreign-no-signal" };
}

/** Adapter for the discovery/scan SampleMeta contract. */
export function computeEligibilityFromMeta(
  meta: SampleMeta,
  authenticatedUserId: string | undefined,
): AnalysisEligibility {
  return computeAnalysisEligibility({
    owner: meta.ownerName,
    numFavorites: meta.numFavorites,
    numUsages: meta.numUsages,
    authenticatedUserId,
  });
}

/** Adapter for the persisted record contract. */
export function computeEligibilityFromRecord(
  record: SampleIndexRecord,
  authenticatedUserId: string | undefined,
): AnalysisEligibility {
  return computeAnalysisEligibility({
    owner: record.owner,
    numFavorites: record.numFavorites,
    numUsages: record.numUsages,
    authenticatedUserId,
  });
}

/** Deterministic priority tiers (STEP38 §11). Order is the sort key. */
export type PriorityGroup =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5;

/** Priority for legacy jobs persisted before priority groups existed. */
export const PRIORITY_GROUP_LEGACY: PriorityGroup = 5;

/** Human labels for diagnostics/UI — stable display copy. */
export const PRIORITY_GROUP_LABELS: Record<PriorityGroup, string> = {
  0: "own one-shot",
  1: "other one-shot",
  2: "own loop",
  3: "other loop",
  4: "own other",
  5: "other other",
};

/**
 * Deterministic priority group of a sample: OWN before FOREIGN, ONE-SHOT
 * before LOOP, unknown kind mapping within its own tier. Pure function of the
 * (`owner`, `kind`, `authenticatedUserId`) triple — no I/O, no side effects.
 * Reuses the existing persisted `kind` values ("one-shot" / "loop" / anything
 * else → "unknown" tier).
 */
export function priorityGroupOf(input: {
  owner: string | undefined;
  kind: string | undefined;
  authenticatedUserId: string | undefined;
}): PriorityGroup {
  const { owner, kind, authenticatedUserId } = input;
  const own =
    owner !== undefined &&
    owner.length > 0 &&
    authenticatedUserId !== undefined &&
    authenticatedUserId.length > 0 &&
    owner === authenticatedUserId;

  const k = (kind ?? "unknown").trim().toLowerCase();
  const tier = k === "one-shot" ? 0 : k === "loop" ? 1 : 2;
  const ownOffset = own ? 0 : 1;
  return (tier * 2 + ownOffset) as PriorityGroup;
}

/** Adapter for the scan SampleMeta contract. */
export function priorityGroupOfMeta(
  meta: SampleMeta,
  authenticatedUserId: string | undefined,
): PriorityGroup {
  return priorityGroupOf({
    owner: meta.ownerName,
    kind: meta.kind,
    authenticatedUserId,
  });
}