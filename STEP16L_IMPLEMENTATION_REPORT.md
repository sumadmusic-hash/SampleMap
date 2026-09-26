# STEP 16L — Global Sample Discovery & Interaction: Implementation Report

**Step:** 16L (Global Sample Discovery & Interaction)
**Order:** 16L-1 → 16L-2 → 16L-3 → 16L-4 → 16L-5 → 16L-6 (strict — search/similarity not started first)
**Design basis:** `STEP16L_AUDIT.md` (Search Variant C — hybrid) + `STEP16_DESIGN.md` §§14–17
**Date:** 2026-09-03

---

## 1. Summary

Step 16L implements **global sample discovery and interaction** on top of the 16K global-map integration:

- **16L-1** — viewport-aware global map loading (camera bbox instead of a blind `0..1`, bounded cursor pagination, debounced camera-driven refresh).
- **16L-2** — global **inspection** without triggering the local analysis pipeline (canonical content-identity lookup; `UNKNOWN` ≠ `UNAVAILABLE`).
- **16L-3** — global→local **hydration** of explicitly selected points (reuses the 16J record shape; metadata-only; idempotent).
- **16L-4** — **search integration** (no new search engine — hydrated records are found by the existing `SearchEngine`).
- **16L-5** — **Find Similar** wired into the UI (existing `similarity-v1` `findSimilar` over the local index).
- **16L-6** — **loading/empty/error states** for the global map, with local data surviving a global failure.

No second search / similarity / map / analysis pipeline was created. The **worker was not changed** — 16L uses only the existing `GET /map` and content-identity lookup endpoints.

**Final verdict:** `STEP 16L — PARTIALLY VERIFIED` (backend + pipeline live-verified; browser/DOM + Audiotool OAuth/Machiniste NOT VERIFIED — environment limitation).

---

## 2. Method

- Read every 16L-relevant module plus the design spec (`STEP16_DESIGN.md` §§14–17) and prior reports.
- Verified a clean baseline **before** implementation (see §4).
- Implemented in the strict order 16L-1 → 16L-6.
- Added a dedicated Step 16L test suite `src/ui/step16L.test.ts` (C1–C7) plus pure viewport tests.
- Re-ran the full app + worker suites, `tsc` (app + worker), and `vite build` after implementation.
- Ran a live probe against the deployed Worker/D1 to verify the 16L data paths on real data (temporary script, removed afterwards).

---

## 3. Production / Test Files Changed

| File | Role | Change |
|------|------|--------|
| `src/ui/map/mapView.ts` | Pure map view-model | Added `NormalizedBBox` + `cameraToViewportBBox(camera, size)` — camera→normalized viewport bbox (inverse of `toScreen` + camera transform, clamped `[0,1]`, includes zoom). |
| `src/ui/app.ts` | Controller | Added `GlobalMapState`, `GlobalInspection`, constants (`GLOBAL_MAP_PAGE_LIMIT=500`, `GLOBAL_MAP_MAX_PAGES=2`, `GLOBAL_REFRESH_DEBOUNCE_MS=250`); `refreshGlobalPoints()` (camera bbox + bounded cursor), `scheduleGlobalRefresh()` (debounced), `refreshGlobalPointsImmediate()`, `selectGlobalPoint()` (routed local→select else inspect), `inspectGlobalPoint()`, `hydrateGlobalSample()`, `findSimilarForSelected()`; `globalMapState/globalBBox/globalInspection/similarResults/similarRecords/similarError` state; optional `index` dep; timer cleared in `dispose()`. |
| `src/global/hydrate.ts` | New pure module | `buildRecordFromGlobalAnalysis(sampleId, meta, globalAnalysis, analysisBuild, now)` → `{ record, resolved }`; reuses the exact 16J record shape; metadata-only, keyed on `sampleId` (idempotent). |
| `src/pipeline/analysisPipeline.ts` | Pipeline | `buildRecordFromGlobal` delegates to `buildRecordFromGlobalAnalysis` (single record-construction authority). |
| `src/ui/render.ts` | DOM projection | `renderMapPanel` shows the `map-global-state` element (`idle/loading/ok/empty/error` via `globalMapStateLabel()`); `renderGlobalInspection()` (classification/confidence/identity/position/origin + Hydrate); `renderSimilarPanel()`; Find Similar button in the normal inspector; errors do **not** clear local points. |
| `src/ui/bootstrap.ts` | Dep wiring | Returns `index` in deps. |
| `src/ui/app.test.ts` | Tests | `mk` helper passes `index`. |
| `src/ui/globalMapIntegration.test.ts` | Tests | `mkApp` passes `index`; old 16K test E rewritten for inspection-first flow; added `makeGlobalAnalysis()` + `inspectionIndex()` helpers. |
| `src/ui/step16L.test.ts` | **New** test file | C1–C7 coverage (26 tests). |

**Worker:** not changed (0 production changes in `workers/d1-worker`).

---

## 4. Baseline (before) vs After

| Suite | Before | After |
|-------|--------|-------|
| App tests | 499/499 (30 files) | **527/527 (31 files)** (+26 new tests, +1 new file) |
| Worker tests | 19/19 (2 files) | **19/19 (2 files)** — unchanged |
| `tsc --noEmit` (app) | 0 errors | **0 errors** |
| `tsc --noEmit` (worker) | 0 errors | **0 errors** |
| `vite build` | PASS | **PASS** |

---

## 5. Architecture (no parallel pipeline)

16L adds **no second analysis pipeline, search engine, similarity engine, or map renderer**. It composes existing, tested authorities:

```
GlobalSampleIndex.queryMapViewport (GET /map)        → global points (metadata only)
  → cameraToViewportBBox (viewport bbox)              → bounded, cursor-paginated
  → globalMapPoints / mergeMapPoints (16K)            → single MapPoint[]
GlobalSampleIndex.lookupContentIdentities (inspection)→ canonical GlobalAnalysisResult
  → buildRecordFromGlobalAnalysis (16J record shape)  → hydrate → IndexStore.put
  → SearchEngine (existing)                           → find by text/class/confidence
  → findSimilar (existing similarity-v1)              → similar results
```

Invariants preserved: content identity = `(contentHashVersion, contentHash)`; single analysis pipeline (16J reuse); usage acceptance unchanged; `UNAVAILABLE ≠ UNKNOWN`; global stores metadata only (no audio bytes).

---

## 6. 16L-1 — Viewport-Aware Global Loading

- `cameraToViewportBBox(camera, size)` inverts `toScreen` + the camera transform `screen = basePixel * zoom + pan`, clamped to `[0,1]`, including the `zoom` level. Pure, DOM-free, testable.
- `refreshGlobalPoints()` derives the bbox from the **current camera** (never a blind `0..1`), sends `mapVersion/xMin/xMax/yMin/yMax/zoom/limit(/cursor)` via the **existing** `GET /map` contract (no new worker params).
- **Bounded pagination:** one page of `GLOBAL_MAP_PAGE_LIMIT (500)` points, at most `GLOBAL_MAP_MAX_PAGES (2)` pages via `nextCursor` — no unbounded page loads.
- **Debounced refresh:** `scheduleGlobalRefresh()` coalesces camera changes (`GLOBAL_REFRESH_DEBOUNCE_MS = 250`) so panning never issues a request per pointer-move. `setMapCamera`/`resetMapView` trigger the debounced refresh; `dispose()` clears the timer.
- The camera is **runtime-only** (never persisted) and is not mutated by global loading.
- **Local points are preserved** across global refresh/errors.

---

## 7. 16L-2 — Global Inspection

- New `GlobalInspection` interface + state (`analysis`, `point`, `sampleId`, `resolved`, `error`).
- `selectGlobalPoint(point)`: if the point maps to a local record → `selectSample`; else → `inspectGlobalPoint(point)`.
- `inspectGlobalPoint(point)`: best-effort `resolveSample` for richer metadata, then `lookupContentIdentities([contentIdentity])` via **existing** path — **no audio fetch, no decode, no feature extraction, no classification**.
- On no matching hit → `error: "unknown"`; on backend failure → `error: "unavailable"` — the two are **structurally distinct** (never conflated).
- `renderGlobalInspection()` shows classification/confidence/content identity/map position/origin + a **Hydrate** button.

---

## 8. 16L-3 — Global → Local Hydration

- **Boundary:** only **explicitly selected** global points are hydrated — never the whole global DB (no `GET /map` → hydrate-everything loop).
- `buildRecordFromGlobalAnalysis` (new pure module `src/global/hydrate.ts`) reuses the **exact 16J record shape** (`SampleIndexRecord`), so there is a single record-construction authority. `AnalysisPipeline.buildRecordFromGlobal` delegates to it.
- `hydrateGlobalSample(point, analysis)`: resolve metadata (best-effort) → `index.put(record)` → `refreshSearch()` → select the now-local record.
- **Idempotent** at the `sampleId` key (`index.put`); no duplicates on repeat hydration.
- **Metadata-only:** `assertNoAudioBytes` guards pass on every hydrated record.

---

## 9. 16L-4 — Search Integration

- **No `SearchEngine` change.** Hydrated records land in the local `IndexStore`, so the existing engine finds them by name / class / confidence / sort. Local and hydrated-global records appear together in one result set.
- The app `search`/`refreshSearch` path is unchanged (single query surface). Search Variant C (hybrid) per the 16L audit — no distributed global text search was built.

---

## 10. 16L-5 — Find Similar UI

- `findSimilarForSelected()` uses the existing `similarity-v1` `findSimilar` over `index.getAll()`, keyed on the selected record's `contentHash + similarityFingerprint`.
- The selected sample is **excluded** (its own content identity is never a result); results are **deduplicated by content identity**, **deterministically sorted** (score DESC, key ASC tie-breaker), and **bounded** (`limit: 10`, sanitized to the allowed `{5,10,20}` set).
- `similarRecords` resolves representative local records for the UI; `renderSimilarPanel()` shows compact rows (play / name / class / origin).
- The normal inspector exposes a **Find Similar** button.

---

## 11. 16L-6 — Loading / Empty / Error States

- `globalMapState: "idle" | "loading" | "ok" | "empty" | "error"`.
- Map panel shows the `map-global-state` element via `globalMapStateLabel()`.
- `empty` (no points in viewport) is distinct from `error` (backend failure).
- On error, previous `globalPoints` are kept and **local map/search continue to work** (global failure never breaks local discovery).

---

## 12. Machiniste

- **Unchanged.** Sending a global-discovered / hydrated sample to a Machiniste flows through the **existing** `SampleMapMachinisteService.send` (16K path). No new integration.
- **Live/browser:** NOT VERIFIED (requires a real authenticated Audiotool project document + OAuth — unavailable in this environment). Not simulated.

---

## 13. Usage Acceptance

- **Unchanged boundary:** usage is accepted iff `committed ∧ applied ∧ readBackMatches ∧ errors.isEmpty`. Covered by `src/global/usageAcceptance.ts` (untouched) and C7 tests.
- A failed transfer (e.g. read-back mismatch) yields **no** usage acceptance and no publish.

---

## 14. Tests (C1–C7) — `src/ui/step16L.test.ts` (+ `mapView` viewport)

| Area | Coverage |
|------|----------|
| **C1 Viewport** | full-map bbox, zoom-punched bbox, pan shift (zoom>1), clamp under extreme pan, camera-bbox query (not blind 0..1), cursor/bounded pages, local points preserved, debounce coalescing. |
| **C2 Inspection** | canonical analysis shown; UNKNOWN → `"unknown"`; UNAVAILABLE → `"unavailable"` (≠ unknown); no auto-analysis. |
| **C3 Hydration** | record reuses global analysis + metadata; idempotent (single record); `buildRecordFromGlobalAnalysis` metadata-only + no audio; content-identity keyed. |
| **C4 Search** | hydrated record found by name / class / confidence / sort via the **existing** engine; local + global together. |
| **C5 Find Similar** | deterministic ordering, exact-dup excluded, bounded limit; controller resolves representative records + excludes selected. |
| **C6 UI states** | ok / empty / error transitions; loading set before resolve; local survives global failure. |
| **C7 Machiniste / acceptance** | global sample transfers via existing `send`; accepted only on committed∧applied∧readBack∧no-errors; failed transfer → no acceptance. |

Counts: `step16L.test.ts` **26 tests**; app suite **527/527**; worker **19/19**.

---

## 15. Typecheck

- App `tsc --noEmit`: **0 errors**.
- Worker `tsc --noEmit`: **0 errors**.

---

## 16. Build

- `npm run build` (tsc + `vite build`): **PASS**. Only the pre-existing >500 kB chunk-size advisory remains (no new warning introduced by 16L).

---

## 17. Live Verification

Live probe against `https://samplemap-d1-worker.sumadmusic.workers.dev` (real `createGlobalProvider` adapter, temporary script removed afterwards):

| Check | Result |
|-------|--------|
| Worker reachable (`/health`) | VERIFIED — `{"status":"ok"}` |
| `queryMapViewport` with camera-derived bbox (C1) | VERIFIED — full map `[0,1]` and zoom-4 `[0.375,0.625] span 0.250` |
| Bounded cursor pagination (C1) | VERIFIED — 2 pages fetched, `nextCursor` followed, no unbounded load |
| No audio bytes in map points (C1) | VERIFIED — `assertNoAudioBytes` passed |
| `lookupContentIdentities` inspection (C2) | VERIFIED — canonical `GlobalAnalysisResult`, `kick`, no audio bytes |
| Hydration → search (C3/C4) | VERIFIED — hydrated record **found by class via the existing `SampleMapSearchEngine`** |
| Find Similar excludes self (C5) | VERIFIED — exact-dup excluded (0 results for a single-record set) |
| **Browser DOM / OAuth / Machiniste** | **NOT VERIFIED** — no authenticated headless browser / Audiotool OAuth; not simulated |

---

## 18. Functional Verification

| Check | Status |
|-------|--------|
| Viewport bbox derived from camera (not blind 0..1) | ✓ C1 + live |
| Bounded cursor pagination | ✓ C1 + live |
| Local points preserved across global refresh/error | ✓ C1 + C6 |
| Global inspection without pipeline (no auto-analysis) | ✓ C2 + live |
| UNKNOWN vs UNAVAILABLE distinct | ✓ C2 |
| Hydration: bounded, idempotent, no audio, searchable | ✓ C3 + C4 + live |
| Hydrated records found by existing SearchEngine | ✓ C4 + live |
| Find Similar reachable in UI, excludes self | ✓ C5 + live |
| Loading/empty/error states; local survives global failure | ✓ C6 |
| Machiniste / usage acceptance unchanged | ✓ C7 + 16K regression |
| Worker unchanged | ✓ (0 production changes) |

---

## 19. Open Questions

1. **Browser-interactive E2E** (rendered map, DOM click → inspection → Hydrate button, live preview, Find-Similar query UI, Machiniste send) still requires a real authenticated Audiotool browser / OAuth session — unavailable headlessly. All backend + pure/model paths are live- or unit-verified.
2. **Global find-similar endpoint** — the contract has none today; V1 Find Similar is scoped to local + hydrated-global content (per `STEP16L_AUDIT` OQ-D / design §15).

---

## 20. Out of Scope

Likes, ratings, voting, reputation, trust, ML, clustering, WebGL, global FTS, and a new search engine were **not** built. 16L deliberately reuses the local `SearchEngine` + `similarity-v1` over hydrated content (Search Variant C).

---

## 21. Final Verdict

```text
STEP 16L — PARTIALLY VERIFIED
```

Breakdown:

| Area | Status |
|------|--------|
| Viewport-aware global loading (C1) | **VERIFIED** (unit + live) |
| Global inspection, no unnecessary analysis (C2) | **VERIFIED** (unit + live) |
| Hydration: bounded/idempotent/searchable/no-audio (C3) | **VERIFIED** (unit + live) |
| Search integration via existing engine (C4) | **VERIFIED** (unit + live) |
| Find Similar UI (C5) | **VERIFIED** (unit + live data path) |
| Loading/empty/error states + local survives failure (C6) | **VERIFIED** (unit) |
| Machiniste / usage acceptance boundary (C7) | **VERIFIED** (unit; unchanged) |
| Browser DOM rendering / OAuth / preview / Machiniste send | **NOT VERIFIED** (environment limitation) |
| Worker unchanged / backend live | **VERIFIED** |

### Verified
- 527/527 app tests (30→31 files), 19/19 worker tests, `tsc` clean (app + worker), `vite build` PASS.
- Backend + pure/model 16L data paths live-verified against the deployed Worker/D1: camera viewport bbox, bounded cursor pagination, content-identity inspection (no audio), hydration→search, Find-Similar self-exclusion.

### Not Verified
- Interactive browser DOM (map click → inspection → Hydrate UI, live preview, Find-Similar query UI, Machiniste send) — requires a real authenticated Audiotool browser/OAuth session, unavailable in this headless environment. Not simulated.

### Blocked
- None (browser/OAuth checks are environment limitations, documented as NOT VERIFIED, not blocked).

### Baseline (before → after)
```text
App:    499/499 (30 files)  →  527/527 (31 files)
Worker: 19/19  (2 files)    →   19/19  (2 files)
tsc (app + worker): 0 errors → 0 errors
build: PASS → PASS
```

---

## No Automatic Next Step

Per the task instructions, Step 16M is **not** auto-started. This report concludes Step 16L.
