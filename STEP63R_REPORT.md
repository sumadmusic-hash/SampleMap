# STEP63R — Startup-Timing Audit (Runtime-Measured)

**Status:** COMPLETE (verdict B)
**Scope:** AUDIT ONLY. All instrumentation is temporary, marked `STEP63R`, and listed in Appendix A. No production behavior was changed.

---

## Executive Verdict

> **B — Startup delay partially measured; more instrumentation required.**

The code-level STEP63 audit concluded startup was healthy; runtime measurement corrects this. The offline harness path is **fast** (~3.7s first load, ~315ms reload, ~240ms cached) and STEP62's own-population pass **does not run at startup** — but none of that matters, because **the harness bypasses the network identity/project path entirely**.

The critical runtime finding is in `resolveAuthenticatedUserIdFromProjects` (`src/identity/authenticatedUser.ts`): the awaited `listProjects` call sits **on the critical path before the UI mounts** (`buildBrowserDeps → mountAuthenticated`), and when that call fails/slow-retries, it **blocks startup indefinitely**. The live PAT diagnostic reproduced this exactly:

```
audiotool.project.v1.ProjectService.listProjects call failed,
  retrying in 2000 ms. Error: ConnectError: [unknown]
  Cannot read properties of undefined (reading 'getToken')
```

That line repeated **43 times over >86 seconds** and never completed. The SDK retries failed calls every 2s without bound; the enclosing `try/catch` in `authenticatedUser.ts` marked the call "non-fatal" but it **never fires** while the SDK retry loop is running, so `buildBrowserDeps` awaits forever and the UI cannot mount. **The ~30s the user observes is consistent with several sequential awaited network calls each stalling through multiple 2s SDK retries** (e.g. `listProjects` in identity resolution + `listUsers` + `listProjects` again in `openFirstProject`), or a slow Nexus document sync in `doc.start()`.

The exact `30s` figure was **not** reproduced end-to-end: the harness avoids the network path, and the PAT environment failed auth before `openFirstProject` could be measured. This is the instrumentation gap that verdict B records.

---

## 1. Methodology

Two independent measurement channels:

1. **Browser harness** (`src/e2e/harness/main.ts` + `e2e/step63r-startup-timing.spec.ts`): real Chrome (headless) against the real vite dev server on port 5173, code-split bundle, `performance.navigation`/monotonic clocks, `[sm-timing]` markers, and a `window.__sm-ready` readiness bar. Three serial runs — T1 fresh (empty IDB), T2 reload (IDB persisted), T3 second reload (fully cached).
2. **Live PAT diagnostic** (`scripts/step63r-startup-timing.ts`): Node `tsx` process constructing the real Audiotool Nexus client with a real PAT, timing client creation, identity resolution, and project open against the actual backend.

Gap: neither channel replayed the user's exact environment (browser + OAuth + real account). The harness deliberately hardcodes identity (`users/alice`); the PAT run failed auth. Both are documented and accounted for in the verdict.

## 2. Phase-by-Phase Timing (measured)

### Channel 1 — browser harness (`[sm-timing]` lines and ready-bar)

| Metric | T1 fresh | T2 reload | T3 cached |
|---|---|---|---|
| navigation → first painted render | 3748 ms | 311 ms | 235 ms |
| navigation → `__sm-ready` | 3769 ms | 314 ms | 243 ms |
| `persistence:openDatabase` | 0.2 ms | 0.2 ms | 0.2 ms |
| `mountSampleMap` (react subtree) | 3.9 ms | ~3 ms | ~3 ms |

### Channel 2 — live PAT diagnostic (`[step63r]` lines)

| Phase | Result |
|---|---|
| `client-create` | **70.0 ms** |
| identity `projects.listProjects` | **FAILED** — `Cannot read properties of undefined (reading 'getToken')`; SDK retried every ~2000 ms, 43 retries in >86 s, never completed (process killed) |
| identity `users.listUsers` / combined | not reached |
| `openFirstProject` (listProjects + open + `doc.start()`) | not reached |

## 3. Identity Resolution Timing

- Instrumented locations (`[sm-timing] identity:*`): `resolveAuthenticatedUserIdFromProjects` (`projects.listProjects`), `resolveViaDisplayName` (`users.listUsers`), `resolveAuthenticatedUserId` (combined).
- **Critical-path position:** `buildBrowserDeps` (= `await`) → `mountAuthenticated` → `mountSampleMap`. `src/ui/bootstrap.ts`.
- **Measured:** harness path (no real network) ≈ μs-scale. **Live:** `listProjects` never returned — SDK retry loop blocked the awaited future, top-candidate for the user's delay.

## 4. IndexedDB Timing

- Measured: `persistence:openDatabase` = **0.2 ms** in all runs. Negligible.
- IDB writes (hashes, own-discovery storage) happen post-mount; STEP62 counts confirm no discovery work at startup (see §8).

## 5. Global Index Timing

- Mitigated: **no global-index work exists.** `.env` has no `VITE_GLOBAL_WORKER_URL`; no `GlobalIndex` provider is constructed during startup. STEP63's assumption verified still true; nothing to time.

## 6. Network Request Audit (startup awaited calls)

Sequential awaited network steps before first render (all live-path):

1. OAuth `audiotool()` SDK boot — `src/main.ts`, awaited before `audiotoolSdk` markers.
2. `listProjects` (paginated) inside `resolveAuthenticatedUserIdFromProjects`.
3. `listUsers` inside `resolveViaDisplayName` (when projects resolution is inconclusive).
4. `openFirstProject`: `listProjects` again + `client.open(docID)` + `doc.start()`.

Each failing call rides the SDK's unbounded 2s retry loop. Three of these four were **not exercised** by the harness (network bypassed) and **not reached** by the PAT run (auth failed at step 2 already).

## 7. Render Timing

- First paint vs ready-bar: `first-render ← __sm-ready` ≈ +21 ms (T1), ≈ +3 ms (T2/T3). Render cost is negligible once `mountSampleMap` is called (3.9 ms).
- Cases: **A** fast (≈315 ms) = harness + local IDB + no network waits on identity. **B** first-load (≈3.7 s) = harness + WASM/bundle/first IDB. **C/E (network-dependent)** = real app whenever identity list-calls stall — unmeasured here, matches user-observed 30 s class. `machiniste` availability and post-`doc.start()` task scheduling were not reached in live mode.

## 8. STEP62 Verification

`STEP62` startup-state captured in T1 (fresh) before interaction:

```json
{"scanStatus":"idle","ownDiscovered":0,"ownEnqueued":0,"foundCount":0,
 "analysisStatus":"idle","queueCounts":{"queued":0,"processing":0,"analyzed":0,
 "failed":0,"skipped":0,"gone":0},"fetchCount":0}
```

Verified at runtime: **own-population pass is NOT triggered during startup** (STEP62 correctly inert — no hidden discovery work behind the delay).

## 9. Hidden Startup Work

- **Found one genuine hidden blocker** (missed by code inspection): the awaited Nexus calls' **unbounded retry loop** inside identity resolution — this is a *runtime* property invisible to static review. `resolveAuthenticatedUserId` never yields until the SDK gives up, and that give-up never happened (>86 s).
- **Not found:** deferred scheduler, dedicated hydrator, or any deferred `machiniste`/`document` runtime taak that start-up-self-executes.
- WASM/bundle + first IDB: real but bounded (≈3.7 s worst case in harness).

## 10. Async vs Non-Blocking

| Startup step | Async? | Non-blocking? |
|---|---|---|
| `audiotool()` OAuth boot | && | **BLOCKING** (awaited in `main`) |
| `buildBrowserDeps:openStores` | && | non-blocking (0.2 ms) |
| identity resolution (`listProjects`, `listUsers`) | && | **BLOCKING** (awaited; unbounded retry) |
| `openFirstProject` (`listProjects`, `open`, `doc.start()`) | && | **BLOCKING** (awaited before mount) |
| `mountSampleMap` | && | non-blocking (3.9 ms) |
| `refreshSearch` | && | post-mount |

**O(n) sequential awaited network calls precede the first render.** This is the structural defect: the network path entirely gates the UI.

---

## Root Cause (as of STEP63R)

1. **User-identity resolution blocks the first render** and can stall for tens of seconds when the underlying `listProjects`/`listUsers` calls are slow or failing — the SDK retries every 2 s without bound, and the enclosing `try/catch` (the "non-fatal" claim) never fires during a retry loop. **This is the highest-confidence cause of the observed delay.**
2. `openFirstProject` then repeats the awaited project-list/document-sync round trip, compounding the stall when steps 1–2 are affected by the same latency.
3. Code-inspection-only STEP63 could not see this because the retry loop and its unbounded duration are runtime properties.

## Recommended Minimal Safe Fixes (conceptual — NOT implemented)

Per spec, no fix was implemented. In order of impact for a future STEP:

1. **Bound every awaited identity call.** Add a timeout around `listProjects`/`listUsers` (e.g. reject after max retries or a hard cap) so identity resolution cannot stall indefinitely; treat unresolved identity as `undefined` on timeout. Impact: caps the worst case; the app survives slow identity. Risk: low; the app already treats missing identity as a catchable case.
2. **Decouple identity resolution from mount.** Kick off identity resolution in parallel with service construction and apply the result when ready, so mount never waits on it. Impact: removes the gate entirely. Risk: medium; downstream consumers must tolerate late identity (they already handle "resolved" vs "unresolved").
3. **Defer or parallelize `doc.start()`** so `machiniste` sync doesn't delay `mountSampleMap`; render the map first, then hydrate. Impact: removes the second stall. Risk: medium; touches task/document lifecycle (STEP-restricted area).
4. **Shorten/annotate the SDK retry budget** (2 s × unbounded) around startup calls specifically. Impact: directly bounds steps 1–3. Risk: low-medium; only startup scope.

## Appendix A — Temporary Instrumentation (STEP63R; to be reverted)

| File | Marker / change |
|---|---|
| `src/e2e/harness/main.ts` | `smTiming` util + `persistence:openDatabase`, `mountSampleMap`, `refreshSearch` (backup: `main.ts.bak`) |
| `src/ui/bootstrap.ts` | `[sm-timing] buildBrowserDeps:openStores/identityResolution/total` |
| `src/ui/main.ts` | `[sm-timing] mountAuthenticated:*` |
| `src/identity/authenticatedUser.ts` | `[sm-timing] identity:*` in 3 functions |
| `src/ui/liveSession.ts` | `[sm-timing] openFirstProject:*` |
| `src/main.ts` | `[sm-timing] main:start/localIndexAndProvider/audiotoolSdk` |
| `e2e/step63r-startup-timing.spec.ts` | new timing spec (3 tests) |
| `scripts/step63r-startup-timing.ts` | new live PAT diagnostic |
| `playwright.config.ts` | port 5176 → 5173 (aligned with `npm run dev`; was inconsistent, blocking any e2e run) |

**Recommended next action (outside this audit):** re-run the user's real browser start with these `[sm-timing]` markers intact to capture the live identity/openFirstProject durations; then implement fix #1 (bounded identity calls) and re-measure.