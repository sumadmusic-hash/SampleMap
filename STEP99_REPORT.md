# STEP99 — Drum-threshold recalibration: measured candidates, A/B verified, REVERTED

**Date:** 2026-10-08 · **Baseline commit:** `6380895` (STEP98) · **Type:** calibration
experiment + analysis tooling. **No production behaviour was changed** — the candidate
change did not survive its own A/B and was reverted.

**Verdict:** negative result, verified. `tsc` clean · `vite build` ok · **90 files / 1601
tests** · working tree carries only the new analysis script.

---

## 1. Why this step exists

STEP97 fixed the V1 spectral extractor, which had made `spectralFlatness` bimodal
(52 % ≈ 0, 48 % exactly 1.0). STEP95's drum anchors (`noisy = flat > 0.002`,
`flat < 0.0008`) had been measured on those degenerate values. STEP98 built a real
tag-labelled drum corpus. STEP99 is the "re-anchor the thresholds on the new
measurement" step that follow-up demanded — including the possibility that it fails.

## 2. Method: only RELIABLE supervision may drive a threshold

`scripts/step99-calibration-analysis.ts` splits the STEP98 corpus by label quality:

| subset | n | why |
|---|---|---|
| NAME and TAG agree on the drum type | **223** | two independent text surfaces agree — the strongest label the data offers |
| only one surface present | 17 | weaker |
| — one-shots within the reliable subset | **135** | the only calibratable set |
| — loops within the reliable subset | 88 | **all 0 %** by construction (STEP96 gives every drums-family loop the neutral type) |

Baseline on the reliable one-shots: **112 / 135 = 83.0 %**, 23 errors.

## 3. The measured anchors (all from that corpus)

| feature | kick | snare | clap | hihat |
|---|---|---|---|---|
| **centroid p25 / med / p75** | 148 / **1219** / 3313 | 3239 / 4512 / 6202 | 4014 / 5203 / 5895 | 6270 / 8404 / 9168 |
| **zcr min / p10 / med / max** | 0.0005 / 0.0023 / **0.0058** / 0.0767 | 0.0078 / 0.0235 / **0.1269** / 0.3724 | 0.0508 / 0.0872 / 0.1237 / 0.3093 | 0.0337 / 0.1590 / 0.2800 / 0.4318 |
| **flatness min / p25 / med / p75** | 0.0006 / 0.0044 / 0.0640 / 0.2565 | 0.0094 / 0.0850 / 0.1645 / 0.3355 | 0.0840 / 0.1543 / 0.3020 / 0.5401 | 0.0530 / 0.0801 / 0.1592 / 0.4554 |

Three *provable* mis-calibrations:

1. **`noisy = flat > 0.002` is near-constant.** Real drum flatness medians are
   0.064 (kick) to 0.302 (clap) — every one far above 0.002 — so the "noise burst vs
   tonal body" term fires for essentially all drum material and stops discriminating.
2. **`flat < 0.0008` is dead.** Almost no real drum sample reaches it.
3. **The kick's 900 Hz cliff sits inside the kick population.** 54 % of correctly
   classified kicks exceed 900 Hz (median 1219 Hz), so they lose the entire dark term
   *and* take a global ×0.25 — while the darkest measured snare is 1028 Hz, the darkest
   hi-hat 3357 Hz and the darkest cymbal 3430 Hz.

The 23 baseline errors cluster as `kick→tom` 6, `kick→snare` 4, `snare→clap` 3, plus
singletons. The four `kick→snare` cases have centroid 920–1631 Hz and zcr 0.002–0.012 —
squarely inside both the measured kick centroid band and the measured kick zcr band.

## 4. The candidate change, and its A/B

Driven purely by §3: widen the kick's scored band from 900 Hz to the measured kick p75
(2500 Hz, with reduced partial credit), *and* add a measured snare zcr floor
(`zcr < 0.02` → ×0.4; above the kick p75 0.0203, below the snare p10 0.0235).

Verified by re-running the **identical** corpus (deterministic selection, 383 samples,
real audio, current pipeline):

| | reliable one-shots | errors |
|---|---|---|
| before | **112 / 135 = 83.0 %** | 23 |
| after | **110 / 135 = 81.5 %** | 25 |

* **Fixed 4** — exactly the four predicted `kick→snare` cases (`hardcore bassdrum 4`,
  `rrdrumkit24_Kick_4`, `fd kick 2`, `Prisma Hardcore Kick F#2`).
* **Regressed 6** — `Jtro 707 Rim Shot`, `at needs more kicks "cymbal"`, `smacked kick`,
  `gabber kick 8 xtra`, `Tom 02 A#`, `Hardcore Kick (170 BPM)`.

Net −2. **The change was reverted.**

## 5. Why no narrower band rescues it

The obvious repair — widen less — is closed by the data. Centroids of the samples the
change *fixed* and of those it *broke*:

| | centroids (Hz) |
|---|---|
| fixed | 920 · 940 · 1107 · 1631 |
| regressed | 1185 · 1219 · 1587 · 1746 · 1973 · 3555 |

They **interleave**. So do their zcr (fixed 0.002–0.012 vs regressed 0.004–0.015),
flatness (0.037–0.092 vs 0.038–0.225) and transientStrength (1.2–4.0 vs 0.7–9.3). There
is **no single-feature threshold** that admits the four without admitting the six.

## 6. What this step establishes

1. **The 900 Hz kick bar is load-bearing.** It was not a stale STEP45 artefact to be
   "corrected"; it is what keeps rim shots, toms and bright percussion out of `kick`.
   The corpus quantiles argue for widening it, and the A/B shows widening costs more
   than it gains. Measurement of a marginal distribution alone is not sufficient
   evidence for moving a *decision boundary* — only the decision-level A/B is.
2. **The residual one-shot errors are not threshold-addressable on the current feature
   set.** `kick→tom`, `kick→snare`, `kick→clap` cases are not separated from their
   correctly-classified neighbours by centroid, zcr, flatness, crest or
   transientStrength. Closing them needs richer features (or a genuinely different
   decision structure), not a moved constant.
3. Consequence for the objective: the tag-driven route has now been taken as far as the
   current features allow. The label set is sound (223 reliable rows) — the features are
   the binding constraint.

## 7. Delivered

* `scripts/step99-calibration-analysis.ts` — the reliable-vs-unreliable supervision
  split and the per-label feature distributions. Reusable for any future calibration
  attempt, and mandatory reading before moving a drum threshold.
* No production change. `src/classify/hier/type.ts` is byte-identical to `6380895`.

## 8. Verification

| check | result |
|---|---|
| `tsc --noEmit` | clean |
| `npm run build` | ok |
| `vitest run` | 90 files / **1601 tests** pass |
| A/B on the real corpus | 112/135 → 110/135 → **reverted** |

## 9. Traceability

* Analysis: `scripts/step99-calibration-analysis.ts`; corpus from
  `scripts/step98-drum-corpus.ts` (383 rows, real WAV audio, current pipeline).
  Baseline corpus `/var/folders/q8/…/T/opencode/step98/`, A/B corpus `…/step99-after/`.
* Sources: `src/classify/hier/type.ts` (`drumMetrics`, `drumScore`), `src/classify/hier/classify.ts`
  (STEP96 loop rule), `src/classify/hier/evidence.ts` (`parseNameEvidence`, `parseTagEvidence`).
* Prior art: `STEP95_REPORT`-equivalent anchors in the STEP95 commit, `STEP97_REPORT.md`
  (the feature fix that invalidated them), `STEP98_REPORT.md` (the corpus).
