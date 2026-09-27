import { describe, it, expect } from "vitest";

import {
  CLUSTER_CELL_NORM,
  CLUSTER_CELL_PX,
  CLUSTER_HIT_RADIUS_PX,
  CLUSTER_MIN_POINTS,
  POINT_HIT_RADIUS_PX,
  CLUSTER_RADIUS_PX,
  MAP_HEIGHT,
  MAP_WIDTH,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  clusterCellSize,
  clusterMapPoints,
  defaultMapCamera,
  entryAt,
  entryAnchor,
  entryCoverage,
  globalMapPoints,
  mapPoints,
  mergeMapPoints,
  zoomToCenterOn,
  toScreen,
  type MapCluster,
  type MapEntry,
  type MapPoint,
} from "./mapView";
import { mapPoints as mapPointsAlias } from "./mapView";

/**
 * Map CLUSTER / LOD — pure, deterministic level of detail for the 2D map.
 *
 * The automatic background indexing can analyse up to 1000 samples, so a
 * zoomed-out map must aggregate instead of painting one `<circle>` per point.
 * Pinned here:
 *  1. below the threshold nothing changes (small maps render exactly as before),
 *  2. above it the entry count collapses, and the aggregation is LOSSLESS in
 *     count — every point is drawn or counted in exactly one cluster,
 *  3. it is deterministic: a shuffled input yields a bit-identical result,
 *  4. cells shrink with zoom, so a cluster progressively resolves,
 *  5. a cluster is not a sample: it has no sampleId and hit-testing can never
 *     return a collapsed member as if it were a visible point,
 *  6. the underlying sample coordinates are never modified.
 */

let seq = 0;

/** A synthetic MapPoint (NOT a record) with a unique content identity. */
function pt(x: number, y: number, id?: string): MapPoint {
  seq += 1;
  const sampleId = id ?? `samples/s${seq}`;
  return {
    sampleId,
    sampleIds: [sampleId],
    contentIdentity: {
      contentHash: `hash-${String(seq).padStart(4, "0")}`,
      contentHashVersion: "pcm-v1",
    },
    name: sampleId,
    owner: "users/alice",
    primaryClass: "kick",
    confidence: 0.9,
    originalTags: [],
    x,
    y,
    origin: "local",
  };
}

/** Deterministic pseudo-random cloud in the normalized map area. */
function cloud(n: number, seedOffset = 0): MapPoint[] {
  seq += seedOffset;
  return Array.from({ length: n }, (_, i) => {
    const a = Math.sin((i + 1) * 12.9898) * 43758.5453;
    const b = Math.sin((i + 1) * 78.233) * 12345.6789;
    return pt(
      (a - Math.floor(a)),
      (b - Math.floor(b)),
      `samples/c${String(i).padStart(4, "0")}`,
    );
  });
}

const clustersOf = (e: MapEntry[]) => e.filter((x): x is MapCluster => x.kind === "cluster");
const pointsOf = (e: MapEntry[]) =>
  e.filter((x) => x.kind === "point").map((x) => (x as { point: MapPoint }).point);

describe("map LOD : clusterMapPoints", () => {
  it("1. leaves a small map untouched (every point renders as itself)", () => {
    const few = [pt(0.1, 0.1), pt(0.11, 0.12), pt(0.9, 0.9), pt(0.05, 0.5)];
    expect(few.length).toBeLessThan(CLUSTER_MIN_POINTS);
    const entries = clusterMapPoints(few, 1);
    expect(entries).toHaveLength(few.length);
    expect(clustersOf(entries)).toHaveLength(0);
    expect(pointsOf(entries).map((p) => p.sampleId)).toEqual(
      few.map((p) => p.sampleId),
    );
  });

  it("2. collapses a 500-point cloud but loses nothing in count", () => {
    const points = cloud(500);
    const entries = clusterMapPoints(points, 1);
    const clusters = clustersOf(entries);

    // Fewer draw calls than points — that is the entire point of the PoC.
    expect(entries.length).toBeLessThan(points.length);
    expect(clusters.length).toBeGreaterThan(0);

    // Lossless: drawn points + clustered points == the input, exactly once.
    expect(entryCoverage(entries)).toBe(500);
    const seen = new Set<string>();
    for (const e of entries) {
      if (e.kind === "point") seen.add(e.point.sampleId);
      else for (const m of e.points) seen.add(m.sampleId);
    }
    expect(seen.size).toBe(500);

    // Clusters are drawn by their count, which is what the label shows.
    for (const c of clusters) {
      expect(c.count).toBe(c.points.length);
      expect(c.count).toBeGreaterThanOrEqual(2);
    }
  });

  it("3. is deterministic: a shuffled input gives a bit-identical result", () => {
    const points = cloud(400);
    const a = clusterMapPoints(points, 1);
    const b = clusterMapPoints(points, 1);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));

    // Reverse the input order — the output must not move.
    const reversed = clusterMapPoints([...points].reverse(), 1);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(a));

    // A deterministic pseudo-shuffle too.
    const shuffled = [...points].sort(
      (x, y) =>
        (x.contentIdentity.contentHash > y.contentIdentity.contentHash ? 1 : -1),
    );
    expect(JSON.stringify(clusterMapPoints(shuffled, 1))).toBe(JSON.stringify(a));
  });

  it("4. uses LARGER cells zoomed out and finer cells zoomed in", () => {
    expect(clusterCellSize(MIN_ZOOM)).toBeCloseTo(CLUSTER_CELL_NORM, 12);
    expect(clusterCellSize(MAX_ZOOM)).toBeCloseTo(CLUSTER_CELL_NORM / MAX_ZOOM, 12);
    // Monotonically finer as the zoom grows.
    for (let z = MIN_ZOOM; z < MAX_ZOOM; z *= 2) {
      expect(clusterCellSize(z * 2)).toBeLessThan(clusterCellSize(z));
    }
    // The cell covers a constant number of SCREEN pixels at every zoom.
    const cellPx = (z: number) => clusterCellSize(z) * MAP_WIDTH * z;
    expect(cellPx(1)).toBeCloseTo(CLUSTER_CELL_PX, 6);
    expect(cellPx(4)).toBeCloseTo(CLUSTER_CELL_PX, 6);
    expect(cellPx(8)).toBeCloseTo(CLUSTER_CELL_PX, 6);
  });

  it("5. resolves progressively: finer cells the closer you zoom in", () => {
    const points = cloud(500);
    const entriesAt = (z: number) => clusterMapPoints(points, z);

    // A finer grid REFINES the coarser one (each coarse cell splits into
    // several fine cells), so the number of draw calls can only grow with the
    // zoom — and the drawn points per entry must shrink, which is the actual
    // "cluster resolves" property.
    const counts = [1, 2, 4, 8].map((z) => entriesAt(z).length);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }

    const maxCluster = (z: number) =>
      clustersOf(entriesAt(z)).reduce((m, c) => Math.max(m, c.count), 0);
    const drawnPoints = (z: number) => pointsOf(entriesAt(z)).length;

    // The biggest cluster shrinks as we zoom in ...
    for (const [z, next] of [[1, 2], [2, 4], [4, 8]] as const) {
      expect(maxCluster(next)).toBeLessThanOrEqual(maxCluster(z));
    }
    expect(maxCluster(MAX_ZOOM)).toBeLessThanOrEqual(2);
    // ... and more samples are drawn individually.
    expect(drawnPoints(8)).toBeGreaterThan(drawnPoints(1));
    expect(drawnPoints(8)).toBeGreaterThan(points.length / 2);

    // Nothing is ever lost on the way.
    for (const z of [1, 2, 4, 8]) expect(entryCoverage(entriesAt(z))).toBe(500);
  });

  it("6. puts a cluster centroid inside the bounds of its own cell", () => {
    const entries = clusterMapPoints(cloud(600), 1);
    for (const c of clustersOf(entries)) {
      const cell = clusterCellSize(1);
      const [col, row] = c.cell.split(":").map(Number);
      const minX = col * cell;
      const minY = row * cell;
      for (const m of c.points) {
        expect(m.x).toBeGreaterThanOrEqual(minX);
        expect(m.x).toBeLessThan(minX + cell);
        expect(m.y).toBeGreaterThanOrEqual(minY);
        expect(m.y).toBeLessThan(minY + cell);
      }
      // The centroid is the mean of the members.
      const mx = c.points.reduce((s, p) => s + p.x, 0) / c.count;
      const my = c.points.reduce((s, p) => s + p.y, 0) / c.count;
      expect(c.x).toBeCloseTo(mx, 12);
      expect(c.y).toBeCloseTo(my, 12);
      expect(c.x).toBeGreaterThanOrEqual(minX);
      expect(c.x).toBeLessThanOrEqual(minX + cell);
    }
  });

  it("7. never modifies the underlying points", () => {
    const points = cloud(300);
    const snapshot = JSON.stringify(points);
    const entries = clusterMapPoints(points, 1);
    entryCoverage(entries);
    expect(JSON.stringify(points)).toBe(snapshot);

    // Cluster members are the very same objects, with untouched coordinates.
    const byId = new Map(points.map((p) => [p.sampleId, p]));
    for (const c of clustersOf(entries)) {
      for (const m of c.points) {
        expect(m).toBe(byId.get(m.sampleId));
      }
    }
  });

  it("8. a cluster is not a sample: it carries no sample identity", () => {
    const entries = clusterMapPoints(cloud(500), 1);
    const clusters = clustersOf(entries);
    expect(clusters.length).toBeGreaterThan(0);
    for (const c of clusters) {
      // No sampleId anywhere on the cluster itself — only on its members.
      expect("sampleId" in c).toBe(false);
      expect("sampleIds" in c).toBe(false);
      expect("contentIdentity" in c).toBe(false);
      expect(c.points.every((p) => typeof p.sampleId === "string")).toBe(true);
      // Its handle is the cell, not a sample.
      expect(c.cell).toMatch(/^-?\d+:-?\d+$/);
    }
  });

  it("9. handles the map's coordinate edges without merging them backwards", () => {
    // Points exactly on the upper/right border must not fold into the last
    // full cell, and must never leave the [0,1] area.
    const pts = [
      ...cloud(30),
      pt(1, 1, "samples/edge-br"),
      pt(0, 0, "samples/edge-tl"),
      pt(0.999999, 0.999999, "samples/edge-just-inside"),
    ];
    const entries = clusterMapPoints(pts, 1);
    expect(entryCoverage(entries)).toBe(pts.length);
    for (const c of clustersOf(entries)) {
      for (const m of c.points) {
        expect(m.x).toBeGreaterThanOrEqual(0);
        expect(m.x).toBeLessThanOrEqual(1);
        expect(m.y).toBeGreaterThanOrEqual(0);
        expect(m.y).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("map LOD : entryAt hit testing", () => {
  it("returns a point for a drawn point and a cluster for a cluster", () => {
    const points = cloud(500);
    const entries = clusterMapPoints(points, 1);
    const camera = defaultMapCamera();
    const cluster = clustersOf(entries)[0];
    expect(cluster).toBeDefined();

    // On the cluster centroid -> a cluster hit, never a member.
    const hitCluster = entryAt(
      entries,
      toScreen(entryAnchor(cluster), { width: MAP_WIDTH, height: MAP_HEIGHT }),
      camera,
    );
    expect(hitCluster?.kind).toBe("cluster");
    if (hitCluster?.kind === "cluster") {
      expect(hitCluster.cluster.cell).toBe(cluster.cell);
      expect(hitCluster.cluster.count).toBe(cluster.count);
    }

    // A drawn point -> the existing point behaviour.
    const single = pointsOf(entries)[0];
    expect(single).toBeDefined();
    const hitPoint = entryAt(
      entries,
      toScreen(entryAnchor({ kind: "point", point: single }), { width: MAP_WIDTH, height: MAP_HEIGHT }),
      camera,
    );
    expect(hitPoint?.kind).toBe("point");
    if (hitPoint?.kind === "point") {
      expect(hitPoint.point.sampleId).toBe(single.sampleId);
    }
  });

  it("never returns a collapsed member as if it were a visible point", () => {
    const points = cloud(500);
    const entries = clusterMapPoints(points, 1);
    const camera = defaultMapCamera();
    const hidden = new Set<string>();
    for (const c of clustersOf(entries)) for (const m of c.points) hidden.add(m.sampleId);

    // Probe every member's own position: whatever comes back must be that very
    // cluster (or a point entry), never a bare member of a collapsed cell.
    for (const c of clustersOf(entries)) {
      for (const m of c.points) {
        const hit = entryAt(
          entries,
          toScreen(entryAnchor({ kind: "point", point: m }), { width: MAP_WIDTH, height: MAP_HEIGHT }),
          camera,
        );
        if (!hit) continue;
        if (hit.kind === "point") {
          // Legal only if this point is itself drawn on its own.
          expect(hidden.has(hit.point.sampleId)).toBe(false);
        } else {
          expect(hit.cluster.count).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("returns nothing in empty space", () => {
    const entries = clusterMapPoints(cloud(500), 1);
    expect(entryAt(entries, { x: 5, y: 5 }, defaultMapCamera())).toBeUndefined();
  });

  it("gives a cluster its own, larger hit radius than a point", () => {
    // A cluster paints bigger than a point, so it must also be easier to grab.
    expect(CLUSTER_HIT_RADIUS_PX).toBeGreaterThan(CLUSTER_RADIUS_PX);
    expect(CLUSTER_HIT_RADIUS_PX).toBeGreaterThan(POINT_HIT_RADIUS_PX);

    const points = cloud(500);
    const entries = clusterMapPoints(points, 1);
    const camera = defaultMapCamera();
    const cluster = clustersOf(entries)[0];
    const centroid = toScreen(entryAnchor(cluster), {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
    });

    // A point in the band BETWEEN the two radii (13 < d <= 18): too far for a
    // point hit, close enough for a cluster. Cells are exclusive, so nothing
    // else can be nearer.
    const band = POINT_HIT_RADIUS_PX + 2;
    expect(band).toBeLessThanOrEqual(CLUSTER_HIT_RADIUS_PX);
    const hit = entryAt(entries, { x: centroid.x + band, y: centroid.y }, camera);
    expect(hit?.kind).toBe("cluster");
    if (hit?.kind === "cluster") expect(hit.cluster.cell).toBe(cluster.cell);

    // Just inside the cluster radius, and well outside it.
    expect(
      entryAt(entries, { x: centroid.x + CLUSTER_HIT_RADIUS_PX - 1, y: centroid.y }, camera)
        ?.kind,
    ).toBe("cluster");
    expect(
      entryAt(entries, { x: centroid.x + CLUSTER_HIT_RADIUS_PX + 2, y: centroid.y }, camera)
        ?.kind,
    ).not.toBe("cluster");

    // A drawn point keeps the NARROW radius: the same distance misses it.
    const single = pointsOf(entries)[0];
    const singleScreen = toScreen(entryAnchor({ kind: "point", point: single }), {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
    });
    expect(
      entryAt(entries, { x: singleScreen.x + band, y: singleScreen.y }, camera),
    ).toBeUndefined();
  });
});

describe("map LOD : zoomToCenterOn", () => {
  it("centres the given coordinate and zooms in", () => {
    const camera = defaultMapCamera();
    const coord = { x: 0.5, y: 0.5 };
    const next = zoomToCenterOn(camera, coord, ZOOM_STEP);

    expect(next.zoom).toBe(camera.zoom * ZOOM_STEP);
    // The coordinate lands in the middle of the viewport.
    const screen = toScreen(coord, { width: MAP_WIDTH, height: MAP_HEIGHT });
    expect(screen.x * next.zoom + next.panX).toBeCloseTo(MAP_WIDTH / 2, 6);
    expect(screen.y * next.zoom + next.panY).toBeCloseTo(MAP_HEIGHT / 2, 6);
  });

  it("still honours the pan clamp, so the map keeps covering the viewport", () => {
    // A corner coordinate CANNOT be centred at a higher zoom: §11 forbids
    // panning the map edge inwards, so the map would stop covering the
    // viewport. zoomToCenterOn must respect that clamp.
    const camera = defaultMapCamera();
    const coord = { x: 0.02, y: 0.02 };
    const next = zoomToCenterOn(camera, coord, ZOOM_STEP);
    expect(next.zoom).toBe(camera.zoom * ZOOM_STEP);

    // Clamped into the legal range: content top-left never enters the
    // viewport, so the map always fully covers it.
    expect(next.panX).toBeLessThanOrEqual(0);
    expect(next.panY).toBeLessThanOrEqual(0);
    expect(next.panX).toBeGreaterThanOrEqual(MAP_WIDTH * (1 - next.zoom));
    expect(next.panY).toBeGreaterThanOrEqual(MAP_HEIGHT * (1 - next.zoom));
    // X had to be clamped (the ideal value would be positive), Y did not.
    expect(MAP_WIDTH / 2 - toScreen(coord, { width: MAP_WIDTH, height: MAP_HEIGHT }).x * next.zoom)
      .toBeGreaterThan(0);
  });

  it("respects the zoom bounds and is pure", () => {
    const camera = { zoom: MAX_ZOOM, panX: 0, panY: 0 };
    const next = zoomToCenterOn(camera, { x: 0.5, y: 0.5 }, ZOOM_STEP);
    expect(next.zoom).toBeLessThanOrEqual(MAX_ZOOM);
    expect(next.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    // Pure: the input camera is untouched.
    expect(camera).toEqual({ zoom: MAX_ZOOM, panX: 0, panY: 0 });
  });

  it("actually resolves the cluster it was zoomed onto", () => {
    const points = cloud(500);
    const before = clusterMapPoints(points, 1);
    // A densely populated cluster, not one that was already a near-singleton.
    const cluster = clustersOf(before).reduce((best, c) =>
      best === undefined || c.count > best.count ? c : best,
    undefined as MapCluster | undefined);
    expect(cluster).toBeDefined();
    expect(cluster!.count).toBeGreaterThanOrEqual(4);

    // Zoom the camera onto it and re-run the projection at the finer cells.
    const camera = zoomToCenterOn(defaultMapCamera(), cluster!, ZOOM_STEP);
    const after = clusterMapPoints(points, camera.zoom);
    expect(entryCoverage(after)).toBe(500);

    // At the new zoom the old cluster's own neighbourhood now holds several
    // smaller entries instead of one big one.
    const cell = clusterCellSize(camera.zoom);
    const oldCell = clusterCellSize(1);
    const oldCol = cluster!.x / oldCell;
    const oldRow = cluster!.y / oldCell;
    // The old cell spans this range of fine cells.
    const fineCols = new Set<number>();
    const fineRows = new Set<number>();
    for (let c = Math.floor(oldCol); c < Math.ceil(oldCol + oldCell / cell); c++) {
      fineCols.add(c);
    }
    for (let r = Math.floor(oldRow); r < Math.ceil(oldRow + oldCell / cell); r++) {
      fineRows.add(r);
    }
    const inOld = after.filter((e) => {
      const [c, r] = e.kind === "cluster"
        ? e.cell.split(":").map(Number)
        : [Math.floor(e.point.x / cell), Math.floor(e.point.y / cell)];
      return fineCols.has(c) && fineRows.has(r);
    });
    const biggest = inOld
      .filter((e): e is MapCluster => e.kind === "cluster")
      .reduce((m, c) => Math.max(m, c.count), 0);
    expect(inOld.length).toBeGreaterThan(1);
    expect(biggest).toBeLessThan(cluster!.count);
  });
});

describe("map LOD : clustering happens AFTER the merge pipeline", () => {
  it("keeps the global/local overlap collapsed to ONE point before clustering", () => {
    // Same content identity, one local + one global point.
    const identity = { contentHash: "same-hash", contentHashVersion: "pcm-v1" };
    const local: MapPoint = {
      sampleId: "samples/kick-909",
      sampleIds: ["samples/kick-909"],
      contentIdentity: identity,
      name: "Deep Kick 909",
      owner: "alice",
      primaryClass: "kick",
      confidence: 0.9,
      originalTags: [],
      x: 0.4,
      y: 0.4,
      origin: "local",
    };
    const global = globalMapPoints([
      {
        contentIdentity: identity,
        x: 0.4,
        y: 0.4,
        representativeSampleId: "samples/kick-909",
        primaryClass: "kick",
      },
    ])[0];

    const merged = mergeMapPoints([local], [global]);
    expect(merged).toHaveLength(1);
    // The local (richer metadata) point wins — unchanged by clustering.
    expect(merged[0].name).toBe("Deep Kick 909");
    expect(merged[0].origin).toBe("local");

    // Below the threshold it still renders as that one point.
    const entries = clusterMapPoints(merged, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("point");
    if (entries[0].kind === "point") {
      expect(entries[0].point.sampleId).toBe("samples/kick-909");
    }
  });

  it("keeps representativeSampleId and the mapPoints projection intact", () => {
    // The clustering layer is fed by the very same mapPoints() output.
    const records = cloud(40).map((p) => ({
      sampleId: p.sampleId,
      owner: p.owner,
      visibility: "public",
      name: p.name,
      kind: "kick",
      originalTags: [],
      primaryClass: "kick",
      confidence: 0.9,
      analysisBuild: "build-v1",
      audioFeatures: {} as never,
      mapPosition: { x: p.x, y: p.y },
      analyzedAt: "2026-01-01T00:00:00.000Z",
      status: "analyzed" as const,
    }));
    const projected = mapPoints(records as never);
    expect(projected).toHaveLength(40);

    const entries = clusterMapPoints(projected, 1);
    expect(entryCoverage(entries)).toBe(40);
    const rendered = [
      ...pointsOf(entries),
      ...clustersOf(entries).flatMap((c) => [...c.points]),
    ];
    // Every rendered point is one of the original projections, untouched.
    expect(new Set(rendered.map((p) => p.sampleId))).toEqual(
      new Set(projected.map((p) => p.sampleId)),
    );
    // Alias sanity: mapView is a single module, one implementation.
    expect(mapPointsAlias).toBe(mapPoints);
  });
});
