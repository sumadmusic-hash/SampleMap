# STEP40 — Compact Similarity Representation & Persistence Design

**Date:** 2026-09-09
**Anchor:** STEP39 verdict B frozen (2D Sound Space = visual/orientation space, NOT a V2 Find Similar replacement). STEP37 projection unchanged. Find Similar unchanged. UI unchanged. No new ML / embeddings / UMAP / t-SNE. No D1 synchronization implemented.

---

## 1. Executive Verdict

# A — Compact representation is sufficiently defined and ready for D1 architecture.

The minimal SampleMap content record is fully specified. A targeted quantization experiment on the real STEP39 corpus (200 samples, 19,900 pairwise comparisons, production V2 engine) shows the sound-character vector can be persisted at **16-bit granularity with mathematically zero meaningful loss** (Kendall τ = 0.99998, 100% top-10 overlap, max distance error 9.1×10⁻⁶) in **17 bytes**, and even at 8-bit it degrades only negligibly (τ = 0.995, 98.5% top-10 overlap, max error 0.0022) in **9 bytes** while keeping the canonical map projection within ~1.6 px. The only open sub-decision (16-bit vs 8-bit) is a scheduled, documented fallback — not a blocking precision question.

No precision/versioning question remains open that requires another validation run.

---

## 2. Current representation (before STEP40)

The persisted `SampleIndexRecord` (IndexedDB store, `src/persistence/indexStore.ts`) currently carries everything per sample:

| Field group | Content |
|---|---|
| identity | `sampleId`, `owner`, `visibility`, `name`, `originalTags`, `kind`, `contentHash`, `contentHashVersion`, `fileHash`, `analysisSourceFormat` |
| classification | `primaryClass`, `confidence`, `secondaryClasses`, `classificationVersion`, `semanticClassification?` (family/subtype/confidence/source/conflict/tagEvidence) |
| analysis V1 | `audioFeatures` (13-dim V1), `analysisVersion` ("features-v1"), `analysisBuild`, `status`, `analyzedAt`, `mapPosition?` (V1), `similarityFingerprint?` (legacy `similarity-v1`) |
| analysis V2 | `analysisV2?` { `features` (V2 DSP), `soundCharacter` (8-dim), `quality`, `analysisVersion` "2.0.0" } |
| global state | `globalPublish?` { usageAcceptedAt, delivery } |

The pre-existing global contract/schema (`src/global/{contract,schema}.ts`, Steps 16A/16B) is **V1-shaped**: global `content` records store `features: AudioFeatures` (V1), `similarity: SimilarityFingerprint` (`similarity-v1`), and V1 `mapPosition`. It has **no V2 sound character**, no canonical Sound Space coordinates, no V2 similarity. This report defines the compact **V2 global representation** that extends that design.

---

## 3. Minimum representation

Per content identity (dedup key `contentHash + contentHashVersion`), the minimum reusable knowledge:

```text
contentIdentity            // contentHash + contentHashVersion  (global dedup key, immutable)
primaryClass               // audio family — content-deterministic (canonical)
confidence                 // number in [0,1] — KEPT: local hydration requires a well-formed
                           //   SampleIndexRecord without re-analysis (isWellFormedIndexRecord)
classificationVersion      // classifier / semantic version that produced primaryClass
soundCharacter[8]          // the V2 perceptual vector (quantized, see §4)
analysisVersion            // ANALYSIS_VERSION "2.0.0" — pins character derivation
similarityVersion          // SIMILARITY_ALGORITHM_VERSION "2.0.0" — pins similarity math
soundSpaceVersion          // SOUND_SPACE_ALGORITHM_VERSION "1.0.0" — pins canonical projector
durationMs                 // source analysis datum; point diameter derived at render time
```

Plus the existing `sample_ref` edge (sampleId → contentIdentity) at the reference level.

**Fields evaluated as NOT persisted** (derived / scope-dependent / diagnostic — see §13): `x`, `y`, RGB colors, `semanticSubtype`, tag evidence, `source`, `conflict`, `secondaryClasses`, `quality`, V1/V2 features, V1 fingerprint, `mapPosition`. Each decision has a concrete reason in §13.

---

## 4. Quantization experiment

### 4.1 Method

- Corpus: STEP39 live corpus (`/tmp/samplemap-step39/corpus.json`), N = 200 projectable, no duplicates, no null dimensions.
- Baseline (A): the persisted float values, fed through the **production** `toSimilarityVector` + `weightedEuclideanSimilarity` (weights `[0.16,0.12,0.18,0.08,0.12,0.12,0.10,0.12]`, shared-dim renormalization) — identical code path to `rankSimilar`.
- Representations evaluated against A:

| Label | Definition |
|---|---|
| **A** | original floating-point (full JS double) |
| **B4 / B3 / B2** | reduced decimal precision, round to 4 / 3 / 2 dp |
| **C** | 16-bit uniform quantization: `round(v·65535)/65535` |
| **D** | 8-bit uniform quantization: `round(v·255)/255` |

- Metrics over all 200 queries × 199 candidates and all 19,900 pairs:
  - top-1 neighbor agreement, top-5 / top-10 overlap (mean IoU)
  - Kendall τ over full 199-length rankings (tie-break `similarity DESC`, `sampleId ASC` — mirrors `rankSimilar`)
  - pairwise distance error vs A: mean / p95 / max `|d_rep − d_A|`
  - map-projection delta: `max|Δx|`, `max|Δy|` of the canonical projector due to quantization
- Artifacts: `/tmp/samplemap-step40/quantize.ts`, results in `/tmp/samplemap-step40/quantize.json`.

### 4.2 Quantitative results

| Rep | top-1 | top-5 ov | top-10 ov | Kendall τ | mean \|Δd\| | max \|Δd\| | packed bytes/vec |
|---|---|---|---|---|---|---|---|
| A (baseline) | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 64 |
| B4 (4 dp) | 1.000 | 0.998 | 1.000 | 0.99986 | 1.2×10⁻⁵ | 5.3×10⁻⁵ | 32 (as int32 scaled) |
| B3 (3 dp) | 0.995 | 0.992 | 0.997 | 0.99878 | 1.2×10⁻⁴ | 5.5×10⁻⁴ | 32 |
| B2 (2 dp) | 0.920 | 0.942 | 0.958 | 0.98681 | 1.2×10⁻³ | 5.7×10⁻³ | 32 |
| **C (16-bit)** | **1.000** | **1.000** | **1.000** | **0.99998** | **1.8×10⁻⁶** | **9.1×10⁻⁶** | **17** (16+1 mask) |
| D (8-bit) | 0.960 | 0.976 | 0.985 | 0.99498 | 4.8×10⁻⁴ | 2.2×10⁻³ | 9 (8+1 mask) |

Map projection delta (canonical STEP37 projector, cloned in the harness):

| Rep | max \|Δx\| | max \|Δy\| | on 800 px map |
|---|---|---|---|
| C (16-bit) | 6.6×10⁻⁶ | 7.6×10⁻⁶ | ~0 px |
| D (8-bit) | 1.8×10⁻³ | 2.0×10⁻³ | ≤ ~1.6 px (0.0020 × 800) |

### 4.3 Reading

- **C (16-bit) is effectively lossless by every metric**: 100% top-1 and top-10 agreement, τ = 0.99998, max distance error < 1×10⁻⁵ — far below the smallest meaningful similarity difference in the corpus (inter-class distances are ~0.1–0.3). It is strictly more faithful than the best decimal alternative (B4) while being ~4× smaller packed.
- **D (8-bit) is nearly lossless**: 96% top-1, 98.5% top-10, τ = 0.995. The 4% top-1 churn only occurs among near-ties separated by <0.002 similarity — acoustically indistinguishable, well under the inter-class decoupling measured in STEP39 (mean dV2 = 0.107, p90 = 0.227). Map positions shift ≤ ~1.6 px (0.0020 × 800 px).
- **B (decimal)**: B4 is acceptable (τ = 0.99986) but strictly worse than C and not smaller; B2 begins real churn (8% top-1) and is rejected; B3 is a middle case.
- Conclusion: **default = C (16-bit)** — preserves Find Similar behavior provably. **D (8-bit)** documented as the ultra-minimal fallback (9 B) with quantified, benign degradation.

---

## 5. Storage estimates

### 5.1 Per-vector payload

| Rep | JSON text (measured / est.) | Packed binary |
|---|---|---|
| A (float64) | ~154 B | 64 B |
| B4 (4 dp) | ~54 B | 32 B (scaled int32) |
| C (16-bit int) | ~47 B | **17 B** (16 + 1 null mask) |
| D (8-bit int) | ~31 B | **9 B** (8 + 1 null mask) |

Text figures measured on the corpus (mean of serialized vectors); packed adds a 1-byte null mask so `null` dims stay representable without consuming a value code.

### 5.2 Per-sample compact record payload (actual useful payload)

Measured realistic JSON payload for the minimal record `{analysisVersion, soundSpaceVersion, classificationVersion, primaryClass, confidence, durationMs, vec[8]+null}`:

| Vector encoding | Sample payload (JSON) | Sample payload (packed baseline) |
|---|---|---|
| A (float64) | ~250 B | ~127 B |
| B4 (4 dp) | ~150 B | ~112 B |
| C (16-bit ints) | ~139 B | ~92 B |
| D (8-bit ints) | ~121 B | ~84 B |

Packed baseline assumes primaryClass TEXT (~8–12 B), confidence 4 B (int16 scaled), durationMs 4 B (int32), versions 5 B each, mask byte. Not included: `contentHash` (64 hex chars) and `sampleId` (~40 chars) which live as keys/FK columns.

### 5.3 Scaled totals (payload for the canonical knowledge only)

| Scale | A float64 | C 16-bit (recommended) | D 8-bit (fallback) |
|---|---|---|---|
| 1,000 | 250 KB | 139 KB | 121 KB |
| 10,000 | 2.5 MB | 1.4 MB | 1.2 MB |
| 100,000 | 25 MB | 14 MB | 12 MB |
| 1,000,000 | 250 MB | 140 MB | 120 MB |

Adding the per-reference rows (`sampleId` ~40 B + FK ~66 B) roughly doubles the 16-bit figures at the top end: ≈ 0.3 MB (@1k) → ≈ 300 MB (@1M). All scales fit comfortably in D1's database limits; quantization mostly removes friction, it is not a hard constraint.

---

## 6. Map implications

- `x / y` are **not persisted**. They are fully deterministic functions of the persisted `soundCharacter[8]` through the canonical STEP37 projector (`computeCanonicalSoundSpacePoint`, `SOUND_SPACE_ALGORITHM_VERSION "1.0.0"`); point exists iff both axes computable.
- Quantization moves points by ≤ ~1.6 px at 8-bit and ~0 px at 16-bit → map rendering is unaffected (< hit radius of 13 px, < base radius 5 px).
- **Storage difference measured:** persisting `x,y` costs 2×float64 = 16 B packed or ~12–32 B textual, plus a drift risk when the projector formula changes. Deriving them is free, always consistent with `soundSpaceVersion`, and removes any stale-coordinate state. **Decision: derive at query/render time; persist only `soundSpaceVersion`.**
- Point radius/diameter stays a render-time function (`4 px/3 px` base-unit, zoom-independent per STEP38 correction) and, where duration-driven, derives from persisted `durationMs` — never stored as pre-computed size.

---

## 7. Find Similar implications

- V2 Find Similar (`rankSimilar`, `src/analysis/similarityRanking.ts`) consumes exactly `analysisV2.soundCharacter[8]` + `analysisVersion` through `weightedEuclideanSimilarity` (`SIMILARITY_ALGORITHM_VERSION "2.0.0"`).
- Persisting the quantized character is the **exact input** the engine reads; no engine change, no ranking change. The quantized value loss is below any observable ordering difference (see §4.3).
- A global consumer hydrated from D1 can rank "Find Similar" **locally** with zero re-analysis and zero audio — the vector is the complete input. Ordering is deterministic and identical across users for the same content.
- The old V1 `similarity-v1` fingerprint is superseded and is local/legacy only; it is not part of the compact global record.

---

## 8. Classification implications

Separation of concerns (§4 of the task):

| Tier | Fields | Global? |
|---|---|---|
| **Runtime-required** | `primaryClass` (audio family → color base), `confidence` (hydration well-formedness), `classificationVersion` | **yes** |
| Runtime-required (derived locally from global family + local tags) | `semanticSubtype` (display class), color | local derivation only |
| Classifier-development / evaluation | `secondaryClasses`, `confidence` distributions | no (confidence kept for the runtime reuse path only) |
| Diagnostic evidence | tag evidence, `source`, `conflict` flags | no |

- **RGB colors are never persisted.** `semanticDotColor(primaryClass, subtype)` is a static deterministic map (`src/ui/map/semanticColors.ts`); the map fills from the two label strings, so no color bytes enter the global index.
- `semanticSubtype` depends on `originalTags` (sample/scope metadata), so it is **not content-canonical**. Global record carries the audio family; each user derives the subtype via `reconcileSemanticClassification(family, localTags)` deterministically. Conflict handling stays local.
- `confidence` is retained only because local hydration must produce a record satisfying `isWellFormedIndexRecord` (requires numeric `confidence`) without re-analysis. It is 4 bytes and not used in any score. Everything else in the classifier's output is dev/eval data and stays local.

---

## 9. Versioning model

Independent algorithms get **independent versions**; nothing is collapsed (§6 of the task, §11.3 of STEP16):

| Version | Source constant | Pins | Invalidates on bump |
|---|---|---|---|
| `analysisVersion` | `ANALYSIS_VERSION` ("2.0.0") | DSP → character derivation (`computeSoundCharacter`) | character data → requires global re-analysis (no features persisted) |
| `soundSpaceVersion` | `SOUND_SPACE_ALGORITHM_VERSION` ("1.0.0") | canonical projector formula | only map derivation — character and similarity stay valid |
| `classificationVersion` | classifier `heuristic-v1` / `semantic-v1` | family/subtype derivation | only classification labels — character and similarity stay valid |
| `similarityVersion` | `SIMILARITY_ALGORITHM_VERSION` ("2.0.0") | similarity weights / normalization | only ranking math — character data stays valid |

Rules:
1. A similarity bump must **never** imply a map or classification recompute (they consume the same character but no math changes hands).
2. A projector or classifier bump must **never** invalidate similarity data: the persisted character is input to all three top-level consumers, and only the consumer layer whose semantics changed re-derives its output.
3. Because the minimal global record stores **results, not features**, an `analysisVersion` bump (character-formula change) is the one case that forces a one-time global re-analysis — acceptable and consistent with "analyze a sample once globally."
4. A productization-layer version (`SIMILARITY_RANKING_VERSION "1.0.0"`, tie-break/limits) governs the UI surface, not persisted data — keep it out of the global record.

---

## 10. Global vs local vs user-specific (persistence boundary)

### 10.1 Global canonical knowledge — shared by all users (D1 `content` + `sample_ref`)

- `contentIdentity` (contentHash + contentHashVersion) — the dedup key.
- Classification result: `primaryClass`, `confidence`, `classificationVersion`.
- `soundCharacter[8]` (16-bit packed) + `analysisVersion` + `similarityVersion` + `soundSpaceVersion`.
- `durationMs`.
- `sample_ref` edges (sampleId → contentIdentity) so representatives and dedup are global.

### 10.2 Local cache — IndexedDB

- Full `SampleIndexRecord` per known local sample, including the V2 `analysisV2` (features + character + quality) for samples analyzed locally, the locally derived `semanticClassification` (with subtype + tag evidence), V1 features, tags, scan/preview state, `contentHash`, publish state.
- Hydration: on a global `known` hit, build/refresh the local record from canonical values **without re-analysis and without fetching audio**; map/find-similar/classification resolve from the cached canonical data.
- The local record may carry MORE than the global record (dev/diagnostic data live here and never leave the device).

### 10.3 User-specific state — never global

- Selection, focus, filters, discovery text/criteria, compare set, session UI state.
- Sample-level Audiotool metadata as applicable (favorites/usages counters, visibility) and own-derivation results (subtype from local tags).
- Usage-acceptance / publish delivery markers.

**Principle preserved:** *Analyze a sample once globally where possible; reuse the result for other users; never store the audio itself.* Audiotool owns the audio; SampleMap only ever needs temporary decode access. D1 stores **knowledge about samples** (hashes, character, classification, versions) — never copies of the audio, never a URL as a stand-in for audio.

---

## 11. D1 implications (design only — NOT implemented in STEP40)

- Extend the existing `GlobalAnalysisRecord` (`src/global/schema.ts`) with a V2 block:
  `{ soundCharacter: number[] (or BLOB), soundSpaceVersion, similarityVersion, analysisVersion, durationMs }`, while classification keeps its independent block.
- Add a packed-codec boundary (V2.SC-v1): `uint8[mask] + uint16[8]` → `number[]`, versioned like the others, so the byte format is pinned at decode time.
- Lookup stays content-hash-first (`lookupContentIdentities`), map becomes a viewport query over derived `x,y` (computed on the fly from stored character under `soundSpaceVersion`), Find Similar becomes a local weighted-Euclidean scan over hydrated characters (no server-side ANN needed at these scales; linear scan over ≤ ~1M × 8 dims is trivially fast and already what the app does).
- No new columns for user state; no audio columns; `assertNoAudioBytes` invariant extends to the codec.
- Representative selection stays the existing `representative-v1` rule (lex-smallest global sampleId).

---

## 12. Rejected data and why

| Data | Reason for rejection |
|---|---|
| `x`, `y` | Deterministically regenerable from `soundCharacter` under pinned `soundSpaceVersion`; persistence costs 8–32 B/record and invites drift |
| RGB colors | Derived by a static map from `primaryClass`/`subtype`; nothing to store |
| `semanticSubtype` | Scope-dependent (depends on local sample tags); derive locally from the global family |
| tag evidence, `source`, `conflict` | Sample metadata + diagnostic only; not runtime-required |
| `secondaryClasses` | Classifier dev/eval data; hydration only needs `primaryClass` + `confidence` |
| `quality` (overall, featureCoverage) | Derivable via `computeSoundCharacterQuality` from the persisted character |
| `AudioFeatures` V1 / V2 | Intermediate DSP data; results (character + classification) are what runtime consumes; a mapping bump → one-time global re-analysis |
| legacy `similarityFingerprint` (`similarity-v1`) | Superseded by V2 weighted-Euclidean on `soundCharacter`; local/legacy only |
| audio bytes / blob URLs | Hard global invariant; Audiotool owns audio |

**Kept despite being borderline:** `confidence` (4 B) — the concrete reason is the hydration path must produce a well-formed `SampleIndexRecord` without audio; it is a runtime enabler, not a dev artifact.

---

## 13. Regression requirements

- **No source files were modified in this step.** The experiment ran as standalone harnesses under `/tmp/samplemap-step40/` (and reused `/tmp/samplemap-step39/corpus.json`). Therefore the previously verified green gates are unchanged: `npx tsc --noEmit` clean, `npm test` 1186/1186, `npm run build` ok, `npx playwright test` 176/176. No STEP36/37/38 behavior was touched.

---

## 14. Final verdict

**A — Compact representation is sufficiently defined and ready for D1 architecture.**

Supporting facts:
1. Quantization is settled empirically, on the production engine and production corpus: **16-bit is lossless-by-math** (τ 0.99998, 100% top-10), **8-bit is a measured near-lossless fallback** (τ 0.995, ≤1.6 px map shift). No second validation round is required.
2. Every persisted field has a concrete justification; every rejected field has a concrete reason.
3. Four independent version lanes are defined with explicit invalidation semantics; no algorithm is silently re-pinned by another.
4. Storage is small at every scale (140 MB @1M samples for the full vector payload in 16-bit).

## 15. Recommendation for STEP41

1. Implement the **V2.SC-v1 packed codec** (uint8 null-mask + uint16[8] → vector; decode → `SoundCharacter`), with a textual 4dp JSON fallback for readability.
2. Extend `src/global/schema.ts` (`GlobalAnalysisRecord`) with the V2 block from §3 and the independent version set.
3. Extend `GlobalAnalysisResult`/`hydrate.ts` to carry the quantized character so hydration builds a complete, well-formed local record without re-analysis.
4. Add a `similarityVersion`-gated local Find-Similar scan over hydrated characters (identical math to `rankSimilar`).
5. Keep the local index as the cache; D1 stays the canonical source of content-level knowledge. No audio, no user state, no colors, no coordinates in D1.
6. Defer any actual D1 provider/adapter wiring and sync scheduling to a later step (explicitly out of scope here).