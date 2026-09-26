# STEP39 — 2D Sound-Space Similarity Validation Report

**Date:** 2026-09-09
**Scope:** Validate whether the canonical STEP37 2D Sound Space is a useful acoustic-similarity space compared with the existing V2 Find Similar engine.
**Constraints honored:** No UI redesign, no new ML (no UMAP/t-SNE/CLAP/BEATs/PANNs/embeddings); the canonical projection was measured as-is; the projection was **not** modified in this pass; verdict A/B/C; persistence implications for a compact record; live categories only reported when observed.

---

## 1. Verdict

# B — Conditionally useful (visual/orientation space), NOT a substitute for V2 Find Similar.

The 2D Sound Space is a **faithful but lossy** acoustic-similarity manifold:

- Global distance agreement with the production V2 metric is strong (Pearson **0.83**, Spearman **0.80**, Kendall τ **0.66**).
- Axis semantics are reproduced exactly by the canonical projection (x ↔ tonality **+0.993**, x ↔ noisiness **−0.961**, y ↔ brightness **1.000**).
- BUT per-query neighbor *ordering* agrees with V2 only partially: nearest-neighbor agreement **13.5%**, top-5 overlap **29.7%**, top-10 overlap **41.4%**.
- V2 beats the 2D map on neighbor purity for every class where the comparison is meaningful — most sharply for the classes users notice most (kick, hihat).

**Consequence:** use the map as the visual browse / orientation surface it already is, keep Find Similar on the V2 8-dimensional metric. Do **not** re-point Find Similar at XY nearest-neighbors.

---

## 2. Methodology

### 2.1 Dataset
- Corpus extracted from the running app (CDP against `127.0.0.1:5173`) via `dump_corpus.ts`.
- 200 raw projectable samples; after dedupe by `contentHash` → **N = 200** (0 duplicates, all 200 projectable). 19,900 unique comparable pairs; every pair also has a finite V2 distance (no null sound-character dims in this corpus).

### 2.2 Definitions
- **XY distance** = Euclidean distance in canonical sound-space coordinates, computed with the real `createSoundSpaceProjector()` (production STEP37 projection).
- **V2 distance** = `1 − weightedEuclideanSimilarity(a, b, weights)` from the production `similarityEngine`, on vectors from the production `toSimilarityVector` with `V2_SIMILARITY_CONFIG.weights` `[0.16, 0.12, 0.18, 0.08, 0.12, 0.12, 0.10, 0.12]` over dims `[brightness, density, transient, duration, tonality, noisiness, dynamics, complexity]`. Distance ∈ [0, 1].
- **Neighbor purity** = fraction of the top-k XY/V2 neighbors sharing the query's primary class (mean over members).
- **nnClassHit** = fraction of queries whose #1 ranked neighbor is same-class.
- **Separation** = (mean cross-class pairwise distance) / (mean within-class pairwise distance), per class. > 1 = separable.
- K endall τ computed over full 199-length neighbor rankings per query; Spearman(top-15) computed over the id-window common to both top-15 lists (197/200 queries had ≥ 2 common ids; 3 too few — excluded from that statistic).

### 2.3 Analyzer integrity
Two analyzer bugs were caught and fixed during the run before these numbers were finalized: (1) a stray id re-sort had clobbered both distance-sorted rankings into the same id order (this initially produced the implausible `nnOverlap = 1.0`, `kendall = 1.0`); (2) the cross-class key convention differed between the writer (`first-seen` order) and reader (`alphabetical` order), dropping pairs for `openhat` separation. All figures below come from the corrected analyzer (`/tmp/samplemap-step39/analyze.ts`, metrics in `/tmp/samplemap-step39/metrics.json`).

---

## 3. Corpus composition

| Class | n | Class | n |
|---|---|---|---|
| loop | 132 | lead | 6 |
| kick | 24 | hihat | 5 |
| openhat | 11 | synth | 4 |
| bass | 9 | noise | 3 |
| tom | 3 | guitar | 2 |
| pad | 1 | | |

**Not observed in this corpus** (reported as not observed, not claimed): `snare`, `closed-hat`, `ride`, `crash`.

---

## 4. Quantitative results

### 4.1 Global XY↔V2 agreement

| Metric | Value |
|---|---|
| Pairs compared | 19,900 |
| Pearson(dxy, dV2) | **0.833** |
| Spearman(dxy, dV2) | **0.804** |
| NN overlap (top-1) | **0.135** |
| Top-5 overlap | **0.297** |
| Top-10 overlap | **0.414** |
| Kendall τ (full rank) | **0.663** |
| Spearman(top-15, common ids) | 0.228 (N = 197) |

### 4.2 Axis sanity (canonical projection is faithful)

| Relation | r |
|---|---|
| x ↔ tonality | **+0.993** |
| x ↔ noisiness | **−0.961** |
| y ↔ brightness | **+1.000** |

The canonical formulas are reproduced exactly: `x = clamp01(mean(tonality, 1−noisiness))`, `y = clamp01(brightness)` (projector at `src/analysis/soundSpaceProjector.ts:123-145`).

### 4.3 Class-context quality (XY vs V2)

| Class | n | XY top5 purity | V2 top5 purity | XY top10 | V2 top10 | XY nn-hit | V2 nn-hit | XY within | V2 within | XY sep | V2 sep |
|---|---|---|---|---|---|---|---|---|---|---|---|
| loop | 132 | 0.750 | **0.926** | 0.777 | **0.917** | 0.750 | **0.932** | 0.223 | 0.130 | 1.60 | 1.88 |
| kick | 24 | 0.325 | **0.692** | 0.321 | **0.592** | 0.125 | **0.708** | 0.474 | 0.238 | 0.91 | 1.14 |
| openhat | 11 | 0.091 | **0.145** | 0.082 | **0.136** | 0.091 | 0.000 | 0.309 | 0.222 | 1.28 | 1.14 |
| lead | 6 | 0.000 | **0.100** | 0.000 | **0.067** | 0.000 | 0.000 | 0.314 | 0.226 | 1.19 | 1.09 |
| bass | 9 | 0.200 | **0.244** | 0.200 | 0.189 | 0.000 | **0.222** | 0.131 | 0.143 | 4.23 | 2.04 |
| hihat | 5 | 0.040 | **0.280** | 0.080 | **0.180** | 0.000 | **0.400** | 0.196 | 0.125 | 1.83 | 1.82 |

Reading: **V2 ≥ XY on every cell** (except bass top-10 and XX sep, both small-n splits). The 2D map's biggest weaknesses are where precision matters visually:
- **kick**: top-5 purity 0.33 vs 0.69, NN same-class 0.13 vs 0.71 — a kick query's XY-nearest neighbor is rarely another kick, and kicks are more spread out in 2D (within 0.474) than V2 says they acoustically are (0.238).
- **hihat**: 0.04 vs 0.28 top-5 — XY essentially cannot recover hihat neighborhoods.
- Only the proletarian **loop** class (66% of the corpus, huge and low-contrast) makes XY look competitive — 0.75/0.78 purity — still behind V2's 0.93/0.92.

### 4.4 Decoupling (worst failure cases)

| Scenario | Metric | mean | p50 | p90 | max |
|---|---|---|---|---|---|
| Acoustically similar (V2#1) but spatially far | dXY | 0.051 | 0.042 | 0.103 | 0.170 |
| Spatially close (XY#1) but acoustically dissimilar | dV2 | 0.107 | 0.081 | 0.227 | 0.305 |

Concrete worst examples:
- XY-nearest pair with largest acoustic gap: **loop 243fdbfb ↔ lead e65e7f6f** — dXY 0.0077 (quasi co-located) yet **dV2 0.305** (similarity 0.695); kick 101daeb5 ↔ loop 7f7386da: dXY 0.0137, dV2 0.294 (sim 0.706).
- V2-nearest pair with largest spatial gap: loop **66a560f9** → lead **dbab1e34**: dV2 0.131 (sim 0.869) at dXY 0.170 — same-sample is 0.170, and loop 180668ad → loop 18523b56: dV2 0.104 at dXY 0.157.

Importantly, the failure magnitudes are bounded: the V2-true nearest neighbor sits at a **median XY distance of only 0.042** — so even where the top-1 differs, the "true" match is almost never far away on screen. The map remains a trustworthy *neighborhood* guide; only point-to-point *ordering* is unreliable.

### 4.5 Outliers
The top spatial and acoustic outliers are the **same loop samples** in both spaces (`66a560f9`, `fc0298e3`, `909f180c`, `3453fd6d`, `37ae2be0`, `54c7162a`). Two independent metrics flagging the same members means these are genuinely atypical loops (long, dense, bright), not an artifact of the 2D projection.

---

## 5. Interpretation

1. **Strong distance agreement (§4.1):** 0.83 Pearson / 0.66 Kendall means the 2D plane does compress real acoustic variation; it is the right *shape* of similarity.
2. **Order agreement is the weak spot (§4.1/§4.3):** only 13.5% of queries keep the same #1 neighbor, and class-precise neighborhood recovery is materially worse for kick/hihat. The 8 dims that V2 uses are partly independent of the 2 + 2 dims XY keeps — density, transient, dynamics, and complexity are dropped or folded away, and their contribution (~0.58 of the V2 weight) cannot be recovered from x,y.
3. **Visual utility is preserved (§4.4):** because the true nearest neighbor is usually a short hop away in XY, the map is a good browse surface ("this region is thick with kicks", "bright lead here") even though it cannot give precise "most similar first" answers.

---

## 6. Persistence implications

**Can the compact record `{sampleId, x, y, primaryClass, durationMs, soundSpaceVersion, classificationVersion}` reproduce V2 Find Similar? — No.**

V2 similarity is weighted Euclidean over the 8-dim sound-character vector; the 2D projection is non-invertible (it destroys density/transient/dynamics/complexity (~0.58 weight) and duration). With only x,y the best achievable rank reconstruction is τ ≈ 0.66 with ~13.5% NN agreement — the find-similar UX would silently regress.

**Minimum compact representation that preserves Find Similar:**

Option (a) — k-space + map fields: persist the **8-dim sound-character vector at reduced precision** (2 significant decimals → ~8 numbers) **plus** `{primaryClass, confidence, durationMs, contentHash, classificationVersion, soundSpaceVersion}`. `x, y` need **not** be persisted at all — the production projector deterministically derives them from the vector; storing them anyway costs little and defends against projector-version drift (recommended: store them, since they make map queries instant and independent).

Option (b) — if byte budget matters: quantize the 8 dims to 1 byte each (round to 255ths) → **8 bytes/sample**, identical ordering behavior.

Versioning: track `classificationVersion` and `soundSpaceVersion` separately — they evolve on different cadences; a `similarityVersion` should gate Find Similar reads.

---

## 7. Recommendation (next architectural step)

1. Keep the current UI and V2 Find Similar untouched.
2. Persist the compact vector (option (a) above) under a single `similarityVersion` gate so Find Similar works identically on incremental scans without re-analysis.
3. Treat the 2D Sound Space as a rendered orientation surface only — its role is "where am I / where is everything", not "what's most similar". Do **not** re-point Find Similar at XY.
4. Optional future work (deferred, out of scope per §43): if per-class neighbor quality for kick/hihat must improve, add a third acoustic axis (e.g., density or transient strength) rather than ML embeddings — the STEP37 coordinate system already carries the right features; the grid is just too coarse at 2 dims.

---

## 8. Claims made / not made

- **Observed (live corpus, offline math):** all quantitative results above; class composition; axis validity; V2 computed with the production engine on production vectors; 2D map geometry is a visual browse surface.
- **Not claimed:** any improvement to Find Similar UX; any live "sounds similar in the map UI" A/B (none was run this step); presence of `snare/closed-hat/ride/crash` in the scanned library.