# STEP55 — D1 → Browser → Map Dataflow Audit

AUDIT ONLY. No production code was changed. All statements are classified
OBSERVED (static reading of the source), MEASURED (test run / server probe on
this machine), CALCULATED (derived from constants), INFERRED (reasoning over
the above) or NOT VERIFIED (cannot be measured in this session — no
authenticated live session with the deployed D1 worker).

---

## 1. Executive Verdict

**B — Implemented and unit-tested end-to-end, but the D1 READS are not wired by
the authenticated live entry point (they are dormant in the shipped boot path).**

The D1 → browser → map dataflow (Step 16K/16L) is fully implemented:

- Worker SQL viewport query `provider.queryMapViewport` (OBSERVED, provider.ts:439-489).
- HTTP envelope + caps (OBSERVED, index.ts).
- Browser transport `CloudflareGlobalAdapter` (OBSERVED, browserAdapter.ts).
- Startup fetch glued by `mountAuthenticated` (OBSERVED, ui/main.ts:48).
- Merge + render (OBSERVED, mapRender.ts:130-134, mapView.ts:477-520).
- Global-only select → inspect → hydrate (OBSERVED, app.ts:1070-1192).

All audited behavior is covered by MEASURED passing tests: `113` browser-side UI
tests (step16L, globalMapIntegration, mapView, hydrate) and `23` worker tests.

**The one deficiency found (wiring, not logic):** the authenticated entry
`src/main.ts → mountLiveSampleMap` passes `globalPublishQueue` to
`mountAuthenticated` but NOT `globalIndex` (OBSERVED, src/main.ts:184-190).
Consequently:

- `bootstrap.globalLookup` is `undefined` (bootstrap.ts:160-162) → the 16J
  per-sample D1 reuse never engages in the live app.
- `mountAuthenticated` skips `app.refreshGlobalPoints()` (ui/main.ts:48) →
  the D1 global pool is never read or displayed on the map.
- In THIS environment additionally `VITE_GLOBAL_WORKER_URL` is not set
  (OBSERVED, .env) so even `resolvePublishProvider()` returns the offline
  provider (liveProvider.ts:90-92); publishes stay pending.

So the codebase supports the "startup load of the growing global pool", but the
shipped boot path does not engage it. This is likely an oversight (publish IS
wired, reads are not) — see §7, Finding F-1.

---

## 2. Dataflow Diagram

```
                     D1 (Cloudflare)
   content  (content_hash, content_hash_version, map_x, map_y, primary_class)
   sample_ref(sample_id, content_hash, content_hash_version)
        |
        | SQL: SELECT content_hash,... ORDER BY map_y, map_x LIMIT ?+1 OFFSET ?
        |      + per point: MIN(sample_id) AS rep  (provider.ts:439-489)
        v
   Cloudflare Worker /map (index.ts)  -- no-audio guard, caps MAP_MAX_LIMIT=1000
        |
        | HTTP GET /map?xMin..yMax&limit&cursor   (browserAdapter.ts)
        v
   CloudflareGlobalAdapter.queryMapViewport
        |
        | (only if a live provider is wired: mountAuthenticated → refreshGlobalPoints)
        v
   app.refreshGlobalPoints()  (app.ts:1001-1039)
        -- bbox from current camera (cameraToViewportBBox, mapView.ts:197)
        -- bounded paging: 500 pts/page x max 2 pages = <= 1000 pts (app.ts:450-451)
        -- epoch-guarded; globalMapState loading/ok/empty/error
        v
   app.globalPoints : GlobalMapPoint[]
        |
        | mapRender.ts:130-134
        v
   globalMapPoints()  (mapView.ts:477-493)          mapPoints(records)  (mapView.ts:327-380)
     name = representativeSampleId                    local, from app.results records
     owner = "global", conf = 1.0, tags = []          + dedup by content identity
        |                                                 | 1 local point per content identity
        +-----------------> mergeMapPoints() <-------------+
              (mapView.ts:504-520; local wins on key)
        v
   renderSampleMap SVG  (mapRender.ts:123+)  -- sample maps (MAP_VERSION = "map-v2")

   --- selection of a GLOBAL-only point (the "string ensemble 2" Inspector case) ---
   selectGlobalPoint (app.ts:1070) -> inspectGlobalPoint (app.ts:1089)
        -> lookupContentIdentities([point.contentIdentity])  (provider path, worker)
        -> globalInspection (GlobalAnalysisResult, sampleId = point.sampleId)
        -> renderGlobalInspection: title = insp.sampleId (render.ts:2259)
   "Hydrate Locally" button (render.ts:2317-2321)
        -> hydrateGlobalSample (app.ts:1164-1192)
        -> buildRecordFromGlobalAnalysis (hydrate.ts:50)  [metadata-only, no audio]
        -> IndexStore.put(record) -> refreshSearch()

   --- 16J per-sample reuse during a LOCAL analysis run ---
   AnalysisPipeline -> GlobalLookup.lookupSamples/contentIdentity (lookup.ts)
        -> buildRecordFromGlobalAnalysis (analysisPipeline.ts:339)
```

### Ownership of each surface

| Surface | Fed by | Never fed by |
|---|---|---|
| SAMPLE MAP | merged local (filtered results) + ALL global viewport points | — |
| Sound Space | whole local index snapshot at open | global-only points (only hydrated records count) |
| RESULTS | SearchEngine over whole local index (filtered) | global-only points |
| Inspector | focused local record OR global inspection | — |
| Header/Footer counters | CURRENT run progress (not index size) | — |

---

## 3. Count Table

For each UI count: the exact source, its meaning, and whether it could be MEASURED.

| Surface | Count expression (file:line) | Semantics | Measured? |
|---|---|---|---|
| Header `Local index · N analyzed` | `app.analysis.analyzed` (render.ts:404) | Number of samples analyzed in the **current/last analysis RUN** — reset to 0 on every `analyze()` (app.ts:798); NOT the index record count | MEASURED (code); live value would reflect the last run, NOT VERIFIED for the deployed session |
| Footer `Running · N analyzed` | `app.analysis.analyzed` (render.ts:512) | Same run-progress counter, rendered only while `running`/`paused`; otherwise footer shows results length or last Machiniste result (render.ts:514-521) | MEASURED (code) |
| RESULTS `resultCountLabel(app.results.length)` | `app.results` = SearchEngine.search over `index.getAll()` (searchEngine.ts:100, app.ts:883) | Count of **local records** matching the active filters — global-only points excluded unless hydrated | MEASURED via 113 UI tests (filter/dedup semantics); live count NOT VERIFIED |
| Sound Space count | `projectAll(getAll())` snapshot at open (app.ts:1350-1351); label `soundSpaceCountLabel(points.length)` (render.ts:1071) | Number of projectable (V2 sound character) analyzed records in the **whole local index** at open time | MEASURED (code path + projector tests); live count NOT VERIFIED |
| SAMPLE MAP points | `mergeMapPoints(mapPoints(app.results→records), globalMapPoints(app.globalPoints))` (mapRender.ts:130-134) | Filtered **local** points (dedup by content identity, position V2-canonical or legacy) + **all** global viewport points | MEASURED via globalMapIntegration/mapView tests; live composition NOT VERIFIED |
| Global fetch bound per refresh | `GLOBAL_MAP_PAGE_LIMIT (500) × GLOBAL_MAP_MAX_PAGES (2) = ≤ 1000` (app.ts:450-451) | Bounded-hydration boundary; worker clamps page limit to `MAP_MAX_LIMIT = 1000` (index.ts:79-80) | CALCULATED |
| D1 `content`/`sample_ref` row counts | — | How many rows the live D1 holds | **NOT VERIFIED** (no authenticated session / live worker to probe) |
| Global points actually returned per refresh | `result.points` from HTTP /map | Live viewport | **NOT VERIFIED** |

---

## 4. Counter Semantics — the "0 analyzed / 25 · 100+ points" observation explained

The previously observed UI state (header `Local index · 0 analyzed`, footer
`Running · 0 analyzed`, Sound Space `25 analyzed samples`, map `100+ points`,
RESULTS `0 samples`) is fully explainable by the counter semantics, no bug
required:

1. **Header/Footer "0 analyzed" ≠ an empty index.** Both render the RUN-progress
   counter `app.analysis.analyzed` (render.ts:404, render.ts:512). If the last
   completed (or a freshly started) run saw 0 analyzed jobs, the counter is `0`
   while the index still holds the 25 records from an earlier run. Sound Space's
   `25 analyzed samples` is a DIFFERENT counter — the whole-index snapshot at
   open (app.ts:1350-1351). OBSERVED semantics; live values NOT VERIFIED.

2. **RESULTS `0 samples` + map `100+ points` is consistent whenever
   `globalIndex` is live.** The map merges `app.results` (→ local points) with
   ALL global viewport points (mapRender.ts:130-134). Global points ignore text/
   class filters entirely. So `results = 0` local points, yet a populated D1
   viewport still renders 100+ global points. Conversely, with the CURRENT .env
   (no `VITE_GLOBAL_WORKER_URL`) `globalIndex` is not wired at all, so neither
   state can occur via D1 in this build — meaning the observation implies a
   session where a live worker (and `globalIndex`) was configured. The live
   composition is NOT VERIFIED here.

3. **Inspector title `string ensemble 2` = D1 `representativeSampleId`.** A
   global-only point carries only `{contentIdentity, x, y, primaryClass,
   representativeSampleId}` (provider.ts:476-482). `globalMapPoints` uses that
   id as name and owner (mapView.ts:484-485), and `renderGlobalInspection`
   titles the Inspector with `insp.sampleId` (render.ts:2259). So the Inspector
   shows the D1 lex-min `sample_id` verbatim — NOT a resolved display name.
   OBSERVED; which id string the live D1 holds is NOT VERIFIED.

---

## 5. Root Cause / Explanation

| # | Observed / candidate | Proper count source | Explanation (evidence) |
|---|---|---|---|
| E-1 | "0 analyzed" vs Sound Space 25 | header/footer: run progress; Sound Space: index snapshot | Two different counters; run counter reset per `analyze()` (app.ts:798), Sound Space snapshot reads the whole index (app.ts:1350). Causes user-visible discrepancy, not a defect. |
| E-2 | RESULTS 0 vs map 100+ | RESULTS: local index filter; map: local filter + ALL global viewport | Global points bypass search filters (mapRender.ts:130-134). Only occurs when a live `globalIndex` is wired. |
| E-3 | Inspector shows a sample-id-like string | global inspection title = `point.sampleId` (render.ts:2259) | D1 projection carries no name/owner/tags (provider.ts:442-483); browser fills fallbacks (mapView.ts:484-488). |

---

## 6. Source Evidence (all OBSERVED unless noted)

Reference file:line — exact citations.

### D1 read side (worker)
- `workers/d1-worker/src/provider.ts:439-450` — viewport SELECT over `content`
  (`content_hash, content_hash_version, map_x, map_y, primary_class`),
  `ORDER BY map_y, map_x LIMIT ?+1 OFFSET ?` for cursor detection.
- `workers/d1-worker/src/provider.ts:462-474` — per-point
  `SELECT MIN(sample_id) AS rep FROM sample_ref` (representative rule).
- `workers/d1-worker/src/provider.ts:475` — `assertNoAudioBytes` guard on map
  output (metadata-only invariant).
- `workers/d1-worker/src/index.ts:79-80` — `defaultMapLimit=200`, `maxMapLimit=1000`.
- `workers/d1-worker/src/browserAdapter.ts` — pure fetch transport mapping the
  contract (no domain logic).

### Browser read/merge/render
- `src/ui/main.ts:44-49` — `buildBrowserDeps` then, IF `opts.globalIndex`,
  `app.refreshGlobalPoints()`.
- `src/ui/bootstrap.ts:160-162` — `GlobalLookup` only created when
  `opts.globalIndex` is present (else undefined → no 16J reuse).
- `src/ui/app.ts:1001-1039` — `refreshGlobalPoints`: camera bbox, ≤2 pages × 500,
  epoch guard, loading/ok/empty/error.
- `src/ui/app.ts:450-454` — `GLOBAL_MAP_PAGE_LIMIT=500`, `GLOBAL_MAP_MAX_PAGES=2`,
  debounce 250 ms.
- `src/ui/map/mapView.ts:477-493` — `globalMapPoints` fallback metadata.
- `src/ui/map/mapView.ts:504-520` — `mergeMapPoints`: local wins on content-identity key.
- `src/ui/map/mapRender.ts:130-134` — final assembly `mergeMapPoints(local, global)`.

### Selection → inspection → hydration
- `src/ui/app.ts:1070-1080` — `selectGlobalPoint` (local match on sampleId, else inspect).
- `src/ui/app.ts:1089-1145` — `inspectGlobalPoint` via `lookupContentIdentities`.
- `src/ui/app.ts:1164-1192` — `hydrateGlobalSample`: version gate + `IndexStore.put`
  + `refreshSearch` (one record at a time, idempotent).
- `src/global/hydrate.ts:50-132` — `buildRecordFromGlobalAnalysis` (metadata-only,
  verbatim content identity, no audio).
- `src/ui/render.ts:2253-2324` — global inspection renderer; title = `insp.sampleId`
  (2259); "Hydrate Locally" (2317-2321).
- `src/pipeline/analysisPipeline.ts:334-346` — 16J reuse path calls
  `buildRecordFromGlobalAnalysis`.
- `src/search/searchEngine.ts:92-128` — `search()` reads `index.getAll()` (local
  IndexedDB), so RESULTS never contains global-only points.

### Live-entry wiring (the gap)
- `src/main.ts:184-190` — `mountAuthenticated({ client, doc, authenticatedUserName,
  globalPublishQueue, globalPublishDelivery })` — **no `globalIndex`**.
- `src/main.ts:96-102, 110-126` — publish provider via `createGlobalProvider`;
  with no `VITE_GLOBAL_WORKER_URL` it is the offline provider.
- `src/global/liveProvider.ts:31-52, 90-92` — `offlineProvider()`: map returns
  empty, publishes rejected/temporary-unavailable.
- `.env` (OBSERVED) — `VITE_GLOBAL_WORKER_URL` absent.

### Counters
- `src/ui/render.ts:401-405` — header `Local index · ${app.analysis.analyzed} analyzed`.
- `src/ui/render.ts:507-521` — footer semantics (run counter while running/paused,
  else results / Machiniste result).
- `src/ui/app.ts:788-848` — `analyze()` resets `analyzed=0`; `applyProgress` sets
  it from the runner.
- `src/ui/app.ts:1332-1370` — `openSoundSpace` = `projectAll(index.getAll())`.
- `src/ui/render.ts:732, 1071` — results / sound-space count labels.

### MEASURED (this session)
- Dev server `http://127.0.0.1:5173/` → HTTP 200 (PID 72589).
- `npx vitest run` (browser src): **113/113 PASS** across `step16L.test.ts`,
  `globalMapIntegration.test.ts`, `map/mapView.test.ts`, `global/hydrate.test.ts`.
- `workers/d1-worker: npx vitest run`: **23/23 PASS** (`provider.test.ts`,
  `browserAdapter.test.ts`).

### NOT VERIFIED
- Live D1 row counts, live global points returned per viewport, and the live
  observed UI numbers — require an authenticated browser session + a configured
  live worker (not available in this environment; current `.env` has no
  `VITE_GLOBAL_WORKER_URL`).

---

## 7. Findings

- **F-1 (wiring gap).** `mountLiveSampleMap` (src/main.ts:184-190) never passes
  `globalIndex` to `mountAuthenticated`, so the shipped live app engages neither
  the D1 map read (ui/main.ts:48 is skipped) nor the 16J analysis reuse
  (bootstrap.ts:160-162). The D1 → map dataflow is only reachable when a caller
  supplies `globalIndex` (as the e2e harness and unit tests do). Recommend
  future work: pass `createGlobalProvider({ baseUrl: GLOBAL_WORKER_URL })` as
  `globalIndex` at src/main.ts:184  (conditional on `GLOBAL_WORKER_URL`), which
  is a small, testable change. **Not changed in this audit.**
- **F-2 (counter semantics).** Header/footer label says "Local index" / "analyzed"
  but the number is the RUN-progress counter, not the local index size — an
  index with 25 records can show "0 analyzed". Not a defect; a labeling nuance.
- **F-3 (info).** Global-only Inspector cannot show a resolved name because D1
  projects no name/owner/tags; the title is the `sample_id` string.

---

## 8. Key Question — Answer

> Does SampleMap, at startup, read the growing global pool from D1 and display
> it, OR does it only hydrate D1 knowledge into samples discovered/indexed in
> the current user's local session?

**Both mechanisms exist and are implemented, but which one runs depends on
wiring:**

1. **Startup read & display of the global pool — implemented, dormant in the
   shipped entry.** When a live `globalIndex` is supplied, `mountAuthenticated`
   fetches the current-viewport D1 points on startup and the map renders them
   merged with local points (OBSERVED: `ui/main.ts:48`, `app.ts:1001-1039`,
   `mapRender.ts:130-134`). D1 knowledge shown read-only; the pool can be
   re-read on camera change (debounced, bounded ≤1000 pts).
   **BUT** the authenticated live entry `src/main.ts:184-190` does not pass
   `globalIndex`, so in the shipped boot path this never fires (F-1).

2. **Hydration of D1 knowledge into the local index — per-record, never
   bulk.** D1 knowledge enters the local IndexedDB index only through:
   (a) per-sample reuse inside a local analysis run (16J:
   `analysisPipeline.ts:334-346` + `hydrate.ts:50`), or
   (b) an explicit user click "Hydrate Locally" on a global-only point (16L Phase 3:
   `app.ts:1164-1192`). There is NO code path that bulk-loads the global pool
   into the local index — that is the documented bounded-hydration boundary
   (`app.ts:444-451`).

In this environment (`VITE_GLOBAL_WORKER_URL` unset) neither the live read nor
16J reuse can engage; publishes are offline. Deployment with the Worker env var
set + wiring `globalIndex` at `src/main.ts:184` enables the full 16K/16L flow.

---

## 9. Production Changes

**NONE.** Audit only. No source, UI, counter, DB, or config changes were made.