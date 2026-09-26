import { describe, it, expect } from "vitest";
import type { SampleIndexRecord } from "../../persistence/indexStore";
import { makeSample } from "../../persistence/test-helpers";
import { emptySoundCharacter, type SoundCharacter } from "../../analysis/soundCharacter";
import { computeCanonicalSoundSpacePoint } from "../../analysis/soundSpaceProjector";
import {
  mapPoints,
  toScreen,
  classColor,
  initialMapUiState,
  hover,
  select,
  findPoint,
  tooltipFor,
  EMPTY_MAP_MESSAGE,
  MAP_VERSION,
  MAP_WIDTH,
  MAP_HEIGHT,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM,
  ZOOM_STEP,
  defaultMapCamera,
  zoomBy,
  panBy,
  applyCamera,
  pointAt,
  BASE_POINT_RADIUS_PX,
  SELECTED_POINT_SCALE,
  pointRadius,
} from "./mapView";

/**
 * Build a record with deterministic features for map tests. The default
 * `makeSample` already has valid audioFeatures; these overrides make the
 * expected x/y trivially computable.
 */
interface RecOverrides {
  tonalNoiseRatio?: number;
  spectralCentroid?: number;
  primaryClass?: string;
  originalTags?: string[];
  name?: string;
  /** When true, build a record with NO audioFeatures (unpositionable). */
  noFeatures?: boolean;
  /** Explicit persisted V2 map position (defaults to makeSample's). */
  mapPosition?: { x: number; y: number } | null;
  /** Attach V2 analysis with the given sound character (default: none). */
  soundCharacter?: SoundCharacter;
}

function char(parts: Partial<SoundCharacter> = {}): SoundCharacter {
  return { ...emptySoundCharacter(), ...parts };
}

function v2With(char: SoundCharacter): SampleIndexRecord["analysisV2"] {
  return {
    analysisVersion: "2.0.0",
    features: {} as NonNullable<SampleIndexRecord["analysisV2"]>["features"],
    soundCharacter: char,
    quality: { overall: 1, featureCoverage: 0.5 },
  };
}

function rec(sampleId: string, over: RecOverrides = {}): SampleIndexRecord {
  const base = makeSample(sampleId);
  const shared = {
    ...(over.primaryClass !== undefined ? { primaryClass: over.primaryClass } : {}),
    ...(over.originalTags !== undefined ? { originalTags: over.originalTags } : {}),
    ...(over.name !== undefined ? { name: over.name } : {}),
    ...(over.mapPosition !== undefined
      ? { mapPosition: over.mapPosition === null ? undefined : over.mapPosition }
      : {}),
    ...(over.soundCharacter !== undefined
      ? { analysisV2: v2With(over.soundCharacter) }
      : {}),
  };
  if (over.noFeatures) {
    return makeSample(sampleId, { ...shared, audioFeatures: undefined });
  }
  return makeSample(sampleId, {
    ...shared,
    audioFeatures: {
      ...base.audioFeatures,
      tonalNoiseRatio: over.tonalNoiseRatio ?? base.audioFeatures.tonalNoiseRatio,
      spectralCentroid: over.spectralCentroid ?? base.audioFeatures.spectralCentroid,
    },
  });
}

const SIZE = { width: MAP_WIDTH, height: MAP_HEIGHT };
const SIZE_100 = { width: 100, height: 100 };

describe("map view : position (Step 15B integration)", () => {
  it("x=0 -> left edge, x=1 -> right edge", () => {
    expect(toScreen({ x: 0, y: 0.5 }, SIZE).x).toBe(0);
    expect(toScreen({ x: 1, y: 0.5 }, SIZE).x).toBe(SIZE.width);
  });

  it("y=0 -> bottom (DARK), y=1 -> top (BRIGHT)", () => {
    expect(toScreen({ x: 0.5, y: 0 }, SIZE).y).toBe(SIZE.height);
    expect(toScreen({ x: 0.5, y: 1 }, SIZE).y).toBe(0);
  });

  it("middle coordinate stays proportional", () => {
    const s = toScreen({ x: 0.5, y: 0.5 }, SIZE_100);
    expect(s.x).toBe(50);
    expect(s.y).toBe(50);
  });

  it("record position comes exclusively from the persisted V2 mapPosition", () => {
    const r = rec("samples/a", { mapPosition: { x: 0.4, y: 0.7 } });
    const [p] = mapPoints([r]);
    expect(p.x).toBe(r.mapPosition!.x);
    expect(p.y).toBe(r.mapPosition!.y);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(1);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(1);
  });
});

describe("map view : rendering projection", () => {
  it("an analyzed sample with audioFeatures becomes exactly one point", () => {
    const r = rec("samples/kick1");
    const points = mapPoints([r]);
    expect(points).toHaveLength(1);
    expect(points[0].sampleId).toBe("samples/kick1");
    expect(points[0].name).toBe(r.name);
    expect(points[0].primaryClass).toBe(r.primaryClass);
  });

  it("a record without audioFeatures is NOT falsely positioned", () => {
    const bad = rec("samples/nofeatures", { noFeatures: true });
    const points = mapPoints([bad]);
    expect(points).toHaveLength(0);
  });

  it("a record without a persisted V2 mapPosition (Missing-V2) is NOT positioned (no V1 fallback)", () => {
    const legacy = rec("samples/pre-v2", { mapPosition: null });
    expect(legacy.mapPosition).toBeUndefined();
    expect(mapPoints([legacy])).toHaveLength(0);
  });

  it("a non-analyzed record (pending/failed/gone) is not positioned", () => {
    const pending = makeSample("samples/p", { status: "pending" });
    const failed = makeSample("samples/f", { status: "failed" });
    expect(mapPoints([pending, failed])).toHaveLength(0);
  });

  it("multiple analyzed samples are independent points", () => {
    const a = rec("samples/a", { mapPosition: { x: 0.1, y: 0.2 } });
    const b = rec("samples/b", { mapPosition: { x: 0.8, y: 0.9 } });
    const c = rec("samples/c", { mapPosition: { x: 0.5, y: 0.5 } });
    const points = mapPoints([a, b, c]);
    expect(points.map((p) => p.sampleId)).toEqual([
      "samples/a",
      "samples/b",
      "samples/c",
    ]);
    expect(new Set(points.map((p) => `${p.x},${p.y}`)).size).toBe(3);
  });
});

describe("map view : STEP37 canonical Sound Space coordinates", () => {
  it("a projectable sound character pins the canonical V2 coordinate", () => {
    const r = rec("samples/a", {
      soundCharacter: char({ tonality: 1, noisiness: 0, brightness: 0.25 }),
      mapPosition: { x: 0.1, y: 0.9 },
    });
    const [p] = mapPoints([r]);
    expect(p.x).toBe(1); // mean(tonality=1, 1-noisiness=1)
    expect(p.y).toBe(0.25); // brightness
    expect(p.projection).toBe("sound-space-canonical");
  });

  it("canonical wins over the persisted mapPosition (single source of truth)", () => {
    const r = rec("samples/a", {
      soundCharacter: char({ tonality: 0, noisiness: 1, brightness: 1 }),
      mapPosition: { x: 0.99, y: 0.99 },
    });
    const [p] = mapPoints([r]);
    expect(p.x).toBe(0);
    expect(p.y).toBe(1);
  });

  it("the map coordinate equals the canonical projector output exactly", () => {
    const r = rec("samples/a", {
      soundCharacter: char({ tonality: 0.8, noisiness: 0.5, brightness: 0.3 }),
    });
    const [p] = mapPoints([r]);
    const canonical = computeCanonicalSoundSpacePoint(r)!;
    expect(p.x).toBe(canonical.x); // 0.65
    expect(p.y).toBe(canonical.y); // 0.3
  });

  it("an unprojectable sound character falls back to the persisted mapPosition", () => {
    const r = rec("samples/a", {
      soundCharacter: char(), // nothing determinable (§11) -> no canonical point
      mapPosition: { x: 0.4, y: 0.7 },
    });
    const [p] = mapPoints([r]);
    expect(p.projection).toBe("map-v2-legacy");
    expect(p.x).toBe(0.4);
    expect(p.y).toBe(0.7);
  });

  it("V2 record with neither a projectable character nor mapPosition is NOT placed", () => {
    const yOnly = rec("samples/y", {
      soundCharacter: char({ brightness: 0.5 }), // X dims absent -> no point (§11)
      mapPosition: null, // no legacy fallback either
    });
    expect(mapPoints([yOnly])).toHaveLength(0);
  });

  it("canonical coordinates are deterministic for identical records", () => {
    const a = rec("samples/a", {
      soundCharacter: char({ tonality: 0.6, noisiness: 0.2, brightness: 0.7 }),
    });
    const [p1] = mapPoints([a]);
    const [p2] = mapPoints([a]);
    expect(p1.x).toBe(p2.x);
    expect(p1.y).toBe(p2.y);
  });
});

describe("map view : classification visual", () => {
  it("different classes map to different visual categories (colors)", () => {
    expect(classColor("kick")).not.toBe(classColor("snare"));
    expect(classColor("kick")).not.toBe(classColor("hihat"));
  });

  it("same class always maps to the same deterministic color", () => {
    expect(classColor("kick")).toBe(classColor("kick"));
  });

  it("unknown classes fall back to the default color", () => {
    expect(classColor("does-not-exist")).toBe("#9e9e9e");
  });

  it("classification NEVER changes the position", () => {
    const sameKin = (primaryClass: string) =>
      rec("samples/x", {
        primaryClass,
        tonalNoiseRatio: 0.62,
        spectralCentroid: 2100,
      });
    const kick = mapPoints([sameKin("kick")])[0];
    const bass = mapPoints([sameKin("bass")])[0];
    expect(kick.x).toBe(bass.x);
    expect(kick.y).toBe(bass.y);
    expect(kick.primaryClass).toBe("kick");
    expect(bass.primaryClass).toBe("bass");
  });
});

describe("map view : interaction", () => {
  it("hover resolves to the correct sample information", () => {
    const a = rec("samples/a", { name: "Hard Kick 01" });
    const points = mapPoints([a]);
    const state = hover(initialMapUiState(), "samples/a");
    expect(state.hoveredSampleId).toBe("samples/a");
    const p = findPoint(points, state.hoveredSampleId)!;
    const tip = tooltipFor(p);
    expect(tip.title).toBe("Hard Kick 01");
    expect(tip.classification).toMatch(/^kick \(/);
    expect(tip.owner).toBe("alice");
  });

  it("click selects exactly that sample (unique selection state)", () => {
    let state = initialMapUiState();
    state = select(state, "samples/a");
    state = select(state, "samples/b");
    expect(state.selectedSampleId).toBe("samples/b");
    // unique: no multi-selection in the map model
    expect(Object.keys(state).filter((k) => k === "selectedSampleId")).toHaveLength(1);
  });

  it("hover can be cleared", () => {
    const state = hover(initialMapUiState(), "samples/a");
    expect(hover(state, undefined).hoveredSampleId).toBeUndefined();
  });

  it("findPoint returns undefined for absent ids", () => {
    const points = mapPoints([rec("samples/a")]);
    expect(findPoint(points, undefined)).toBeUndefined();
    expect(findPoint(points, "samples/nope")).toBeUndefined();
  });

  it("tooltip keeps classification separate from original tags (INV-2)", () => {
    const r = rec("samples/a", { originalTags: ["pierre", "my-kick"] });
    const tip = tooltipFor(mapPoints([r])[0]);
    expect(tip.classification).toMatch(/^kick /);
    // classification block is from primaryClass/confidence only, never a tag:
    expect(tip.classification).not.toContain("pierre");
    expect(tip.originalTags).toEqual(["pierre", "my-kick"]);
  });
});

describe("map view : empty state + determinism", () => {
  it("no samples -> no crash and empty projection", () => {
    expect(mapPoints([])).toEqual([]);
    expect(EMPTY_MAP_MESSAGE).toBe("No analyzed samples yet.");
  });

  it("records without features or without analyzed status -> empty map", () => {
    const mixed = [
      makeSample("samples/ok", { primaryClass: "kick" }),
      makeSample("samples/bad", { audioFeatures: undefined }),
      makeSample("samples/pend", { status: "pending" }),
    ];
    const points = mapPoints(mixed);
    expect(points).toHaveLength(1);
    expect(points[0].sampleId).toBe("samples/ok");
  });

  it("same records -> identical projections (deterministic)", () => {
    const records = [
      rec("samples/a", { tonalNoiseRatio: 0.2, spectralCentroid: 300 }),
      rec("samples/b", { tonalNoiseRatio: 0.8, spectralCentroid: 5000 }),
    ];
    expect(mapPoints(records)).toEqual(mapPoints(records));
  });

  it("exposes the Step 16Q map version constant", () => {
    expect(MAP_VERSION).toBe("map-v2");
  });
});

describe("map view : camera (Step 15F zoom + pan)", () => {
  const W = MAP_WIDTH;
  const H = MAP_HEIGHT;
  const CENTRE = { x: W / 2, y: H / 2 };

  it("default camera is the full map with no pan", () => {
    expect(defaultMapCamera()).toEqual({ zoom: DEFAULT_ZOOM, panX: 0, panY: 0 });
    expect(DEFAULT_ZOOM).toBe(1);
  });

  it("zoom in raises zoom and keeps the map centred (centre anchor)", () => {
    const c = zoomBy(defaultMapCamera(), ZOOM_STEP);
    expect(c.zoom).toBe(2);
    expect(c.panX).toBe(-W / 2);
    expect(c.panY).toBe(-H / 2);
  });

  it("zoom out lowers zoom back to the full map", () => {
    const c2 = zoomBy(defaultMapCamera(), ZOOM_STEP);
    const back = zoomBy(c2, 1 / ZOOM_STEP);
    expect(back.zoom).toBe(1);
    expect(back.panX).toBe(0);
    expect(back.panY).toBe(0);
  });

  it("zoom cannot exceed MAX_ZOOM", () => {
    expect(zoomBy(defaultMapCamera(), 1000000).zoom).toBe(MAX_ZOOM);
    expect(MAX_ZOOM).toBe(8);
  });

  it("zoom cannot go below MIN_ZOOM", () => {
    expect(zoomBy(defaultMapCamera(), 0.0001).zoom).toBe(MIN_ZOOM);
    expect(MIN_ZOOM).toBe(1);
  });

  it("wheel-style zoom keeps the base point under the pointer fixed", () => {
    const cam1 = defaultMapCamera();
    const anchor = { x: 300, y: 200 };
    const cam2 = zoomBy(cam1, 3, anchor);
    const baseX = (anchor.x - cam1.panX) / cam1.zoom;
    const baseY = (anchor.y - cam1.panY) / cam1.zoom;
    expect(baseX * cam2.zoom + cam2.panX).toBeCloseTo(anchor.x, 6);
    expect(baseY * cam2.zoom + cam2.panY).toBeCloseTo(anchor.y, 6);
  });

  it("repeated zoom-in steps advance deterministically and hit the max", () => {
    const steps = [2, 4, 8, 8];
    let cam = defaultMapCamera();
    for (const expected of steps) {
      cam = zoomBy(cam, ZOOM_STEP, CENTRE);
      expect(cam.zoom).toBe(expected);
    }
  });

  it("pan moves the view but preserves zoom", () => {
    const c = panBy({ zoom: 2, panX: -200, panY: -100 }, 50, 30);
    expect(c).toEqual({ zoom: 2, panX: -150, panY: -70 });
  });

  it("pan is clamped so the map always covers the viewport (no dead space)", () => {
    let c = panBy({ zoom: 2, panX: -200, panY: -100 }, 5000, 5000);
    expect(c.panX).toBe(0);
    expect(c.panY).toBe(0);
    c = panBy({ zoom: 2, panX: -200, panY: -100 }, -5000, -5000);
    expect(c.panX).toBe(W - 2 * W);
    expect(c.panY).toBe(H - 2 * H);
  });

  it("at zoom 1 there is nothing to pan (full map always visible)", () => {
    const c = panBy(defaultMapCamera(), 50, 50);
    expect(c).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });
});

describe("map view : camera-aware hit test (Step 15F hover/click)", () => {
  const W = MAP_WIDTH;
  const H = MAP_HEIGHT;
  const CENTRE = { x: W / 2, y: H / 2 };

  const makeTwo = () =>
    mapPoints([
      rec("samples/a", { mapPosition: { x: 0.2, y: 0.2 } }),
      rec("samples/b", { mapPosition: { x: 0.8, y: 0.8 } }),
    ]);

  it("hover after zoom identifies the correct sample under the pointer", () => {
    const points = makeTwo();
    const cam = zoomBy(defaultMapCamera(), 4, CENTRE);
    for (const p of points) {
      const screen = applyCamera(toScreen(p, SIZE), cam);
      expect(pointAt(points, screen, cam)?.sampleId).toBe(p.sampleId);
    }
  });

  it("hover after pan identifies the correct sample under the pointer", () => {
    const points = makeTwo();
    const cam = panBy(zoomBy(defaultMapCamera(), 3, CENTRE), 40, -25);
    for (const p of points) {
      const screen = applyCamera(toScreen(p, SIZE), cam);
      expect(pointAt(points, screen, cam)?.sampleId).toBe(p.sampleId);
    }
  });

  it("a pointer far from every point hits nothing (drag never selects)", () => {
    const points = makeTwo();
    const cam = defaultMapCamera();
    expect(pointAt(points, { x: W + 200, y: H + 200 }, cam)).toBeUndefined();
    expect(pointAt(points, { x: -50, y: -50 }, cam)).toBeUndefined();
  });

  it("clicks still resolve once zoomed: pointer offset goes through the camera", () => {
    const points = makeTwo();
    const cam = zoomBy(defaultMapCamera(), 4, CENTRE);
    const baseA = toScreen(points[0], SIZE);
    // Pointer at A's true (zoomed) position, 3 base px off-center still hits A:
    const nearA = applyCamera(baseA, cam);
    expect(pointAt(points, { x: nearA.x - 3, y: nearA.y + 3 }, cam)?.sampleId).toBe(
      points[0].sampleId,
    );
  });

  it("pointAt prefers the nearest point when two are both in range", () => {
    const points = mapPoints([
      rec("samples/a", { mapPosition: { x: 0.4, y: 0.5 } }),
      rec("samples/b", { mapPosition: { x: 0.7, y: 0.5 } }),
    ]);
    const cam = defaultMapCamera();
    const baseA = toScreen(points[0], SIZE);
    const baseB = toScreen(points[1], SIZE);
    // Both differ only in x by >40px; pointer 2px right of A.
    expect(baseA.y).toBe(baseB.y);
    expect(Math.abs(baseA.x - baseB.x)).toBeGreaterThan(40);
    expect(pointAt(points, { x: baseA.x + 2, y: baseA.y }, cam)?.sampleId).toBe(
      points[0].sampleId,
    );
  });
});

describe("map view : position invariance under camera (Step 15F §18)", () => {
  const records = [
    rec("samples/a", { mapPosition: { x: 0.2, y: 0.2 } }),
    rec("samples/b", { mapPosition: { x: 0.8, y: 0.8 } }),
  ];

  it("mapPoints() output is identical whatever the camera is", () => {
    const base = mapPoints(records)[0];
    const sNoZoom = applyCamera(toScreen(base, SIZE), defaultMapCamera());
    for (const zoom of [2, 4, 8]) {
      const viewed = applyCamera(toScreen(base, SIZE), { zoom, panX: -400, panY: -260 });
      // The VIEW (screen position) changes with zoom...
      expect(viewed.x).not.toBe(sNoZoom.x);
      expect(viewed.y).not.toBe(sNoZoom.y);
      // ...but the projection over records never does.
      expect(mapPoints(records)[0]).toEqual(base);
      expect(zoom).toBeGreaterThan(1);
    }
  });

  it("x/y stay exactly the persisted V2 mapPosition() values under any zoom/pan", () => {
    const cams = [defaultMapCamera(), zoomBy(defaultMapCamera(), 8)];
    for (const cam of cams) {
      const points = mapPoints(records);
      for (let i = 0; i < points.length; i++) {
        const pos = records[i].mapPosition!;
        expect(points[i].x).toBe(pos.x);
        expect(points[i].y).toBe(pos.y);
      }
      expect(cam.zoom).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("map view : point radius (FINAL_UI_UX §8.1 + STEP38 §27, corrected)", () => {
  it("base radius is exactly 5px in screen space at 100% zoom", () => {
    expect(pointRadius(DEFAULT_ZOOM)).toBe(BASE_POINT_RADIUS_PX);
    expect(BASE_POINT_RADIUS_PX).toBe(5);
  });

  it("radius is zoom-INDEPENDENT: exactly 5px at every zoom level", () => {
    // STEP38 correction — the point radius must NOT scale with zoom. The value
    // itself is a screen-space constant regardless of the argument.
    for (const zoom of [0.5, 1, 1.25, 1.6, 2, 4, 8]) {
      expect(pointRadius(zoom)).toBe(BASE_POINT_RADIUS_PX);
    }
    // The renderer draws the base-unit SVG radius as (screen radius ÷ group
    // zoom) so that after the content group's scale transform the ON-SCREEN
    // radius resolves back to exactly 5px at any zoom.
    for (const zoom of [1, 1.6, 2, 4, 8]) {
      const baseUnit = pointRadius(zoom) / zoom;
      expect(baseUnit * zoom).toBeCloseTo(BASE_POINT_RADIUS_PX, 5);
    }
  });

  it("emphasized (focused/batch-selected) radius = base × 1.35 (§8.2), ≈6.75px, also zoom-independent", () => {
    expect(pointRadius(DEFAULT_ZOOM, true)).toBeCloseTo(
      BASE_POINT_RADIUS_PX * SELECTED_POINT_SCALE,
      5,
    );
    expect(SELECTED_POINT_SCALE).toBe(1.35);
    for (const zoom of [1, 1.6, 2, 4, 8]) {
      expect(pointRadius(zoom, true)).toBe(BASE_POINT_RADIUS_PX * SELECTED_POINT_SCALE);
      expect((pointRadius(zoom, true) / zoom) * zoom).toBeCloseTo(
        BASE_POINT_RADIUS_PX * SELECTED_POINT_SCALE,
        5,
      );
    }
  });

  it("is pure presentation: zoom never changes the radius, no position input", () => {
    expect(pointRadius(4)).toBe(pointRadius(4));
    expect(pointRadius(4, true)).toBe(pointRadius(4, true));
    expect(pointRadius(1)).toBe(pointRadius(8));
    // Defensive: degenerate / non-finite zoom input still returns the 5px
    // constant (never NaN).
    expect(pointRadius(0)).toBe(BASE_POINT_RADIUS_PX);
    expect(Number.isFinite(pointRadius(Number.NaN))).toBe(true);
  });
});