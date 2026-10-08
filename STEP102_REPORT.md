# STEP102 — Weight tuning closed with held-out validation: the feature set is the binding constraint

**Date:** 2026-10-08 · **Baseline commit:** `d56813f` (STEP101) · **Type:** measurement +
a durable overfitting guard. **No production behaviour changed** — every candidate was
rejected by its own validation.

**Verdict:** `tsc` clean · `vite build` ok · **90 files / 1601 tests**.

---

## 1. Starting point

After STEP101 the acoustic drum-type accuracy is **43/135 = 31.9 %** on the reliable
one-shot corpus. This step tested whether the remaining error is reachable by adjusting
**weights** — the last untested lever named by the objective (STEP99 tested thresholds,
STEP100 tested a weight change whose effect turned out to be circular).

## 2. The overfitting guard, now part of the harness

A single-term candidate can move a 135-sample total by a few samples on noise alone.
`scripts/step100-offline-eval.ts` therefore now also reports the accuracy of two
**deterministic halves** (hash parity of the sample id), and the rule applied here is:

> a candidate must improve **both** halves, not just the total.

Baseline: total **43/135 = 31.9 %** · half 0 **22/56 = 39.3 %** · half 1 **21/79 = 26.6 %**.

This guard is what rejected all three candidates below — each looked like a small win on
the total and turned out to be one-half noise.

## 3. What the remaining error actually is

**Acoustic prediction distribution (n = 135):** snare 38, clap 34, kick 17, hihat 8,
openhat 6, tom 6, lead 6, other 4, noise 3, guitar 3, vocal 2, piano 2, synth 2, bass 1,
atmosphere 1, pad 1, **cymbal 1, percussion 0**.

`clap` is the magnet (34 predictions for 12 true claps). But the misclassified kicks are
**objectively bright and wide**, not a boundary artefact:

| reliable one-shot group | n | centroid | flatness | zcr | bandwidth | duration |
|---|---|---|---|---|---|---|
| kick → `kick` (correct) | 16 | **134 Hz** | 0.004 | 0.003 | **617 Hz** | 0.20 s |
| kick → `clap` | 11 | **1973 Hz** | 0.087 | 0.012 | **3463 Hz** | 0.28 s |
| kick → `snare` | 9 | **1631 Hz** | 0.110 | 0.007 | **2844 Hz** | 0.52 s |
| kick → `tom` | 5 | 615 Hz | 0.033 | 0.006 | 2145 Hz | 0.47 s |

A sample like `Kick Amen` (centroid 3951 Hz, zcr 0.077, crest 5.50) or
`at needs more kicks "cymbal"` (1973 Hz) is acoustically a bright, wide, cracky hit. The
name and the tag both say `kick`; the acoustics genuinely do not. STEP99 already showed
that widening the kick's dark band to admit them costs more than it gains (rim shots,
toms and bright percussion come with it). **This cluster is label ambiguity, not a
fixable decision boundary.**

## 4. Candidates tested, all rejected

| # | candidate | motivation (measured) | total | half 0 | half 1 | verdict |
|---|---|---|---|---|---|---|
| 0 | baseline | — | 43/135 (31.9 %) | 22/56 (39.3 %) | 21/79 (26.6 %) | — |
| 1a | clap `noisy` → `flat > 0.20` | clap has the *highest* measured flatness (median 0.302 vs kick 0.064); `noisy` (`flat > 0.002`) is near-constant (STEP99) | 46 (+3) | — | — | swept, not robust |
| 1b | 1a **+** clap `(short‖med)` → `dur <= 0.30` | claps are the shortest class (median 0.21 s vs snare 0.45 s) | 46 (+3) | **+5.4 pp** | **0.0 pp** | **rejected** |
| 2 | percussion reachable on merit (ceiling 0.60 → 0.85) | `percussion` is **structurally unreachable**: max score 0.60 vs 1.0 for snare/clap/kick, so it is predicted **0 times** (before STEP101 it existed only as the §14 abstention) | 41 (−2) | **−3.6 pp** | **0.0 pp** | **rejected** |

Candidate 2 is the informative one: making the catch-all class winnable *removes* correct
predictions, because the samples users tag `percussion` (shakers, congas, rims) are
acoustically better served by `hihat`/`snare`. The tag is a catch-all; it is not a good
optimisation target.

## 5. Conclusion — the objective's calibration route is exhausted

Three routes have now been tested against real audio, each with its own verification:

| route | step | outcome |
|---|---|---|
| thresholds | STEP99 | candidate reverted — the 900 Hz kick bar is load-bearing |
| weights (single term) | STEP100 | reverted — zero acoustic effect, circular "gain" only |
| decision rule (type overwrite) | **STEP101** | **shipped: acoustic 19.3 % → 31.9 %, reconciled unchanged** |
| weights (coordinated, validated) | STEP102 | rejected — no candidate survives held-out validation |

> **The drum type classifier is at the ceiling of the current feature set.** No
> single-term threshold or weight change improves it on held-out data, and the residual
> errors are (a) label ambiguity on objectively bright/wide hits and (b) a catch-all tag
> that is not a target. The binding constraint is the **features**.

That is a genuine result, not a failure to try: it is the difference between "we could not
find a fix" and "we measured that this class of fix cannot work, and here is the evidence".

## 6. What would move it (outside this objective's scope)

A discriminative feature, not a weight. The two largest remaining clusters —
`kick → clap/snare` (20 of 52 kicks) and `snare → clap` (10 of 32) — need a cue that
separates a *body/pitch* hit from a *noise burst* independently of brightness and
bandwidth. Candidates: a low-band-to-total energy ratio, or the attack/decay envelope
shape (kick = fast attack + short decay + pitched body). Adding a feature means a V2
analysis version bump and re-analysis, i.e. a separate, larger step.

## 7. Delivered in this step

* `scripts/step100-offline-eval.ts` — acoustic-only confusion matrix **and** the
  deterministic-half robustness check, so no future candidate can be accepted on a
  one-half gain. This is the most valuable artefact of the step.
* No production change: `src/classify/hier/*` is byte-identical to `d56813f`.

## 8. Verification

| check | result |
|---|---|
| `tsc --noEmit` | clean |
| `npm run build` | ok |
| `vitest run` | 90 files / **1601 tests** pass |
| held-out validation | all three candidates rejected |

## 9. Traceability

* Tooling: `scripts/step100-offline-eval.ts` (split check added),
  `scripts/step99-calibration-analysis.ts`, `scripts/step98-drum-corpus.ts`.
* Sources: `src/classify/hier/type.ts` (`drumScore` — kick/snare/clap/cymbal/percussion
  terms and their measured ceilings, `decideWithin`).
* Prior art: `STEP99_REPORT.md`, `STEP100_REPORT.md` (circularity),
  `STEP101_REPORT.md` (the shipped improvement).
