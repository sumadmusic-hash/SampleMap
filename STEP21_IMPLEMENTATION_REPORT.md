# STEP21 — V2 DSP Feature Extraction & Sound Character Calibration — Implementation Report

## 1. Verdict

**STEP21 PASS**

## 2. Executive Summary

STEP21 built the deterministic V2 DSP extractor on top of the frozen V1 V2
contract foundation and calibrated `computeSoundCharacter` against real
extractor output. Decoded PCM (`Float32Array` mono/stereo, transient, never
persisted) is turned, through a pure, sample-rate-independent DSP pipeline, into
the canonical `AudioFeaturesV2` record; the STEP20 SoundCharacter mappings were
then verified relation-by-relation against those extracted features. All
already-existing STEP20 SoundCharacter ranges hold with the real extractor — **no
`soundCharacter.ts` formula change was needed**. The only V2 contract change is
the additive `inharmonicity` field (§26).

| Check | Before (STEP20 end) | After (STEP21) |
| --- | --- | --- |
| `npm run typecheck` | 0 errors | 0 errors |
| App unit tests (`npm test`) | 766 passed | **836 passed** (+69 STEP21, +1 V2-fixture invariant) |
| Global worker tests (`workers/d1-worker`) | 19 passed | 19 passed |
| Playwright E2E (`npx playwright test`) | 70 passed | 70 passed |
| `npm run build` | PASS | PASS (pre-existing chunk-size warning only) |

Every extracted feature record is self-evidenced valid by
`validateAudioFeaturesV2` (NaN/Infinity structurally impossible; absent
quantities `null`, never `0`). A 96 kHz robustness bug (spurious ~47 Hz pitch on
white noise — a CMNDF frame-edge bias) was found during calibration and fixed
with two documented DSP constraints (see §4).

## 3. Changed Files

| File | Change | Evidence |
| --- | --- | --- |
| `src/audio/v2Config.ts` | NEW — single source of truth for DSP magic numbers (`fftSize 2048`, `hopSize 512`, rolloff `.85`, `transientScale 20`, attack `.9` / decay `.37`, pitch window 40–4000 Hz / Cmndf threshold `.3` / max 96 frames, partial floor `.1`, spectral eps, energy floor) + `makeHannWindow`, `nextPow2` | REAL (unit-tested) |
| `src/audio/v2Input.ts` | NEW — `AudioAnalysisInput` (per-channel `Float32Array`), `validateAnalysisInput` / `assertValidAnalysisInput` (TypeError), `fromDecodedAudio` (V1 adaptor, mono), `downmixChannels` (energy-preserving mean, zero-padded) | REAL (unit-tested) |
| `src/audio/v2Dsp.ts` | NEW — `analyzeAudio` deterministic extractor: framing (Hann 2048/512, final frame zero-padded), spectral aggregation (magnitude-weighted centroid/spread/rolloff/flatness/slope + normalized-L1 flux, strongest-frame spectrum), temporal (rms/peak/crest/zcr, RMS-envelope transient/attack/decay), YIN/CMNDF pitch + best-lag-ACF harmonicity, partial-ladder inharmonicity; output forced through `validateAudioFeaturesV2` | REAL (unit-tested) |
| `src/audio/v2Fixtures.ts` | NEW — deterministic 16-signal calibration corpus (seeded mulberry32 noise, closed-form tones), `renderCorpus` / `analyzeCorpus`, `V2_CORPUS_NAMES`, `V2_SAMPLE_RATES` (22050/44100/48000/96000) | FIXTURE (constructed, seeded determinism) |
| `src/analysis/audioFeaturesV2.ts` | MOD — **additive** `inharmonicity: number \| null` (§26): documented, validated `[0,1]`/null, empty-record default `null`; `fromV1AudioFeatures` semantics unchanged | REAL (unit-tested) |
| `src/analysis/fixtures.ts` | MOD — the 5 V2 fixtures carry `inharmonicity: null` (additive field, no other change) | FIXTURE |
| `src/analysis/fixtures.test.ts` | MOD — added inharmonicity-`null` invariant over all V2 fixtures | FIXTURE |
| `src/audio/v2Input.test.ts` | NEW — input contract validation + energy-preserving downmix (14 tests) | REAL |
| `src/audio/v2Dsp.test.ts` | NEW — robustness, channel handling, determinism, feature semantics, inharmonicity semantics (14 tests) | REAL |
| `src/audio/v2Fixtures.test.ts` | NEW — corpus validity/rendering determinism, SR independence across 22050→96000, feature-semantic baseline (26 tests) | FIXTURE + REAL relations |
| `src/analysis/soundCharacter.v2extraction.test.ts` | NEW — computeSoundCharacter calibrated on DSP-extracted corpus: validity, determinism, brightness/tonality/noisiness/transient/dynamics/duration/density/complexity relations (15 tests) | REAL (calibration) |
| `STEP21_IMPLEMENTATION_REPORT.md` | NEW — this report | — |

V1 `src/` files: **unchanged**. The only V1-adjacent change is the additive
optional `analysisV2?` persistence field already introduced by STEP20; no V1
record, no V1 consumer, no audio persistence touched.

## 4. DSP Architecture

Pure, single-pass pipeline (`analyzeAudio`, `src/audio/v2Dsp.ts`). Frequencies
physical Hz, times seconds; `sampleRate` is always read from the input — nothing
is hardcoded to 44.1 k.

- **Framing** — Hann window, FFT-size 2048, hop 512, covering the whole signal;
  final frame zero-padded.
- **Spectral** — per energy-bearing frame: centroid, spread, rolloff (0.85
  energy fraction), flatness (geometric/arithmetic mean over bins ≥ 1), slope
  (OLS of log10(mag) vs log10(freq)). Aggregated magnitude-weighted over frames.
  Flux = mean per-pair L1 distance between consecutive frames' **unit-normalized**
  magnitude spectra (scale-invariant, bounded). The strongest-energy frame's
  magnitude spectrum is kept for the inharmonicity ladder.
- **Temporal** — global rms/peak; crestFactor = peak/rms (`null` when rms ≤ 0);
  zero-crossing rate crossings/(n−1); RMS envelope (512-sample windows) →
  `transientStrength` (positive envelope slew, sequence starts at a silent 0 so a
  first-window onset counts), `attackTimeSec` (first envelope ≥ 0.9·peak),
  `decayTimeSec` (first post-peak drop below 0.37·peak; sustained → `null`).
- **Pitch (YIN/CMNDF)** — ≤ 96 evenly sampled frames (performance cap, eat the
  tail on demand), demeaned DC removal, first normalized-difference dip below
  `pitchCmnfThreshold` (0.3, local-min refined, parabolic interpolation), median
  freq + confidence = 1 − cmndf. Two documented robustness constraints were
  added during calibration:
  1. **Pair-count normalization**: `d(τ) = Σ(x[n]−x[n+τ])² / (N−τ)`. Without it
     the difference function shrinks with `(N−τ)` and the CMNDF collapses toward
     0 as `τ → N`, fabricating deep fake dips near the frame edge.
  2. **Lag floor** `τ_max = N − 1 − floor(N/4)`: at least 512 real pairs must
     overlap, so low-frequency lags (a handful of pairs at `τ ≈ N`) can no
     longer be won by sampling noise.
  Together these fix the observed spurious ~47 Hz pitch with 0.95 confidence on
  **96 kHz white noise** (44.1 kHz had avoided it purely by luck of its
  `τ_max`). All tonal pitch estimates are unaffected.
- **Harmonicity** — mean best-lag **demeaned** normalized |ACF| over the same
  frames, lags confined to `≤ floor(N/2)` (at `τ = N−1` only one pair exists, so
  the correlation is trivially 1 for any signal). Pure tone ≈ 0.999, white noise
  ≈ 0.09–0.10.
- **Inharmonicity (§26)** — on the strongest frame's magnitude spectrum: partials
  = spectral local maxima ≥ 0.1×max, top 8; RMS fractional deviation of each
  partial from the nearest integer multiple `h·pitch` (grid up to h = 32, partials
  allowed ≥ 0.5×pitch). `null` when pitch is null or fewer than two partials are
  measurable — a lone partial cannot express ladder deviation. Noise (no pitch)
  and a single pure tone (one partial) correctly report `null`, not 0.

## 5. SoundCharacter Calibration

`computeSoundCharacter` (STEP20 formulas, unchanged) was applied to the
DSP-extracted corpus. The full measured character table (44100 Hz) — **all
derived values are FIXTURE-class evidence** (constructed corpus, §7):

| signal | brightness | density | transient | duration | tonality | noisiness | dynamics | complexity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| silence | NULL | 0.000 | NULL | 0.344 | NULL | 0.000 | NULL | 0.000 |
| pureTone440 | 0.198 | 0.025 | 0.399 | 0.471 | 0.999 | 0.010 | 0.022 | 0.023 |
| lowSine110 | 0.019 | 0.027 | 0.409 | 0.471 | 0.999 | 0.003 | 0.022 | 0.012 |
| highSine2000 | 0.425 | 0.075 | 0.401 | 0.424 | 0.999 | 0.044 | 0.022 | 0.080 |
| whiteNoise | 1.000 | 0.399 | 0.518 | 0.450 | 0.101 | 0.892 | 0.039 | 0.611 |
| pinkNoise | 0.888 | 0.217 | 0.093 | 0.450 | 0.436 | 0.535 | 0.158 | 0.415 |
| impulse | 1.000 | 0.300 | 0.888 | 0.185 | 0.020 | 0.794 | 0.601 | 0.200 |
| shortClick | 0.301 | 0.339 | 0.872 | 0.265 | 0.983 | 0.018 | 0.266 | 0.064 |
| sustainedTone | 0.157 | 0.016 | 0.397 | 0.609 | 0.999 | 0.007 | 0.022 | 0.012 |
| swellTone | 0.196 | 0.022 | 0.010 | 0.529 | 0.999 | 0.010 | 0.027 | 0.020 |
| decayingTone90 | 0.000 | 0.084 | 0.603 | 0.370 | 0.980 | 0.003 | 0.113 | 0.021 |
| percussiveNoiseHit | 1.000 | 0.523 | 0.686 | 0.311 | 0.126 | 0.887 | 0.167 | 0.615 |
| lowThump | 0.000 | 0.044 | 0.562 | 0.424 | 0.984 | 0.002 | 0.096 | 0.014 |
| highThump | 0.536 | 0.325 | 0.776 | 0.311 | 0.988 | 0.063 | 0.212 | 0.125 |
| detunedHarmonic | 0.175 | 0.019 | 0.511 | 0.471 | 0.998 | 0.007 | 0.019 | 0.023 |
| bellLike | 0.323 | 0.035 | 0.518 | 0.504 | 0.849 | 0.022 | 0.064 | 0.055 |

Every one of these satisfies the STEP20 relational targets (asserted in
`soundCharacter.v2extraction.test.ts`):

- **brightness**: lowSine110 < pureTone440 < highSine2000 < whiteNoise; decayingTone90 darker than pureTone440; silence NULL.
- **tonality/noisiness**: pureTone & shortClick ≈ 0.999/0.983, bellLike 0.849; whiteNoise 0.101 tonal / 0.892 noisy; pink sits between (0.436 / 0.535); percussiveNoiseHit 0.887 noisy; pureTone noisiness < 0.1.
- **transient/dynamics**: impulse 0.888 > shortClick 0.872 > pureTone 0.399 > swellTone 0.010; impulse dynamics 0.601 > pureTone 0.022.
- **duration**: sustainedTone 0.609 > pureTone 0.471 > decayingTone90 0.370; silence duration determinable (< 1).
- **density/complexity**: whiteNoise > pureTone in both; silence dim=0.
- **quality**: pureTone featureCoverage 1.0; silence 0.5.

## 6. Inharmonicity (STEP21 §26 — additive contract)

`inharmonicity: number | null` added to `AudioFeaturesV2` (documented; validated
finite `[0,1]` or `null`; NaN/Infinity rejected; `null` = "not determinable",
**never** 0; empty-record default `null`; the five V2 fixtures now carry
`inharmonicity: null`). Measured on the extracted corpus (44100 Hz):

| signal | pitch | inharmonicity | interpretation |
| --- | --- | --- | --- |
| pureTone440 | 440.019 | NULL | single partial — no ladder |
| whiteNoise | NULL | NULL | no pitch determinable |
| detunedHarmonic (220 + 660) | 220.001 | **0.019** | mild deviation |
| bellLike (440 + 1200 + 1900) | 399.020 | **0.061** | strong deviation |

Tested semantics: `bellLike > detunedHarmonic > (pure/white = null)`; noise never
fabricates a value (§40).

## 7. Evidence Classification (§15)

- The calibration corpus is **FIXTURE-class**: every signal is synthesized
  deterministically (seeded `mulberry32` PRNG for noise, closed-form math for
  tones) from just its name + sample rate, so all corpus-derived values in this
  report (§5, §6, §8) are fixture evidence, **never** "REAL audio evidence".
- The DSP *behavior* tests (correctness of the math applied to constructed
  input, robustness, determinism, channel handling) are REAL for the algorithm.
- No recorded/real-world audio was analyzed anywhere in STEP21.

## 8. Sample-Rate Independence & Performance

Physical features (frequencies, times, energies) are invariant across sample
rate; bandwidth-limited ratio features are rate-invariant by construction.
Measured across 22050 / 44100 / 48000 / 96000 (44100 = reference):

| signal | pitch@22050/44100/48000/96000 | rms (all) | harmonicity (all) | centroid (Hz) range |
| --- | --- | --- | --- | --- |
| pureTone440 | 440.09 / 440.02 / 440.02 / 440.00 | 0.3526 | 0.995–0.998 | 449.1–464.1 |
| sustainedTone | 330.03 / 330.01 / 330.00 / 330.00 | 0.3533 | 0.998 | 332.1–336.3 |
| swellTone | 440.09 / 440.02 / 440.02 / 440.00 | 0.3291 | 0.994–0.998 | 445.9–455.8 (attack 0.181–0.187 s) |
| decayingTone90 | 90.22 / 90.23 / 90.22 / 90.18 | 0.1696 | 0.990–0.997 | 90.3–91.3 (decay 0.046–0.058 s) |
| whiteNoise | NULL / NULL / NULL / NULL | 0.2884–0.2889 | 0.086–0.101 | 5515 → 23999 (noise bandwidth scales with Nyquist — **expected**, flatness 0.845 constant) |

The low-pitch measurement floor at high rates is the documented `τ_max` lag
budget (≥ 512 overlapping pairs): at 22050/44100/48000 the configured 40 Hz
floor applies; 96000 reaches ≈ 62.5 Hz, so sub-63 Hz pitch is deliberately
deferred to the ≤ 48 k regime (corpus low tones > 63 Hz are pitchable at every
rate).

Performance (44100 Hz, `pitchMaxFrames = 96` caps the pitch pass; spectral loop
dominates):

| audio duration | samples | wall time | real-time factor |
| --- | --- | --- | --- |
| 0.1 s | 4 410 | ≈ 12 ms | ≈ 0.12 |
| 0.5 s | 22 050 | ≈ 58 ms | ≈ 0.12 |
| 1 s | 44 100 | ≈ 114 ms | ≈ 0.11 |
| 5 s | 220 500 | ≈ 147 ms | ≈ 0.03 |
| 30 s | 1 323 000 | ≈ 275 ms | ≈ 0.009 |
| 60 s | 2 646 000 | ≈ 430 ms | ≈ 0.007 |

## 9. Determinism & Robustness

- **Determinism**: identical input → byte-identical features (seeded noise,
  pure math, no PRNG, no nondeterministic iteration). Asserted for the corpus
  and for repeated `analyzeAudio` calls.
- **Total function**: invalid inputs (non-object, missing contract, `sampleRate ≤ 0`
  / NaN / Infinity, empty channel list, non-`Float32Array`, non-finite sample)
  throw a descriptive `TypeError`; degenerate-but-determinable signals (empty
  channel, all-zero buffer) analyze to the safe all-`null`/0 silence record —
  `null` (never `0`) wherever a quantity is not determinable.
- **Channel handling**: mono vs duplicated-stereo reproduce identical features
  (energy-preserving mean — verified), a silent channel halves a voiced channel's
  amplitude, shorter channels zero-pad to the longest, inputs never mutated.
- The extractor validates its own output before returning; a violation would
  raise, never emit invalid features.

## 10. Compatibility

- **V1 frozen (ABSOLUTE V1 FREEZE):** no V1 file changed; V1 index/search/map/
  classify/UI regression is green before and after (§2).
- **V2 contract change is additive only:** `inharmonicity` — every existing
  record/validator/fixture stays valid; `null` is the neutral default.
- **STEP20 non-negotiable contracts intact:** `SOUND_CHARACTER_DIMENSIONS` order,
  `V2_SIMILARITY_WEIGHTS` sum-1 (FP-tolerant), `toSimilarityVector` order,
  `MapProjector` baseline, `SampleAnalysisV2` "2.0.0", worker messages type-only,
  `assertNoAudioBytes` on records, no auto-migration.

## 11. Security

No new attack surface: no remote sends, no external APIs or ML, no credentials,
no auth/E-P7 bypass, no auto-publish, no new dependencies. The extractor runs
entirely on in-memory decoded PCM and produces metadata only; §40
no-audio-persistence invariant holds (audio exists only on the worker request
message, transient + transferable, never written through the index store).

## 12. Scope Control (§37–§39 — deliberately NOT implemented)

- No UI: no maps, similar-select, find-similar, analysis panels, no demo page.
- No ML / embedding / online-NN; no clustering; no UMAP/t-SNE/PCA.
- No V2 publish; V2 analysis not stored on records.
- No worker wiring: V2 worker messages remain type-only contracts; the only
  worker project (global publish worker) is untouched; the app still has no
  in-app analysis Worker.
- No V1 change of any kind.

## 13. Known Limitations / Not Tested

- All corpus evidence is FIXTURE-class (constructed signals); "REAL audio
  evidence" is not produced by this step by design (§15).
- Pitch at 96 kHz is limited to ≥ ≈ 62.5 Hz by the ≥ 512-pair lag overlap rule;
  the corpus's > 63 Hz tones are all correctly pitched at 96 kHz. Sub-63 Hz
  sources at very high sample rates fall back to 44.1 k sampling where the floor
  is ≈ 28 Hz.
- `transientStrength` of stationary noise is envelope-window-resolution limited
  and is therefore only asserted within a sample-rate-tolerance band in tests,
  not as an exact invariance.
- The report's performance numbers are single-run measurements at 44100 Hz
  (see §8); formal benchmark CI is out of scope.

## 14. Verification Commands

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | 0 errors |
| Unit tests | `npm test` | 836 passed (48 files) |
| Global worker tests | `npm test` (workers/d1-worker) | 19 passed |
| E2E | `npx playwright test` | 70 passed |
| Build | `npm run build` | PASS (pre-existing chunk-size warning only) |

## 15. Conclusion

STEP21 passes: the deterministic, sample-rate-independent V2 DSP extractor
produces valid `AudioFeaturesV2` over decoded PCM, the corpus calibration
confirms every STEP20 SoundCharacter relational target against real extractor
output with zero formula changes, the additive `inharmonicity` contract is
implemented and tested, the 96 kHz CMNDF edge artifact was root-caused and fixed,
and the frozen V1 baseline plus all STEP20 contracts remain fully green.

## 16. Next Step

**STEP22 — Similarity Engine Productization & Validation**