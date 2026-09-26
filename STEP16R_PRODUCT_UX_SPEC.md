# STEP16R — Product/UX Foundation Specification (Implementation-Ready)

**STEP**: STEP16R (post 16I/16L/16M/16O/16P/16Q)
**Status**: SPECIFICATION COMPLETE — IMPLEMENTATION NOT STARTED
**Type**: Specification only. Companion to `STEP16R_SPEC.md` (technical/scope foundation) and
`FINAL_UI_UX_DESIGN_SPEC.md` v1.1 (visual design). This document makes **NO source, test,
config, formula, persistence, classification, API, or GUI code changes**. Its only
deliverable is this specification, grounded in the actual, verified repository state.

**Binding anchors (not reopened):**
- `STEP16R_SPEC.md` §3/§4 — persisted V2 `mapPosition` authoritative; no V1 fallback; no
  on-read recompute; frozen map formula; no audio persistence; no redesign of
  OAuth/Nexus/Machiniste.
- `FINAL_UI_UX_DESIGN_SPEC.md` v1.1 + `FINAL_UI_UX_PHASE1_AUDIT_REPORT.md` — the audited,
  approved Phase-1 shell; audit §2 records the §7.2 axis prose as a **SPEC BUG**
  (implementation is correct: NOISY left / TONAL right); audit §5 lists the remaining-gap
  classifications this document now resolves as defined work items.
- `STEP16I_16M_STATUS.md` — final verdict **B — PARTIALLY REAL**; 16I 11/11, 16M 23/23,
  Layer C (interactive browser OAuth) **BLOCKED** (human session only).

**Verification baseline this spec must keep green (re-verified this session):** tsc 0 errors;
app vitest 576/576 (32 files); worker 19/19; `vite build` PASS; Playwright 28/28;
16I 11/11; 16M 23/23; Juul-perc foreign-public + legacy-hyphen direct-reference accepted
and read-back verified live (no ownership gate).

---

## 1. Purpose of This Document

`STEP16R_SPEC.md` defines *what the product is* and the V1/Later/Out-of-scope contract.
`FINAL_UI_UX_DESIGN_SPEC.md` defines *how it should look* (final visual design, later phase).
This document defines the **implementation-ready product/UX foundation**: the 15 UX areas
(A), the 11 canonical user flows (B), the UI state model (C), the component map (D), the
phased implementation plan (E), and the visual QA checklist (F), closing with the frozen
**16R DECISIONS** list that a successor implementation phase must obey.

Every "Current state" claim below is grounded in the actual code
(`src/ui/render.ts`, `src/ui/app.ts`, `src/ui/view.ts`, `src/ui/bootstrap.ts`,
`src/main.ts`, `src/ui/main.ts`, `src/ui/liveSession.ts`, `src/ui/map/mapView.ts`,
`src/ui/map/mapRender.ts`, `src/ui/samplemap.css`) and its tests.

---

# A. PRODUCT SPECIFICATION — 15 UX AREAS

## A0. One-sentence product statement (frozen)

> **SampleMap is an intelligent visual browser and classification layer over the accessible
> public Audiotool Sample Pool** — find it on a 2D map (Tonal⇄Noisy × Dark⇄Bright), hear it,
> narrow it, inspect it, and insert it into Audiotool by direct sample reference.

Mental model (`STEP16R_SPEC.md` §6): *"The accessible Audiotool public sample pool becomes a
searchable visual map."* Owner is metadata, never a wall. Analysis is a one-time per-sample
investment. Classification is an estimate, never ground truth. SampleMap acts in Audiotool,
not in SampleMap.

---

## A1. Layout & Shell

**Current state (implemented + Phase-1 audited):**
- `.app-shell` = header + `.app-content` (3-column grid: `240px` filter rail / `minmax(420px,1fr)` map region / `320px` inspector rail) + sticky bottom `.action-bar` + `.mobile-notice` (`render.ts:93-100`, `samplemap.css:164-254`).
- Header: brand `SAMPLEMAP` + status dot + `Local index · N analyzed`; global search; actions `Refresh index` / ☰ / `Inspector` (`render.ts:154-207`).
- Center region is **map-dominant** with the results list as an integrated secondary surface — never a fourth column (`render.ts:131-136`).
- Left rail: Library Scan / Analysis / Filters panels; right rail: Inspector / Find Similar / Send to Machiniste panels (`render.ts:120-147`).

**Definition for 16R (frozen):** The shell is the product's permanent chrome. Final visual
styling belongs to the later Final UI/UX Design phase; this spec only fixes layout regions,
region roles, region precedence (map dominant), and the persistent action bar.

## A2. The 2D Map

**Current state:**
- Pure projection `mapPoints()` — one point per **Audio Content Identity**, representative = lexicographically smallest sampleId; records without contentHash degrade to `legacy:<id>` unique points (`mapView.ts:296-341`).
- Only `status==="analyzed"` && `audioFeatures` && persisted `mapPosition` render; **Missing-V2 never renders** (`mapView.ts:300`).
- SVG `viewBox 0 0 800 520`, `preserveAspectRatio xMidYMid meet`; background + fixed axis labels in screen space; only the `.map-content` group receives the camera transform (`mapRender.ts:144-196`).
- Fixed classification palette (`CLASS_COLORS`, 22 classes + default) — presentation only, never position (`mapView.ts:355-385`).
- Points merged with global worker points; local precedence on identity (`mergeMapPoints`, `mapView.ts:465-481`).

**Definition for 16R:** Map is the product centerpiece. Density is a **read** (V1) — the
current visual crowding is the density aid; algorithmic clustering is Later. Overlapping
points: **reachability is a V1 requirement**; concrete overlap visualization (fan-out §10 of
the design spec) is declared later work in D/E, never invented during implementation.

## A3. X/Y Semantics (axes)

**Frozen reading (audit §2 — the §7.2 prose in the design spec is a recorded SPEC BUG; the
implementation is correct):**
- Horizontal x: **NOISY (left, x=0) ⇄ TONAL (right, x=1)** — flatness→1 ⇒ noisier ⇒ x→0.
- Vertical y: **DARK (bottom, y=0) ⇄ BRIGHT (top, y=1)** — screen Y is inverted via
  `toScreen()` so bright renders at top (`mapView.ts:347-352`).
- Axis labels in the SVG: bottom-left `NOISY`, bottom-right `TONAL`, top-left `BRIGHT`,
  lower-left `DARK` (`mapRender.ts:168-183`); `aria-label` "Sample map (noisy-tonal by
  dark-bright)" (`mapRender.ts:151`).
- The only proximity promise: *samples close together share similar characteristics along
  the defined SampleMap V2 axes.* No general "sounds the same" claim.

**Definition for 16R:** Frozen. Axis copy may be restated in plain English in tooltips/labels,
but coordinates are never re-derived, reordered, or relabeled beyond the above reading.

## A4. Search

**Current state:**
- Header global search input (`search-text`), placeholder `Search name, owner, or tag…`
  (`render.ts:168-176`), clear × button, `Cmd/Ctrl+F` focuses it and selects its text
  (`render.ts:888-895`).
- Deterministic text match over **name, owner, original tags, and primary class** via
  `SampleMapSearchEngine` (read-only; INV-4) (`app.ts:395-405`).
- Debounce-free full re-query per keystroke against the local index; live typing survives
  re-render via focus/caret preservation (`render.ts:84-117`).

**Definition for 16R:** Search is per-keystroke live, deterministic, and **never mutates map
point positions, the map camera, or the batch selection**. No-result search yields the
canonical `No samples match your search.` everywhere (map + list).

## A5. Filters (classification / confidence / sort)

**Current state:**
- Class filter: single `<select>` with `All` + groups `Drums`/`Musical`/`Other` + all 22
  classes from the frozen taxonomy (`classFilterOptions()` in `view.ts:146-153`);
  `All` clears, hidden group members expand via SearchEngine (`render.ts:374-395`).
- Min-confidence numeric input (0–1, step 0.05); empty = unset (`render.ts:398-409`).
- Sort: `Relevance / Confidence / Name / Analyzed At`, desc default (`SORT_OPTIONS`,
  `render.ts:412-420`).
- Result count (`resultCountLabel`), `Clear` (disabled unless a filter is active), active-filter
  detection via `hasActiveSearch` (`view.ts:171-179`, `render.ts:424-438`).

**Definition for 16R:** Structured filter panel in its current compact form is functionally
complete for V1. The restyled grouped-class + "Clear filters" control set (design spec §13) is
**defined work in a later increment (E-P4), not a correctness gap**. Filtering is explicit,
never implicitly drops low-confidence samples, and never clears the selection.

## A6. Result List

**Current state:** Integrated under the map. Row = checkbox (`multiselect-<id>`), preview
`▶`, name (click → focus/select), class `primaryClass (NN%)` with secondary classes in the
title tooltip, original tags on the line (kept separate from the class — INV-2), duration
(`render.ts:544-598`). Empty state `No samples match your filters.` (`results-empty`).

**Definition for 16R:** The list is the "landing surface" for precise identification behind
overlapping/large map densities; it exposes selection (checkbox), preview, focus (name), and
classification — matching map semantics 1:1. Sort order displayed = declaration of current
score order.

## A7. Inspector (detail panel)

**Current state (`render.ts:648-746`, `view.ts:62-100`):**
- Fields: name; Owner; Duration; Classification (primary class, confidence 3-dp, secondary
  classes w/ 2-dp confidence); Original Tags (read-only, separate section); Map Position
  (`X: … Y: …` or `unavailable` for Missing-V2); Preview toggle; Find Similar.
- Global-inspection variant for global-only points: name, `Origin: global (canonical
  analysis)`, classification, Content Identity (hash version + first 12 chars), analysis
  version, map position, `Hydrate Locally` (idempotent, version-guarded) — with
  `unknown` / `unavailable` / `incompatible` distinguished states (`render.ts:748-817`).
- Focus is exactly 0..1; empty state `No sample selected.`

**Definition for 16R:** Inspector is **focus-driven, never selection-driven**. The V1 field set
is already implemented and complete; Missing-V2 and low-confidence flags are surfaced in the
inspector (see A9). Full 14-field audio-feature readout remains Optional (data exists).

## A8. Preview

**Current state (`app.ts:788-841`):** Play/Stop per record in list + inspector; single active
player (focus change stops the previous); ObjectURL lifecycle owned entirely by
`PreviewService` (INV-6); generation/epoch guard sm-audit-007 discards stale in-flight
fetches; error `no preview url available` or previewError surfaced non-blocking. Button
becomes `■ Stop` while that sample is playing.

**Definition for 16R:** Single-playing semantics are binding. Preview is ephemeral — never
cached/persisted (audio invariance). Stopping, switching focus, and revoking all release the
ObjectURL.

## A9. Classification UX & Low Confidence

**Current state:** Confidence always shown (list + inspector + tooltip). Secondary classes
shown by confidence so near-misses read as understandable. Tags never fused into class labels
(INV-2 structural in `view.ts`).

**Definition for 16R (frozen):** Classification is an *estimate*, never ground truth; the UI
never writes tags back to Audiotool. Low-confidence samples are **never dropped**; they are
flagged in the inspector. The visual low-confidence cue on the map (design spec §8.5 inner
ring / density glow) and the tooltip disclaimer copy (§20.3) are **defined work in E-P5** —
presentation-only increments with no map-math involvement.

## A10. Selection vs Focus (state model core)

**Current state (`app.ts:195-209`, `app.ts:735-782`):**
- **Focus** (`focusedSampleId`): exactly 0..1; drives Inspector, Find-Similar, map highlight;
  survives filtering/search.
- **Selection** (`selectedSampleIds`): explicit batch, 0..8, **independent of focus**; survives
  zoom and filtering; hidden-but-selected samples remain in the batch send; `toggleMultiSelect`
  also focuses the clicked sample; the 9th cannot be added; `clearSelection()` clears selection
  **only** (never search/filters).
- `Esc` blurs the active control, closes drawers, then clears selection (`render.ts:877-901`).
- Action bar: pill `N / 8` (`.is-selected`/`.is-maxed`), `Add to Machiniste` disabled at 0
  (`render.ts:223-260`).

**Definition for 16R:** These semantics are the frozen interaction contract. Any successor
increment must preserve Focus⇄Selection independence as an invariant and keep the 8-cap at
the UI layer (service keeps its independent >8 defensive rejection).

## A11. Machiniste Action (send)

**Current state (`app.ts:854-874`, `render.ts:819-858`):** Send panel: machiniste id input +
slot-start number + `Send (max 8)`; action-bar CTA `Add to Machiniste` uses panel values.
Send maps `selectedRecords[i] → slotStart+i`, slices to 8, records `pendingSamples`, calls
`MachinisteService.send`. Result line: `Applied: A  Read-back: M  Slots: K` (+ `Errors: …`).
No selection → `no sample selected` error state.

**Definition for 16R:** Send operates exclusively on **selection**, never on focus alone.
Direct sample references only — no re-upload, no local copy. Read-back verification is part
of the success semantics (16M-verified chain).

## A12. Global State (map + publish)

**Current state:**
- Map side: viewport-bounded global loading — `limit 500`, max 2 pages via `nextCursor`,
  250 ms camera debounce; UI states `idle/loading/ok/empty/error` with human labels;
  error keeps the local map fully usable (`app.ts:146-158, 490-544`,
  `render.ts:482-485, 528-542`). Global map state line never implies "whole map empty".
- Publish side (`main.ts:104-126`): `GlobalPublishQueue` + usage-acceptance markers persisted
  in local IndexedDB; `reconstructPending` re-queues previously accepted samples; live worker
  (`VITE_GLOBAL_WORKER_URL`) or offline-first pending fallback.
- **Global publication is a strict 7-step semantic chain:** send → transfer succeeds →
  commit/applied verified → read-back matches → usage acceptance → queue accepts → worker
  publication succeeds. Publication must **never** be conflated with transfer.

**Definition for 16R:** The global layer is additive and defensive: it never masks local
content, never auto-loads unbounded pages, and the publish gate (usage acceptance) is
reflected in UI state rather than hidden. The publish-status surface (stored/known/conflict/
rejected/temporary-unavailable) is **defined work in E-P6** (currently surfaced via
main.ts logs + local marker persistence, not yet a dedicated UI panel).

## A13. Empty / Loading / Error States

**Current state (canonical, tested):**
- First-use overlay: `No analyzed samples yet.` + sub copy + single CTA
  `Connect Audiotool & start indexing` → `startScan` (`render.ts:489-525`), shown exactly when
  `resultCount===0 && !hasFilter && scanStatus==="idle"` (`view.ts:242-248`).
- Map empty `No analyzed samples yet.`; no-match `No samples match your search.`
  (`view.ts:182-189`); result list empty `No samples match your filters.`
- Scan/Analysis per-sample failure lines; budget 10/100/1000 only; pause/resume.
- Global map: `Global: loading… / available / no points in viewport / unavailable (local map
  still works) / idle`.
- Preview errors, local/global inspection errors, similar-panel empty states — all explicit.

**Definition for 16R:** These five canonical strings are frozen V1 copy (16R DECISIONS #16).
Every state must be explicit and non-fatal; nothing silently blank.

## A14. Responsive Behavior

**Current state (`samplemap.css:657-751`):**
- ≥1280: default 3-column grid (240 / minmax 420 / 320).
- 1024–1279: compact 220 / minmax 420 / 300, header search ≤360px.
- 768–1023: single column; filter rail becomes a left overlay drawer, inspector a bottom
  drawer (max-height 55vh), toggled by ☰/`Inspector` header buttons; `Esc` closes drawers.
- ≤767: desktop-only notice bar `SampleMap requires a desktop browser.` (V1 out of scope).

**Definition for 16R:** 768–1023 drawer behavior is implemented (CSS + shell classes) but is
**not e2e-covered** (audit §5 test gap) — a dedicated responsive-viewport Playwright spec is
**defined work in E-P5**. ≤767 stays a documented non-goal.

## A15. Accessibility (a11y) & Visual Language

**Current state:**
- Regions carry `aria-label` (Filters / Inspector); map SVG `role="application"` +
  `aria-label`; icon-only buttons have `aria-label`; native inputs/buttons used throughout.
- Keyboard: Esc (blur→drawers→clear selection), Cmd/Ctrl+F (search), Cmd/Ctrl+0 (reset view)
  (`render.ts:877-901`).
- Visual language (design tokens, `samplemap.css:11-93`): dark surfaces, 4 px spacing scale,
  Inter/SF-Mono, radius set, z-index ladder (`--z-header/drawer/actionbar/toast/modal`),
  `prefers-reduced-motion` honored (`samplemap.css:757-764`); `:focus-visible` ring.

**Definition for 16R:** Token set and motion handling are V1. The point-state matrix
(hover/focus/selection) is Phase-1 audited. Keyboard set is frozen (§28.1). Additional a11y
polish (keyboard point navigation, ARIA live regions for analysis progress) is **defined work
in E-P5**, non-blocking.

---

# B. USER FLOWS — 11 FLOWS (STEP-BY-STEP, GROUNDED)

Conventions: each flow lists trigger → steps bound to real components (`data-testid` / class)
→ state transitions → exit condition → acceptance hook (existing test or new e2e).
Flows marked **human-confirm** require the blocked Layer-C OAuth session to be closed first.

## FLOW 1 — First-use onboarding (**human-confirm**)
1. Open app unauthenticated → `#login` `Log in with Audiotool` button (main.ts:143-146).
2. OAuth completes → `mountAuthenticated` boots deps over the user's first opened project.
3. `refreshSearch` on an empty index → `shouldShowFirstUse` true → overlay (data-testid
   `first-use`): title + sub + CTA `first-use-index` (`startScan`).
4. User clicks CTA → scan starts (FLOW 2 path).
**Exit:** at least one analyzed point lands; overlay hides. **Hook:** `first-use` element
presence + `shouldShowFirstUse` unit test (`view.test.ts`); CTA e2e offline. Human step: OAuth.

## FLOW 2 — Indexing (scan + controlled analysis)
1. `Start Scan` (`scan-start`) → scanLibrary pages (pageSize 20, max 200 default) → enqueue
   added/changed (queue idempotent per build `smap-build-v1`).
2. `Analyse 10/100/1000` (`analyze-<budget>`) → JobRunner processes queue → records land:
   analyzed position persisted + class + confidence.
3. Progress visible: scan status/found/page count; analysis status/budget/analyzed/failed/
   remaining; pause/resume; per-sample failure lines.
4. Map updates progressively as results land (non-blocking).
**Exit:** run `stopped`, budget consumed or pause. **Hook:** 16L/16M e2e scan→analyze→points;
`app.test.ts` analysis state transitions.

## FLOW 3 — Browse & navigate the map
1. Read axes (NOISY⇄TONAL × DARK⇄BRIGHT), see density.
2. Wheel zoom around pointer (zoomBy anchor); `＋/−` buttons (1→2→4→8); `Reset View`
   (`map-zoom-reset`); Cmd/Ctrl+0.
3. Drag-pan (after DRAG_THRESHOLD_PX=4); hit radius 10 px through the current camera
   (pointAt); hover tooltip (name/class/owner/tags).
4. Zoom label `NN%` updates; camera clamped (zoom 1..8, pan keeps map covering viewport).
**Exit:** user locates a region of interest. **Hook:** `mapView.test.ts` camera math;
Playwright pan/zoom/reset; camera runtime-only invariant (never persisted).

## FLOW 4 — Search / filter / sort
1. Type in global search (name/owner/tag/class) → list + map shrink per query live.
2. Refine with class select (`filter-class`), min confidence (`filter-confidence`),
   sort (`filter-sort`); `Clear` (`search-clear`) resets all + reloads full set.
3. No-match → canonical `No samples match your search.` on map + `results-empty` in list.
**Exit:** focused result set. **Hook:** `app.test.ts` + 15D step tests; determinism check;
selection survives (assertion: `selectedSampleIds` untouched by `setSearch`).

## FLOW 5 — Inspect a sample
1. Click map point or result-row name → focus set, point rendered `map-point-selected`.
2. Inspector shows V1 field set (name / owner / duration / classification / tags / position).
3. Missing-V2 → `Map position unavailable` (never fabricated). Low-confidence → flagged.
4. Global-only point → canonical global inspection (origin + identity + analysis version) →
   optional `Hydrate Locally` (idempotent, version-guarded).
**Exit:** user understands the sample. **Hook:** `detailView`/`detailMapPosition` unit tests;
16L inspection e2e; hydrate idempotency test (`globalMapIntegration.test.ts`).

## FLOW 6 — Preview
1. `▶` in list or inspector → PreviewService plays (ObjectURL); button → `■ Stop`.
2. Focus another sample → previous stops automatically (one active player).
3. Error → non-blocking `preview-error` line.
**Exit:** Stop or focus change. **Hook:** PreviewService tests; epoch/discard assertions
(SM-AUDIT-007) in `app.test.ts`.

## FLOW 7 — Find Similar
1. Focus a sample → `Find Similar` (`inspector-find-similar`) → similarity-v1 over local
   index (limit 10, deterministic ordering, self excluded).
2. Results in Find Similar panel (name/class/origin/play/select), data-testid `similar-<id>`.
**Exit:** user inspects a similar sample. **Hook:** 16L similarity tests; missing-fingerprint
error state.

## FLOW 8 — Global map browsing (community layer)
1. Camera changes → debounced viewport query (500/page, ≤2 pages); state line updates
   (`Global: loading…/available/no points in viewport/unavailable`).
2. Global point click → local match? focus local : canonical global inspection.
3. Error/unavailable → sticker state line; local map unaffected.
**Exit:** user finds or dismisses global content. **Hook:** `refreshGlobalPoints`/bounded-paging
unit tests; global-map-state label unit tests; live `/map?mapVersion=map-v2` read-back
(worker real point verified this session).

## FLOW 9 — Batch selection + send to Machiniste
1. Select via list checkboxes (toggleMultiSelect also focuses) and/or map points
   (Cmd/Ctrl-click semantics); pill `N / 8` updates; 9th cannot be added.
2. Selection survives zoom/filter; `Add to Machiniste` enables at 1, disabled at 0.
3. Enter machiniste id + slot start → `Send (max 8)` → batch 1..8 direct references →
   read-back verification → `Applied: A  Read-back: M  Slots: K` (+ errors).
4. `Esc` clears selection (never search/filters) at any time.
**Exit:** verified send or error surfaced. **Hook:** 16M e2e send/read-back; cap-8 +
>`8`-defensive unit tests; globalMapIntegration send chain.

## FLOW 10 — Global publish after verified usage (**human-confirm**)
1. Real Machiniste use verified (read-back matches, errors=0) → `acceptUsageAndEnqueue`
   persists marker + enqueues publication (main.ts/runMachinisteTest path).
2. Live worker configured (`VITE_GLOBAL_WORKER_URL`) → publish chain executes 7 steps;
   offline → pending/retryable, re-queued on next boot via `reconstructPending`.
3. Publish-status surfaced (16R DECISIONS #9; dedicated status surface = E-P6) —
   **transfer ≠ publication**.
**Exit:** worker accepts publish or offline pending is recorded. **Hook:** usageAcceptance +
publishQueue unit tests; live Worker publish verified this session (map-v2 point at
x=0.6556 y=0.5398). Human step: one authenticated Layer-C run.

## FLOW 11 — Persist & reload determinism
1. Reload → local index hydrates; positions read (never recomputed); same points, same DOM.
2. Camera resets to default (runtime-only, not persisted — Later: restored viewport).
3. Selection clears (session state); first-use overlay only when never indexed.
4. Missing-V2 remains honestly absent.
**Exit:** identical map layout. **Hook:** 16M-07 determinism + 16M-12 reload e2e;
persisted `rec.mapPosition === computePosition(...)` live-verify guard.

---

# C. UI STATE MODEL

The controller `SampleMapApp` is DOM-free; `render.ts` is a thin projection. All state below
is real field/state names from `app.ts` / `view.ts` / `mapView.ts`. New increments add state
only when E-phase work requires it (flagged **ADD**).

## C1. Domain state
| State | Type / values | Owner | Invariant |
|---|---|---|---|
| `results` | `SearchResult[]` | app | projection of search only; never mutated by camera |
| `scan` | `{status: idle\|scanning\|done\|error, foundCount, pageCount, error}` | app | bounded (maxSamples) |
| `analysis` | `{budget?, status: idle\|running\|paused\|stopped, analyzed/failed/skipped/gone, stoppedReason?, error?}` | app | budget ∈ {10,100,1000} only; reentrancy-guarded |
| `searchState` | `{text, classes[], minConfidence?, sortBy, sortDir}` | app | deterministic; pass-through to SearchEngine (read-only) |
| `focusedSampleId` | `string\|null` | app | exactly 0..1; survives filter |
| `selectedSampleIds` | `string[]` `(0..MAX_BATCH_SLOTS)` | app | independent of focus; survives zoom+filter; 9th not addable; visible≠availability |
| `knownRecords` | `Map<id, SampleIndexRecord>` | app (private) | lets hidden focus/selection stay inspectable |
| `globalPoints`, `globalBBox` | `GlobalMapPoint[]`, `NormalizedBBox?` | app | viewport-bounded |
| `globalMapState` | `idle\|loading\|ok\|empty\|error` | app | never implies whole-map empty; error keeps local |
| `globalInspection` | `GlobalInspection?` (point, analysis, sampleId, resolved, error?) | app | read-only; no pipeline run |
| `similarResults/Records/Error` | lists + error | app | deterministic, self excluded, limit 10 |
| `previewSampleId/Error` | state + errors | app | one active player; epoch-guarded |
| `mapCamera` | `MapCamera {zoom, panX, panY}` | app | **runtime-only, never persisted**; clamped |

## C2. View-model projections (pure, tested)
`resultView`, `detailView`, `detailMapPosition` (undefined = Missing-V2), `durationLabel`,
`resultCountLabel`, `selectionCountLabel`, `selectionPillLabel` (clamped `N / 8`),
`emptyStateMessage(hasFilter)`, `shouldShowFirstUse`, `classFilterOptions`, `SORT_OPTIONS`,
`ANALYSIS_BUDGETS` — all in `view.ts`.

## C3. Map interaction state (reducer in `mapView.ts`)
`MapUiState {hoveredSampleId?, selectedSampleId?}`; transitions `hover()` / `select()`; pure
`tooltipFor()`; camera math `zoomBy/panBy/clampZoom/clampPan/applyCamera/cameraToViewportBBox`.

## C4. State transition rules (binding)
1. Search/filter/sort set → `refreshSearch` (only source of `results` change).
2. Camera set → only camera + global viewport query; positions/records untouched.
3. Selection ops touch **only** selection (plus focus on toggle, matching Cmd/Ctrl-click).
4. `Esc` → blur active control → close drawers → `clearSelection`; never search/filters.
5. Publish states `stored/known/conflict/rejected` + `temporary-unavailable` (offline) —
   **ADD** surface in E-P6; chain states documented (`app.ts`/`global`).
6. Missing-V2 → no map point; `Map position unavailable` in inspector; publish guarded.

---

# D. COMPONENT MAP

Legend: **KEEP** = untouched; **EXTEND** = additive, preserves behavior/testids;
**ADD** = new component by a successor implementation phase; fidelity to
`FINAL_UI_UX_DESIGN_SPEC.md` section numbers.

## D1. UI layer (`src/ui`)
| Component | File | Status | Notes |
|---|---|---|---|
| Controller `SampleMapApp` | `app.ts` | KEEP | DOM-free; all invariants; new increments add methods/state without touching existing semantics |
| Renderer shell | `render.ts` | KEEP | every pre-existing testid preserved; new sections append |
| View-models | `view.ts` | KEEP (EXTEND in E-P4/E-P5) | add pure projections only |
| Browser bootstrap | `bootstrap.ts` | KEEP | real deps wiring incl. `SampleMapMachinisteService(doc)`, `scanMaxSamples:200` |
| `mountAuthenticated` | `ui/main.ts` | KEEP | entry for authenticated mounts |
| `openFirstProject` | `liveSession.ts` | KEEP | Layer-C glue |
| Map view-model | `map/mapView.ts` | KEEP | frozen; `pointRadius` Phase-1 approved |
| Map renderer | `map/mapRender.ts` | KEEP | thin SVG glue |
| Stylesheet | `samplemap.css` | KEEP (EXTEND in E-P5) | token system; point-state matrix audited |
| OAuth + POC harness | `src/main.ts` | KEEP | `mountLiveSampleMap`, runSamplePoc, publish queue bootstrap |

## D2. Core services (untouched — invariant boundary)
`src/map/mapPosition.ts` (frozen formula), `src/audio`, `src/classify`, `src/persistence`,
`src/pipeline` (AnalysisPipeline/JobRunner), `src/search`, `src/machiniste`,
`src/global` (publishQueue/usageAcceptance/lookup/liveProvider/contract), `workers/d1-worker`.
None of these are modified by any successor increment; they are consumed as-is.

## D3. Defined future components (**ADD** in E-phases)
| Component | Phase | Requirement | Design-ref |
|---|---|---|---|
| Low-confidence map cue (ring/glow) | E-P5 | visual only; no math; regression-safe | §8.5 |
| Global publish-status surface (stored/known/conflict/rejected/temporary-unavailable) | E-P6 | additive panel/section; reflects the 7-step chain | §19.5 |
| Structured filter panel (grouped class controls + Clear-filters) | E-P4 | restyle of existing functional controls; testids preserved | §13 |
| Tooltip disclaimer copy (`Position is an impression of timbre…`) | E-P5 | copy only | §20.3 |
| Responsive drawer e2e coverage (768–1023) | E-P5 | test-only increment | §27 |
| Overlap reachability UX + eventual fan-out | Later (E-gate) | reachability is V1 (already true via list/hit-test); concrete visualization later | §10 |
| Saved viewport restore | Later | opt for persistence of camera — currently runtime-only | §11.7 |
| Confidence threshold UI | Later | explicit-only, never implicit | §11.3 |

## D4. Untouchable list (frozen by 16R DECISIONS)
Magnified map math, persisted V2 positions, audio persistence invariants, Focus/Selection
semantics, batch cap, canonical copy, published-point positions. No increment may change
`data-testid`s used by the 16M/28-test Playwright suite.

---

# E. IMPLEMENTATION PLAN (PHASED, INCREMENTAL)

Phase discipline (audit §6): strictly incremental; every increment re-runs the full gate:
`vitest` (576+ → grows), `tsc --noEmit` 0 errors, `vite build` PASS, Playwright 28+ PASS,
16I/16M live-verify scripts 11/11 and 23/23 (or the documented Layer-C exception), plus
frozen-invariant assertions (focus≠selection, cap 8, no V1 recompute, camera runtime-only,
canonical copy).

## E-P0 — Baseline lock (no code)
Re-run gates; record exact counts; snapshot `FINAL_UI_UX_PHASE1_AUDIT_REPORT.md`; confirm
zero unintended code change during 16R. **Exit:** green baseline.

## E-P1 — Mapping spec to code reconciliation (docs only)
Produce a cross-reference table: every UX area (A) + flow (B) + state (C) → file/line +
existing test name. Freeze the Component Map. **Exit:** 100% of A/B mapped to real anchors.

## E-P2 — Copy + labels pass
Apply the five canonical strings everywhere (16R DECISIONS #16); align tooltip/axis plain
English per A3; ensure no dev-facing strings leak into product copy. **Exit:** copy audit
green; no behavior change.

## E-P3 — Selection/send polish surface
Wrap current info into clearer UX without semantic change — e.g. expose `selectionCountLabel`
tooltips, disabled-state title on `Add to Machiniste`, send panel id/slot validation hint.
**Exit:** e2e still green; new unit tests for label projections.

## E-P4 — Structured filter panel (restyle, §13)
Grouped class controls + "Clear filters" over the existing `setClasses/setMinConfidence/
clearSearch` API. Keep `filter-class`/`filter-confidence`/`search-clear` testids functional.
No change to SearchEngine. **Exit:** full filter test matrix green (combined criteria,
active-filter count, clear).

## E-P5 — Presentation + a11y + responsive coverage (§8.5, §20.3, §27, a11y)
Low-confidence map cue (visual only), tooltip disclaimer copy, keyboard/ARIA polish,
dedicated 768–1023 Playwright viewport spec. Each item independently rolled back if it
threatens the gate. **Exit:** all gates + new spec files green.

## E-P6 — Global publish-status surface (§19.5)
Additive panel/section reflecting `GlobalPublishQueue`/usage-acceptance states and the
7-step chain; offline-first + live worker both represented; never blocks the local map.
**Exit:** publish-state unit tests + live worker roundtrip.

## E-P7 — Human Layer-C closure (not implementable in automation)
One authenticated browser OAuth run exercising FLOW 1 + FLOW 10 end-to-end. Closes the
recorded BLOCKED state and upgrades the remaining PARTIALLY REAL item to REAL.
**Exit:** STEP16I_16M_STATUS verdict upgraded; report updated.

## E-P8 — Frozen read-only review
Final audit: 16R DECISIONS compliance, zero unintended diffs, gate baseline intact.
**Exit:** successor phase may begin.

---

# F. VISUAL QA CHECKLIST

Run after every E-increment (E-P2 and up) in a desktop Chrome @ ≥1280 px and @ 1024 px,
plus a 768 px drawer pass where relevant.

## Shell & layout
- [ ] Header: brand + dot + `Local index · N analyzed`; search centered ≤440 px; Refresh/☰/Inspector reachable.
- [ ] 3 regions exactly; map dominant; results integrated below map (no 4th column).
- [ ] Action bar sticky at bottom: status line, `N / 8` pill, `Add to Machiniste`.
- [ ] No horizontal overflow; region minimums hold (420 px map min).

## Map
- [ ] Axes readable: NOISY⇄TONAL (x), DARK⇄BRIGHT (y), top=bright.
- [ ] Zoom 1→2→4→8 (± buttons + wheel-around-pointer); label updates; Reset View works.
- [ ] Drag pans only after threshold; click on point never pans; hit radius 10 px holds after zoom.
- [ ] Hover: stroke + tooltip (name / class / owner / tags); leaves clean.
- [ ] Point size stable while zooming (`max(4, 6/zoom)`), focused/selected ×1.35 ring; selection glow.
- [ ] Missing-V2 never renders; no fabricated positions.
- [ ] Global points merge without obscuring local; state line readable in all 5 states.

## Inspector / list / similar
- [ ] Inspector field set complete incl. position (`X/Y` or `Map position unavailable`);
      low-confidence flag; classification secondary order.
- [ ] Global inspection variants (unknown / unavailable / incompatible) render read-only;
      Hydrate is bounded + idempotent.
- [ ] Result rows: checkbox / ▶ / name / class% / tags / duration; hover state.
- [ ] Find Similar panel lists deterministically; self excluded.

## Selection & action bar
- [ ] Focus ≠ selection visually distinguishable; hidden-but-selected still counted.
- [ ] Pill: `N / 8`, `is-selected`, `is-maxed`; 9th add impossible at UI.
- [ ] Esc: blur → drawers close → selection cleared; search/filters untouched.
- [ ] Send: batch 1..8, Applied/Read-back/Slots/Errors line; empty-selection disabled states.

## States & copy
- [ ] First-use overlay exactly when never indexed + no filter; single CTA.
- [ ] Canonical strings used exclusively: `No samples match your search.`,
      `No analyzed samples yet.`, `Map position unavailable`, `Global: unavailable (local map
      still works)`.
- [ ] Every loading/error path visible and non-fatal (scan/analysis/preview/map/global/send).

## Responsive & a11y & motion
- [ ] 1024–1279 compact grid; 768–1023 drawers (filter left / inspector bottom) + Esc close;
      ≤767 notice bar.
- [ ] Keyboard: Esc, Cmd/Ctrl+F, Cmd/Ctrl+0; focus-visible ring on all controls; ARIA labels.
- [ ] `prefers-reduced-motion: reduce` → no meaningful animation.

---

# 16R DECISIONS (FROZEN — binding for every successor increment)

1. **Axes (frozen).** NOISY(left)⇄TONAL(right); DARK(bottom)⇄BRIGHT(top); labels over frozen
   V2 math; the design-spec §7.2 prose reversal is a recorded SPEC BUG, not implemented.
2. **The map is the centerpiece; the result list is an integrated secondary surface** (never a
   fourth column); density is a V1 read; algorithmic clustering is Later.
3. **Persisted V2 `mapPosition` is authoritative** — no V1 fallback, no recompute, no
   fabrication; `Missing-V2` = `Map position unavailable` + no point + publish-guarded.
4. **FOCUS ≠ SELECTION (binding).** Focus is 0..1 and drives inspector/similar/map-highlight;
   selection is the 0..8 batch, independent, survives zoom+filter; visible ≠ availability.
5. **Batch cap 8 at the UI layer**; a 9th cannot be added; the Machiniste service keeps its
   independent >8 defensive rejection (not a normal UI dialog).
6. **Machiniste send uses selection only, direct references only** (no re-upload, no local
   copy); success includes read-back verification.
7. **One active player at a time; preview is ephemeral** (PreviewService owns ObjectURLs);
   no audio persistence anywhere; audio stats never written by UI.
8. **Classification is an estimate, never ground truth**; confidence always shown; low-confidence
   samples never dropped; tags never written back (INV-2 structural).
9. **Global publish is a strict 7-step semantic chain**; transfer ≠ publication; publishing is
   gated on verified usage acceptance; offline-first pending is a first-class state; the
   publish-status surface (stored/known/conflict/rejected/temporary-unavailable) is E-P6.
10. **Search/filter/sort and camera never mutate** record positions, map layout, or selection;
    `results` change only through `refreshSearch`.
11. **Global map loading is bounded** (500/page, ≤2 pages, 250 ms debounce); the global state
    line never implies "whole map empty"; global errors never break the local map.
12. **First-use = canonical empty state + single CTA (start indexing)**; shown exactly when
    `resultCount===0 && !hasFilter && scanStatus==="idle"`.
13. **Responsive contract:** ≥1280 default; 1024–1279 compact; 768–1023 drawers; ≤767
    desktop-only notice (documented non-goal). Drawer behavior ships with a dedicated
    viewport e2e in E-P5.
14. **Keyboard set frozen:** Esc (blur → close drawers → clear selection only), Cmd/Ctrl+F
    (search), Cmd/Ctrl+0 (reset view); `prefers-reduced-motion` honored.
15. **Canonical V1 copy (frozen):** `No samples match your search.` (map + list no-match),
    `No analyzed samples yet.` (empty pool / first-use title), `Map position unavailable`
    (Missing-V2), `Global: unavailable (local map still works)`. `results-empty` uses `No
    samples match your filters.`.
16. **Gate discipline:** every increment must keep `vitest` ≥576 (32 files), tsc 0, build PASS,
    Playwright ≥28, 16I 11/11, 16M 23/23 (or the documented Layer-C exception), and all frozen
    invariants asserted. Only `STEP16R_PRODUCT_UX_SPEC.md` (and the successor phase's E-plan)
    may be modified by this step.
17. **Component discipline:** `src/map`, `src/audio`, `src/classify`, `src/persistence`,
    `src/pipeline`, `src/search`, `src/machiniste`, `src/global`, `workers/d1-worker` are
    consumed as-is — never modified by a UI increment. Core service changes require a new
    technical step, not a UI increment.
18. **Owner is metadata:** shown in inspector + result rows; **searchable via text search**
    (name/owner/tag). A dedicated owner *filter control* is Later (constrained by the existing
    search architecture).
19. **Layer C closure is a human OAuth session** (FLOW 1 + FLOW 10), currently BLOCKED; it is
    a verification task, not an implementation task, and upgrades the status when completed.
20. **This phase ends without code change.** The successor phase runs E-P0→E-P8 in order,
    one increment at a time, each green-gated. No increment may begin without the prior one's
    exit criteria.

---

**STEP16R PRODUCT/UX FOUNDATION SPECIFICATION COMPLETE — IMPLEMENTATION NOT STARTED**