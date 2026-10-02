/**
 * STEP48 — Audit-first hardening (targeted tests).
 *
 * Closes exactly two STEP47 findings:
 *   Objective A — persisted-validator family↔type coherence
 *     (`isWellFormedHierClassification` rejects incoherent family/type pairs,
 *     and the read-path `isWellFormedIndexRecord` gate treats such persisted
 *     rows as absent → re-analysis, never repair/delete).
 *   Objective B — cross-family metadata adoption must not leak acoustic-family
 *     secondaries onto the surface (drums acoustic + "bass" name/tag must not
 *     leave snare/clap/tom on the musical surface).
 *
 * Each group maps to report sections:
 *   §6  validator valid/invalid lists + edge cases  (authoritative `FAMILY_TYPES`
 *       + `familyOfType` reused — the ontology is never duplicated here)
 *   §10 cross-family adoption regression (TAG-SUPPORTED)
 *   §11 same-family adoption regression (unchanged behavior)
 *   §12 persistence gate: invalid row → absent → eligible for re-analysis
 */
import { describe, it, expect } from "vitest";
import type { AudioFeatures, SampleIndexRecord } from "./persistence/indexStore";
import { isWellFormedIndexRecord } from "./persistence/indexStore";
import { openTestDatabase, makeSample } from "./persistence/test-helpers";
import type { AudioFeaturesV2 } from "./analysis/audioFeaturesV2";
import { classifyHier } from "./classify/hier/classify";
import {
  FAMILY_TYPES,
  HIER_CLASSIFICATION_VERSION,
  UNKNOWN_TYPE,
  isWellFormedHierClassification,
  type HierClassification,
  type SoundFamily,
} from "./classify/hier/types";
import { familyOfType } from "./classify/hier/evidence";
import { kickFeatures, makeFeatures } from "./classify/test-helpers";

// ---------------------------------------------------------------------------
// Fixtures (pipeline-produced, coherent records only — no hand-crafted hier)
// ---------------------------------------------------------------------------

function v2(overrides: Partial<AudioFeaturesV2> = {}): AudioFeaturesV2 {
  return {
    durationSec: 1.0,
    sampleRate: 44100,
    channels: 1,
    rms: 0.3,
    peak: 0.9,
    crestFactor: 3,
    transientStrength: null,
    zeroCrossingRate: 0.02,
    spectralCentroidHz: 1500,
    spectralSpreadHz: 2500,
    spectralRolloffHz: 7000,
    spectralFlatness: 0.5,
    spectralFlux: 0.4,
    spectralSlope: 0,
    attackTimeSec: 0.02,
    decayTimeSec: 0.05,
    pitchHz: null,
    pitchConfidence: null,
    harmonicity: null,
    inharmonicity: null,
    ...overrides,
  };
}

const kickV2 = v2({
  durationSec: 0.3,
  transientStrength: 6,
  zeroCrossingRate: 0.01,
  spectralCentroidHz: 140,
  spectralSpreadHz: 220,
  spectralFlatness: 0.12,
  spectralFlux: 1.2,
  attackTimeSec: 0.001,
  decayTimeSec: 0.1,
});

/** Ultra-short ambiguous drum hit (the STEP47 TAG-SUPPORTED adoption fixture). */
const ultraShortDrum = (): AudioFeatures =>
  makeFeatures({
    duration: 0.3,
    transientDensity: 12,
    spectralCentroid: 1800,
    spectralBandwidth: 2500,
    spectralRolloff: 6500,
    zeroCrossingRate: 0.1,
    spectralFlatness: 0.5,
    attack: 0.004,
    rms: 0.25,
    peak: 0.9,
  });

const ultraShortDrumV2 = v2({
  durationSec: 0.3,
  transientStrength: 4,
  spectralCentroidHz: 1800,
  spectralSpreadHz: 2500,
  spectralFlatness: 0.5,
  spectralFlux: 1.0,
  zeroCrossingRate: 0.1,
  attackTimeSec: 0.004,
  decayTimeSec: 0.05,
});

function run(
  name: string,
  features: AudioFeatures,
  duration: number,
  v2z?: AudioFeaturesV2,
  tags: readonly string[] = [],
): ReturnType<typeof classifyHier> {
  return classifyHier({
    features,
    meta: { kind: "one-shot", durationSeconds: duration, name, tags },
    v2: v2z,
  });
}

/** A real pipeline-produced record, re-scoped to an arbitrary family/type. */
const base = run("kick 808", kickFeatures(), 0.3, kickV2).hier;
function hierOf(family: SoundFamily, type: string): HierClassification {
  return { ...base, family, type };
}

// ---------------------------------------------------------------------------
// §6 — validator hardening: family↔type coherence (authoritative, no duplicate
// ontology)
// ---------------------------------------------------------------------------

describe("STEP48 §6 — isWellFormedHierClassification coherence (family↔type)", () => {
  it("accepts every real family/type pair from the authoritative FAMILY_TYPES table", () => {
    for (const family of Object.keys(FAMILY_TYPES) as Exclude<SoundFamily, "unknown">[]) {
      for (const type of FAMILY_TYPES[family]) {
        expect(
          isWellFormedHierClassification(hierOf(family, type)),
          `${family}/${type} must stay valid`,
        ).toBe(true);
        expect(familyOfType(type)).toBe(family);
      }
    }
  });

  it("accepts unknown family + other (the documented fallback)", () => {
    expect(isWellFormedHierClassification(hierOf("unknown", UNKNOWN_TYPE))).toBe(true);
  });

  it("accepts a concrete family + other (documented §24 exception — do not reinterpret)", () => {
    expect(isWellFormedHierClassification(hierOf("drums", UNKNOWN_TYPE))).toBe(true);
    expect(isWellFormedHierClassification(hierOf("musical", UNKNOWN_TYPE))).toBe(true);
  });

  it("rejects every incoherent family/type pair a persisted record could hold", () => {
    const invalid: Array<[SoundFamily, string]> = [
      ["drums", "bass"],
      ["musical", "kick"],
      ["vocal", "snare"],
      ["fx", "piano"],
      ["atmosphere-noise", "synth"],
      ["musical", "noise"],
      ["unknown", "kick"],
      ["unknown", "bass"],
    ];
    for (const [family, type] of invalid) {
      expect(isWellFormedHierClassification(hierOf(family, type)), `${family}/${type}`).toBe(false);
    }
  });

  it("rejects off-ontology type strings on any family (never a fallback bucket)", () => {
    expect(isWellFormedHierClassification(hierOf("drums", "kittens"))).toBe(false);
    expect(isWellFormedHierClassification(hierOf("unknown", "kittens"))).toBe(false);
    expect(isWellFormedHierClassification(hierOf("musical", ""))).toBe(false);
  });

  it("is a pure validator: it never normalizes, repairs or mutates its input", () => {
    const h = hierOf("musical", "kick");
    const snapshot = JSON.parse(JSON.stringify(h));
    expect(isWellFormedHierClassification(h)).toBe(false);
    expect(h).toEqual(snapshot);
    expect(isWellFormedHierClassification(h)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §10 — cross-family metadata adoption: no stale drum secondaries on a musical
// surface (Objective B)
// ---------------------------------------------------------------------------

describe("STEP48 §10 — cross-family adoption drops acoustic-family secondaries", () => {
  const DRUM_CLASSES = FAMILY_TYPES.drums;

  it("TAG-SUPPORTED via tag: acoustic drums + 'bassline' tag → musical/bass surface with no drum secondaries", () => {
    const r = run("808 kit", ultraShortDrum(), 0.3, ultraShortDrumV2, ["bassline"]);
    expect(r.hier.reconciliation.status).toBe("TAG-SUPPORTED");
    expect(r.hier.type).toBe("bass");
    expect(r.hier.family).toBe("musical");
    expect(familyOfType(r.hier.type)).toBe(r.hier.family);
    expect(r.surface.primaryClass).toBe("bass");
    // The acoustic picture remains observable only in evidence (§26), never on
    // the surface: drum secondaries must not leak into the musical surface.
    expect(r.surface.secondaryClasses).toEqual([]);
    expect(r.surface.secondaryClasses.map((s) => s.class)).not.toEqual(
      expect.arrayContaining([...DRUM_CLASSES]),
    );
  });

  it("TAG-SUPPORTED via name: acoustic drums + 'bassline 808' name → musical/bass, no drum secondaries", () => {
    const r = run("bassline 808", ultraShortDrum(), 0.3, ultraShortDrumV2);
    expect(r.hier.reconciliation.status).toBe("TAG-SUPPORTED");
    expect(r.hier.type).toBe("bass");
    expect(r.hier.family).toBe("musical");
    expect(r.surface.primaryClass).toBe("bass");
    expect(r.surface.secondaryClasses).toEqual([]);
  });

  it("every surface class still belongs to a single sound family (no cross-family bleed)", () => {
    for (const r of [
      run("808 kit", ultraShortDrum(), 0.3, ultraShortDrumV2, ["bassline"]),
      run("bassline 808", ultraShortDrum(), 0.3, ultraShortDrumV2),
    ]) {
      for (const s of r.surface.secondaryClasses) {
        expect(familyOfType(s.class)).toBe(r.hier.family);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §11 — same-family adoption preserves secondaries (unchanged behavior)
// ---------------------------------------------------------------------------

describe("STEP48 §11 — same-family adoption keeps drum secondaries", () => {
  it("acoustic drums + 'snare break' → drum surface with drum secondaries intact", () => {
    const r = run("snare break", ultraShortDrum(), 0.3, ultraShortDrumV2);
    expect(r.hier.reconciliation.status).toBe("TAG-SUPPORTED");
    expect(r.hier.type).toBe("snare");
    expect(r.hier.family).toBe("drums");
    expect(r.surface.primaryClass).toBe("snare");
    expect(r.surface.secondaryClasses.length).toBeGreaterThan(0);
    // PHASE1 (§3): the acoustic runner order changed — clap is now the #1
    // acoustic candidate for this fixture (score 1.00 vs snare 0.925), and
    // `runners` excludes the top candidate, so `clap` is no longer a runner
    // while the tag-adopted `snare` becomes the surface primary. The guarantee
    // this test protects is unchanged: the drum secondaries survive metadata
    // adoption and stay inside the drums family.
    expect(r.surface.secondaryClasses.map((s) => s.class)).toEqual(
      expect.arrayContaining(["percussion"]),
    );
    for (const s of r.surface.secondaryClasses) {
      expect(familyOfType(s.class)).toBe("drums");
    }
  });
});

// ---------------------------------------------------------------------------
// §12 — persistence gate: an incoherent persisted `hier` is treated as absent
// (re-analysis), never repaired, never deleted (Objective A continuity)
// ---------------------------------------------------------------------------

describe("STEP48 §12 — read-path persistence gate (incoherent hier → absent)", () => {
  const coherent = run("snare break", ultraShortDrum(), 0.3, ultraShortDrumV2).hier;
  const incoherent: HierClassification = { ...coherent, family: "musical" };

  it("isWellFormedIndexRecord accepts a record with a coherent hier", () => {
    const rec = makeSample("samples/coherent", {
      secondaryClasses: [],
      classificationVersion: HIER_CLASSIFICATION_VERSION,
      hier: coherent,
    });
    expect(isWellFormedIndexRecord(rec)).toBe(true);
  });

  it("isWellFormedIndexRecord rejects a record whose hier is incoherent", () => {
    const rec = makeSample("samples/incoherent", {
      secondaryClasses: [],
      classificationVersion: HIER_CLASSIFICATION_VERSION,
      hier: incoherent,
    });
    expect(isWellFormedIndexRecord(rec)).toBe(false);
  });

  it("rejects non-object hier blocks (null / garbage)", () => {
    const rec = (hier: unknown): SampleIndexRecord =>
      makeSample("samples/x", {
        secondaryClasses: [],
        classificationVersion: HIER_CLASSIFICATION_VERSION,
        hier: hier as HierClassification,
      });
    expect(isWellFormedIndexRecord(rec(null))).toBe(false);
    expect(isWellFormedIndexRecord(rec("garbage"))).toBe(false);
  });

  it("IndexStore: an incoherent-hier row is undefined to get, excluded from getAll, and NOT deleted", async () => {
    const { index, db } = await openTestDatabase();
    try {
      await index.put(
        makeSample("samples/incoherent", {
          secondaryClasses: [],
          classificationVersion: HIER_CLASSIFICATION_VERSION,
          hier: incoherent,
        }),
      );
      // Invalid row -> treated as absent (undefined), so callers take the
      // analyze/NotFound path and re-analyze it (§12 self-healing contract).
      expect(await index.get("samples/incoherent")).toBeUndefined();
      expect(await index.getAll()).toEqual([]);
      // No delete, no repair: the row is preserved (count stays 1) for a
      // future inspection/repair path.
      expect(await index.count()).toBe(1);
    } finally {
      await db.close();
    }
  });
});