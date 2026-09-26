/**
 * STEP25 — Sound Space filter unit tests (§34).
 */
import { describe, it, expect } from "vitest";
import {
  normalizeRange,
  isRangeActive,
  isFilterActive,
  recordMatchesFilter,
  matchesSoundCharacter,
  filterSoundSpacePoints,
  emptySoundSpaceFilter,
} from "./soundSpaceFilter";
import type { SampleIndexRecord } from "../persistence/indexStore";
import { ANALYSIS_VERSION } from "./sampleAnalysisV2";
import { makeSample } from "../persistence/test-helpers";
import type { SoundCharacter } from "./soundCharacter";
import type { SoundSpacePoint } from "./soundSpaceProjector";
import { SOUND_CHARACTER_DIMENSIONS } from "./config";

const nullChar = (): SoundCharacter =>
  Object.fromEntries(SOUND_CHARACTER_DIMENSIONS.map((d) => [d, null])) as unknown as SoundCharacter;

function charWith(values: Partial<Record<keyof SoundCharacter, number | null>>): SoundCharacter {
  return { ...nullChar(), ...values };
}

function recordWith(values: Partial<Record<keyof SoundCharacter, number | null>>): SampleIndexRecord {
  const sc = charWith(values);
  return makeSample("samples/x", {
    analysisV2: {
      analysisVersion: ANALYSIS_VERSION,
      features: {} as never,
      soundCharacter: sc,
      quality: { overall: 0.5, featureCoverage: 1 },
    },
  });
}

function recs(n: number): SampleIndexRecord[] {
  return Array.from({ length: n }, (_, i) =>
    recordWith({
      brightness: (i * 37) % 11 / 10,
    }),
  );
}

describe("STEP25 :: soundSpaceFilter basics", () => {
  it("1. no filter → records pass through", () => {
    const r = recordWith({ brightness: 0.5 });
    expect(recordMatchesFilter(r, emptySoundSpaceFilter())).toBe(true);
  });

  it("2. brightness min/max respected (inclusive) — and a null dim fails the filter", () => {
    const bright = recordWith({ brightness: 0.9 });
    const dark = recordWith({ brightness: 0.1 });
    const noBrightness = recordWith({ brightness: null });
    const f = { brightness: { min: 0.5, max: 1 } };
    expect(recordMatchesFilter(bright, f)).toBe(true);
    expect(recordMatchesFilter(dark, f)).toBe(false);
    expect(recordMatchesFilter(noBrightness, f)).toBe(false);
    expect(recordMatchesFilter(bright, { brightness: { min: 0.9, max: 0.9 } })).toBe(true);
  });

  it("3. tonality filter (X-axis dimension) composes correctly", () => {
    const tonal = recordWith({ tonality: 0.9, noisiness: 0.1 });
    const noisy = recordWith({ tonality: 0.1, noisiness: 0.9 });
    expect(recordMatchesFilter(tonal, { tonality: { min: 0.5, max: 1 } })).toBe(true);
    expect(recordMatchesFilter(noisy, { noisiness: { min: 0.5, max: 1 } })).toBe(true);
  });

  it("4. noisiness filter (the 'Noisy ↔ Tonal' axis)", () => {
    const noisy = recordWith({ noisiness: 0.8, tonality: 0.1 });
    expect(recordMatchesFilter(noisy, { noisiness: { min: 0.5, max: 1 } })).toBe(true);
    expect(recordMatchesFilter(noisy, { tonality: { min: 0.5, max: 1 } })).toBe(false);
  });

  it("5. partial character: dims not covered by the filter are irrelevant", () => {
    // tonality set; brightness null — with only a tonality filter active the
    // null brightness must not fail the record.
    const partial = recordWith({ tonality: 0.8, brightness: null });
    expect(recordMatchesFilter(partial, { tonality: { min: 0.5, max: 1 } })).toBe(true);
  });

  it("6. null dimension → fails its own filter, never 0→no-op", () => {
    const noT = recordWith({ tonality: null, brightness: 0.9 });
    expect(recordMatchesFilter(noT, { tonality: { min: 0.4, max: 1 } })).toBe(false);
  });

  it("7. empty result — nothing matches, returns []  (no crash)", () => {
    const r = recordWith({ brightness: 0.7 });
    const none = {
      brightness: { min: 0.9, max: 1 },
      tonality: { min: 0.8, max: 1 },
    };
    expect(recordMatchesFilter(r, none)).toBe(false);
  });

  it("8. combined filters use AND semantics (§7)", () => {
    const mixed = recordWith({ brightness: 0.9, tonality: 0.6 });
    // Passes brightness alone; fails tonality alone.
    expect(
      recordMatchesFilter(mixed, {
        brightness: { min: 0.8, max: 1 },
        tonality: { min: 0.1, max: 0.4 },
      }),
    ).toBe(false);
    expect(
      recordMatchesFilter(mixed, {
        brightness: { min: 0.8, max: 1 },
        tonality: { min: 0.5, max: 1 },
      }),
    ).toBe(true);
  });

  it("9. no mutation of the input records or filter", () => {
    const rec = recordWith({ brightness: 0.75 });
    const filter = { brightness: { min: 0.5, max: 1 } };
    const before = JSON.parse(JSON.stringify(rec));
    const beforeFilter = JSON.parse(JSON.stringify(filter));
    recordMatchesFilter(rec, filter);
    expect(rec).toEqual(before);
    expect(filter).toEqual(beforeFilter);
  });

  it("10. deterministic: same input → same answer on repeated calls", () => {
    const rec = recordWith({ brightness: 0.75 });
    const f = { brightness: { min: 0.3, max: 1 } };
    expect(recordMatchesFilter(rec, f)).toBe(recordMatchesFilter(rec, f));
    // Every synthetic record passes its own no-op filter semantics.
    const five = recs(5);
    const ident = { brightness: { min: 0, max: 1 } };
    expect(five.filter((r) => recordMatchesFilter(r, ident))).toHaveLength(5);
  });

  it("11. order preservation in filterSoundSpacePoints", () => {
    const pts: SoundSpacePoint[] = [
      { sampleId: "b", x: 0.2, y: 0.4, analysisVersion: "2.0.0", algorithmVersion: "1.0.0" },
      { sampleId: "a", x: 0.9, y: 0.7, analysisVersion: "2.0.0", algorithmVersion: "1.0.0" },
    ];
    const recA = recordWith({ brightness: 0.9 });
    recA.sampleId = "a";
    const recB = recordWith({ brightness: 0.9 });
    recB.sampleId = "b";
    const records = new Map<string, SampleIndexRecord>([["a", recA], ["b", recB]]);
    const f = { brightness: { min: 0.8, max: 1 } };
    const out = filterSoundSpacePoints(pts, records, f);
    expect(out.map((p) => p.sampleId)).toEqual(["b", "a"]);
  });

  it("12. matcher with records directly for the browser-level composition", () => {
    const r = recordWith({ tonality: 0.4, brightness: 0.9 });
    expect(
      recordMatchesFilter(r, {
        tonality: { min: 0.3, max: 1 },
        brightness: { min: 0.8, max: 1 },
      }),
    ).toBe(true);
  });
});

describe("STEP25 :: isRangeActive / isFilterActive / normalizeRange", () => {
  it("inactive ranges are detect and skipped", () => {
    expect(isRangeActive({ min: 0, max: 1 })).toBe(false);
    expect(isRangeActive({ min: 0.2, max: 1 })).toBe(true);
    expect(isRangeActive(undefined)).toBe(false);
    expect(isFilterActive({})).toBe(false);
    expect(isFilterActive({ brightness: { min: 0, max: 0.7 } })).toBe(true);
  });

  it("normalizeRange clamps and swaps inputs", () => {
    expect(normalizeRange(1.2, 0.4)).toEqual({ min: 0.4, max: 1 });
    expect(normalizeRange(0.3, 1.5)).toEqual({ min: 0.3, max: 1 });
    expect(normalizeRange(0.3, 0.8)).toEqual({ min: 0.3, max: 0.8 });
  });
});

describe("STEP25 :: matcher composability helpers", () => {
  it("matchesSoundCharacter works directly on the SoundCharacter object", () => {
    expect(matchesSoundCharacter(charWith({ brightness: 0.8 }), { brightness: { min: 0.5, max: 1 } })).toBe(true);
    expect(matchesSoundCharacter(charWith({ brightness: 0.8 }), { brightness: { min: 0.9, max: 1 } })).toBe(false);
  });

  it("recs is deterministic across runs", () => {
    const a = recs(3);
    const b = recs(3);
    expect(a).toEqual(b);
  });

  it("full fixture with default ranges passes everything", () => {
    const r = recordWith({ brightness: 0.9 });
    expect(
      recordMatchesFilter(r, {
        brightness: { min: 0, max: 1 },
        tonality: { min: 0, max: 1 },
      }),
    ).toBe(true);
  });
});
