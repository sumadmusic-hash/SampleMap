import type { SampleIndexRecord, SecondaryClass } from "../persistence/indexStore";
import { ALL_CLASSES, TAXONOMY } from "../classify/taxonomy";
import { EMPTY_MAP_MESSAGE } from "./map/mapView";
import { MAX_BATCH_SLOTS } from "../machiniste/machinisteService";
import type { PublishQueueItem } from "../global/publishQueue";
import type { SimilarityState } from "./app";
import type { SoundSpaceCharFilter } from "../analysis/soundSpaceFilter";
import type { SoundCharacter } from "../analysis/soundCharacter";

/**
 * View-models for the SampleMap UI (SAMPLEMAP_V1_SPEC §13).
 *
 * These are PURE projection functions: they map a persisted `SampleIndexRecord`
 * onto display structures. They contain NO business logic (no classification,
 * no searching, no persistence) — they only shape data for rendering. They are
 * intentionally framework- and DOM-free so they are deterministically testable
 * and reused by the thin DOM renderer.
 *
 * Invariant §INV-2 (Tags ≠ classification) is enforced structurally here: the
 * classification view is derived solely from the record's `primaryClass`,
 * `confidence`, `secondaryClasses` and NEVER from `originalTags`. The tags are
 * exposed as a separate `originalTags` list.
 */

/** The classification block shown in the detail view (never derived from tags). */
export interface ClassificationView {
  primaryClass: string;
  confidence: number;
  secondaryClasses: SecondaryClass[];
}

/** Audio-feature block — only fields that actually exist on the record. */
export type FeatureView = Record<string, number>;

/**
 * Musical metadata block — Audiotool BPM. `null` means "no tempo set" (`bpm===0`
 * is preserved as a source value but displayed as "—"). Never a score.
 */
export interface MusicalView {
  /** Raw Audiotool BPM; `0` → "not set"; `undefined` on legacy records. */
  bpm: number | null;
}

/**
 * Community metadata block — raw Audiotool counters. These are raw numbers, NOT
 * ratings, NOT a popularity score, and are NEVER folded into confidence/relevance.
 */
export interface CommunityView {
  /** Raw Audiotool favorites counter (>= 0), or null when unavailable. */
  numFavorites: number | null;
  /** Raw Audiotool usages counter (>= 0), or null when unavailable. */
  numUsages: number | null;
}

/** The separated detail-view structure shown for a selected sample. */
export interface DetailView {
  name: string;
  owner: string;
  kind: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  /** Classification block — from primaryClass/confidence/secondaryClasses only. */
  classification: ClassificationView;
  /** Audiotool original tags — kept strictly separate from classification. */
  originalTags: string[];
  /** Audio features — from record.audioFeatures only. */
  features: FeatureView;
  /** Musical metadata block (BPM). Strictly separate from scores. */
  musical: MusicalView;
  /** Community metadata block (raw favorites/usages counters). */
  community: CommunityView;
}

/** A compact row shown in the results list. */
export interface ResultView {
  sampleId: string;
  name: string;
  primaryClass: string;
  confidence: number;
  /** Semicolon-joined secondary class names (empty if none). */
  secondaryLabel: string;
  /** Original tags, joined for display only (never fused into a class label). */
  originalTags: string[];
  durationLabel: string;
  status: string;
}

/** Build the separated detail view for one record. */
export function detailView(record: SampleIndexRecord): DetailView {
  const features: FeatureView = {};
  const af = record.audioFeatures;
  if (record.audioFeatures) {
    for (const key of [
      "duration",
      "sampleRate",
      "channels",
      "rms",
      "peak",
      "transientDensity",
      "spectralCentroid",
      "spectralBandwidth",
      "spectralRolloff",
      "zeroCrossingRate",
      "spectralFlatness",
      "attack",
      "tonalNoiseRatio",
    ]) {
      const v = (af as unknown as Record<string, number>)[key];
      if (typeof v === "number") features[key] = v;
    }
  }
  return {
    name: record.name,
    owner: record.owner,
    kind: record.kind,
    durationSeconds: af?.duration ?? 0,
    sampleRate: af?.sampleRate ?? 0,
    channels: af?.channels ?? 0,
    classification: {
      primaryClass: record.primaryClass,
      confidence: record.confidence,
      secondaryClasses: (record.secondaryClasses ?? []).map((c) => ({ ...c })),
    },
    originalTags: (record.originalTags ?? []).map((t) => t),
    features,
    musical: {
      // bpm===0 is a preserved source value rendered as "—"; keep null when a
      // legacy record simply has no BPM.
      bpm: record.bpm === undefined ? null : record.bpm,
    },
    community: {
      numFavorites: record.numFavorites ?? null,
      numUsages: record.numUsages ?? null,
    },
  };
}

/** Build a compact result-row view for one record. */
export function resultView(record: SampleIndexRecord): ResultView {
  const secondary = (record.secondaryClasses ?? [])
    .map((c) => c.class)
    .join(", ");
  return {
    sampleId: record.sampleId,
    name: record.name,
    primaryClass: record.primaryClass,
    confidence: record.confidence,
    secondaryLabel: secondary,
    originalTags: (record.originalTags ?? []).map((t) => t),
    durationLabel: durationLabel(record.audioFeatures?.duration ?? 0),
    status: record.status,
  };
}

/** Format a duration in seconds, e.g. `0.82s`. */
export function durationLabel(seconds: number): string {
  if (!Number.isFinite(seconds)) return "?s";
  return `${seconds.toFixed(2)}s`;
}

export interface ClassFilterGroup {
  id: string;
  label: string;
  /** If empty, the group is a plain class id; if present, it expands to members. */
  classes: string[];
}

/**
 * Taxonomy-driven class filter options for the UI.
 * Derived exclusively from the existing taxonomy (never invented).
 * Groups carry their member classes (the SearchEngine expands group names).
 */
export interface ClassFilterOptions {
  /** "All" pseudo-option (clears the class filter). */
  all: { id?: undefined; label: "All" };
  /** Group options: drums / musical / other. */
  groups: ClassFilterGroup[];
  /** Every individual class id (in taxonomy order). */
  classes: string[];
}

export function classFilterOptions(): ClassFilterOptions {
  const groups: ClassFilterGroup[] = [
    { id: "drums", label: "Drums", classes: [...TAXONOMY.drums] },
    { id: "musical", label: "Musical", classes: [...TAXONOMY.musical] },
    { id: "other", label: "Other", classes: [...TAXONOMY.other] },
  ];
  return { all: { id: undefined, label: "All" }, groups, classes: [...ALL_CLASSES] };
}

/** Sort options exposed by the SearchEngine (passed straight through). */
export const SORT_OPTIONS: { id: "relevance" | "confidence" | "name" | "analyzedAt"; label: string }[] = [
  { id: "relevance", label: "Relevance" },
  { id: "confidence", label: "Confidence" },
  { id: "name", label: "Name" },
  { id: "analyzedAt", label: "Analyzed At" },
];

/** The three controlled analysis budgets (spec §5.0 / §INV-3). */
export const ANALYSIS_BUDGETS = [10, 100, 1000] as const;

// ---------------------------------------------------------------------------
// Step 15D — search/filter UI projection (pure, SearchEngine stays untouched)
// ---------------------------------------------------------------------------

/** The structured-filter criteria exposed by the Filter panel (E-P4). */
export interface FilterState {
  text: string;
  classes: readonly string[];
  minConfidence: number | undefined;
}

/** Whether any search/filter criterion is currently active. */
export function hasActiveSearch(st: FilterState): boolean {
  return (
    st.text.trim().length > 0 ||
    st.classes.length > 0 ||
    st.minConfidence !== undefined
  );
}

/** Number of active search/filter criteria (0..3) — the filter-panel badge. */
export function activeFilterCount(st: FilterState): number {
  let n = 0;
  if (st.text.trim().length > 0) n++;
  if (st.classes.length > 0) n++;
  if (st.minConfidence !== undefined) n++;
  return n;
}

/** Human label for a class or taxonomy-group token ("kick" / "Drums"). */
function classOrGroupLabel(token: string): string {
  const g = classFilterOptions().groups.find((grp) => grp.id === token);
  return g ? g.label : token;
}

/**
 * Compact one-line summary of the active filter criteria ("Class: kick ·
 * Confidence ≥ 0.65"). Empty string when nothing is filtered. Derived purely
 * from `FilterState`; used by the Filter panel's active-state line (E-P4.2).
 */
export function activeFilterSummary(st: FilterState): string {
  const parts: string[] = [];
  if (st.text.trim().length > 0) parts.push(`Query: "${st.text.trim()}"`);
  for (const t of st.classes) {
    parts.push(
      classFilterOptions().groups.some((g) => g.id === t)
        ? `Group: ${classOrGroupLabel(t)}`
        : `Class: ${classOrGroupLabel(t)}`,
    );
  }
  if (st.minConfidence !== undefined) {
    parts.push(`Confidence ≥ ${String(st.minConfidence)}`);
  }
  return parts.join(" · ");
}

/** Human label for a sort id ("relevance" → "Relevance"), falling back to the id. */
export function sortLabel(id: string): string {
  return SORT_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

/** Empty-state label when nothing is filtered. */
export const NO_ANALYZED_MESSAGE = EMPTY_MAP_MESSAGE;
/** Empty-state label when a search/filter produced no matches. */
export const NO_MATCH_MESSAGE = "No samples match your search.";

/** Distinguish the two Step-15D empty states (spec §14). */
export function emptyStateMessage(hasFilter: boolean): string {
  return hasFilter ? NO_MATCH_MESSAGE : NO_ANALYZED_MESSAGE;
}

/** Compact count label derived from the current SearchEngine results. */
export function resultCountLabel(count: number): string {
  return `${count} ${count === 1 ? "sample" : "samples"}`;
}

/**
 * Step 15E — optional inspector display of the sample's 2D map position.
 * Returns undefined when the record carries no persisted V2 `mapPosition`
 * (Missing-V2). Values come EXCLUSIVELY from the persisted analysis result —
 * they are read on demand and never recomputed from `audioFeatures`.
 */
export function detailMapPosition(
  record: SampleIndexRecord,
): { x: number; y: number } | undefined {
  if (!record.mapPosition) return undefined;
  return { x: record.mapPosition.x, y: record.mapPosition.y };
}

// ---------------------------------------------------------------------------
// STEP16R E-P2 — canonical product copy (labels only, no semantics)
// ---------------------------------------------------------------------------

/**
 * Inspector "Map Position" line (16R DECISION #15). Missing-V2 renders the
 * canonical frozen string; otherwise the persisted V2 position (3-dp, never
 * recomputed from features).
 */
export function mapPositionLabel(
  pos: { x: number; y: number } | undefined,
): string {
  if (!pos) return "Map position unavailable";
  return `X: ${pos.x.toFixed(3)}  Y: ${pos.y.toFixed(3)}`;
}

/** Human English read of the Library-Scan status (raw state leaks never shown). */
export function scanStatusLabel(status: string): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "scanning":
      return "Scanning";
    case "done":
      return "Complete";
    case "error":
      return "Failed";
    default:
      return status;
  }
}

/**
 * STEP38 — the eligibility-gate readout of the last scan. `eligible` = samples
 * that passed the gate and were AUTO-enqueued (own + foreign-with-signal);
 * `skipped` = discovered samples that were NOT auto-enqueued (foreign with
 * zero favorites AND zero usage / identity unresolved). Deterministic copy.
 */
export function scanEligibilityLabels(s: {
  eligibleEnqueued: number;
  ineligibleSkipped: number;
}): string {
  return `Eligible: ${s.eligibleEnqueued}  Skipped: ${s.ineligibleSkipped}`;
}

/**
 * Analysis-progress panel labels (E-P2): final English product copy for the
 * analyzed/failed/remaining counters. `remaining` is undefined when no budget /
 * uncontrolled runs; it renders as an em dash exactly as before.
 */
export function analysisProgressLabels(
  a: { analyzed: number; failed: number },
  remaining: number | undefined,
): { analyzed: string; failed: string; remaining: string } {
  return {
    analyzed: `Analyzed: ${a.analyzed}`,
    failed: `Failed: ${a.failed}`,
    remaining: `Remaining: ${remaining === undefined ? "—" : String(remaining)}`,
  };
}

// ---------------------------------------------------------------------------
// FINAL UI/UX v1.1 Phase 1 — action-bar / selection-state projections (pure)
// ---------------------------------------------------------------------------

/**
 * The action-bar count text for a batch selection size (FINAL_UI_UX §18.1).
 * Mirrors the spec's count states; `max` is the V1 cap (8). Intermediates read
 * `N of max selected` and the full batch reads `max of max selected (limit
 * reached)`, so the cap is always stated on the single count surface.
 */
export function selectionCountLabel(
  count: number,
  max: number = MAX_BATCH_SLOTS,
): string {
  if (count >= max) return `${max} of ${max} selected (limit reached)`;
  if (count <= 0) return "No samples selected";
  return `${count} of ${max} selected`;
}

/**
 * E-P3 16R — concise validation guidance for the send panel. States only the
 * constraints the existing pipeline already enforces (machiniste id resolves;
 * slots are numbered from the starting slot upward) — nothing invented here.
 */
export const SEND_PANEL_HINT =
  "The id must match an existing Machiniste; slots are numbered from the starting slot upward.";

/**
 * The persistent `N / 8` selection pill (FINAL_UI_UX §17.4 / §18.1).
 * Clamped to the valid range so the pill can never overshoot the batch cap.
 */
export function selectionPillLabel(
  count: number,
  max: number = MAX_BATCH_SLOTS,
): string {
  const c = Math.min(Math.max(0, Math.floor(count)), max);
  return `${c} / ${max}`;
}

/**
 * Whether the FIRST-USE empty-state overlay should be shown on the map region
 * (FINAL_UI_UX §25): no analyzed results, no active search/filter, and the
 * (bounded) library scan has never completed — so the user sees the canonical
 * `No analyzed samples yet.` experience with the indexing CTA.
 */
export function shouldShowFirstUse(
  resultCount: number,
  scanStatus: string,
  hasFilter: boolean,
): boolean {
  return resultCount === 0 && !hasFilter && scanStatus === "idle";
}

// ---------------------------------------------------------------------------
// STEP16R E-P6 — Global publish-status surface (pure projection)
// ---------------------------------------------------------------------------

/**
 * The E-P6 sample publish status (STEP16R §E-P6 / frozen invariant #9 — the
 * 7-step semantic chain). `none` means the sample has no publish state at all:
 * never usage-accepted, never queued. `pending` is a first-class, non-error
 * state ("accepted & queued, not yet delivered"). The terminal and transient
 * states (conflict / rejected / temporary-unavailable) are ONLY ever derived
 * from a concrete queue outcome — never guessed from `delivery: "pending"`.
 */
export type PublishStatus =
  | "none"
  | "pending"
  | "stored"
  | "known"
  | "conflict"
  | "rejected"
  | "temporary-unavailable";

/**
 * E-P6 delivery mode: `offline` (offline-first, no live worker configured —
 * every publish is retryable/temporary-unavailable; the Local map still works
 * independently) or `live` (a live worker/provider is configured). This is a
 * read-only reflection of the provider already wired at bootstrap.
 */
export type PublishDeliveryMode = "offline" | "live";

/** Reason hints that classify a rejected outcome as retryable-temporary. */
const TEMPORARY_REASON_HINTS: readonly string[] = [
  "temporary-unavailable",
  "rate-limited",
  "rate limited",
];

function outcomeReason(item: PublishQueueItem): string {
  if (item.lastOutcome && item.lastOutcome.status === "rejected") {
    return item.lastOutcome.reason;
  }
  return item.lastError ?? "";
}

function isConflictOutcome(item: PublishQueueItem): boolean {
  return outcomeReason(item).toLowerCase().includes("conflict");
}

function isTemporaryOutcome(item: PublishQueueItem): boolean {
  const reason = outcomeReason(item).toLowerCase();
  if (TEMPORARY_REASON_HINTS.some((h) => reason.includes(h))) return true;
  // A transport failure that exhausted its retries leaves only `lastError`
  // (no per-item outcome) — it is an unavailability, not a payload rejection.
  // A user-initiated cancellation is NOT an outcome at all (see below).
  return (
    item.status === "failed" &&
    !item.lastOutcome &&
    item.lastError !== undefined &&
    item.lastError !== "cancelled"
  );
}

/**
 * Select the queue item the E-P6 projection must use for a sample when the
 * snapshot holds MULTIPLE items for the same sampleId (BUG #1 / STEP16V).
 *
 * The queue snapshot is append-ordered, so the NEWEST item wins: a stale
 * terminal item (e.g. an old conflict) must never mask a newer publish state
 * (e.g. re-accept → succeeded). This is a pure, testable selector — render.ts
 * calls it with the read-only snapshot and never mutates the queue.
 */
export function newestPublishItem(
  snapshot: readonly PublishQueueItem[],
  sampleId: string,
): PublishQueueItem | undefined {
  let item: PublishQueueItem | undefined;
  for (const candidate of snapshot) {
    if (candidate.sampleId === sampleId) item = candidate;
  }
  return item;
}

/**
 * Project the E-P6 status for one sample from the persisted usage-acceptance
 * marker and the current queue item (if any).
 *
 * Priority (STEP16T §4 — never mutated by the UI; purely read-only):
 *   1. the specific CURRENT queue outcome wins (stored / already-known →
 *      stored / known; conflict / rejected / temporary-unavailable are shown
 *      verbatim and never downgraded to pending/published);
 *   2. a queue item WITHOUT a concrete outcome (pending / in-flight) and the
 *      persisted delivery state are the fallback — delivery "published" maps
 *      to `stored`, delivery "pending" maps to `pending`;
 *   3. no marker and no item → `none`.
 *
 * Guarantees: `conflict` / `rejected` / `temporary-unavailable` are NEVER
 * inferred from the mere ABSENCE of an outcome — a concrete outcome is required.
 * A `published` marker is never overridden by a stale pending queue item.
 */
export function publishStatusFor(
  marker: SampleIndexRecord["globalPublish"],
  item: PublishQueueItem | undefined,
): PublishStatus {
  if (item && item.status === "succeeded") {
    return item.lastOutcome?.status === "already-known" ? "known" : "stored";
  }
  if (item && item.status === "retryable") {
    return "temporary-unavailable";
  }
  // A terminal item with a concrete outcome is shown verbatim. A user-initiated
  // cancellation (lastError="cancelled", no backend outcome) and pending/
  // in-flight items fall through to the persisted marker (frozen #9 — never
  // fabricate a terminal state without a concrete outcome).
  const isCancelled = item?.status === "failed" && item.lastError === "cancelled";
  if (item && item.status === "failed" && !isCancelled) {
    if (isConflictOutcome(item)) return "conflict";
    if (isTemporaryOutcome(item)) return "temporary-unavailable";
    return "rejected";
  }
  if (marker) {
    return marker.delivery === "published" ? "stored" : "pending";
  }
  return "none";
}

/** Canonical E-P6 status label (product copy, not raw state). */
export function publishStatusLabel(status: PublishStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "stored":
      return "Stored";
    case "known":
      return "Known";
    case "conflict":
      return "Conflict";
    case "rejected":
      return "Rejected";
    case "temporary-unavailable":
      return "Temporary unavailable";
    case "none":
      return "None";
  }
}

/** Canonical E-P6 delivery line (offline-first vs live worker). */
export function publishDeliveryLabel(mode: PublishDeliveryMode): string {
  return mode === "live"
    ? "Live worker"
    : "Offline / waiting for live provider";
}

// ---------------------------------------------------------------------------
// STEP23 — V2 similarity surface view-models.
//
// Pure projections over the `SimilarityState` SNAPSHOT (never over `results`/
// `focusedRecord`), so the rendered surface cannot silently drift from the
// snapshot when focus changes (§29/§30).
// ---------------------------------------------------------------------------

/** The one-line query header: "Similar to: <query sample name>". */
export function similarityV2Header(queryName: string | undefined): string {
  return `Similar to: ${queryName ?? "—"}`;
}

/**
 * Canonical score label for a ranked neighbour. The product never calls this a
 * "Confidence" (§9) — the value is `rankSimilar` similarity, rounded to %.
 */
export function similarityV2ScoreLabel(similarity: number): string {
  const pct = Math.round(clamp01(similarity) * 100);
  return `Similarity ${pct}%`;
}

/** The subtle "Limited analysis" note — shown ONLY when data-backed (§10). */
export function similarityV2LimitedLabel(state: SimilarityState): string | undefined {
  if (state.status !== "ready" || !state.queryLimited) return undefined;
  return "Limited analysis";
}

/** Deterministic empty/status copy for each V2 surface state. */
export function similarityV2StatusText(state: SimilarityState): string | undefined {
  switch (state.status) {
    case "idle":
      return undefined;
    case "ready":
      return state.results.length === 0
        ? "No similar samples found."
        : undefined;
    case "empty":
      return state.error ?? "No similar samples found.";
    case "error":
      return state.error ?? "Find Similar failed.";
    default:
      return undefined;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// STEP24 — V2 Sound Space view-models.
//
// The Sound Space is a SNAPSHOT surface (§§38/45): points are projected ONCE
// at open time; focus changes afterwards never move points. Position labels
// are semantics-only (never "Confidence"/"Quality") and come from the frozen
// `soundSpaceProjector` axis constants.
// ---------------------------------------------------------------------------

/** The one-line panel header summary: "Sound Space · N analyzed samples". */
export function soundSpaceCountLabel(pointCount: number): string {
  return pointCount === 1
    ? "1 analyzed sample"
    : `${pointCount} analyzed samples`;
}

/** The toggle-button label; the surface toggles between open and closed. */
export function soundSpaceToggleLabel(open: boolean): string {
  return open ? "Close Sound Space" : "Sound Space";
}

/** Empty-state copy shown when the library has no projectable V2 records. */
export const SOUND_SPACE_EMPTY_TEXT =
  "No analyzed samples in Sound Space yet.";

/**
 * One-line axis summary shown under the panel — the ONLY axis semantics the
 * 1.0.0 projector supports (§14: honest labels, no invented semantics).
 */
export function soundSpaceAxisLabel(
  xLow: string,
  xHigh: string,
  yLow: string,
  yHigh: string,
): string {
  return `${xLow} ↔ ${xHigh} · ${yLow} ↔ ${yHigh}`;
}

// ---------------------------------------------------------------------------
// STEP25 — Sound Space interaction / filter / compare view-models.
// ---------------------------------------------------------------------------

/**
 * A readable one-line summary of the active Sound Space filter, e.g.
 * "brightness ≥ 0.50 · noisiness ≤ 0.30" or "All samples" when there is no
 * active filter. The filter is a pure, presentational object — this helper
 * never reads UI DOM values (§9).
 */
export function soundSpaceFilterSummary(
  filter: Record<string, { min: number; max: number } | undefined>,
): string {
  const parts: string[] = [];
  for (const [dim, range] of Object.entries(filter)) {
    if (!range) continue;
    const active = range.min > 0 || range.max < 1;
    if (!active) continue;
    parts.push(`${dim} ${range.min.toFixed(2)}–${range.max.toFixed(2)}`);
  }
  return parts.length === 0 ? "All samples" : parts.join(" · ");
}

/** The "N of M" visible-vs-total label in the Sound Space header. */
export function soundSpaceVisibleLabel(visible: number, total: number): string {
  return visible === total ? "All samples" : `${visible} of ${total} samples`;
}

/**
 * Human-friendly two-decimal character value for the Compare table, e.g.
 * `0.65`. Null/undefined become `—` (missing — never 0).
 */
export function characterValueLabel(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}

/**
 * STEP25 — label for a Compare-column header (the sample name when up to 2,
 * otherwise still a plain name list). Kept minimal and deterministic.
 */
export function compareEntryLabel(name: string): string {
  return name.trim() || "—";
}

/** Whether a compare table renders the max-4 cap (always the case by spec). */
export const COMPARE_MAX = 4 as const;

/** Given a SoundCharacter, return the deterministic grayscale hint of its
 *   position for the hover text (one word chosen from brightest/darkest
 *   direction — NO color encoding of semantic meaning). */
export function soundSpaceHoverHint(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Missing";
  return value < 0.5 ? "Dark" : "Bright";
}

/** Compute the visible subset of Sound Space points under the current filter
 * (pure — uses only the index snapshot, never re-projects). Search narrowing
 * comes via the caller-provided `searchIds` (the existing SearchEngine
 * produces those from the current global search state; STEP25 never reruns
 * ranking/searches itself). */
export function visibleSoundSpacePoints(
  state: { readonly points: ReadonlyArray<{ sampleId: string; x: number; y: number }>; readonly recordsById: ReadonlyMap<string, unknown>; },
  filter: SoundSpaceCharFilter,
  searchIds?: ReadonlySet<string>,
): ReadonlyArray<{ sampleId: string; x: number; y: number }> {
  if (!isFilterShape(filter) && (!searchIds || searchIds.size === 0)) {
    return state.points;
  }
  return state.points.filter((p) => {
    if (searchIds && !searchIds.has(p.sampleId)) return false;
    const rec = state.recordsById.get(p.sampleId);
    if (!rec) return false;
    const char = (rec as { analysisV2?: { soundCharacter?: unknown } }).analysisV2?.soundCharacter as
      | Partial<Record<keyof SoundCharacter, number>>
      | undefined;
    if (!char) {
      // Could not derive a character — treat as missing dims: filter out.
      return false;
    }
    for (const dim of Object.keys(filter) as (keyof SoundCharacter)[]) {
      const range = filter[dim];
      if (!range) continue;
      const active = range.min > 0 || range.max < 1;
      if (!active) continue;
      const v = char[dim];
      if (v === null || v === undefined) return false;
      if (v < range.min || v > range.max) return false;
    }
    return true;
  });
}

/** True when `filter` has at least one active dim  (§9 identity filter passes everything). */
function isFilterShape(filter: SoundSpaceCharFilter | undefined): boolean {
  return !!filter && Object.values(filter).some((r) => {
    if (!r) return false;
    return (r.min > 0 || r.max < 1);
  });
}

/** Label for a single Sound Space point when it's included in export/list contexts. */
export function soundSpacePointLabel(name: string | undefined): string {
  return name && name.trim().length > 0 ? name : "—";
}

/** The sample's single character value in the Compare table or missing label. */
export function soundCharacterDimensionLabel(dim: string): string {
  return dim[0].toUpperCase() + dim.slice(1);
}

// ---------------------------------------------------------------------------
// STEP26 — V2 Discovery view-models.
//
// Pure projections over the `DiscoveryState` snapshot (never over live search/
// filter state), so the rendered surface always reflects the submitted query —
// draft text and shared-filter edits do NOT silently re-run it.
// ---------------------------------------------------------------------------

/** The subset of DiscoveryState the view-models read (structural, DOM-free). */
export interface DiscoveryStatusShape {
  readonly status: "idle" | "running" | "ready" | "empty" | "error";
  readonly results: readonly unknown[];
  readonly error?: string;
}

/**
 * The deterministic status copy for each Discovery state (spec copy — exact):
 *   idle -> "Find a sound"; running -> "Finding sounds…";
 *   ready with no results -> "No matching sounds found.";
 *   empty -> its error (reference hint) or "No matching sounds found.";
 *   error -> its message or "Local sample index unavailable."
 * Returns `undefined` when the surface shows results instead of a status line.
 */
export function discoveryStatusText(state: DiscoveryStatusShape): string | undefined {
  switch (state.status) {
    case "idle":
      return "Find a sound";
    case "running":
      return "Finding sounds…";
    case "ready":
      return state.results.length === 0 ? "No matching sounds found." : undefined;
    case "empty":
      return state.error ?? "No matching sounds found.";
    case "error":
      return state.error ?? "Local sample index unavailable.";
    default:
      return undefined;
  }
}

/**
 * The canonical score chip: "Match <pct>%". The label is always "Match" — the
 * product never calls a discovery score "AI Score" / "Confidence" (§"no AI
 * semantics"). Value is the bounded combined score, clamped to [0, 1].
 */
export function discoveryScoreLabel(score: number): string {
  const clamped = score < 0 ? 0 : score > 1 ? 1 : score;
  return `Match ${Math.round(clamped * 100)}%`;
}

/** One-line reason summary: "Matches search · Similar" (empty → "Match"). */
export function discoveryReasonSummary(reasons: readonly { label: string }[]): string {
  return reasons.length === 0 ? "Match" : reasons.map((r) => r.label).join(" · ");
}

// ---------------------------------------------------------------------------
// STEP27 — Sound Collection view-models (exact surface copy, all deterministic)
// ---------------------------------------------------------------------------

/** §14 — the honest empty-state copy for a collection with no members. */
export const COLLECTION_EMPTY_TEXT =
  "No sounds collected yet.\nAdd sounds from Discovery, Search, or Sound Space.";

/** §8 — shown while the collection is at the hard cap (no auto-eviction). */
export const COLLECTION_FULL_TEXT = "Collection is full.";

/** §24 — the summary must be labeled "Collection average", never
 *  "AI profile"/"predicted sound". */
export const COLLECTION_AVG_LABEL = "Collection average";

/** §27 — a member whose record is no longer in the index. */
export const COLLECTION_UNAVAILABLE_LABEL = "Unavailable sample";

/** §13 — the header counter: "My Sounds · 7" (empty → "My Sounds · 0"). */
export function collectionCounterLabel(count: number): string {
  return `My Sounds · ${count}`;
}

/** §9/§15 — the per-source Add/Added action label (Added = already a member). */
export function collectionAddLabel(isMember: boolean): string {
  return isMember ? "Added" : "Add";
}

/**
 * §20 — the EXPLICIT Select All action label. Replacing the batch selection is
 * bounded by the existing MAX_BATCH_SLOTS (8), so a larger collection surfaces
 * the honest "8 of N" note here rather than hiding the bound.
 */
export function collectionSelectAllLabel(count: number): string {
  return count > MAX_BATCH_SLOTS
    ? `Select All (${MAX_BATCH_SLOTS} of ${count})`
    : "Select All";
}

// ---------------------------------------------------------------------------
// STEP28 — Persistent Sound Collections: manager view-models (deterministic)
// ---------------------------------------------------------------------------

/** §11 — name rules surfaced to the user honestly. */
export const COLLECTION_NAME_MAX_CHARS_TEXT = "Name: 1–100 characters.";

/** §24 — the default working-set name. */
export const COLLECTION_MANAGER_TITLE = "Collections";

/**
 * §11 — the STATUS a11y/value string for the manager (used as the aria-label
 * on the header). Reflects the honest working-set state.
 */
export function collectionManagerStatusLabel(dirty: boolean, name: string): string {
  return dirty ? `Active collection: ${name} *` : `Active collection: ${name}`;
}

/** §44 — the working-set title bar with the dirty `*` marker. */
export function collectionTitleLabel(name: string, dirty: boolean): string {
  return dirty ? `${name} *` : name;
}

/** §26 — the Save/Save As force-disabled label when persistence is absent. */
export const COLLECTION_PERSISTENCE_UNAVAILABLE =
  "Collection persistence is unavailable in this session.";

/**
 * §42 — the state label shown while the manager loads the stored collections.
 */
export function collectionListLoadingText(): string {
  return "Loading collections…";
}

/**
 * §42 — the honest empty-list copy (there are simply no saved collections yet).
 */
export function collectionListEmptyText(): string {
  return "No saved collections yet. Create and Save one to persist it.";
}

/** §42 — the honest error copy when listing fails (never a fake empty list). */
export function collectionListErrorText(error: string): string {
  return `Could not load collections: ${error}`;
}

/** §43 — a collection row label: `Name` with a marker when it is active. */
export function collectionRowLabel(name: string, active: boolean): string {
  return active ? `${name} (active)` : name;
}

/** §31 — the delete-confirmation body with explicit "samples NOT deleted". */
export function collectionDeleteConfirmBody(name: string): string {
  return `Delete collection "${name}"? The samples themselves are NOT deleted — `
    + "only this saved collection is removed.";
}

/** §30 — the unsaved-switch confirmation body. */
export function collectionSwitchConfirmBody(targetName: string): string {
  return `You have unsaved changes to the current collection. Save them, discard them, or cancel switching to "${targetName}".`;
}
