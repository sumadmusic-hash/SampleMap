import { describe, it, expect } from "vitest";
import { HeuristicClassifier } from "./heuristicClassifier";
import { ClassifierRegistry } from "./registry";
import { DRUM_CLASSES, MUSICAL_CLASSES, OTHER_CLASSES, ALL_CLASSES } from "./taxonomy";
import {
  kickFeatures,
  hatFeatures,
  bassFeatures,
  noiseFeatures,
  makeFeatures,
} from "./test-helpers";
import type { AudioFeatures } from "../persistence/indexStore";

describe("HeuristicClassifier", () => {
  const c = new HeuristicClassifier();

  it("classifies a kick profile as kick with highest confidence", async () => {
    const out = await c.classify(kickFeatures());
    expect(out.primaryClass).toBe("kick");
    expect(out.confidence).toBeGreaterThan(0.5);
    expect(out.confidence).toBeLessThanOrEqual(1);
  });

  it("classifies a hi-hat profile as a hat/cymbal-family drum", async () => {
    const out = await c.classify(hatFeatures());
    expect(out.primaryClass).toBe("hihat");
    expect(out.confidence).toBeGreaterThan(0.5);
  });

  it("classifies a sustained dark tonal profile as bass", async () => {
    const out = await c.classify(bassFeatures());
    expect(out.primaryClass).toBe("bass");
    expect(out.confidence).toBeGreaterThan(0.5);
  });

  it("classifies broadband noise as noise or atmosphere", async () => {
    const out = await c.classify(noiseFeatures());
    expect(["noise", "fx", "atmosphere"]).toContain(out.primaryClass);
  });

  it("returns secondary classes sorted descending and never duplicates primary", async () => {
    const out = await c.classify(kickFeatures());
    expect(out.secondaryClasses.length).toBeGreaterThan(0);
    expect(out.secondaryClasses[0].confidence).toBeGreaterThanOrEqual(
      out.secondaryClasses[out.secondaryClasses.length - 1].confidence,
    );
    expect(out.secondaryClasses.every((s) => s.class !== out.primaryClass)).toBe(
      true,
    );
  });

  it("output is a probability distribution over the top-5 alternatives", async () => {
    const out = await c.classify(makeFeatures());
    // The classifier retains primary + ranked secondary alternatives (top 5).
    const ids = [out.primaryClass, ...out.secondaryClasses.map((s) => s.class)];
    expect(ids.length).toBe(5);
    expect(new Set(ids).size).toBe(ids.length);
    const total = out.confidence + out.secondaryClasses.reduce((a, s) => a + s.confidence, 0);
    expect(total).toBeCloseTo(1, 3);
  });

  it("is deterministic: identical inputs give byte-identical outputs", async () => {
    const a = await c.classify(kickFeatures());
    const b = await c.classify(kickFeatures());
    expect(b).toEqual(a);
  });

  it("never throws and never emits NaN/Infinity for NaN feature inputs", async () => {
    const bad: Record<string, number> = { ...makeFeatures() };
    for (const k of Object.keys(bad)) bad[k] = NaN;
    const out = await c.classify(bad as unknown as AudioFeatures);
    expect(ALL_CLASSES).toContain(out.primaryClass);
    expect(Number.isFinite(out.confidence)).toBe(true);
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
    expect(out.secondaryClasses.every((s) => Number.isFinite(s.confidence))).toBe(true);
  });

  it("never throws and never emits NaN/Infinity for infinite feature inputs", async () => {
    const bad: Record<string, number> = { ...makeFeatures() };
    for (const k of Object.keys(bad)) bad[k] = Infinity;
    const out = await c.classify(bad as unknown as AudioFeatures);
    expect(Number.isFinite(out.confidence)).toBe(true);
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
  });

  it("degrades to a valid, low-confidence distribution for degenerate neutral features", async () => {
    const neutral: Record<string, number> = { ...makeFeatures() };
    for (const k of Object.keys(neutral)) neutral[k] = 0;
    const out = await c.classify(neutral as unknown as AudioFeatures);
    expect(Number.isFinite(out.confidence)).toBe(true);
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
    const total = out.confidence + out.secondaryClasses.reduce((a, s) => a + s.confidence, 0);
    expect(total).toBeCloseTo(1, 3);
  });
});

describe("ClassifierRegistry", () => {
  it("registers and retrieves by id; rejects duplicates", () => {
    const reg = new ClassifierRegistry();
    const a = new HeuristicClassifier();
    expect(reg.register(a)).toBe(reg);
    expect(reg.get("heuristic")).toBe(a);
    expect(reg.has("heuristic")).toBe(true);
    expect(reg.list()).toEqual(["heuristic"]);
    expect(() => reg.register(new HeuristicClassifier())).toThrow(/already registered/);
  });
});

describe("Taxonomy", () => {
  it("covers drums, musical and other disjointly", () => {
    const all = [...DRUM_CLASSES, ...MUSICAL_CLASSES, ...OTHER_CLASSES];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(ALL_CLASSES.length);
  });
});
