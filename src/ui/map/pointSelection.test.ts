import { describe, it, expect } from "vitest";
import {
  MAX_DISPLAYED_POINTS,
  LOD_CELLS_ACROSS,
  levelForZoom,
  representativesAtLevel,
  selectDisplayedPoints,
  type ViewportBounds,
} from "./pointSelection";
import {
  BASE_POINT_RADIUS_PX,
  MAX_ZOOM,
  MIN_ZOOM,
  MIN_POINT_RADIUS_PX,
  pointRadius,
  SELECTED_POINT_SCALE,
} from "./mapView";
import type { MapPoint } from "./mapView";
import type { AudioContentIdentity } from "../../identity/audioContentIdentity";

/**
 * STEP86 / STEP90 — the hard display limit that replaced cluster rendering.
 *
 * The map draws individual sample points only. STEP90 replaced the
 * zoom-dependent ROUND-ROBIN that caused ID churn with a hierarchical quadtree
 * LOD: every point stands for its cell's representative, and the representative
 * is `argmin(contentIdentityKey + sampleId)`, so it does not depend on the
 * queried level. These tests pin the four stability rules (zoom-in monotonicity,
 * representative stability, pan neutrality, deterministic zoom-out), the hard
 * limit, determinism, and that no coordinate is ever rewritten.
 */
function point(id: string, x: number, y: number): MapPoint {
  const identity: AudioContentIdentity = {
    contentHash: id.padEnd(64, "0").slice(0, 64),
    contentHashVersion: "pcm-v1",
  };
  return {
    sampleId: `samples/${id}`,
    sampleIds: [`samples/${id}`],
    contentIdentity: identity,
    name: `Sample ${id}`,
    owner: "owner",
    primaryClass: "kick",
    confidence: 0.9,
    originalTags: [],
    x,
    y,
  };
}

/** `count` points on a deterministic grid covering the whole map. */
function grid(count: number, side = 25): MapPoint[] {
  const out: MapPoint[] = [];
  for (let i = 0; i < count; i++) {
    out.push(point(
      String(i).padStart(6, "0"),
      ((i * 7) % side + 0.5) / side,
      ((i * 13) % side + 0.5) / side,
    ));
  }
  return out;
}

/**
 * `count` points on a genuine 2D lattice covering the whole map.
 *
 * Unlike `grid`, x and y advance independently, so every region of the map is
 * actually occupied — required to exercise viewport/pan/split behaviour.
 */
function field(count: number, side = 40): MapPoint[] {
  const out: MapPoint[] = [];
  for (let i = 0; i < count; i++) {
    out.push(point(
      String(i).padStart(6, "0"),
      ((i % side) + 0.5) / side,
      ((Math.floor(i / side) % side) + 0.5) / side,
    ));
  }
  return out;
}

const ids = (points: readonly MapPoint[]) => points.map((p) => p.sampleId).sort();

const FULL: ViewportBounds = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };

/** Viewport of a camera zoomed `z` around the map centre (1 = full map). */
function viewAtZoom(z: number): ViewportBounds {
  const half = 0.5 / z;
  return { xMin: 0.5 - half, xMax: 0.5 + half, yMin: 0.5 - half, yMax: 0.5 + half };
}

function inside(p: MapPoint, b: ViewportBounds): boolean {
  return p.x >= b.xMin && p.x <= b.xMax && p.y >= b.yMin && p.y <= b.yMax;
}

/** Deterministic shuffle (no Math.random, so a failure is reproducible). */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  let seed = 12345;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("STEP86 — display limit: at or below the maximum", () => {
  it("returns every point when the library is at the maximum", () => {
    const points = grid(MAX_DISPLAYED_POINTS);
    const shown = selectDisplayedPoints(points);
    expect(shown).toHaveLength(MAX_DISPLAYED_POINTS);
    expect(ids(shown)).toEqual(ids(points));
  });

  it("returns every point when the library is well below the maximum", () => {
    const points = grid(120);
    const shown = selectDisplayedPoints(points);
    expect(shown).toHaveLength(120);
    expect(ids(shown)).toEqual(ids(points));
  });

  it("is a no-op for an empty or single-point map", () => {
    expect(selectDisplayedPoints([])).toEqual([]);
    const one = point("only", 0.5, 0.5);
    expect(selectDisplayedPoints([one])).toEqual([one]);
  });
});

describe("STEP90 — display limit: above the maximum", () => {
  it("never exceeds MAX_DISPLAYED_POINTS and never returns nothing", () => {
    const shown = selectDisplayedPoints(grid(MAX_DISPLAYED_POINTS * 3), {
      bbox: FULL,
    });
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThanOrEqual(MAX_DISPLAYED_POINTS);
  });

  it("spreads the selection over the whole map instead of one corner", () => {
    const shown = selectDisplayedPoints(grid(MAX_DISPLAYED_POINTS * 4), {
      bbox: FULL,
    });
    const xs = shown.map((p) => p.x);
    const ys = shown.map((p) => p.y);
    expect(Math.min(...xs)).toBeLessThan(0.2);
    expect(Math.max(...xs)).toBeGreaterThan(0.8);
    expect(Math.min(...ys)).toBeLessThan(0.2);
    expect(Math.max(...ys)).toBeGreaterThan(0.8);
    const quadrants = new Set(shown.map((p) => `${p.x > 0.5 ? "r" : "l"}${p.y > 0.5 ? "t" : "b"}`));
    expect(quadrants.size).toBe(4);
  });

  it("shows points from a densely populated region AND a sparse one", () => {
    // Everything crammed into one quadtree cell, plus one far-away point: the
    // lonely point must survive, because every occupied cell contributes a
    // representative (the dense cell collapses to exactly one).
    const dense: MapPoint[] = [];
    for (let i = 0; i < 3000; i++) {
      dense.push(point(String(i).padStart(6, "0"), 0.02 + (i % 50) * 0.0005, 0.02 + ((i / 50) | 0) * 0.0005));
    }
    const lonely = point("999999", 0.97, 0.97);
    const shown = selectDisplayedPoints([...dense, lonely], { bbox: FULL });
    expect(shown.length).toBeLessThanOrEqual(MAX_DISPLAYED_POINTS);
    expect(ids(shown)).toContain("samples/999999");
  });

  it("never produces duplicates", () => {
    const shown = selectDisplayedPoints(grid(MAX_DISPLAYED_POINTS * 2), {
      bbox: FULL,
    });
    expect(new Set(ids(shown)).size).toBe(shown.length);
  });

  it("keeps the original coordinates of every displayed point", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 2);
    const byId = new Map(points.map((p) => [p.sampleId, p]));
    for (const shown of selectDisplayedPoints(points, { bbox: FULL })) {
      // Identity, not just equality: the very same object is handed through.
      expect(shown).toBe(byId.get(shown.sampleId));
      expect(shown.x).toBe(byId.get(shown.sampleId)!.x);
      expect(shown.y).toBe(byId.get(shown.sampleId)!.y);
    }
  });

  it("collapses duplicate content identities to one deterministic representative", () => {
    const a = point("dup", 0.1, 0.1);
    const b: MapPoint = { ...a, sampleId: "samples/dup-reimport", sampleIds: ["samples/dup-reimport"] };
    const shown = selectDisplayedPoints([a, b, b, a]);
    expect(shown).toHaveLength(1);
    expect(shown[0].sampleId).toBe("samples/dup");
  });
});

describe("STEP90 — determinism", () => {
  it("produces the same selection for the same data in a different order", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 2);
    const reference = ids(selectDisplayedPoints(points, { bbox: FULL }));
    for (const permutation of [shuffled(points), shuffled(points), [...points].reverse()]) {
      expect(ids(selectDisplayedPoints(permutation, { bbox: FULL }))).toEqual(reference);
    }
  });

  it("produces the same ORDER, not just the same set", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 2);
    const reference = selectDisplayedPoints(points, { bbox: FULL }).map((p) => p.sampleId);
    expect(
      selectDisplayedPoints(shuffled(points), { bbox: FULL }).map((p) => p.sampleId),
    ).toEqual(reference);
  });

  it("is independent of the input order for the pure LOD primitive too", () => {
    const points = field(900, 40);
    const reference = ids(representativesAtLevel(points, levelForZoom(4), FULL));
    expect(ids(representativesAtLevel(shuffled(points), levelForZoom(4), FULL))).toEqual(reference);
  });

  it("is stable across repeated calls with the same input", () => {
    const points = grid(MAX_DISPLAYED_POINTS + 137);
    const first = ids(selectDisplayedPoints(points, { bbox: FULL }));
    expect(ids(selectDisplayedPoints(points, { bbox: FULL }))).toEqual(first);
    expect(ids(selectDisplayedPoints(points, { bbox: FULL }))).toEqual(first);
  });
});

describe("STEP90 — hierarchical LOD stability rules", () => {
  it("levelForZoom is monotone non-decreasing and clamps to the configured range", () => {
    // CELLS_ACROSS=16, zoom 1 -> level 4; zoom 8 -> level 7.
    expect(levelForZoom(MIN_ZOOM)).toBe(Math.round(Math.log2(LOD_CELLS_ACROSS)));
    expect(levelForZoom(MAX_ZOOM)).toBe(Math.round(Math.log2(LOD_CELLS_ACROSS * MAX_ZOOM)));
    let previous = -Infinity;
    for (let z = MIN_ZOOM; z <= MAX_ZOOM; z += 0.05) {
      const level = levelForZoom(z);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
    expect(levelForZoom(1e9)).toBe(levelForZoom(MAX_ZOOM));
    expect(levelForZoom(-1)).toBe(levelForZoom(MIN_ZOOM));
  });

  it("Regel B — a cell's representative does not change when the cell splits", () => {
    // Every representative of a coarser level must survive at the finer level,
    // because exactly one child inherits it.
    const points = field(900, 40);
    const coarse = representativesAtLevel(points, 4, FULL);
    const fine = new Set(representativesAtLevel(points, 5, FULL).map((p) => p.sampleId));
    expect(coarse.length).toBeGreaterThan(0);
    for (const p of coarse) expect(fine.has(p.sampleId)).toBe(true);
  });

  it("Regel A — zoom-in never drops a point that stays inside the viewport", () => {
    const points = field(MAX_DISPLAYED_POINTS * 3, 40);
    const narrow = viewAtZoom(MAX_ZOOM);
    const zoomedOut = selectDisplayedPoints(points, { zoom: MIN_ZOOM, bbox: FULL });
    const zoomedIn = new Set(
      selectDisplayedPoints(points, { zoom: MAX_ZOOM, bbox: narrow }).map((p) => p.sampleId),
    );
    const mustSurvive = zoomedOut.filter((p) => inside(p, narrow));
    expect(mustSurvive.length).toBeGreaterThan(0);
    for (const p of mustSurvive) expect(zoomedIn.has(p.sampleId)).toBe(true);
  });

  it("Regel C — panning only changes viewport membership, never a representative", () => {
    const points = field(900, 40);
    const level = levelForZoom(4);
    const left: ViewportBounds = { ...FULL, xMax: 0.6 };
    const right: ViewportBounds = { ...FULL, xMin: 0.4 };
    const overlap: ViewportBounds = { xMin: 0.4, xMax: 0.6, yMin: 0, yMax: 1 };
    const inLeft = new Set(representativesAtLevel(points, level, left).map((p) => p.sampleId));
    const inRight = new Set(representativesAtLevel(points, level, right).map((p) => p.sampleId));
    const shared = representativesAtLevel(points, level, overlap);
    expect(shared.length).toBeGreaterThan(0);
    for (const p of shared) {
      expect(inLeft.has(p.sampleId)).toBe(true);
      expect(inRight.has(p.sampleId)).toBe(true);
    }
  });

  it("Regel D — zoom-out reduces detail deterministically (nested sets)", () => {
    const points = field(MAX_DISPLAYED_POINTS * 3, 40);
    const zoomedOut = representativesAtLevel(points, levelForZoom(1), FULL);
    const zoomedIn = representativesAtLevel(points, levelForZoom(4), FULL);
    const finer = new Set(zoomedIn.map((p) => p.sampleId));
    expect(zoomedOut.length).toBeGreaterThan(0);
    expect(zoomedOut.length).toBeLessThanOrEqual(zoomedIn.length);
    for (const p of zoomedOut) expect(finer.has(p.sampleId)).toBe(true);
  });

  it("shrinks the ON-SCREEN point size as zoom increases, with a floor", () => {
    let prev = pointRadius(MIN_ZOOM);
    expect(prev).toBe(BASE_POINT_RADIUS_PX);
    for (const zoom of [1, 2, 4, MAX_ZOOM]) {
      // The renderer divides by zoom, the content group multiplies by zoom, so
      // the ON-SCREEN radius is exactly pointRadius(zoom).
      const onScreen = (pointRadius(zoom) / zoom) * zoom;
      expect(onScreen).toBe(pointRadius(zoom));
      expect(onScreen).toBeLessThanOrEqual(prev + 1e-12);
      expect(onScreen).toBeGreaterThanOrEqual(MIN_POINT_RADIUS_PX);
      prev = onScreen;
    }
    expect((pointRadius(MAX_ZOOM, true) / MAX_ZOOM) * MAX_ZOOM).toBeCloseTo(
      pointRadius(MAX_ZOOM) * SELECTED_POINT_SCALE,
      12,
    );
  });
});

describe("STEP86 — focused and selected points are never hidden", () => {
  it("always shows the focused point, even deep in an unselected region", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 3);
    const baseline = new Set(ids(selectDisplayedPoints(points, { bbox: FULL })));
    const hidden = points.find((p) => !baseline.has(p.sampleId))!;
    expect(baseline.has(hidden.sampleId)).toBe(false);

    const shown = ids(
      selectDisplayedPoints(points, { bbox: FULL, keepSampleIds: [hidden.sampleId] }),
    );
    expect(shown).toContain(hidden.sampleId);
    expect(shown.length).toBeLessThanOrEqual(MAX_DISPLAYED_POINTS);
  });

  it("always shows every batch-selected point", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 3);
    const baseline = new Set(ids(selectDisplayedPoints(points, { bbox: FULL })));
    const hidden = points
      .filter((p) => !baseline.has(p.sampleId))
      .slice(0, 8)
      .map((p) => p.sampleId);
    expect(hidden).toHaveLength(8);

    const shown = ids(
      selectDisplayedPoints(points, { bbox: FULL, keepSampleIds: hidden }),
    );
    for (const id of hidden) expect(shown).toContain(id);
    expect(shown.length).toBeLessThanOrEqual(MAX_DISPLAYED_POINTS);
  });

  it("does not overshoot the maximum when pinning points", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 2);
    const keep = points.slice(0, 5).map((p) => p.sampleId);
    const shown = selectDisplayedPoints(points, { bbox: FULL, keepSampleIds: keep });
    expect(shown.length).toBeLessThanOrEqual(MAX_DISPLAYED_POINTS);
    for (const id of keep) expect(ids(shown)).toContain(id);
  });

  it("does not double-count a pinned point that would also be sampled", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 2);
    const target = points[0].sampleId;
    const shown = ids(selectDisplayedPoints(points, { bbox: FULL, keepSampleIds: [target] }));
    expect(shown.filter((id) => id === target)).toHaveLength(1);
    expect(shown.length).toBeLessThanOrEqual(MAX_DISPLAYED_POINTS);
  });

  it("ignores a pinned id that is not on the map (no phantom points)", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 2);
    const shown = selectDisplayedPoints(points, {
      bbox: FULL,
      keepSampleIds: ["samples/does-not-exist"],
    });
    expect(shown.length).toBeLessThanOrEqual(MAX_DISPLAYED_POINTS);
    expect(ids(shown)).not.toContain("samples/does-not-exist");
  });
});

describe("STEP90 — the limit is a display constant, not a data constant", () => {
  it("keeps the hard display budget at 500", () => {
    expect(MAX_DISPLAYED_POINTS).toBe(500);
  });
});
