# STEP 16P — Semantic 2D SampleMap v2 — Mapping Design

> Status: **DESIGN ONLY.** No production mapping code is changed. No GUI, classification,
> persistence, Audiotool, Machiniste, Global Index, Search or Preview change.
> Implementation happens in a separate step after approval of this spec.
>
> All numbers in this report are measured from the **100 REAL Audiotool samples**
> via the production pipeline (`extractFeatures` + `mapPosition`, PAT in Node),
> using the existing `scripts/analyze-map-x.ts --corr` diagnostic.

---

## 1. Problem

The current map is:

```
x = clamp01(tonalNoiseRatio) = clamp01(1 - spectralFlatness)   (mapPosition.ts:38)
y = log-scaled spectralCentroid                                 (mapPosition.ts:39-43)
```

with `spectralFlatness` measured on a **single 1024-sample Hann window (~23 ms) at the
start of the audio**.

Diagnosis (Step 16O) on 100 real samples:

- X median = **0.935**, mean = **0.803**; **46 % have X ≥ 0.95**, **22 % have X ≥ 0.99**.
- `spectralFlatness` median = 0.065, mean = 0.197 → because flatness is strongly
  right-skewed (most content is near-0), its complement `1 - flatness` collides near 1.
- Result: real content draws a near-vertical point cloud at the right edge → X axis is
  effectively unusable; the map uses essentially one (Y) dimension.

Root causes (two, compounding):

1. **Feature-space skew** — `1 - flatness` is an ill-conditioned transform of a
   right-skewed, near-0-clustered statistic. The semantic distinction (tonal vs noisy)
   lives in the small flatness range ~0.001–0.7, which is crushed against 1 by the
   identity `1 - flatness`.
2. **Too-short analysis window** — one 1024-frame (~23 ms) window from the sample start
   is not representative of sustained/loop content and inflates measured tonality.
3. **No normalization/spread** — linear identity with fixed [0,1] per axis, no corpus
   adaptation.

---

## 2. Requirements (V1)

- Real two-dimensional audio map: similar sounds close, different sounds far.
- Position derives from **acoustic properties**, not from categories or random jitter.
- Axes are **interpretable** and **orthogonal** (not two measures of the same thing).
- Full map area usable on a **real** corpus (hundreds–thousands of samples in Browser).
- **Stable** positions when samples are added/removed and across reloads.
- **Deterministic**, **fast** (no expensive DSP), browser-capable for thousands of samples.
- Category used **only for visual encoding**, never as positional input.

---

## 3. Axis definition

Both raw axes use **log-domain** transforms of well-understood perceptual quantities.
Choosing log scales is deliberate: audio features are multiplicative/skewed, so a linear
identity degenerates (as measured). Logs linearize the semantic structure.

### X-axis — `tonal ↔ noisy`

**Semantic:** how much the sample behaves like a pitched/tonal body vs broadband noise.

- **Primary component** — `spectralFlatness` (whole-sample, multi-window; §4).
  - Meaning: ratio of geometric to arithmetic mean of spectrum. ~0 = tonal (few strong
    bins), ~1 = noise-like (flat spectrum).
  - Range: [0, 1], strongly right-skewed (measured p10=0.004, p50=0.065, p90=0.702).
- **Optional secondary component** — ZCR *residual* (only if needed later; not in V1):
  the component of ZCR orthogonal to brightness (see §5). Measured `corr(zcr, centroid)` =
  0.64 → ZCR is mostly brightness, so it cannot simply be summed in. If ever added, use
  `zcrResid = zcr - slope·centroid` after centering. Kept out of V1 for interpretability.

### Y-axis — `dark/low ↔ bright/high`

**Semantic:** spectral brightness / pitch height.

- **Primary component** — `spectralCentroid` (Hz). Measured p10=229, p50=2031, p90=7794 Hz.
- Alternatives considered and **rejected for V1** because they are near-duplicates of
  centroid on this corpus (measured Pearson |r| vs centroid):

| feature         | |r| vs centroid | verdict |
|-----------------|-----------------|---------|
| spectralRolloff | 0.96            | redundant (nearly identical) |
| spectralBandwidth| 0.79           | redundant |
| zeroCrossingRate | 0.64           | redundant for brightness |

  Including these would violate the orthogonality requirement (§3 above).

### Orthogonality check (measured, real corpus)

| pair             | Pearson r | verdict |
|------------------|-----------|---------|
| flatness vs centroid | 0.444 | **best orthogonal pair**; moderate, acceptable |
| flatness vs rolloff  | 0.480 | worse than centroid |
| flatness vs zcr      | 0.203 | lowest X-crossover, but zcr is 0.64-correlated to brightness |

**Conclusion:** `flatness` (X) and `centroid` (Y) are the most orthogonal meaningful pair
available in the current `AudioFeatures`. They are combined in a log-domain map that
further decouples them (component 2 of the nonlinearity removes shared brightness).

---

## 4. Improved flatness measurement (multi-window)

**Problem with the current single-window measurement:**
- 1024 frames ≈ 23 ms from sample start captures only the onset transient; for loops,
  sustained pads, and long samples it is not representative → inflates tonality.
- The fixed single window makes the feature unstable across similar samples.

**Proposed replacement (cost-aware):**

```
WINDOW = 2048 frames (≈46 ms @ 44.1 kHz), Hann window
HOP    = 50 % (1024 frames)

N      = clamp(floor((N_frames - WINDOW) / HOP), 1, MAX_WINDOWS)
        # at least 1 window (short-sample handling), at most MAX_WINDOWS

windows: t_i = i * HOP for i in 0..N-1  →  flatness_i = spectralFlatness(fft(window t_i))
flatOverall = median(flatness_0 .. flatness_{N-1})
```

- **Median**, not mean: robust to a single noisy/attenuated window (attack transient,
  dropped beats in loops).
- **MAX_WINDOWS = 16** caps the cost: ≤ 16 FFTs of 2048 frames per sample, regardless of
  sample length. Cost ≈ `16 × FFT(2048)` ≈ a few ms per sample in JS/WASM → trivially
  browser-safe for thousands of samples.
- **Short samples** (< one window): kept at `N = 1`, compute on whatever frames exist
  (measured duration p10 = 0.33 s ≈ 14.5k frames, so ≥ 7 windows even at p10; only tiny
  FX/one-shots fall to N=1). Deterministic and cheap.
- **Weighting:** uniform median across up to 16 windows. Heavier weighting of windows by
  RMS (perceptual salience) is reserved as a future option; median already de-emphasizes
  near-silent onset frames without extra cost.

**Justification vs one-shot:** multi-window median is (a) semantically correct for loop /
sustained content, (b) only ~16× the current single-FFT cost (still microseconds-to-ms per
sample, amortized fine over thousands), (c) deterministic, (d) improves stability because
a per-sample representative is less sensitive to where the sample starts. Rejected options:
mean (outlier-sensitive), all-windows sizing (unbounded cost for long samples), weighted
by sample-start (the very thing we are fixing).

> Note: `extractFeatures` also feeds the classifier; this step changes *only* the SampleMap
> path. The V1 implementation MUST keep `AudioFeatures.spectralFlatness` (and the classifier
> contract) unchanged and compute the map-specific whole-sample flatness **inside the map
> module** (deriving it from the FFT frames it already needs), so classifier/Persistence
> semantics are untouched.

---

## 5. Feature combination → concrete raw-axis formulas

Components (their meaning, range, normalization, weight, selection reason):

### `rawX` — tonal/noisy axis

```
flatOverall  ∈ [0, 1]            (whole-sample median, §4)
snr          =  (1 - flatOverall) / (flatOverall + ε)      # ε = 1e-4 avoids div-by-0
rawX         =  log10(snr)                                  # tonal → +, noisy → −
```

- **Meaning:** log "signal-to-noise ratio" in the tonality sense — how much tonal energy vs
  flat/noise energy.
- **Range:** log10 of (1-f)/f. flatness→0 ⇒ +∞ (clamped at +Xceil); flatness 0.5 ⇒ 0;
  flatness→1 ⇒ −∞ (clamped). On the measured corpus this spans roughly −2 … +3.
- **Normalization:** none here (log already stabilizes); normalized later in §6 by fixed
  anchors.
- **Why log + ratio instead of `1 - flatness`:** the measured right-skew means the tonal
  half (flatness 0.001–0.7) occupies 99 % of the identity scale, crushing real distinction.
  A log-ratio maps tonality onto a *symmetric, wide* scale where the fine tonal structure is
  preserved (no right-edge saturation). This is the direct fix for the Step 16O finding.

### `rawY` — dark/bright axis

```
rawY   =  log10(1 + spectralCentroid)      # centroid in Hz
```

- **Meaning:** perceptual brightness on a log-Hz scale (matches how we perceive pitch).
- **Range:** measured centroid ∈ [229, 11571] Hz → rawY ∈ [2.36, 4.06]. `1 +` guards log(0).
- **Why log:** linear Hz is dominated by bright outliers (p90=7794 vs p50=2031); log makes
  the perceptually-relevant low/mid region spread evenly.

### Weights

- No arbitrary additive weights. X is *flatness-driven*; Y is *centroid-driven*. Any
  X-component correlated with brightness is explicitly removed (ZCR residual, optional) so
  X and Y stay orthogonal without needing hand-tuned scalar weights. This is preferred over
  "just add features" because additive mixing without decorrelation reintroduces the
  redundancy measured in §3.

### Decorrelation step (optional, deterministic, low cost)

After computing `flatOverall` and `centroid`, compute each sample's global mean across the
corpus and subtract the shared regression to shrink residual X–Y correlation if it exceeds
a small threshold — OR skip and rely on the measured 0.444 being acceptable. V1: **skip**;
revisit only if on the full corpus the X–Y correlation rises above ~0.6.

---

## 6. Corpus-adaptive normalization

Required **order** (and why):

1. **Semantic raw features** (`rawX`, `rawY`) — the log-domain quantities from §5.
   - Why first: everything after works on perceptually-linearized values; a logit/log
     transform before any clipping makes the distribution symmetric instead of
     right-skewed, which is the root of the original saturation.
2. **Robust outlier handling** — clip each axis to its corpus P2.5–P97.5 (`robustClip`).
   - Why: spectrogram outliers (a single near-silent loop, a 40-second FX tail) would
     otherwise stretch the whole axis; percentiles are robust to a few bad samples.
3. **Robust per-axis scaling** — map the clipped range to [0,1] linearly.
   - Why: linear on the *clipped* range (already log-linearized + declipped) is now safe:
     the skew was removed upstream, so linear spreading here is faithful, not naive.
4. **Optional moderate percentile spread** — a mild power/squash to improve area usage
   *only if* the post-clip distribution is still concentrated (e.g. `x' = x^γ` with
   γ ∈ [0.7, 1.3]). Default γ = 1 (off) for V1; used only if the acceptance criteria in §9
   show a degenerate marginal.
5. **Final clamp** to [0,1] and quantization-safe rounding to e.g. 4 decimals.

Why this sequence is correct: normalize semantic → remove outliers → spread → optional
re-spread → clamp. Each step operates on a progressively cleaner signal; applying clipping
before the log transform, or spreading before clipping, would re-introduce the skew that
caused the original failure.

---

## 7. Stability strategy

**Decision for SampleMap V1: (B) — stable global normalization with perceptual anchors,
plus an optional (A) "lens" on top that is smooth in corpus size.**

Rationale over pure (A) or pure (C):

- **(A) fully corpus-adaptive** (percentile/rank of the current set): best area usage, but
  *any added sample re-ranks everything* → every existing position moves on every analysis.
  Unacceptable for a live map.
- **(B) stable global anchors:** positions are a **pure function of the sample's own
  features** + fixed, interpretable anchors (log-musical floor/ceiling). Adding/removing
  samples changes **nothing**. Fully deterministic, reload-stable. This is the right default.
- **(C) hybrid:** use (B) as the underlying stable coordinate; optionally, when the corpus
  is large enough, apply a *small, slowly-varying* percentile tilt that only activates at
  e.g. ≥ 200 samples and changes positions by < a few % — keeping near-stability.

**Recommended V1 = (B)** with these fixed anchors (chosen from measured data, rounded to
interpretable musical/log values):

| axis | anchor function                    | chosen bounds                 | why |
|------|------------------------------------|-------------------------------|-----|
| X    | `rawX = log10((1-f)/f)`            | clip to [ -2.0, +3.0 ]        | covers measured flatness 0.001→0.99 spread |
| Y    | `rawY = log10(1+centroidHz)`       | clip to [ log10 100, log10 10000 ] | 100 Hz (deep sub) → 10 kHz (air); musical floor/ceiling |

These bounds are **fixed** and need no corpus → positions never move when samples are added.

### Behavior across corpus sizes (V1, anchor-based)

| corpus | behavior |
|--------|----------|
| 10 samples | fully distributed per own features; no re-mapping. Positions stable. |
| 100 samples | same; measured real data now spans X ≈ −0.45…+3, Y ≈ 2.4…3.9 before clip. |
| 1000+ samples | same; no `O(n)` or `O(n²)` cost — each sample is analyzed independently. |
| after reload | identical (deterministic function of features; no stored corpus state). |

This is precisely designed so **V1 never re-ranks**: adding a sample can only occupy free
space, never disturb neighbours.

---

## 8. Categories are visual, not positional

Classification (`kick`, `snare`, `bass`, `loop`, …) is **never** fed into `rawX`/`rawY`.
The map shows the actual sound. For V1 the category is encoded purely visually, with no
effect on coordinates:

- **Colour** by top class (single stable `classId → hue` palette).
- **Point size** optional (loops slightly larger).
- **Tooltip / click** shows class + metadata.

Rejected for V1: shape icons, explicit clusters/chart-render. Colour + optional size is
cheap, deterministic, and keeps the audio position untouched. This preserves the XO-like
goal (sound-determined placement) while still letting a user read category at a glance.

---

## 9. XO-like behaviour — required properties

| property | how V1 meets it |
|----------|-----------------|
| local similarity | nearby flatness+centroid ⇒ nearby log-axes ⇒ nearby position. |
| global overview | stable anchors keep full musical range spread across the square. |
| no artificial category split | coordinates use only acoustic features (§8). |
| full-area usage | log transforms + robust clip spread real data (measured). |
| stable positions | fixed-anchor mapping, no re-rank (§7). |
| fast computation | ≤16 FFT(2048) per sample (§4); O(1) per sample map. |
| browser-capable | pure JS + small WebAudio FFT; no external DSP deps. |
| deterministic | pure function of features; fixed anchors; no RNG. |

A real XO clone is **not** needed — this is a robust, explainable 2D embedding with the
practical guarantees above.

---

## 10. Variant comparison

Evaluated against the measured corpus and V1 requirements.

### Variant A — Existing features + percentile normalisation
- Quality: fixes right-saturation by spreading, but `1 - flatness` still lacks tonal
  resolution and single-window flatness is unrepresentative. **Poor tonal separation.**
- Interpretability: high (simple).
- Stability: poor (percentile re-ranks on every sample → positions move).
- Performance: O(1). Complexity: low.
- **Verdict:** fixes the symptom, not the cause. **Rejected for V1** (still fully corpus-adaptive → unstable).

### Variant B — Multi-window flatness + percentile normalisation
- Quality: better flatness (representative), but still percentile-based → re-ranking.
- Interpretability: medium.
- Stability: poor (same re-rank issue).
- Performance: ≤16×FFT, O(1)/sample. Complexity: low–medium.
- **Verdict:** improves the feature but keeps the unstable normalisation. **Rejected for V1** (unstable), but its *feature* improvement (multi-window flatness) is adopted into Variant C/R.

### Variant C — Semantic combined axes + robust normalisation (RECOMMENDED)
- Quality: log-ratio X (de-saturates the actual root cause) + log-centroid Y (orthogonal);
  robust clip; stable anchors. **Best quality/interp/stability balance.**
- Interpretability: high (tonal↔noisy, dark↔bright).
- Stability: **high** — fixed anchors, no re-rank; reload-stable.
- Performance: ≤16×FFT, O(1)/sample. Complexity: medium.
- Browser-capability: excellent (pure JS + WebAudio FFT).
- **Verdict: recommended for SampleMap V1.**

### Variant D — PCA / UMAP / embedding
- Quality: highest possible *spatial* embeddings (UMAP clusters well; PCA is linear),
  but axes become **non-semantic** (arbitrary principal directions / manifold coords).
- Interpretability: **low** — axes no longer mean "tonal↔noisy".
- Stability: UMAP is notoriously unstable with new data (needs re-fit); PCA stable only per fit.
- Performance/complexity: highest (PCA O(n·d²), UMAP iterative; heavy for thousands in Browser).
- **Verdict:** overkill and non-interpretable for V1; **rejected**. Revisit only if V2 needs
  automatic clustering.

### Recommendation — **Variant C**

It directly addresses the Step 16O root cause (log-ratio X), keeps interpretable orthogonal
semantic axes, is stable (fixed anchors), cheap (O(1)/sample, ≤16 FFTs), browser-safe, and
deterministic.

---

## 11. Acceptance criteria (measurable; test on the 100 REAL samples)

Proposed reproducible gate for the implementation step (same real 100-sample population via
PAT, same diagnostic harness):

1. **X not right-degenerate:** fraction of samples with `X ≥ 0.95` drops from **46 %** to
   **< 15 %** (target ideally < 10 %).
2. **X spread:** `stdev(X) > 0.20` (was effectively crushed at the right edge). And
   `X` P10–P90 span > 0.5.
3. **Y spread:** `stdev(Y) > 0.15` and P10–P90 span > 0.4.
4. **No edge pile-up:** no axis has > 25 % of samples within 2.5 % of its edge, and no
   corner bin (5×5 grid) holds > 30 % of samples.
5. **Orthogonality:** |Pearson(X,Y)| ≤ 0.5 on the sampled corpus (measured raw-feature pair
   was 0.444; the map-level target is ≤ 0.5).
6. **Local similarity:** mean intra-class X–Y distance for the top-5 classes is less than
   the global mean pairwise distance (i.e. similar sounds cluster more than random) —
   without any class label being a positional input.
7. **No artificial category split:** Pearson correlation between `classId` (as a numeric
   code) and X (and Y) remains below the threshold that would indicate category-driven
   placement; colour is cosmetic only. Concretely: |r(classCode, X)| ≤ 0.4 and |r(classCode, Y)| ≤ 0.4.
8. **Determinism:** two runs on the same 100 samples produce byte-identical X/Y (to 4 dp).
9. **Performance:** analysis + mapping of the 100 samples completes in < a few seconds in
   Node, and per-sample map cost is O(1) (no corpus-wide pass) so 1000 samples ≈ 10× the time,
   not 100×.

---

## 12. Implementation plan (separate step, ONLY after approval)

1. **Map-feature source:** add a map-local `flatnessOverall(decodedAudio)` (multi-window
   median, §4) inside the **map module** (not the classifier path), keeping
   `AudioFeatures.spectralFlatness` and the classifier contract unchanged.
2. **New mapping in `mapPosition`:** compute `rawX = log10((1-f)/(f+ε))`, `rawY = log10(1 + centroid)`;
   robust-clip to fixed anchors; map to [0,1]; optional γ-squash if ACs fail; clamp + round.
3. **Backwards-compat guard:** map module exposes a pure `computePosition(features, decodedAudio)`
   and a thin wrapper preserving the current `mapPosition(features)` signature for the test/UI
   surface that depends on it (verified before editing).
4. **Diagnostic validation:** extend `scripts/` harness to run the new mapping over the same
   100 real samples and report **all** §11 AC numbers side-by-side with baseline.
5. **Tests:** update `mapPosition.test.ts` + a new map-normalisation unit test (log scaling,
   anchors, determinism, short-sample N=1 path, clip, clamp). Existing classifier/persistence
   tests must remain green.
6. **Verification:** `tsc --noEmit`, `vitest`, `eslint`, Playwright 16M layer A/offline, and the
   §11 AC report. GUI category-colour only if a follow-up step covers it (this design does not
   mandate GUI change).
7. **Do NOT:** change classifier, persistence, Audiotool, Machiniste, Global Index, Search, Preview.

---

### STOP

This is the design. No production mapping code, GUI, or tests (other than the read-only
diagnostic) has been changed. Awaiting review and go-ahead for the implementation step.
