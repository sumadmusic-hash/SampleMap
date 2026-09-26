# STEP20 — V2 Architecture Foundation — Implementation Report

## 1. Verdict

**STEP20 PASS**

## 2. Executive Summary

STEP20 laid the V2 architecture foundation on top of the frozen V1: the
canonical V2 data contracts and the pure service boundaries for the SampleMap
analysis domain were defined, implemented and unit-tested — **without changing
V1 behavior**. The complete V1 baseline regression stays green before and after
the change:

| Check | Before (STEP19A end) | After (STEP20) |
| --- | --- | --- |
| `npm run typecheck` | 0 errors | 0 errors |
| App unit tests (`npm test`) | 681 passed | **766 passed** (+85 V2) |
| Global worker tests (`workers/d1-worker`) | 19 passed | 19 passed |
| Playwright E2E (`npx playwright test`) | 70 passed | 70 passed |
| `npm run build` | PASS | PASS (pre-existing chunk-size warning only) |

V2 contributes the analysis domain (`src/analysis/`) with typed contracts,
validation, a deterministic baseline SoundCharacter derivation, a pure
SimilarityEngine, a map projection boundary, worker message contracts, a lossless
serialization round-trip, deterministic fixtures, and an **additive** `analysisV2?`
field on the persisted record. No V1 record is auto-migrated, no audio bytes are
ever persisted, and no V1 consumer was touched.

## 3. Changed Files

| File | Change | Evidence |
| --- | --- | --- |
| `src/analysis/config.ts` | NEW — canonical SoundCharacter dimension order + V2.0 similarity weights + weight-shape validation | REAL (unit-tested) |
| `src/analysis/normalize.ts` | NEW — `clamp01`, `normalize`, `logNormalize`, `mapPresentFields`, `weightedMean` (missing-dim renormalization, safe-state `null`) | REAL (unit-tested) |
| `src/analysis/audioFeaturesV2.ts` | NEW — `AudioFeaturesV2` contract (null semantics), `validateAudioFeaturesV2` (NaN/Infinity rejection), `fromV1AudioFeatures` adaptor | REAL (unit-tested) |
| `src/analysis/soundCharacter.ts` | NEW — `SoundCharacter`, `SoundCharacterQuality`, `computeSoundCharacter` (V2.0 deterministic baseline mappings), `computeSoundCharacterQuality`, `validateSoundCharacter`, `toSimilarityVector` (stable order) | REAL (unit-tested) |
| `src/analysis/similarityEngine.ts` | NEW — `SimilarityEngine` boundary, weighted-Euclidean similarity with shared-dim renormalization, `SimilarityConfig` (V2.0 weights, `"2.0.0"`) | REAL (unit-tested) |
| `src/analysis/mapProjector.ts` | NEW — `MapProjector` boundary + deterministic baseline projector (no UMAP/t-SNE/PCA), version `"2.0.0"` | REAL (unit-tested) |
| `src/analysis/sampleAnalysisV2.ts` | NEW — `SampleAnalysisV2` aggregate, `analysisVersion: "2.0.0"`, structural validation, lossless JSON round-trip | REAL (unit-tested) |
| `src/analysis/workerContract.ts` | NEW — typed `AnalyzeSampleRequestV2` / `AnalyzeSampleResponseV2` / `AnalyzeSampleErrorV2` worker messages (type-only boundary; NOT wired) | REAL (unit-tested) |
| `src/analysis/fixtures.ts` | NEW — deterministic fixtures SILENCE / PURE TONE / WHITE NOISE / IMPULSE / SHORT PERCUSSION | FIXTURE (handcrafted; asserted by invariants) |
| `src/persistence/indexStore.ts` | MOD — **additive** optional `analysisV2?: SampleAnalysisV2` on `SampleIndexRecord`; no other change | REAL (persistence round-trip) |
| `src/analysis/*.test.ts` (8 files) + `src/persistence/v2Persistence.test.ts` | NEW — 85 V2 unit tests | REAL / FIXTURE |
| `STEP20_IMPLEMENTATION_REPORT.md` | NEW — this report | — |

V1 `src/` files other than the single additive field above: **unchanged**.

## 4. Architecture

Clarity rule adopted: RAW DSP FEATURES → PERCEPTUAL SOUND CHARACTER →
SIMILARITY SPACE → MAP PROJECTION are four distinct layers. No layer collapses
into another and no layer touches audio bytes or persistence:

- **Raw features** — `AudioFeaturesV2`: physical magnitudes (`>= 0`) vs
  normalized ratios (`[0, 1]`); nullable fields mean "not determinable",
  `null` is never substituted with `0`, NaN/Infinity are rejected by
  `validateAudioFeaturesV2`.
- **SoundCharacter** — 8 dimensions in `[0, 1]` (or `null`): brightness,
  density, transient, duration, tonality, noisiness, dynamics, complexity.
  Derived by `computeSoundCharacter` via **V2.0 deterministic baseline
  mappings** (see formula table below) — transparent, documented, subject to
  STEP21 calibration.
- **Similarity** — `SimilarityEngine.similarity(a, b) ∈ [0, 1]` (or `null`),
  self = 1, symmetric, deterministic. Weighted Euclidean distance over SHARED
  dimensions with weights renormalized to sum 1; 0 shared dimensions is a
  documented safe-state `null` (never 0). Weights:
  brightness .16 · density .12 · transient .18 · duration .08 · tonality .12 ·
  noisiness .12 · dynamics .10 · complexity .12 (sum = 1).
- **Map projection** — `MapProjector.project(char) → {x, y} ∈ [0, 1]²`,
  deterministic, no corpus dependence, no UMAP/t-SNE/PCA. Baseline projector:
  weighted means of the vector over two fixed, documented weight sets; neutral
  center (0.5, 0.5) when nothing is determinable. The V1 `map-v2` algorithm is
  untouched.

### V2.0 baseline SoundCharacter formula table (`computeSoundCharacter`, §4)

| Dimension | Inputs (each independently null-aware) | Weights |
| --- | --- | --- |
| `brightness` | log-normalized spectralCentroidHz [100, 10000] ; normalized spectralRolloffHz [1000, 15000] | 0.6 / 0.4 |
| `density` | normalized spectralFlux [0, 2] ; zeroCrossingRate [0, 0.5] ; transientStrength [0, 20] | 0.4 / 0.3 / 0.3 |
| `transient` | (1 − norm attackTimeSec [0.0005, 0.05]) ; transientStrength [0, 20] ; crestFactor [1, 20] | 0.5 / 0.3 / 0.2 |
| `duration` | log-normalized durationSec [0.01, 60] | 1 |
| `tonality` | pitchConfidence ; harmonicity | 0.6 / 0.4 |
| `noisiness` | spectralFlatness [0, 1] ; (1 − harmonicity) ; zeroCrossingRate [0, 0.5] | 0.5 / 0.3 / 0.2 |
| `dynamics` | normalized crestFactor [1, 20] ; decayTimeSec [0.001, 5] | 0.6 / 0.4 |
| `complexity` | normalized spectralFlux [0, 2] ; zeroCrossingRate [0, 0.5] ; spectralSpreadHz [50, 5000] | 0.5 / 0.3 / 0.2 |

Quality (`SoundCharacterQuality`): `overall` = V2-weight-weighted mean of the
present dimension values; `featureCoverage` = fraction of the 8 dimensions that
are determinable. Both in `[0, 1]`.

## 5. Compatibility

- **V1 untouched** — only `SampleIndexRecord` gained one OPTIONAL field.
  `isWellFormedIndexRecord`, `assertNoAudioBytes`, `get`/`getAll`, the search /
  map / similarity / publish projection paths and the whole UI are byte-identical
  in behavior.
- **Additive, not migrating** — `analysisV2?` is absent on V1 records; records
  without V2 remain readable (`get` returns them, `analysisV2` is `undefined`, no
  re-analysis, no auto-migration; verified in `v2Persistence.test.ts`).
- **V1→V2 adaptor** (`fromV1AudioFeatures`) — equivalent V1 fields are carried
  under their V2 names (e.g. `duration` → `durationSec`, `spectralCentroid` →
  `spectralCentroidHz`, `attack` → `attackTimeSec`); genuinely different
  quantities (`transientDensity` vs `transientStrength`, `tonalNoiseRatio` vs
  `harmonicity`, pitch map) become `null` instead of being fabricated.
  `crestFactor` is derived from the equivalent V1 peak/rms pair.
- Independent version constants are kept separate: `analysisVersion`,
  `mapAlgorithmVersion`, `similarityAlgorithmVersion` are each the string
  `"2.0.0"` (no merged global version counter).

## 6. Tests

New V2 tests (85), all co-located per repo convention and labeled:

| Suite | Tests | Evidence |
| --- | --- | --- |
| `src/analysis/normalize.test.ts` | 13 | REAL |
| `src/analysis/audioFeaturesV2.test.ts` | 12 | REAL |
| `src/analysis/fixtures.test.ts` | 6 | FIXTURE (invariant-based) |
| `src/analysis/soundCharacter.test.ts` | 18 | REAL + FIXTURE |
| `src/analysis/similarityEngine.test.ts` | 14 | REAL |
| `src/analysis/mapProjector.test.ts` | 6 | REAL |
| `src/analysis/sampleAnalysisV2.test.ts` | 8 | REAL |
| `src/analysis/workerContract.test.ts` | 5 | REAL |
| `src/persistence/v2Persistence.test.ts` | 3 | REAL |

Key verified behaviors: weighting sum = 1 (FP-tolerant); `[0,1]` bounds; NaN /
Infinity rejection on every present field; `null != 0` on nested round-trips;
similarity self = 1, symmetry, shared-dim renormalization, 0-shared-dims →
`null`; projector determinism + unit-square bounds + neutral center; fixture
invariant orderings (tonality PURE_TONE > SHORT_PERCUSSION > IMPULSE >
WHITE_NOISE; noisiness WHITE_NOISE highest, PURE_TONE lowest; transient
IMPULSE > SHORT_PERCUSSION > …; duration IMPULSE shortest); V1 record +
`analysisV2` add → read → V1 unchanged; `assertNoAudioBytes` holds on V2
records; structured-clone (request) and JSON (response) round-trips.

Full regression (all REAL, see §2): App 766/766 · Worker 19/19 · E2E 70/70 ·
Build PASS.

## 7. Invariants

- No audio bytes in any V2 analysis / contract / persisted record
  (`assertNoAudioBytes` enforced on records; `audio: ArrayBuffer` exists ONLY on
  the worker request message, transient + transferable, never persisted).
- `null` is the only "not determinable" marker — never `0`; NaN/Infinity are
  always rejected.
- Every SoundCharacter dimension in `[0, 1]` (or null); vectors use the stable
  canonical order; weights sum to 1 (FP-tolerant).
- Similarity: self = 1, symmetric, `[0, 1]`, deterministic, audio-free.
- Map projection: deterministic, `[0, 1]²`, corpus-independent.
- V1 behavior byte-identical (see §5); V1 baseline regression fully green.

## 8. Persistence

Verified by `v2Persistence.test.ts` with a real fake-indexeddb round-trip:
write a V1 record → read → add `analysisV2` → put → read → the V2 analysis is
byte-identical and **every V1 field is unchanged** after stripping the additive
field. A V1-only record reads back without `analysisV2` (no auto-migration).
Full JSON → IndexedDB round-trip also passes. Schema version (`SCHEMA_VERSION`)
is unchanged because the field is optional/additive — existing stores require no
migration, which is the correct minimal versioning decision for an optional
metadata field.

## 9. Security

No new attack surface: no remote sends, no external ML APIs, no credentials, no
auth bypass, no E-P7 bypass, no auto-publish, no new dependencies. V2 analysis
remains entirely local and metadata-only. `assertNoAudioBytes` continues to
reject any audio byte container written through the index store, including on
records carrying V2 analysis.

## 10. Scope Control

Deliberately NOT implemented (STEP21+ scope): a V2 DSP feature extractor, any
pipeline wiring of V2, V2 map rendering / similar-select / find-similar UI,
ML / ONNX / TF / embeddings / UMAP / t-SNE / PCA, clustering, and any change to
V1 `map-v2`, similarity-v1 fingerprint, classification or the UI. No new
dependencies were added. The worker messages are contract types only — no
worker instance is created or wired (confirmed by inspection: the app has no
in-app analysis Worker; the only worker project is the global publish worker,
which is metadata-only).

## 11. Known Limitations / Not Tested

- `AudioFeaturesV2` fixtures are **FIXTURE-class** evidence (handcrafted, not
  produced by a DSP extractor; extraction is STEP21+ scope). They are used only
  to test the contracts/engines deterministically; their invariant ordering is
  the documented source of truth.
- The V1→V2 adaptor maps only equivalent fields; pitch/harmonicity-like V2
  fields are `null` for V1-derived data until a V2 extractor exists.
- No performance experiments were run (no corpus, no real audio).
- `AnalyzeSampleErrorV2` is structurally typed but no producer/consumer exists
  yet (worker unwired by design).
- Map projector is a deterministic baseline only — deliberately not a
  perceptual layout; calibration is STEP21 scope.

## 12. Next Step

**STEP21 — Sound Character Engine Calibration / Productization**
(End of step — do not continue past this point without a new STEP21 brief.)