# STEP 16Q — V2 Semantic 2D SampleMap (Persisted Position) — Implementation

**Date**: 2026-09-04
**Type**: Map-position architecture change (V2 persisted analysis result)
**Baseline before**: app 539 tests / 32 files — tsc 0 errors — vite build PASS — worker 19/19 — Playwright 16M 20/20
**After**: app 540 tests / 32 files — tsc 0 errors — vite build PASS — worker 19/19 — Playwright 16M 20/20 — real-data 11/11 AC PASS

> 16P designed the V2 Semantic 2D SampleMap (multi-window whole-sample flatness →
> log-SNR X; log-centroid Y). 16Q implements it as a **persisted analysis result**
> per the ratified architecture decision in `STEP16Q_SPEC_BLOCKER_REPORT.md`.
> `mapPosition` is no longer a value derived from `AudioFeatures` and recomputed
> downstream; it is computed **once at analysis time from decoded audio** and
> stored, and every downstream consumer (Publish, Validation, Global, Harness,
> UI) reads/validates the persisted V2 position. There is deliberately **no V1
> fallback** (a missing position = Missing-V2 state, never a recompute).

---

# 1. Goal

STEP16P designed a semantic 2D map whose **X** axis is tonal↔noisy (whole-sample
multi-window flatness via log-SNR) and **Y** axis is dark↔bright (log centroid).
Its authoritative X computation requires **decoded audio** (a multi-window median
over the whole sample), which only exists at analysis time. STEP16Q therefore:

- makes `mapPosition` a **persisted analysis result** (the one approved
  persistence change), stored on `SampleIndexRecord`;
- computes it **once** via `computePosition(features, decodedAudio)` inside the
  analysis pipeline (audio available);
- **removes** the V1 `mapPosition(features)` function entirely (anti-fallback);
- re-scopes every downstream consumer to **read/validate the persisted V2
  position** (never reconstruct it from `AudioFeatures`);
- validates the result on the same 100 real samples and reports the 11
  acceptance criteria.

No scope creep: `AudioFeatures` contract, classifier, search, preview,
Machiniste, global worker architecture, OAuth, and the Audiotool API are
unchanged. Similarity fingerprint and classification remain
recomputable-from-features and untouched (binding rule 4).

---

# 2. Adopted architecture decision (recap)

Referenced decision (ratified, binding rules 1–5) in
`STEP16Q_SPEC_BLOCKER_REPORT.md` → "ADOPTED ARCHITECTURE DECISION":

> **Map Position V2 is a persisted analysis result.** It is computed exactly once
> at analysis time (where `decodedAudio` is available) and stored. Downstream
> consumers **read and validate the persisted V2 position** and **must never
> reconstruct it from `AudioFeatures`.**

This is the explicit, granted exception to the Step 16D §26 "recompute derived,
don't re-analyze" rule, scoped to `mapPosition` only. The preferred resolution
(§4 of the blocker report) was selected — **not** the V1-recompute option.

---

# 3. V2 map computation (`src/map/mapPosition.ts`)

- `mapVersion = "map-v2"`.
- **X** = `flatnessToX(flatOverall)`:
  - `flatOverall` = median over ≤16 windows of per-window spectral flatness
    (window = 2048, Hann, hop = 1024; N = 1 for short samples), computed from
    `decodedAudio.mono` via an internal self-contained radix-2 FFT.
  - `snr = (1 - f) / (f + 1e-4)`, `rawX = log10(snr)` clamped to [-2, +3],
    `x = (rawX + 2) / 5` clamped to [0,1].
- **Y** = `centroidToY(centroidHz)`:
  - `y = (log10(1 + c) - log10(100)) / (log10(10000) - log10(100))` clamped to [0,1].
- Exported pure functions: `computePosition(features, audio)`,
  `flatnessToX(f)`, `centroidToY(hz)`, `wholeSampleFlatness(mono)`. The V1
  `mapPosition(features)` accessor is **removed** (anti-fallback rule). The
  `MapPosition {x,y}` type is preserved.

The function is pure and fully deterministic: identical (decoded audio,
features) always yields identical output — fixed anchors, no corpus
normalization, no re-ranking. This is what guarantees reload-stability (the
persisted value never changes).

---

# 4. Persistence change (the one approved field)

`src/persistence/indexStore.ts` — `SampleIndexRecord` gains an optional
`mapPosition?: MapPosition`. Documented as a persisted V2 analysis result;
optional = **Missing-V2** for pre-V2 records. No audio is persisted (binding
rule 2).

`src/persistence/test-helpers.ts` — `makeSample` now includes a default
`mapPosition: { x: 0.62, y: 0.42 }` so tests exercise the persisted-value path.

---

# 5. Analysis-time computation

`src/pipeline/analysisPipeline.ts` imports `computePosition, mapVersion,
MapPosition` and computes `mapPositionV2 = computePosition(features, decoded)`
at analysis time (decoded audio present). `buildRecord(...)` takes the computed
position and stores it on the record.

`src/global/hydrate.ts` — a globally-known compatible analysis is hydrated into
a local record; its persisted `map` is copied into
`record.mapPosition = { x: map.x, y: map.y }`.

---

# 6. Downstream consumers read/validate persisted V2 (never recompute)

- **`src/global/publish.ts`** — `createPublishCandidate` reads `record.mapPosition`
  and throws `PublishCandidateError` if it is missing (**Missing-V2**, no V1
  fallback). The `mapPosition` import is removed (`mapVersion` retained).
- **`src/global/validation.ts`** — removed `deriveMapPosition` and the
  feature-recompute cross-check for the map (`derivedMap`/`close()`).
  Fingerprint cross-check is retained. `validateVersionFingerprints` still
  structurally validates the persisted map (version token, finite x/y, [0,1]).
  Module doc updated.
- **`src/global/contract.ts`** — `GlobalPublishResult.features` /
  `GlobalAnalysisResult` comments updated: the map is a **persisted** result, not
  derivable from features.
- **`src/ui/map/mapView.ts`** — `mapPoints` reads `representative.mapPosition`;
  records without it (Missing-V2) are skipped (no false placement, no V1
  fallback). `MAP_VERSION = mapVersion = "map-v2"`.
- **`src/ui/view.ts`** — `detailMapPosition` returns the persisted
  `record.mapPosition` (undefined when Missing-V2); no recompute from features.
- **`src/e2e/harness/main.ts`** — `readRecords` reads `rec.mapPosition`, throws
  if missing, and projects `cx/cy` from the persisted value.

No downstream path recomputes the position from `AudioFeatures` (verified, §9).

---

# 7. Tests re-scoped to persisted V2 position

- `src/map/mapPosition.test.ts` — rewritten for V2: `flatnessToX`,
  `centroidToY`, `wholeSampleFlatness` (incl. short-sample N=1),
  `computePosition`, multi-window behavior, determinism. (23 tests, passing.)
- `src/global/contract.test.ts` — map is built as a **persisted** fixed value;
  the "map recomputable from features" and "reject map contradicting features"
  tests are replaced by V2 tests asserting validation does **not** cross-check
  the map against features; mapVersion assertions `"map-v1"` → `"map-v2"`.
- `src/global/schema.test.ts`, `src/global/lookup.test.ts`,
  `src/pipeline/analysisReuse.test.ts` — `makeAnalysis` helpers supply a
  persisted `map`/`mapPosition`; SUPPORTED mapVersion → `map-v2`.
- `src/ui/map/mapView.test.ts` — position tests read persisted `mapPosition`;
  added a **Missing-V2** test (record with features but no persisted position is
  not placed); distinct-position/hit-test fixtures now use explicit persisted
  coordinates; `MAP_VERSION` → `"map-v2"`.
- `src/ui/view.test.ts`, `src/ui/app.test.ts` — `detailMapPosition` / position
  tests read persisted `record.mapPosition`.
- `src/global/publish.test.ts`, `src/global/usageAcceptance.test.ts` —
  `makeLocalRecord` supplies a default persisted `mapPosition`; added a
  **Missing-V2 publish rejection** test (no V1 fallback).
- Worker tests (`workers/d1-worker/test/fixtures.ts`, `provider.test.ts`,
  `browserAdapter.test.ts`) — fixtures now carry a fixed persisted map; version
  literals updated to `map-v2`.

---

# 8. Documented formula-vs-spec deviations (NOT adjusted)

Per the no-adjust rule, these are documented as-is:

- `flatnessToX(0.5) ≈ 0.4000` (not 0.5): snr = 0.5/0.5001 ≈ 1 → log10 ≈ −0.00009
  → `(x + 2)/5 ≈ 0.4`.
- `centroidToY(100) ≈ 0.00216` (log10(101) = 2.0043, not exactly log10(100)).
- `centroidToY(10000) = 1.0` (clamped; log10(10001) > log10(10000)).
- `centroidToY(<100) = 0` (clamped); `centroidToY(>10000) = 1` (clamped).
- Whole-sample flatness of silence ≈ 1.0 → X at the tonal floor (`flatnessToX(1)`).

These are inherent to the chosen `1 +` and anchor/clamp construction and are
not treated as failures (ACs gate the aggregate distribution, not these
point values).

---

# 9. Verification

- **tsc --noEmit** — 0 errors (app tsconfig includes `src` + `vite.config.ts`).
- **vitest (app)** — 540 passed / 32 files.
- **vite build** — PASS (dist transformed/built).
- **worker subproject** (`workers/d1-worker`): typecheck 0 errors; vitest 19/19.
- **Playwright 16M** — 20/20, including:
  - `16M-07 Deterministic Position`: DOM circle coords match the **persisted**
    V2 map-position projection.
  - `16M-12 Reload`: persisted state survives a full page reload (persisted
    mapPosition read back, not recomputed).
- **eslint** — no eslint config exists in the repo and none is declared in
  `package.json`/devDependencies; skipped (nothing to run).
- **No-downstream-recompute proof** — `grep` over `src/`: no file imports or
  calls the removed `mapPosition(features)` function (remaining
  `mapPosition()` occurrences are comments/docstrings); no `map-v1` literals
  remain; `computePosition` is only called with decoded audio (analysis pipeline
  + tests). V1 recompute is fully removed.

---

# 10. Real-data diagnostic (100 real samples, `analyze-map-x.ts --limit 100`)

Same real population as the 16O baseline, comparing V1 (BEFORE) vs V2 (AFTER)
`computePosition(features, decoded)`:

| metric | BEFORE (V1) | AFTER (V2) |
|---|---|---|
| X median | 0.9354 | 0.6631 |
| X mean | 0.8028 | 0.6661 |
| X stdev | 0.2762 | 0.2209 |
| X P10–P90 span | 0.6357 | 0.5201 |
| X ≥ 0.95 | 46.0 % | 6.0 % |
| X ≥ 0.99 | 22.0 % | 2.0 % |
| Y stdev | 0.2824 | 0.2731 |
| Y P10–P90 span | 0.8051 | 0.7651 |
| \|Pearson(X,Y)\| | 0.095 | 0.267 |
| X/Y edge pileup (outer 2.5 %) | — | x=8.0 % y=13.0 % |
| max 5×5 corner-bin share | — | 6.0 % |

### 11 Acceptance Criteria (AFTER / V2) — **11/11 PASS**

1. X ≥ 0.95 < 15 % → **PASS** (6.0 %)
2. X stdev > 0.20 → **PASS** (0.2209)
3. X P10–P90 > 0.5 → **PASS** (0.5201)
4. Y stdev > 0.15 → **PASS** (0.2731)
5. Y P10–P90 > 0.4 → **PASS** (0.7651)
6. no axis edge-pileup > 25 % → **PASS** (x=8.0 % y=13.0 %)
7. no 5×5 corner-bin > 30 % → **PASS** (6.0 %)
8. \|Pearson(X,Y)\| ≤ 0.5 → **PASS** (0.267)
9. deterministic (fixed anchors, no corpus) → **PASS**
10. max 16 FFTs/sample (window=2048, hop=1024, maxWindows=16) → **PASS**
11. performance (per-sample O(1), constant-window bound) → **PASS**

The X-saturation of 16O (46 % at X ≥ 0.95) is resolved: the V2 X axis now
spreads samples across the full width (median 0.66, 6 % at X ≥ 0.95),
orthogonal to Y. Per the no-adjust rule, all 11 criteria passed on the 100 real
samples, so **no formula adjustment was made**.

---

# 11. Regression status

- App: 540 tests pass (was 539; +1 for the Missing-V2 publish-rejection test).
  tsc 0 errors, vite build PASS.
- Worker: 19 tests pass, typecheck 0 errors (fixtures/version literals updated
  to V2 only — worker architecture unchanged).
- Playwright 16M: 20/20 (position determinism + reload persistence explicitly
  green).
- The anti-fallback invariant is enforced by removing the V1 accessor (compile
  error if any consumer tried to use it) plus explicit Missing-V2 tests in
  publish/UI/harness.

---

# 12. Known limitations / notes

- **Formula-vs-spec deviations** (§8) are documented and left unchanged per the
  no-adjust rule.
- **`scripts/live-verify-16i.ts`** still imports the removed
  `mapPosition(features)` symbol (line 65, 89). It is a historical 16I script
  **excluded from the app tsconfig** (`scripts/*` is not typechecked or built),
  and it cannot compute a V2 position without decoded audio, so it is left as-is
  (not part of the app surface). `scripts/step16m-live-verify.ts` and
  `scripts/analyze-map-x.ts` were updated to V2 (`computePosition` at analysis).
- **`_v2chk.mts`** temp verification file was created and removed; no stray
  artifacts remain.
- Global worker architecture, OAuth, and Audiotool API are explicitly out of
  scope and unchanged.

---

# 13. Stop condition

This report, the 11/11 real-data AC result at §10, and the full verification at
§9 complete STEP 16Q. No further formula changes are applied. STOP.
