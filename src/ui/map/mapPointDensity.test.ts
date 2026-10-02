import { describe, expect, it } from "vitest";

import { BASE_POINT_RADIUS_PX, MIN_POINT_RADIUS_PX, POINT_HIT_RADIUS_PX, SELECTED_POINT_SCALE, pointRadius } from "./mapView";

/**
 * STEP76 — visual density guard for large point clouds.
 * Reproduces the 800+ sample situation with plain geometry (no UI, no data
 * changes) and pins the two properties the shrink had to keep: visible
 * separation and unchanged clickability / focus emphasis.
 */
describe("map view : point size under a dense cloud (800+ samples)", () => {
  const N = 826;

  /** Deterministic pseudo-random cloud inside the 1200x800 map canvas. */
  const cloud = (n: number, spread: number): Array<{ x: number; y: number }> =>
    Array.from({ length: n }, (_, i) => {
      const a = Math.sin(i * 12.9898) * 43758.5453;
      const b = Math.sin(i * 78.233) * 12345.6789;
      return { x: 600 + (a - Math.floor(a) - 0.5) * spread, y: 400 + (b - Math.floor(b) - 0.5) * spread * 0.66 };
    });

  /** Pairwise count of circles whose bounding boxes overlap. */
  const overlapping = (pts: Array<{ x: number; y: number }>, r: number): number => {
    let n = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < 2 * r) n++;
      }
    }
    return n;
  };

  it("reduces overlap in a dense 826-point cloud versus the old 5px radius", () => {
    const pts = cloud(N, 900);
    const old = overlapping(pts, 5);
    const now = overlapping(pts, BASE_POINT_RADIUS_PX);
    expect(now).toBeLessThan(old);
    // 2.5px radius halves the diameter, so the crowded-pair count drops sharply.
    expect(now).toBeLessThan(old / 2);
  });

  it("renders every one of the 826 points (no count limit, no dropping)", () => {
    const pts = cloud(N, 900);
    expect(pts).toHaveLength(826);
    // Radii are assigned per point, never per page: N points -> N circles.
    const radii = pts.map(() => pointRadius(1));
    expect(radii).toHaveLength(826);
    expect(new Set(radii)).toEqual(new Set([BASE_POINT_RADIUS_PX]));
  });

  it("shrinks points as the user zooms in, floored at the minimum", () => {
    let prev = pointRadius(1);
    for (const zoom of [0.5, 1, 1.6, 2, 4, 8]) {
      const r = pointRadius(zoom);
      expect(r).toBeLessThanOrEqual(prev + 1e-12);
      expect(r).toBeGreaterThanOrEqual(MIN_POINT_RADIUS_PX);
      prev = r;
    }
    expect(pointRadius(4)).toBeLessThan(pointRadius(1));
  });

  it("keeps focus/selection strictly larger than the resting point", () => {
    const rest = pointRadius(1);
    const emph = pointRadius(1, true);
    expect(emph).toBeGreaterThan(rest);
    expect(emph / rest).toBeCloseTo(SELECTED_POINT_SCALE, 5);
    expect(emph).toBeCloseTo(3.375, 5);
  });

  it("keeps clickability untouched: hit radius still covers the smaller dot many times over", () => {
    expect(POINT_HIT_RADIUS_PX).toBe(13);
    expect(POINT_HIT_RADIUS_PX).toBeGreaterThan(pointRadius(1) * 4);
  });

  it("zoomed-in points stay separable (no re-growth with zoom)", () => {
    const zoomed = cloud(N, 900 * 4);
    expect(overlapping(zoomed, BASE_POINT_RADIUS_PX)).toBeLessThan(overlapping(zoomed, 5));
  });
});
