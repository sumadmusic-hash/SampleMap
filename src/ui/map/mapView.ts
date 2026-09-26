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
 *  exactly 5px at every zoom level — never scales with zoom. */
export const BASE_POINT_RADIUS_PX = 5;
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

/** Base-pixel -> screen pixel under the current camera. */
export function applyCamera(screen: ScreenPosition, camera: MapCamera): ScreenPosition {
  return { x: screen.x * camera.zoom + camera.panX, y: screen.y * camera.zoom + camera.panY };
}

/**
 * Camera-aware point hit-test (§10). `pointer` is the pointer position in BASE
 * pixel units; the search runs through the current view transform so hover and
 * click stay correct after zoom/pan. Returns undefined when nothing is within
 * `radiusPx`.
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
    if (d <= radiusPx && (best === undefined || d < best.distance)) {
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