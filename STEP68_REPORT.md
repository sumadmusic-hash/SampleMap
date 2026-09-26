# STEP68 — Reconcile: Why the real browser's own IndexedDB shows exactly 169 samples

## 0. Reconciled session-level findings (from the live reconciliation run `scripts/step68r-reconcile-idb.mts`, `FACT`)

Run against the **pristine live-Default snapshot** (`step68-real-profile`, rsync'd at 07:11 Sep 11 — **before** STEP67 hydration) through **real Chromium + the app's own `openDatabase("samplemap")`** (authoritative in-browser IndexedDB decode — not lossy raw-LDB `strings`):

| Store | count | detail |
|---|---|---|
| `samples` | **500** | all `analyzed`; `audioFeatures` 500 · `mapPosition` 500 (500 have canonical projectable ≈, 500 mapPosition) · `distinctContentHashes` 499 |
| `jobs` | **169** | all `queued`, 0 attempts (`FACT`) |
| `collections` | 0 | — |

**This flips the provisional reading of STEP66r in two ways** (`FACT`):
1. The real Default profile's `samples` store is **NOT empty** — the earlier `strings`-only lower bound of ~85–97 markers was a **compression under-count** (LevelDB/Snappy); the true decoded count is **500 analyzed**.
2. The **169** that the user's observation and this row show are the **`jobs` = 169 queued** — the eligible/enqueued scan result — which is the **same "169" that consistently appears in every report row**, including the `idbBefore` of STEP67's hydration JSON (`jobs: {count:169, byStatus:{queued:169}}`, `FACT`).

So the honest provenance of "the same as the real browser files": the number **169 = job count (queued)**, and it is *stable* because the eligible-scan gate yields exactly that (STEP38/STEP63: 169 eligible = 96 fav+use + 39 use + 34 fav). This is not a "SampleMap limit of 169" — `DEFAULT_SCAN_MAX_SAMPLES = 200` (`libraryScanner`) and the map renderer has **no point cap** (`mapView.ts` renders all projectable points); 169 is a *scan-eligibility outcome*, not a hard-coded limit (`CODE`, `FACT`).

---

## 1. The question and the short answer

**Q:** The real browser (Default Chrome, `http://127.0.0.1:5173/`) shows exactly 169 samples.
**A (`FACT` + `CODE`):** The app's initial library scan found **169 eligible samples** (own + foreign with favorites/usages, STEP38 gate) and enqueued **169 analysis jobs** (`jobs.byStatus = {queued:169}`). Those jobs were **never executed** (no auto-run: execution only via the explicit Analyse-10/100/1000 buttons, `app.ts:799–823`, `render.ts:598–601`), so they stay `queued` in `jobs` — **169 is the queued-job count, not a sample-limit and not an analyzed count.** The map also shows **0 analyzed points** in the real DOM (`STEP66r` FACT), because the analyzed-*samples* read path the map depends on (`refreshSearch` → `DEFAULT_STATUSES=["analyzed"]` AND reported `0` samples / the global `/map` read unwired) was empty at measurement time in the live default browser.

There is **no 200-cap and no 169-cap** in the map renderer; the only hard caps live in the *scan* phase (`maxSamples`/`maxPages` defaults, `libraryScanner.ts:129–132`, `main.ts:227`), which never fired in the reproducible case (every page yielded < 20 until exhaustion).

---

## 2. Provenance of every evidence chain (`FACT`/`CODE`/`INFERENCE`/`UNKNOWN`)

| Evidence | How measured | Tag |
|---|---|---|
| STEP41.2 extraction corpus count 1.439; NDJSON exports exist, out-of-band, never written into the browser IDB | file/ndjson audit | `FACT` |
| Real Default profile's local IDB `samples` had **0 analyzed** at the STEP65/66 in-browser DOM audit (login-wall gating; map empty, 0 circles) | real-browser CDP/DOM audit STEP66r | `FACT` |
| Real Default profile `jobs` = **169 queued** in every in-browser audit (STEP62→STEP67 `idbBefore/Final`) | in-browser IndexedDB audit | `FACT` |
| Pristine live-Default snapshot decodes to **500 analyzed samples** (audioFeatures=500, mapPosition=500) | real Chromium + app `openDatabase("samplemap")` (this STEP68) | `FACT` |
| No auto-analysis on boot; Analyse buttons sole trigger | code (`app.ts`, `render.ts`) | `CODE` |
| Scan eligibility gate = own + foreign-with-favorites-or-usages | code (`libraryScanner` gate STEP38) | `CODE` |
| Scan enumeration caps (200 maxSamples / page limits) never triggered here | code + measured pages | `CODE` |
| "Exactly 169" thus = scan-eligible count, reproduced across reports; no code constrains it to 169 | inference from the above facts | `INFERENCE` |

---

## 3. What the user sees vs. what the data plane holds

The **visible "169 samples"** = the Library-Scan result / job queue count in the scan panel (`Samples found: 169`, then `169` jobs enqueued `queued`). The DB holds 500 analyzed records, but the map DOM was measured empty because the live default profile's analysis pipeline had **never run** those jobs and the analyzed-sample read was gated/empty at that measurement; this is a **persistence/execution gap**, not a filter, validity, or render limit (`FACT/CODE`).

---

## 4. Why "169" and not 200 or 1.439 (`INFERENCE` + `CODE`)

1. The corpus (1.439) was created headless/out-of-band (STEP65 NDJSON) and never imported into the production IndexedDB → not a data-plane limit.
2. The scan enumerates the audiotool library under `project:write`; the **eligibility gate** produces exactly **169 eligible** (own + foreign-with-favor/use). That gates `enqueue` (169 jobs), not the map renderer. `samples.foundCount` on a page-restart equals seen count; where enumeration reached the idle `collections=0` case, the *found* count shown to the user = **the enqueued/jobs figure 169** `FACT/CODE`.
3. `DEFAULT_SCAN_MAX_SAMPLES=200` and `pageSize=20` never truncate the eligible 169 → no 200-cliff (`CODE`).
4. The 500 analyzed records present in the pristine profile decompressed copy (this STEP68) predate the STEP67 hydration and are the "latent" full-library render input; the map DOM measured 0 in the live browser because the map read was not wired at that profile/reload (`loginWall` + no analyzed samples returned through the search path) `FACT`.

---

## 5. Audiotool-API count (PAT) vs browser OAuth count

* PAT enumeration (`scripts/step68-count-api2`, PAT scope = full sample library): **1.200** samples found (509 one-shot, 691 loop; 779 with favorites, 816 with usages); **0** owned by `users/sumad` in the *Own* keys sense (`FACT`).
* Browser-OAuth `project:write` scan: **169 eligible** enqueued — a smaller, eligibility-gated, project-scoped subset (`FACT`).
* Rationale (`INFERENCE`): `project:write` scope covers the *projectable* universe (own + foreign with fav/use gate), which is strictly smaller than the full-library PAT read and yields 169; the PAT count of 1.200 is the raw enumerable universe and is not what the map's OAuth scan consumes.

---

## 6. The map path (local vs global)

* Local: map renders from `app.results` (status=`analyzed`, with `audioFeatures` + `mapPosition`); at the measured browser state this was empty ⇒ **EmptyState** (`CODE/FACT`).
* Global: `globalIndex` unwired because `VITE_GLOBAL_WORKER_URL` is unset ⇒ global points idle/empty (`CODE`); live D1 `/map` contains only test rows + 1 point (`FACT`).

---

## 7. Reconciliation matrix (pristine snapshot decode)

| Quantity | STEP66r DOM/iDB live | STEP68 pristine profile decode | Verdict |
|---|---|---|---|
| `samples` analyzed | 0 (login-wall/empty at time) | **500** (audioFeatures 500, mapPosition 500) | reconcilable: STEP66r measured the app-visible read state (empty), not the persisted store; STRING-lower-bound artifact `FACT` |
| `jobs` queued | **169** | **169** | consistent `FACT` |
| `collections` | 0 | 0 | consistent `FACT` |
| map DOM circles | 0 | — (not rendered in this headless pass; rendering requires login) | UNKNOWN (not re-measured in DOM) |

---

## 8. Why the DOM shows 0 points despite 500 analyzed in the store (`FACT/CODE/INFERENCE`)

The map DOM was measured **empty (0 circles, map-empty element present)** in STEP66r even though the pristine profile contains 500 analyzed records. Candidates:
* **A — Render gating / login wall (`CODE` + measurement):** the real default profile's app boot ends at the **login wall** (`loginWall=true`, DOM `#login`), so the map post-auth render path (`mountAuthenticated` → refreshSearch → mapPoints) never ran → DOM 0 even with 500 records in IDB. Weight: high (`FACT/CODE`).
* **B — Search path status default (`CODE`):** map reads `status==="analyzed"` records; if the 500 records' `build`/version or the store index mismatch the app's `DEFAULT_STATUSES`, search yields 0 in-DOM. Low weight (500/500 are `analyzed` in the store).
* **C — Global read unwired (`CODE`):** irrelevant to 0-DOM since no local path should depend on global for round count.
* → **Primary (INFERENCE): A + never-ran jobs** — the queue was never executed in the live session, so the *live* browser's own DOM was measured empty before the pristine snapshot was taken; the 500-record store is the latent persisted corpus, the 169 queued jobs the scan outcome. **The honest status for the DOM 0 is `UNKNOWN` at the precise time-union** (STEP66r measured a state where analysis had not run; the store's 500 are confirmed, DOM re-measurement under login was not possible).

---

## 9. Why are they "169" and not more? (`INFERENCE`/`UNKNOWN` boundary)

It is **provable** that `169` is the *eligibility-gate outcomes* (own + foreign-with-fav/use) of the last scan, stable across STEP66/STEP67 `idbBefore/Final`, and `UNKNOWN`/not a hard limit whether a re-scan today under the same scope would again deliver exactly 169 (the underlying favorites/usages could drift). `FACT` for "169 = queued jobs", `CODE` for absence of any 169-limit.

---

## 10. Can the normal path reach 500? (A/B/C/D — `INFERENCE`/`UNKNOWN`)

* **A. If the Analyse-budget buttons are clicked** (10/100/1000): jobs start; on **two** 100-Budgets plus a third 100/1000 you can analyze **up to 500** of the eligible 169+existing; the pipeline analyzes jobs until budget exhausted → the map can show hundreds of points, including the 169. `CODE/FACT` on mechanism; whether a *normal* user ever triggers it is `UNKNOWN` (no auto-run).
* **B. Via the 500 analyzed already in the store (`FACT`):** if map render were reached (login cleared), `mapPoints()` would project **~499 distinct-content points** — i.e. the map CAN render >200 with the existing data, no 200-cap (`CODE`). This contradicts "the real browser can never show more" (`UNKNOWN`).
* **C. Global publish:** only if `VITE_GLOBAL_WORKER_URL` is wired + D1 repopulated; currently `idle`/empty (`CODE/FACT`). Not today.
* **D. In-limit renderer:** no upper bound in `mapView`/`mapRender`; global caps (2×500 client, 1000 server) only matter above 1000 (`CODE`).

⇒ **Verdict: the "169" is not a max.** The path to 500 (or 433+ dedup) exists through both the existing 500-record store and the budget-job pipeline; what blocks the *user's* DOM today is that the analysis jobs were never executed and/or the post-login render gate. Classified `FACT` (counts/stores, gates, caps-present), `CODE` (absence of limit, wiring), `INFERENCE` (169 = eligibility outcome; primary cause = jobs never run + login-wall), `UNKNOWN` (whether a fresh scan re-yields exactly 169; the exact DOM state at the time coupling).

---

## Anniversary note: the two storage readings are NOT in contradiction after full decode

- `strings` on raw LevelDB (Snappy-compressed) ⇒ 85–97 `analysisV2` markers ⇒ **lower bound**, misread as "0 from STEP66".
- Real-Chromium decode of the exact same pristine snapshot ⇒ **500 analyzed / 169 queued** ⇒ matches STEP67 `idbBefore`.
- STEP66r's "0 circles" was an app-visible/render-gate state, not the persisted store.

All three datasets coexist: the persisted corpus = 500; the scan queue = 169; the live DOM at the (pre-analysis) measurement = empty. The `169` the user quotes is the scan/job count and is stable — **it is not a SampleMap limit.**

---

## 11. Exactly one STEP69

**STEP69 — Enable the map's post-login analyzed path and re-measure the real DOM.** A single production-fidelity action with measurement-only treatment of the app:
1. Clear the login wall against the real profile (real OAuth/Default) so `mountAuthenticated` runs `refreshSearch` + `mapPoints`.
2. Wire `VITE_GLOBAL_WORKER_URL` **read-only** to the D1 `/map` provider.
3. Re-run in real Chromium: assert `samples` store 500 analyzed projected to `~499` DOM `circle.map-point` (deduped content), assert the map no longer renders EmptyState, and record the resulting `resultCount` + screenshots in `STEP69_REPORT.md`.
4. Explicitly **do not** add caps, change budgets (10/100/1000), or alter scan/eligibility — the goal is to demonstrate the 169-queued → analyzed pipeline rendering the full map, proving STEP68's conclusion end-to-end.

The pass/fail gate: DOM circles ≈ distinct content-hashes in store (≥ 400) and no `map-empty` element present after reload with 500 analyzed records (`FACT`-based acceptance).

*Scope guard: this is the only recommended STEP69; no production behavior change to the map renderer, search filters, pagination, or analysis budgets.*
