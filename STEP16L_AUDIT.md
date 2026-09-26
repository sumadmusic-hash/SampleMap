# STEP 16L — AUDIT & DESIGN: Global Discovery / Interaction

**Status: DESIGN PHASE ONLY — nothing implemented.**
**Production changes: 0.**

This is a **design-decision report**, not an implementation. Step 16L audits the
entire codebase and assesses **current discovery and interaction capabilities**,
then produces a minimal-invasive design decision for the next phase. No
production code is written here. All baselines were re-verified to confirm the
tree is clean at the start of 16L.

---

## 1. Executive Summary

Step 16K integrated the global worker (`/map`) into the local SVG map, verified
content-identity dedup and KNOWN-reuse live, and left the app at **499/499 app
tests, 19/19 worker tests, tsc clean (app + worker), and a passing Vite build**.

Step 16L is the **discovery/interaction** phase. The audit finds the app already
capable of:

- local search/filter/sort (text/class/confidence over the local index),
- local + global **map** discovery (merged, local-precedence, zoom/pan/hover/click),
- selection + inspector + preview + machiniste + usage-acceptance publish.

The audit also identifies **five concrete gaps** for global discovery/interaction:

- **G1** — Global points are **not searchable** (search engine is local-only).
- **G2** — Global map loads a **single fixed full-viewport batch** (hardcoded
  `0..1`, `limit:500`); no viewport-aware query, no cursor pagination, no clustering.
- **G3** — **`findSimilar` is not wired into any UI** (it is a tested pure function only).
- **G4** — Global-point selection silently runs a full analysis pipeline on
  arbitrary content; no "inspect without analyze" and no clear loading/empty/error
  distinction for global data.
- **G5** — Local-index **hydration from global results** (design §16.3) is
  partial: it happens only when the user clicks a global point.

**Recommended design decision (this report):** adopt **Search Variant C —
hybrid** (map-viewport discovery + local search over a locally-hydrated index).
This is the smallest V1 solution, matches `STEP16_DESIGN.md` §15 verbatim, and
avoids building a new distributed global text-search engine (large / out of scope).

---

## 2. Scope

- **In scope:** audit of discovery & interaction capabilities across the app;
normative design decision (variants A/B/C) and a minimal-invasive change set for
the *next* phase. Baseline (re)verification only.
- **Out of scope for this report:** any production code change, any new
feature/API/model/DB/worker change, any new dependency, any implementation of
the recommendations below.

---

## 3. Audit Method

- Read every discovery/interaction-relevant module (see §4).
- Cross-referenced the verified invariants from prior step reports and
  `STEP16_DESIGN.md` §§14–15.
- Re-ran the full baseline: app tests, worker tests, `tsc --noEmit` (app +
  worker), `vite build` — all green, confirming zero drift before this phase.

---

## 4. Modules Read (audit surface)

| Module | Role | Discovery/Interaction relevance |
|---|---|---|
| `src/ui/main.ts` | Browser entry | wires global map refresh |
| `src/ui/bootstrap.ts` | Dep wiring | global provider, pipeline, search, preview |
| `src/ui/app.ts` | Controller | search, camera, global points, selection, preview, machiniste |
| `src/ui/view.ts` | Pure view-models | detail/result/class-filter projections |
| `src/ui/render.ts` | Thin DOM projection | search/filter/map/results/inspector/send panels |
| `src/ui/map/mapView.ts` | Pure map view-model | merge local+global, camera, hover/select, tooltip |
| `src/ui/map/mapRender.ts` | SVG renderer | global/local point drawing, hit-test, zoom/pan |
| `src/search/searchEngine.ts` | Local search | text/class/confidence/sort/status |
| `src/similarity/similaritySearch.ts` | Find-similar (pure) | similarity discovery |
| `src/preview/previewService.ts` | Audio preview | bounded-fetch + ObjectURL LRU |
| `src/machiniste/machinisteService.ts` | Machiniste send | atomic multi-slot transfer |
| `src/global/usageAcceptance.ts` | Publish on acceptance | verified-transfer → publish queue |
| `src/global/publishQueue.ts` | Publish queue | dedup/batch/offline |
| `src/global/lookup.ts` | Global lookup/reuse | known/incompatible/unknown |
| `src/global/liveProvider.ts` | Provider resolution | live vs offline |
| `src/global/contract.ts` | Contract | viewport/map/lookup/publish types |

---

## 5. Baseline Verification (zero-diff gate)

| Check | Command | Result |
|---|---|---|
| App tests | `npx vitest run` (root) | **499/499 pass** |
| Worker tests | `npx vitest run` (workers/d1-worker) | **19/19 pass** |
| App typecheck | `npx tsc --noEmit` (root) | clean (exit 0) |
| Worker typecheck | `npx tsc --noEmit` (worker) | clean (exit 0) |
| App build | `npx vite build` | pass |

All green ⇒ the audit starts from a clean tree with **production changes: 0**.

---

## 6. Current Discovery Capabilities (capability inventory)

| Capability | Where | Scope | Global-aware? | NOTES |
|---|---|---|---|---|
| Text search (name/tags/owner) | `searchEngine` | local index only | **NO** | `index.getAll()` |
| Class filter (single + taxonomy group) | `searchEngine` / `view.classFilterOptions` | local only | **NO** | |
| Min-confidence filter | `searchEngine` | local only | **NO** | |
| Sort (relevance/conf/name/analyzedAt) | `searchEngine` | local only | **NO** | deterministic |
| Map discovery | `mapView.mergeMapPoints` | local + global | **YES** | local precedence, 16K |
| Camera (zoom/pan/reset) | `mapView` / `mapRender` | runtime | **YES** | never persisted |
| Hover tooltip | `mapView.tooltipFor` | local + global | **YES** | |
| Click select (local) | `app.selectSample` | local | — | |
| Click select (global-only) | `app.selectGlobalPoint` | global | **YES** | resolves + analyzes/reuses |
| Inspector | `view.detailView` / `renderDetailPanel` | selection | partial | name/owner/tags/class/position/preview |
| Preview | `previewService` | local URL | — | per-record preview URL |
| Find similar | `similaritySearch.findSimilar` | local (`records`) | **NO** | **pure fn only; NOT wired to UI** |
| Machiniste send | `machinisteService.send` | multi-slot | — | atomic + read-back |
| Usage-accept publish | `usageAcceptance` | verified transfer | **YES** | |
| Publish queue | `publishQueue` | offline-first | **YES** | dedup/batch/retry |
| Global map loading state | (none) | — | **NO** | errors silently swallowed |
| Global map empty state | `mapRender` empty | local+global | partially | only when 0 merged points |
| Global map error state | (none) | — | **NO** | indistinguishable from "no global" |
| Pagination/cursor | `contract.MapViewportQuery` | defined | **YES** | **not consumed in UI** |
| Clustering (Tier-2) | (none) | — | **NO** | deferred per design §14.2 |

---

## 7. Verified Architectural Invariants (must not be broken by any 16L change)

- **Content identity = `(contentHashVersion, contentHash)`** — never sampleId.
- **No second analysis pipeline** — single pipeline; global reuse via 16J only.
- **Local analysis distributed / global knowledge reused / map for discovery /
  Machiniste = usage signal** — the four-way split from the design.
- **Usage acceptance** = `committed===true AND slot.applied===true AND
  readBackMatches===true AND errors===0`.
- **UNAVAILABLE ≠ UNKNOWN** — offline/unreachable must not be read as "no data".
- **No audio bytes globally** — global data is metadata/fingerprints only.
- **Map axes** X = NOISY→TONAL, Y = DARK→BRIGHT (from `mapPosition`).
- **Search engine is local and read-only** (`search()` only; INV-4).

---

## 8. Gap Analysis (G1–G5)

### G1 — Global points not searchable
`searchEngine` operates only on local records (`index.getAll()`). Global /map
points are not included in text/class/confidence results. A user cannot "find the
global kick" by typing; they must pan the map.

### G2 — Global map is a fixed full-viewport batch
`app.refreshGlobalPoints()` (`src/ui/app.ts:398-414`) always issues
`queryMapViewport({ xMin:0, xMax:1, yMin:0, yMax:1, limit:500 })` regardless of
the current camera zoom/pan. The contract supports `cursor`, `zoom`,
`primaryClass`, `limit`, and a real viewport, but none are consumed. Camera
changes re-fetch the **same** full quadrant — not the visible region.

### G3 — Find Similar not wired
`findSimilar(...)` (pure, exhaustive, local, tested) has **no controller method
and no render button/flow**. It is only exercised in tests (`similarity.test.ts`,
`globalMapIntegration.test.ts`).

### G4 — Global selection runs a blind analysis; no inspection-only path
`app.selectGlobalPoint` resolves metadata, enqueues, creates a `createRunner(10)`
and runs it. There is no "view without analyzing," and global load/empty/error
states are not surfaced (errors swallowed silently in `refreshGlobalPoints`).

### G5 — Local-index hydration from global is partial
Design §16.3 calls for the local index to be "hydrated from global results."
Today that only happens when a global point is clicked (and then only via the
analysis pipeline's 16J reuse). There is no bulk hydration of nearby global
results into a searchable local form.

---

## 9. Assessment: Current Discovery Maturity

- **Local discovery:** mature (search/filter/sort/map/inspector/preview).
- **Global discovery:** minimal — one bounded map viewport fetch exists (16K),
  but it is not viewport-aware, not searchable, not paginated, not clustered, and
  lacks interaction states.

---

## 10. Search Variant Analysis (the design decision)

The central open question for the discovery phase: **how should a user discover
globally-known content?**

### Variant A — Map-only global + local search
The map is the sole global discovery surface; search stays strictly local.

- + Smallest; zero new search surfaces.
- − Users must know what they're looking for positionally; no text/class query
  over global content; fails the core "find a kick" need.
- **Rejected** for V1 (does not meet discovery goals).

### Variant B — Full global text search (distributed)
A new server-side global search engine over all canonical analyses.

- + Powerful; scales to millions.
- − Very large: new API, indexing, scoring, pagination, auth/rate-limit; violates
  "minimal-invasive"; contradicts design §15 (which keeps the SearchEngine local
  and hydrates the local index instead).
- **Rejected** for V1 (cost/scope; conflicts with the established architecture).

### Variant C — Hybrid: map-viewport discovery + local search over a
hydrated local index. **RECOMMENDED**

- Global content is discovered via the **map** (viewport bbox queries, Tier-1).
- When a user **interacts** with global content (click / nearby-viewport), the
  canonical analysis is **hydrated into the local index** (16J reuse path already
  persists it), making it **instantly searchable by the existing local
  SearchEngine** — no new search engine.
- Matches `STEP16_DESIGN.md` §15.1–§15.3 exactly ("the full SearchEngine runs
  over the local IndexStore, which is now hydrated from global results").
- **Recommended** — smallest V1 that delivers searchable global discovery.

---

## 11. Recommended Design Decision (normative)

**Adopt Search Variant C.** The map remains the global **discovery** surface; the
local `SearchEngine` remains the query surface, operating over a locally-hydrated
index. No distributed global search is introduced.

The recommended minimal-invasive change set (for the implementation phase that
follows 16L — NOT built now) is enumerated in §13.

---

## 12. Options Considered & Rejected

| Option | Rejected because |
|---|---|
| Variant A (map-only global) | no text/class discovery over global content |
| Variant B (full global search) | large scope; conflicts with design §15; not minimal |
| Server-side clustering (Tier-2) now | deferred by design §14.2; only needed at high counts |
| Canvas/WebGL renderer (Tier-3) | explicitly deferred; SVG fine at current scale |

---

## 13. Minimal-Invasive Change Set (design for the NEXT phase — not built here)

Ranked by value/effort. All are incremental over existing seams; none break the
invariants in §7.

1. **C1 — Viewport-aware global map query** (`app.refreshGlobalPoints`):
   translate the current camera into the visible normalized bbox
   (`xMin/xMax/yMin/yMax`) instead of the hardcoded `0..1`, keeping `limit` and
   handling `nextCursor` for pagination. Requires a pure camera→bbox helper
   (unit-testable), reused by the renderer (`mapView.ts`).
2. **C3 — Wire Find Similar into the UI** (controller method + a "Similar"
   button in the inspector/results): run `findSimilar` over `index.getAll()`
   using the selected record's stored `contentIdentity` + `similarityFingerprint`;
   show results via existing result rows. Reuses the tested pure function.
3. **C2/C5 — Hydration of interacted global content**: extend the 16J reuse path
   so global content the user selects is persisted to the local index and
   immediately reflected in search results. Already partially present in
   `selectGlobalPoint`; formalize it.
4. **C4 — Surface global load/empty/error states**: add an explicit map state
   (`loading` / `error` / `ok`) so UNAVAILABLE is visually distinct from "no
   data", preserving UNAVAILABLE ≠ UNKNOWN.

---

## 14. Out of Scope (explicitly deferred)

- Distributed global text search (Variant B) — not for V1.
- Tier-2 clustering / Tier-3 Canvas/WebGL map.
- New API endpoints, DB/worker/schema changes.
- Any new dependency.
- Cursor/pagination is *in scope* at the client (C1) but the worker already
  returns `nextCursor`; no worker change needed.

---

## 15. Invariant Compliance of the Recommended Design

- Content identity stays `(contentHashVersion, contentHash)` — C1/C2/C3 never
  re-key global data.
- No second analysis pipeline — C2 reuses the 16J reuse path.
- Search engine stays local and read-only — C3 feeds it a hydrated index, never
  mutates its semantics (INV-4 preserved).
- No audio bytes — all recommendations are metadata-only.
- UNAVAILABLE ≠ UNKNOWN — C4 makes this visible.

---

## 16. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Viewport query at high zoom returns few points | keep `limit` + cursor pagination (C1) |
| Hydration could grow the local index unbounded | bounded by intentional user interaction (§16.3) |
| Find Similar over many records is O(n) | acceptable at V1 scale; limit results (5/10/20) |
| Blind global selection triggers analysis cost | C4 adds inspection-only path / explicit state |
| Worker `nextCursor` contract drift | keep client read-only against existing contract |

---

## 17. Testing Plan (for the next phase — not executed now)

- **C1**: pure camera→bbox unit tests; app-level test that `refreshGlobalPoints`
  issues the correct viewport + follows `nextCursor`.
- **C3**: controller-level test that "similar" runs `findSimilar` with the
  selected record's identity/fingerprint and renders result rows; reuse existing
  `findSimilar` tests.
- **C2/C5**: test that selecting a global-only point persists a searchable local
  record (extension of `globalMapIntegration.test.ts`).
- **C4**: test distinct loading/empty/error map states (extend `mapView.test.ts`).
- **Regression**: full app + worker suites, tsc, build.

---

## 18. Live Verification Plan (for the next phase)

Reuse the live worker `https://samplemap-d1-worker.sumadmusic.workers.dev`:
- **C1**: publish a synthetic point in a sub-quadrant; zoom the map to that
  quadrant; assert the client issues a real bbox query and renders only that
  point.
- **C3**: verify Find Similar surfaces a globally-hydrated, compatible neighbor.
- **C4**: toggle worker availability (live vs offline provider) and assert the
  map shows `loading`/`error`/`ok` distinctly.
- Browser DOM rendering, preview, and Machiniste remain **NOT VERIFIED** (no
  authenticated Audiotool OAuth/browser available) — same limitation as 16K.

---

## 19. Open Questions

- **OQ-A**: Should global point selection offer an "inspect without analyzing"
  path (read global canonical metadata directly) vs. the current analyze-then-
  select? (Affects G4.)
- **OQ-B**: How aggressive should local-index hydration be (click-only vs.
  viewport-batch)? (Affects G5 / growth bounds.)
- **OQ-C**: Is a "global-only" visual filter on the map needed in V1, or does
  origin-based styling suffice?
- **OQ-D**: Is Find Similar scoped to local + hydrated-global content for V1, or
  should it query the global canonical fingerprints too? (The contract lacks a
  global find-similar endpoint today.)

---

## 20. Assumptions

- Global content shared for discovery is the **canonical, audio-free analysis**
  (per contract) — never raw audio.
- The local `SearchEngine` remains the *single* query surface (design §15).
- The 16J reuse path is the sanctioned way to turn global knowledge into
  searchable local records (design §16.3).

---

## 21. Definition of Done (for the 16L phase itself)

- [x] Entire discovery/interaction surface audited (all modules in §4).
- [x] Baselines re-verified green (app 499/499, worker 19/19, tsc, build).
- [x] Capability inventory produced (§6).
- [x] Five gaps identified (§8).
- [x] Search variant decision made (Variant C, §10–§11).
- [x] Minimal-invasive change set enumerated (§13) — **for the next phase only**.
- [ ] No production code written (enforced — `Production changes: 0`).

---

## 22. Verification Evidence

- `npx vitest run` (root) → 30 files, 499 tests, all pass.
- `npx vitest run` (workers/d1-worker) → 2 files, 19 tests, all pass.
- `npx tsc --noEmit` (root) → exit 0.
- `npx tsc --noEmit` (worker) → exit 0.
- `npx vite build` → succeed.

---

## 23. Files Reviewed

`src/ui/main.ts`, `src/ui/bootstrap.ts`, `src/ui/app.ts`, `src/ui/view.ts`,
`src/ui/render.ts`, `src/ui/map/mapView.ts`, `src/ui/map/mapRender.ts`,
`src/search/searchEngine.ts`, `src/similarity/similaritySearch.ts`,
`src/preview/previewService.ts`, `src/machiniste/machinisteService.ts`,
`src/global/usageAcceptance.ts`, `src/global/publishQueue.ts`,
`src/global/lookup.ts`, `src/global/liveProvider.ts`, `src/global/contract.ts`.

Reference docs: `STEP16_DESIGN.md` (§§14–17), `STEP16K_REPORT.md`,
`STEP16K_LIVE_VERIFICATION.md`, `SAMPLEMAP_V1_SPEC.md`.

---

## 24. Final Verdict

**STEP 16L — AUDIT + DESIGN — COMPLETE.**
- Production changes: **0** (design phase only; nothing implemented).
- Baselines: **499/499 app, 19/19 worker, tsc clean (app + worker), build pass.**
- **Recommended design decision:** **Search Variant C — hybrid** (map-viewport
  global discovery + local search over a hydrated local index), per
  `STEP16_DESIGN.md` §15.
- **Minimal-invasive change set for the next phase:** C1 (viewport-aware global
  map), C3 (wire Find Similar into UI), C2/C5 (hydrate interacted global
  content), C4 (global map load/empty/error states).
- **Live status:** worker/D1/publish//map/content identity/viewport/KNOWN-reuse
  were live-verified in 16K. Browser DOM rendering, preview, and Machiniste
  remain **NOT VERIFIED** (no authenticated Audiotool OAuth/browser available).

**This is a stopping point. Step 16L is NOT auto-implemented.**
