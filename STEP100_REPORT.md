# STEP100 — Offline A/B harness, and the discovery that the drum accuracy metric was circular

**Date:** 2026-10-08 · **Baseline commit:** `41c45a8` (STEP99) · **Type:** measurement
infrastructure + methodological correction + one REVERTED weight candidate.

**Verdict:** the candidate weight change was reverted (0 acoustic effect). The durable
result is a fast A/B harness and a corrected baseline that re-aims the whole objective.
`tsc` clean · `vite build` ok · **90 files / 1601 tests**.

---

## 1. Why this step

STEP99 tested threshold re-anchoring and the A/B rejected it. The remaining lever named
by the objective was **weights**. Testing weights needed many iterations, and each
full corpus run costs ~10 minutes of audio download and analysis — so the first task
was to make iteration cheap.

## 2. Delivered infrastructure

1. **Full-feature corpus capture** (`scripts/step98-drum-corpus.ts`, additive): each row
   now also carries the complete `AudioFeatures` and `AudioFeaturesV2` of the analysed
   sample. Feature capture failed for none of the 383 rows.
2. **`scripts/step100-offline-eval.ts`** — re-runs `classifyHier` over the stored
   features of the identical real-audio corpus. ~1 second per candidate instead of
   ~10 minutes. Validated: it reproduces the STEP99 baseline **exactly** — 112/135,
   identical confusion matrix.

Every candidate below was found and rejected in seconds; only a winner would be
confirmed by one full corpus run.

## 3. The methodological correction (the important result)

The harness now prints two numbers. They are not the same thing:

| metric | measurement | what it means |
|---|---|---|
| **RECONCILED** (audio + name + tag) | **112 / 135 = 83.0 %** | what the shipped classifier outputs |
| **ACOUSTIC-ONLY** (all metadata stripped) | **26 / 135 = 19.3 %** | what the recognition algorithm itself achieves |

**The reconciled number is circular.** Its ground truth — "name and tag independently
agree on a drum type" — is derived from the *same* name/tag text the classifier
consumes as evidence. Any change that increases metadata adoption therefore scores
better on it *whether or not the audio improved*. Only the acoustic-only number is
evidence about the recognition algorithm.

Restricted to the rows where the acoustic path does commit to the drums family
(110 of 135; the other 25 are `unknown` 4 / non-drum 21):

> **Acoustic drum-TYPE accuracy: 26 / 110 = 23.6 %.**

Per label (acoustic-only, against the reconciled result for contrast):

| label | acoustic-only | reconciled | acoustic mass goes to |
|---|---|---|---|
| kick | 13 / 52 = 25 % | 47 / 59 (STEP98) | percussion 11, snare 8, tom 5 |
| snare | 8 / 32 = 25 % | 33 / 39 | percussion 14, lead 4 |
| clap | 1 / 12 = 8 % | 13 / 13 | percussion 8, snare 2 |
| **hihat** | **0 / 17 = 0 %** | 21 / 25 | percussion 12, openhat 3 |
| tom | 0 / 3 | 6 / 8 | percussion 2 |
| **cymbal** | **0 / 7 = 0 %** | 8 / 12 | noise 2, other 2 |
| percussion | 4 / 12 = 33 % | 22 / 40 | snare 3 |

Acoustic prediction distribution over the 135 rows: **`percussion` 52 (39 %)**,
snare 22, kick 14, clap 9, tom 6, lead 6, openhat 5, everything else ≤ 4 — and exactly
**one** `hihat` and **one** `cymbal` in the whole set.

So the dominant acoustic behaviour is **abstention into `percussion`**, which is the
STEP44 §14 ultra-short fallback (`veryShort` ≤ 0.35 s with a within-family margin below
the gate → `percussion` + `ambiguous`). Real drum one-shots are largely ≤ 0.35 s, so the
classifier's honest-refusal design fires constantly. That — not the tag vocabulary, and
not a threshold — is the binding constraint on drum recognition.

## 4. The weight candidate that was reverted

**Measured defect.** `drumScore("kick")` rewarded `crestHigh` (crest ≥ 5) with 0.15.
On the reliable one-shot corpus that term fires for only **17 % of the kick class**
(median 2.49, p75 3.94) while firing for 66 % of snares, 67 % of claps, 100 % of
hi-hats, 86 % of cymbals and 83 % of percussion — and it fires for precisely the kicks
the classifier gets wrong (their crest is 5.63–7.67). STEP95 had already made this
exact correction in `family.ts` ("crest is inverted for kicks"); `type.ts` never was.
Fix: `crestHigh` → `crestCompact` (crest < 4.5, the same STEP95 boundary).

**A/B result (offline, then confirmed by a full corpus run):**

| | reconciled | acoustic-only |
|---|---|---|
| before | 112 / 135 = 83.0 % (23 errors) | 26 / 135 |
| after | **117 / 135 = 86.7 %** (18 errors) | **26 / 135 (unchanged)** |

+5 fixed, 0 regressed (4 × `kick→tom`, 1 × `percussion→tom`) — and **not one sample
moved in the acoustic path**. Tracing a single case with its exact stored features:

```
crest 2.68 / 4.0  → audioType = tom, reconciliation TAG-SUPPORTED, winningSource = tag  → type = kick
crest 5.0  / 9.0  → audioType = tom, reconciliation CONFLICT,      winningSource = audio → type = tom
```

The acoustic decision is `tom` at **every** crest value. The term only moves the
raw-score margin, which flips `audioStrong`, which flips whether §24 lets the (correct)
tag through. The +5 is therefore **metadata adoption**, measured on a
metadata-derived ground truth — exactly the circularity of §3.

**Reverted.** A change whose only measured effect is circular is not evidence of better
recognition. If more metadata adoption is wanted, that is a decision about the
reconciliation policy and belongs in that policy, explicitly — not as a side effect of
a crest constant.

## 5. Where the objective actually stands

* The tag vocabulary was genuinely widened in STEP98 (+1.15 pp coverage, 105 occurrences,
  no mis-assignment) — that part is real and shipped.
* The acoustic drum classifier resolves drum *types* at **23.6 %**, and its dominant
  behaviour is abstaining into `percussion` (39 % of decisions).
* Therefore: the previously reported "83–87 %" numbers were metadata reconciliation
  wearing the recognition algorithm's name. The honest ceiling of the tag route is now
  measured, and it is not the bottleneck — **the acoustic margin on short hits is.**

## 6. Next (goal continues)

Target the `percussion` abstention directly, measured on the **acoustic-only** metric:
make the within-family drum margin exceed the §14 gate for real short one-shots (weights
and/or a hit-shape term), and bundle the independently-measured crest inversion from §4
so its effect can finally be observed once abstention stops masking it.

## 7. Verification

| check | result |
|---|---|
| Offline harness vs STEP99 baseline | identical: 112/135, same confusion |
| Candidate A/B (offline + full corpus) | reconciled +5 / acoustic ±0 → reverted |
| `tsc --noEmit` | clean |
| `npm run build` | ok |
| `vitest run` | 90 files / **1601 tests** pass |

## 8. Traceability

* Tooling: `scripts/step100-offline-eval.ts` (new), `scripts/step98-drum-corpus.ts`
  (additive full-feature capture), `scripts/step99-calibration-analysis.ts`.
* Corpora (temp, not the repo): `…/T/opencode/step100-features/` (baseline features),
  `…/step100-after/` (full-corpus confirmation run).
* Sources: `src/classify/hier/type.ts` (`drumMetrics`, `drumScore`, `decideWithin` §14
  gate), `src/classify/hier/classify.ts` (`audioStrong`, reconciliation adoption),
  `src/classify/hier/reconcile.ts` (§24).
* Prior art: `STEP99_REPORT.md` (threshold route rejected), `STEP98_REPORT.md` (corpus),
  `STEP44_HIERARCHICAL_CLASSIFICATION_REPORT.md` §14 (the ultra-short percussion fallback).
