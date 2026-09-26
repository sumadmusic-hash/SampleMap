# STEP58 — Global D1 Browser Read Wiring Report

Audit + minimal implementation + verification. Only the missing authenticated-
entry wiring was added; nothing else was redesigned.

## VERDICT: B

(Implementation complete and fully regression-tested. The only unverified
surface is the LIVE end-to-end browser run with a real D1 Worker: this
environment has no authenticated Audiotool session and no
`VITE_GLOBAL_WORKER_URL`, so those checks are NOT VERIFIED per the rules.)

## What was wired (exactly)

- `src/main.ts` — `mountLiveSampleMap(...)` now receives the single provider that
  already backs the publish queue (`publishProvider` from
  `resolvePublishProvider()`) and forwards it as `globalIndex` to
  `mountAuthenticated(...)` when `VITE_GLOBAL_WORKER_URL` is configured.
- `src/global/liveProvider.ts` — new pure helper `readProviderFor(provider, live)`:
  returns the SAME shared provider when a live Worker URL is set, else `undefined`
  (offline map read stays unwired — byte-for-byte previous behavior).
- `src/global/liveProvider.test.ts` — 4 new focused tests pinning the decision +
  the shared-provider `/map` read.

## DATAFLOW (final runtime chain)

`VITE_GLOBAL_WORKER_URL` → `createGlobalProvider({ baseUrl })` → `GlobalSampleIndex`
(same instance as the publish queue) → `mountAuthenticated({ globalIndex })` →
`app.refreshGlobalPoints()` → `queryMapViewport()` → `app.globalPoints` →
`mergeMapPoints(local, global)` → `renderSampleMap`.

(Reviving `globalIndex` also re-activates the designed 16J `GlobalLookup` reuse
during local analysis — a documented, intended consequence of wiring
`globalIndex`, not a redesign.)

## OFFLINE BEHAVIOR: PASS

With no `VITE_GLOBAL_WORKER_URL`: `readProviderFor` → `undefined`, so
`refreshGlobalPoints()` is not invoked, `queryMapViewport` is never called, the
server never becomes mandatory, and the POC boots to the `login` screen exactly
as before (verified by the offline-boot browser smoke + full Vitest suite).

## PUBLISH PATH: PASS / UNCHANGED

Same `publishProvider` instance continues to back `GlobalPublishQueue`; queue
creation, per-sample outcome handling, endpoints, payloads and auth are all
untouched. Reusing one instance for publish + read avoids a second provider.

## LOCAL SEARCH ISOLATION: PASS

`SearchEngine` still searches only the local IndexedDB index
(`searchEngine.ts:100`); global points never enter Search Results until the
existing explicit "Hydrate Locally" action runs. Regression suite green.

## SOUND SPACE ISOLATION: PASS

`openSoundSpace()` still projects only the local `index.getAll()` snapshot
(`app.ts:1350-1351`); global map points are not added to the local index
automatically. Regression suite green.

## UNIT TESTS: 1337/1337 (was 1333; +4 new wiring tests) — full Vitest suite; worker suite 23/23.

## TSC: PASS

## PLAYWRIGHT: 9/9 (offline-boot smoke on the real `src/main.ts` POC entry:
1/1; existing harness browser specs: 8/8). The full 202-spec suite was NOT
re-run: Playwright's webServer expects port 5176 while STEP54 pinned
`vite.config.ts` to 5173 (pre-existing drift unrelated to this STEP). No
failures occurred in anything actually run.

## LIVE D1 BROWSER: NOT VERIFIED

No authenticated Audiotool OAuth session and no `VITE_GLOBAL_WORKER_URL` exist
in this environment, so the real Worker map fetch, bounded viewport refreshes,
local-wins merge, global inspector, and Hydrate Locally were not exercised in a
live browser. No audible playback or authenticated behavior is claimed.

## REGRESSIONS: NONE

## PRODUCTION CHANGES
- `src/main.ts` (reuse publish provider as `globalIndex` in the live entry)
- `src/global/liveProvider.ts` (new pure `readProviderFor` decision helper)
- `src/global/liveProvider.test.ts` (tests only)

## FINAL

The previously dormant D1 browser-read path is now wired: with
`VITE_GLOBAL_WORKER_URL` set, the single existing provider flows into
`mountAuthenticated` → `refreshGlobalPoints()` → `queryMapViewport()` → map
render, while the offline case is unchanged. What remains unverified is the
live end-to-end browser run (real Worker + authenticated Audiotool session),
which this environment cannot provide.