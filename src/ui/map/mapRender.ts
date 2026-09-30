import type { SampleIndexRecord } from "../../persistence/indexStore";
import {
  CLUSTER_RADIUS_PX,
  DRAG_THRESHOLD_PX,
  EMPTY_MAP_MESSAGE,
  MAP_HEIGHT,
  MAP_WIDTH,
  MapCamera,
  MapCluster,
  MapEntry,
  MapPoint,
  ScreenPosition,
  ZOOM_STEP,
  clusterMapPoints,
  defaultMapCamera,
  entryAt,
  entryCoverage,
  globalMapPoints,
  mapPoints,
  mergeMapPoints,
  panBy,
  pointRadius,
  toScreen,
  tooltipFor,
  zoomBy,
  zoomToCenterOn,
} from "./mapView";
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
  /**
   * Called when the user clicks a CLUSTER (LOD PoC).
   *
   * A cluster is NOT a sample, so this is deliberately separate from
   * `onSelect`: a cluster click never selects a record, never triggers a
   * preview and never persists anything. The renderer additionally zooms the
   * camera onto the cluster through `onCamera` (see `zoomToCenterOn`).
   */
  onClusterSelect?: (cluster: MapCluster) => void;
  /** Current view camera (Step 15F). Defaults to the full-map view. */
  camera?: MapCamera;
  /** Commit a new camera (drag-pan end / wheel zoom). Runtime state only. */
  onCamera?: (camera: MapCamera) => void;
  /** Overrides the default "No analyzed samples yet." empty-state message. */
  emptyMessage?: string;
  /**
   * STEP85 — read-only report of what was actually PAINTED.
   *
   * Called after the renderable entries are computed (and also for the empty
   * map, with zeros). It exists purely so the UI can tell the user apart
   * between loaded/analyzed samples, deduplicated content identities, rendered
   * map points and clusters — the four numbers that used to be indistinguishable.
   * It never influences what is drawn.
   */
  onRendered?: (info: MapRenderInfo) => void;
}

/** STEP85 — the observed counts behind one rendered map frame. */
export interface MapRenderInfo {
  /** Records handed to the map (already filtered by Global/My visibility). */
  readonly records: number;
  /** Local map points after content-identity dedup (before the global merge). */
  readonly localPoints: number;
  /** Points actually drawn-or-counted, after the local/global merge. */
  readonly points: number;
  /** Rendered elements: single points + clusters. */
  readonly entries: number;
  /** How many of those elements are clusters. */
  readonly clusters: number;
  /** How many of those elements are individual sample points. */
  readonly singles: number;
  /** Sum of all point + cluster counts — always equal to `points`. */
  readonly covered: number;
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

  if (points.length === 0) {
    const empty = document.createElement("div");
    empty.className = "map-empty";
    empty.setAttribute("data-testid", "map-empty");
    empty.textContent = opts.emptyMessage ?? EMPTY_MAP_MESSAGE;
    container.appendChild(empty);
    opts.onRendered?.({
      records: opts.records.length,
      localPoints: localPoints.length,
      points: 0,
      entries: 0,
      clusters: 0,
      singles: 0,
      covered: 0,
    });
    return;
  }

  // LOD / clustering (PoC) — strictly AFTER the existing pipeline above, so
  // Global/My visibility, the content-identity dedup and the global/local
  // overlap are all already decided. Clustering only chooses how many of those
  // very points are painted at this zoom.
  const entries: readonly MapEntry[] = clusterMapPoints(points, camera.zoom);

  // STEP85 — report the observed counts (read-only; changes nothing below).
  const clusterCount = entries.reduce((n, e) => n + (e.kind === "cluster" ? 1 : 0), 0);
  opts.onRendered?.({
    records: opts.records.length,
    localPoints: localPoints.length,
    points: points.length,
    entries: entries.length,
    clusters: clusterCount,
    singles: entries.length - clusterCount,
    covered: entryCoverage(entries),
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

  // Point radius (FINAL_UI_UX §8.1 + STEP38 §27, corrected): the base-unit SVG
  // radius is the SCREEN-space constant divided by the camera zoom, because the
  // content group carries the zoom transform. The rendered ON-SCREEN radius is
  // therefore exactly BASE_POINT_RADIUS_PX at every zoom level — zoom
  // changes spatial separation ONLY, never point size. Emphasized (focused or
  // batch-selected, §8.2) uses a larger but equally zoom-independent radius.
  // Presentation only — positions untouched.
  const restRadius = pointRadius(camera.zoom) / camera.zoom;
  const emphasizedRadius = pointRadius(camera.zoom, true) / camera.zoom;

  // Points: one per analyzed record, positioned ONLY by the view-model; the
  // camera transform moves the whole group, never the circles themselves.
  //
  // With the LOD PoC the loop walks RENDER ENTRIES: a cell holding one point
  // paints exactly the circle it painted before, a cell holding several paints
  // ONE cluster (circle + count) instead of N circles.
  const clusterRadius = CLUSTER_RADIUS_PX / camera.zoom;
  for (const entry of entries) {
    if (entry.kind === "cluster") {
      const s = toScreen(entry, { width: MAP_WIDTH, height: MAP_HEIGHT });
      const group = svgEl("g", {
        class: "map-cluster",
        transform: `translate(${s.x} ${s.y})`,
        "data-testid": `map-cluster-${entry.cell}`,
        "data-cluster-cell": entry.cell,
        "data-cluster-count": entry.count,
      });
      // A cluster is not a sample: it carries NO `data-sample-id` (and no
      // sample-scoped testid), so it can never be mistaken for — or selected
      // as — one of the samples it stands for.
      group.appendChild(
        svgEl("circle", { cx: 0, cy: 0, r: clusterRadius, class: "map-cluster-dot" }),
      );
      const label = svgEl("text", {
        x: 0,
        y: clusterRadius * 0.36,
        "text-anchor": "middle",
        class: "map-cluster-count",
        // The camera scales the whole content group, so expressing the size in
        // base units divided by the zoom keeps it constant in SCREEN px — the
        // same rule the point radius follows.
        "font-size": clusterRadius * 1.2,
      });
      label.textContent = String(entry.count);
      group.appendChild(label);
      const clusterTitle = svgEl("title", {});
      clusterTitle.textContent = `${entry.count} samples — click to zoom in`;
      group.appendChild(clusterTitle);
      content.appendChild(group);
      continue;
    }

    const point = entry.point;
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

  function hoverClear(): void {
    hideTooltip(tip);
    for (const el of content.querySelectorAll(
      ".map-point-hovered, .map-cluster-hovered",
    )) {
      el.classList.remove("map-point-hovered");
      el.classList.remove("map-cluster-hovered");
    }
  }

  function hoverAt(base: ScreenPosition): void {
    // Hit-test the RENDERED entries, not the raw points: a member of a
    // collapsed cluster is not painted, so it must not answer a hover either.
    const hit = entryAt(entries, base, camera);
    hoverClear();
    if (!hit) return;
    if (hit.kind === "cluster") {
      content
        .querySelector(`[data-cluster-cell="${hit.cluster.cell}"]`)
        ?.classList.add("map-cluster-hovered");
      showClusterTooltip(tip, hit.cluster);
      return;
    }
    content
      .querySelector(`[data-sample-id="${hit.point.sampleId}"]`)
      ?.classList.add("map-point-hovered");
    showTooltip(tip, hit.point);
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
    // Hit-test the rendered entries, so a collapsed cluster answers as a
    // cluster and never as one of its undrawn members.
    const hit = entryAt(entries, base, camera);
    if (hit) {
      if (hit.kind === "cluster") {
        // Cluster click: zoom the view onto the cluster. No selection, no
        // preview, no persistence — a cluster is not a sample.
        opts.onClusterSelect?.(hit.cluster);
        opts.onCamera?.(zoomToCenterOn(camera, hit.cluster, ZOOM_STEP));
        return;
      }
      const point = hit.point;
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
    if (dragging.panning) opts.onCamera?.(dragging.lastCamera);
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
      opts.onCamera?.(zoomBy(camera, factor, base));
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

/**
 * Hover info for a CLUSTER (LOD PoC).
 *
 * A cluster is not a sample, so it must not show a sample tooltip: no name, no
 * class, no owner and no tags of some arbitrary member. It states the count and
 * the available action instead.
 */
function showClusterTooltip(tip: HTMLElement, cluster: MapCluster): void {
  const count = document.createElement("div");
  count.className = "map-tooltip-name";
  count.textContent = `${cluster.count} samples`;

  const hint = document.createElement("div");
  hint.className = "map-tooltip-class";
  hint.textContent = "Zoom in to separate these samples";

  tip.textContent = "";
  tip.append(count, hint);
  tip.style.display = "block";
}

function hideTooltip(tip: HTMLElement): void {
  tip.style.display = "none";
}