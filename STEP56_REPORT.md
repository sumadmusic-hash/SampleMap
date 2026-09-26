# STEP56 — Screenshot State Reconciliation Audit

AUDIT ONLY · no production changes · screenshots not attached to this session —
state reconstructed from source, persisted-state semantics, configuration, and
the STEP55 evidence. Classifications: OBSERVED / MEASURED / INFERRED / NOT VERIFIED.

Observations to reconcile (from the STEP55 session note):
Header/Footer `0 analyzed` · Sound Space `25 analyzed samples` · RESULTS `0 samples`
· Map `100+ points` · Inspector shows an analyzed sample (`string ensemble 2`).

---

## 1. MAP — source of the 100+ MAP-V2 points

Rendered set = `mergeMapPoints(mapPoints(app.results→records), globalMapPoints(app.globalPoints))`
(OBSERVED, `src/ui/map/mapRender.ts:130-134`; merge dedup rule,
`src/ui/map/mapView.ts:504-520`).

With `app.results.length === 0` (see §3), the local contribution is **0 points**.
Therefore all ~100 displayed points are `app.globalPoints` — the D1 viewport
result of `refreshGlobalPoints()` (`app.ts:1001-1039`) → worker
`provider.queryMapViewport` (`workers/d1-worker/src/provider.ts:439-489`,
projection + per-point `MIN(sample_id)` rep, bounded `ORDER BY map_y, map_x
LIMIT ?+1 OFFSET ?`), delivered by `CloudflareGlobalAdapter` over HTTP.

**MAP SOURCE (ground truth):** The **D1 global content pool** rendered via the
live global provider — the map shows only global points because the active
search filter makes the local extraction empty. Global points are
filter-independent: they render regardless of RESULTS/text/class
(OBSERVED, `mapRender.ts` consumes `app.globalPoints` untouched by filters).
Runtime count of D1 rows: **NOT VERIFIED** (no live session).

## 2. SOUND SPACE — source of `25 analyzed samples`

`openSoundSpace()` captures a whole-index snapshot and projects it
(OBSERVED, `src/ui/app.ts:1341-1370`):

```
records = await index.getAll()          // ALL local records
points  = projectAll(projector, records) // only records with a projectable V2 soundCharacter
label   = soundSpaceCountLabel(points.length)   // "N analyzed samples" (render.ts:1071)
```

**SOUND SPACE SOURCE (ground truth):** The **local IndexedDB index** — the count
of analyzed local records whose V2 Sound Character projects to a position
(≥25 such records exist). This counter is **independent of the search filter and
of the run-progress counter** — which is exactly why it can be `25` while RESULTS
is `0` and header/footer read `0`.

## 3. RESULTS — why `0 samples`

`results = SearchEngine.search(q)` over `index.getAll()` (OBSERVED,
`src/ui/app.ts:883`; `src/search/searchEngine.ts:92-128`), default status filter
`["analyzed"]` (OBSERVED, searchEngine.ts:83-85).

With 25 analyzed records in the index, an **unfiltered** query returns ≥25.
`0 samples` therefore requires an **active search constraint that matches none of
the 25** — text query, class filter, or min-confidence (OBSERVED + CALCULATED:
the only exclusion paths are `textScore <= 0`, `!matchesAnyClass`, and
`confidence < minConfidence`). Map-side consequence: local points = 0 (map is
all-global, §1).

**RESULTS SOURCE (ground truth):** **Local index filtered by the active search
state** → `0` because the active filter matches no local record. Stale-empty
`results` is a rejected alternative (startup and post-run `refreshSearch()` keep
it populated; OBSERVED `ui/main.ts:46`, `app.ts:1186`). Exact filter string:
**NOT VERIFIED** (no screenshot).

## 4. COUNTER — why header/footer show `0 analyzed`

Both render `app.analysis.analyzed` — the **current/last analysis RUN's progress
counter**, reset to 0 on every `analyze()` and only advanced by job completion
(OBSERVED, `src/ui/render.ts:404` header, `render.ts:512` footer; reset at
`src/ui/app.ts:798`, update at `app.ts:839-847`). It is **not** the index size.
Footer literally "Running · 0 analyzed" additionally requires
`analysis.status === "running"`/`"paused"` (OBSERVED, render.ts:511-513) — i.e.,
a run in progress whose first job has not yet completed (real decode+features+
classify is slow, so a fresh run can sit at "Running · 0 analyzed").

**COUNTER SOURCE (ground truth):** an **analysis run that is in progress and has
not yet reported a completion** — independent of the 25 records already indexed.
The 25-record index and a 0-progress run transitively coexist (INFERRED: they
are separate state, see §5).

## 5. INSPECTOR — how it can show `string ensemble 2`

Local path (most consistent): the Inspector renders `focusedRecord`, resolved
through the **knownRecords registry, which filtering never prunes**
(OBSERVED, `src/ui/app.ts:936-940`; STEP16R invariant at `app.ts:884-890` "never
REMOVES an entry"; render path `src/ui/render.ts:2075` + title = `record.name`).
So a sample focused **before** the zero-match filter was applied stays
inspectable while RESULTS is 0 — no D1 involvement needed.
"string ensemble 2" is a real Audiotool sample display name; the harness
fixtures never use it (MEASURED: `rg "string ensemble"` matches only this
report), so the string originates from an **Audiotool `SampleMeta.displayName` /
`name`** (OBSERVED `hydrate.ts:90`, `analysisPipeline.ts:366`).

Global path (possible but less likely): a global point click would title the
Inspector with `insp.sampleId = D1 representativeSampleId`
(OBSERVED, `render.ts:2259`). D1 sample_ids are Audiotool slugs, so a literal
`string ensemble 2` here is improbable.

**INSPECTOR SOURCE (most likely, INFERRED):** a **previously focused local
record named "string ensemble 2" kept alive by the focus/registry invariant**
while the active filter hides it from RESULTS and the map's local layer.
(NOT VERIFIED: exact click/selection history absent.)

## 6. Reconciliation — how the screenshot state occurred

One coherent timeline (all steps individually OBSERVED in code; the sequence is
INFERRED and consistent):

1. Authenticated session with a **live D1 worker configured** → map reads the
   global pool (this is the only way 100+ points exist while RESULTS = 0).
2. Prior runs analyzed the user's library → local index holds ≥25 analyzed
   records → Sound Space shows `25 analyzed samples`.
3. User invokes a new analysis run → run-progress counter resets → header/
   footer show `0 analyzed` ("Running · 0 analyzed": first job still in flight).
4. User sets a search filter matching none of the 25 → RESULTS = `0 samples` and
   the map's local extraction is empty (map = all-global).
5. `string ensemble 2` had been focused before the filter was applied; the focus
   registry keeps it resolvable → Inspector still shows the analyzed record.

No single UI bug is required: each number is the correct readout of its own
counter (run progress vs index snapshot vs filtered search vs D1 viewport).

## 7. Current build — reproducibility

**NOT reproducible with the current build + `.env`.** Reasons (all OBSERVED):

- `.env` has no `VITE_GLOBAL_WORKER_URL` → `createGlobalProvider` returns the
  offline provider → `queryMapViewport` returns `{mapVersion:"", points:[]}`
  (`src/global/liveProvider.ts:31-52,90-92`).
- Even with the env var set, the shipped entry never wires `globalIndex`:
  `mountLiveSampleMap` passes only `globalPublishQueue` to `mountAuthenticated`
  (`src/main.ts:184-190`), so `refreshGlobalPoints()` is skipped
  (`src/ui/main.ts:48`) and `GlobalLookup` is undefined
  (`src/ui/bootstrap.ts:160-162`). The D1 **read** side is dormant in this build.
- No authenticated Audiotool session exists in this environment (STEP54: OAuth
  error state), so the UI never mounts at all.

The nested, non-D1 pieces (RESULTS=0 under a zero-match filter, header/footer
run-counter 0, Sound Space = index snapshot, filter-surviving Inspector) are all
reproducible in unit/e2e tests (113 audited tests PASS, plus 23 worker tests),
but the screenshot state **as a whole** (100+ global map points) cannot occur
here.

## 8. Most likely environment difference

The screenshot came from a session with **all of**: (a) `VITE_GLOBAL_WORKER_URL`
pointing at the deployed D1 worker (`.env.example` documents it),
(b) `globalIndex` wired at the entry (a build/setup ahead of `src/main.ts:184-190`
or a temporary wiring), (c) an authenticated Audiotool library session,
(d) an active zero-match search filter, and (e) an analysis run in flight.
The current environment differs on all of (a)–(c).

## 9. Source Evidence (file:line)

- Map assembly: `src/ui/map/mapRender.ts:130-134`; merge: `src/ui/map/mapView.ts:504-520`; global fetch: `src/ui/app.ts:1001-1039`; D1 SQL: `workers/d1-worker/src/provider.ts:439-489`; caps `index.ts:79-80`.
- Sound Space: `src/ui/app.ts:1341-1370`; label `src/ui/render.ts:1071`.
- RESULTS: `src/ui/app.ts:883`; `src/search/searchEngine.ts:83-128`.
- Counters: `src/ui/render.ts:404, 511-513`; reset `src/ui/app.ts:798`.
- Inspector: `src/ui/app.ts:936-940`, `884-890`; `src/ui/render.ts:2064-2075, 2259`.
- Wiring gap: `src/main.ts:184-190`; `src/ui/main.ts:48`; `src/ui/bootstrap.ts:160-162`; `src/global/liveProvider.ts:31-52,90-92`.
- Verification runs: 113 browser-side UI tests + 23 worker tests PASS (MEASURED).

## 10. Production Changes

**NONE.** Audit only.