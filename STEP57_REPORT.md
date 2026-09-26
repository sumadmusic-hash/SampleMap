# STEP57 — Global D1 Wiring Provenance Audit

AUDIT ONLY · no production changes · no `.env`/config/UI/map/provider changes.
Classification per item: OBSERVED / MEASURED / INFERRED / NOT VERIFIED. No git
history exists (this directory is not a git repository — MEASURED), so all
provenance comes from the current filesystem + retained STEP reports.

---

## 1. Where `globalIndex` is currently defined and consumed

- Type definition: `GlobalSampleIndex` interface, `src/global/contract.ts:292`;
  `queryMapViewport` at `src/global/contract.ts:318`.
- Dep slot: `globalIndex?: GlobalSampleIndex` in `SampleMapAppDeps`
  (`src/ui/app.ts:414`); the `mountAuthenticated` opts mirror it
  (`src/ui/main.ts:34`); `buildBrowserDeps` forwards it
  (`src/ui/bootstrap.ts:204`).
- Consumed by: `refreshGlobalPoints`/`selectGlobalPoint`/`inspectGlobalPoint`/
  `hydrateGlobalSample` (`src/ui/app.ts:1001,1070,1089,1164`); `GlobalLookup`
  construction (`src/ui/bootstrap.ts:160-162`); map merge+render
  (`src/ui/map/mapRender.ts:130-134`, `src/ui/map/mapView.ts:477-520`).
- The **only** injection point is the `globalIndex` option on
  `mountAuthenticated`/`buildBrowserDeps`. MEASURED: the **only** place in the
  whole project that ever passes that key is the doc-comment usage example
  `src/ui/main.ts:23` (`buildBrowserDeps({ client, doc, globalIndex: provider })`).
  No retained production or harness call site passes it.

## 2. Where `globalIndex` was expected to be created/injected

- Documented expectation: `src/ui/main.ts:16-25` — "pass the same live
  `GlobalSampleIndex` (e.g. from `createGlobalProvider`) as `globalIndex` so the
  analysis pipeline reuses globally-known analyses".
- STEP16K defines the intended flow:
  - bootstrap returns `globalIndex` + `resolveSample` (STEP16K_REPORT.md:24, 41, 47);
  - `mountAuthenticated` calls `refreshGlobalPoints()` **if globalIndex is provided**
    (STEP16K_REPORT.md:54; `src/ui/main.ts:48`);
  - `onCamera` → `refreshGlobalPoints()` (STEP16K_REPORT.md:51;
    `src/ui/app.ts:970` `scheduleGlobalRefresh`).
- So the intended injection point is the live authenticated entry
  (`mountLiveSampleMap → mountAuthenticated`) calling
  `createGlobalProvider({ baseUrl: VITE_GLOBAL_WORKER_URL })` — which was never
  done (see §3/§6).

## 3. Did `mountLiveSampleMap` ever accept/pass `globalIndex`?

**No evidence it ever did.**
- STEP16N introduced `mountLiveSampleMap` calling `mountAuthenticated(root,
  { client, doc })` **without** `globalIndex` (STEP16N_REPORT.md:16,19,31,61):
  ":19 No publishing is triggered automatically: `mountAuthenticated` is called
  **without** a `globalIndex`…".
- The current entry still omits it: `src/main.ts:184-190` passes only
  `authenticatedUserName`, `globalPublishQueue`, `globalPublishDelivery`.
- The 16M Layer-C browser chain is documented WITHOUT `globalIndex`
  (STEP16I_16M_STATUS.md:90-93): "mountLiveSampleMap → openFirstProject →
  mountAuthenticated → … → `GlobalPublishQueue` → live Worker".
- The e2e harness deps (`src/e2e/harness/main.ts:396-417`) also omit
  `globalIndex` (its provider's `queryMapViewport` returns empty, line 300-302).
- (No git history exists; conclusion is consistent across all retained reports.
  NOT VERIFIED beyond local ATLEST8/11 evidence.)

## 4. Did `VITE_GLOBAL_WORKER_URL` exist earlier?

**Yes (introduced STEP16I), and it never drove the map READ.**
- Introduced in STEP16I: `src/global/liveProvider.ts` (`createGlobalProvider`,
  `workerUrlFromEnv`, `offlineProvider`) — STEP16I_IMPLEMENTATION.md:35-37,71.
- It is honored only by the PUBLISH queue: `src/main.ts:28-29,96-102` →
  `resolvePublishProvider()` → `createGlobalProvider` → `GlobalPublishQueue`
  (`src/main.ts:110-119`). OBSERVED: no call site feeds it to `globalIndex`.
- `.env.example:13` documents it (public Worker URL, non-secret);
  STEP16I_16M_STATUS.md:95-96 notes a 16M dev session "holds a
  VITE_GLOBAL_WORKER_URL" — i.e., it was present in a session's environment at
  that time, still only for publish.
- Current `.env`: **not set** — `createGlobalProvider` therefore returns
  `offlineProvider()` (OBSERVED, `liveProvider.ts:90-92`); browsers in this env
  log "OFFLINE provider (no VITE_GLOBAL_WORKER_URL)" (reaffirmed in reports:
  STEP19_LAYER_C_LIVE_CLOSURE_REPORT.md:131, STEP18:150).

## 5. Which STEP introduced each item

| Item | STEP | Evidence |
|---|---|---|
| D1 global lookup + `/map` contract | 16A/16B (contract), 16F (worker SQL/deploy) | `STEP16A_IMPLEMENTATION.md`, `STEP16B_IMPLEMENTATION.md`, `STEP16F_IMPLEMENTATION.md`; `contract.ts:292/318`; `provider.ts:439-489` |
| `queryMapViewport` (browser call) | 16K (viewport param) / 16L (camera bbox + paging) | STEP16K_REPORT.md:9,23,43; STEP16L_REPORT:14,192 |
| `globalIndex` (UI dep) | 16K | STEP16K_REPORT.md:24,41,54 |
| browser global-point merging | 16K | `globalMapPoints`/`mergeMapPoints` (STEP16K_REPORT.md:32; mapView.ts:477-520) |
| live worker configuration (`VITE_GLOBAL_WORKER_URL`) | 16I | STEP16I_IMPLEMENTATION.md:35-37,71; `liveProvider.ts` |

## 6. Was the live D1 browser path later removed/disabled/bypassed?

**No removal evidenced — it was never completed (deferred/blocked from the start).**
- STEP16N explicitly deferred it: ":95 Global publication of a real analyzed
  sample (`/map` points) **BLOCKED / deferred — deliberately not wired into this
  step** (Worker publish is an open question)" and ":19 …without a `globalIndex`".
- Browser rendering of global map points is consistently reported **NOT
  VERIFIED / BLOCKED**, never removed:
  - STEP16K_LIVE_VERIFICATION.md:146,328,382 — "Actual browser DOM rendering of
    global map points … NOT VERIFIED (environment limitation)".
  - STEP16M_LAYER_C_INVESTIGATION.md:68 — "`mountAuthenticated` (
    `src/ui/main.ts`) has **zero callers**" pre-16N; the Layer-C glue was
    described as "exactly one small glue addition" (:119-128) that was never
    completed.
  - STEP16I_16M_STATUS.md:116 — "Global Map appearance … **BLOCKED (browser)**;
    browser render = Layer C".
  - STEP19_LAYER_C_LIVE_CLOSURE_REPORT.md:17,131,158,187 — Layer C closed BLOCKED;
    `VITE_GLOBAL_WORKER_URL` empty → OFFLINE provider in-browser.
- No retained report or code path describes a browser entry that passed
  `globalIndex` and had it later removed.

## 7. Does the screenshot state match a previously evidenced implementation state?

**Partially.** The D1 **server→model** side was verified live: real Worker
`queryMapViewport` returned 10 live points including the published point
(`kick @ 0.350, 0.265`) and the real `globalMapPoints` bridge converted them to
map points (STEP16K_LIVE_VERIFICATION.md:140,146; verified server-side
appearance also PASS at STEP16I_16M_STATUS.md:116). The **browser rendering** of
those points is exactly what was documented BLOCKED/NOT VERIFIED (16K:146,
16M:116, 19:17). So the screenshot's "100+ global points rendered in the
SampleMap browser UI" matches the **intended-but-deferred Layer C state**, not
any state that was verifiably rendered before. The sample name `string ensemble 2`
appears nowhere in the codebase or reports (MEASURED) — its real-world origin is
NOT VERIFIED.

## 8. Current absence classification

**Incomplete integration (primary) + environment-only difference (contributor).**
Not intentional architecture (reports call the browser glue "one small, additive
addition", STEP16M:119-128), not an accidental regression (no removal evidence
anywhere), not a schema/provider/UI defect. The read path was designed (16K) and
unit/harness-tested, but the authenticated live entry never wired
`createGlobalProvider(...) → globalIndex`, and this environment additionally
lacks the env var and an authenticated session.

## 9. Last known project state with global D1 browser map points wired

**Never wired in a browser entry.** The last state where REAL D1 global map
points entered the map **model** was the **STEP16K live verification**
(STEP16K_LIVE_VERIFICATION.md:140,146): real Worker `provider.queryMapViewport`
→ 10 live points → real `globalMapPoints` bridge (Node, no browser render).
After that, every retained artifact (16N entry, 16M status, Layer C closure,
harness, current `src/main.ts`) shows the browser global-read path unwired.

---

## Source Evidence (file:line)

- deps/injection: `src/ui/app.ts:414`; `src/ui/main.ts:16-25,34,48`; `src/ui/bootstrap.ts:160-162,204`.
- entry wiring: `src/main.ts:28-29,96-102,110-126,184-190`; contract `src/global/contract.ts:292,318`.
- worker: `workers/d1-worker/src/provider.ts:439-489`; `workers/d1-worker/src/index.ts:79-80`.
- reports: STEP16K_REPORT.md:24,41,51,54; STEP16K_LIVE_VERIFICATION.md:140,146,328,382;
  STEP16N_REPORT.md:16,19,31,61,95; STEP16M_LAYER_C_INVESTIGATION.md:68,119-128;
  STEP16I_16M_STATUS.md:90-96,116; STEP19_LAYER_C_LIVE_CLOSURE_REPORT.md:17,131,158,187;
  STEP16I_IMPLEMENTATION.md:35-37,71; `.env.example:13`.
- harness: `src/e2e/harness/main.ts:300-302,396-417`.
- Tests exercising the read with a fake provider: `src/ui/globalMapIntegration.test.ts`,
  `src/ui/step16L.test.ts` (113 tests PASS, MEASURED).

## Production Changes

**NONE.** No `.env` value was read or modified during this audit.