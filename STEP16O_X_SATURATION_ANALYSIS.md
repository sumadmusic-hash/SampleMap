# STEP 16O — X-Saturation Root-Cause Analysis (SampleMap)

**Date:** 2026-09-03
**Scope:** analysis only — no mapping-logic implementation, no GUI, no changes to classification/persistence/Audiotool/Machiniste.
**Method:** read of `mapPosition()`, `extractFeatures()`, `featureExtractor` FFT, plus a **temporary diagnostic run** (`scripts/analyze-map-x.ts`) over 100 REAL Audiotool samples through the same production `extractFeatures` + `mapPosition` (PAT in Node, identical to the established 15G/16M live-verify method). No audio persisted; no credential exposed.

---

## 1. The X-coordinate chain (exact formulas)

**`mapPosition`** (`src/map/mapPosition.ts:37-44`):

```ts
const x = clamp01(features.tonalNoiseRatio);
const y = clamp01((log(max(spectralCentroid,100)) - log(100)) / (log(8000) - log(100)));
```

So **X is derived *entirely* and *only* from `tonalNoiseRatio`** (`mapPosition.ts:28,38`). The mapper applies a **strictly linear (identity) mapping** plus `clamp01`. There is no spreading, percentile, or corpus normalization on X.

**`extractFeatures`** (`src/audio/featureExtractor.ts:28-30`):

```ts
const spectralFlatness  = spectral.flatness;         // geoMean/arithMean over FFT bins
const tonalNoiseRatio   = clamp01(1 - spectralFlatness);
```

`spectralFlatness` is computed in `computeSpectral` (`featureExtractor.ts:132-186`) on a **single fixed Hann-windowed FFT of `FFT_SIZE = 1024`** samples taken from the **start of the audio** (`mono.subarray(0, min(n, 1024))`). For a 44.1 kHz sample that window is the first ≈ **23 ms**.

---

## 2. Why X saturates toward 1 (mechanism)

- `spectralFlatness = geometricMean(magnitudes)/arithmeticMean(magnitudes)` over positive bins.
- For **tonal / pitched / sustained** content (loops, bass, guitar, most musical one-shots), the short 1024-sample window is near-periodic → the magnitude spectrum is **concentrated into sharp peaks** → geometric mean ≪ arithmetic mean → `flatness ≈ 0.001–0.01`.
- Then `tonalNoiseRatio = 1 - flatness` → `≈ 0.99 – 0.999`.
- `mapPosition` maps that literally (identity) onto X → **X ≈ 0.996–0.999** for all tonal content.
- Only genuinely broad-spectrum/noise-like content (cymbals, noise, some hats/snares) has higher flatness → lower X. That contrast exists but is a **minority** of a real library.

The `clamp01` in both places is **not** the cause — the real values are legitemately ≈0.99, not force-clamped over 1.

---

## 3. Real-data statistics (100 real Audiotool samples, same pipeline)

Population: **100 analyzed, 0 skipped, 0 failed** — 43 one-shot, 57 loop.

**X (tonalNoiseRatio):**
| metric | value |
|---|---|
| min / max | 0.0000 / 0.9988 |
| mean / median | **0.8028 / 0.9354** |
| n(X ≥ 0.95) | **46 (46.0%)** |
| n(X ≥ 0.97) | 34 (34.0%) |
| n(X ≥ 0.99) | **22 (22.0%)** |
| distinct X @3dp / @4dp | 73 / 93 of 100 |

**Y (spectralCentroid, log):**
| metric | value |
|---|---|
| min / max | 0.0000 / 1.0000 |
| mean / median | 0.6194 / 0.6869 |
| centroid Hz min/max/mean/median | 0 / 11571 / 2823 / 2029 |

**spectralFlatness (underlying driver):**
| metric | value |
|---|---|
| min / max | 0.0012 / 1.0000 |
| mean / median | **0.1972 / 0.0646** |

**X by kind (mean):** one-shot 0.7804 (n=43), loop 0.8197 (n=57).

**Top-tonal examples** (all loops/tonal one-shots, `flatness 0.0012–0.0039`):
`X=0.9988, 0.9986, 0.9984, 0.9981, 0.9980, 0.9980, 0.9971, 0.9968, 0.9968, 0.9965, 0.9962, 0.9961`.

Interpretation: the **median** X is 0.935 and 46% lie ≥ 0.95 — a dense right-edge cluster. X is **not** a single collapsed value (73 distinct @3dp) but is heavily compressed in [0.95, 1.0]. This matches the reported "vertical line at the right edge."

Cross-check with the independently known real value: the 16M live-verify "Flume Tennis Snare" (a percussive one-shot) yielded `flatness=0.425 → X=0.575` — i.e. mid-X, a noise-like sample. This confirms the axis *works* for non-tonal content but that real libraries are dominated by tonal material.

---

## A) Where exactly does the X-saturation originate?

**Primarily in `extractFeatures`** (`featureExtractor.ts:30`): the feature `tonalNoiseRatio = 1 - spectralFlatness` is already near 1 for most real samples **before** `mapPosition` sees it, because the underlying `spectralFlatness` on the short 1024-sample window is ≈0 for tonal content. `mapPosition` **compounds** it by applying a linear identity mapping with no spreading, so the already-1-skewed value lands stacked at the right edge. Clamping is incidental.

So: the *signal* that's saturated is produced in the extractor; the *mapping* simply fails to spread it and is the second half of the problem.

## B) Which feature / formula causes it?

- **Feature:** `tonalNoiseRatio = 1 - spectralFlatness` (featureExtractor.ts:30), driven by `spectralFlatness` from a **single Hann-windowed 1024-sample FFT** (`featureExtractor.ts:132-186`, `FFT_SIZE=1024`).
- **Formula that stacks them:** `x = clamp01(tonalNoiseRatio)` — a **linear identity** of `1 - flatness` (mapPosition.ts:38).

## C) Is the current mapping strategy suitable for an XO-like SampleMap?

**No, not as-is.** Two reasons:
1. **X carries only one feature** (`1 - flatness`) that is degenerate (≈1) on real tonal libraries → the X-axis cannot discriminate the bulk of samples; it only separates a small noisy minority.
2. The **fixed per-sample identity mapping** (static domain bounds, no corpus/percentile normalization) never adapts to the actual distribution, so even a well-distributed feature would not fill the map for real data.
An XO-style map needs **two complementary, discriminative axes** and **distribution-aware (corpus-adaptive) placement**; a single short-window flatness on a linear axis is inadequate.

## D) What 2D mapping would be sensible for SampleMap?

Options (implementation deliberately deferred — recommendation only, from lowest to highest effort):

1. **Corpus-adaptive percentile/rank normalization (highest-value, minimal change):** keep the semantic axes (tonal/noise, dark/bright) but map each sample to its **rank/percentile within the analyzed set** instead of a fixed linear domain. This alone would spread the current data across the full X-range and remove the right-edge stacking, while staying deterministic *per corpus*.
2. **Replace/augment the X feature:** use a feature that better separates real content, e.g. `spectralFlatness` itself, or **`tonalNoiseRatio` from a longer/multi-window FFT** (average flatness over the whole sample, not just the first 23 ms), or a combination (bandwidth, zero-crossing rate, rolloff). Choose axes that are **orthogonal** to `spectralCentroid` (the Y axis), so the map is 2-dimensionally populated rather than a line.
3. **Curated 2D audio space (XO-like):** define two complementary perceptual axes — e.g. **X = "noiseness/brightness"** (flatness + bandwidth + ZCR) and **Y = "low-end/energy"** (centroid/rolloff/bass-energy) — and standardize each against the corpus.
4. **Learned/embedded projection (highest effort):** featurize per-sample into a vector and project to 2D (PCA or a UMAP/t-SNE embedding computed from the analyzed corpus). Best spread for an XO feel, but requires an embedding step and loses simple, stable axis semantics.

Recommendation: **start with (1) percentile normalization + (2) a long-window/multi-window flatness (or a complementary second feature)**, keeping the axes semantic and orthogonal; evaluate against the corpus, then consider (4) only if a richer layout is required.

---

## What was NOT done (per instruction)

- **NO** new mapping logic implemented.
- **NO** GUI/cosmetic changes.
- **NO** change to classification, persistence, Audiotool integration, or Machiniste.
- **NO** credential copied/printed; PAT used only in Node from `.env` (never in browser, never logged).

**Reproducibility:** the temporary diagnostic `scripts/analyze-map-x.ts` reproduces these numbers by running the real `extractFeatures` + `mapPosition` over real samples. It is outside the app `tsconfig.include` (`["src", "vite.config.ts"]`), so it does not affect tsc/build/tests; `tsc --noEmit` confirmed clean.

**Next step (not started):** decide the 2D-map strategy from §D, then a separate implementation step.
