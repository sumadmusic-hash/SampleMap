/**
 * STEP44 — Stage 2: family-conditional acoustic type (§12–§18).
 *
 * Types are scored ONLY within the family selected at Stage 1 — no global
 * 22-class race. Drums use onset-shape V2 features (transientStrength /
 * attackTimeSec / decayTimeSec / crestFactor) when available and fall back to
 * V1 features otherwise. The "very short = kick" shortcut (STEP42 failure) is
 * REMOVED: a kick requires dark spectral energy; bright/short/low-energy
 * material cannot win kick. Ultra-short drum material prefers "correct family
 * + ambiguous subtype" over a confidently wrong subtype (§14).
 *
 * STEP45 calibration (§10): every constant below is anchored to MEDIAN/Q1/Q3
 * values measured on the 590-sample STEP45 one-shot reference corpus — percussion
 * residue drops from a fixed 0.25 veto to a low evidence-aware fallback (0.12+
 * real anchor hits); the snare brightB×0.3 cap is removed (snares ARE bright,
 * median 5.1k) in favour of a sun-bright (>7.5k) hi-hat-side cap; kicks keep
 * SC4 but only bar centroid >900Hz (darkMid kicks measure 135–519Hz); hihat vs
 * openhat split on measured transientStrength (closed Q1 5.2 vs open Q3 2.0)
 * and decay (0.032 vs 0.174); keys gain a slow-attack cue (median 3.1s vs piano
 * 0.10s).
 */
import type { AudioFeatures } from "../../persistence/indexStore";
import type { AudioFeaturesV2 } from "../../analysis/audioFeaturesV2";
import type { ClassId } from "../classifier";
import type { SoundFamily, SoundStructure } from "./types";
import { FAMILY_TYPES } from "./types";

export interface TypeScoring {
  scores: Record<ClassId, number>;
  type: ClassId;
  /** (top − second) / top in [0,1]; 0 when only one candidate fires. */
  marginRatio: number;
  /** Alternative candidates (excluding the winner), descending score. */
  runners: ClassId[];
  ambiguous: boolean;
}

export interface TypeInput {
  family: SoundFamily;
  features: AudioFeatures;
  v2?: AudioFeaturesV2 | null;
  structure: SoundStructure;
  durationSeconds: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const nan = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : NaN;

/** Margin ratio below which the type decision is flagged ambiguous (§28). */
export const TYPE_AMBIGUOUS_MARGIN = 0.18;

/**
 * Ultra-short drums: subtype is made only when the acoustic margin is decisive.
 * Only for genuinely very-short hits (<=0.35s); a medium 0.4–0.5s snare/thump
 * is long enough to carry a subtype when the top acoustic candidate separates.
 * The optional margin stays the documented §14 bar for the ultra-short case.
 */
export const ULTRA_SHORT_SUBTYPE_MIN_MARGIN = 0.35;
/** Ultra-short drum threshold (seconds). */
export const ULTRA_SHORT_SEC = 0.35;

interface DrumM {
  dur: number;
  flux: number;
  dec2: number;
  crest: number;
  centroid: number;
  short: boolean;
  med: boolean;
  veryShort: boolean;
  dark: boolean;
  darkMid: boolean;
  midB: boolean;
  brightB: boolean;
  invisible: boolean;
  noisy: boolean;
  tonal: boolean;
  transient: boolean;
  fast: boolean;
  crestHigh: boolean;
  decayLong: boolean;
  decayShort: boolean;
  fluxHigh: boolean;
  zcr: number;
  bw: number;
  flat: number;
  ts: number;
  tsStrong: boolean;
}

function drumMetrics(input: TypeInput): DrumM {
  const { features: f, v2 } = input;
  const dur = input.durationSeconds;
  const ts = nan(v2?.transientStrength);
  const atk2 = nan(v2?.attackTimeSec);
  const dec2 = nan(v2?.decayTimeSec);
  const crest2 = nan(v2?.crestFactor);
  const flux = nan(v2?.spectralFlux);
  const crest1 = f.rms > 0 && f.peak > 0 ? f.peak / f.rms : NaN;
  const crest = Number.isFinite(crest2) ? crest2 : Number.isFinite(crest1) ? crest1 : NaN;

  const centroid =
    nan(v2?.spectralCentroidHz) || f.spectralCentroid;
  const zcr =
    typeof v2?.zeroCrossingRate === "number" ? v2.zeroCrossingRate : f.zeroCrossingRate;
  const bw =
    nan(v2?.spectralSpreadHz) || f.spectralBandwidth;
  const flat =
    nan(v2?.spectralFlatness) || f.spectralFlatness;
  const short = dur <= 0.5;
  const med = dur > 0.5 && dur <= 1.5;
  const veryShort = dur <= 0.35;
  const dark = centroid < 250;
  const darkMid = centroid >= 250 && centroid < 900;
  const midB = centroid >= 900 && centroid <= 3200;
  const brightB = centroid > 3200;
  const invisible = Math.abs(centroid) < 1e-9 && flat >= 0.999; // silence/degenerate
  const noisy = flat > 0.55;
  const tonal = flat < 0.3;
  const transient =
    (Number.isFinite(ts) ? ts >= 0.25 : f.transientDensity > 5) || f.attack < 0.02;
  const fast = Number.isFinite(atk2) ? atk2 < 0.012 : f.attack < 0.02;
  const crestHigh = Number.isFinite(crest) && crest >= 5;
  // STEP45 (§9–§10): measured decayTimeSec separates closed hats (median 0.032s)
  // from open hats (median 0.174s; Q1 0.128s). The legacy >0.15 boundary sat at
  // the open-hat MEDIAN, leaving ~half of open hats decay-neutral; 0.12 sits at
  // the open-hat Q1 and still clears the hi-hat Q3 (0.043s).
  const decayLong = Number.isFinite(dec2) && dec2 > 0.12;
  const decayShort = Number.isFinite(dec2) && dec2 < 0.05;
  const fluxHigh = Number.isFinite(flux) && flux > 0.4;
  // STEP45 (§10): transientStrength is the STRONGEST (es 2.25) closed↔open hat
  // discriminator — hi-hats median 6.5 (Q1 5.2), open hats/crashes Q3 ~2.0.
  const tsStrong = Number.isFinite(ts) && ts >= 3;
  return {
    dur, flux, dec2, crest, centroid, short, med, veryShort, dark, darkMid, midB,
    brightB, invisible, noisy, tonal, transient, fast, crestHigh, decayLong,
    decayShort, fluxHigh, zcr, bw, flat, ts, tsStrong,
  };
}

/**
 * Margin-based type decision for every multi-type family. Deterministic: ties
 * break toward the canonical family-type order (stable sort).
 */
function decideWithin(
  scores: Record<ClassId, number>,
  candidates: readonly ClassId[],
  input: TypeInput,
): TypeScoring {
  const ranked = candidates
    .map((c) => ({ c, s: clamp01(scores[c]) }))
    .sort((a, b) => b.s - a.s || candidates.indexOf(a.c) - candidates.indexOf(b.c));
  const top = ranked[0];
  const second = ranked[1];
  // STEP45 (§10): measured discriminations for the snare↔clap pair are WEAK
  // at the level the classifier can act on — NO STRONG feature exists in the
  // V2 pipeline (best V2 es: pitchConfidence 0.81, harmonicity 0.46,
  // pitchHz 0.32, attackTimeSec 0.30) and only two MODERATE SoundCharacter
  // terms (tonality 1.02, attack 0.92) sit at much weaker separation than
  // e.g. the kick↔snare centroid (es 2.6) or hihat↔openhat decay (es 2.5);
  // median centroids overlap across 3.7–6.0k. A scoring edge there is not
  // evidence of separation, so the effective margin is capped BELOW the
  // ambiguity threshold: the decision cannot report as "strong audio", and
  // reconciliation falls back to tag/name evidence. The top pick is unchanged
  // (med hits keep their type); ultra-short snare/clap hits route to the
  // percussion residue via the §14 gate.
  const weakSeparationPair =
    input.family === "drums" && top !== undefined && second !== undefined &&
    ((top.c === "snare" && second.c === "clap") || (top.c === "clap" && second.c === "snare"));
  let marginRatio = top.s > 0 ? (top.s - Math.max(0, second.s)) / top.s : 0;
  if (weakSeparationPair) marginRatio = Math.min(marginRatio, 0.15);
  const runners = ranked.slice(1, 4).map((r) => r.c);
  let type = top.c;
  let ambiguous = marginRatio < TYPE_AMBIGUOUS_MARGIN;

  if (top.s <= 0) {
    // No candidate fired acoustically: report the honest "unknown type" rather
    // than fabricating the first candidate (e.g. bass with zero support).
    type = "other";
    ambiguous = true;
  } else if (input.family === "drums" && input.structure !== "sustained-phrase") {
    const veryShort = input.durationSeconds <= ULTRA_SHORT_SEC;
    if (veryShort && marginRatio < ULTRA_SHORT_SUBTYPE_MIN_MARGIN) {
      // §14: prefer correct family + ambiguous subtype over a confident guess.
      type = "percussion";
      ambiguous = true;
    }
  }

  return { scores, type, marginRatio, runners, ambiguous };
}

export function classifyType(input: TypeInput): TypeScoring {
  if (input.family === "unknown") {
    return { scores: {}, type: "other", marginRatio: 0, runners: [], ambiguous: true };
  }
  if (input.family === "vocal") {
    return { scores: { vocal: 1 }, type: "vocal", marginRatio: 1, runners: [], ambiguous: false };
  }
  if (input.family === "fx") {
    return { scores: { fx: 1 }, type: "fx", marginRatio: 1, runners: [], ambiguous: false };
  }
  if (input.family === "atmosphere-noise") {
    return classifyAtmosphere(input);
  }
  const candidates = FAMILY_TYPES[input.family];
  const scores: Record<ClassId, number> = {};
  for (const c of candidates) {
    scores[c] = input.family === "drums" ? drumScore(c, input) : musicalScore(c, input);
  }
  return decideWithin(scores, candidates, input);
}

// ---- drums ---------------------------------------------------------------

function drumScore(classId: ClassId, input: TypeInput): number {
  const m = drumMetrics(input);
  switch (classId) {
    case "kick": {
      // SC4 (§14): KICK REQUIRES dark spectral energy. Bright/mid material can
      // never accumulate a confident kick — the auto-kick bug is removed.
      let s =
        0.3 * (m.dark ? 1 : m.darkMid ? 0.4 : 0)
        + 0.2 * (m.transient ? 1 : 0)
        + 0.15 * (m.fast ? 1 : 0)
        + 0.15 * (m.crestHigh ? 1 : 0)
        + 0.1 * (m.zcr < 0.03 ? 1 : 0)
        + 0.1 * (m.tonal ? 1 : 0);
      if (m.invisible) s = 0;
      // STEP45 (§9/§12): measured kick centroids span dark→darkMid (Q1 135Hz,
      // Q3 519Hz). Legacy `!dark → ×0.25` cut every darkMid kick (e.g. 519Hz
      // thump) down to ~0.1, losing to the percussion residue. Only genuinely
      // bright (>900Hz) material is barred — SC4's dark requirement is kept.
      else if (m.centroid > 900) s *= 0.25;
      return s;
    }
    case "snare": {
      // STEP45 (§9/§10): measured snares ARE bright — median centroid 5.1kHz
      // (Q1 3.7k / Q3 6.0k), noise-burst flatness 0.116–0.392, zcr 0.071–0.171,
      // crest 3.97–8.55. Legacy rules (brightB ×0.3 cap + flat in (0.3,0.7) band)
      // fired for only ~1 in 3 typical snares, capping even a fully-anchored
      // snare ≈0.30 and so STILL losing to the fixed 0.25 percussion residue
      // (STEP44.1 root cause: snare 0/50 acoustic). The cap now applies only at
      // the sun-bright hi-hat end (>7.5kHz, hat Q1 7.0k), and the zcr band
      // rewards the snare's mid zcr against hats (0.29+) and kicks (~0.004).
      let s =
        0.25 * (m.brightB || m.midB ? 1 : 0)
        + 0.2 * (m.transient ? 1 : 0)
        + 0.15 * (m.fast ? 1 : 0)
        + 0.15 * (m.flat >= 0.1 && m.flat <= 0.5 ? 1 : 0) // noise burst + body
        + 0.15 * (m.short ? 0.5 : m.med ? 1 : 0)
        + 0.1 * (m.crestHigh ? 1 : 0)
        + 0.1 * (m.zcr >= 0.05 && m.zcr <= 0.25 ? 1 : 0);
      if (m.invisible) s = 0;
      else if (m.dark) s *= 0.3;
      // STEP45 (§9/§10): measured snare↔percussion separation is MODERATE
      // (harmonicity es 1.18 — real percussion/rim/tambourine is MORE tonal).
      // Snare flatness Q1 is 0.116, so material in the near-tonal zone
      // (flat < 0.1, e.g. cowbell/rim/wood) is capped toward percussion.
      else if (m.flat < 0.1) s *= 0.4;
      // STEP45 (§9): measured boundary between snare (Q3 6.0k) and hi-hat
      // (Q1 7.0k) centroids. A bright "boundary hat" (>6.5k) is capped toward
      // the hat side so mid-bright taller hats stay honest.
      else if (m.centroid > 6500) s *= 0.45;
      return s;
    }
    case "clap": {
      let s =
        0.25 * (m.midB || m.brightB ? 1 : 0)
        + 0.2 * (m.noisy ? 1 : 0)
        + 0.15 * (m.transient ? 1 : 0)
        + 0.15 * (m.bw >= 2500 ? 1 : 0)
        + 0.15 * (m.zcr >= 0.04 && m.zcr <= 0.2 ? 1 : 0)
        + 0.1 * (m.short || m.med ? 1 : 0);
      if (m.invisible) s = 0;
      else if (m.dark) s *= 0.3;
      // A clap is a very short noise burst: a long-decay hit (open hat, crash)
      // should not accumulate clap evidence.
      else if (m.decayLong) s *= 0.5;
      return s;
    }
    case "hihat": {
      // Closed hi-hat: bright, very short, high crest, noisy, high zcr.
      let s =
        0.25 * (m.brightB ? 1 : 0)
        + 0.15 * (m.veryShort ? 1 : m.short ? 0.7 : 0.2)
        + 0.15 * (m.crestHigh ? 1 : 0)
        + 0.15 * (m.zcr > 0.08 ? 1 : 0)
        + 0.15 * (m.noisy ? 1 : 0)
        + 0.1 * (m.fast ? 1 : 0)
        + 0.05 * (m.decayShort ? 1 : 0)
        // STEP45 (§10): transientStrength es 2.25 — closed hats Q1 5.2 vs open
        // hats Q3 ≈2.0. Rewards the punchy closed-hat transient.
        + 0.1 * (m.tsStrong ? 1 : 0);
      if (m.invisible) s = 0;
      else if (!m.brightB) s *= 0.4;
      // A ringing bright noise (decay >0.12s, e.g. open hat / crash) is not a
      // closed hat; opens the "openhat→hihat" confusion (STEP44.1: 9 rows).
      else if (m.decayLong) s *= 0.5;
      return s;
    }
    case "openhat": {
      let s =
        0.25 * (m.brightB ? 1 : 0)
        + 0.15 * (m.noisy ? 1 : 0)
        + 0.25 * (m.decayLong ? 1 : m.dec2 > 0 ? 0 : m.med || (m.dur > 0.35 && m.dur <= 1.2) ? 0.8 : 0)
        + 0.1 * (m.dur > 0.35 && m.dur <= 1.2 ? 1 : 0)
        + 0.1 * (m.zcr > 0.06 ? 1 : 0)
        + 0.1 * (m.crestHigh ? 1 : 0)
        + 0.05 * (m.transient ? 1 : 0)
        // STEP45 (§10): open hats have a soft attack (transient Q1 1.4 / Q3
        // 2.0) versus the closed-hat transient (Q1 5.2). A soft onset favours
        // open hat; es 2.25.
        + 0.1 * (!m.tsStrong ? 1 : 0);
      if (m.invisible) s = 0;
      else if (!m.brightB) s *= 0.4;
      return s;
    }
    case "tom": {
      let s =
        0.3 * (m.darkMid ? 1 : m.midB ? 0.5 : 0)
        + 0.2 * (m.tonal ? 1 : 0)
        + 0.2 * (m.transient ? 1 : 0)
        + 0.15 * (m.med ? 1 : m.short ? 0.5 : 0)
        + 0.1 * (m.zcr > 0.02 && m.zcr < 0.08 ? 1 : 0)
        + 0.05 * (m.fast ? 1 : 0);
      if (m.invisible) s = 0;
      else if (m.dark) s *= 0.5;
      else if (m.brightB) s *= 0.3;
      else if (m.veryShort) s *= 0.5;
      return s;
    }
    case "cymbal": {
      let s =
        0.3 * (m.brightB ? 1 : 0)
        + 0.25 * (m.noisy ? 1 : 0)
        // Cymbals ring out: a genuinely long (>1.2s) decaying noise. An open
        // hat shares brightness and noise but not the sustained ring.
        + 0.2 * (m.dur > 1.2 ? 1 : 0)
        + 0.15 * (m.bw >= 3500 ? 1 : 0)
        + 0.1 * (m.zcr > 0.08 ? 1 : 0);
      if (m.invisible) s = 0;
      else if (!m.brightB) s *= 0.4;
      return s;
    }
    case "percussion":
    default:
      // §14 residue bucket — STEP45 (§11): the legacy FIXED 0.25 beat every
      // specific drum class whose own anchors fired but whose cap or missing
      // term kept it at ≤0.25 (STEP44.1: snare 0/50, hihat/openhat overuse).
      // Measured percussion = bright-ish (median centroid 3.6k, → +mid/bright),
      // short (median 0.26s), HIGHEST transient (median 6.6 vs snare 4.0) and
      // crest (median 10.7), low-mid zcr (0.089). The residue stays a LOW base
      // (0.12) that a specific class with its OWN fully-fired anchors can beat,
      // but a generic short bright transient hit that trips the percussion
      // profile now accumulates real evidence instead of a flat 0.25.
      let s = 0.12
        + 0.12 * (m.brightB || m.midB ? 1 : 0) // measured: bright/mid
        + 0.08 * (m.veryShort || m.short ? 1 : 0) // measured: median 0.26s
        + 0.12 * (m.transient ? 1 : 0) // measured: transient median 6.6 (highest drum)
        + 0.1 * (m.crestHigh ? 1 : 0) // measured: crest median 10.7
        + 0.06 * (m.zcr <= 0.25 ? 1 : 0); // measured: zcr median 0.089
      if (m.invisible) s = 0;
      return s;
  }
}

// ---- musical -----------------------------------------------------------------

interface MusM {
  dur: number;
  centroid: number;
  zcr: number;
  flat: number;
  dark: boolean;
  darkMid: boolean;
  midB: boolean;
  brightB: boolean;
  inv: boolean;
  transient: boolean;
  hasPitchLow: boolean;
  hasPitch: boolean;
  hasHarmonic: boolean;
  tonal: boolean;
  sustained: boolean;
  veryShort: boolean;
  atk2: number;
  hasSlowAttack: boolean;
}

function musicalMetrics(input: TypeInput): MusM {
  const { features: f, v2 } = input;
  const dur = input.durationSeconds;
  const pitchHz = nan(v2?.pitchHz);
  const pitchConf = nan(v2?.pitchConfidence);
  const harmonic = nan(v2?.harmonicity);
  const hasPitch = Number.isFinite(pitchHz) && Number.isFinite(pitchConf) && pitchConf >= 0.35;
  const hasPitchLow = hasPitch && pitchHz < 250;
  const hasHarmonic = Number.isFinite(harmonic) && harmonic >= 0.55;
  const centroid =
    nan(v2?.spectralCentroidHz) || f.spectralCentroid;
  const flat =
    nan(v2?.spectralFlatness) || f.spectralFlatness;
  const zcr =
    typeof v2?.zeroCrossingRate === "number" ? v2.zeroCrossingRate : f.zeroCrossingRate;
  const atk2 = nan(v2?.attackTimeSec);
  const tonal = flat < 0.35;
  const inv = Math.abs(centroid) < 1e-9 && flat >= 0.999;
  return {
    dur, centroid, zcr, flat, dark: centroid < 250,
    darkMid: centroid >= 250 && centroid < 900, midB: centroid >= 900 && centroid <= 3200,
    brightB: centroid > 3200, inv, transient: f.transientDensity > 5 || f.attack < 0.02,
    hasPitchLow, hasPitch, hasHarmonic, tonal,
    sustained: dur > 1.5, veryShort: dur <= 0.5,
    atk2, hasSlowAttack: Number.isFinite(atk2) && atk2 >= 1.5,
  };
}

function musicalScore(classId: ClassId, input: TypeInput): number {
  const m = musicalMetrics(input);
  switch (classId) {
    case "bass": {
      let s =
        0.35 * (m.dark ? 1 : 0)
        + 0.3 * (m.hasPitchLow ? 1 : !m.hasPitch && m.dark ? 0.4 : 0)
        + 0.2 * (m.tonal ? 1 : 0)
        + 0.15 * (m.dur > 1.0 ? 1 : 0);
      if (m.inv) s = 0;
      else if (!m.dark) s *= 0.4; // bass lives in the sub/low band
      return s;
    }
    case "piano": {
      let s =
        0.3 * (m.tonal ? 1 : 0)
        + 0.25 * (m.transient ? 1 : 0) // hammer onset
        + 0.25 * (m.dur > 0.5 && m.dur <= 3.5 ? 1 : 0)
        + 0.2 * (m.midB || m.darkMid ? 1 : 0);
      if (m.inv) s = 0;
      else if (m.dur > 2.5) s *= 0.6;
      else if (m.brightB) s *= 0.5;
      return s;
    }
    case "guitar": {
      let s =
        0.3 * (m.midB || m.darkMid ? 1 : 0)
        + 0.25 * (m.tonal ? 1 : 0)
        + 0.2 * (m.transient ? 1 : 0) // pluck
        + 0.25 * (m.dur > 0.5 && m.dur <= 2.0 ? 1 : 0);
      if (m.inv) s = 0;
      else if (m.brightB) s *= 0.5;
      else if (m.dur > 3) s *= 0.6;
      return s;
    }
    case "strings": {
      let s =
        0.3 * (m.tonal ? 1 : 0)
        + 0.3 * (m.sustained ? 1 : 0)
        + 0.2 * (!m.transient ? 1 : 0)
        + 0.2 * (m.midB ? 1 : 0);
      if (m.inv) s = 0;
      else if (m.transient) s *= 0.6;
      else if (m.veryShort) s *= 0.4;
      return s;
    }
    case "keys": {
      // STEP45 (§14): measured keys (organ/swells) have a slow median attack
      // 3.1s (Q1 0.02 / med 3.1 / Q3 5.3s) vs pianos' bite (median 0.10s). A slow
      // approach enforces keys against piano; pitched-free electric keys stay
      // honest (no pitch term).
      let s =
        0.25 * (m.tonal ? 1 : 0)
        + 0.25 * (m.sustained ? 1 : 0)
        + 0.25 * (m.midB || m.darkMid ? 1 : 0)
        + 0.25 * (m.dur >= 0.5 && m.dur < 2.5 ? 1 : 0)
        + 0.15 * (m.hasSlowAttack ? 1 : 0);
      if (m.inv) s = 0;
      else if (m.brightB) s *= 0.5;
      return s;
    }
    case "synth": {
      let s =
        0.4 * (m.tonal || m.hasHarmonic ? 1 : 0)
        + 0.3 * (m.sustained ? 1 : 0)
        + 0.3 * (m.midB ? 1 : 0);
      if (m.inv) s = 0;
      else if (m.veryShort) s *= 0.4;
      return s;
    }
    case "pad": {
      let s =
        0.4 * (m.sustained ? 1 : 0)
        + 0.3 * (m.tonal ? 1 : 0)
        + 0.2 * (!m.transient ? 1 : 0)
        + 0.1 * (m.darkMid ? 1 : 0);
      if (m.inv) s = 0;
      else if (m.transient) s *= 0.5;
      else if (m.veryShort) s *= 0.3;
      return s;
    }
    case "lead": {
      let s =
        0.3 * (m.tonal || m.hasHarmonic ? 1 : 0)
        + 0.3 * (m.sustained ? 1 : 0)
        + 0.25 * (m.hasPitch ? 1 : 0)
        + 0.15 * (m.brightB ? 1 : 0);
      if (m.inv) s = 0;
      else if (!m.tonal && !m.hasHarmonic && !m.hasPitch) s *= 0.4;
      else if (m.veryShort) s *= 0.4;
      return s;
    }
    default:
      return 0;
  }
}

// ---- atmosphere / noise ----------------------------------------------------

function classifyAtmosphere(input: TypeInput): TypeScoring {
  const { features: f, v2 } = input;
  const dur = input.durationSeconds;
  const hasPitch =
    nan(v2?.pitchHz) > 0 && nan(v2?.pitchConfidence) >= 0.35;
  const hasHarmonic = nan(v2?.harmonicity) >= 0.55;
  const flat =
    nan(v2?.spectralFlatness) || f.spectralFlatness;
  const bw =
    nan(v2?.spectralSpreadHz) || f.spectralBandwidth;
  const sustained = dur > 1.5;
  const noise = 0.2
    + 0.35 * (flat >= 0.6 ? 1 : 0)
    + 0.2 * (bw > 2500 ? 1 : 0)
    + 0.25 * (!hasPitch && !hasHarmonic ? 1 : 0);
  const atmosphere = 0.15
    + 0.3 * (sustained ? 1 : 0)
    + 0.25 * (flat >= 0.45 && flat <= 0.75 ? 1 : 0)
    + 0.2 * (!hasPitch && !hasHarmonic ? 1 : 0);
  const scores: Record<ClassId, number> = { atmosphere, noise };
  return decideWithin(scores, ["atmosphere", "noise"], input);
}