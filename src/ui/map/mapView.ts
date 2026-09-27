import type { SampleIndexRecord } from "../../persistence/indexStore";
import { mapVersion } from "../../map/mapPosition";
import { computeCanonicalSoundSpacePoint } from "../../analysis/soundSpaceProjector";
import {
  contentIdentityKey,
  selectRepresentative,
  type AudioContentIdentity,
} from "../../identity/audioContentIdentity";
import type { GlobalMapPoint } from "../../global/contract";

/**
 * Pure view-model for the 2D SampleMap UI (SAMPLEMAP_V1_SPEC §13, Step 15C).
 *
 * Everything here is a deterministic PURE projection over `SampleIndexRecord`s:
 *  - `mapPoints()`  : records -> display points (one per Audio Content Identity)
 *  - `toScreen()`   : normalized map coords -> pixel coords (Y inverted, so
 *                     bright sits at the TOP of the screen)
 *  - `classColor()` : classification -> deterministic visual category (color).
 *                     Used ONLY for presentation, NEVER for position.
 *  - interaction state (hover / unique selection) as a tiny reducer
 *  - `tooltipFor()` : the pure hover info block
 *
 * This module is DOM-free so it is fully testable in Node. The DOM renderer
 * (`./mapRender.ts`) is a thin projection of it, exactly like `render.ts`.
 *
 * Invariant §INV-2 (Tags != classification) is enforced structurally: the
 * tooltip's classification block comes solely from `primaryClass`/`confidence`,
 * while originalTags stay in their own separate list.
 *
 * Position invariant (Step 15B + STEP 16Q): a point's x/y comes ONLY from the
 * PERSISTED V2 `mapPosition` (analysis result). It is never recomputed from
 * `audioFeatures`; `primaryClass` and `originalTags` never affect position.
 *
 * STEP37 canonicalization: when the record carries a projectable V2
 * `analysisV2.soundCharacter`, the point position comes from the CANONICAL
 * Sound Space coordinate (`computeCanonicalSoundSpacePoint` — tonality /
 * noisiness / brightness), so every map surface renders one coherent Sound
 * Space. The persisted V1 `mapPosition` remains ONLY as a data-availability
 * fallback for records without a projectable V2 character (pre-V2 library
 * state). Position is never derived from `audioFeatures`.
 *
 * Identity invariant (Step 15I): a point's identity is
 * (contentHashVersion, contentHash), NOT sampleId. Multiple Audiotool samples
 * with identical audio content share ONE Map Point.
 */

export const MAP_VERSION = mapVersion;
export const MAP_WIDTH = 800;
export const MAP_HEIGHT = 520;
export const EMPTY_MAP_MESSAGE = "No analyzed samples yet.";

/**
 * A display point representing one Audio Content Identity (Step 15I).
 *
 * When multiple Audiotool samples share the same (contentHashVersion,
 * contentHash), they appear as ONE Map Point. The point's metadata (name,
 * owner, classification, tags) comes from the *representative* sample — the
 * lexicographically smallest sampleId in the group.
 */
export interface MapPoint {
  /**
   * The representative sample's ID (lexicographically smallest in the group).
   * Used for hover/click/selection — the UI tracks one selected point, not one
   * selected sample (Step 15I §4).
   */
  sampleId: string;
  /** All sample IDs sharing this content identity. */
  sampleIds: readonly string[];
  /** The versioned content identity (the TRUE identity of this point). */
  contentIdentity: AudioContentIdentity;
  /** Representative-sample metadata. */
  name: string;
  owner: string;
  primaryClass: string;
  confidence: number;
  /** copied list; kept separate from classification (INV-2) */
  originalTags: readonly string[];
  /**
   * STEP38 — fine-grained semantic subtype (e.g. "ride", "closedhat") from the
   * representative's additive semantic classification. Absent on pre-STEP38
   * records — the renderer then falls back to the `primaryClass` color.
   */
  semanticSubtype?: string;
  /** normalized map coordinate in [0,1] (NOISY..TONAL) */
  x: number;
  /** normalized map coordinate in [0,1] (DARK..BRIGHT) */
  y: number;
  /**
   * STEP37 coordinate provenance of this point: canonical Sound Space V2 when
   * the representative has a projectable sound character, else the legacy
   * persisted `mapPosition` data-availability fallback.
   */
  projection?: "sound-space-canonical" | "map-v2-legacy";
  /** Step 16K: origin marker — local analysis vs. global worker. */
  origin?: "local" | "global";
}

/** Pixel area the map is drawn into (SVG viewBox units). */
export interface MapSize {
  width: number;
  height: number;
}

/** Pixel-space position after Y inversion. */
export interface ScreenPosition {
  x: number;
  y: number;
}

/**
 * Step 15F camera (§34 "Camera State ≠ Sample State").
 *
 * The camera is a RUNTIME-ONLY view transform:
 *   screen = basePixel * zoom + pan
 * It never touches normalized sample coordinates, `audioFeatures` or
 * `mapPosition()` output — those stay exactly as computed in Step 15B.
 * The camera is deliberately NOT persisted anywhere (no IndexedDB, no record
 * fields). All camera math is pure and lives here so it is testable in Node;
 * `mapRender.ts` is the thin browser projection.
 */
export interface MapCamera {
  /** multiplier on top of the base 800x520 pixel space (1..8) */
  zoom: number;
  /** horizontal pan in base pixel units (clamped, <= 0) */
  panX: number;
  /** vertical pan in base pixel units (clamped, <= 0) */
  panY: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
export const DEFAULT_ZOOM = 1;

/** Factor used by the visible [–]/[+] controls (1 -> 2 -> 4 -> 8). */
export const ZOOM_STEP = 2;

/** Pointer must move at least this far (base px) before a drag counts as Pan. */
export const DRAG_THRESHOLD_PX = 4;

/** Max pointer distance (base px) from a point for hit-testing / hover. */
export const POINT_HIT_RADIUS_PX = 13;

/** FINAL_UI_UX §8.1 + STEP38 §27 (CORRECTED): base point radius, SCREEN-space,
 *  exactly 2.5px at every zoom level — never scales with zoom.
 *  STEP76: reduced from 5px so 800+ point clouds stay separable. Selection and
 *  focus remain unmistakable — they additionally carry `stroke-width: 2.5` and the
 *  selection glow from samplemap.css, independent of this radius. Hit-testing is
 *  governed separately by POINT_HIT_RADIUS_PX, which is unchanged. */
export const BASE_POINT_RADIUS_PX = 2.5;
/** FINAL_UI_UX §8.2: selected/focused radius = base × this scale. */
export const SELECTED_POINT_SCALE = 1.35;

/**
 * FINAL_UI_UX §8.1 + STEP38 §27 (CORRECTED): base point radius is a SCREEN-SPACE
 * constant — **exactly 5px at every zoom level**. Zoom changes spatial
 * separation ONLY; sample-point visual size never changes in screen pixels.
 *
 * `pointRadius(zoom, emphasized)` therefore returns a zoom-INDEPENDENT value:
 * the `zoom` argument is accepted for call-site compatibility but is NOT part
 * of the radius math (the caller — `mapRender` — divides the base-unit SVG
 * radius by the camera zoom so the scaled content group still resolves to this
 * constant on-screen radius). The historical `max(4, 5/zoom)` floor is gone:
 * the on-screen radius no longer grows past 5px when zooming in.
 *
 * `emphasized` (focused / batch-selected / playing, §8.2) uses a larger but
 * equally zoom-INDEPENDENT screen-space radius (base × SELECTED_POINT_SCALE).
 * Pure presentation — never touches positions, `mapPosition` or audio data.
 */
export function pointRadius(zoom: number, emphasized = false): number {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void zoom;
  const base = BASE_POINT_RADIUS_PX;
  return emphasized ? base * SELECTED_POINT_SCALE : base;
}

/**
 * Step 16L: a normalized viewport bounding box (all values in [0, 1]) used to
 * query the global map for only the points currently visible under the camera.
 * Pure geometry — no UI, no network, deterministic and unit-testable.
 */
export interface NormalizedBBox {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** The camera zoom that produced this bbox (for the global map `zoom` field). */
  zoom: number;
}

/**
 * Step 16L: project the current camera + map dimensions into the visible
 * normalized bbox (inverse of `toScreen` + the camera transform).
 *
 *   screenPixel = basePixel * zoom + pan
 *   toScreen(n) = { x: n.x * W, y: (1 - n.y) * H }
 *
 * We invert both to find the normalized coordinates currently on screen, clamp
 * to [0, 1], and return the bbox. The camera is RUNTIME-only — this never
 * mutates sample positions, `audioFeatures` or `mapPosition` output.
 */
export function cameraToViewportBBox(
  camera: MapCamera,
  size: MapSize = { width: MAP_WIDTH, height: MAP_HEIGHT },
): NormalizedBBox {
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const xMinBase = -camera.panX / camera.zoom;
  const xMaxBase = (size.width - camera.panX) / camera.zoom;
  const yMinBase = -camera.panY / camera.zoom;
  const yMaxBase = (size.height - camera.panY) / camera.zoom;
  return {
    xMin: clamp01(xMinBase / size.width),
    xMax: clamp01(xMaxBase / size.width),
    yMin: clamp01(1 - yMaxBase / size.height),
    yMax: clamp01(1 - yMinBase / size.height),
    zoom: camera.zoom,
  };
}

/** The default/Reset view: full map, no zoom, no pan. */
export function defaultMapCamera(): MapCamera {
  return { zoom: DEFAULT_ZOOM, panX: 0, panY: 0 };
}

/** Bounded zoom — the user can never zoom out past the full map or in forever. */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Bounds: the map must keep fully covering the viewport, i.e. the map's screen
 * rect [panX, panX + zoom*W] x [panY, panY + zoom*H] always contains the
 * viewport [0,W] x [0,H]. This is a deliberately simple clamp (§11).
 */
export function clampPan(camera: MapCamera): MapCamera {
  const maxPanX = MAP_WIDTH * (1 - camera.zoom);
  const maxPanY = MAP_HEIGHT * (1 - camera.zoom);
  return {
    zoom: camera.zoom,
    panX: Math.min(0, Math.max(maxPanX, camera.panX)),
    panY: Math.min(0, Math.max(maxPanY, camera.panY)),
  };
}

/**
 * Apply a zoom factor while keeping the base-pixel point `anchor` fixed on
 * screen (wheel-around-pointer, §7). A missing anchor zooms around the viewport
 * centre.
 */
export function zoomBy(
  camera: MapCamera,
  factor: number,
  anchor: ScreenPosition = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 },
): MapCamera {
  const zoom = clampZoom(camera.zoom * factor);
  const k = zoom / camera.zoom;
  return clampPan({
    zoom,
    panX: anchor.x - (anchor.x - camera.panX) * k,
    panY: anchor.y - (anchor.y - camera.panY) * k,
  });
}

/** Shift the view by `dx`/`dy` base pixel units (clamped, §11). */
export function panBy(camera: MapCamera, dx: number, dy: number): MapCamera {
  return clampPan({ ...camera, panX: camera.panX + dx, panY: camera.panY + dy });
}

/**
 * Zoom in by `factor` and centre the given NORMALIZED map coordinate
 * (a point, or a cluster's centroid) in the viewport.
 *
 * The minimal camera addition the cluster interaction needs: it reuses the
 * existing `toScreen` / `clampZoom` / `clampPan` primitives and introduces NO
 * new camera state — a cluster click is just another view transform, exactly
 * like a wheel zoom or a drag pan. Runtime-only: it never touches a sample
 * coordinate, `audioFeatures` or `mapPosition` output.
 */
export function zoomToCenterOn(
  camera: MapCamera,
  coord: { x: number; y: number },
  factor: number = ZOOM_STEP,
): MapCamera {
  const zoom = clampZoom(camera.zoom * factor);
  const base = toScreen(coord, { width: MAP_WIDTH, height: MAP_HEIGHT });
  // screen = base * zoom + pan, solved for the viewport centre.
  return clampPan({
    zoom,
    panX: MAP_WIDTH / 2 - base.x * zoom,
    panY: MAP_HEIGHT / 2 - base.y * zoom,
  });
}

/** Base-pixel -> screen pixel under the current camera. */
export function applyCamera(screen: ScreenPosition, camera: MapCamera): ScreenPosition {
  return { x: screen.x * camera.zoom + camera.panX, y: screen.y * camera.zoom + camera.panY };
}

/**
 * Camera-aware point hit-test (§10). `pointer` is the pointer position in BASE
 * pixel units; the search runs through the current view transform so hover and
 * click stay correct after zoom/pan. Returns undefined when nothing is within
 * `radiusPx`.
 *
 * Tie-break (STEP76): nearest wins; on an EXACT distance tie the LAST entry of
 * `points` wins. The renderer appends its circles in exactly this array order,
 * so the last entry is the one painted on top — the tie-break therefore returns
 * the point the user actually SEES. With a strict `<` comparison the earlier
 * (visually hidden) entry won instead, so clicking the visible dot selected an
 * invisible sample for exactly coincident points.
 */
export function pointAt(
  points: readonly MapPoint[],
  pointer: ScreenPosition,
  camera: MapCamera,
  radiusPx: number = POINT_HIT_RADIUS_PX,
): MapPoint | undefined {
  let best: { distance: number; point: MapPoint } | undefined;
  for (const point of points) {
    const s = applyCamera(toScreen(point, { width: MAP_WIDTH, height: MAP_HEIGHT }), camera);
    const d = Math.hypot(s.x - pointer.x, s.y - pointer.y);
    if (d <= radiusPx && (best === undefined || d <= best.distance)) {
      best = { distance: d, point };
    }
  }
  return best?.point;
}

/** Pure interaction state of the map (hover + unique selection). */
export interface MapUiState {
  hoveredSampleId: string | undefined;
  selectedSampleId: string | undefined;
}

/** The pure hover-info block (classification kept separate from tags, INV-2). */
export interface MapTooltip {
  /** Sample name. */
  title: string;
  /** "primaryClass (NN%)" — from classification ONLY. */
  classification: string;
  /** Sample owner. */
  owner: string;
  /** Original Audiotool tags, separate list (never fused into a class label). */
  originalTags: readonly string[];
}

/**
 * Project records to map points, deduplicating by Audio Content Identity.
 *
 * Multiple records with the same (contentHashVersion, contentHash) are merged
 * into a SINGLE Map Point. The point's metadata comes from the representative
 * sample (lexicographically smallest sampleId — Step 15I §5).
 *
 * Records without `contentHash` (e.g. legacy or pre-15H) are treated as
 * unique identities — one record = one point — so they degrade gracefully.
 *
 * Position comes exclusively from the persisted V2 position — the CANONICAL
 * Sound Space coordinate when the representative has a projectable V2
 * `analysisV2.soundCharacter`, else the persisted `mapPosition` legacy
 * fallback (STEP37). It is NEVER recomputed from `audioFeatures` (STEP 16Q).
 * A record with neither a projectable Sound Character nor a persisted
 * `mapPosition` is a Missing-V2 state and is NOT placed on the map.
 */
export function mapPoints(records: readonly SampleIndexRecord[]): MapPoint[] {
  // Group by content identity.
  const groups = new Map<string, SampleIndexRecord[]>();
  for (const r of records) {
    if (r.status !== "analyzed" || !r.audioFeatures) continue;
    const key = r.contentHash
      ? contentIdentityKey({
          contentHash: r.contentHash,
          contentHashVersion: r.contentHashVersion ?? "unknown",
        })
      : `legacy:${r.sampleId}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(r);
  }

  const out: MapPoint[] = [];
  for (const group of groups.values()) {
    const sampleIds = [...new Set(group.map((r) => r.sampleId))].sort();
    const representativeId = selectRepresentative(sampleIds);
    const representative = group.find((r) => r.sampleId === representativeId)!;
    const canonical = representative.analysisV2?.soundCharacter
      ? computeCanonicalSoundSpacePoint(representative)
      : null;
    const pos = canonical ?? (representative.mapPosition ?? null);
    if (!pos) continue;
    out.push({
      sampleId: representativeId,
      sampleIds,
      contentIdentity: representative.contentHash
        ? {
            contentHash: representative.contentHash,
            contentHashVersion: representative.contentHashVersion ?? "unknown",
          }
        : { contentHash: "", contentHashVersion: "" },
      name: representative.name,
      owner: representative.owner,
      primaryClass: representative.primaryClass,
      confidence: representative.confidence,
      originalTags: [...representative.originalTags],
      ...(representative.semanticClassification
        ? { semanticSubtype: representative.semanticClassification.subtype }
        : {}),
      x: pos.x,
      y: pos.y,
      projection: canonical ? "sound-space-canonical" : "map-v2-legacy",
      origin: "local",
    });
  }
  return out;
}

/**
 * Deterministic normalized -> pixel transform. Y is inverted because the screen
 * grows downwards: y=1 (BRIGHT) maps to the top (0), y=0 (DARK) to the bottom.
 */
export function toScreen(coord: { x: number; y: number }, size: MapSize): ScreenPosition {
  return {
    x: coord.x * size.width,
    y: (1 - coord.y) * size.height,
  };
}

/** Fixed deterministic palette for the classification visual categories. */
export const CLASS_COLORS: Record<string, string> = {
  kick: "#e53935",
  snare: "#fb8c00",
  clap: "#fdd835",
  hihat: "#43a047",
  openhat: "#26c6da",
  tom: "#1e88e5",
  cymbal: "#5e35b1",
  percussion: "#8e24aa",
  bass: "#00897b",
  synth: "#00acc1",
  piano: "#3949ab",
  guitar: "#7cb342",
  strings: "#c0ca33",
  keys: "#f4511e",
  pad: "#6a1b9a",
  lead: "#d81b60",
  vocal: "#ff7043",
  fx: "#757575",
  atmosphere: "#78909c",
  noise: "#b0bec5",
  loop: "#546e7a",
  other: "#9e9e9e",
};

export const DEFAULT_CLASS_COLOR = "#9e9e9e";

/** Deterministic visual category (color) for a classification. Presentation only. */
export function classColor(primaryClass: string): string {
  return CLASS_COLORS[primaryClass] ?? DEFAULT_CLASS_COLOR;
}

/** The initial interaction state (nothing hovered, nothing selected). */
export function initialMapUiState(): MapUiState {
  return { hoveredSampleId: undefined, selectedSampleId: undefined };
}

/** Pure hover transition. `sampleId` undefined clears the hover. */
export function hover(state: MapUiState, sampleId: string | undefined): MapUiState {
  return { ...state, hoveredSampleId: sampleId };
}

/** Pure selection transition: exactly ONE selected id at any time (unique). */
export function select(state: MapUiState, sampleId: string): MapUiState {
  return { ...state, selectedSampleId: sampleId };
}

/** Find a point by id (undefined if absent). */
export function findPoint(
  points: readonly MapPoint[],
  sampleId: string | undefined,
): MapPoint | undefined {
  if (sampleId === undefined) return undefined;
  return points.find((p) => p.sampleId === sampleId);
}

/** Build the pure hover info block for a point. */
export function tooltipFor(p: MapPoint): MapTooltip {
  return {
    title: p.name,
    classification: `${p.primaryClass} (${Math.round(p.confidence * 100)}%)`,
    owner: p.owner,
    originalTags: [...p.originalTags],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 16K: Global Map Points — convert GlobalMapPoint[] → MapPoint[]
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 16K: Convert global worker map points to the local MapPoint format.
 *
 * The global worker's `GET /map` returns `GlobalMapPoint[]` with content
 * identity, position, representative sample ID, and primary classification.
 * This function bridges them into the existing MapPoint shape so the SVG
 * renderer can display them alongside local points without any parallel
 * rendering architecture.
 *
 * Name/owner/tags are not available from the global endpoint — they are set
 * to fallback values. When a global point corresponds to a local record, the
 * merge step (mergeMapPoints) uses the local record's richer metadata.
 */
export function globalMapPoints(
  globalPoints: readonly GlobalMapPoint[],
): MapPoint[] {
  return globalPoints.map((gp) => ({
    sampleId: gp.representativeSampleId,
    sampleIds: [gp.representativeSampleId],
    contentIdentity: gp.contentIdentity,
    name: gp.representativeSampleId,
    owner: "global",
    primaryClass: gp.primaryClass,
    confidence: 1.0,
    originalTags: [],
    x: gp.x,
    y: gp.y,
    origin: "global" as const,
  }));
}

/**
 * Step 16K: Merge local and global map points.
 *
 * Local points take precedence over global points for the same content
 * identity (the local record has richer metadata: name, owner, tags).
 * Global points that don't exist locally fill the map with community data.
 *
 * The result is a single MapPoint[] suitable for the existing SVG renderer.
 */
export function mergeMapPoints(
  local: readonly MapPoint[],
  global: readonly MapPoint[],
): MapPoint[] {
  const byKey = new Map<string, MapPoint>();
  for (const p of local) {
    const key = contentIdentityKey(p.contentIdentity);
    byKey.set(key, p);
  }
  for (const p of global) {
    const key = contentIdentityKey(p.contentIdentity);
    if (!byKey.has(key)) {
      byKey.set(key, p);
    }
  }
  return [...byKey.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// LOD / CLUSTERING (PoC) — renderable point set for a zoom level
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CLUSTER / LOD PROOF OF CONCEPT.
 *
 * `mapPoints()` already collapses samples by content identity, but the renderer
 * still emitted one `<circle>` per visible map point. With the automatic
 * background indexing analysing up to 1000 samples, a zoomed-out map has to
 * aggregate instead of painting every point.
 *
 * This is a PURE, deterministic, O(n) level-of-detail projection: it takes
 * already-merged `MapPoint[]` plus the current zoom and returns what should be
 * painted. It runs strictly AFTER `mapPoints()` + `globalMapPoints()` +
 * `mergeMapPoints()`, so the verified invariants (Global/My visibility,
 * content-identity dedup, global/local overlap, `representativeSampleId`) are
 * untouched — clustering only decides how many of those SAME points are drawn.
 *
 * Deliberately NOT in this PoC: k-means, force simulation, viewport culling,
 * animated transitions, cluster-boundary shapes, or any change to the underlying
 * sample coordinates (`mapPosition`, `analysisV2`, Sound Space are read-only
 * here). No DOM, no IndexedDB, no audio, no network.
 */

/**
 * Screen-space size of one cluster cell, in BASE pixel units. Because the cell
 * is divided by the zoom below, it covers the same number of SCREEN pixels at
 * every zoom level — zooming in therefore reveals finer structure inside a
 * stable on-screen grid.
 */
export const CLUSTER_CELL_PX = 80;

/** The same cell in normalized map units at zoom 1 (square in base pixels). */
export const CLUSTER_CELL_NORM = CLUSTER_CELL_PX / MAP_WIDTH;

/**
 * Point count below which clustering stays OFF. A small map renders every point
 * exactly as before, which keeps the existing (verified) map behaviour intact
 * and confines the PoC to the dense case it is meant for.
 */
export const CLUSTER_MIN_POINTS = 24;

/** Cluster dot radius, SCREEN space (never scales with zoom). */
export const CLUSTER_RADIUS_PX = 9;

/**
 * Cluster hit radius in screen px, NEVER scaling with zoom.
 *
 * Deliberately larger than a point's hit radius (13px): a cluster stands for
 * many samples, so its whole painted area — plus a margin — is the target the
 * user aims at. A cluster and a point never share a cell, so this radius can
 * never make one shadow the other.
 */
export const CLUSTER_HIT_RADIUS_PX = 18;

/**
 * Normalized cell size for a zoom level: LARGE cells when zoomed out, small
 * cells when zoomed in. Zoom 1 -> the full 80px grid; zoom 8 -> 1/8 of it, i.e.
 * fine enough that a few hundred points practically never share a cell.
 */
export function clusterCellSize(zoom: number): number {
  return CLUSTER_CELL_NORM / clampZoom(zoom);
}

/** A cell that holds exactly ONE point: rendered as the point itself. */
export interface MapPointEntry {
  kind: "point";
  point: MapPoint;
}

/**
 * A cell that holds SEVERAL points, collapsed into one renderable entry.
 *
 * IMPORTANT: a cluster is NOT a sample. It deliberately has no `sampleId` (and
 * therefore cannot be selected, previewed or persisted as one); the members it
 * stands for stay reachable through `points`.
 */
export interface MapCluster {
  kind: "cluster";
  /** Normalized centroid of the members — where the cluster dot is drawn. */
  x: number;
  y: number;
  /** Number of member map points (e.g. 3, 17, 42). */
  count: number;
  /** The member points, in a deterministic order. */
  points: readonly MapPoint[];
  /** Stable `"col:row"` cell key — also the cluster's DOM/test handle. */
  cell: string;
}

/** One renderable entry of the map: either a point or a cluster. */
export type MapEntry = MapPointEntry | MapCluster;

/** The normalized coordinate an entry is drawn / hit-tested at. */
export function entryAnchor(entry: MapEntry): { x: number; y: number } {
  return entry.kind === "point" ? entry.point : entry;
}

/** Total number of original map points represented by a set of entries. */
export function entryCoverage(entries: readonly MapEntry[]): number {
  let n = 0;
  for (const e of entries) n += e.kind === "point" ? 1 : e.count;
  return n;
}

/**
 * Separator between the content identity and the sample id in a member key.
 *
 * ASCII US (0x1f): a control character that occurs in neither a content hash
 * nor a path segment, so the joined key is unambiguous. Written via
 * `String.fromCharCode` to keep this source file free of literal control
 * bytes.
 */
const MEMBER_KEY_SEPARATOR = String.fromCharCode(0x1f);

/** Stable, input-order-independent sort key of a member point. */
function memberKey(p: MapPoint): string {
  return contentIdentityKey(p.contentIdentity) + MEMBER_KEY_SEPARATOR + p.sampleId;
}

/**
 * Collapse map points into the renderable set for a zoom level.
 *
 * Deterministic uniform GRID in map space: a point falls into the cell
 * `floor(x / cell), floor(y / cell)`, and every cell that ends up with more than
 * one point becomes a single cluster whose position is the members' centroid.
 *
 * Properties that matter and are pinned by the tests:
 *  - deterministic and reproducible: the output order and the member order are
 *    sorted by stable keys, so a shuffled input yields an identical result;
 *  - O(n): one pass to bin, one pass to emit, plus per-cell sorts;
 *  - lossless in COUNT: every input point is either drawn itself or counted in
 *    exactly one cluster — nothing is dropped and no coordinate is rewritten;
 *  - progressive: cells shrink as the zoom grows, so a cluster resolves into
 *    several points (or smaller clusters) by zooming in.
 *
 * Runs strictly after the existing `mapPoints()` + `globalMapPoints()` +
 * `mergeMapPoints()` pipeline and never reorders or alters those points.
 */
export function clusterMapPoints(
  points: readonly MapPoint[],
  zoom: number,
): MapEntry[] {
  if (points.length < CLUSTER_MIN_POINTS) {
    return points.map((point) => ({ kind: "point", point }) as const);
  }

  const cell = clusterCellSize(zoom);
  const cells = new Map<string, { col: number; row: number; members: MapPoint[] }>();
  for (const p of points) {
    // Coordinates are normalized to [0,1]; floor() keeps the right-most /
    // bottom-most edge in its own cell instead of merging it back into the
    // last full cell.
    const col = Math.floor(p.x / cell);
    const row = Math.floor(p.y / cell);
    const key = `${col}:${row}`;
    let bucket = cells.get(key);
    if (!bucket) {
      bucket = { col, row, members: [] };
      cells.set(key, bucket);
    }
    bucket.members.push(p);
  }

  const placed: Array<{ col: number; row: number; entry: MapEntry }> = [];
  for (const [key, bucket] of cells) {
    if (bucket.members.length === 1) {
      placed.push({
        col: bucket.col,
        row: bucket.row,
        entry: { kind: "point", point: bucket.members[0] },
      });
      continue;
    }
    // Sort the members before averaging: floating-point addition is not
    // associative, so a stable member order is what makes the centroid
    // bit-identical regardless of the input order.
    const members = [...bucket.members].sort((a, b) =>
      memberKey(a) < memberKey(b) ? -1 : memberKey(a) > memberKey(b) ? 1 : 0,
    );
    let sx = 0;
    let sy = 0;
    for (const m of members) {
      sx += m.x;
      sy += m.y;
    }
    placed.push({
      col: bucket.col,
      row: bucket.row,
      entry: {
        kind: "cluster",
        cell: key,
        x: sx / members.length,
        y: sy / members.length,
        count: members.length,
        points: members,
      },
    });
  }

  // Spatial order (column-major), independent of the order the points arrived
  // in. Every entry carries its cell, so the comparator is total.
  placed.sort((a, b) => (a.col !== b.col ? a.col - b.col : a.row - b.row));
  return placed.map((p) => p.entry);
}

/** What a hit-test found: a single point, or a cluster (never a member). */
export type MapEntryHit =
  | { kind: "point"; point: MapPoint }
  | { kind: "cluster"; cluster: MapCluster };

/**
 * Camera-aware hit-test over the RENDERED entries.
 *
 * Unlike `pointAt()` — which would happily return a member of a collapsed
 * cluster and select an invisible sample — this distinguishes the two cases
 * explicitly: a point hit keeps the existing behaviour, a cluster hit can only
 * ever be a cluster, never one of its (currently undrawn) members.
 *
 * Tie-break mirrors `pointAt()`: nearest wins, and on an exact distance tie the
 * LAST entry wins, because the renderer appends entries in exactly this order
 * and the last one is painted on top.
 */
export function entryAt(
  entries: readonly MapEntry[],
  pointer: ScreenPosition,
  camera: MapCamera,
  pointRadiusPx: number = POINT_HIT_RADIUS_PX,
  clusterRadiusPx: number = CLUSTER_HIT_RADIUS_PX,
): MapEntryHit | undefined {
  let best: { distance: number; hit: MapEntryHit } | undefined;
  for (const entry of entries) {
    const isCluster = entry.kind === "cluster";
    const screen = applyCamera(
      toScreen(entryAnchor(entry), { width: MAP_WIDTH, height: MAP_HEIGHT }),
      camera,
    );
    const d = Math.hypot(screen.x - pointer.x, screen.y - pointer.y);
    const radius = isCluster ? clusterRadiusPx : pointRadiusPx;
    if (d <= radius && (best === undefined || d <= best.distance)) {
      best = {
        distance: d,
        hit: isCluster
          ? { kind: "cluster", cluster: entry }
          : { kind: "point", point: entry.point },
      };
    }
  }
  return best?.hit;
}