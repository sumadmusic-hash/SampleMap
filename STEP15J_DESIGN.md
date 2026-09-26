# STEP 15J DESIGN — Perceptual Similarity / Find Similar (design-only)

**Date**: 2026-09-02
**Scope**: Technical design only. No production code, no tests were authored in
	this step. Baseline confirmed: 287 tests / 21 files — tsc clean — build OK.

**Production files changed**: 0
**Production files created**: 0

---

## A. Current State (evidence-based)

Everything below is taken from the running code at the time of writing; nothing
invented.

### Feature extractor (`src/audio/featureExtractor.ts`)

`extractFeatures` is a pure function `DecodedAudio -> AudioFeatures`. The actual
feature set (code-verified, `FFT_SIZE = 1024`):

| # | Feature              | Domain            | How it is computed (from code) |
|---|----------------------|-------------------|-------------------------------|
| 1 | `duration`           | seconds, >= 0     | full duration of the mono PCM |
| 2 | `sampleRate`         | Hz                | metadata (source-dependent)   |
| 3 | `channels`           | int               | metadata (source-dependent)   |
| 4 | `rms`                | amplitude         | whole signal                  |
| 5 | `peak`               | amplitude         | whole signal                  |
| 6 | `transientDensity`   | transients/sec    | whole signal, envelope +/- mean+std threshold, |rise| x1.3 |
| 7 | `spectralCentroid`   | Hz                | FFT, Hann, **first min(n,1024) samples only** |
| 8 | `spectralBandwidth`  | Hz                | FFT, same onset window        |
| 9 | `spectralRolloff`    | Hz (85%)          | FFT, same onset window        |
|10 | `zeroCrossingRate`   | 0..1              | whole signal                  |
|11 | `spectralFlatness`   | 0..1              | FFT, same onset window        |
|12 | `attack`             | seconds           | time to 90% of max envelope, whole signal |
|13 | `tonalNoiseRatio`    | 0..1              | `clamp(1 - flatness)` — exactly complementary to #11 |

> **Structural limitation (code fact)**: features 7, 8, 9, 11, 13 are computed
> over **only the first 1024 PCM samples** (at 48 kHz that is ~21 ms of audio —
> an *onset snapshot*). They carry no information about the rest of the sample
> (e.g. a long tail). This is already true for the map (map `Y` uses
> `spectralCentroid` from the same onset window).

### Versions already in the system (must stay distinct)

| Constant | Value | Where |
|----------|-------|-------|
| `ANALYSIS_VERSION` (default) | `features-v1` | `src/ui/bootstrap.ts`, `src/pipeline/analysisPipeline.ts` |
| `CANONICAL_PCM_VERSION` | `pcm-v1` | `src/audio/canonicalPcm.ts` |
| `contentHashVersion` | inherits `pcm-v1` | identity records |
| `REPRESENTATIVE_VERSION` | `representative-v1` | `src/identity/audioContentIdentity.ts` |
| `mapVersion` | `map-v1` | `src/map/mapPosition.ts` |
| classifier version | `heuristic-v1` | `src/classify/heuristicClassifier.ts` |

### Existing related artifacts

- `AudioContentIdentity { contentHash, contentHashVersion }`,
  `contentIdentityKey = "version:hash"`, `selectRepresentative()` (lex-smallest
  sampleId), `REPRESENTATIVE_VERSION = "representative-v1"`.
- `MapPoint` now carries `sampleId` (representative) + `sampleIds[]` +
  `contentIdentity`; `mapPoints()` dedups by identity (1 identity = 1 point).
- Pipeline persists `analysisSourceFormat`, `fileHash`, `contentHash`,
  `contentHashVersion`; records carry `analysisVersion`.
- `assertNoAudioBytes` guard (no PCM/raw bytes in the index).
- Quality gate (`GATE_REJECT`) and container gate run **before** hashing; a
  decode failure → `skipped DECODE_FAILED`.

---

## B. Investigation mandate: can the existing feature base serve V1 similarity?

**Verdict: YES for a defensible V1 — with one documented structural
limitation.**

- The **time-domain / temporal features** (`duration`, `transientDensity`,
  `zeroCrossingRate`, `attack`) are whole-signal and reliable.
- The **spectral features** are onset-only (first 1024 samples). For one-shot
  sample libraries (kicks, snares, hats — the classic SampleMap domain) the
  onset *is* the discriminative part, so exclusion distance is still
  meaningful. For long evolving pads/ambience the onset snapshot alone is
  weaker, but the time-domain features still differentiate.
- Therefore: **V1 reuses the existing extractor unchanged.** No new DSP, no new
  FFT, no ML. This also keeps sharing work with the distributed-analysis goal
  (the fingerprint is a pure function of the already-computed features).

**Optional, non-blocking `similarity-v2` path (design only, explicitly NOT
required for 15J):** average `spectralCentroid/Bandwidth/Rolloff` and a
per-octave-band RMS profile over all hop windows (reuse the existing `computeSpectral`
per window, `hop = 256`). Deterministic, stays in the pure extractor, no ML.
Defer until a qualitative validation of V1 ranking shows onset-only artifacts
matter (§O3).

---

## C. Feature selection for the similarity fingerprint

Selected **8 components** (explicit ordering, fixed by version `similarity-fp-v1`):

| idx | Feature            | Weight | Rationale |
|-----|--------------------|--------|-----------|
| 0   | `duration`         | 0.10   | length is part of identity; varies only when content differs |
| 1   | `zeroCrossingRate` | 0.10   | cheap roughness proxy, whole-signal |
| 2   | `transientDensity` | 0.15   | rhythmic/drum character |
| 3   | `attack`           | 0.10   | envelope shape (struck vs sustained) |
| 4   | `spectralCentroid` | 0.20   | brightness (onset snapshot) |
| 5   | `spectralBandwidth`| 0.15   | spectral spread |
| 6   | `spectralRolloff`  | 0.10   | energy up to 85% |
| 7   | `tonalNoiseRatio`  | 0.10   | tonal vs noisy (uses `1-flatness`; flatness itself excluded to avoid exact redundancy) |

Excluded deliberately:
- `rms`, `peak` — loudness is a mixing attribute, not identity; a quieter
  recording of the same performance should stay "similar". (If a later version
  wants loudness sensitivity, add them under a version bump.)
- `sampleRate`, `channels` — metadata, already canonicalized to 48 kHz mono;
  they carry no similarity content after canonicalization.
- `spectralFlatness` — perfectly correlated with `tonalNoiseRatio`.

Weight sum = 1.0. Weights are part of the fingerprint/engine version and are
tunable only by bumping that version (§F).

---

## D. Normalization (deterministic, no corpus statistics)

Required invariant: identical in-browser vs server output, incremental and
stateless — **no z-scores, no min/max over a corpus snapshot** (results would
change with index size and across users). Use *fixed, documented global bounds*
per component with monotone log-compression for skewed features and clamp to
[0, 1]:

| Component            | Transform                     | Fixed bounds      |
|----------------------|-------------------------------|-------------------|
| `duration`           | `log10(d)` clamp              | 0.01 s … 60 s     |
| `zeroCrossingRate`   | direct clamp                  | 0 … 1             |
| `transientDensity`   | direct clamp                  | 0 … 20 /s         |
| `attack`             | `log10(a)` clamp              | 0.001 s … 1 s     |
| `spectralCentroid`   | `log10(Hz)` clamp             | 100 … 8000 Hz (same axis as map `Y`) |
| `spectralBandwidth`  | `log10(Hz)` clamp             | 50 … 5000 Hz      |
| `spectralRolloff`    | `log10(Hz)` clamp             | 100 … 10000 Hz    |
| `tonalNoiseRatio`    | direct clamp                  | 0 … 1             |

`clamp(x, lo, hi)` and log bounds are constants in the version — fully
deterministic, cross-runtime reproducible (IEEE-754 double math, same standard
libs the rest of the pipeline relies on).

---

## E. Distance and similarity score

- **Distance**: weighted Euclidean over the normalized 8-vector:

  ```
  d = sqrt( sum_i w_i * (q_i - t_i)^2 ) / sqrt( sum_i w_i )
  ```
  Division by `sqrt(sum w)` normalizes to `d in [0,1]` (w sum = 1 → `d in [0,1]`).

- **Similarity score**: `similarity = 1 - d`, domain [0,1]; shown to the user as
  integer percent.

Why weighted Euclidean (not cosine, not Manhattan):
- Preserves magnitude meaning of `duration`/`attack` (cosine ignores magnitude
  and would over-rate "same direction, different length").
- Monotonic, bounded, cheap (8 dims, no sorting needed beyond top-k scan).
- Deterministic; no parametrization beyond the versioned weights.

---

## F. Fingerprint data model and versioning

```ts
// Design proposal — NOT implemented in 15J.
type SimilarityFingerprint = {
  similarityVersion: "similarity-v1";      // engine/weights/distance revision
  values: number[];                        // 8 normalized components, fixed order (§C)
};
```

Rules:
- `similarityVersion = "similarity-v1"` distinct from
  `analysisVersion / contentHashVersion / representativeVersion / mapVersion`
  (each owns its own revision; bumping one never cascades).
- Changing any of {feature selection, weights, bounds, distance formula} →
  bump `similarityVersion`; old fingerprints are not mixed into new comparisons
  (engine compares only records whose `similarityVersion` matches the query's).
- **Invariant: equal `contentHash` ⇒ equal fingerprint** (fingerprint is a pure
  function of features, which derive from the same canonical PCM). Verified by
  test, not assumed.
- Serialization: `{ similarityVersion, values }` (8 doubles) — compact
  (~100 bytes JSON), no typed arrays (falls inside `assertNoAudioBytes`), no
  audio bytes, browser-computable, server-comparable.

---

## G. Find Similar: query semantics

**Inputs**:
1. **Existing sample** (selected representative): use its persisted
   fingerprint directly (no re-download, no re-analysis).
2. **New local file** (prospective): run container gate → decode → canonicalize
   → extract → fingerprint; do **not** persist; search only. Decode failure →
   user-visible "cannot analyze" (same gate reasons as pipeline).

**Matching** (V1, exhaustive scan over the local index):
- Normalize bounds + weights are the query's `similarityVersion` group only.
- Exclude the probe identity: skip records with
  `contentIdentityKey(candidate) === contentIdentityKey(query)`
  (equal `contentHash` ⇒ already the same Map Point; **never** a separate
  Similar result).
- Deduplicate results by `contentIdentityKey` (mirrors `mapPoints()`).
- Sort descending by `similarity`; return top `N`.

**Find Similar result object** (one per content identity):
```ts
// Design proposal — NOT implemented in 15J.
type SimilarSampleResult = {
  contentIdentity: AudioContentIdentity; // identity, alternate sampleIds resolvable via index
  representativeSampleId: string;        // 15I representative
  similarityVersion: "similarity-v1";
  similarityScore: number;               // 0..1
};
```

**UI enrichment** (data already in the index; no new storage): resolved
through `representativeSampleId` — name, class + confidence, play audio. The
similarity value `X %` is displayed only for the probes; it is a *ranking* knob,
never a confidence in classification and never a quality gate.

---

## H. Map distance != similarity

The map is a fixed 2-D projection `(tonalNoiseRatio, log centroid)` — two of
the eight fingerprint dims, and the centroid one is onset-only. Near-on-map
does **not** imply near in 8-D (e.g. same centroid+tonality, very different
`duration`/`transientDensity`). No map-distance weighting is used. Find Similar
runs in fingerprint space only.

---

## I. Result limit

- Default `top 10`, configurable `5 / 10 / 20`.
- V1: exhaustive scan is `O(indexRecords * 8)`, browser-trivial at sample
  library scale (thousands); the top-k cost is negligible.

---

## J. Scaling: V1 vs "millions of samples" (design note, no code)

- **V1 (now)**: exhaustive weighted-Euclidean scan over the local index. No
  ANN, no codec, no WASM. Correct and bounded for the current library sizes.
- **Later (requires its own step, not 15J)**: segment the index by coarse
  features (e.g. class + a few fingerprint dims as a bucketing key) to get
  candidate subsets, then exact distance within candidates, then optionally an
  ANN index (HNSW/IVF) keyed on the same versioned fingerprint. All later, all
  behind the same `similarityVersion` gating so a future engine swap is a
  drop-in that never mixes revisions.
- Explicit non-goal for 15J: ML models, neural nets, cloud embeddings, TF/ONNX/
  GPU, ANN index.

---

## K. Distributed analysis / reuse

Identical to the 15H/15I strategy:
- The fingerprint is derived **once per unique content identity**, by the first
  user who analyzes it, and persisted like `contentHash`.
- Later users whose probe hits an existing `contentIdentityKey` **reuse** the
  stored fingerprint — zero re-analysis, zero re-download of the audio.
- Local retrieval path (prospective file) pays only the gate + decode + extract
  for that probe; nothing is persisted.
- No audio bytes, no waveform storage anywhere.

---

## L. Storage

- New optional persisted field on the sample index record:
  `similarityFingerprint?: SimilarityFingerprint` (like `fileHash`/`contentHash`
  in 15H), written transiently by the pipeline after extraction. Present only
  when analysis succeeded and fingerprint derivation succeeded.
- Satisfies `assertNoAudioBytes` (plain `string` + `number[]`).
- No separate tables, no new endpoints beyond the Find Similar query route.
- Records carrying `similarityVersion != "similarity-v1"` are excluded from
  comparisons of `similarity-v1` (never silently mixed; not migrated in 15J).

---

## M. Test plan (for the follow-up implementation step)

Mirror the 15I style (17 tests → equivalence class + determinism). Reuse
existing synthetic helpers (`tone`, `noise`, `silence`, `impulse`,
`buildPcmWavBytesWithExtraChunk`).

1. **Fingerprint determinism**: same `DecodedAudio` twice → identical
   fingerprint; re-run of extraction → identical values.
2. **Content-hash ⇒ fingerprint**: same PCM via two containers (WAV vs
   WAV-with-extra-chunk) → identical fingerprint.
3. **Loudness-invariance**: same sample scaled to different amplitudes
   (different `rms`/`peak`) → identical fingerprint (rms/peak excluded).
4. **Version gating**: fingerprints of two `similarityVersion`s are never
   compared.
5. **Query-identity exclusion**: matching identity → excluded (never a
   separate Similar result).
6. **Dedup by content identity**: two records, one identity → a single result.
7. **Distance/similarity golden values**: hand-computed `d`/`score` for a fixed
   pair of fingerprints (guards formula + bounds + weights drift).
8. **Ranking known pairs**: `tone(220)` vs `tone(240)` score > `tone(220)` vs
   `noise`; `impulse` vs `tone` clearly lower than two related `tone`s.
9. **Result limit**: query with >N matched identities returns exactly N,
   sorted descending.
10. **Storage invariant**: persisted record with fingerprint passes
    `assertNoAudioBytes`.

---

## N. Version strategy (per-version table)

| Concern                  | Version constant          | Value (this design)  |
|--------------------------|---------------------------|----------------------|
| Analysis features        | `ANALYSIS_VERSION`        | `features-v1` (unchanged) |
| Canonical PCM / contentHash | `CANONICAL_PCM_VERSION` / contentHashVersion | `pcm-v1` (unchanged) |
| Representative selection | `REPRESENTATIVE_VERSION`  | `representative-v1` (unchanged) |
| Map projection           | `mapVersion`              | `map-v1` (unchanged) |
| Similarity fingerprint   | `similarityVersion`       | **`similarity-v1` (new)** |

No other version is touched. Bumping `similarity-v1` → `similarity-v2` only
affects Find Similar.

---

## O. Open questions (real, unanswered — none hidden)

- **O1**: Is a real WAV vs a real FLAC of the same sample → equal
  `contentHash` → equal fingerprint? **NOT VERIFIED** (inherited from 15H/15I;
  needs an authenticated live probe; the design does not claim it VERIFIED).
- **O2**: Does the onset-only spectral window produce acceptable V1 ranking on
  real-world long samples (pads/ambience beyond ~21 ms)? Needs a small manual
  validation after implementation; if it fails, the §B `similarity-v2` path is
  the fix (no architecture change).
- **O3**: Are the §C weights perceptually right? Orthogonal to the design;
  tunable in a later version bump without touching structure.
- **O4**: ANN engine for million-scale — explicitly deferred; revisit in a
  later step.

---

## P. Explicit exclusions (frozen for this step)

- No similarity check design for classification, map position, or quality.
- No ANN, no ML, no embeddings, no cloud AI, no TF/ONNX/GPU/WASM codecs.
- No change to any existing version constant, gate, pipeline stage, or UI
  other than the single Find Similar route/panel described.
- No migration/backfill of old records (only comparisons inside
  `similarity-v1`).
- `Find Similar` UI: defined within `src/ui` as route + panel + controller
  (view-model) with tests — implementation belongs to the follow-up step.

---

## Q. Status

**Design status: READY FOR IMPLEMENTATION**

Reason: the existing feature extractor satisfies the V1 similarity needs in
full (no new DSP or ML), the fingerprint/versioning rules are deterministic,
storage complies with `assertNoAudioBytes`, and the reuse story matches the
15H/15I distributed-analysis model. Deriving the fingerprint requires no new
target licenses or dependencies. The only verification still open is the
cross-format real-samples probe (O1), which is independent of this design and
must be labeled NOT VERIFIED until executed.