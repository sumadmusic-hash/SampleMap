# STEP16R — E-P0 BASELINE REPORT

**Step**: STEP16R E-P0 — Baseline Lock
**Date**: 2026-09-05
**Scope**: Read-only verification. No product source modified. Deliverable: this report.
**Spec anchor**: `STEP16R_PRODUCT_UX_SPEC.md` (frozen) — E-P0 baseline lock, do not proceed to E-P1 without authorization.

---

## 1. Verification Results

### 1.1 TypeScript — PASS (app + worker)
- App: `npm run typecheck` (`tsc --noEmit`) — **0 errors, exit 0**.
- Worker: `npm run typecheck` in `workers/d1-worker` — **0 errors, exit 0**.

### 1.2 App Vitest — PASS
- `npx vitest run` — **32 test files passed (32)**, **576 tests passed (576)**, exit 0. Duration 2.06s.

### 1.3 Worker Vitest — PASS
- `npx vitest run` in `workers/d1-worker` — **2 test files passed (2)**, **19 tests passed (19)**, exit 0. Duration 1.02s.

### 1.4 Vite production build — PASS
- `npm run build` (`tsc --noEmit && vite build`) — PASS, exit 0, built in 628ms. Only note: pre-existing `> 500 kB` chunk-size warning (`index-0xkoVNm3.js` 782.15 kB / gzip 134.16 kB) — known, non-blocking, unchanged.

### 1.5 Playwright (e2e, offline harness, system Chrome @5176) — PASS
- `npx playwright test` — **28 passed (28)**, exit 0, 10.8s. Suite: `e2e/step16m.spec.ts` (16M-01..16M-20, shared page, real decode/classification) + `e2e/final-ui-phase1.spec.ts` (FP-01..FP-08).

### 1.6 16I live verification (`scripts/live-verify-16i.ts`) — PASS
- `npx tsx scripts/live-verify-16i.ts` — **11 VERIFIED, 0 NOT VERIFIED, 0 SKIPPED**, exit 0.
- All cases A–J against the live deployed Worker `https://samplemap-d1-worker.sumadmusic.workers.dev` (recorded deployment Version `8b730b53-a57c-4a8a-bf45-29e07b258122`, HEAD 16Q structural V2 validation). Including: publish→stored, idempotent republish→already-known, sample/content lookup, conflict→rejected (no last-write-wins), no-audio payload (1058 bytes, features+analysis only), positive usage-acceptance gate→flush→D1→lookup known (marker `published`), negative gate (transfer-readback-failed→unknown), offline→restart→live publish.

### 1.7 16M live verification (`scripts/step16m-live-verify.ts`) — PASS
- `npx tsx --env-file=.env scripts/step16m-live-verify.ts` (PAT from `.env`, never printed) — **23 VERIFIED, 0 NOT VERIFIED**, exit 0.
- Full real chain: PAT client → list (20 samples) → real one-shot `samples/0001a13b-074e-5245-a443-1e19971190bd` ("Flume Tennis Snare") → WAV 113881 B → decode 44100Hz/2ch/0.645s/28452 frames → real `extractFeatures` (flatness 0.425, t/n 0.575) → real `HeuristicClassifier` (openhat @0.320, secondary noise/hihat/cymbal/snare) → `computePosition` V2 `map-v2` (0.4120, 0.8781) → real `AnalysisPipeline` → IndexStore record (class=openhat, contentHash `77d8631ca0a1…`) with **persisted V2 position deterministic** (`persisted=(0.4120,0.8781) == recomputed=(0.4120,0.8781)`) → SearchEngine returns it → real project opened (`projects/0027eb44-0ccf-477f-b8a9-15a2ae9ac1b9`) → real SyncedDocument → real `MachinisteService.send` (machiniste `5bc6dfb6-598e-40a8-bbed-b66102faa685`) → **read-back verified on live backend document** (channel→sample entity `2e329ae1-7192-4481-b303-6188b8dd8d94`→`samples/0001a13b-...-90bd`) → idempotency (2nd run same build → `skipped`, **0** redundant audio fetches).

### 1.8 Layer-C status — BLOCKED (only known blocker, unchanged)
The only remaining known blocker is the interactive browser OAuth session (human click-through required). Non-interactive proof remains green: vite dev server boots at `http://localhost:5176` (matching the Worker `API_ALLOWED_ORIGIN`), harness HTTP 200 + CORS preflight 204, `#login` "Log in with Audiotool" renders, `VITE_GLOBAL_WORKER_URL` honored. This is a verification task, not an implementation gap.

---

## 2. Exact Test Counts

| Gate | Result | Files | Tests | Exit |
|---|---|---|---|---|
| tsc app | PASS 0 errors | — | — | 0 |
| tsc worker | PASS 0 errors | — | — | 0 |
| App vitest | PASS | **32** | **576** | 0 |
| Worker vitest | PASS | **2** | **19** | 0 |
| vite build | PASS | — | — | 0 |
| Playwright | PASS | — | **28** | 0 |
| 16I live | PASS | — | **11 VERIFIED / 0 / 0** | 0 |
| 16M live | PASS | — | **23 VERIFIED / 0** | 0 |
| Layer C | BLOCKED | — | human OAuth only | n/a |

No tests skipped or weakened.

---

## 3. Frozen Invariant Results — ALL VERIFIED

Each invariant: code anchor + test anchor (exact test names from the passing suites).

1. **Persisted V2 `mapPosition` authoritative** — `mapView.ts:296-341` (x/y read only from stored `mapPosition`); `mapView.test.ts` "record position comes exclusively from the persisted V2 mapPosition"; 16M live: persisted == analysis-time compute (0.4120, 0.8781). **PASS**
2. **No V1 fallback** — `mapPosition(features)` removed (frozen); `mapView.test.ts:120` "a record without a persisted V2 mapPosition (Missing-V2) is NOT positioned (no V1 fallback)". **PASS**
3. **No on-read recomputation** — no getter recomputes; `detailMapPosition` reads `record.mapPosition` only (`view.ts:202-207`); `mapView.test.ts:407` "x/y stay exactly the persisted V2 mapPosition() values under any zoom/pan". **PASS**
4. **Missing-V2 does not render** — `mapView.ts:300` skips records without `mapPosition`; `mapView.test.ts:120`; inspector shows `Map position unavailable` (`render.ts:719`). **PASS**
5. **Focus ≠ Selection** — `app.ts:195-209` (independent, never pruned); `app.test.ts:809` "focus can differ from selection", `:771` "single click focuses without selecting", `:896/:910` "Machiniste requires explicit selection", "sends the selection". **PASS**
6. **Selection maximum = 8** — `app.ts:758-769` (9th cannot be added); `app.test.ts:835` "selection is capped at MAX_BATCH_SLOTS", `:563-576` "never sends more than MAX_BATCH_SLOTS"; `view.ts:228` pill clamp. **PASS**
7. **Selection survives filtering** — `app.ts:207-209`; `app.test.ts:707` "a selected sample hidden by a filter REMAINS selected", `:850` "search does not clear selection", `:882` "zoom/pan does not clear selection". **PASS**
8. **Camera runtime-only** — `app.ts:218` "RUNTIME-ONLY — never persisted"; `mapView.test.ts:393` "mapPoints() output is identical whatever the camera is", `:407`. **PASS**
9. **Search/filter/camera do not mutate map positions** — positions derive solely from persisted V2 (`mapView.ts:29-31`); `results` changes only through `refreshSearch` (`app.ts:395-405`); tests 92/393/407. **PASS**
10. **Preview remains ephemeral** — PreviewService owns ObjectURL lifecycle (INV-6, `app.ts:48-49`); `app.test.ts:515` "preview is triggered through PreviewService (which owns ObjectURLs)", `:522` revoke on stop, `:1125` "stale in-flight preview guard (SM-AUDIT-007)". **PASS**
11. **No audio persistence** — `app.test.ts:624` "no audio bytes persisted (INV-1)"; `globalMapIntegration.test.ts:509-514` "globalMapPoints / mergeMapPoints produces no audio byte containers"; controller enqueues sample IDs only, never bytes. **PASS**
12. **Machiniste uses direct sample references** — `machinisteService.send` receives sample IDs, no re-upload (`app.ts:854-874`); 16M live direct reference + read-back verified; e2e 16M-10/16M-18. **PASS**
13. **Read-back verification remains mandatory** — success semantics include `readBackMatches` (result label `Read-back: M`); e2e 16M-10; 16M live `readBackMatches=true`. **PASS**
14. **Transfer ≠ global publication** — `step16L.test.ts:660` "successful transfer → usage acceptance boundary", `:669` "failed transfer → no usage acceptance"; 16I live: transfer-readback-failed → no publish. **PASS**
15. **Global publication requires verified usage acceptance** — `main.ts:421-443` gate; 16I live H (accepted→published) + I (failed→unknown) + J (offline→restart→live). **PASS**
16. **Global map loading bounded** — `app.ts:146-155` (500/page, ≤2 pages via cursor, 250ms debounce); `globalMapIntegration.test.ts:530-531` "refreshGlobalPoints queries with bounded limit"; `step16L.test.ts:258` "follows nextCursor up to a bounded number of pages". **PASS**
17. **Local map usable when global map fails** — `app.ts:517-520` errors keep previous points + local map; `step16L.test.ts:596` "backend failure → error, and local map still works"; `globalMapIntegration.test.ts:338,354`. **PASS**
18. **Canonical V1 copy unchanged** — `view.ts:182-189` (`No analyzed samples yet.` / `No samples match your search.`), `render.ts:528-542` global labels, `Map position unavailable` at `render.ts:719`; `view.test.ts:136-137` exact string assertions. **PASS**
19. **Playwright `data-testid`s intact** — all 28 e2e specs passed against the live DOM (`search-text`, `sample-map`, `map-point-*`, `machiniste-add`, `selection-pill`, `first-use`, `inspector-*`, `filter-*`, etc.); `render.ts:79-80` documents preservation of every pre-existing testid. **PASS**

---

## 4. Git / Worktree & File-Scope Status

- **VCS**: No git repository present in `/Users/sumad/SampleMap` (`git rev-parse` → `fatal: not a git repository`). Git-based diffing is therefore not available; file-scope verified by modification-time scan.
- **16R specification phase (approx. 10:28–10:35 today) wrote exactly one file**: `STEP16R_PRODUCT_UX_SPEC.md`. No `src/` product file, test, config, or worker file was created or modified by the 16R phase.
- **Recently-touched files that predate the 16R phase** (part of earlier approved steps, NOT introduced by 16R, left untouched):
  - `src/ui/map/mapView.ts`, `src/ui/map/mapRender.ts`, `src/ui/map/mapView.test.ts` (2026-09-05 07:52–07:53) — the approved Phase-1 §8.1 point-radius fix, documented in `FINAL_UI_UX_PHASE1_AUDIT_REPORT.md` §3.
  - `scripts/live-verify-16i.ts` (10:01), `scripts/machiniste-foreign-access.ts` (10:03), `scripts/machiniste-legacy-name-test.ts` (10:05) — step-6 investigation/diagnostic scripts from the earlier session (Juul-perc access tests).
  - `STEP16I_16M_STATUS.md` — final status report written earlier this session (approved).
- **Generated artifacts from this run only**: `e2e/artifacts/16M-map-analyzed.png`, `e2e/artifacts/16M-selection.png`, `e2e/artifacts/fp-action-bar-selected.png`, `e2e/artifacts/test-results/.last-run.json` (Playwright outputs) — expected, disposable.
- **Conclusion**: No unintended changes exist. The specification phase is documentation-only. Nothing was deleted or overwritten.

---

## 5. Known Layer-C Limitation

The single remaining known blocker is interactive Audiotool OAuth (human browser session + click-through). It is a **verification gap**, not a technical impossibility and not an implementation defect:
- Foreign public sample listing by `samples.list()` and foreign-sample acceptance by Machiniste were additionally **live-proven this session** by the Juul-perc access scripts (foreign public `samples/0001a43b-ed6d-54c9-b8cd-3c9c15dcc694` accepted + read-back verified, incl. the legacy hyphen-stripped reference form) — directly addressing the former exercise's "live UNPROVEN" items.
- Closing Layer C = one authenticated browser run of `STEP16R_PRODUCT_UX_SPEC.md` FLOW 1 + FLOW 10 (human-confirm). Status remains **BLOCKED** and is the only deviation from a fully REAL verdict.

---

## 6. Unexpected Findings

1. **16M read-back entity id differs from the prior session** (`2e329ae1-7192-4481-b303-6188b8dd8d94` this run vs `0bdb1f4e-…` earlier): expected — each run creates a new channel slot on the live document. `readBackMatches=true`, `errors=[]`; not a failure.
2. **Worker content-lookup E canonical set** now returns 11 representatives (accumulated live test + accepted samples) — expected growth of the live D1 store; no behavior change.
3. **Chunk-size warning only** (782 kB main bundle, gzip 134 kB): pre-existing, unchanged, non-blocking.
4. **No VCS**: git-based change detection is unavailable; mtime-based scope check used instead (§4). If a git history is desired before E-P1, init a repo from the current tree.

---

## 7. E-P0 Exit Verdict

**E-P0 PASS — BASELINE LOCKED**

All gates green with exact counts: tsc app 0 / worker 0; app vitest 576/576 (32); worker vitest 19/19 (2); vite build PASS; Playwright 28/28; 16I live 11/11; 16M live 23/23. All 19 frozen invariants verified against code + passing tests. The 16R specification phase introduced **zero** source changes. The **only** known blocker remains the human Layer-C OAuth session (verification, not implementation).

Per the E-P0 instructions, no further phase (E-P1+) is executed. **Waiting for explicit authorization before E-P1.**