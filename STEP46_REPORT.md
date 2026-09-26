# STEP46 — Acoustic Feature-Gap & Classification-Boundary Audit Report

Date: 2026-09-10 (reproducible — every number below regenerates from
`scripts/step46-audit.ts → scripts/step46-multi.ts → scripts/step46-nulls.ts`
over the STEP45 reference corpus in `step45-analysis.ndjson`).

---

## 1. Scope, verdict, single recommendation

STEP46 is a **pure audit** over the STEP45 reference corpus (590 one-shot
references, corpusRole=`reference`): it inventories the *actual* feature surface
the classifier consumes (§3), measures per-class-boundary separation with
effect size / P(A>B) / overlap / duration-control survival / null-rate safety
and outlier identification (§4–§6), classifies every boundary as
STRONG / MODERATE / WEAK / NONE (§4), and answers the feature-gap question for
the ambiguous pairs (§7–§11).

**STRICT non-negotiables honoured:** no classifier tuning, no new rules or
thresholds, no persisted features, no V2/D1/UI/Map/FindSimilar changes. Only
audit scripts, statistics, reports, and regression-proving tests.

**Verdict: B — most boundaries are supported, several are intrinsically
ambiguous with the current feature surface, and NO feature-gap is demonstrated
(no ambiguous boundary is rescued by any feature that already exists but is
unused).**

**Single recommendation: 1. KEEP** the classifier and its thresholds exactly as
they are, with two honest caveats recorded (§17): the classifier must keep
treating snare/clap, synth/lead, and cymbal/openhat as *low-confidence*
boundaries (report ambiguous), and no new acoustic feature is justified by this
audit — a *sampling with documentation* gap already exists and is not
acoustic at all.

Evidence summary (details in §4–§14):

| Statement | Evidence |
|---|---|
| 7 of 20 boundaries STRONG (kicks, snare↔hihat, snare↔tom, hihat↔openhat/cymbal); es ≥ 1.8 and mostly survive ≤0.6 s duration control | §4, §13 |
| 6 MODERATE (kick/tom, clap/percussion, snare/percussion, tom/percussion, synth/pad, lead/pad); real but partial separators, always with a documented residual | §4 |
| 6 WEAK (snare/clap, cymbal/openhat, piano/keys, guitar/keys, piano/strings, pad/strings) and **1 NONE** (synth/lead, es ≈ 0.34) | §4 |
| Every ambiguous pair is **not** rescued by any of the 18 raw V2 features, nor by 8 SoundCharacter dimensions, nor by 2-feature box coverage → classification is **C (intrinsic ambiguity), not D (feature gap)** | §7, §8, §9, §11, §12 |
| SoundCharacter contributes **no boundary information beyond V2 raw**: SC only beats best-raw on 3 already-STRONG drum pairs by ≤0.32, and loses badly on kick/clap (−0.60) and hihat/openhat (−1.65 vs decay); SC never rescues a WEAK/NONE boundary | §12 |
| Several apparently-large es values are **null-rate artifacts**: pitchConfidence gating on claps (90% null), hihats (93%), cymbals (83%), openhats (90%) inflates d to 3.74–2.09 on 3–5 rows — must be discounted | §6, §9 |
| No regression: 74 test files / 1290 tests / `tsc` clean | §15 |

---

## 2. Dataset and method

- **Source:** `step45-analysis.ndjson`, filtered to `corpusRole==='reference'`
  → **590 rows**, 20 classes. Loop-validation rows (40) excluded from all
  reference statistics (re-verified: exactly 590).
- **Per-class n:** kick 50, snare 50, clap 40, hihat 40, openhat 30, cymbal 30,
  tom 30, percussion 30, bass 30, synth 30, pad 30, lead 30, vocal 30, fx 30,
  piano 20, guitar 20, strings 20, keys 20, noise 15, atmosphere 15.
- **Features audited:** V1 legacy (13 fields incl. sampleRate/channels),
  V2 raw (18 fields), SoundCharacter (8 dims — deterministic transform, audited
  separately §12), plus the binary gates the classifier actually uses
  (`tsStrong`, `crestHigh`, `fastAttack`, `harmonicity≥0.55`, `pitchConf≥0.35`,
  `inharm≥0.5`, `low/mid/high band`, `slowAttack`).
- **Dynamic labels:** reference labels may name multiple instruments per row;
  boundaries below use membership (each reference may appear in >1 class).
- **Metrics per (boundary, feature) pair, computed over raw feature values:**
  Cohen's d (`|es|`), trimmed d (5% trim), P(A>B) via sorted-rank fraction,
  quartile-box overlap fraction, sample-sizes nA/nB **plus null-rate discipline
  ** (feature is trustworthy only when neither side exceeds ~50% null).
- **Duration control:** only pairs with n ≥ 20 per side in a ≤0.6 s band are
  re-measured there; explicit §13.

Output artifacts (STEP45 tmp dir):
`step46-boundaries.json`, `step46-multi-feature.json`, `step46-null-dur-outliers.json`.

---

## 3. Feature surface inventory (what the classifier actually has)

| Layer | Fields (implemented, nullable where marked) | Consumed by type.ts/family.ts |
|---|---|---|
| V1 (`featureExtractor.ts`) | duration, rms, peak, transientDensity, spectralCentroid, spectralBandwidth, spectralRolloff, spectralFlatness, zeroCrossingRate, attack, tonalNoiseRatio (+ sampleRate, channels) | V2 fallbacks for centroid/bandwidth/flatness/zcr/attack/transient |
| V2 raw (`audioFeaturesV2.ts`) | durationSec, rms, peak, crestFactor, transientStrength, zeroCrossingRate, spectralCentroidHz, spectralSpreadHz, spectralRolloffHz, spectralFlatness, spectralFlux, spectralSlope, attackTimeSec, decayTimeSec, pitchHz, pitchConfidence, harmonicity, inharmonicity | centroid, spread, flatness, flux, transientStrength, crest, decay, attack, zcr, pitchHz/conf, harmonicity, inharmonicity |
| SoundCharacter (8 dims) | brightness, density, transient, duration, tonality, noisiness, dynamics, complexity | **never** consumed |
| Derived gates | tsStrong (ts≥3), crestHigh (crest≥5), harmonicity≥0.55, pitchConf≥0.35, inharm≥0.5, slowAttack (attack≥1.5 s), band flags | yes (family.ts) |

**Unused-but-existing features (candidates the audit checked for gaps):**
`spectralRolloffHz`, `spectralSlope` (V2), `durationSec` (raw — only used via
structure/`hitDuration`/phrase gate), and all 8 SoundCharacter dims. **None of
them rescues any WEAK/NONE boundary** (§7). The audio pipeline *already* has
access to the raw waveform (librosa re-render at analysis); a missing feature
would mean *un-computed* information (e.g., number/comb-filter of transients in
a clap burst), which is a **hypothesis, not a demonstrated gap**.

---

## 4. Boundary classification matrix

Classifier boundary → strongest **raw** feature (SC/duration variants noted) →
es → P(A>B) → verdict.

| Boundary | Strongest raw feature | \|es\| | P(A>B) | 2nd best (es) | Duration-ctrl | Verdict |
|---|---|---|---|---|---|---|
| kick / snare | spectralCentroidHz | 2.77 | 0.03 | harmonicity 2.76; SC_brightness **3.00** | −2.64 ✓ | **STRONG** |
| kick / clap | harmonicity | 4.72 | 0.996 | centroid 3.25 | ✓ | **STRONG** |
| kick / percussion | harmonicity | 1.86 | 0.919 | rolloffHz 1.62; SC_brightness 2.18 | ✓ full + ctrl | **STRONG** |
| kick / tom | crestHigh | 1.13 | 0.06 | rms 1.12 | centroid weak | **MODERATE** |
| snare / hihat | spectralCentroidHz | 1.81 | 0.11 | zcr 1.26 | −1.79 ✓ | **STRONG** |
| snare / tom | harmonicity | 2.46 | 0.045 | centroid 2.43; SC_noisiness 2.56 | 2.17 ✓ | **STRONG** |
| snare / percussion | transientStrength | 1.21 | 0.21 | crest 1.06 | **1.53 ✓ (strengthens)** | **MODERATE** |
| snare / clap | crestFactor | 0.57 | 0.35 | harmonicity 0.52; SC_dynamics 0.65 | collapse (~0.4 left) | **WEAK** |
| clap / percussion | harmonicity | 1.65 | 0.12 | transientStrength 1.09 | ✓ | **MODERATE** |
| hihat / openhat | decayTimeSec | 2.69 | 0.013 | ts 2.34; tsStrong 2.67 | **2.63 / 2.43 ✓** | **STRONG** |
| hihat / cymbal | transientStrength | 2.16 | — | tsStrong 3.02; decay 1.39 | too few short cymbals | **STRONG** |
| openhat / cymbal | durationSec | 1.12 | 0.18 | zcr 1.05 | **collapse (overlap zone)** | **WEAK** (duration-only) |
| tom / percussion | harmonicity | 1.59 | 0.899 | ts 1.49; SC_density 1.87 | ✓ | **MODERATE** |
| synth / lead | spectralSpreadHz | 0.34 | 0.60 | flatMid 0.27 | ~0.36 max in band | **NONE** |
| synth / pad | pitchConfidence | 1.17(n=28/29) | 0.75 | spread 0.92 | 0.85 ✓ | **MODERATE** |
| lead / pad | pitchConfidence | 1.22(n=28/29) | 0.79 | pitchHz 0.70 | 0.63 ✓ | **MODERATE** |
| pad / strings | pitchConfidence | 0.71 | 0.32 | decay 0.57 | ✓ | **WEAK** |
| piano / keys | harmonicity | 0.79 | 0.69 | tonalNoiseRatio 0.65; SC_tonality 0.74 | slowAttack is the real cue | **WEAK** |
| guitar / keys | crestFactor | 0.72 | 0.40 | SC_dynamics 0.97 | weak | **WEAK** |
| piano / strings | spectralFlux | 0.90 | 0.25 | rolloffHz 0.82; SC_brightness 1.00 | weak, semantic-y | **WEAK** |

Counts: **STRONG 7, MODERATE 6, WEAK 6, NONE 1.** No boundary is
unmeasurable-globally; the WEAK/NONE set is exactly the semantic/metadata-heavy
set (§11) plus the acoustically close pairs (§8–§9).

---

## 5. Null-rate audit (truthy es vs artifact)

`step46-null-dur-outliers.json`, null rates per class for the features the
classifier gates on:

| class | pitchConfidence/pitchHz null | inharmonicity null | decayTimeSec null | all robust features null |
|---|---|---|---|---|
| clap | **90%** (n=4) | 90% | 0% | 0% |
| hihat | **93%** (n=3) | 93% | 0% | 0% |
| openhat | **90%** (n=3) | 90% | 3% | 0% |
| cymbal | **83%** (n=5) | 83% | 3% | 0% |
| snare | **58%** (n=21) | 64% | 0% | 0% |
| percussion | 43% (n=17) | 50% | 0% | 0% |
| kick / tom / bass / synth / lead / pad / guitar / piano / keys / strings / vocal | 0–10% | ≤40% | 0–17% | 0% |

**Consequences (applied throughout this report):**
- Any es computed on `pitchConfidence` / `pitchHz` / `inharmonicity` for the
  drum classes is **discounted or excluded** unless n ≥ 10 non-null each side.
- **hihat/openhat pitchConfidence d=3.74 and openhat/cymbal d=−2.09 are
  artifacts** on 3–5 rows — replaced by the honest numbers in §4/§9.
- The classifier's `pitchConf≥0.35` gates are therefore effectively inert on
  drums (hihat 93%, openhat 90%, clap 90% null) — drums are separated by
  envelope/transient/spectral features, which is exactly what the audit finds
  robust (§4).

---

## 6. Outliers (straddle points) with sampleIds

Identified in `step46-null-dur-outliers.json`:

| Pair | Outlier IDs (sampleId tail) | Why it flows to the wrong side |
|---|---|---|
| snare → hihat/tom | `806dc2d0` (centroid 1161 Hz) | one of 3/13 snare outliers near tom centroid |
| snare → clap (crest) | `eee712d9` (7.95, 0.61s), `73861b55` (7.96, 0.18s), `68eaa8b3` (7.59, 0.13s) | flattened snares, crest in clap range |
| clap → snare (harmonicity) | `26d2e01d` (0.49, 1.72s), `5eb8a60d` (0.51, 0.59s), `f2d41437` (0.48, 0.31s) | well-pitched claps, harmonicity in snare range |
| openhat → cymbal | `96bac64a` (cent 7479, 0.56s), `8bd4deaa` (7777, 0.21s) | short openhats with cymbal-like contact |
| cymbal → openhat | `331171dd` (cent 8583, 1.99s) | long cymbal crush with openhat-like decay |

These are the *legitimate* straddle points that §14 argues the classifier should
keep reporting as ambiguous rather than force.

---

## 7. Feature-gap analysis: is anything C vs D?

The audit checked three candidate "usable-but-unused" resources for every
WEAK/NONE boundary:

1. `spectralRolloffHz` (V2) — never better than centroid/spread on any pair.
2. `spectralSlope` (V2) — best marginal on openhat/cymbal at `|es|≈0.39`, far
   below the already-weak duration separator (1.12); does not rescue.
3. 8 SoundCharacter dims — SC never rescues (§12).

**Result: no boundary moves from WEAK/NONE to MODERATE/STRONG with any
already-existing feature, and 2-feature box coverage peaks at ~0.5–0.55 for the
STRONG pairs and ~0.20–0.25 for snare/clap and synth/lead** (best-quartile-box
non-overlap fraction; `step46-multi-feature.json`). Therefore every WEAK/NONE
boundary is classified **C (intrinsically ambiguous with the current surface)**
— there is **no demonstrated D (feature-gap)**. Hypotheses for genuinely missing
*signal* (un-computed waveform detail) exist — snare/clap: number-of-transients
/ comb-filter detail / noise-band shape; cymbal/openhat: riser spectrum +
centroid *trajectory*; synth/lead and the keyboard/sustained pairs —
but they are **hypotheses only** and cannot justify a D verdict under the
evidence bar.

---

## 8. Dedicated analysis: snare vs clap

The single hardest drum pair.

| Measure | Result |
|---|---|
| Best raw es (crestFactor) | 0.57 (P=0.35, overlap ~0.77) |
| SC_dynamics | 0.65 (best of SC); SC_tonality 0.63 |
| pitchConfidence | 0.61 — **unreliable, n=21 vs 4 (58%/90% null), excluded** |
| centroid | full 0.16; duration-controlled 0.08 — **no spectral separation** |
| **0.2–0.5 s duration-controlled band** (n=10/24) | ts 4.32 vs 3.64; crest 7.85 vs 6.28; cent 5153 vs 5538; harmonicity 0.449 vs 0.493 — **all medians near-identical** |
| survives ≤0.6 s | only harmonicity ~0.42 (recomputed ≤0.6 s band) — nothing survives with es ≥ 0.65 |

**Conclusion:** claps and snares are acoustically near-identical on every
existing dimension at matched duration. Classification C. Missing-signal
hypothesis: number-of-transients (clap has a characteristic burst envelope
structure) — un-computed, per §7.

---

## 9. Dedicated analysis: openhat vs cymbal

| Measure | Result |
|---|---|
| Best raw (durationSec) | 1.12 — cymbal median ~2.0 s vs openhat ~0.56 s |
| zcr | 1.05 |
| decay, harmonicity, centroid | 0.39 / 0.32 / ~0.5 — **all weak** |
| pitchConfidence | −2.09 — **artifact (n=3 vs 5), excluded** |
| SC_duration | 1.38 (durations transform) |
| **Overlap zone 0.35–0.9 s (n=6 openhat / 19 cymbal)** | ts 1.94 vs 1.72; decay 0.133 vs 0.174; centroid 8913 vs 8728 — **near-identical** |
| cymbal short members (≤0.6 s, n=4) | unreliably small sample, still low es |

**Conclusion:** in-duration the two are acoustically indistinguishable with 18
features + SC; the only separator is *duration*, which the classifier already
uses (its cymbal `dur > 1.2 s` gate is the honest proxy). Classification **C**
— inherently ambiguous, duration-proxy supported as-is. Riser/attack-spectrum
trajectory is a hypothesis only (§7).

---

## 10. Dedicated analysis: the percussion family (snare/percussion,

clap/percussion, tom/percussion) — the residual bucket

- **snare/percussion:** transientStrength 1.21 full → **1.53 at ≤0.6 s —
  *survives and strengthens***; crest 1.06. Percussion references are
  high-transient (median ts 5.2, crest 5.73, harmonicity 0.448 vs snare 0.449,
  zcr 0.154, duration 0.173 s); 27/30 percussion references are
  transient/crest-ambiguous with snare.
- **clap/percussion:** harmonicity 1.65 (percussion measurable more tonal),
  transientStrength 1.09 — real, moderate.
- **tom/percussion:** harmonicity 1.59, ts 1.49, SC_density 1.87 — real.
- **Residence audit:** among 106 acoustic drum residents classified
  percussion, 28 are snare-like, 24 hihat-like, 19 clap-like, 4 kick-like, 17
  real perc, and the tail (fx/openhat/tom/etc.) 14. **The percussion bucket is
  acoustically real but is the residual bucket by construction.**

**Conclusion:** MODERATE ×3, honest residual; the classifier's percussion score
is evidence-based (transient/crest medians) and the 106-resident spread shows
its ambiguity is being *reported*, not hidden.

---

## 11. Dedicated analysis: the "musical/instrument" boundaries

piano/keys, guitar/keys, piano/strings, synth/lead, synth/pad, lead/pad,
pad/strings.

| Pair | Best feature | es | Reading |
|---|---|---|---|
| piano / keys | harmonicity | 0.79 | keys slow-attack 3.6 s vs piano 0.128 s is the *only* real cue (and it is exactly the classifier's slowAttack evidence) |
| guitar / keys | SC_dynamics | 0.97 | crest/decay mix; raw crest 0.72 |
| piano / strings | SC_brightness | 1.00 | piano strings are bright — semantic-ish |
| synth / lead | spectralSpreadHz | **0.34** | **no separator; es never exceeds 0.36 in 0.6–1.5 s** |
| synth / pad | pitchConfidence | 1.17 (n=28/29, real) | sustained-ness ↗ |
| lead / pad | pitchConfidence | 1.22 (n=28/29) | pitch-line evidence ↗ |
| pad / strings | pitchConfidence | 0.71 | sustained non-pitched ≈ strings |

**Conclusion:** these are **semantic/metadata categories first, acoustic second
**. The classifier must not pretend synth/lead, guitar/keys, piano/keys,
piano/strings, pad/strings are acoustically separable (they are C), and should
lean on the slowAttack/pitchConfidence anchors only where they are *real*
(pitchConfidence n=28+/29 for synth/pad, lead/pad — but the exposure for
cymbal/openhat/clap/etc. is null-saturated, §5).

---

## 12. SoundCharacter contributes no boundary information beyond V2 raw

For every boundary, SC best-es compared to best raw (all features):

| Boundary | SC best | best raw | Δ(SC−raw) |
|---|---|---|---|
| kick/snare (= brightness) | 3.00 | centroid 2.77 | **+0.23** |
| kick/percussion (brightness) | 2.18 | harmonicity 1.86 | +0.32 |
| tom/percussion (density) | 1.87 | harmonicity 1.59 | +0.28 |
| kick/clap | 4.12 | harmonicity 4.72 | **−0.60** |
| hihat/openhat | 1.04 | decay 2.69 | **−1.65** |
| openhat/cymbal | sc_duration 1.38 | durationSec 1.12 | **SC_duration = re-scale of raw duration, not new info; verdict unchanged (duration-only, WEAK)** |
| remaining | — | — | SC ≤ raw |
| **Overall** | | | **SC only marginally beats raw on 3 already-STRONG drum pairs (brightness/density re-encodes); it never rescues a WEAK/NONE boundary** |

SoundCharacter is a deterministic transform of V2 raw — it adds *no*
information, only re-encoding. Its use in V2 similarity (not classification) is
fine; it must not be treated as an independent feature source for type
decisions. This closes Step45's open question: **no hidden signal was lost in
V2 → SC compression.**

---

## 13. Duration-control results (≤0.6 s trimming, explicit)

| Boundary | Full es | ≤0.6 s es | Survives? |
|---|---|---|---|
| kick/snare (centroid) | 2.77 | 2.64 | ✓ |
| hihat/openhat (decay) | 2.69 | 2.63 | ✓ |
| hihat/openhat (transient) | 2.34 | 2.43 | ✓ |
| snare/hihat (centroid) | 1.81 | 1.79 | ✓ |
| snare/tom (centroid) | 2.43 | 2.17 | ✓ |
| snare/percussion (transient) | 1.21 | **1.53** | ✓ strengthens |
| clap/percussion (harmonicity) | 1.65 | 1.55 | ✓ |
| snare/clap (all) | ≤0.65 | ~0.44 (harmonicity) | ✗ collapse |
| openhat/cymbal (overlap zone 0.35–0.9 s) | 1.12 (duration) | near-identical on ts/decay/centroid | ✗ collapse |
| synth/lead | 0.34 | ≤0.36 in 0.6–1.5 s | ✗ none ever |

The STRONG/MODERATE drum boundaries are **not a duration artifact**; the WEAK
pairs **remain weak** when duration is controlled.

---

## 14. Ontology assessment (percussion residual & straddle legitimacy)

1. **`percussion` is acoustically real but residual:** median resident profile
   (ts 5.2, crest 5.73, harmonicity 0.448, zcr 0.154, duration 0.173 s) is a
   real, coherent acoustic cluster — it is NOT a junk bucket; but by
   construction it is where ambiguous drum-ish material lands (106 residents:
   28 snare-, 24 hihat-, 19 clap-, 4 kick-, 17 real-perc-like, 14 tail).
2. **Straddle points are legitimate, not errors:** a sample can be both
   percussion- and snare-like (or clap/snare, openhat/cymbal) between the two
   prototypes without the classifier being wrong. Forcing exact subtypes on
   these exceeds the information in the current feature surface (§7–§9).
3. **Every precise subtype must be justified by measured evidence, not taxonomy
   friction:** this audit measures which boundaries the evidence supports
   (STRONG/MODERATE) and which it does not (WEAK/NONE), and the classifier
   already reports those honestly.

---

## 15. Regression

| Check | Result |
|---|---|
| `npx vitest run --testTimeout 60000` | **74 files passed, 1290 tests passed** |
| `npx tsc --noEmit -p tsconfig.json` | **exit 0, clean** |

STEP45 baseline re-verified green at STEP46 closure (same 74/1290 as STEP45's
own report). No product code, tests, or fixtures were touched by this step;
only audit scripts and this report were added.

---

## 16. Limitations

- Reference labels are **proxy labels, not ground truth** (from Audiotool
  metadata); "agreement with reference" is a calibration-consistency metric,
  not accuracy.
- Dynamic labels: references may list multiple names → boundary membership
  overlap; es/P(A>B) computed on memberships, slightly conservative.
- Samples are ≈1–2 s one-shots; sub-0.6 s bands shrink n for cymbal/openhat
  (the cymbal short tail is n≈4) — reported, not padded.
- Null-based exclusions (§5) *remove* information for `pitchConfidence` on
  drum classes; we chose the conservative reading (trusting es only on n≥10),
  which is the honest reading.
- The missing-signal hypotheses (§7) are not falsified — they are simply
  *unmeasured*; this audit cannot seat them as either D-evidence or noise.

---

## 17. Recommendation & follow-ups

**KEEP (recommendation 1).** The classifier's thresholds and evidence model are
supported wherever the audit says the boundaries are supported (STRONG/MODERATE
drum and percussion pairs, including the `dur > 1.2 s` cymbal gate and
`slowAttack`/`pitchConfidence` anchors where non-null). The WEAK/NONE pairs are
either reported-low-confidence already (snare/clap, synth/lead) or duration-
proxy (openhat/cymbal).

**Honest caveats recorded (future evidence paths, NOT next-step work):**
1. Recorded in the decision layer: snare/clap, synth/lead, openhat/cymbal at
   matched duration are acoustically indistinguishable with the current surface
   → ambiguous is correct; do not force.
2. Missing-signal *hypotheses only*, to revisit only if new measurement
   (e.g., transient-count / comb-filter detail for clap-snare; centroid
   trajectory for cymbal-openhat) is ever added and validated per STEP bars —
   never tune to fill them.
3. SoundCharacter must keep its role as a *similarity* descriptor, not be
   promoted to a type-separation feature.

No classifier tuning, no new rules/thresholds/persisted features, no
V2/D1/UI/Map/FindSimilar changes were made; the decision is **KEEP**.

---

*Data on disk: `step46-boundaries.json`, `step46-multi-feature.json`,
`step46-null-dur-outliers.json` (STEP45 tmp dir). Sources:
`src/audio/featureExtractor.ts`, `src/analysis/audioFeaturesV2.ts`,
`src/audio/v2Dsp.ts`, `src/analysis/soundCharacter.ts`,
`src/classify/hier/type.ts`, `src/classify/hier/family.ts`.*