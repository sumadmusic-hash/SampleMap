import { contentIdentityKey } from "../../identity/audioContentIdentity";
import { MAP_WIDTH, clampZoom } from "./mapView";
import type { MapPoint } from "./mapView";

/**
 * STEP86 — the hard display limit for the 2D map.
 *
 * Replaces the previous cluster rendering. The map draws INDIVIDUAL sample
 * points and nothing else; when there are more points than a human can
 * distinguish, exactly this many of them are drawn.
 *
 * This is a PRESENTATION limit only. It runs strictly after
 * `mapPoints()` -> `globalMapPoints()` -> `mergeMapPoints()`, so every point it
 * ever sees is already a fully decided, content-deduplicated, correctly
 * positioned map point. Nothing here changes which points exist, where they
 * are, or which sample they stand for.
 */
export const MAX_DISPLAYED_POINTS = 500;

/**
 * Size of one selection cell in BASE pixels at zoom 1.
 *
 * This has nothing to do with what is painted — the cells are never drawn. They
 * only partition the map so the selection can hand out its budget evenly across
 * the whole surface. 80 base px over the 800 px map width yields a 10x7 grid
 * (70 cells), which is deliberately much smaller than `MAX_DISPLAYED_POINTS`:
 * with fewer cells than slots, every cell must contribute several points
 * instead of the whole budget collapsing onto a sparse subset of the map.
 */
export const DISPLAY_CELL_PX = 80;

/** The same cell in normalized map units at zoom 1. */
export const DISPLAY_CELL_NORM = DISPLAY_CELL_PX / MAP_WIDTH;

/**
 * Selection cell size for a zoom level.
 *
 * Mirrors the old cell behaviour so ZOOM remains meaningful under the new
 * limit: cells are LARGE when zoomed out and shrink as the zoom grows, so
 * zooming in re-partitions the map more finely and therefore promotes a
 * different (finer-grained) subset of points into the displayed set.
 *
 * This is the ONLY thing zoom changes here. No coordinate is ever recomputed:
 * a cell only decides membership, and the points that are selected are emitted
 * as the original, untouched `MapPoint` objects.
 */
export function displayCellSize(zoom: number): number {
  return DISPLAY_CELL_NORM / clampZoom(zoom);
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

/** Spatial cell of a point, in the grid for the given zoom. */
function cellOf(p: MapPoint, cell: number): { col: number; row: number } {
  // Coordinates are normalized to [0,1]; floor() keeps the right-most /
  // bottom-most edge in its own cell instead of folding it back.
  return { col: Math.floor(p.x / cell), row: Math.floor(p.y / cell) };
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

export interface DisplaySelectionOptions {
  /**
   * Current camera zoom. Only influences the cell grid (see `displayCellSize`),
   * never a point position.
   */
  zoom?: number;
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
 *  - `points.length <= MAX_DISPLAYED_POINTS` -> every point is returned.
 *  - otherwise exactly `MAX_DISPLAYED_POINTS` points are returned, spread over
 *    the whole map by ROUND-ROBIN over spatial cells.
 *
 * The round-robin is the point of this function. Taking `points.slice(0, MAX)`
 * (or any stable-sort prefix) would keep only whichever corner of the map
 * happens to sort first, so a dense library would silently reduce to a small
 * patch. Instead every cell gets its first point before any cell gets a second
 * one, then every cell gets its second, and so on — so the displayed set always
 * covers the entire sound space and grows evenly.
 *
 * Determinism (pinned by tests):
 *  - points are ordered by `contentIdentityKey` + `sampleId`, never by arrival;
 *  - duplicate content identities collapse to a deterministic representative;
 *  - cells are visited in column-major order;
 *  so the same data yields the same selection regardless of input order.
 */
export function selectDisplayedPoints(
  points: readonly MapPoint[],
  opts: DisplaySelectionOptions = {},
): MapPoint[] {
  // ── 1. Deterministic base order + content-identity uniqueness ─────────────
  // Sorting BEFORE de-duplicating is what makes the representative choice
  // order-independent: "keep the first" then always means "keep the smallest
  // key", never "keep whichever arrived first".
  const ordered = [...points].sort((a, b) => {
    const ka = pointKey(a);
    const kb = pointKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const unique: MapPoint[] = [];
  const seenIdentity = new Set<string>();
  for (const p of ordered) {
    const identity = contentIdentityKey(p.contentIdentity);
    if (seenIdentity.has(identity)) continue;
    seenIdentity.add(identity);
    unique.push(p);
  }

  const budget = Math.max(0, MAX_DISPLAYED_POINTS);

  // ── 2. Split the budget: reserved (focus/selection) vs. sampled ───────────
  // Reserved points are guaranteed a slot BEFORE the round-robin starts, so
  // they can never be crowded out by the spatial pass.
  const keep = new Set(opts.keepSampleIds ?? []);
  const reserved: MapPoint[] = [];
  const candidates: MapPoint[] = [];
  for (const p of unique) {
    // A point is visited once, so several pinned ids landing on the SAME merged
    // point still reserve it exactly once, and a point is never both reserved
    // and sampled.
    if (carriesAnyPinnedId(p, keep)) reserved.push(p);
    else candidates.push(p);
  }
  if (candidates.length + reserved.length <= budget) return unique;

  const sampleBudget = Math.max(0, budget - reserved.length);

  // ── 3. Bin into spatial cells ─────────────────────────────────────────────
  const cell = displayCellSize(opts.zoom ?? 1);
  const cells = new Map<string, { col: number; row: number; members: MapPoint[] }>();
  for (const p of candidates) {
    const { col, row } = cellOf(p, cell);
    const key = `${col}:${row}`;
    let bucket = cells.get(key);
    if (!bucket) {
      bucket = { col, row, members: [] };
      cells.set(key, bucket);
    }
    bucket.members.push(p);
  }
  // Column-major cell order: a total, input-order-independent visit order.
  const orderedCells = [...cells.values()].sort(
    (a, b) => (a.col !== b.col ? a.col - b.col : a.row - b.row),
  );

  // ── 4. Round-robin: one point per cell per pass ───────────────────────────
  // `members` is already in `pointKey` order, so pass r takes a deterministic
  // STRIDE through each cell rather than an arbitrary member.
  const chosen: { col: number; row: number; point: MapPoint }[] = [];
  let taken = 0;
  for (let pass = 0; taken < sampleBudget; pass++) {
    let progressed = false;
    for (const bucket of orderedCells) {
      if (taken >= sampleBudget) break;
      const member = bucket.members[pass];
      if (member === undefined) continue;
      chosen.push({ col: bucket.col, row: bucket.row, point: member });
      taken += 1;
      progressed = true;
    }
    // Every cell is exhausted; nothing left to add.
    if (!progressed) break;
  }

  for (const p of reserved) {
    const { col, row } = cellOf(p, cell);
    chosen.push({ col, row, point: p });
  }

  // ── 5. Deterministic output order (spatial, then stable key) ──────────────
  chosen.sort((a, b) => {
    if (a.col !== b.col) return a.col - b.col;
    if (a.row !== b.row) return a.row - b.row;
    const ka = pointKey(a.point);
    const kb = pointKey(b.point);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return chosen.map((c) => c.point);
}
