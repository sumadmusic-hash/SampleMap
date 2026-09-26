/**
 * STEP24 — Sound Space projector tests (§29 geometry, §30 neighbor sanity,
 * §28 corpus validation, §54 projection benchmark).
 *
 * Corpus members are deterministic constructed signals via `analyzeCorpus` —
 * FIXTURE-class evidence (§16), never real recorded audio.
 */
import { describe, it, expect } from "vitest";
import {
  createSoundSpaceProjector,
  projectAll,
  projectSample,
  computeCanonicalSoundSpacePoint,
  soundSpaceCornerLabels,
  SOUND_SPACE_ALGORITHM_VERSION,
  SOUND_SPACE_X_HIGH,
  SOUND_SPACE_X_LOW,
  SOUND_SPACE_Y_HIGH,
  SOUND_SPACE_Y_LOW,
} from "./soundSpaceProjector";
import { SOUND_CHARACTER_DIMENSIONS } from "./config";
import {
  computeSoundCharacter,
  computeSoundCharacterQuality,
} from "./soundCharacter";
import type { SoundCharacter } from "./soundCharacter";
import { analyzeCorpus } from "../audio/v2Fixtures";
import { ANALYSIS_VERSION } from "./sampleAnalysisV2";
import type { SampleAnalysisV2 } from "./sampleAnalysisV2";
import { makeSample } from "../persistence/test-helpers";
import type { SampleIndexRecord } from "../persistence/indexStore";

const projector = createSoundSpaceProjector();

const nullChar = (): SoundCharacter =>
  Object.fromEntries(SOUND_CHARACTER_DIMENSIONS.map((d) => [d, null])) as unknown as SoundCharacter;

function charWith(values: Partial<Record<keyof SoundCharacter, number | null>>): SoundCharacter {
  return { ...nullChar(), ...values };
}

function corpusAnalysis(name: string): SampleAnalysisV2 {
  const features = analyzeCorpus(name, 44100);
  const soundCharacter = computeSoundCharacter(features);
  return {
    analysisVersion: ANALYSIS_VERSION,
    features,
    soundCharacter,
    quality: computeSoundCharacterQuality(soundCharacter),
  };
}

describe("STEP24 projection geometry (§29)", () => {
  it("A. determinism: same input -> same point (twice, and equal versions)", () => {
    const CHAR = charWith({
      brightness: 0.8,
      tonality: 0.6,
      noisiness: 0.2,
    });
    const a = projector.project(CHAR)!;
    const b = projector.project(CHAR)!;
    expect(a).toEqual(b);
    expect(createSoundSpaceProjector().project(CHAR)).toEqual(a);
    expect(projector.version).toBe(SOUND_SPACE_ALGORITHM_VERSION);
  });

  it("B. bounds: every produced coordinate is finite and within [0, 1]", () => {
    for (const name of [
      "pureTone440",
      "sustainedTone",
      "whiteNoise",
      "pinkNoise",
      "impulse",
      "shortClick",
      "lowSine110",
      "highSine2000",
      "lowThump",
      "highThump",
    ]) {
      const p = projector.project(corpusAnalysis(name).soundCharacter);
      expect(p).not.toBeNull();
      expect(p!.x).toBeGreaterThanOrEqual(0);
      expect(p!.x).toBeLessThanOrEqual(1);
      expect(p!.y).toBeGreaterThanOrEqual(0);
      expect(p!.y).toBeLessThanOrEqual(1);
    }
  });

  it("C. x = mean(tonality, 1 - noisiness) over present dims; y = brightness when present", () => {
    // All three dims present → both axes computable → point produced.
    const p = projector.project(charWith({ tonality: 0.6, noisiness: 0.2, brightness: 0.4 }))!;
    expect(p.x).toBeCloseTo((0.6 + 0.8) / 2, 12);
    expect(p.y).toBeCloseTo(0.4, 12);
    // Partial char with PRESENT brightness but missing noisiness: the X axis
    // renormalizes over the remaining tonality (null is SKIPPED, never 0).
    const partial = projector.project(charWith({ tonality: 0.6, brightness: 0.4 }))!;
    expect(partial.x).toBeCloseTo(0.6, 12);
    expect(partial.y).toBeCloseTo(0.4, 12);
  });

  it("D. null safety: fully-null character -> NO point (never NEUTRAL fabrication)", () => {
    expect(projector.project(nullChar())).toBeNull();
    // Only one axis computable → no point (documented minimum-dimension threshold).
    expect(projector.project(charWith({ brightness: 0.9 }))).toBeNull();
    expect(projector.project(charWith({ tonality: 0.9 }))).toBeNull();
    // dims outside [0,1] / non-finite are treated as missing, never as 0.
    expect(
      projector.project(charWith({ brightness: Number.NaN, tonality: 0.9, noisiness: 0.4 })),
    ).toBeNull();
    expect(
      projector.project(charWith({ brightness: 1.5, tonality: 0.9, noisiness: 0.4 })),
    ).toBeNull();
    const ok = projector.project(charWith({ brightness: 0.9, tonality: 0.9, noisiness: 0.4 }))!;
    expect(ok.x).toBeCloseTo((0.9 + 0.6) / 2, 12);
    expect(ok.y).toBeCloseTo(0.9, 12);
  });

  it("E. input immutability: the character is never mutated", () => {
    const c = charWith({ brightness: 0.7, tonality: 0.3, noisiness: 0.5 });
    const frozen = JSON.parse(JSON.stringify(c));
    projector.project(c);
    expect(c).toEqual(frozen);
  });

  it("F. X-only character (both X dims present, brightness null) → NO point (§11)", () => {
    // The X axis alone is computable, but Y is not — the documented
    // minimum-dimension threshold requires BOTH axes, so no point is produced.
    expect(
      projector.project(charWith({ tonality: 0.6, noisiness: 0.2 })),
    ).toBeNull();
  });
});

describe("STEP24 §28 corpus validation + §30 neighbor sanity (FIXTURE-class)", () => {
  const NAMES = [
    "pureTone440",
    "sustainedTone",
    "whiteNoise",
    "pinkNoise",
    "impulse",
    "shortClick",
    "lowSine110",
    "highSine2000",
    "lowThump",
    "highThump",
  ];
  const points = new Map(
    NAMES.map((n) => [n, projector.project(corpusAnalysis(n).soundCharacter)!]),
  );

  it("tonal samples sit right of noise; bright samples above dark samples", () => {
    expect(points.get("pureTone440")!.x).toBeGreaterThan(points.get("whiteNoise")!.x);
    expect(points.get("highSine2000")!.y).toBeGreaterThan(points.get("lowSine110")!.y);
    // Axis labels per §14.
    expect(SOUND_SPACE_X_LOW).toBe("Noisy");
    expect(SOUND_SPACE_X_HIGH).toBe("Tonal");
    expect(SOUND_SPACE_Y_LOW).toBe("Dark");
    expect(SOUND_SPACE_Y_HIGH).toBe("Bright");
  });

  it("STEP22-like neighbors stay close: 440-tone ~ sustainedTone closer than 440-tone ~ whiteNoise", () => {
    expect(
      Math.hypot(
        points.get("pureTone440")!.x - points.get("sustainedTone")!.x,
        points.get("pureTone440")!.y - points.get("sustainedTone")!.y,
      ),
    ).toBeLessThan(
      Math.hypot(
        points.get("pureTone440")!.x - points.get("whiteNoise")!.x,
        points.get("pureTone440")!.y - points.get("whiteNoise")!.y,
      ),
    );
    expect(
      Math.hypot(
        points.get("pureTone440")!.x - points.get("highSine2000")!.x,
        points.get("pureTone440")!.y - points.get("highSine2000")!.y,
      ),
    ).toBeLessThan(
      Math.hypot(
        points.get("pureTone440")!.x - points.get("whiteNoise")!.x,
        points.get("pureTone440")!.y - points.get("whiteNoise")!.y,
      ),
    );
  });

  it("documented projection loss: lowThump/highThump separate on Y", () => {
    expect(
      Math.hypot(
        points.get("lowThump")!.x - points.get("highThump")!.x,
        points.get("lowThump")!.y - points.get("highThump")!.y,
      ),
    ).toBeGreaterThan(0.15);
  });

  it("representative corpus coordinates are produced (recorded in the STEP24 report §10)", () => {
    for (const n of NAMES) {
      const p = points.get(n)!;
      console.log(`SOUNDSPACE ${n} x=${p.x.toFixed(4)} y=${p.y.toFixed(4)}`);
    }
  });
});

describe("STEP24 §54 projection benchmark (CONSTRUCTED records)", () => {
  // The features blob is irrelevant to projection; compute it ONCE so the
  // benchmark measures projection, not repeated FIXTURE audio rendering.
  const SHARED_FEATURES = analyzeCorpus("pureTone440", 44100);

  function synthRecord(i: number): SampleIndexRecord {
    const h = (n: number) => {
      let x = (i * 2654435761 + n * 40503) >>> 0;
      x ^= x >>> 15;
      x = x >>> 0; // keep the unsigned hash strictly non-negative
      return (x % 10_000) / 10_000;
    };
    const soundCharacter = charWith({
      brightness: h(1),
      density: h(2),
      transient: h(3),
      duration: h(4),
      tonality: h(5),
      noisiness: h(6),
      dynamics: h(7),
      complexity: h(8),
    });
    return makeSample(`samples/bench-${i}`, {
      analysisV2: {
        analysisVersion: ANALYSIS_VERSION,
        features: SHARED_FEATURES,
        soundCharacter,
        quality: computeSoundCharacterQuality(soundCharacter),
      },
    });
  }

  function bench(n: number): { ms: number; count: number } {
    const records = Array.from({ length: n }, (_, i) => synthRecord(i));
    const t0 = performance.now();
    const points = projectAll(projector, records);
    const ms = performance.now() - t0;
    // Constructed records carry a full valid character, so EVERY record
    // produces a point — the benchmark is exact (n in, n out).
    expect(points).toHaveLength(n);
    return { ms, count: n };
  }

  it("projects 100..10_000 records per run, measured", () => {
    const rows = [100, 500, 1_000, 5_000, 10_000].map(bench);
    for (const r of rows) {
      // Log measured projection time; exact point count depends on record data.
      console.log(`SOUNDSPACE-BENCH projection ${r.count} -> ${r.ms.toFixed(2)}ms`);
    }
    // Generous ceiling; the goal is to MEASURE the benchmark, not gate on count.
    expect(rows[rows.length - 1].ms).toBeLessThan(5_000);
  });
});

describe("STEP37 canonical coordinate + four-corner label model (§2/§37)", () => {
  function rec(name: string, soundCharacter: SoundCharacter): SampleIndexRecord {
    return makeSample(name, {
      analysisV2: {
        analysisVersion: ANALYSIS_VERSION,
        features: analyzeCorpus("pureTone440", 44100),
        soundCharacter,
        quality: computeSoundCharacterQuality(soundCharacter),
      },
    });
  }

  it("computeCanonicalSoundSpacePoint == projectSample(createSoundSpaceProjector(), record)", () => {
    const CHAR = charWith({ tonality: 0.6, noisiness: 0.2, brightness: 0.4 });
    const record = rec("samples/canon-a", CHAR);
    const canonical = computeCanonicalSoundSpacePoint(record)!;
    const direct = projectSample(createSoundSpaceProjector(), record)!;
    expect(canonical.x).toBeCloseTo(direct.x, 12);
    expect(canonical.y).toBeCloseTo(direct.y, 12);
    expect(canonical.algorithmVersion).toBe(SOUND_SPACE_ALGORITHM_VERSION);
  });

  it("canonical boundary is deterministic and corpus-independent (same record, twice)", () => {
    const CHAR = charWith({ tonality: 0.9, noisiness: 0.1, brightness: 0.7 });
    const a = computeCanonicalSoundSpacePoint(rec("samples/canon-b", CHAR))!;
    const b = computeCanonicalSoundSpacePoint(rec("samples/canon-b", CHAR))!;
    expect(a).toEqual(b);
  });

  it("four corners are X-pole first, Y-pole second, from the axis constants", () => {
    expect(soundSpaceCornerLabels()).toEqual({
      topLeft: `${SOUND_SPACE_X_LOW} · ${SOUND_SPACE_Y_HIGH}`,
      topRight: `${SOUND_SPACE_X_HIGH} · ${SOUND_SPACE_Y_HIGH}`,
      bottomLeft: `${SOUND_SPACE_X_LOW} · ${SOUND_SPACE_Y_LOW}`,
      bottomRight: `${SOUND_SPACE_X_HIGH} · ${SOUND_SPACE_Y_LOW}`,
    });
  });

  it("the four corner labels are all four, distinct and spelled from constants", () => {
    const labels = soundSpaceCornerLabels();
    const all = [labels.topLeft, labels.topRight, labels.bottomLeft, labels.bottomRight];
    expect(new Set(all).size).toBe(4);
    for (const label of all) {
      expect(label).toMatch(/^(Noisy|Tonal) · (Dark|Bright)$/);
    }
  });
});