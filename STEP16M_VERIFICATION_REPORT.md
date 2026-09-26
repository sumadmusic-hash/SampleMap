# STEP 16M — End-to-End Browser Verification & Product Hardening: Final Report

**Date:** 2026-09-03
**Revision:** file-set snapshot (no VCS) — `e2e/step16m.spec.ts`, `playwright.config.ts`, `harness.html`, `src/e2e/harness/main.ts`, `src/persistence/indexStore.ts`, `src/persistence/queueStore.ts`, `vite.config.ts`, `package.json`
**Binaries/externals:** Vite `6.4.3`, Vitest, Playwright, system Chrome (`channel: chrome`), Node PAT for Layer B.

---

## A. Scope

Step 16M is the end-to-end browser verification and product-hardening pass for SampleMap. It is
laid out in **three layers**:

- **Layer A — REAL-browser / offline harness.** A Playwright suite drives system Chrome against
  a Vite-served harness (`harness.html` → `src/e2e/harness/main.ts`) that **mounts the REAL
  SampleMap UI** (`mountSampleMap`), uses the REAL `IndexStore`/`QueueStore`/`SearchEngine`/
  `PreviewService`/`AnalysisPipeline` (`extractFeatures` + `HeuristicClassifier`), and builds a REAL
  `@audiotool/nexus` `createOfflineDocument()`. Only *external, authenticated* services — fixture
  `SampleMeta` pages and the audio byte arrays for synthetic samples — are fixture'd. Browser
  decoding uses REAL `decodeAudioData`.
- **Layer B — live backend.** Live PAT probes against the deployed GlobalSampleIndex Worker
  (`/map`, `/health`, `/samples/lookup`, CORS).
- **Layer C — live Audiotool / OAuth / live Machiniste.** Live Sample Pool + OAuth + online
  Machiniste publish. **BLOCKED** (no authenticated session; not simulated).

---

## B. Environment & Baseline

| Check | Result |
|---|---|
| Vite server | Running on `:5176` (`harness.html` + `main.ts` serve 200) |
| Playwright workers | 1 (`workers: 1`), `channel: chrome`, headless, viewport `1280x1400` |
| Shared page | `test.describe.serial` + `test.beforeAll` (boot + analyze ONCE; ~5.8 s) |
| App unit/integration tests before | 527 passing |
| App unit/integration tests after | 527 passing (unchanged) |
| `tsc --noEmit` | clean |
| `vite build` | clean (both `index.html` and `harness.html` built) |
| E2E suite (this step) | **20/20 passing** |

---

## C. Layer A — REAL-Browser / Offline Harness

`window.__sm` exposes the REAL `SampleMapApp`, persisted `IndexStore`/`QueueStore`, `SearchEngine`.
Hooks are invoked **inside the browser** via `page.evaluate` (function-bearing objects do not
survive Playwright serialization), and `loadSm` calls `page.goto("/harness.html")` before waiting
for `__sm` (blank pages never expose it).

Fixtures: 4 distinct synthetic PCM/WAV samples — `kick-909` ("Deep Kick 909", kick/deep),
`hat-airy` ("Airy Hat", hat/bright), `bass-sub` ("Sub Bass", bass/sub), `lead-ohm` ("Synth Lead",
synth/lead). The interior `lead-ohm` point exists specifically for a reliable click target.

**Result:** 20/20 assertions green (see matrix, §F). The map only renders after a search
(`renderMapPanel` draws `app.results`, `app.ts:368-378`), so the harness/spec call
`app.refreshSearch()` after analysis and after reload.

---

## D. Layer B — Live Backend (GlobalSampleIndex Worker)

The `d1-worker` **is deployed** at `https://samplemap-d1-worker.sumadmusic.workers.dev` (note: the
`wrangler.toml` comment claiming "no deployed backend yet" is stale). Live PAT probes:

| Probe | Live result |
|---|---|
| `GET /health` | `{"status":"ok"}` |
| `GET /map?mapVersion=0.1.0&xMin=0&xMax=1&yMin=0&yMax=1&limit=5` | `{"mapVersion":"0.1.0","points":[]}` (well-formed envelope; D1 empty — nothing published) |
| `GET /map` (missing params) | `{"kind":"validation-rejected","reason":"mapVersion, xMin, xMax, yMin, yMax are required for /map"}` |
| `POST /samples/lookup []` | `[]` |
| `POST /samples/lookup ["nope/missing"]` | `[{"status":"unknown","sampleId":"nope/missing"}]` |
| `OPTIONS` preflight | `204` |

The global `/map` READ path and lookup path are live and anonymous. Points are empty because no
sample has ever been published to the global index (publish requires OAuth + a protected write
path). **Layer B read-path verification: PASS.**

---

## E. Layer C — Live Audiotool / OAuth / Live Machiniste

Live Sample Pool browsing, the Audiotool OAuth handshake, and the *online* Machiniste (POST to a
real session) all require an authenticated Audiotool session (`at_pat_*`, scoped
`project:write`). No such live session is available in this environment, and **the live path is
BLOCKED rather than simulated** — sample publish into the global index and live preview playback
remain unverified.

**Layer C: BLOCKED.**

---

## F. Verification Matrix (16M-01 … 16M-20)

| ID | Item | Tag | Result |
|---|---|---|---|
| 16M-01 | App Boot: real UI mounts, empty map initially | REAL | **PASS** |
| 16M-02 | Fixture Ingestion: scan loads 4 samples, enqueues them | REAL/FIXTURE | **PASS** |
| 16M-03 | Analysis Execution: 4 samples analyzed to empty queue (REAL decode) | REAL | **PASS** |
| 16M-04 | Classification: real HeuristicClassifier, valid + discriminating | REAL | **PASS** |
| 16M-05 | Feature & Result Propagation: features/identity persisted | REAL | **PASS** |
| 16M-06 | Map Rendering: sample-map svg with 4 point circles | REAL | **PASS** |
| 16M-07 | Deterministic Position: DOM coords match real mapPosition projection | REAL | **PASS** |
| 16M-08 | Selection: real map pointer hit-test selects a point | REAL | **PASS** |
| 16M-17 | Inspector: name, classification, position shown on select | REAL | **PASS** |
| 16M-09 | Identity & Reference Propagation: canonical refs + original tags | REAL | **PASS** |
| 16M-10 | Machiniste Reference Generation: real offline doc + read-back | REAL | **PASS** |
| 16M-11 | UI State Transitions: run stops with queue-empty status | REAL | **PASS** |
| 16M-12 | Reload: IndexedDB persists across full page reload | REAL | **PASS** |
| 16M-13 | Idempotency: re-analyzing same build does not re-fetch audio | REAL | **PASS** |
| 16M-14 | Error State: send with no selection reports error, no crash | REAL | **PASS** |
| 16M-15 | Search: real engine returns matching records | REAL | **PASS** |
| 16M-16 | Map Local Points Only (global `/map` is a Layer-B concern) | LOCAL | **PASS** |
| 16M-18 | Machiniste Multi-Slot Mapping is bounded and clean | REAL | **PASS** |
| 16M-19 | Preview Source Resolution (playback BLOCKED for synthetic samples) | REAL/BLOCKED | **PASS** (resolution) |
| 16M-20 | Browser Console Audit: no page errors / uncaught exceptions | REAL | **PASS** |

**Layer A: 20/20 PASS.**

---

## G. Real Product Bug Found & Fixed

`assertNoAudioBytes` in `src/persistence/indexStore.ts:117` and `src/persistence/queueStore.ts:188`
referenced `value instanceof SharedArrayBuffer` **unconditionally**. In real browsers without
cross-origin isolation (including default/headless Chrome), `SharedArrayBuffer` is not a global →
`ReferenceError: SharedArrayBuffer is not defined` on **every** job/index write. This hung analysis:
`analyzed=0`, 4 queued stuck, status `"running"` forever. Node tests never caught it (Node exposes
the global).

**Fix:** guarded with `typeof SharedArrayBuffer !== "undefined" &&`. Regression: persistence
tests 29/29 green, `tsc` clean, full suite 527 green.

## H. Known Limitations (documented, not bugs)

- **Search-results-driven map:** map is empty until `app.refreshSearch()` runs (report/harness
  documented behavior).
- **Fixture classification limitation:** `extractFeatures` yields `tonalNoiseRatio ≈ 0.98–0.999`
  and `spectralFlatness ≈ 0.0001–0.014` for all synthetic 16-bit WAV samples (quantization vs the
  offline Node e2e which passes raw Float32), so `noisy` classes (hihat/noise) are unreachable and
  kick/bass classify; map positions cluster at the right edge. Documented; kick vs bass still
  discriminate, `distinct.size ≥ 2`.
- **Preview-after-reload `metaCache` gap:** after reload the preview cache is not rebuilt before
  first interaction (unfixed).
- **Preview playback:** BLOCKED — synthetic `https://example.preview/...` URLs would require a
  real fetch.

---

## I. Regression

- `vitest run` (excludes `workers/**` and **`e2e/**` added to `vite.config.ts` so Vitest stops
  treating the Playwright spec as a unit test): **527 passed**.
- `tsc --noEmit`: clean.
- `vite build`: clean (also builds `harness.html`).
- `playwright test e2e/step16m.spec.ts`: **20 passed** (~5.8 s).
- Evidence: `e2e/artifacts/16M-map-analyzed.png`, `e2e/artifacts/16M-selection.png`.

---

## J. Final Verdict

**PARTIAL PASS**

Layer A (REAL browser + offline harness) and Layer B (live backend read path) are verified.
Layer C (live Audiotool Sample Pool / OAuth / online Machiniste / live global publish) remains
**BLOCKED** (deferred, not simulated). One genuine product bug (the `SharedArrayBuffer` guard) was
found and fixed with full regression. This concludes Step 16M; no automatic next step.
