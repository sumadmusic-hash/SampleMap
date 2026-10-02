import type { SampleIndexRecord } from "../../persistence/indexStore";
import {
  DRAG_THRESHOLD_PX,
  EMPTY_MAP_MESSAGE,
  MAP_HEIGHT,
  MAP_WIDTH,
  MapCamera,
  MapPoint,
  ScreenPosition,
  defaultMapCamera,
  globalMapPoints,
  mapPoints,
  mergeMapPoints,
  panBy,
  pointAt,
  pointRadius,
  toScreen,
  tooltipFor,
  zoomBy,
} from "./mapView";
import { calibrateDisplayX } from "./xCalibration";
import type { GlobalMapPoint } from "../../global/contract";
import { soundSpaceCornerLabels } from "../../analysis/soundSpaceProjector";
import { semanticDotColor } from "./semanticColors";

/**
 * SampleMap 2D renderer (Steps 15C + 15F) — thin DOM/SVG projection of the pure
 * view-model in `./mapView.ts`.
 *
 * Layering (§4):
 *   svg
 *    ├── background + axis labels   (SCREEN space, never zoomed/panned)
 *    └── <g class="map-content">    (transformed group)
 *          └── sample points        (BASE pixel space, camera applies)
 *
 * The camera (Step 15F) lives in the controller and is passed in via `camera`:
 * the content group gets `transform="translate(panX panY) scale(zoom)"`. Only
 * the *view* changes — the circles' cx/cy stay at their `mapPosition`-derived
 * base pixels. Point positions are NEVER rewritten.
 *
 * Interaction (Step 15F):
 *  - Wheel / trackpad zoom around the pointer (`onCamera` -> zoomBy).
 *  - Drag on empty map surface pans (`onCamera` -> panBy), only after the
 *    pointer has exceeded DRAG_THRESHOLD_PX (click never pans).
 *  - A press on/near a sample point selects it — drag on points does not pan,
 *    so selection can never be swallowed by a pan.
 *  - Hover hit-tests the pointer THROUGH the current camera (pointAt), so
 *    after zoom/pan the correct point is identified (§10).
 *
 * This file is browser glue and is intentionally not unit-tested in Node,
 * exactly like `./render.ts`; all decision logic lives in the pure view-model.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export interface SampleMapRenderOptions {
  records: readonly SampleIndexRecord[];
  /** Sample id to highlight (from the controller's single selection). */
  selectedSampleId?: string;
  /**
   * FINAL UI/UX v1.1 Phase 1: ids in the explicit BATCH SELECTION (0..8).
   * Each is rendered with the `map-point-in-selection` visual (--selection
   * stroke/glow), independent of the single focus highlight. Additive — a
   * focused + selected point carries both classes.
   */
  selectedSampleIds?: readonly string[];
  /** Called when the user clicks a local sample point. */
  onSelect?: (record: SampleIndexRecord) => void;
  /** Step 16K: global map points from the worker /map endpoint. */
  globalPoints?: readonly GlobalMapPoint[];
  /** Step 16K: called when the user clicks a global-only point. */
  onSelectGlobal?: (point: MapPoint) => void;
  /** Current view camera (Step 15F). Defaults to the full-map view. */
  camera?: MapCamera;
  /** Commit a new camera (drag-pan end / wheel zoom). Runtime state only. */
  onCamera?: (camera: MapCamera) => void;
  /** Overrides the default "No analyzed samples yet." empty-state message. */
  emptyMessage?: string;
  /**
   * STEP86 — read-only report of what was actually PAINTED.
   *
   * Called after the displayed points are chosen (and also for the empty map,
   * with zeros). It exists purely so the UI can state how many samples the map
   * holds and how many of them are currently drawn. It never influences what is
   * drawn.
   */
  onRendered?: (info: MapRenderInfo) => void;
}

/** STEP86 — the observed counts behind one rendered map frame. */
export interface MapRenderInfo {
  /** Records handed to the map (already filtered by Global/My visibility). */
  readonly records: number;
  /** Local map points after content-identity dedup (before the global merge). */
  readonly localPoints: number;
  /** Total map points available after the local/global merge. */
  readonly total: number;
  /** Points actually drawn — at most `MAX_DISPLAYED_POINTS`. */
  readonly shown: number;
}

function svgEl(
  tag: string,
  attrs: Record<string, string | number>,
): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

/** Client px (relative to the SVG element) -> base pixel units, accounting for
 *  the viewBox letterboxing so pointer math stays correct at any size (§10). */
function clientToBase(
  svg: SVGSVGElement,
  client: { x: number; y: number },
): ScreenPosition {
  const rect = svg.getBoundingClientRect();
  const scale = Math.min(rect.width / MAP_WIDTH, rect.height / MAP_HEIGHT);
  const ox = (rect.width - MAP_WIDTH * scale) / 2;
  const oy = (rect.height - MAP_HEIGHT * scale) / 2;
  return {
    x: (client.x - rect.left - ox) / scale,
    y: (client.y - rect.top - oy) / scale,
  };
}

function applyContentTransform(content: SVGGElement, camera: MapCamera): void {
  content.setAttribute(
    "transform",
    `translate(${camera.panX} ${camera.panY}) scale(${camera.zoom})`,
  );
}

interface DragState {
  startX: number;
  startY: number;
  startCamera: MapCamera;
  lastCamera: MapCamera;
  panning: boolean;
}

/** Render the map into `container` (replaces its content on every call). */
export function renderSampleMap(
  container: HTMLElement,
  opts: SampleMapRenderOptions,
): void {
  container.textContent = "";

  const camera = opts.camera ?? defaultMapCamera();
  const localPoints = mapPoints(opts.records);
  const globalPts = opts.globalPoints
    ? globalMapPoints(opts.globalPoints)
    : [];
  const points = mergeMapPoints(localPoints, globalPts);

  // STEP91 — presentation-only X calibration, applied as late as possible: the
  // rawX produced by the existing map projection becomes the actual displayed /
  // hit-tested map X only here. `MapPoint.x` (rawX), Y, the analysis pipeline
  // and the stored/deduped point data are all untouched; these are copies used
  // exclusively for the map layer below.
  const displayPoints = points.map((point) => ({
    ...point,
    x: calibrateDisplayX(point.x),
  }));

  if (points.length === 0) {
    const empty = document.createElement("div");
    empty.className = "map-empty";
    empty.setAttribute("data-testid", "map-empty");
    empty.textContent = opts.emptyMessage ?? EMPTY_MAP_MESSAGE;
    container.appendChild(empty);
    opts.onRendered?.({
      records: opts.records.length,
      localPoints: localPoints.length,
      total: 0,
      shown: 0,
    });
    return;
  }

  // STEP91 — the map ALWAYS draws the same set of points. Zoom never adds,
  // removes or swaps a sample: it only changes how large the dots are (see the
  // radius below). The former zoom-dependent quadtree LOD (`selectDisplayedPoints`)
  // is therefore not used on this path — every merged, content-deduplicated,
  // calibrated point is drawn at every zoom and pan. `displayPoints` are copies,
  // so no `MapPoint` (position, identity, membership) is altered.
  const displayed = displayPoints;

  // STEP86 — report the observed counts (read-only; changes nothing below).
  opts.onRendered?.({
    records: opts.records.length,
    localPoints: localPoints.length,
    total: points.length,
    shown: displayed.length,
  });

  const svg = svgEl("svg", {
    class: "sample-map-svg",
    "data-testid": "sample-map",
    viewBox: `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`,
    preserveAspectRatio: "xMidYMid meet",
  }) as SVGSVGElement;
  svg.setAttribute("role", "application");
  svg.setAttribute(
    "aria-label",
    "Sample map: noisy to the left, tonal to the right; dark at the bottom, bright at the top",
  );
  // E-P5A T4: make the map a keyboard-focusable application region so
  // arrow-key point navigation applies only while the map has focus.
  svg.setAttribute("tabindex", "0");
  const mapTitle = svgEl("title", {});
  mapTitle.textContent =
    "Sample map: noisier samples on the left, more tonal on the right; darker samples at the bottom, brighter at the top";
  svg.appendChild(mapTitle);
  container.appendChild(svg);

  // Background + border stay in SCREEN space so the "canvas" always fills the
  // viewport; only sample content zooms and pans.
  svg.appendChild(
    svgEl("rect", {
      x: 0,
      y: 0,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      rx: 4,
      class: "map-bg",
    }),
  );

  // Four-corner labels (STEP37): the canonical label model replaces the
  // one-per-edge axis list. Each corner renders ONE label carrying its X pole
  // first, Y pole second, in Title Case, sourced from the projector constants;
  // this removes the previous missing-top-right and lower-left-overlap defects.
  // Labels stay fixed (orientation guides, §17) — they never zoom.
  const corners = soundSpaceCornerLabels();
  const corner4 = [
    { x: 8, y: MAP_HEIGHT - 8, anchor: "start", text: corners.bottomLeft, hint: `${corners.bottomLeft} (left, bottom)` },
    { x: MAP_WIDTH - 8, y: MAP_HEIGHT - 8, anchor: "end", text: corners.bottomRight, hint: `${corners.bottomRight} (right, bottom)` },
    { x: 8, y: 16, anchor: "start", text: corners.topLeft, hint: `${corners.topLeft} (left, top)` },
    { x: MAP_WIDTH - 8, y: 16, anchor: "end", text: corners.topRight, hint: `${corners.topRight} (right, top)` },
  ];
  for (const a of corner4) {
    const t = svgEl("text", {
      x: a.x,
      y: a.y,
      "text-anchor": a.anchor,
      class: "map-axis",
    });
    t.textContent = a.text;
    const tip = svgEl("title", {});
    tip.textContent = a.hint;
    t.appendChild(tip);
    svg.appendChild(t);
  }

  // Hover tooltip overlay (pure content via mapView.tooltipFor).
  const tip = document.createElement("div");
  tip.className = "map-tooltip";
  tip.setAttribute("data-testid", "map-tooltip");
  tip.style.display = "none";
  container.appendChild(tip);

  // Content group: EVERYTHING that represents map data (points) lives here; the
  // camera transform is applied to this group and only to this group.
  const content = svgEl("g", { class: "map-content" }) as SVGGElement;
  applyContentTransform(content, camera);
  svg.appendChild(content);

  const byId = new Map<string, SampleIndexRecord>();
  for (const record of opts.records) byId.set(record.sampleId, record);

  // Point radius (STEP91): zoom only shrinks the SAME points. The base-unit SVG
  // radius is the desired screen radius divided by the camera zoom, because the
  // content group carries the zoom transform; after that group's scale(zoom) the
  // ON-SCREEN radius resolves to exactly `pointRadius(zoom)` (see mapView.ts).
  // Emphasized (focused / batch-selected, §8.2) stays proportionally larger.
  // Presentation only — positions untouched.
  const restRadius = pointRadius(camera.zoom) / camera.zoom;
  const emphasizedRadius = pointRadius(camera.zoom, true) / camera.zoom;

  // Points: one circle per map point, positioned ONLY by the view-model; the
  // camera transform moves the whole group, never the circles themselves. Every
  // painted element is a real sample point at its real coordinate, and the set
  // is identical at every zoom.
  for (const point of displayed) {
    const s = toScreen(point, { width: MAP_WIDTH, height: MAP_HEIGHT });
    const focused = point.sampleId === opts.selectedSampleId;
    // FINAL UI/UX v1.1 Phase 1: batch-selected points get the selection
    // treatment too; a focused + selected point carries both classes.
    const inSelection =
      opts.selectedSampleIds?.includes(point.sampleId) ?? false;
    const cls = ["map-point"];
    if (focused) cls.push("map-point-selected");
    if (inSelection) cls.push("map-point-in-selection");
    const circle = svgEl("circle", {
      cx: s.x,
      cy: s.y,
      r: focused || inSelection ? emphasizedRadius : restRadius,
      class: cls.join(" "),
      fill: semanticDotColor(point.primaryClass, point.semanticSubtype),
      "data-sample-id": point.sampleId,
      "data-testid": `map-point-${point.sampleId}`,
    });
    circle.appendChild(svgEl("title", {}));
    (circle.querySelector("title")!).textContent = point.name;
    content.appendChild(circle);
  }

  // ---------------------------------------------------------------
  // Interaction: hover, click-vs-drag pan, wheel zoom (Step 15F).
  // ---------------------------------------------------------------
  let dragging: DragState | undefined;

  // STEP90 — the camera this surface last committed. Wheel bursts arrive much
  // faster than a render, so successive steps must accumulate on this local
  // view instead of each re-deriving from the camera captured at render time
  // (which would drop every step but the last in a burst).
  let view = camera;

  function hoverClear(): void {
    hideTooltip(tip);
    for (const el of content.querySelectorAll(".map-point-hovered")) {
      el.classList.remove("map-point-hovered");
    }
  }

  function hoverAt(base: ScreenPosition): void {
    // Hit-test the DISPLAYED points, not the full set: a point that the display
    // limit left out is not painted, so it must not answer a hover either.
    const hit = pointAt(displayed, base, camera);
    hoverClear();
    if (!hit) return;
    content
      .querySelector(`[data-sample-id="${hit.sampleId}"]`)
      ?.classList.add("map-point-hovered");
    showTooltip(tip, hit);
  }

  svg.addEventListener("pointermove", (e) => {
    if (dragging) {
      const dx = e.clientX - dragging.startX;
      const dy = e.clientY - dragging.startY;
      if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        dragging.panning = true;
        dragging.lastCamera = panBy(dragging.startCamera, dx, dy);
        svg.style.cursor = "grabbing";
        applyContentTransform(content, dragging.lastCamera);
      }
      return;
    }
    hoverAt(clientToBase(svg, { x: e.clientX, y: e.clientY }));
  });

  svg.addEventListener("pointerleave", () => {
    if (!dragging) hoverClear();
  });

  svg.addEventListener("pointerdown", (e) => {
    const base = clientToBase(svg, { x: e.clientX, y: e.clientY });
    // Hit-test the displayed points, so only a painted point can be selected.
    const point = pointAt(displayed, base, camera);
    if (point) {
      const record = byId.get(point.sampleId);
      if (record) {
        opts.onSelect?.(record);
      } else if (point.origin === "global" && opts.onSelectGlobal) {
        opts.onSelectGlobal(point);
      }
      return;
    }
    svg.setPointerCapture(e.pointerId);
    dragging = {
      startX: e.clientX,
      startY: e.clientY,
      startCamera: camera,
      lastCamera: camera,
      panning: false,
    };
    svg.style.cursor = "grabbing";
  });

  const endDrag = (): void => {
    if (!dragging) return;
    if (dragging.panning) {
      view = dragging.lastCamera;
      opts.onCamera?.(dragging.lastCamera);
    }
    svg.style.cursor = "";
    dragging = undefined;
  };

  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const base = clientToBase(svg, { x: e.clientX, y: e.clientY });
      const factor = Math.exp(-e.deltaY * 0.0015);
      view = zoomBy(view, factor, base);
      opts.onCamera?.(view);
      svg.style.cursor = "";
    },
    { passive: false },
  );
}

/** Show the pure hover tooltip near the container's top-left corner. */
function showTooltip(tip: HTMLElement, point: MapPoint): void {
  const info = tooltipFor(point);

  const name = document.createElement("div");
  name.className = "map-tooltip-name";
  name.textContent = info.title;

  const cls = document.createElement("div");
  cls.className = "map-tooltip-class";
  cls.textContent = `Class: ${info.classification}`;

  const owner = document.createElement("div");
  owner.className = "map-tooltip-owner";
  owner.textContent = `Owner: ${info.owner}`;

  const tags = document.createElement("div");
  tags.className = "map-tooltip-tags";
  tags.textContent =
    info.originalTags.length > 0
      ? `Tags: ${info.originalTags.join(", ")}`
      : "Tags: none";

  // §7.4 help note — position is an impression, not a measurement.
  const note = document.createElement("div");
  note.className = "map-tooltip-note";
  note.textContent =
    "Position is an impression of timbre, not a precise acoustic measurement.";

  tip.textContent = "";
  tip.append(name, cls, owner, tags, note);
  tip.style.display = "block";
}

function hideTooltip(tip: HTMLElement): void {
  tip.style.display = "none";
}