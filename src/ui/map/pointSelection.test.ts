import { describe, it, expect } from "vitest";
import {
  MAX_DISPLAYED_POINTS,
  DISPLAY_CELL_NORM,
  displayCellSize,
  selectDisplayedPoints,
} from "./pointSelection";
import {
  BASE_POINT_RADIUS_PX,
  MAP_WIDTH,
  MAX_ZOOM,
  MIN_ZOOM,
  pointRadius,
  SELECTED_POINT_SCALE,
} from "./mapView";
import type { MapPoint } from "./mapView";
import type { AudioContentIdentity } from "../../identity/audioContentIdentity";

/**
 * STEP86 — the hard display limit that replaced cluster rendering.
 *
 * The map draws individual sample points only. When the library is larger than
 * `MAX_DISPLAYED_POINTS`, exactly that many are drawn, chosen SPATIALLY and
 * DETERMINISTICALLY. These tests pin that contract, plus the guarantees that
 * matter for trust: no coordinate is ever rewritten, no point is duplicated,
 * and the sample the user is working with is never the one that disappears.
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

const ids = (points: readonly MapPoint[]) => points.map((p) => p.sampleId).sort();

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

describe("STEP86 — display limit: above the maximum", () => {
  it("shows exactly MAX_DISPLAYED_POINTS", () => {
    const shown = selectDisplayedPoints(grid(MAX_DISPLAYED_POINTS * 3));
    expect(shown).toHaveLength(MAX_DISPLAYED_POINTS);
  });

  it("spreads the selection over the whole map instead of one corner", () => {
    // A stable-sort prefix (or slice) would keep only a small region. The
    // round-robin must cover both axes across the full normalized range.
    const shown = selectDisplayedPoints(grid(MAX_DISPLAYED_POINTS * 4));
    const xs = shown.map((p) => p.x);
    const ys = shown.map((p) => p.y);
    expect(Math.min(...xs)).toBeLessThan(0.2);
    expect(Math.max(...xs)).toBeGreaterThan(0.8);
    expect(Math.min(...ys)).toBeLessThan(0.2);
    expect(Math.max(...ys)).toBeGreaterThan(0.8);
    // Every quadrant of the map is represented, not just one.
    const quadrants = new Set(shown.map((p) => `${p.x > 0.5 ? "r" : "l"}${p.y > 0.5 ? "t" : "b"}`));
    expect(quadrants.size).toBe(4);
  });

  it("shows points from a densely populated region AND a sparse one", () => {
    // Everything crammed into one cell, plus one far-away point: the far point
    // must survive, because the budget is shared across cells.
    const dense: MapPoint[] = [];
    for (let i = 0; i < 3000; i++) {
      dense.push(point(String(i).padStart(6, "0"), 0.02 + (i % 50) * 0.0005, 0.02 + ((i / 50) | 0) * 0.0005));
    }
    const lonely = point("999999", 0.97, 0.97);
    const shown = ids(selectDisplayedPoints([...dense, lonely]));
    expect(shown).toHaveLength(MAX_DISPLAYED_POINTS);
    expect(shown).toContain("samples/999999");
  });

  it("never produces duplicates", () => {
    const shown = selectDisplayedPoints(grid(MAX_DISPLAYED_POINTS * 2));
    expect(new Set(ids(shown)).size).toBe(shown.length);
  });

  it("keeps the original coordinates of every displayed point", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 2);
    const byId = new Map(points.map((p) => [p.sampleId, p]));
    for (const shown of selectDisplayedPoints(points)) {
      // Identity, not just equality: the very same object is handed through.
      expect(shown).toBe(byId.get(shown.sampleId));
      expect(shown.x).toBe(byId.get(shown.sampleId)!.x);
      expect(shown.y).toBe(byId.get(shown.sampleId)!.y);
    }
  });

  it("collapses duplicate content identities to one deterministic representative", () => {
    const a = point("dup", 0.1, 0.1);
    // Same content identity, different sample id (a re-import).
    const b: MapPoint = { ...a, sampleId: "samples/dup-reimport", sampleIds: ["samples/dup-reimport"] };
    const shown = selectDisplayedPoints([a, b, b, a]);
    expect(shown).toHaveLength(1);
    // The representative is chosen by key, not by arrival order.
    expect(shown[0].sampleId).toBe("samples/dup");
  });
});

describe("STEP86 — determinism", () => {
  it("produces the same selection for the same data in a different order", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 2);
    const reference = ids(selectDisplayedPoints(points));
    for (const permutation of [shuffled(points), shuffled(points), [...points].reverse()]) {
      expect(ids(selectDisplayedPoints(permutation))).toEqual(reference);
    }
  });

  it("produces the same ORDER, not just the same set", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 2);
    const reference = selectDisplayedPoints(points).map((p) => p.sampleId);
    expect(selectDisplayedPoints(shuffled(points)).map((p) => p.sampleId)).toEqual(reference);
  });

  it("is stable across repeated calls with the same input", () => {
    const points = grid(MAX_DISPLAYED_POINTS + 137);
    const first = ids(selectDisplayedPoints(points));
    expect(ids(selectDisplayedPoints(points))).toEqual(first);
    expect(ids(selectDisplayedPoints(points))).toEqual(first);
  });
});

describe("STEP86 — focused and selected points are never hidden", () => {
  it("always shows the focused point, even deep in an unselected region", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 3);
    // Pick a point that the plain spatial selection would drop.
    const baseline = new Set(ids(selectDisplayedPoints(points)));
    const hidden = points.find((p) => !baseline.has(p.sampleId))!;
    expect(baseline.has(hidden.sampleId)).toBe(false);

    const shown = ids(selectDisplayedPoints(points, { keepSampleIds: [hidden.sampleId] }));
    expect(shown).toContain(hidden.sampleId);
    expect(shown).toHaveLength(MAX_DISPLAYED_POINTS);
  });

  it("always shows every batch-selected point", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 3);
    const baseline = new Set(ids(selectDisplayedPoints(points)));
    const hidden = points
      .filter((p) => !baseline.has(p.sampleId))
      .slice(0, 8)
      .map((p) => p.sampleId);
    expect(hidden).toHaveLength(8);

    const shown = ids(selectDisplayedPoints(points, { keepSampleIds: hidden }));
    for (const id of hidden) expect(shown).toContain(id);
    expect(shown).toHaveLength(MAX_DISPLAYED_POINTS);
  });

  it("reserves the pinned slots instead of overshooting the maximum", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 2);
    const keep = points.slice(0, 5).map((p) => p.sampleId);
    const shown = selectDisplayedPoints(points, { keepSampleIds: keep });
    expect(shown).toHaveLength(MAX_DISPLAYED_POINTS);
    for (const id of keep) expect(ids(shown)).toContain(id);
  });

  it("does not double-count a pinned point that would also be sampled", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 2);
    const target = points[0].sampleId;
    const shown = ids(selectDisplayedPoints(points, { keepSampleIds: [target] }));
    expect(shown.filter((id) => id === target)).toHaveLength(1);
    expect(shown).toHaveLength(MAX_DISPLAYED_POINTS);
  });

  it("ignores a pinned id that is not on the map (no phantom points)", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 2);
    const shown = selectDisplayedPoints(points, { keepSampleIds: ["samples/does-not-exist"] });
    expect(shown).toHaveLength(MAX_DISPLAYED_POINTS);
    expect(ids(shown)).not.toContain("samples/does-not-exist");
  });
});

describe("STEP86 — zoom only re-partitions, it never moves a point", () => {
  it("shrinks the selection cell as the zoom grows", () => {
    expect(displayCellSize(MIN_ZOOM)).toBeCloseTo(DISPLAY_CELL_NORM, 12);
    expect(displayCellSize(MAX_ZOOM)).toBeCloseTo(DISPLAY_CELL_NORM / MAX_ZOOM, 12);
  });

  it("keeps the ON-SCREEN point size constant at every zoom", () => {
    // The renderer divides the screen-space radius by the zoom and the content
    // group multiplies it back, so the painted radius is zoom-independent. That
    // is the invariant that makes more of these points legibly distinguishable
    // when the user zooms in — the reason the display limit may be
    // zoom-dependent while no point ever changes size.
    for (const zoom of [MIN_ZOOM, 1, 2, 4, MAX_ZOOM]) {
      const onScreen = (pointRadius(zoom) / zoom) * zoom;
      expect(onScreen).toBeCloseTo(BASE_POINT_RADIUS_PX, 12);
      expect((pointRadius(zoom, true) / zoom) * zoom).toBeCloseTo(
        BASE_POINT_RADIUS_PX * SELECTED_POINT_SCALE,
        12,
      );
    }
  });

  it("can promote a different set of points, but keeps every coordinate", () => {
    const points = grid(MAX_DISPLAYED_POINTS * 3);
    const zoomedOut = ids(selectDisplayedPoints(points, { zoom: 1 }));
    const zoomedIn = ids(selectDisplayedPoints(points, { zoom: 8 }));
    // Zooming re-partitions the grid, so the two sets may differ…
    expect(zoomedOut).toHaveLength(MAX_DISPLAYED_POINTS);
    expect(zoomedIn).toHaveLength(MAX_DISPLAYED_POINTS);
    // …but no zoom level ever invents or relocates a sample.
    const known = new Set(points.map((p) => p.sampleId));
    for (const id of [...zoomedOut, ...zoomedIn]) expect(known.has(id)).toBe(true);
    const byId = new Map(points.map((p) => [p.sampleId, p]));
    for (const p of selectDisplayedPoints(points, { zoom: 8 })) {
      expect(p.x).toBe(byId.get(p.sampleId)!.x);
      expect(p.y).toBe(byId.get(p.sampleId)!.y);
    }
  });
});

describe("STEP86 — the limit is a display constant, not a data constant", () => {
  it("does not depend on the map size constant beyond the cell grid", () => {
    // The cell grid is expressed in base pixels over the map width; a change of
    // the map size must not change the NUMBER of points shown.
    expect(MAX_DISPLAYED_POINTS).toBe(500);
    expect(DISPLAY_CELL_NORM).toBeCloseTo(80 / MAP_WIDTH, 12);
  });
});
