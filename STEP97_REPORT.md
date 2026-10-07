# STEP97 — The V1 spectral extractor measured only the first 21 ms; 47.6 % of real records carried fabricated features

**Date:** 2026-10-08 · **Baseline commit:** `3924527` (STEP96) · **Type:** root-cause fix
in V1 audio feature extraction + a test-hygiene fix. No schema, contract, UI-behaviour,
classifier-threshold or worker change.

**Verdict:** defect proven on the live global index (read-only), fixed, verified
(`tsc` clean, `vite build` ok, **90 files / 1601 tests**, three consecutive full runs
without a single unhandled error).

---

## 1. How this was found

The task was "optimise the sample recognition algorithm". Acting on the project's own
rule — calibrate only against **measured** data — I started by inventorying every feature
threshold in the classifier against the ranges the pipeline actually produces.

Checking the feature source contradicted the project's own records: `type.ts:119-128`
(STEP95) states the real V2 `spectralFlatness` medians are `kick 0.0006 … cymbal 0.0055`,
while the V2 DSP, run over the synthetic calibration corpus, produces **0.845 for white
noise**, 0.597 for pink noise, 1.0 for an impulse and 0.002 for a pure tone. Both cannot
be true of the same feature.

So I measured the real thing.

---

## 2. Measurement (real data, read-only, no token)

Source: the deployed global index over its **public read path**
(`GET /map?mapVersion=map-v2` → `POST /content/lookup`), 500 content identities.
No write endpoint was touched, no credential was used, no audio was fetched.

### `spectralFlatness` of the live corpus (n = 500, V1 `audioFeatures`)

| band | count | share |
|---|---|---|
| 0.000000–0.002 | 261 | 52.2 % |
| 0.002–0.01 | 1 | 0.2 % |
| 0.01–0.05 | **0** | 0.0 % |
| 0.05–0.10 | **0** | 0.0 % |
| 0.10–0.35 | **0** | 0.0 % |
| 0.35–0.60 | **0** | 0.0 % |
| 0.60–0.80 | **0** | 0.0 % |
| 0.80–1.01 | 238 | 47.6 % |

min `0.0000255`, p05 `0.0000561`, median `0.000835`, p95 `1`, max `1`.

The distribution is **bimodal with nothing in between**: half the corpus at ~0.001 and
half pinned at exactly `1.0`. That is not a timbre distribution.

### The `flatness == 1` group is not silence — it is real audio

| group | n | rms | peak | **centroid** | zcr | duration |
|---|---|---|---|---|---|---|
| `flatness == 1` | 238 | 0.1196 | 0.7088 | **0.0000** | 0.0332 | 11.67 s |
| `flatness < 0.002` | 261 | 0.3051 | 0.8914 | 161.10 | 0.0096 | 4.72 s |

Real audio (rms 0.12, peak 0.71, up to 177 s) with `spectralCentroid` **exactly 0.0**
and `spectralFlatness` **exactly 1.0**. `analysisVersion` is `features-v1` for all 500;
`classificationVersion` is `hier-v1` for 496.

### Why that happens (logic, not inference)

`computeSpectral` returned the degenerate default `{centroid: 0, bandwidth: 0,
rolloff: 0, flatness: 1}` in exactly three cases: `n === 0`, `n < 2`, or `totalMag <= 0`.
Magnitudes are non-negative, so `totalMag === 0` **iff the windowed frame is all zeros**.
The analysed frame was `mono.subarray(0, min(n, FFT_SIZE))` with `FFT_SIZE = 1024`
(`featureExtractor.ts:11`) — i.e. **only the first 1024 samples = 21.3 ms at 48 kHz**.
Those 21 ms were digital silence for 238 of 500 real samples (encoder priming delay / a
leading rest), and the extractor then reported a fabricated "perfectly flat, no centroid"
constant for the entire sample.

---

## 3. The fix

`src/audio/featureExtractor.ts` — `computeSpectral` now aggregates across
**energy-bearing frames over the whole signal**, mirroring the V2 DSP chain
(`v2Dsp.ts:124-223`): every frame is Hann-windowed, magnitude-weighted aggregation for
centroid/bandwidth/rolloff/flatness, and a frame whose magnitude sum is zero is
**skipped instead of measured**. `SPECTRAL_HOP = FFT_SIZE / 2` (50 % overlap).
The degenerate fallback now applies only when **no** frame carries energy — the one case
where it is literally true. The dead `fftMag` / `nextPow2` helpers were removed.

### V1 vs V2 agreement, before → after (same synthetic corpus)

| signal | V2 flatness | V1 before | V1 after |
|---|---|---|---|
| whiteNoise | 0.8454 | 0.8498 | 0.8467 |
| percussiveNoiseHit | 0.8505 | 0.8514 | 0.8497 |
| pureTone440 | 0.001960 | 0.001735 | 0.001017 |
| highSine2000 | 0.012552 | **0.000451** (28× off) | 0.006413 |
| swellTone | 0.001286 | **0.0000155** (83× off) | 0.000661 |
| detunedHarmonic | 0.001649 | **0.0000058** (285× off) | 0.000855 |
| bellLike | 0.003216 | **0.0000122** (263× off) | 0.001600 |

Centroids now track V2 closely across the corpus (e.g. `whiteNoise` 11 978 vs 11 992 Hz);
residual ~2× differences on tonal signals come from the different frame size
(1024 vs 2048) and are expected.

### Cost

Extraction is now whole-signal. Measured against the V2 chain that the pipeline already
runs on the same buffer: `1 s` 12 ms vs 168 ms · `10 s` 26 ms vs 202 ms · `60 s` 130 ms
vs 507 ms. The addition is a fraction of the analysis the pipeline already performs.

---

## 4. What this defect was corrupting

| consumer | field(s) | effect on ~48 % of records |
|---|---|---|
| `similarityFingerprint.ts:74-76` | centroid · bandwidth · rolloff (**3 of 8** normalised dims) | Find Similar and the published fingerprint ran on three constants |
| `mapPosition.ts:92` | `centroidToY(features.spectralCentroid)` | centroid 0 → `y = 0`, i.e. pinned to the very bottom ("darkest") of the map |
| D1 `content.features` | published `AudioFeatures` | the degenerate values were published and server-side fingerprint recomputation validated against them |
| `hydrate.ts:75` | `fromV1AudioFeatures(globalAnalysis.audioFeatures)` | the degenerate V1 values were adapted **into `analysisV2.features`** on reuse |
| `hier` classifier | V1 fallback path | spectral terms fed by constants |

It also explains why the classifier's own threshold inventory looked broken: STEP87's
"real corpus flatness range" and STEP95's medians describe the **lower mode of this
degenerate measurement**, not the feature.

### Consequence for the classifier calibration (follow-up, deliberately NOT changed here)

`family.ts:158-159` (`tonal = flat < 0.35`, `flatNoisy = flat >= 0.6`, vocal band
`0.4–0.85`, atmosphere bands) is calibrated for the **0–1 scale** the DSP genuinely
produces. `type.ts` mixes that scale with the degenerate mode's scale **inside one file**:
`noisy = flat > 0.002` (`:129`) and `flat < 0.0008` (`:298`) sit next to
`tonal = flat < 0.3` (`:130`), `tonal = flat < 0.35` (`:449`), `flat >= 0.6` (`:572`) and
`flat >= 0.45 && flat <= 0.75` (`:577`). The calibrations therefore contradict each other
in both directions: `flat = 0.1` is "tonal" to `family.ts:158` and to `type.ts:449`, but
"noisy" to `type.ts:129`; the bands at `:572` and `:577` are unreachable on the
degenerate mode's scale. With the extractor fixed the input is finally a real measurement,
but **STEP87 / STEP95 / STEP91 (the presentation-only X stretch) must be re-derived** on
re-analyzed data. That is a separate, measurement-led step and was intentionally not
folded into this one.

---

## 5. Test hygiene fix (same change set)

Making extraction slower surfaced a latent race in the full suite: an unhandled
`InvalidStateError` from a coalesced live `refreshSearch()` firing after a test had closed
the store (`backgroundIndexing.test.ts`). The code at `app.ts:1294` already *documented*
"a failing re-read must not surface as an unhandled rejection" — but did not catch it.
Both fire-and-forget call sites (`app.ts:1265`, `app.ts:1298`) now honour that documented
contract with `.catch(() => {})`, matching the existing style at `app.ts:1334`.

Baseline `HEAD` did not show the error; the fixed tree ran **three consecutive full suites
with zero errors** (90 files / 1601 tests each).

---

## 6. Verification

| check | result |
|---|---|
| `vitest run` (full) | **90 files / 1601 tests pass** (was 1598; +3) — three consecutive runs, no errors |
| `npm run build` (`tsc --noEmit` + vite) | clean |
| New regression tests | silent lead-in of two different lengths measures identically; a noise burst behind a silent lead-in reports centroid > 0 / flatness > 0.5 instead of the 1/0 pair; a wholly silent buffer keeps the documented default |
| V1↔V2 cross-check | agreement demonstrated on the synthetic corpus (§3) |
| Real-corpus measurement | 500 live records via the public read path (§2) |

---

## 7. Not done here / open

1. **Rollout.** `ANALYSIS_BUILD` (`bootstrap.ts:42`, `"smap-build-v1"`) is the project's
   re-analysis lever: the pipeline skips a record whose `analysisBuild` matches. It was
   **not** bumped, so today only newly analyzed samples benefit; the existing library
   keeps its degenerate features until a re-analysis runs. Bumping it re-fetches and
   re-analyzes every eligible sample (network + CPU) — a resource decision, not a code
   decision.
2. **Published data.** D1 already holds `features-v1` rows with the degenerate values
   (the `content.features` column). Whether to re-publish, version the feature token
   (`features-v1` → `features-v2`), or invalidate reuse for old rows is a contract
   decision that follows from (1).
3. **Recalibration.** STEP87 (X diagnosis), STEP95 (`type.ts` anchors) and STEP91 (the
   presentation-only X stretch in `xCalibration.ts`) are all built on the degenerate
   measurement and should be re-derived once re-analyzed data exists.

---

## 8. Traceability

* Sources: `src/audio/featureExtractor.ts` (`computeSpectral`, `SPECTRAL_HOP`),
  `src/audio/v2Dsp.ts:124-223` (the mirrored V2 aggregation), `src/audio/v2Input.ts`
  (`fromDecodedAudio`), `src/audio/v2Fixtures.ts` (calibration corpus),
  `src/analysis/soundCharacter.ts` (`RANGES.flatness`), `src/classify/hier/family.ts`,
  `src/classify/hier/type.ts`, `src/similarity/similarityFingerprint.ts`,
  `src/map/mapPosition.ts`, `src/global/hydrate.ts`, `src/ui/app.ts`.
* Tests: `src/audio/featureExtractor.test.ts` (12 tests, 3 new).
* Measurement: live global index, public read path only — `GET /map?mapVersion=map-v2`
  and `POST /content/lookup`, 500 content identities. No token, no writes, no audio.
* Non-negotiable bounds honoured: no ML/embeddings, no audio bytes persisted, no external
  service introduced, no D1 schema change, no classifier threshold changed.
