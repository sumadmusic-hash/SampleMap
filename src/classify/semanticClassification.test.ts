import { describe, it, expect } from "vitest";
import { normalizeTag, normalizeTags } from "./normalizeTag";
import {
  SUBTYPE_IDS,
  SUBTYPE_LABELS,
  tagToSubtype,
  tagMatchesSubtype,
  SUBTYPE_FAMILY,
  HAT_SUBTYPES,
  CYMBAL_SUBTYPES,
  PERCUSSION_SUBTYPES,
} from "./drumOntology";
import {
  reconcileSemanticClassification,
  collectTagEvidence,
  SEMANTIC_CLASSIFICATION_VERSION,
  REFINEMENT_CONFIDENCE_EPSILON,
  CONFLICT_CONFIDENCE_DISCOUNT,
} from "./semanticClassification";
import type { ClassOutput } from "./classifier";

const out = (
  primaryClass: string,
  confidence = 0.7,
): ClassOutput => ({
  primaryClass,
  confidence,
  secondaryClasses: [],
});

describe("normalizeTag (STEP38)", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeTag("  Hi-Hat!  ")).toBe("hi hat");
    expect(normalizeTag("Open Hat")).toBe("open hat");
    expect(normalizeTag("  kick__12 ")).toBe("kick 12");
  });

  it("handles empty/blank gracefully and preserves list order", () => {
    expect(normalizeTag("")).toBe("");
    expect(normalizeTag("   ")).toBe("");
    expect(normalizeTags(["Kick", "open hat ", " hi-hat"])).toEqual([
      "kick",
      "open hat",
      "hi hat",
    ]);
  });
});

describe("drum ontology (STEP38 §17/§18)", () => {
  it("has the exact 16-subtype taxonomy with labels", () => {
    expect(SUBTYPE_IDS).toEqual([
      "kick", "snare", "clap", "closedhat", "openhat", "ride", "crash",
      "tom", "shaker", "tambourine", "rim", "cowbell", "bongo", "conga",
      "clave", "percussion-other",
    ]);
    expect(SUBTYPE_LABELS.closedhat).toBe("Closed Hat");
    expect(SUBTYPE_LABELS["percussion-other"]).toBe("Other Percussion");
  });

  it("hierarchies are present: hats, cymbals, percussion buckets", () => {
    expect(HAT_SUBTYPES).toEqual(["closedhat", "openhat"]);
    expect(CYMBAL_SUBTYPES).toEqual(["ride", "crash"]);
    expect(PERCUSSION_SUBTYPES).toContain("shaker");
    expect(PERCUSSION_SUBTYPES).toContain("clave");
    expect(SUBTYPE_FAMILY.closedhat).toBe("hihat");
    expect(SUBTYPE_FAMILY.openhat).toBe("hihat");
    expect(SUBTYPE_FAMILY.ride).toBe("cymbal");
    expect(SUBTYPE_FAMILY.crash).toBe("cymbal");
    expect(SUBTYPE_FAMILY.shaker).toBe("percussion");
  });

  it("resolves tag evidence deterministically", () => {
    expect(tagToSubtype("Closed Hat")).toBe("closedhat");
    expect(tagToSubtype("closed hat")).toBe("closedhat");
    expect(tagToSubtype("Open-Hat")).toBe("openhat");
    expect(tagToSubtype("ride")).toBe("ride");
    expect(tagToSubtype("crash cymbal")).toBe("crash");
    expect(tagToSubtype("Tambourine")).toBe("tambourine");
    expect(tagToSubtype("cow bell")).toBe("cowbell");
    expect(tagToSubtype("Wood Block")).toBe("clave");
    expect(tagToSubtype("")).toBeUndefined();
  });

  it("does not fabricate a subtype from unrelated tags", () => {
    expect(tagToSubtype("bass")).toBeUndefined();
    expect(tagToSubtype("synth")).toBeUndefined();
    expect(tagToSubtype("piano")).toBeUndefined();
    expect(tagMatchesSubtype("hi hat", "closedhat")).toBe(false);
    expect(tagMatchesSubtype("hi hat", "openhat")).toBe(false);
  });
});

describe("reconcileSemanticClassification (STEP38 §15/§18)", () => {
  it("hihat audio + closed-hat tag → closedhat, audio+tags, refinement boost", () => {
    const r = reconcileSemanticClassification(out("hihat"), ["Closed Hat"]);
    expect(r.subtype).toBe("closedhat");
    expect(r.source).toBe("audio+tags");
    expect(r.conflict).toBe(false);
    expect(r.confidence).toBeCloseTo(0.7 + REFINEMENT_CONFIDENCE_EPSILON, 5);
    expect(r.family).toBe("hihat");
    expect(r.tagEvidence).toEqual(["Closed Hat"]);
    expect(r.version).toBe(SEMANTIC_CLASSIFICATION_VERSION);
  });

  it("hihat audio + open-hat tag → openhat", () => {
    const r = reconcileSemanticClassification(out("hihat"), ["open hat"]);
    expect(r.subtype).toBe("openhat");
    expect(r.source).toBe("audio+tags");
  });

  it("openhat audio stays openhat even without tags", () => {
    const r = reconcileSemanticClassification(out("openhat"), []);
    expect(r.subtype).toBe("openhat");
    expect(r.source).toBe("audio");
    expect(r.conflict).toBe(false);
  });

  it("cymbal audio + ride tag → ride; + crash tag → crash", () => {
    expect(reconcileSemanticClassification(out("cymbal"), ["ride"]).subtype).toBe("ride");
    expect(reconcileSemanticClassification(out("cymbal"), ["crash"]).subtype).toBe("crash");
  });

  it("cymbal audio WITHOUT tag evidence does not fabricate ride/crash (stays family)", () => {
    const r = reconcileSemanticClassification(out("cymbal"), []);
    expect(r.subtype).toBe("cymbal");
    expect(r.source).toBe("audio");
  });

  it("percussion audio + shaker tag → shaker; conga tag → conga", () => {
    expect(reconcileSemanticClassification(out("percussion"), ["shaker"]).subtype).toBe("shaker");
    expect(reconcileSemanticClassification(out("percussion"), ["Conga"]).subtype).toBe("conga");
  });

  it("kick/snare/clap/tom audio keep their own subtype (already fine-grained)", () => {
    expect(reconcileSemanticClassification(out("kick"), []).subtype).toBe("kick");
    expect(reconcileSemanticClassification(out("snare"), []).subtype).toBe("snare");
    expect(reconcileSemanticClassification(out("clap"), []).subtype).toBe("clap");
    expect(reconcileSemanticClassification(out("tom"), []).subtype).toBe("tom");
  });

  it("CONFLICT: tags pointing at a different family do not override the audio family", () => {
    const r = reconcileSemanticClassification(out("clap", 0.8), ["shaker", "percussion"]);
    expect(r.conflict).toBe(true);
    expect(r.subtype).toBe("clap");
    expect(r.source).toBe("audio");
    expect(r.confidence).toBeCloseTo(0.8 * CONFLICT_CONFIDENCE_DISCOUNT, 5);
  });

  it("CONFLICT: percussion audio + closed-hat tag keeps percussion and flags conflict", () => {
    const r = reconcileSemanticClassification(out("percussion"), ["closed hat"]);
    expect(r.conflict).toBe(true);
    expect(r.subtype).toBe("percussion");
  });

  it("non-drum musical classes pass through untouched (audio source, no conflict)", () => {
    const r = reconcileSemanticClassification(out("bass"), ["kick"]);
    expect(r.subtype).toBe("bass");
    expect(r.family).toBe("bass");
    expect(r.conflict).toBe(true); // kick is drum-family evidence — audio stays bass
    expect(r.source).toBe("audio");
  });

  it("tags are preserved verbatim in evidence (never overwritten)", () => {
    const r = reconcileSemanticClassification(out("hihat", 0.9), ["  Closed Hat  ", "sharp"]);
    expect(r.tagEvidence).toEqual(["Closed Hat"]);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("confidence never exceeds 1 after refinements", () => {
    const r = reconcileSemanticClassification(out("hihat", 0.999), ["open hat"]);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("first tag wins on conflicting/duplicate evidence (deterministic)", () => {
    const r = reconcileSemanticClassification(out("hihat"), ["ride", "closed hat"]);
    expect(r.conflict).toBe(true);
    expect(r.subtype).toBe("hihat");
    expect(r.confidence).toBeCloseTo(0.7 * CONFLICT_CONFIDENCE_DISCOUNT, 5);
  });

  it("collectTagEvidence dedups subtypes and returns original tags", () => {
    const { subtypes, evidenceTags } = collectTagEvidence(["kick", "kick", "ride"]);
    expect(subtypes).toEqual(["kick", "ride"]);
    expect(evidenceTags).toEqual(["kick", "ride"]);
  });

  it("is deterministic across repeated calls", () => {
    const a = reconcileSemanticClassification(out("cymbal"), ["ride", "tambourine"]);
    const b = reconcileSemanticClassification(out("cymbal"), ["ride", "tambourine"]);
    expect(a).toEqual(b);
  });
});

describe("semantic colors (STEP38 §20/§24)", () => {
  it("Ride ≠ Closed Hat; Tom ≠ Bongo; Closed Hat ≠ Open Hat; Ride ≠ Crash", async () => {
    const { semanticDotColor } = await import("../ui/map/semanticColors");
    expect(semanticDotColor("cymbal", "ride")).not.toBe(semanticDotColor("hihat", "closedhat"));
    expect(semanticDotColor("tom", "tom")).not.toBe(semanticDotColor("percussion", "bongo"));
    expect(semanticDotColor("hihat", "closedhat")).not.toBe(semanticDotColor("openhat", "openhat"));
    expect(semanticDotColor("cymbal", "ride")).not.toBe(semanticDotColor("cymbal", "crash"));
  });

  it("falls back to the family color when the subtype is absent/unknown", async () => {
    const { semanticDotColor, SEMANTIC_SUBTYPE_COLORS } = await import("../ui/map/semanticColors");
    expect(semanticDotColor("kick", undefined)).toBe("#e53935");
    expect(SEMANTIC_SUBTYPE_COLORS["closedhat"]).toBe("#43a047");
    expect(semanticDotColor("hihat", "closedhat")).toBe("#43a047");
  });
});