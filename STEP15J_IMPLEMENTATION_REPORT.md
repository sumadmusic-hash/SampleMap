# STEP 15J IMPLEMENTATION REPORT — Perceptual Similarity / Find Similar

**Date**: 2026-09-02
**Based on**: `STEP15J_DESIGN.md` (design status: READY FOR IMPLEMENTATION)

---

## A — Implemented

### Production files created (3)

- `src/similarity/similarityFingerprint.ts` — fingerprint type, version constant,
  normalization bounds, weights, and `computeSimilarityFingerprint(features)`.
- `src/similarity/similarityDistance.ts` — weighted Euclidean distance and
  `similarityScore` (= 1 − d).
- `src/similarity/similaritySearch.ts` — `findSimilar` exhaustive V1 scan,
  result type, limit sanitation.

### Production files changed (2)

- `src/persistence/indexStore.ts` — added optional `similarityFingerprint?`
  field to `SampleIndexRecord` (compact `{ similarityVersion, values }`; passes
  `assertNoAudioBytes`).
- `src/pipeline/analysisPipeline.ts` — after feature extraction the pipeline
  now computes and persists the similarity fingerprint on each analyzed record.

### Production UI changes: 0
(per design §P — UI is the follow-up step; the domain/service layer is implemented only)

---

## B — Similarity v1

Exact implementation of the design's decision:

- **8 components** in fixed order: `duration`, `zeroCrossingRate`,
  `transientDensity`, `attack`, `spectralCentroid`, `spectralBandwidth`,
  `spectralRolloff`, `tonalNoiseRatio` (design §C).
- **Weights** (sum = 1.0): `0.1, 0.1, 0.15, 0.1, 0.2, 0.15, 0.1, 0.1`
  (design §C).
- **Excluded** as designed: `rms`, `peak` (loudness — not identity),
  `sampleRate`, `channels` (metadata, canonicalized away), `spectralFlatness`
  (perfectly correlated with `tonalNoiseRatio`).
- **Weighted Euclidean distance + similarity = 1 − d** (design §E).
- No ML / AI / ANN / embeddings / external API / cloud analysis.

---

## C — Fingerprint

```ts
type SimilarityFingerprint = {
  similarityVersion: "similarity-v1";
  values: number[]; // 8 normalized components, fixed order (§C)
};
```

- `SIMILARITY_VERSION = "similarity-v1"` — distinct from
  `analysisVersion`/`contentHashVersion`/`representativeVersion`/`mapVersion`
  (all unchanged).
- Pure function of `AudioFeatures` ⇒ **equal `contentHash` ⇒ equal
  fingerprint** (verified by test).
- `number[]` + `string` only — no audio bytes, no typed arrays; passes
  `assertNoAudioBytes`; compact (~100 bytes JSON), serializable,
  browser-computable, server-comparable.

---

## D — Normalization

Fixed, documented global bounds — no corpus statistics (incremental,
stateless, cross-runtime deterministic), per design §D. Log-compressed features
use `Math.log10`; others clamp directly. All clamped to [0, 1]:

| Component | Transform | Bounds |
|-----------|-----------|--------|
| `duration` | log10 | 0.01 s … 60 s |
| `zeroCrossingRate` | direct | 0 … 1 |
| `transientDensity` | direct | 0 … 20 /s |
| `attack` | log10 | 0.001 s … 1 s |
| `spectralCentroid` | log10 | 100 … 8000 Hz (same axis as map Y) |
| `spectralBandwidth` | log10 | 50 … 5000 Hz |
| `spectralRolloff` | log10 | 100 … 10000 Hz |
| `tonalNoiseRatio` | direct | 0 … 1 |

---

## E — Distance

`d = sqrt( sum_i w_i * (q_i − t_i)^2 ) / sqrt( sum_i w_i )`, with `sqrt(sum w)`
= 1 (weights sum to 1) so `d ∈ [0,1]`. `similarity = 1 − d`, clamped to [0,1].
Golden value verified in tests.

---

## F — Content Identity (15I integration)

- Domain level uses the existing 15I identity: `contentIdentityKey`,
  `selectRepresentative` (lex-smallest), `AudioContentIdentity`.
- **Similarity does NOT replace Content Identity** — identity remains the
  primary level; similarity is a separate acoustic relationship.
- One Content Identity → one Similar result regardless of how many
  Audiotool sample IDs it maps to.
- **Query exclusion** (`§8`): a candidate whose
  `contentIdentityKey === query.contentIdentityKey` is excluded — exact
  duplicates (same `contentHash`) are never separate Similar results
  (`§9`). 15I dedup stays authoritative.

---

## G — Search

`findSimilar({ contentIdentity, fingerprint, records, limit })`:

1. Receives the query identity + fingerprint.
2. Excludes the query itself (by content identity).
3. Excludes exact content duplicates (same identity).
4. Skips non-analyzed records and legacy records with no `contentHash`.
5. Compares only `similarity-v1` fingerprints (incompatible versions never
   mixed — per design §F/L; tested).
6. Computes `similarity = 1 − d`.
7. Deduplicates by content identity and carries the representative sample.
8. Sorts by `similarityScore DESC`, then `contentIdentityKey ASC`
   (deterministic tie-breaker).
9. Applies the sanitized limit (5 / 10 / 20, default 10).

Result type (`SimilarSampleResult`): `contentIdentity`,
`representativeSampleId`, `similarityVersion`, `similarityScore` (0..1). No
audio data.

---

## H — Tests

```
before: 287 tests / 21 files
after:  325 tests / 22 files
new:     38 tests (src/similarity/similarity.test.ts)
passed:  325
failed:  0
```

None of the existing tests were removed, weakened, or replaced with trivial
mocks. The search tests exercise real deterministic computation.

Coverage maps to the task §20 as follows:

- **A** fingerprint determinism: same features → identical fingerprint (3)
- **B** version: `similarity-v1`, 8 components, weights sum = 1 (4)
- **C** normalization: bounds, out-of-range clamp, log axes (5)
- **D** distance: zero distance, hand-computed golden value, symmetry, max (4)
- **E** similarity = 1 − d: identical → 1, score == 1 − d, range (3)
- **F** identical fingerprints → maximal similarity (1)
- **G** different fingerprints → expected lower similarity (1)
- **H** query exclusion: query never in results (1)
- **I** content-identity dedup: many sampleIds → one result (1)
- **J** exact-duplicate exclusion: same contentHash → no result (1)
- **K** deterministic ordering: ties broken by identityKey ASC (2)
- **L** result limit: default 10, custom 5/20, invalid → default (3)
- **M** version incompatibility: distance throws, search skips (4)
- **N** no audio persistence: `assertNoAudioBytes` passes for fingerprint + record (2)
- search semantics extras (ordering, no-fingerprint skip, non-analyzed skip) (3)
  + two fingerprint-level helper candidates (counted within the above)

---

## I — Verification

- **VERIFIED** — fingerprint determinism; version gating; normalization
  bounds; weighted-Euclidean golden value; similarity = 1 − d; query
  exclusion; content-identity dedup; exact-duplicate exclusion; deterministic
  tie-break ordering; result limit; version-incompatibility handling;
  `assertNoAudioBytes` storage invariant; full pipeline persists the
  fingerprint; 325/325 tests green; 22/22 files green.
- **NOT VERIFIED** — real WAV vs real FLAC of the same sample → equal
  `contentHash` → equal fingerprint (requires an authenticated live probe;
  inherited from 15H/15I/15J-O1). Not claimed verified.
- **BLOCKED** — none.

---

## J — TypeScript

`npx tsc --noEmit` → **0 errors** (clean).

---

## K — Build

`npm run build` → **OK** (built in ~534ms). Only the pre-existing
"chunks are larger than 500 kB" warning persists (harmless, unchanged from the
baseline; no new dependency was added).

---

## L — Limitations

- `similarity-v1` uses the existing feature base — no new DSP/FFT/ML.
- The spectral snapshot is the **first 1024 samples** (onset window ~21 ms at
  48 kHz) — accepted for V1; long evolving pads/ambience may rank less
  discriminatively on spectral dims, though time-domain dims still separate.
- Real WAV-vs-FLAC fingerprint equality remains **NOT VERIFIED** (requires
  authenticated live probe).
- V1 is an exhaustive linear scan (`O(records × 8)`); no ANN.
- Weights/bounds are versioned and only tunable by bumping `similarity-v1` to
  a later version.

---

## M — Future (not implemented, intentionally deferred)

- `similarity-v2` — whole-signal spectral averaging / per-band RMS profile
  (design §B/O2/O3).
- Indexed similarity / approximate nearest-neighbor (HNSW/IVF) for
  million-scale (design §J/O4).
- Global index / distributed analysis / multi-user sharing (design §K/§25 —
  the later global layer is NOT part of 15J).

---

## Critical architecture rule (task §24)

Two distinct relationships, never mixed:

```
CONTENT IDENTITY        SIMILARITY
Sample A ─┐            Content X ──┐
Sample B ─┼ contentX → 1 identity  Content Y ─┼ relationship
Sample C ─┘            Content Z ──┘
```

Both are implemented as separate concerns: content identity (15I) resolves
exact duplicates to one identity; similarity (15J) ranks distinct identities
by acoustic distance. The query's own identity is never its own similar result.
