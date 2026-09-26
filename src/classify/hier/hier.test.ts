/**
 * STEP44 — required tests (§37) and hierarchy invariants.
 *
 * Groups:
 *   1-6   structure (kind/duration authoritative; SC1/SC2)
 *   7-14  drums (family-conditional; kick requires darkness)
 *   15-18 ultra-short (duration NEVER auto-kicks; percussion fallback)
 *   19-25 musical
 *   26-28 vocal (NOT atmosphere/noise)
 *   29-33 fx / noise-bed / atmosphere-bed
 *   34-42 metadata reconciliation (AGREE / TAG-SUPPORTED / CONFLICT / AUDIO-
 *          SUPPORTED / UNKNOWN; generic tags never fix a precise type)
 *   43-45 null-safe V2 (missing pitch/harmonicity / no V2 at all)
 *
 * Plus invariants: determinism, well-formed persistable shape, taxonomy-only
 * surface vocabulary, no audio bytes, confidence bounds, legacy-vs-hier
 * additivity through the real pipeline.
 */
import { describe, it, expect } from "vitest";
import { assertNoAudioBytes } from "../../persistence/indexStore";
import type { AudioFeatures } from "../../persistence/indexStore";
import type { AudioFeaturesV2 } from "../../analysis/audioFeaturesV2";
import { ALL_CLASSES } from "../taxonomy";
import { makeFeatures } from "../test-helpers";
import { classifyHier } from "./classify";
import { isWellFormedHierClassification, UNKNOWN_TYPE } from "./types";
import { HierClassifier } from "../hierClassifier";

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

/** Kick 40–300ms profile: dark, fast, transient, tonal thump. */
function kickFeatures(dur = 0.3): AudioFeatures {
  return makeFeatures({
    duration: dur,
    transientDensity: 18,
    spectralCentroid: 140,
    spectralBandwidth: 220,
    spectralRolloff: 3000,
    zeroCrossingRate: 0.01,
    spectralFlatness: 0.12,
    attack: 0.001,
    rms: 0.35,
    peak: 0.95,
  });
}

const kickV2 = (dur = 0.3): AudioFeaturesV2 =>
  v2({
    durationSec: dur,
    crestFactor: 0.95 / 0.35,
    transientStrength: 6,
    zeroCrossingRate: 0.01,
    spectralCentroidHz: 140,
    spectralSpreadHz: 220,
    spectralFlatness: 0.12,
    spectralFlux: 1.2,
    attackTimeSec: 0.001,
    decayTimeSec: 0.1,
    spectralRolloffHz: 3000,
  });

/** Short mid-bright noisy hit (snare-ish) with sub-decisive acoustics. */
function ambiguousDrum(): AudioFeatures {
  return makeFeatures({
    duration: 0.4,
    transientDensity: 14,
    spectralCentroid: 2400,
    spectralBandwidth: 3000,
    spectralRolloff: 6500,
    zeroCrossingRate: 0.15,
    spectralFlatness: 0.6,
    attack: 0.003,
    rms: 0.2,
    peak: 0.9,
  });
}

const ambiguousDrumV2 = (): AudioFeaturesV2 =>
  v2({
    durationSec: 0.4,
    transientStrength: 5,
    zeroCrossingRate: 0.15,
    spectralCentroidHz: 2400,
    spectralSpreadHz: 3000,
    spectralFlatness: 0.6,
    spectralFlux: 1.0,
    attackTimeSec: 0.003,
    decayTimeSec: 0.09,
    spectralRolloffHz: 6500,
  });

/** Pitched mid material with NO decisive family (weak audio). */
function pitchedWeak(): AudioFeatures {
  return makeFeatures({
    duration: 1.2,
    transientDensity: 2,
    spectralCentroid: 1500,
    spectralBandwidth: 1200,
    spectralRolloff: 6000,
    zeroCrossingRate: 0.02,
    spectralFlatness: 0.35,
    attack: 0.05,
    rms: 0.2,
    peak: 0.5,
  });
}

type RunOpts = {
  name?: string;
  tags?: string[];
  kind?: string;
  durationSeconds?: number;
  v2?: AudioFeaturesV2 | null;
};

function run(features: AudioFeatures, o: RunOpts = {}) {
  return classifyHier({
    features,
    meta: {
      kind: o.kind ?? "one-shot",
      durationSeconds: o.durationSeconds ?? features.duration,
      name: o.name ?? "",
      tags: o.tags ?? [],
    },
    v2: o.v2 === undefined ? null : o.v2,
  });
}

describe("STEP44 structure (§7–§8; SC1/SC2)", () => {
  it("1. one-shot 0.1s → one-shot", () => {
    expect(run(makeFeatures({ duration: 0.1 }), { durationSeconds: 0.1 }).hier.structure).toBe("one-shot");
  });
  it("2. one-shot 1s → one-shot", () => {
    expect(run(makeFeatures({ duration: 1 }), { durationSeconds: 1 }).hier.structure).toBe("one-shot");
  });
  it("3. one-shot 5s → sustained-phrase (explicit rule, not loop)", () => {
    const r = run(makeFeatures({ duration: 5 }), { durationSeconds: 5 });
    expect(r.hier.structure).toBe("sustained-phrase");
    expect(r.hier.structure).not.toBe("loop");
  });
  it("4. loop 0.2s → loop (short loops stay loop; SC2)", () => {
    expect(run(makeFeatures({ duration: 0.2 }), { kind: "loop", durationSeconds: 0.2 }).hier.structure).toBe("loop");
  });
  it("5. loop 1s → loop", () => {
    expect(run(makeFeatures({ duration: 1 }), { kind: "loop", durationSeconds: 1 }).hier.structure).toBe("loop");
  });
  it("6. loop 5s → loop", () => {
    expect(run(makeFeatures({ duration: 5 }), { kind: "loop", durationSeconds: 5 }).hier.structure).toBe("loop");
  });
});

describe("STEP44 drums (§12–§14)", () => {
  it("7. kick: dark short thump → drums/kick, decisive", () => {
    const r = run(kickFeatures(), { v2: kickV2(), tags: ["kick"] });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("kick");
    expect(r.hier.ambiguous).toBe(false);
    expect(r.surface.primaryClass).toBe("kick");
  });
  it("8. snare: mid burst with body → snare", () => {
    const feats = makeFeatures({
      duration: 0.45,
      transientDensity: 16,
      spectralCentroid: 1900,
      spectralBandwidth: 1200,
      spectralRolloff: 5500,
      zeroCrossingRate: 0.035,
      spectralFlatness: 0.33,
      attack: 0.002,
      rms: 0.22,
      peak: 0.9,
    });
    const r = run(feats, {
      v2: v2({
        durationSec: 0.45,
        transientStrength: 5,
        zeroCrossingRate: 0.035,
        spectralCentroidHz: 1900,
        spectralSpreadHz: 1200,
        spectralFlatness: 0.33,
        attackTimeSec: 0.002,
        decayTimeSec: 0.12,
      }),
    });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("snare");
  });
  it("9. clap: broadband noisy burst → clap (acoustic + tag evidence)", () => {
    const feats = makeFeatures({
      duration: 0.42,
      transientDensity: 14,
      spectralCentroid: 5000,
      spectralBandwidth: 6000,
      spectralRolloff: 9000,
      zeroCrossingRate: 0.28,
      spectralFlatness: 0.75,
      attack: 0.004,
      rms: 0.15,
      peak: 0.9,
    });
    const r = run(feats, {
      name: "Handclap",
      tags: ["clap"],
      v2: v2({
        durationSec: 0.42,
        crestFactor: 6,
        transientStrength: 4,
        zeroCrossingRate: 0.28,
        spectralCentroidHz: 5000,
        spectralSpreadHz: 6000,
        spectralFlatness: 0.75,
        attackTimeSec: 0.004,
        decayTimeSec: 0.04,
        spectralRolloffHz: 9000,
      }),
    });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("clap");
    expect(["AGREE", "TAG-SUPPORTED"]).toContain(r.hier.reconciliation.status);
  });
  it("10. hihat: bright very-short noisy high-zcr → hihat (acoustic + tag evidence)", () => {
    const feats = makeFeatures({
      duration: 0.18,
      transientDensity: 19,
      spectralCentroid: 10000,
      spectralBandwidth: 2600,
      spectralRolloff: 14000,
      zeroCrossingRate: 0.38,
      spectralFlatness: 0.66,
      attack: 0.0004,
      rms: 0.1,
      peak: 0.9,
    });
    const r = run(feats, {
      name: "HH 909",
      tags: ["hihat"],
      v2: v2({
        durationSec: 0.18,
        crestFactor: 9,
        transientStrength: 9,
        zeroCrossingRate: 0.38,
        spectralCentroidHz: 10000,
        spectralSpreadHz: 2600,
        spectralFlatness: 0.66,
        attackTimeSec: 0.0004,
        decayTimeSec: 0.008,
        spectralRolloffHz: 14000,
      }),
    });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("hihat");
    expect(["AGREE", "TAG-SUPPORTED"]).toContain(r.hier.reconciliation.status);
  });
  it("11. openhat: bright noisy long-ish decay → openhat", () => {
    const feats = makeFeatures({
      duration: 0.6,
      transientDensity: 12,
      spectralCentroid: 9000,
      spectralBandwidth: 2600,
      spectralRolloff: 12000,
      zeroCrossingRate: 0.25,
      spectralFlatness: 0.7,
      attack: 0.004,
      rms: 0.2,
      peak: 0.9,
    });
    const r = run(feats, {
      v2: v2({
        durationSec: 0.6,
        transientStrength: 3,
        zeroCrossingRate: 0.25,
        spectralCentroidHz: 9000,
        spectralSpreadHz: 2600,
        spectralFlatness: 0.7,
        attackTimeSec: 0.004,
        decayTimeSec: 0.35,
        spectralRolloffHz: 12000,
      }),
    });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("openhat");
    expect(r.hier.ambiguous).toBe(false);
  });
  it("12. tom: dark-mid transient tonal mid-length → tom", () => {
    const feats = makeFeatures({
      duration: 0.7,
      transientDensity: 13,
      spectralCentroid: 650,
      spectralBandwidth: 500,
      spectralRolloff: 3000,
      zeroCrossingRate: 0.05,
      spectralFlatness: 0.18,
      attack: 0.01,
      rms: 0.3,
      peak: 0.9,
    });
    const r = run(feats, {
      v2: v2({
        durationSec: 0.7,
        transientStrength: 4,
        zeroCrossingRate: 0.05,
        spectralCentroidHz: 650,
        spectralSpreadHz: 500,
        spectralFlatness: 0.18,
        attackTimeSec: 0.01,
        decayTimeSec: 0.25,
      }),
    });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("tom");
    expect(r.hier.ambiguous).toBe(false);
  });
  it("13. cymbal: bright noisy decay-long wide → cymbal", () => {
    const feats = makeFeatures({
      duration: 1.4,
      transientDensity: 8,
      spectralCentroid: 11000,
      spectralBandwidth: 6500,
      spectralRolloff: 18000,
      zeroCrossingRate: 0.3,
      spectralFlatness: 0.72,
      attack: 0.008,
      rms: 0.15,
      peak: 0.9,
    });
    const r = run(feats, {
      name: "Crash Cymbal",
      tags: ["cymbal"],
      v2: v2({
        durationSec: 1.4,
        crestFactor: 6,
        transientStrength: 2,
        zeroCrossingRate: 0.3,
        spectralCentroidHz: 11000,
        spectralSpreadHz: 6500,
        spectralFlatness: 0.72,
        attackTimeSec: 0.008,
        decayTimeSec: 0.4,
        spectralRolloffHz: 18000,
      }),
    });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("cymbal");
  });
  it("14. percussion residue: short ambiguous hit → percussion, NOT kick", () => {
    const feats = makeFeatures({
      duration: 0.3,
      transientDensity: 14,
      spectralCentroid: 2600,
      spectralBandwidth: 900,
      spectralRolloff: 6000,
      zeroCrossingRate: 0.12,
      spectralFlatness: 0.5,
      attack: 0.001,
      rms: 0.25,
      peak: 0.9,
    });
    const r = run(feats, {
      v2: v2({
        durationSec: 0.3,
        transientStrength: 5,
        zeroCrossingRate: 0.12,
        spectralCentroidHz: 2600,
        spectralSpreadHz: 900,
        spectralFlatness: 0.5,
        attackTimeSec: 0.001,
        decayTimeSec: 0.06,
      }),
    });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("percussion");
    expect(r.hier.type).not.toBe("kick");
  });
});

describe("STEP44 ultra-short (§14): duration NEVER auto-kicks", () => {
  it("15. 40ms dark kick thump → kick (by darkness, NOT by duration)", () => {
    const r = run(kickFeatures(0.04), { v2: kickV2(0.04) });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("kick");
    expect(r.hier.ambiguous).toBe(false);
  });
  it("16. 40ms bright hat-like transient → NOT kick", () => {
    const feats = makeFeatures({
      duration: 0.04,
      transientDensity: 19,
      spectralCentroid: 11000,
      spectralBandwidth: 2800,
      spectralRolloff: 18000,
      zeroCrossingRate: 0.42,
      spectralFlatness: 0.66,
      attack: 0.0004,
      rms: 0.1,
      peak: 0.9,
    });
    const r = run(feats, {
      v2: v2({
        durationSec: 0.04,
        crestFactor: 9,
        transientStrength: 12,
        zeroCrossingRate: 0.42,
        spectralCentroidHz: 11000,
        spectralSpreadHz: 2800,
        spectralFlatness: 0.66,
        attackTimeSec: 0.0004,
        decayTimeSec: 0.006,
      }),
    });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).not.toBe("kick");
  });
  it("17. 80ms snare-like transient → NOT kick", () => {
    const feats = makeFeatures({
      duration: 0.08,
      transientDensity: 15,
      spectralCentroid: 2000,
      spectralBandwidth: 1200,
      spectralRolloff: 6000,
      zeroCrossingRate: 0.06,
      spectralFlatness: 0.4,
      attack: 0.002,
      rms: 0.22,
      peak: 0.9,
    });
    const r = run(feats, {
      v2: v2({
        durationSec: 0.08,
        transientStrength: 7,
        zeroCrossingRate: 0.06,
        spectralCentroidHz: 2000,
        spectralSpreadHz: 1200,
        spectralFlatness: 0.4,
        attackTimeSec: 0.002,
        decayTimeSec: 0.02,
      }),
    });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).not.toBe("kick");
  });
  it("18. ambiguous ultra-short transient → percussion + ambiguous, NOT kick", () => {
    const feats = makeFeatures({
      duration: 0.04,
      transientDensity: 18,
      spectralCentroid: 3200,
      spectralBandwidth: 2000,
      spectralRolloff: 10000,
      zeroCrossingRate: 0.2,
      spectralFlatness: 0.5,
      attack: 0.001,
      rms: 0.2,
      peak: 0.9,
    });
    const r = run(feats, {
      v2: v2({
        durationSec: 0.04,
        transientStrength: 10,
        zeroCrossingRate: 0.2,
        spectralCentroidHz: 3200,
        spectralSpreadHz: 2000,
        spectralFlatness: 0.5,
        attackTimeSec: 0.001,
        decayTimeSec: 0.004,
      }),
    });
    expect(r.hier.type).not.toBe("kick");
    expect(r.hier.ambiguous).toBe(true);
  });
});

describe("STEP44 musical (§15–§17)", () => {
  it("19. bass: dark pitched low sustained → bass", () => {
    const feats = makeFeatures({
      duration: 2,
      transientDensity: 1,
      spectralCentroid: 130,
      spectralBandwidth: 120,
      spectralRolloff: 800,
      zeroCrossingRate: 0.01,
      spectralFlatness: 0.12,
      attack: 0.1,
      rms: 0.35,
      peak: 0.5,
    });
    const r = run(feats, {
      name: "Sub Bass",
      v2: v2({
        durationSec: 2,
        pitchHz: 55,
        pitchConfidence: 0.8,
        harmonicity: 0.7,
        spectralCentroidHz: 130,
        spectralSpreadHz: 120,
        spectralFlatness: 0.12,
      }),
    });
    expect(r.hier.family).toBe("musical");
    expect(r.hier.type).toBe("bass");
  });
  it("20. piano: tonal hammer transient medium → piano", () => {
    const feats = makeFeatures({
      duration: 0.8,
      transientDensity: 12,
      spectralCentroid: 2100,
      spectralBandwidth: 1800,
      spectralRolloff: 6000,
      zeroCrossingRate: 0.05,
      spectralFlatness: 0.18,
      attack: 0.003,
      rms: 0.15,
      peak: 0.95,
    });
    const r = run(feats, {
      name: "Piano",
      v2: v2({
        durationSec: 0.8,
        crestFactor: 6.33,
        transientStrength: 4,
        pitchHz: 280,
        pitchConfidence: 0.9,
        harmonicity: 0.8,
        spectralCentroidHz: 2100,
        spectralSpreadHz: 1800,
        spectralFlatness: 0.18,
        attackTimeSec: 0.003,
        decayTimeSec: 0.25,
      }),
    });
    expect(r.hier.family).toBe("musical");
    expect(r.hier.type).toBe("piano");
  });
  it("21. guitar: tonal pluck medium → guitar", () => {
    const feats = makeFeatures({
      duration: 1.0,
      transientDensity: 11,
      spectralCentroid: 1800,
      spectralBandwidth: 1600,
      spectralRolloff: 5000,
      zeroCrossingRate: 0.06,
      spectralFlatness: 0.3,
      attack: 0.006,
      rms: 0.35,
      peak: 0.5,
    });
    const r = run(feats, {
      name: "Acoustic Gtr",
      v2: v2({
        durationSec: 1.0,
        crestFactor: 1.4,
        transientStrength: 3,
        pitchHz: 200,
        pitchConfidence: 0.6,
        harmonicity: 0.75,
        spectralCentroidHz: 1800,
        spectralSpreadHz: 1600,
        spectralFlatness: 0.3,
        attackTimeSec: 0.006,
        decayTimeSec: 0.35,
      }),
    });
    expect(r.hier.family).toBe("musical");
    expect(r.hier.type).toBe("guitar");
  });
  it("22. strings: sustained tonal no attack → strings", () => {
    const feats = makeFeatures({
      duration: 2.5,
      transientDensity: 1,
      spectralCentroid: 1600,
      spectralBandwidth: 900,
      spectralRolloff: 4000,
      zeroCrossingRate: 0.03,
      spectralFlatness: 0.15,
      attack: 0.3,
      rms: 0.3,
      peak: 0.45,
    });
    const r = run(feats, {
      name: "Violin",
      v2: v2({
        durationSec: 2.5,
        pitchHz: 440,
        pitchConfidence: 0.9,
        harmonicity: 0.8,
        spectralCentroidHz: 1600,
        spectralSpreadHz: 900,
        spectralFlatness: 0.15,
        attackTimeSec: 0.3,
        decayTimeSec: 0.3,
      }),
    });
    expect(r.hier.family).toBe("musical");
    expect(r.hier.type).toBe("strings");
  });
  it("23. keys: tonal mid short-ish sustain → keys", () => {
    const feats = makeFeatures({
      duration: 1.2,
      transientDensity: 9,
      spectralCentroid: 2000,
      spectralBandwidth: 1500,
      spectralRolloff: 5500,
      zeroCrossingRate: 0.05,
      spectralFlatness: 0.2,
      attack: 0.01,
      rms: 0.25,
      peak: 0.9,
    });
    const r = run(feats, {
      name: "EP Keys",
      v2: v2({
        durationSec: 1.2,
        crestFactor: 4,
        transientStrength: 2,
        pitchHz: 300,
        pitchConfidence: 0.5,
        harmonicity: 0.7,
        spectralCentroidHz: 2000,
        spectralSpreadHz: 1500,
        spectralFlatness: 0.2,
        attackTimeSec: 0.01,
        decayTimeSec: 0.3,
      }),
    });
    expect(r.hier.family).toBe("musical");
    expect(r.hier.type).toBe("keys");
  });
  it("24. synth: mid tonal sustained harmonic → synth", () => {
    const feats = makeFeatures({
      duration: 2.5,
      transientDensity: 2,
      spectralCentroid: 2000,
      spectralBandwidth: 1200,
      spectralRolloff: 5000,
      zeroCrossingRate: 0.03,
      spectralFlatness: 0.1,
      attack: 0.05,
      rms: 0.35,
      peak: 0.5,
    });
    const r = run(feats, {
      name: "Synth Pad",
      v2: v2({
        durationSec: 2.5,
        pitchHz: 220,
        pitchConfidence: 0.7,
        harmonicity: 0.6,
        spectralCentroidHz: 2000,
        spectralSpreadHz: 1200,
        spectralFlatness: 0.1,
      }),
    });
    expect(r.hier.family).toBe("musical");
    expect(r.hier.type).toBe("synth");
  });
  it("25. pad: dark-mid sustained smooth → pad", () => {
    const feats = makeFeatures({
      duration: 3.5,
      transientDensity: 1,
      spectralCentroid: 700,
      spectralBandwidth: 800,
      spectralRolloff: 3000,
      zeroCrossingRate: 0.02,
      spectralFlatness: 0.22,
      attack: 0.2,
      rms: 0.3,
      peak: 0.4,
    });
    const r = run(feats, {
      name: "Atmos Pad",
      v2: v2({
        durationSec: 3.5,
        harmonicity: 0.6,
        spectralCentroidHz: 700,
        spectralSpreadHz: 800,
        spectralFlatness: 0.22,
      }),
    });
    expect(r.hier.family).toBe("musical");
    expect(r.hier.type).toBe("pad");
  });
  it("26b. lead: bright pitchy sustained → lead", () => {
    const feats = makeFeatures({
      duration: 2.0,
      transientDensity: 3,
      spectralCentroid: 4000,
      spectralBandwidth: 1400,
      spectralRolloff: 8000,
      zeroCrossingRate: 0.06,
      spectralFlatness: 0.15,
      attack: 0.05,
      rms: 0.3,
      peak: 0.5,
    });
    const r = run(feats, {
      name: "Lead Synth",
      v2: v2({
        durationSec: 2.0,
        pitchHz: 480,
        pitchConfidence: 0.8,
        harmonicity: 0.7,
        spectralCentroidHz: 4000,
        spectralSpreadHz: 1400,
        spectralFlatness: 0.15,
      }),
    });
    expect(r.hier.family).toBe("musical");
    expect(r.hier.type).toBe("lead");
  });
});

describe("STEP44 vocal (§16): singing/rap/spoken are vocal, NOT noise", () => {
  it("26. singing: pitched harmonic vocal-band → vocal", () => {
    const feats = makeFeatures({
      duration: 2.2,
      transientDensity: 4,
      spectralCentroid: 1100,
      spectralBandwidth: 1800,
      spectralRolloff: 6000,
      zeroCrossingRate: 0.07,
      spectralFlatness: 0.55,
      attack: 0.03,
      rms: 0.25,
      peak: 0.5,
    });
    const r = run(feats, {
      name: "Singing Hook",
      v2: v2({
        durationSec: 2.2,
        pitchHz: 320,
        pitchConfidence: 0.75,
        harmonicity: 0.6,
        spectralFlux: 0.5,
        spectralCentroidHz: 1100,
        spectralSpreadHz: 1800,
        spectralFlatness: 0.55,
      }),
    });
    expect(r.hier.family).toBe("vocal");
    expect(r.hier.type).toBe("vocal");
    expect(r.hier.type).not.toBe("noise");
    expect(r.hier.type).not.toBe("atmosphere");
  });
  it("27. rap: pitched fast speech → vocal", () => {
    const feats = makeFeatures({
      duration: 1.8,
      transientDensity: 6,
      spectralCentroid: 1600,
      spectralBandwidth: 2200,
      spectralRolloff: 6500,
      zeroCrossingRate: 0.09,
      spectralFlatness: 0.5,
      attack: 0.01,
      rms: 0.25,
      peak: 0.6,
    });
    const r = run(feats, {
      name: "Rap Flow",
      v2: v2({
        durationSec: 1.8,
        pitchHz: 170,
        pitchConfidence: 0.55,
        harmonicity: 0.55,
        spectralFlux: 0.6,
        spectralCentroidHz: 1600,
        spectralSpreadHz: 2200,
        spectralFlatness: 0.5,
      }),
    });
    expect(r.hier.family).toBe("vocal");
    expect(r.hier.type).toBe("vocal");
  });
  it("28. spoken: pitched dry voice → vocal", () => {
    const feats = makeFeatures({
      duration: 1.5,
      transientDensity: 3,
      spectralCentroid: 900,
      spectralBandwidth: 1600,
      spectralRolloff: 4500,
      zeroCrossingRate: 0.06,
      spectralFlatness: 0.6,
      attack: 0.02,
      rms: 0.2,
      peak: 0.4,
    });
    const r = run(feats, {
      name: "Spoken Word",
      v2: v2({
        durationSec: 1.5,
        pitchHz: 140,
        pitchConfidence: 0.45,
        harmonicity: 0.5,
        spectralCentroidHz: 900,
        spectralSpreadHz: 1600,
        spectralFlatness: 0.6,
      }),
    });
    expect(r.hier.family).toBe("vocal");
  });
});

describe("STEP44 fx / bins (§17–§18)", () => {
  it("29. riser: evolving broadband sweep → fx", () => {
    const feats = makeFeatures({
      duration: 3,
      transientDensity: 2,
      spectralCentroid: 4200,
      spectralBandwidth: 7000,
      spectralRolloff: 12000,
      zeroCrossingRate: 0.2,
      spectralFlatness: 0.8,
      attack: 0.05,
      rms: 0.25,
      peak: 0.5,
    });
    const r = run(feats, {
      name: "Riser",
      v2: v2({
        durationSec: 3,
        spectralFlux: 0.9,
        spectralCentroidHz: 4200,
        spectralSpreadHz: 7000,
        spectralFlatness: 0.8,
      }),
    });
    expect(r.hier.family).toBe("fx");
    expect(r.hier.type).toBe("fx");
  });
  it("30. sweep: high flux white sweep → fx", () => {
    const feats = makeFeatures({
      duration: 2.5,
      transientDensity: 2,
      spectralCentroid: 5000,
      spectralBandwidth: 8000,
      spectralRolloff: 14000,
      zeroCrossingRate: 0.25,
      spectralFlatness: 0.75,
      attack: 0.04,
      rms: 0.25,
      peak: 0.5,
    });
    const r = run(feats, {
      name: "Whoosh Sweep",
      v2: v2({
        durationSec: 2.5,
        spectralFlux: 1.1,
        spectralCentroidHz: 5000,
        spectralSpreadHz: 8000,
        spectralFlatness: 0.75,
      }),
    });
    expect(r.hier.family).toBe("fx");
  });
  it("31. impact: sub boom transient extreme band → fx", () => {
    const feats = makeFeatures({
      duration: 0.8,
      transientDensity: 6,
      spectralCentroid: 140,
      spectralBandwidth: 4000,
      spectralRolloff: 6000,
      zeroCrossingRate: 0.04,
      spectralFlatness: 0.5,
      attack: 0.03,
      rms: 0.3,
      peak: 0.9,
    });
    const r = run(feats, {
      name: "Impact Drop",
      v2: v2({
        durationSec: 0.8,
        transientStrength: 2,
        spectralFlux: 1.2,
        spectralCentroidHz: 140,
        spectralSpreadHz: 4000,
        spectralFlatness: 0.5,
        attackTimeSec: 0.03,
        spectralRolloffHz: 6000,
      }),
    });
    expect(r.hier.family).toBe("fx");
    expect(r.hier.type).toBe("fx");
  });
  it("32. noise bed: sustained full flat noise → atmosphere-noise/noise", () => {
    const feats = makeFeatures({
      duration: 3,
      transientDensity: 1,
      spectralCentroid: 4500,
      spectralBandwidth: 12000,
      spectralRolloff: 20000,
      zeroCrossingRate: 0.3,
      spectralFlatness: 0.92,
      attack: 0.1,
      rms: 0.25,
      peak: 0.4,
    });
    const r = run(feats, {
      name: "White Noise Bed",
      v2: v2({
        durationSec: 3,
        spectralFlux: 0.2,
        spectralCentroidHz: 4500,
        spectralSpreadHz: 12000,
        spectralFlatness: 0.92,
      }),
    });
    expect(r.hier.family).toBe("atmosphere-noise");
    expect(r.hier.type).toBe("noise");
  });
  it("33. atmosphere bed: sustained mid dull bed → atmosphere", () => {
    const feats = makeFeatures({
      duration: 4,
      transientDensity: 1,
      spectralCentroid: 2000,
      spectralBandwidth: 3000,
      spectralRolloff: 6000,
      zeroCrossingRate: 0.1,
      spectralFlatness: 0.55,
      attack: 0.2,
      rms: 0.2,
      peak: 0.3,
    });
    const r = run(feats, {
      name: "Ambient Bed",
      v2: v2({
        durationSec: 4,
        spectralFlux: 0.3,
        spectralCentroidHz: 2000,
        spectralSpreadHz: 3000,
        spectralFlatness: 0.55,
      }),
    });
    expect(r.hier.family).toBe("atmosphere-noise");
    expect(r.hier.type).toBe("atmosphere");
  });
});

describe("STEP44 metadata reconciliation (§19–§26)", () => {
  it("34. explicit kick tag + strong audio → AGREE (kick), winner audio", () => {
    const r = run(kickFeatures(), { v2: kickV2(), tags: ["kick"], name: "Kick" });
    expect(r.hier.type).toBe("kick");
    expect(r.hier.reconciliation.status).toBe("AGREE");
    expect(r.hier.reconciliation.winningSource).toBe("audio");
    expect(r.hier.reconciliation.tagType).toBe("kick");
  });
  it("35. explicit snare tag under weak audio → TAG-SUPPORTED (snare)", () => {
    const r = run(ambiguousDrum(), { v2: ambiguousDrumV2(), tags: ["snare"] });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("snare");
    expect(r.hier.reconciliation.status).toBe("TAG-SUPPORTED");
    expect(r.hier.reconciliation.winningSource).toBe("tag");
  });
  it("36. explicit vocal tag + pitched material → vocal", () => {
    const r = run(pitchedWeak(), { tags: ["vocal"] });
    expect(r.hier.type).toBe("vocal");
    expect(r.hier.family).toBe("vocal");
    expect(r.hier.reconciliation.tagType).toBe("vocal");
  });
  it("37. CONFLICT: strong audio kick + tag snare → audio wins, disagreement kept", () => {
    const r = run(kickFeatures(), { v2: kickV2(), tags: ["snare"] });
    expect(r.hier.type).toBe("kick");
    expect(r.hier.reconciliation.status).toBe("CONFLICT");
    expect(r.hier.reconciliation.winningSource).toBe("audio");
    expect(r.hier.reconciliation.tagType).toBe("snare");
    expect(r.hier.reconciliation.conflict).toBe(true);
  });
  it("38. TAG-SUPPORTED by NAME: weak audio + snare name → snare, winner name", () => {
    const r = run(ambiguousDrum(), { v2: ambiguousDrumV2(), name: "Snare 02" });
    expect(r.hier.type).toBe("snare");
    expect(r.hier.reconciliation.status).toBe("TAG-SUPPORTED");
    expect(r.hier.reconciliation.winningSource).toBe("name");
    expect(r.hier.reconciliation.nameType).toBe("snare");
  });
  it("39. strong audio, no tags → AUDIO-SUPPORTED winner audio", () => {
    const r = run(kickFeatures(), { v2: kickV2() });
    expect(r.hier.type).toBe("kick");
    expect(r.hier.reconciliation.status).toBe("AUDIO-SUPPORTED");
    expect(r.hier.reconciliation.winningSource).toBe("audio");
    expect(r.hier.reconciliation.tagType).toBeUndefined();
  });
  it("40. generic 'drum' tag NEVER fixes a precise type (§21)", () => {
    const r = run(ambiguousDrum(), { v2: ambiguousDrumV2(), tags: ["drum"] });
    expect(r.hier.reconciliation.tagType).toBeUndefined();
    expect(r.hier.evidence.tag.generic).toContain("drum");
    expect(r.hier.evidence.tag.types).toEqual([]);
    expect(r.hier.reconciliation.status).not.toBe("AGREE");
  });
  it("41. generic 'loop' tag + kind loop → structure loop and no duration race", () => {
    const r = run(makeFeatures({ duration: 1.2 }), { kind: "loop", tags: ["loop"], durationSeconds: 1.2 });
    expect(r.hier.structure).toBe("loop");
    expect(r.hier.evidence.tag.generic).toContain("loop");
    expect(r.hier.evidence.tag.types).toEqual([]);
  });
  it("42. no evidence → no hallucinated precise type, low confidence", () => {
    const r = run(
      makeFeatures({
        duration: 1.0,
        transientDensity: 2,
        spectralCentroid: 1500,
        spectralBandwidth: 1800,
        spectralRolloff: 7000,
        zeroCrossingRate: 0.03,
        spectralFlatness: 0.62,
        attack: 0.04,
        rms: 0.2,
        peak: 0.4,
      }),
      {},
    );
    const specific = ["kick", "snare", "clap", "hihat", "openhat", "tom", "cymbal", "bass", "synth", "piano", "guitar", "strings", "keys", "pad", "lead", "vocal"];
    expect(specific).not.toContain(r.hier.type);
    expect(r.hier.confidence).toBeLessThan(0.3);
    expect(r.hier.reconciliation.status).toMatch(/AUDIO-SUPPORTED|UNKNOWN/);
  });
});

describe("STEP44 null-safe V2 (§43-45)", () => {
  it("43. missing V2 pitch fields → still classifies, no crash, finite", () => {
    // Keep the kick acoustic profile; only scrub the pitch/harmonicity fields.
    const v: AudioFeaturesV2 = { ...kickV2(), pitchHz: null, pitchConfidence: null, harmonicity: null };
    const r = run(kickFeatures(), { v2: v });
    expect(Number.isFinite(r.hier.confidence)).toBe(true);
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("kick");
  });
  it("44. V2 harmonicity null (instruments) → valid, musical not atmosphere", () => {
    const feats = makeFeatures({
      duration: 2,
      transientDensity: 1,
      spectralCentroid: 1600,
      spectralBandwidth: 900,
      spectralFlatness: 0.15,
      attack: 0.2,
    });
    const r = run(feats, {
      name: "Sustained",
      v2: v2({
        durationSec: 2,
        harmonicity: null,
        pitchHz: null,
        pitchConfidence: null,
        spectralCentroidHz: 1600,
        spectralSpreadHz: 900,
        spectralFlatness: 0.15,
      }),
    });
    expect(r.hier.family).toBe("musical");
    expect(Number.isFinite(r.hier.confidence)).toBe(true);
  });
  it("45. missing V2 entirely → still valid; confidence penalized vs V2 present", () => {
    const withV2 = run(kickFeatures(), { v2: kickV2() });
    const without = run(kickFeatures(), {});
    expect(without.hier.type).toBe("kick");
    expect(without.hier.confidence).toBeLessThan(withV2.hier.confidence);
    expect(without.hier.confidence).toBeGreaterThanOrEqual(0.05);
  });
});

describe("STEP45 acoustic calibration (§10–§12 evidence-backed)", () => {
  // A fully-anchored measured snare profile (median centroid 5.1k, noise-burst
  // flatness 0.22, mid zcr 0.11, crest ~6) MUST out-score the percussion
  // residue. Legacy: the brightB ×0.3 cap left even a perfect snare ≈0.30 vs
  // the fixed 0.25 residue, so snares collapsed to percussion (STEP44.1 0/50).
  it("46. percussion residue: fully-anchored bright snare wins (residue is no longer a veto)", () => {
    const feats = makeFeatures({
      duration: 0.45,
      transientDensity: 15,
      spectralCentroid: 5100,
      spectralBandwidth: 3800,
      spectralRolloff: 8700,
      zeroCrossingRate: 0.11,
      spectralFlatness: 0.22,
      attack: 0.001,
      rms: 0.2,
      peak: 0.9,
    });
    const r = run(feats, {
      v2: v2({
        durationSec: 0.45,
        crestFactor: 6,
        transientStrength: 4,
        zeroCrossingRate: 0.11,
        spectralCentroidHz: 5100,
        spectralSpreadHz: 3800,
        spectralFlatness: 0.22,
        attackTimeSec: 0.001,
        decayTimeSec: 0.046,
        spectralRolloffHz: 8700,
      }),
    });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("snare");
    // snare↔clap separation measured WEAK (es ≈0.5 max) — the decision is
    // never reported as a strong overclaim; it stays honest/ambiguous.
    expect(r.hier.ambiguous).toBe(true);
    expect(r.hier.reconciliation.status).toBe("UNKNOWN");
  });
  it("47. percussion residue: generic short bright transient hit stays percussion (no fabricated subtype)", () => {
    // Generic bright very-short transient with no specific anchor -> §14 residue.
    const feats = makeFeatures({
      duration: 0.2,
      transientDensity: 16,
      spectralCentroid: 3600,
      spectralBandwidth: 3100,
      spectralRolloff: 9000,
      zeroCrossingRate: 0.09,
      spectralFlatness: 0.55,
      attack: 0.001,
      rms: 0.18,
      peak: 0.9,
    });
    const r = run(feats, {
      v2: v2({
        durationSec: 0.2,
        crestFactor: 10,
        transientStrength: 6.6,
        zeroCrossingRate: 0.09,
        spectralCentroidHz: 3600,
        spectralSpreadHz: 3100,
        spectralFlatness: 0.55,
        attackTimeSec: 0.001,
        decayTimeSec: 0.03,
        spectralRolloffHz: 9000,
      }),
    });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("percussion");
    expect(r.hier.ambiguous).toBe(true);
  });
  it("48. kick: a darkMid thump (measured centroid 135–519Hz) is no longer crushed below the residue", () => {
    const feats = makeFeatures({
      duration: 0.42,
      transientDensity: 16,
      spectralCentroid: 500,
      spectralBandwidth: 400,
      spectralRolloff: 3000,
      zeroCrossingRate: 0.01,
      spectralFlatness: 0.05,
      attack: 0.002,
      rms: 0.3,
      peak: 0.95,
    });
    const r = run(feats, {
      v2: v2({
        durationSec: 0.42,
        crestFactor: 3.3,
        transientStrength: 3.1,
        zeroCrossingRate: 0.01,
        spectralCentroidHz: 500,
        spectralSpreadHz: 400,
        spectralFlatness: 0.05,
        attackTimeSec: 0.005,
        decayTimeSec: 0.1,
        spectralRolloffHz: 3000,
      }),
    });
    expect(r.hier.family).toBe("drums");
    // darkMid thumps sit at the honest kick↔tom boundary, but they must NOT be
    // forfeited to the percussion residue (the legacy !dark ×0.25 behaviour).
    expect(r.hier.type).not.toBe("percussion");
  });
  it("49. hihat: measured closed-hat transient (5.2–8.5) + very short decay keeps hihat; a ringing bright noise is NOT a closed hat", () => {
    // §14 gate: a 0.18s bright transient fires hihat best (1.0) but the margin
    // to cymbal/clap (~0.80) is only 0.20 — genuinely ambiguous at ultra-short
    // durations. Acoustic-only → percussion; tags rescue to hihat (TAG-SUPPORTED).
    const closedV2 = v2({
      durationSec: 0.18,
      crestFactor: 7,
      transientStrength: 6.5,
      zeroCrossingRate: 0.29,
      spectralCentroidHz: 8500,
      spectralSpreadHz: 6000,
      spectralFlatness: 0.65,
      attackTimeSec: 0,
      decayTimeSec: 0.032,
      spectralRolloffHz: 12000,
    });
    const closedNoTag = run(
      makeFeatures({
        duration: 0.18,
        transientDensity: 16,
        spectralCentroid: 8500,
        spectralBandwidth: 6000,
        spectralRolloff: 12000,
        zeroCrossingRate: 0.29,
        spectralFlatness: 0.65,
        attack: 0.001,
      }),
      { v2: closedV2 },
    );
    expect(closedNoTag.hier.family).toBe("drums");
    expect(closedNoTag.hier.type).toBe("percussion");
    const closedWithTag = run(
      makeFeatures({
        duration: 0.18,
        transientDensity: 16,
        spectralCentroid: 8500,
        spectralBandwidth: 6000,
        spectralRolloff: 12000,
        zeroCrossingRate: 0.29,
        spectralFlatness: 0.65,
        attack: 0.001,
      }),
      { v2: closedV2, tags: ["hihat"] },
    );
    expect(closedWithTag.hier.type).toBe("hihat");
    expect(closedWithTag.hier.reconciliation.status).toBe("TAG-SUPPORTED");
    // Ringing hat: >0.35s so no §14 gate; long decay + soft transient → openhat.
    const ringing = run(
      makeFeatures({
        duration: 0.55,
        transientDensity: 14,
        spectralCentroid: 8400,
        spectralBandwidth: 6000,
        spectralRolloff: 11600,
        zeroCrossingRate: 0.31,
        spectralFlatness: 0.6,
        attack: 0.002,
      }),
      {
        v2: v2({
          durationSec: 0.55,
          crestFactor: 7.4,
          transientStrength: 1.6,
          zeroCrossingRate: 0.31,
          spectralCentroidHz: 8400,
          spectralSpreadHz: 6000,
          spectralFlatness: 0.6,
          attackTimeSec: 0.01,
          decayTimeSec: 0.174,
          spectralRolloffHz: 11600,
        }),
      },
    );
    expect(ringing.hier.type).toBe("openhat");
  });
  it("50. openhat: soft transient (<3) + 0.35–1.2s dur + long decay → openhat, NOT hihat", () => {
    const feats = makeFeatures({
      duration: 0.55,
      transientDensity: 13,
      spectralCentroid: 8400,
      spectralBandwidth: 5800,
      spectralRolloff: 11600,
      zeroCrossingRate: 0.31,
      spectralFlatness: 0.6,
      attack: 0.003,
      rms: 0.2,
      peak: 0.9,
    });
    const r = run(feats, {
      v2: v2({
        durationSec: 0.55,
        crestFactor: 7.4,
        transientStrength: 1.6,
        zeroCrossingRate: 0.31,
        spectralCentroidHz: 8400,
        spectralSpreadHz: 5800,
        spectralFlatness: 0.6,
        attackTimeSec: 0.01,
        decayTimeSec: 0.174,
        spectralRolloffHz: 11600,
      }),
      tags: ["hihat"], // even an explicit hihat tag must not flip a ringing open hat
    });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).toBe("openhat");
    expect(r.hier.reconciliation.tagType).toBe("hihat");
  });
  it("51. snare↔clap WEAK separation: the acoustic edge is capped below the strong threshold so a clap tag still supports full clap", () => {
    // Measured snare↔clap overlap (centroid 3.7–6.0k both; max es ≈0.5). Build a
    // boundary hit where the snare row scores above clap; the acoustic decision
    // must be flagged ambiguous (not audioStrong) so reconciliation uses tags.
    const feats = makeFeatures({
      duration: 0.45,
      transientDensity: 15,
      spectralCentroid: 4800,
      spectralBandwidth: 3600,
      spectralRolloff: 8500,
      zeroCrossingRate: 0.12,
      spectralFlatness: 0.24,
      attack: 0.001,
      rms: 0.2,
      peak: 0.9,
    });
    const v2o = v2({
      durationSec: 0.45,
      crestFactor: 7.5,
      transientStrength: 4.3,
      zeroCrossingRate: 0.12,
      spectralCentroidHz: 4800,
      spectralSpreadHz: 3600,
      spectralFlatness: 0.24,
      attackTimeSec: 0.001,
      decayTimeSec: 0.035,
      spectralRolloffHz: 8500,
    });
    const noMeta = run(feats, { v2: v2o });
    expect(noMeta.hier.family).toBe("drums");
    expect(noMeta.hier.type).toBe("snare");
    expect(noMeta.hier.ambiguous).toBe(true);
    const withClapTag = run(feats, { v2: v2o, tags: ["clap"] });
    expect(withClapTag.hier.type).toBe("clap");
    expect(withClapTag.hier.reconciliation.status).toBe("TAG-SUPPORTED");
  });
  it("52. kick: measured darkMid (not <250Hz) bright-side thump keeps kick-vs-residue honest", () => {
    const feats = makeFeatures({
      duration: 0.4,
      transientDensity: 15,
      spectralCentroid: 700,
      spectralBandwidth: 500,
      spectralRolloff: 3200,
      zeroCrossingRate: 0.015,
      spectralFlatness: 0.08,
      attack: 0.002,
      rms: 0.3,
      peak: 0.95,
    });
    const r = run(feats, {
      v2: v2({
        durationSec: 0.4,
        crestFactor: 3,
        transientStrength: 3,
        zeroCrossingRate: 0.015,
        spectralCentroidHz: 700,
        spectralSpreadHz: 500,
        spectralFlatness: 0.08,
        attackTimeSec: 0.005,
        decayTimeSec: 0.1,
        spectralRolloffHz: 3200,
      }),
    });
    expect(r.hier.family).toBe("drums");
    expect(r.hier.type).not.toBe("percussion");
  });
});

describe("STEP44 invariants", () => {
  it("is deterministic (byte-identical outputs)", () => {
    const a = run(kickFeatures(), { v2: kickV2(), tags: ["kick"] });
    const b = run(kickFeatures(), { v2: kickV2(), tags: ["kick"] });
    expect(b).toEqual(a);
  });
  it("emits a well-formed persisted hier classification", () => {
    const r = run(kickFeatures(), { v2: kickV2(), tags: ["kick"] });
    expect(isWellFormedHierClassification(r.hier)).toBe(true);
    expect(r.hier.classificationVersion).toBe("hier-v1");
  });
  it("surface vocabulary is exactly the existing taxonomy (SC11)", () => {
    for (const o of [
      { tags: ["kick"] },
      { tags: ["vocal"] },
      { name: "Riser" },
      {},
    ]) {
      const r = run(kickFeatures(), { v2: kickV2(), ...o });
      const ids = [r.surface.primaryClass, ...r.surface.secondaryClasses.map((s) => s.class)];
      expect(ids.every((c) => ALL_CLASSES.includes(c))).toBe(true);
    }
    expect(run(pitchedWeak(), {}).surface.primaryClass).toBe(UNKNOWN_TYPE);
  });
  it("confidence always in [0.05, 0.95]", () => {
    const cases = [
      run(kickFeatures(), { v2: kickV2(), tags: ["kick"] }),
      run(ambiguousDrum(), { v2: ambiguousDrumV2() }),
      run(kickFeatures(), { tags: ["snare"] }),
      run(pitchedWeak(), {}),
    ];
    for (const r of cases) {
      expect(r.hier.confidence).toBeGreaterThanOrEqual(0.05);
      expect(r.hier.confidence).toBeLessThanOrEqual(0.95);
      expect(Number.isFinite(r.surface.confidence)).toBe(true);
    }
  });
  it("the hier record survives assertNoAudioBytes (SC12 additivity)", () => {
    const r = run(kickFeatures(), { v2: kickV2(), tags: ["kick"] });
    expect(() => assertNoAudioBytes(r.hier)).not.toThrow();
    expect(r.hier.evidence.audio.familyScores).toBeTruthy();
  });
  it("name evidence is boundary-aware and never sub-strings (skick ≠ kick)", () => {
    const a = run(makeFeatures({ duration: 0.3, spectralCentroid: 140, spectralFlatness: 0.1 }),
      { name: "skick" });
    expect(a.hier.evidence.name.types).not.toContain("kick");
    const b = run(makeFeatures({ duration: 0.3, spectralCentroid: 140, spectralFlatness: 0.1 }),
      { name: "808 Kick Punchy" });
    expect(b.hier.evidence.name.types).toContain("kick");
  });
});

describe("HierClassifier (stable Classifier contract)", () => {
  const c = new HierClassifier();
  it("exposes id = hier and version = hier-v1", () => {
    expect(c.id).toBe("hier");
    expect(c.version).toBe("hier-v1");
  });
  it("classify(features) returns a valid, honest feature-only surface", async () => {
    const out = await c.classify(kickFeatures());
    expect(ALL_CLASSES).toContain(out.primaryClass);
    expect(Number.isFinite(out.confidence)).toBe(true);
    expect(out.confidence).toBeGreaterThanOrEqual(0.05);
    expect(out.confidence).toBeLessThanOrEqual(1);
  });
});