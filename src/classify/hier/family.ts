/**
 * STEP44 — Stage 1: acoustic sound family (§9–§11).
 *
 * Families are scored INDEPENDENTLY (no single global race where one class can
 * dominate everything). Every score is a documented, additive combination of
 * null-safe V1/V2 feature indicators. High spectral flatness alone can NEVER
 * make vocal/musical/FX material classify as atmosphere-noise: those families
 * are actively discounted when strong pitch/harmonic evidence is present.
 *
 * Confidence here uses:
 *   - family share of the normalized score distribution,
 *   - family separation (top-vs-second margin ratio),
 * and is refined in the orchestrator with type margin + reconciliation
 * agreement + a missing-feature penalty. It is a decision confidence, NOT a
 * claimed statistical probability (§11).
 */
import type { AudioFeatures } from "../../persistence/indexStore";
import type { AudioFeaturesV2 } from "../../analysis/audioFeaturesV2";
import type { SoundFamily, SoundStructure } from "./types";

export interface FamilyHints {
  drums: boolean;
  musical: boolean;
  vocal: boolean;
  fx: boolean;
  atmosphere: boolean;
  noise: boolean;
}

export interface FamilyScoring {
  scores: Record<SoundFamily, number>;
  family: SoundFamily;
  /** (top − second) / top in [0,1]. 0 when only one family fires. */
  marginRatio: number;
  /** top / sum(scores) in [0,1]. */
  shareTop: number;
}

export interface FamilyInput {
  features: AudioFeatures;
  v2?: AudioFeaturesV2 | null;
  structure: SoundStructure;
  hints: FamilyHints;
  durationSeconds: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const nan = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : NaN;

/**
 * Documented family weights (STEP44 §10). Each rule is an independent, bounded
 * contribution; a family wins by accumulating consistent evidence, never by a
 * single dominant shortcut.
 */
const W = {
  drums: {
    transient: 0.35, // strong transient onset (V2 transientStrength or V1 density)
    crest: 0.2, // peak-to-rms crest (V2 or derived)
    fastAttack: 0.15, // near-instant attack
    hitDuration: 0.15, // short one-hit envelope
    lowMidSpectrum: 0.15, // drums live in the low/mid band
    hint: 0.15, // drum ontology / name / tag evidence
    longPhraseGate: 0.25, // a >4s one-shot phrase is NOT a drum hit
    tonalGate: 0.2, // sustained pitched tones are not drums
  },
  musical: {
    harmonic: 0.3, // measured harmonicity (V2)
    pitch: 0.2, // meaningful pitch confidence (V2)
    tonal: 0.2, // low spectral flatness (tonal line)
    sustained: 0.1, // sustained energy
    sustainedTonal: 0.15, // sustained + tonal = a held line/bed, not a carpet
    hint: 0.2, // musical name/tag evidence
  },
  vocal: {
    pitch: 0.3,
    harmonic: 0.2,
    vocalBand: 0.15, // mixed noise — speech/singing sits mid-high, flatter than dry tones
    unvoicedGate: 0.4, // no pitch + no hint → unlikely vocal
    hint: 0.25,
  },
  fx: {
    flux: 0.25, // evolving spectral content (V2 spectralFlux)
    inharmonic: 0.2, // measurably inharmonic (V2)
    impact: 0.2, // transient with extreme band energy (V1 fallback)
    wideBand: 0.2, // very wide spectral spread
    hint: 0.25, // fx/riser/sweep/impact evidence
  },
  atmosphere: {
    unpitched: 0.25,
    unharmonic: 0.25,
    flat: 0.25,
    sustained: 0.15,
    hint: 0.1,
    voicedGate: 0.35, // strong pitch/harmony actively reduces this family
    evolvingGate: 0.3, // strong spectral evolution is NOT static atmosphere
    tonalGate: 0.3, // strong tonal line (flat < 0.3) is not a carpet/bed
    bedlessGate: 0.25, // absence-of-voice evidence alone must not sell a bed
  },
} as const;

/** Score helpers shared by the independent family rules. */
function indicators(
  f: AudioFeatures,
  v2: AudioFeaturesV2 | null | undefined,
) {
  const flux = nan(v2?.spectralFlux);
  const ts = nan(v2?.transientStrength);
  const crest2 = nan(v2?.crestFactor);
  const atk2 = nan(v2?.attackTimeSec);
  const pitchHz = nan(v2?.pitchHz);
  const pitchConf = nan(v2?.pitchConfidence);
  const harmonic = nan(v2?.harmonicity);
  const inharm = nan(v2?.inharmonicity);

  const crest1 = f.rms > 0 && f.peak > 0 ? f.peak / f.rms : NaN;
  const crest = Number.isFinite(crest2) ? crest2 : Number.isFinite(crest1) ? crest1 : NaN;

  const transient = !Number.isNaN(ts) ? ts : f.transientDensity;
  const hasTransient = (!Number.isNaN(ts) ? ts >= 0.25 : f.transientDensity > 5)
    || f.attack < 0.02;
  const fastAttack =
    !Number.isNaN(atk2) ? atk2 < 0.012 : f.attack < 0.02;
  const crestHigh = Number.isFinite(crest) && crest >= 5;

  const hasPitch =
    !Number.isNaN(pitchHz) &&
    !Number.isNaN(pitchConf) &&
    pitchConf >= 0.35;
  const hasHarmonic = !Number.isNaN(harmonic) && harmonic >= 0.55;
  const hasInharmonic = !Number.isNaN(inharm) && inharm >= 0.5;

  const flat =
    Number.isFinite(nan(v2?.spectralFlatness)) ? (v2?.spectralFlatness as number) : f.spectralFlatness;
  const centroid =
    Number.isFinite(nan(v2?.spectralCentroidHz)) ? (v2?.spectralCentroidHz as number) : f.spectralCentroid;
  const bandwidth =
    Number.isFinite(nan(v2?.spectralSpreadHz)) ? (v2?.spectralSpreadHz as number) : f.spectralBandwidth;
  const tonal = flat < 0.35;
  const flatNoisy = flat >= 0.6;
  const lowMid = centroid < 3200 && centroid >= 100;
  const midHigh = centroid >= 250 && centroid <= 6000;
  const wideBand = bandwidth > 3000;

  return {
    transient,
    hasTransient,
    fastAttack,
    crestHigh,
    hasPitch,
    hasHarmonic,
    hasInharmonic,
    tonal,
    flat,
    flatNoisy,
    lowMid,
    midHigh,
    centroid,
    bandwidth,
    wideBand,
    flux,
    duration: f.duration,
  };
}

/** Score every family independently. All contributions are bounded and additive. */
export function scoreFamilies(input: FamilyInput): FamilyScoring {
  const { features: f, v2, structure, hints, durationSeconds } = input;
  const I = indicators(f, v2);
  const dur = durationSeconds;

  // ---- drums ------------------------------------------------------------
  let drums =
    W.drums.transient * (I.hasTransient ? 1 : 0)
    + W.drums.crest * (I.crestHigh ? 1 : 0)
    + W.drums.fastAttack * (I.fastAttack ? 1 : 0)
    + W.drums.hitDuration * (dur < 0.75 ? 1 : 0)
    + W.drums.lowMidSpectrum * (I.lowMid ? 1 : 0)
    + W.drums.hint * (hints.drums ? 1 : 0);
  if (structure === "sustained-phrase") {
    // A >4s one-shot is a full phrase/track — its hit-like onset does not make
    // the whole sample a drum hit (STEP43: "way down kick 180" case).
    drums *= W.drums.longPhraseGate;
  }
  if (I.hasHarmonic && I.hasPitch && !I.hasTransient) drums -= W.drums.tonalGate;
  // ---- end drums

  // ---- musical ----------------------------------------------------------
  let musical =
    W.musical.harmonic * (I.hasHarmonic ? 1 : 0)
    + W.musical.pitch * (I.hasPitch ? 1 : 0)
    + W.musical.tonal * (I.tonal ? 1 : 0)
    + W.musical.sustained * (dur > 1.5 ? 1 : 0)
    + W.musical.sustainedTonal * (dur > 1.5 && I.tonal ? 1 : 0)
    + W.musical.hint * (hints.musical ? 1 : 0);
  // Short, unvoiced, noise-flat content is not "musical" without a hint.
  if (!I.hasHarmonic && !I.hasPitch && !I.tonal && !hints.musical) musical *= 0.4;
  // ---- end musical

  // ---- vocal -------------------------------------------------------------
  let vocal =
    W.vocal.pitch * (I.hasPitch ? 1 : 0)
    + W.vocal.harmonic * (I.hasHarmonic ? 1 : 0)
    + W.vocal.vocalBand * (I.flat >= 0.4 && I.flat <= 0.85 && I.midHigh ? 1 : 0)
    + W.vocal.hint * (hints.vocal ? 1 : 0);
  if (!I.hasPitch && !hints.vocal) vocal *= W.vocal.unvoicedGate;
  // ---- end vocal

  // ---- FX ----------------------------------------------------------------
  let fx =
    W.fx.flux * (!Number.isNaN(I.flux) && I.flux > 0.8 ? 1 : 0)
    + W.fx.inharmonic * (I.hasInharmonic ? 1 : 0)
    + W.fx.impact * (I.hasTransient && (I.centroid < 250 || I.centroid > 3200) ? 1 : 0)
    + W.fx.wideBand * (I.wideBand ? 1 : 0)
    + W.fx.hint * (hints.fx ? 1 : 0);
  // ---- end FX

  // ---- atmosphere / noise ------------------------------------------------
  // High flatness alone is explicitly NOT sufficient: pitched / harmonic
  // content actively discounts this family.
  let atmosphere =
    W.atmosphere.unpitched * (I.hasPitch ? 0 : 1)
    + W.atmosphere.unharmonic * (I.hasHarmonic ? 0 : 1)
    // A flat-noise BED only counts when it is sustained; a short flat burst is
    // still a HIT, not an atmosphere bed (§ atmosphere).
    + W.atmosphere.flat * (I.flatNoisy && dur > 1.5 ? 1 : 0)
    + W.atmosphere.sustained * (dur > 1.5 ? 1 : 0)
    + W.atmosphere.hint * (hints.atmosphere || hints.noise ? 1 : 0);
  if (I.hasHarmonic || I.hasPitch) atmosphere -= W.atmosphere.voicedGate;
  if ((I.hasHarmonic || I.hasPitch) && !I.flatNoisy) atmosphere *= 0.5;
  // A strong tonal line (flat < 0.3) is not a carpet / noise bed.
  if (I.tonal) atmosphere -= W.atmosphere.tonalGate;
  // Absence-of-voice evidence alone must not flag generic material as a bed:
  // require at least one POSITIVE bed/noise signature to keep the family.
  const bedPositive =
    (I.flatNoisy && dur > 1.5) || I.wideBand || dur > 1.5 || hints.atmosphere || hints.noise;
  if (!bedPositive) atmosphere *= W.atmosphere.bedlessGate;
  // Strong spectral evolution (riser/sweep) is not a static bed.
  if (Number.isFinite(I.flux) && I.flux > 0.8) atmosphere -= W.atmosphere.evolvingGate;
  // ---- end atmosphere / noise

  const scores: Record<SoundFamily, number> = {
    drums: clamp01(drums),
    musical: clamp01(musical),
    vocal: clamp01(vocal),
    fx: clamp01(fx),
    "atmosphere-noise": clamp01(atmosphere),
    unknown: 0,
  };

  return decide(scores);
}

/** Deterministic family decision from independent scores. */
export function decide(scores: Record<SoundFamily, number>): FamilyScoring {
  const order: SoundFamily[] = ["drums", "musical", "vocal", "fx", "atmosphere-noise", "unknown"];
  const ranked = order
    .map((family) => ({ family, score: scores[family] }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const second = ranked[1];
  const total = order.reduce((a, fam) => a + scores[fam], 0);
  const marginRatio = top.score > 0 ? (top.score - Math.max(0, second.score)) / top.score : 0;
  const shareTop = total > 0 ? top.score / total : 0;
  const DECIDE_MIN_SCORE = 0.3;
  const DECIDE_MIN_MARGIN = 0.12;

  let family: SoundFamily = top.family;
  if (top.score < DECIDE_MIN_SCORE) {
    family = "unknown";
  } else if (marginRatio < DECIDE_MIN_MARGIN && top.score < 0.5) {
    // No family separates clearly — report unknown rather than a coin-flip.
    family = "unknown";
  }
  return { scores, family, marginRatio, shareTop };
}