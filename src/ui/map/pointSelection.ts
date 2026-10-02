import { contentIdentityKey } from "../../identity/audioContentIdentity";
import { clampZoom } from "./mapView";
import type { MapPoint } from "./mapView";

/**
 * STEP90 — the hard display limit for the 2D map, now backed by a hierarchical
 * (quadtree) level-of-detail selection instead of a zoom-dependent round-robin.
 *
 * The old round-robin re-partitioned the map into a DIFFERENT grid at every
 * zoom, so a point that stayed inside the viewport could still lose its slot to
 * a reshuffled neighbour. That is the ID churn this module now eliminates.
 *
 * The rule is simple and deterministic: the map surface is a quadtree, a point
 * only ever stands for its cell's representative, and the representative of a
 * cell is `argmin(contentIdentityKey + sampleId)`. Because that key is
 * independent of the level at which the cell is queried, exactly one child
 * inherits the parent's representative when a cell splits. Zooming in can
 * therefore only ADD points; panning can only change which points leave/enter
 * the viewport; zooming out only reduces detail.
 *
 * This is a PRESENTATION limit only. It runs strictly after
 * `mapPoints()` -> `globalMapPoints()` -> `mergeMapPoints()`, so every point it
 * ever sees is already a fully decided, content-deduplicated, correctly
 * positioned map point. Nothing here changes which points exist, where they
 * are, or which sample they stand for.
 */
export const MAX_DISPLAYED_POINTS = 500;

/**
 * STEP90 quadtree configuration.
 *
 * `LOD_CELLS_ACROSS` is the number of cells a zoom-1 viewport is divided into
 * per axis. `levelForZoom` keeps `2^level / zoom` roughly constant, so the
 * ON-SCREEN cell size is zoom-invariant: zooming in reveals finer cells at a
 * constant apparent size rather than shrinking a fixed grid.
 */
export const LOD_CELLS_ACROSS = 16;
export const LOD_MIN_LEVEL = 2;
export const LOD_MAX_LEVEL = 9;

/**
 * The quadtree level for a camera zoom. A PURE, MONOTONE, NON-DECREASING
 * function of zoom — the single property that guarantees zoom-in monotonicity.
 */
export function levelForZoom(zoom: number): number {
  const z = clampZoom(zoom);
  const level = Math.round(Math.log2(LOD_CELLS_ACROSS * z));
  return Math.min(LOD_MAX_LEVEL, Math.max(LOD_MIN_LEVEL, level));
}

/**
 * Separator between the content identity and the sample id in a point key.
 *
 * ASCII US (0x1f): a control character that occurs in neither a content hash nor
 * a path segment, so the joined key is unambiguous. Built via `fromCharCode` to
 * keep this file free of literal control bytes.
 */
const POINT_KEY_SEPARATOR = String.fromCharCode(0x1f);

/** Stable, input-order-independent sort key of a map point. */
function pointKey(p: MapPoint): string {
  return contentIdentityKey(p.contentIdentity) + POINT_KEY_SEPARATOR + p.sampleId;
}

/** Ascending comparison on `pointKey` (never on arrival order). */
function byPointKey(a: MapPoint, b: MapPoint): number {
  const ka = pointKey(a);
  const kb = pointKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Whether a map point carries ANY pinned sample id.
 *
 * A `MapPoint` stands for a CONTENT IDENTITY and therefore carries every sample
 * id merged into it. Focus and batch selection are expressed as sample ids, and
 * the focused record is not necessarily the representative of its own point, so
 * matching on `sampleId` alone would let the very sample the user selected
 * disappear. Both the representative and the merged members are checked.
 */
function carriesAnyPinnedId(p: MapPoint, keep: ReadonlySet<string>): boolean {
  if (keep.has(p.sampleId)) return true;
  for (const id of p.sampleIds) {
    if (keep.has(id)) return true;
  }
  return false;
}

/**
 * Deterministically collapse duplicate content identities.
 *
 * Sorting BEFORE de-duplicating is what makes the representative choice
 * order-independent: "keep the first" then always means "keep the smallest
 * key", never "keep whichever arrived first".
 */
function dedupeByIdentity(points: readonly MapPoint[]): MapPoint[] {
  const ordered = [...points].sort(byPointKey);
  const unique: MapPoint[] = [];
  const seen = new Set<string>();
  for (const p of ordered) {
    const identity = contentIdentityKey(p.contentIdentity);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(p);
  }
  return unique;
}

/** One occupied quadtree cell: its level, position and representative key. */
interface LodCell {
  /** `pointKey` of the representative — level-independent, so it is stable. */
  readonly rep: string;
  readonly col: number;
  readonly row: number;
}

/**
 * A built quadtree over a fixed point set: for every level, the occupied cells
 * and their representative point key.
 *
 * It is built once per point set (see `lodIndexOf`) and REUSED for every zoom,
 * so crossing a level boundary never rebuilds it.
 */
interface LodIndex {
  readonly cellsByLevel: ReadonlyMap<number, ReadonlyMap<string, LodCell>>;
}

/** Clamp a coordinate into [0,1] before gridding (global data can be exact 0/1). */
function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

/**
 * Build the quadtree.
 *
 * For each level in [LOD_MIN_LEVEL, LOD_MAX_LEVEL] every point is gridded and
 * offered to its cell; the cell keeps the smallest `pointKey` it ever sees.
 * Since the key ordering is global, the representative of a cell is a subset
 * minimum and therefore independent of the level it was computed at — the
 * property Regel B depends on.
 */
function buildLodIndex(points: readonly MapPoint[]): LodIndex {
  const cellsByLevel = new Map<number, Map<string, LodCell>>();
  for (const p of points) {
    const pk = pointKey(p);
    const x = clamp01(p.x);
    const y = clamp01(p.y);
    for (let level = LOD_MIN_LEVEL; level <= LOD_MAX_LEVEL; level++) {
      const grid = 1 << level;
      const col = Math.min(grid - 1, Math.floor(x * grid));
      const row = Math.min(grid - 1, Math.floor(y * grid));
      let cells = cellsByLevel.get(level);
      if (!cells) {
        cells = new Map<string, LodCell>();
        cellsByLevel.set(level, cells);
      }
      const key = `${col}:${row}`;
      const current = cells.get(key);
      if (current === undefined || pk < current.rep) {
        cells.set(key, { rep: pk, col, row });
      }
    }
  }
  return { cellsByLevel };
}

/** FNV-1a over the canonical point keys + coordinates, for index reuse. */
function indexSignature(points: readonly MapPoint[]): string {
  let hash = 0x811c9dc5;
  for (const p of points) {
    const s = `${pointKey(p)}|${p.x}|${p.y}`;
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `${(hash >>> 0).toString(16)}:${points.length}`;
}

/**
 * The last built index. Kept module-level (keyed by signature) so the same
 * point set is never re-indexed just because the camera moved to a new level.
 * The index stores only point KEYS, never point objects, so a cache hit still
 * hands back the caller's current instances (identity is preserved).
 */
let cachedSignature: string | undefined;
let cachedIndex: LodIndex | undefined;

function lodIndexOf(points: readonly MapPoint[]): LodIndex {
  const signature = indexSignature(points);
  if (cachedIndex !== undefined && cachedSignature === signature) {
    return cachedIndex;
  }
  cachedIndex = buildLodIndex(points);
  cachedSignature = signature;
  return cachedIndex;
}

/** Normalized viewport bounds the LOD selection is limited to (all in [0,1]). */
export interface ViewportBounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/**
 * The representatives of every occupied cell at `level`, restricted to the
 * viewport when one is given.
 *
 * This is the pure LOD primitive. It never applies the display budget and never
 * takes the "small library" shortcut, so it is the function the stability rules
 * are defined on. Output order is deterministic (column-major cell order).
 */
export function representativesAtLevel(
  points: readonly MapPoint[],
  level: number,
  bbox?: ViewportBounds | null,
): MapPoint[] {
  const unique = dedupeByIdentity(points);
  const byKey = new Map<string, MapPoint>();
  for (const p of unique) byKey.set(pointKey(p), p);
  const index = lodIndexOf(unique);
  return selectAtLevel(index, byKey, level, bbox ?? null);
}

/**
 * Emit the representative of each occupied cell at `level` that intersects the
 * viewport. Bounded and deterministic; a cell the viewport cannot see is simply
 * not visited, which is what makes panning affect membership and nothing else.
 */
function selectAtLevel(
  index: LodIndex,
  byKey: ReadonlyMap<string, MapPoint>,
  level: number,
  bbox: ViewportBounds | null,
): MapPoint[] {
  const cells = index.cellsByLevel.get(level);
  if (cells === undefined) return [];
  const grid = 1 << level;
  const hit: { col: number; row: number; point: MapPoint }[] = [];
  for (const cell of cells.values()) {
    if (bbox) {
      const x0 = cell.col / grid;
      const x1 = (cell.col + 1) / grid;
      const y0 = cell.row / grid;
      const y1 = (cell.row + 1) / grid;
      if (x1 < bbox.xMin || x0 > bbox.xMax || y1 < bbox.yMin || y0 > bbox.yMax) {
        continue;
      }
    }
    const point = byKey.get(cell.rep);
    if (point !== undefined) hit.push({ col: cell.col, row: cell.row, point });
  }
  hit.sort((a, b) => (a.col !== b.col ? a.col - b.col : a.row - b.row));
  return hit.map((c) => c.point);
}

export interface DisplaySelectionOptions {
  /**
   * Current camera zoom. Only selects the quadtree level (see `levelForZoom`),
   * never a point position.
   */
  zoom?: number;
  /**
   * Current camera viewport in normalized coordinates. Limits the selection to
   * what is on screen; it never changes a representative.
   */
  bbox?: ViewportBounds | null;
  /**
   * Sample ids that must be present in the result REGARDLESS of the limit — the
   * focused sample and every batch-selected sample. A point the user is
   * currently working with must never be the one that silently disappears when
   * the library grows.
   */
  keepSampleIds?: Iterable<string>;
}

/**
 * Choose which map points the map actually draws.
 *
 * Runs strictly AFTER the existing pipeline
 * (`mapPoints()` -> `globalMapPoints()` -> `mergeMapPoints()`) and never
 * reorders, merges or re-positions those points.
 *
 * Behaviour:
 *  - `points.length <= MAX_DISPLAYED_POINTS` -> every point is returned (no LOD
 *    is applied at all, so a small library is maximally stable).
 *  - otherwise the quadtree level for the zoom is selected and each occupied
 *    cell contributes exactly one representative. The viewport bounds the
 *    result; if that would still exceed the budget the level is coarsened
 *    deterministically until it fits.
 *
 * Stability (pinned by tests):
 *  - zoom-in monotonicity — a point visible at z1 that stays in the viewport is
 *    still present at z2 > z1 (`S(z1) ∩ V(z2) ⊆ S(z2)`);
 *  - representative stability — a cell's representative does not depend on the
 *    queried level, so splitting a cell never swaps it;
 *  - pan neutrality — panning only changes viewport membership;
 *  - zoom-out reduces detail deterministically, never by re-shuffling.
 */
export function selectDisplayedPoints(
  points: readonly MapPoint[],
  opts: DisplaySelectionOptions = {},
): MapPoint[] {
  const budget = Math.max(0, MAX_DISPLAYED_POINTS);
  const keep = new Set(opts.keepSampleIds ?? []);
  const unique = dedupeByIdentity(points);

  // ── Small library: draw everything, apply no LOD and therefore no churn. ──
  if (unique.length <= budget) {
    return withPinned(unique, unique, keep, budget);
  }

  const byKey = new Map<string, MapPoint>();
  for (const p of unique) byKey.set(pointKey(p), p);
  const index = lodIndexOf(unique);

  // ── Hierarchical selection at the zoom's level, bounded by the viewport. ──
  const level = levelForZoom(opts.zoom ?? 1);
  const bbox = opts.bbox ?? null;
  let selected = selectAtLevel(index, byKey, level, bbox);

  // Deterministic budget safety net. Coarsening walks DOWN the hierarchy, and
  // because every coarser representative survives in its finer child, this can
  // only remove detail — it can never swap a point the user already sees. With
  // a viewport bbox this loop is not reached in practice (measured peak well
  // under the budget), but it keeps the limit hard for unbounded callers.
  for (
    let coarser = level - 1;
    selected.length > budget && coarser >= LOD_MIN_LEVEL;
    coarser--
  ) {
    selected = selectAtLevel(index, byKey, coarser, bbox);
  }

  return withPinned(selected, unique, keep, budget);
}

/**
 * Guarantee every pinned point a slot, then fill the remaining budget from the
 * LOD selection (never duplicating a pinned point that was already selected).
 * Output is sorted by `pointKey`, so it is identical for any input order.
 */
function withPinned(
  selected: readonly MapPoint[],
  all: readonly MapPoint[],
  keep: ReadonlySet<string>,
  budget: number,
): MapPoint[] {
  if (keep.size === 0) {
    return selected.slice(0, budget).sort(byPointKey);
  }
  const pinned = all.filter((p) => carriesAnyPinnedId(p, keep));
  const pinnedKeys = new Set(pinned.map(pointKey));
  const sampled = selected.filter((p) => !pinnedKeys.has(pointKey(p)));
  const room = Math.max(0, budget - pinned.length);
  return [...pinned, ...sampled.slice(0, room)].sort(byPointKey);
}
