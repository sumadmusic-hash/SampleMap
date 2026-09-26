# STEP 16N — Minimal Live Browser Wiring + Layer C Verification

**Date:** 2026-09-03
**Verdict note:** This step implements **A — Code-ready** only. It does **not** and cannot claim **B/C — Real browser/OAuth verified**, which require the manual interactive login in §5.

---

## 1. Changes Made

All changes are minimal, additive browser glue. No SampleMap service, analysis architecture, OAuth architecture, Worker, or scope was changed.

| File | Why / What |
|---|---|
| `src/ui/liveSession.ts` (new) | Small glue module. `pickFirstProject(projects)` (pure) picks the first usable project by `name`; `openFirstProject(client)` reuses the existing `client.projects.listProjects` + `client.open(name)` + `doc.start()` project-opening pattern and returns the started `SyncedDocument` (or `undefined` when the user has no usable project). No new services, no auth/scopes. |
| `src/ui/liveSession.test.ts` (new) | 5 structural tests of the new wiring: `pickFirstProject` (first-with-name / none), and `openFirstProject` (lists→picks→opens→starts; no-project → `undefined`; failure propagation) using a fake `client`/`doc`. Tests the glue logic only — it does **not** fake an OAuth login or claim real Layer C. |
| `src/main.ts` | In the existing authenticated branch (after `OK — authenticated as …`), opens the user's first project via `openFirstProject` and calls the existing `mountAuthenticated(root, { client, doc })` to mount the REAL SampleMap UI in `#app`. Wrapped in `mountLiveSampleMap(...).catch(...)` so a project-open/mount failure is logged **non-fatally** and never breaks the existing POC auth/error behavior. Added 2 imports (`mountAuthenticated`, `openFirstProject`) and the `mountLiveSampleMap` helper. |
| `index.html` | Added a `<div id="app"></div>` SampleMap host element after `#log` (the POC diagnostics stay in `#log`; the SampleMap UI mounts in `#app`). |

No publishing is triggered automatically: `mountAuthenticated` is called **without** a `globalIndex`, so no global publish is enqueued by this step (per §2 of the task).

---

## 2. Changes NOT Made

Explicitly confirmed **not changed**:
- **OAuth architecture** — untouched; still the SDK `audiotool({ clientId, redirectUrl, scope })` flow in `src/main.ts`.
- **Scopes** — unchanged (`VITE_SAMPLE_SCOPE = project:write`); no new or raised permissions.
- **Worker / D1 backend** — not modified.
- **Analysis pipeline / classifier / features / persistence / search** — not touched.
- **PAT handling** — no PAT is introduced into, or read by, browser code. PAT remains Node-only (`scripts/*.ts`, `src/cli.ts`) from `.gitignore`'d `.env`.
- **`mountAuthenticated` / `mountSampleMap` / `buildBrowserDeps`** — reused as-is, not duplicated or modified.

---

## 3. Test Results

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`) | **clean** |
| Vite build (`npm run build`) | **clean** (`index.html` + `harness.html` built) |
| Vitest full suite | **532 passed** (32 files) — prior 527 + 5 new `liveSession` glue tests |
| Playwright `e2e/step16m.spec.ts` | **20 passed** (16M-01 … 16M-20) |
| `scripts/step16m-live-verify.ts` | **22 VERIFIED, 0 NOT VERIFIED, exit 0** (real pool→get→WAV→decode→analyze→map→index→search→Machiniste on a live SyncedDocument with read-back) |

`step16m-live-verify.ts` was run unmodified and passed on its own merits.

---

## 4. Live Browser Entry — how OAuth reaches `mountAuthenticated`

```
Chrome → http://127.0.0.1:5176/  (index.html → src/main.ts)
  → audiotool({ clientId, redirectUrl, scope }).login()      [existing OAuth]
  → status "unauthenticated"? → show Log in with Audiotool    [existing, unchanged]
  → status "authenticated"?
       → log "authenticated as …"                            [existing]
       → openFirstProject(at)                                  [NEW glue]
            → client.projects.listProjects({pageSize:5})      [existing project API]
            → pick first usable project by name               [pure helper]
            → client.open(project.name)  →  doc.start()       [existing pattern]
       → mountAuthenticated(#app, { client: at, doc })         [existing, reuse]
            → buildBrowserDeps({ client, doc })                [existing]
            → mountSampleMap(#app, deps)                       [existing → real UI]
            → app.refreshSearch()                              [populates from real Pool]
```

The POC diagnostics continue to render in `#log`; the real SampleMap UI renders in `#app`. Any failure in the mount path is caught and logged as non-fatal, preserving the original authentication behavior.

---

## 5. Manual Layer C Procedure (for you to run in Chrome)

1. `npm run dev` — Vite on `:5176`.
2. In **system Chrome**, open `http://127.0.0.1:5176/`.
3. Click **Log in with Audiotool** and complete the **interactive Audiotool sign-in** in the browser (this is the step I cannot automate — I will never ask for your PAT/token/password/cookie).
4. After redirect, the page shows `authenticated as "<you>"`, the POC list in `#log`, and the **real SampleMap UI** mounted in `#app` (populated from your real Sample Pool).
5. In the SampleMap UI: **Start Scan** → **Analyze** (budget 10) → wait for real samples to classify and appear as **map points**.
6. **Click a map point** → the **Inspector** shows the real sample name / classification / position.
7. **Send to Machiniste** → confirm the live `SyncedDocument` commit (`applied` / `readBackMatches` true) for the `samples/{uuid}` reference.
8. **Preview**: select a sample and use the inspector preview; confirm audible playback. *(If playback remains technically blocked in this configuration, that is reported honestly — no unrelated code change.)*
9. Confirm the browser console has no errors and **no credential is printed anywhere** (log/UI/screenshot/console).

Expected happy path: `Chrome → OAuth → authenticated client → user project → SampleMap → real Pool → real analysis → real map point → select → inspector → Send to Machiniste → live SyncedDocument → samples/{uuid} → read-back`.

---

## 6. Current Verification Status

| Path | Status |
|---|---|
| **PAT/Node REAL** (real pool/get/download/decode/analyze/map/index/search + live project + Machiniste read-back) | **VERIFIED** — `step16m-live-verify.ts` 22/22, plus prior 15G/16F/16K evidence |
| **Browser/offline REAL** (harness: real UI + real decode + real classify + real Machiniste offline doc) | **VERIFIED** — Playwright 16M 20/20 |
| **Browser/OAuth (real session)** (interactive login + real SampleMap UI over a live session) | **NOT YET RUN** — code-ready (this step) but requires the manual login in §5 |
| **Live preview playback** in a browser | **NOT YET RUN** (may remain technically blocked; will be reported honestly) |
| **Global publication of a real analyzed sample** (`/map` points) | **BLOCKED / deferred** — deliberately not wired into this step (Worker publish is an open question); testable separately |
| **Layer C tag** | remains **BLOCKED** until the §5 manual run completes → then flip to **VERIFIED** |

The step transitions Layer C from "not even runnable in a browser" to "code-ready, one interactive login away". It does **not** claim Layer C PASS.

---

## 7. NEXT ACTION

1. You run the **§5 manual procedure** in Chrome with a real Audiotool login (the only step that cannot be automated here).
2. Collect/inspect the results (real map points, selection, inspector, Machiniste read-back, optional preview/console status).
3. Optionally, as a **separate** follow-up (not this step), test publishing **one** real analyzed sample to the GlobalSampleIndex and confirm `/map` populates.
4. Only after the real-browser run: change the report/`SAMPLEMAP_V1_STATUS` Layer C tag from **BLOCKED → VERIFIED** and re-issue the final verdict.

**Stop — no further feature or development phase begins after this report.**
