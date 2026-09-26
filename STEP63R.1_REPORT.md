# STEP63R.1 — Real-Browser Startup-Timing Verification (OAuth + Real Backend)

**Status:** COMPLETE
**Scope:** AUDIT ONLY. No production behavior changed. The only additions are temporary `[sm-timing]` console markers (listed in Appendix A). The audit spec: observe the REAL OAuth-authenticated startup path in the REAL browser with the REAL backend, identify the real blocking chain, and determine whether the user's ~30s delay reproduces.

---

## Executive Verdict

> **A — The delay reproduces in the real browser and the root cause is identified — with the exact ~30 s figure NOT reproduced. The measured delay is ~14.6–16.9 s, and its dominant term is deterministic identity-resolution pagination (~12.9–13.4 s on EVERY load).**

The multiple-second startup delay is **reproduced** (3/3 runs, real Chrome + real OAuth session + real backend) and the blocking chain is **measured end-to-end**. It is NOT caused by failures or SDK retry loops. It is caused by one slow, awaited, fully-paginated network walk: `resolveAuthenticatedUserIdFromProjects` serially fetches **every page** of the user's project list (`pageSize: 25`, ~59 pages ≈ 1,450–1,500 projects, each page ~200 ms ⇒ ~12.5–12.9 s) on the critical path **before the first render**. This term is present in 100% of loads and grows linearly with the account's project count.

The user's exact ~30 s was **not** reproduced (we measured 14.6–16.9 s). The gap is magnitude, not mechanism: the same blocking phase can run ~2× slower under the user's real conditions (per-RPC latency, first-load bundle/WASM, token-refresh round trip when the session expired, busier project's `doc.start()`). See §6.

This corrects STEP63R's verdict: the earlier "unbounded SDK retry loop on `getToken`-undefined" conclusion was an artifact of a bug in the PAT diagnostic (`createPATAuth` was spread into client options instead of nested as `auth`). The real, repeatedly-measured mechanism is **slow sequential full pagination, not error/retry**.

---

## 1. Methodology

Driver: `scripts/step63r-real-browser.mts` — launches **real installed Google Chrome** (`channel: "chrome"`) with a **copy of the user's real profile** (`/tmp/sm-real-profile`: real OAuth tokens in `http://127.0.0.1:5173` Local Storage, clientId `64f0978f-d3f5-48a6-af78-36a802a8f79a`, access token valid to 2026-10-10) against the **real live Audiotool backend**, loading the real dev app on `http://127.0.0.1:5173/`.

Three serial runs: **A** cold open, **B** reload, **C** second reload. Captured per run:

- wall-clock to **first useful render** = `[data-testid="sound-space-canvas"]` (map canvas) mounted;
- every `[sm-timing]` marker (real-time console capture);
- `performance.getEntriesByType("resource")` filtered to `audiotool.com`/`rpc.audiotool.com` hosts (decoded request-by-request);
- IndexedDB snapshot after settle (STEP62 startup-state).

Confirmed no synthetic identity: output line `OK — authenticated as "users/sumad"` from the real OAuth session in every run.

## 2. End-to-End Timing (measured)

| Phase | Run A (cold) | Run B (reload) | Run C (2nd reload) |
|---|---|---|---|
| **time to first useful render (map canvas)** | **16948 ms** | **14805 ms** | **14630 ms** |
| `main:start` (after nav) | +96 ms | +98 ms | +87 ms |
| `audiotoolSdk` (OAuth boot incl. GetWhoami RPC) | 1276 ms | 338 ms | 408 ms |
| `openFirstProject` total | 2120 ms | 1209 ms | 1191 ms |
| &nbsp;&nbsp;· `listProjects` (1 page, pageSize 5) | 367 ms | 335 ms | 362 ms |
| &nbsp;&nbsp;· `client.open` (OpenSession + document-service wasm) | 967 ms | 810 ms | 802 ms |
| &nbsp;&nbsp;· `doc.start()` | 1153 ms | 399 ms | 389 ms |
| `buildBrowserDeps` total | 13394 ms | 13149 ms | 12883 ms |
| &nbsp;&nbsp;· `openStores` (IndexedDB) | 0.2 ms | 0.1 ms | 0.1 ms |
| &nbsp;&nbsp;· synchronous store/classifier/`new AudioContext()` | ~160 ms | ~0 ms | ~0 ms |
| &nbsp;&nbsp;· **identity resolution (awaited)** | **13234 ms** | **13148 ms** | **12882 ms** |
| &nbsp;&nbsp;&nbsp;&nbsp;· `projects.listProjects` FULL pagination | **12891 ms** | **12732 ms** | **12553 ms** |
| &nbsp;&nbsp;&nbsp;&nbsp;· `users.listUsers` (display-name fallback) | 342 ms | 415 ms | 328 ms |
| `mountSampleMap` → `refreshSearch` | ~25 ms | ~10 ms | ~10 ms |

Identity resolution is **78–88% of total time-to-usable** in all three runs (A: 13.23 s of 16.95 s; B: 13.15 s of 14.81 s; C: 12.88 s of 14.63 s). Only the OAuth boot and `openFirstProject` precede it; both are small and bounded.

## 3. Network Timeline (the decisive evidence)

All three runs show the identical pattern: after `GetWhoami`/`openFirstProject` complete, a **59-page serial `ListProjects` burst** occupies ~12.5–12.9 s, one fetch at a time:

- **Run A:** 59 sequential `ProjectService/ListProjects` fetches from +3647 ms to +16299 ms (`dur` 165–421 ms, ~200 ms avg), then one `UserService/ListUsers` (+16539 ms) before mount at +16886 ms.
- **Run B:** same — 59 pages +1600→+14332 ms, `ListUsers` +14332 ms, mount +14794 ms.
- **Run C:** same — 59 pages +1656→+14209 ms, `ListUsers` +14209 ms, mount +14568 ms.

The pages are strictly sequential (each awaits the previous `nextPageToken`), and the walk **always** runs to the terminal page even though every run records exactly **1 sole-member candidate** (`projects.listProjects:end … (1 candidate(s))`). The remaining traffic during this window is only the opened document's heartbeat `DocumentService/Ping` (~every 1.15 s, non-blocking, and the only other traffic).

## 4. Identity Resolution — Root Cause Detail

Source: `src/identity/authenticatedUser.ts:59-98` (`resolveAuthenticatedUserIdFromProjects`).

- Loop: `do { listProjects({ pageSize: 25, pageToken }) } while (pageToken)` — paginates the **entire** project chain, ~59 pages ≈ 1,450–1,500 projects for this account.
- `pageSize: 25` and a strictly sequential `do/while` mean per-page latency (~200 ms) is additive: 59 × ~210 ms ≈ 12.5–12.9 s.
- **No early exit:** the code only checks `candidates.size !== 1` **after** the while loop completes (line 96). The first page already establishes the unique sole-member candidate (`creatorName === members[0]`); subsequent pages can only reduce certainty (add conflicting members ⇒ `undefined`). Short-circuiting on uniqueness would cut this phase from ~13 s to ~0.4 s while preserving safe-by-default semantics for the common case — see §7.
- `resolveViaDisplayName` then runs **afterwards**, awaited, adding ~0.33–0.42 s (`listUsers`, pageSize 2) — on the same critical path.
- **On the critical path:** `buildBrowserDeps` (src/ui/bootstrap.ts:141-147) `await`s `resolveAuthenticatedUserId` before constructing the machiniste and returning deps; `mountSampleMap` cannot run until it resolves. This is a hard gate before first render.

Independent confirmation (Node PAT diagnostic, `scripts/step63r-startup-timing.ts`, same live backend): full-paginated identity `projects.listProjects` = **13797.5 ms**, combined `resolveAuthenticatedUserId` = **12679.9 ms** — same 12.7–13.8 s class outside the browser.

## 5. STEP62 Startup-State Verification (real browser)

Snapshot taken 4 s after the map canvas mounted, in all three runs:

```json
{"stores":["collections","jobs","samples"],
 "collections":{"count":0},
 "jobs":{"count":169,"byStatus":{"queued":169}},
 "samples":{"count":0}}
```

Identical across A/B/C. The 169 queued jobs are **legacy state** from the user's earlier sessions — during our three real startup runs, **no new jobs were created, no samples were analyzed, no collections written** (counts flat). This reconfirms, in the real browser with a real session, that **STEP62's own-population pass does not run at startup** and contributes nothing to the delay.

## 6. The User's ~30 Seconds

Reproduced in **class**, not exact magnitude:

- Measured here: **14.6 s (B/C) – 16.9 s (A)** until the map is usable — already 3–5× a healthy startup.
- The blocking phase is the same in kind as reported: the UI sits on a blank loading state for ~13 s of identity pagination on **every** load (caching does not help — reloads B/C repeat the full walk).
- The residual gap to the user's ~30 s is plausibly environmental, all in the same phase or adjacent: per-RPC latency on their network (each ~200 ms page → ~350 ms ⇒ 59 pages ≈ 20–22 s), plus first-load bundle/WASM overhead, an expired-token → OAuth refresh round trip on a cold start (can add several seconds and a login popup), and a slower `doc.start()` for a busier open project. None of these need a different mechanism.

**Per the audit spec we state explicitly: the exact ~30 s was NOT reproduced here; the issue is NOT solved; only the blocking chain and its dominant term are now definitively measured.**

## 7. Root Cause (evidence-based ranking)

1. **Identity-resolution full pagination (dominant, deterministic):** `resolveAuthenticatedUserIdFromProjects` walks ~59 pages × ~200 ms serially = **~12.9–13.4 s on the critical path, every load** (§3, §4). This alone explains ~78–88% of startup and scales with account size.
2. **Awaited gating:** the identity walk is `await`ed inside `buildBrowserDeps` before `mountSampleMap`; there is no render-early-then-resolve path (§4).
3. **`openFirstProject` (1.19–2.12 s):** second awaited network sequence (`listProjects` + `OpenSession` + document-service wasm + `doc.start`), small but non-negligible, and it too gates mount.
4. **SDK/OAuth boot (0.34–1.28 s):** `GetWhoami` RPC; small, only large on cold starts.
5. **Local/render work (F):** negligible — `openStores` 0.1–0.2 ms, mount→usable ~10–25 ms.

**Not implicated:** no retry loops fired (corrected from STEP63R), no errors, no `getToken` failures, no STEP62/own-discovery work, no deferred hidden scheduler (see §5 and network timeline). The delay is pure sequential awaited network latency on an unbounded-by-content walk.

## 8. Recommended Fixes (conceptual only — NOT implemented, per audit spec)

1. **Bounded/early-exit identity resolution.** Stop paginating once a unique sole-member candidate is established (optionally after verifying a bounded number of subsequent pages for agreement), and/or cap pages. Preserves safe-by-default agreement semantics for the verification window while cutting ~12.5 s → ~0.4–1 s. Highest impact; lowest risk to own-detection correctness.
2. **Bypass the project crawl entirely.** OAuth boot (`GetWhoami`) already returns an authenticated identifier — in all three runs the app logged `authenticated as "users/sumad"`, i.e. already the stable `users/{slug}` id that the 13 s crawl produces. If `audiotool().userName` is (or is sanitized-into) the stable id, identity resolution can be removed from the critical path completely.
3. **Decouple identity from mount.** Mount the app with unresolved identity (`undefined` — already a designed-for state) and apply the resolved id when ready. Removes the hard gate; no SPI changes.
4. **Parallelize/defer `openFirstProject`** so `mountSampleMap` isn't blocked behind `client.open` + `doc.start`, and re-check `doc.start()` cost on slow days.

## Appendix A — Temporary instrumentation & artifacts (STEP63R/STEP63R.1; to be reverted)

| Path | Change |
|---|---|
| `scripts/step63r-real-browser.mts` | NEW drivers + decodes real Chrome (profile copy `/tmp/sm-real-profile`), real OAuth, real backend; A/B/C runs; network + IDB capture. Temporary. |
| `scripts/step63r-startup-timing.ts` | PAT diagnostic — FIXED this STEP: `auth: createPATAuth(PAT)` nested correctly; `logLevel: "error"`. Temporary. |
| `scripts/probe-profile.mts` | Profile/token probe (origin 127.0.0.1:5173). Temporary. |
| `src/identity/authenticatedUser.ts` | `[sm-timing] identity:*` / `projects.listProjects:end`, `resolveAuthenticatedUserIdFromProjects:start`. |
| `src/ui/bootstrap.ts` | `[sm-timing] buildBrowserDeps:start/openStores/identityResolution/total`. |
| `src/ui/main.ts` | `[sm-timing] mountAuthenticated:*`, `buildBrowserDeps:end`. |
| `src/ui/liveSession.ts` | `[sm-timing] openFirstProject:*`. |
| `src/main.ts` | `[sm-timing] main:start/localIndexAndProvider/audiotoolSdk`. |
| `src/e2e/harness/main.ts` | existing STEP63R `smTiming` util (unchanged). |

Raw evidence captured in `/tmp/step63r-real-2.log` (Run A/B/C markers + network timeline + IDB snaps).

**Recommended next action (outside this audit):** implement fix #1 or #2 above and re-run this same real-browser driver to measure the reduction; then re-measure against the user's environment.