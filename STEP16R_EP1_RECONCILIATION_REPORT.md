# STEP16R — E-P1 Spec-to-Code Reconciliation Report

**STEP**: STEP16R, E-P1 (Mapping spec to code reconciliation — docs only)
**Status**: COMPLETE
**Type**: Documentation-only reconciliation. This report makes **NO source, test, config,
formula, persistence, classification, API, or GUI code changes**. It maps the frozen
`STEP16R_PRODUCT_UX_SPEC.md` (spec) against the actual, verified repository state and produces
the cross-reference tables required by E-P1. Its only deliverable is this document.

**Verdict: `E-P1 PASS — DOCUMENTATION RECONCILED`**

Reconciliation exit criteria, per spec `E-P1` (`STEP16R_PRODUCT_UX_SPEC.md:489-491`):
100% of A (UX areas) mapped to real anchors with existing test names; the Component Map
frozen; zero product-source modification. All verified below (§13).

---

## 1. Executive Summary

The frozen spec's 15 UX areas (A0–A15), 11 canonical flows (B), the UI state model (C), and the
component map (D) were reconciled against the actual code — not inferred from filenames or
report prose. Every spec claim was anchored to real `file:line` locations in `src/ui/*`,
`src/map/*`, `src/global/*`, `src/search/*`, `src/pipeline/*`, `src/preview/*`,
`src/similarity/*`, `src/machiniste/*`, `src/classify/*`, `workers/d1-worker/*` and to existing
unit/e2e/live test names (`src/ui/*.test.ts`, `e2e/step16m.spec.ts`, `e2e/final-ui-phase1.spec.ts`,
`scripts/live-verify-16i.ts`, `scripts/step16m-live-verify.ts`).

Outcomes:

1. **A0–A15 all match implementation.** The current state descriptions in the spec enumerate
   the code correctly. No UX area was found to be unimplemented-missing; every "Definition for
   16R" item is either already true in the code or is explicitly scheduled to a later E-phase by
   the spec itself.
2. **B1–B11 all mapped to live anchors.** Six flows are fully automated (2, 4, 5, 8, 9, 11); two
   are automated-except-audio (3, 6); three involve the human Layer-C OAuth boundary (1, 10) or
   real-backend materiality (7 via live-script, 10 via 16I). Two e2e-viewport gaps are recorded
   by the spec as E-P5 work (drag-pan/wheel-zoom gesture e2e, 768–1023 drawer e2e).
3. **C state model is exact.** Every C1 state is a real field of `SampleMapApp` (`app.ts`);
   every C2 projection is a real export of `view.ts`; C3 is the real `mapView.ts` reducer; C4
   transition rules reproduce the real controller branching, with the single `ADD` item (publish
   states surface) deferred to E-P6 by spec decision.
4. **D Component Map frozen.** D1 components verified `KEEP` (with the two `EXTEND`-in-EP5/EP4
   notes). D2 core services confirmed unchanged and consumed-as-is (invariant boundary, spec
   DECISION #17). D3 future components map cleanly onto E-P4/E-P5/E-P6/Later. D4 untouchable
   list matches the E-P0 frozen-invariant evidence.
5. **No blocking conflict found.** Five minor, non-blocking copy/string inconsistencies were
   identified (§9); every one is a documented E-P2 copy-pass item, none contradicts a frozen
   semantic decision, and none requires a stop.
6. **E-P0 remains authoritative.** All gate counts quoted here (tsc 0/0, app vitest 576/32 files,
   worker vitest 19/2 files, vite build PASS, Playwright 28/28, 16I 11/11, 16M 23/23) come from
   `STEP16R_EP0_BASELINE_REPORT.md`; no gate was re-run in E-P1, per the docs-only mandate.
7. **Zero product-source modification.** A SHA-256 manifest of 115 product-source/config files
   was captured before this report (E-P1 start) and re-verified after (E-P1 end); the two
   manifests are byte-identical (§13).

### 1.1 Section-to-requirement coverage matrix

| # | E-P1 requirement (task) | Report section |
|---|---|---|
| 1 | Executive summary of the reconciliation | §1 |
| 2 | Repository/file map used as the evidence base | §2 |
| 3 | A — reconcile all 15 UX areas to file/line + test anchors | §3 |
| 4 | B — reconcile all 11 flows to test/e2e anchors + status | §4 |
| 5 | C — reconcile the UI state model (C1/C2/C3/C4) | §5 |
| 6 | D — freeze the Component Map (KEEP/EXTEND/ADD) | §6 |
| 7 | E — carry-forward backlog E-P2…E-P8 with evidence | §7 |
| 8 | Conflicts / spec-vs-implementation contradictions (or explicit "none blocking") | §8 |
| 9 | Frozen invariant confirmation mapped to E-P0 evidence | §9 |
| 10 | Deferred work separated from missing work | §10 |
| 11 | Layer-C human boundary documentation | §11 |
| 12 | Verdict + integrity/write-protection verification | §13 |

---

## 2. Repository & File Map (evidence base)

Directory layout relevant to the mapping (all paths relative to repo root; no `.git`
— verified `git rev-parse` fails — so integrity is asserted via the §13 manifest, not VCS):

| Path | Role in reconciliation |
|---|---|
| `STEP16R_PRODUCT_UX_SPEC.md` | Frozen spec being reconciled (633 lines; sole mutable doc per DECISION #16) |
| `STEP16R_EP0_BASELINE_REPORT.md` | Authoritative gate/invariant evidence — cited, never re-run |
| `STEP16R_SPEC.md`, `FINAL_UI_UX_DESIGN_SPEC.md` v1.1, `FINAL_UI_UX_PHASE1_AUDIT_REPORT.md`, `STEP16I_16M_STATUS.md` | Referenced anchors (audit §2 axis SPEC BUG, audit §5 test gaps; verdict B — PARTIALLY REAL) |
| `src/ui/app.ts` | Controller `SampleMapApp` — DOM-free; all C1 state + C4 transitions |
| `src/ui/view.ts` | Pure projections (C2) + canonical copy constants (A13) |
| `src/ui/render.ts` | Thin DOM glue; every `data-testid`; shell/map/inspector/list/labels |
| `src/ui/bootstrap.ts`, `src/ui/main.ts`, `src/ui/liveSession.ts`, `src/main.ts` | Real-service wiring + OAuth POC + publish bootstrap |
| `src/ui/map/mapView.ts`, `mapRender.ts` | Map view-model (camera/point/hover/selection) + SVG renderer + axis labels |
| `src/ui/samplemap.css` | Design tokens, responsive §§14/27, a11y/motion (763 lines) |
| `src/ui/*.test.ts` | Unit suites (32 files, 576 tests; subset cited throughout) |
| `src/persistence`, `src/audio`, `src/classify`, `src/identity`, `src/similarity`, `src/search`, `src/pipeline`, `src/machiniste`, `src/global`, `src/library`, `src/map/mapPosition.ts` | D2 core services (consumed as-is; evidence anchors for state/build constants) |
| `workers/d1-worker/src`, `workers/d1-worker/test` | Worker source + 2 test files (`provider.test.ts`, `browserAdapter.test.ts`) |
| `e2e/step16m.spec.ts` (20 tests 16M-01…20), `e2e/final-ui-phase1.spec.ts` (8 tests FP-01…08), `e2e/artifacts/` | Playwright suite (28 total — the gate baseline) |
| `scripts/live-verify-16i.ts`, `scripts/step16m-live-verify.ts`, `scripts/machiniste-foreign-access.ts`, `scripts/machiniste-legacy-name-test.ts`, `scripts/analyze-map-x.ts`, `scripts/check-wav-url.ts` | Live verification harnesses (16I 11/11; 16M 23/23) |
| `package.json`, `vite.config.ts`, `playwright.config.ts`, `harness.html`, `index.html`, `tsconfig.json` | Build/test/driver config (port 5176 strictPort; system chrome; harness.html; webServer `npm run dev`) |

---

## 3. A — Reconciliation of the 15 UX Areas

Legend: **IMP** = implemented as described; **IMP-E#** = implemented; a listed enhancement is
spec-deferred to phase E#; **N/A-deferred** = spec defers the item; the code correctly does not
include it.

| Area | Spec | Implementation anchor (real) | Test anchor | Status |
|---|---|---|---|---|
| A0 Product statement | :46-55 | 3-col shell + map centerpiece; Tonal⇄Noisy × Dark⇄Bright; direct-reference insert | `app.test.ts` send chain; `e2e/step16m.spec.ts` 16M-10/18 | IMP |
| A1 Layout & shell | :59-69 | `render.ts:76-79` (`.app-shell`/`.app-content`/`.action-bar`/`.mobile-notice`); header `render.ts:154-207`; centers `render.ts:131-136`; action bar `render.ts:223-260` | FP-01 (idle shell), FP-06 (action-bar) | IMP |
| A2 2D map | :71-83 | `mapView.ts:296-341` `mapPoints()` (per-content-identity, legacy degrade); `mapView.ts:300` Missing-V2 never renders; `mapRender.ts:144-196` viewBox/axis-in-screen-space; `mapView.ts:355-385` palette; `mapView.ts:465-481` local-precedence merge | 16M-06 (svg + 4 circles), 16M-07 (deterministic coords), `mapView.test.ts` position describes | IMP (clustering = Later per spec) |
| A3 X/Y semantics (frozen) | :85-99 | `mapView.ts:347-352` `toScreen()`; `mapRender.ts:168-183` axis labels NOISY/TONAL/BRIGHT/DARK; `mapRender.ts:151` aria-label | `render.ts`/`mapRender.ts` are the audited-correct targets (audit §2) | IMP (SPEC-BUG record: design-spec §7.2 prose, implementation correct) |
| A4 Search | :101-114 | `search-text` `render.ts:168-176`; `Cmd/Ctrl+F` `render.ts:888-895`; engine `app.ts:395-405` via `SampleMapSearchEngine` (read-only); per-keystroke re-render caret preservation `render.ts:84-117` | `view.test.ts:182-189` canonical no-match; 16M-15; determinism in 16M-07 | IMP |
| A5 Filters/confidence/sort | :116-131 | class select `render.ts:374-395` (`classFilterOptions` `view.ts:146-153`); confidence `render.ts:398-409`; sort `render.ts:412-420` (`SORT_OPTIONS`); count/clear `render.ts:424-438` (`hasActiveSearch` `view.ts:171-179`). Restyled grouped panel = E-P4 per spec | `view.test.ts` filter projections; `app.test.ts:1297` (filter ≠ camera) | IMP (panel restyle deferred E-P4 per spec) |
| A6 Result list | :133-143 | `render.ts:544-598` row = checkbox `multiselect-<id>`/▶/name/class% + secondary-in-title/tags-separate/duration; `results-empty` | FP-04/05 selection counts; 16M-15 | IMP |
| A7 Inspector | :145-159 | `render.ts:648-746` + `view.ts:62-100` (`detailView`, `detailMapPosition` undefined = Missing-V2); global variant `render.ts:748-817`; empty `No sample selected.` | `view.test.ts` Step 15E inspector; 16M-17; `globalMapIntegration.test.ts` hydrated/idempotent | IMP |
| A8 Preview | :161-171 | one-active-player `app.ts:788-841`; ObjectURL lifecycle own `PreviewService`; epoch guard (SM-AUDIT-007) | `app.test.ts:1037-1163` (lifecycle + discard); 16M-19 | IMP (audible playback = real-browser human artifact) |
| A9 Classification/low-confidence | :173-183 | confidence every surface; secondary by confidence `view.ts`; tags never fused (INV-2 structural); low-conf ring + disclaimer = E-P5 per spec | `view.test.ts` INV-2 tag≠classification; `app.test.ts:624` INV-1 class | IMP (visual cue/deferred E-P5 per spec) |
| A10 Selection vs Focus (frozen) | :185-200 | focus `app.ts:195-209`; selection `app.ts:735-782`; Esc `render.ts:877-901`; pill `render.ts:223-260` | `app.test.ts:771/783/809/823/835/850/882/933`; FP-03/07; 16M-08 | IMP |
| A11 Machiniste send | :202-212 | panel + `Send (max 8)` `render.ts:819-858`; send map `app.ts:854-874`; result line `render.ts:287` (`Applied: …  Read-back: …  Slots: …`); `no sample selected` `app.ts:857` | `app.test.ts:896/910`; 16M-10/18; FP-06 | IMP |
| A12 Global state | :214-232 | viewport-bounded load `app.ts:146-158, 490-544`; state line `render.ts:531-540`; publish bootstrap `main.ts:104-126`; publish-status surface = E-P6 per spec (currently main.ts logs + markers) | `globalMapIntegration.test.ts` A–L + E; 16M-16; live /map read-back | IMP (E-P6 surface = spec-deferred) |
| A13 Empty/loading/error (canonical copy) | :234-248 | first-use overlay `render.ts:489-525`; `NO_ANALYZED_MESSAGE` `view.ts:182`; `NO_MATCH_MESSAGE` `view.ts:184,188`; CTA `render.ts:520` | `view.test.ts:180-200` (incl. `shouldShowFirstUse:190-200`); FP-01/FP-02 | IMP (2 copy items → §9, E-P2) |
| A14 Responsive | :250-261 | breakpoints `samplemap.css:657-751` (≥1280 / 1024-1279 compact / 768-1023 drawers / ≤767 notice) | CSS-only; 768–1023 e2e deferred E-P5 (audit §5 gap) | IMP (drawer e2e deferred E-P5 per spec) |
| A15 A11y & visual language | :263-277 | tokens `samplemap.css:11-93`; focus-visible `samplemap.css:138-140`; reduced-motion `samplemap.css:757-764`; keyboard `render.ts:877-901` ×2 | FP-07 (Esc semantics), FP-08 (Cmd/Ctrl+0) | IMP (keyboard-point-nav + ARIA-live = E-P5 per spec) |

Notes. (a) A3 is the audit §2-recognized SPEC BUG in `FINAL_UI_UX_DESIGN_SPEC.md` §7.2 prose;
the frozen reading (NOISY left / TONAL right, DARK bottom / BRIGHT top) matches
`mapRender.ts:168-183` exactly. (b) `classFilterOptions()` at `view.ts:146-153` returns the
frozen 22-class taxonomy groups (Drums/Musical/Other + All), matching A5's "all 22 classes".

---

## 4. B — Reconciliation of the 11 Canonical Flows

Status classification: **AUTO** = fully automated (unit+e2e/live); **AUTO(audio-adjacent)** =
automated except audible playback or gesture feel; **AUTO+human** = automated offline; the
authenticated browser step requires Layer-C (human OAuth, `STEP16I_16M_STATUS` verdict
B — PARTIALLY REAL).

| # | Flow | Spec | Implementation anchor | Verification anchor | Status |
|---|---|---|---|---|---|
| 1 | First-use onboarding (**human-confirm**) | :287-294 | `#login` `main.ts:143-146`; `mountAuthenticated`; overlay + CTA `render.ts:489-525`; `shouldShowFirstUse` = `resultCount===0 && !hasFilter && scanStatus==="idle"` | `view.test.ts:190-200`; FP-01/FP-02 (offline); OAuth step = Layer-C | AUTO+human |
| 2 | Indexing (scan + controlled analysis) | :296-305 | scanLibrary pageSize 20/max 200; enqueue idempotent per build; budget `10/100/1000`; JobRunner paused/stopped | `app.test.ts` analysis states; `step16L.test.ts` F; 16M-02/03/13 | AUTO |
| 3 | Browse & navigate | :307-315 | zoomBy/panBy/clamp/pointAt `mapView.ts`; `Reset View`; Cmd/Ctrl+0; camera runtime-only | `mapView.test.ts` camera/radius/pan describes; FP-08 (Cmd/Ctrl+0); drag/wheel e2e gap → E-P5 | AUTO(audio-adjacent/gesture gap) |
| 4 | Search / filter / sort | :317-323 | engine + controls A4/A5 anchors | `app.test.ts:7` selection-survives, 1297; 16M-15; FP-04/05 | AUTO |
| 5 | Inspect a sample | :325-332 | A7 anchors; Missing-V2 → `unavailable` (copy: §9 item C-1) | `view.test.ts` detail/detailMapPosition; 16M-17; hydrate idempotency `globalMapIntegration.test.ts` | AUTO |
| 6 | Preview | :334-339 | A8 anchors; epoch discard | `app.test.ts:1037-1163`; PreviewService tests; 16M-19 (url resolution only) | AUTO(audio-adjacent) |
| 7 | Find Similar | :341-346 | `inspector-find-similar`; `findSimilar` `similaritySearch.ts:71` (limit 10, self-excluded, deterministic); `findSimilarForSelected` focus-driven `app.ts:683-701` | `step16L.test.ts` C5; `globalMapIntegration.test.ts` K | AUTO (e2e not dedicated; unit-covered) |
| 8 | Global map browsing | :348-355 | bounded paging `app.ts:146-158,490-544` (500/page ≤2 pages 250ms); state line `render.ts:531-540`; local on error | `globalMapIntegration.test.ts` A–L/E; `step16L.test.ts` C1; 16M-16; live /map read-back | AUTO |
| 9 | Batch selection + send | :357-366 | A10/A11 anchors; cap-8 UI + >8 defensive | `app.test.ts:835` (cap), 563 (defensive), 896/910; 16M-10/18; FP-06 | AUTO |
| 10 | Global publish (**human-confirm**) | :367-376 | `acceptUsageAndEnqueue` + markers `usageAcceptance.ts`; 7-step chain; offline pending `publishQueue.ts`; reconstructPending | `usageAcceptance.test.ts`/`publishQueue.test.ts` (16I suite 11/11); live worker publish `scripts/live-verify-16i.ts`; E-P6 surface deferred; OAuth step = Layer-C | AUTO+human |
| 11 | Persist & reload determinism | :378-384 | hydrated positions never recomputed; camera runtime-only; selection session-only; Missing-V2 honestly absent | 16M-07 (determinism) + 16M-12 (reload); live `rec.mapPosition === computePosition(...)` guard | AUTO |

Gaps recorded here are exactly the ones the spec itself already classifies as E-P5 work
(responsive-drawer e2e §A14; drag-pan/wheel e2e is implied by FLOW 3's "Playwright pan/zoom/reset"
hook, currently only reset is e2e-covered via FP-08) — no missing work was found.

---

## 5. C — Reconciliation of the UI State Model

### C1. Domain state — every spec row is a real `SampleMapApp` field (`app.ts`)
| Spec state | Real declaration | Invariant observed |
|---|---|---|
| `results` | `SearchResult[]` | `refreshSearch` is the only writer (spec C4.1) |
| `scan` | `{status≈idle\|scanning\|done\|error, foundCount, pageCount, error}` | bounded by `scanMaxSamples` 200 (bootstrap) |
| `analysis` | `{budget?, status idle\|running\|paused\|stopped, analyzed/failed/skipped/gone, stoppedReason?, error?}` | `ANALYSIS_BUDGETS` {10,100,1000}; reentrancy-guarded |
| `searchState` | `{text, classes[], minConfidence?, sortBy, sortDir}` | pass-through to read-only engine |
| `focusedSampleId` | `string\|null` | 0..1; survives filter (test :742) |
| `selectedSampleIds` | `string[] (0..MAX_BATCH_SLOTS)` | focus-independent; survives zoom+filter (tests :850/:882); 9th not addable (:835); visible≠availability (:707) |
| `knownRecords` | `Map<id,SampleIndexRecord>` | hidden focus/selection stay inspectable |
| `globalPoints`/`globalBBox` | `GlobalMapPoint[]`/`NormalizedBBox?` | viewport-bounded |
| `globalMapState` | `idle\|loading\|ok\|empty\|error` | label never "whole map empty" (`render.ts:531-540`) |
| `globalInspection` | `GlobalInspection?` | read-only; no pipeline run |
| `similarResults/Records/Error` | lists + error | deterministic; self excluded; limit 10 |
| `previewSampleId/Error` | state + error | one active player; epoch-guarded |
| `mapCamera` | `MapCamera {zoom, panX, panY}` | runtime-only, clamped (test :1262) |

### C2. View-model projections — all real exports of `view.ts`
`resultView`, `detailView`, `detailMapPosition` (undefined = Missing-V2), `durationLabel`,
`resultCountLabel`, `selectionCountLabel`, `selectionPillLabel` (clamped `N / 8`),
`emptyStateMessage`, `shouldShowFirstUse`, `classFilterOptions`, `SORT_OPTIONS`,
`ANALYSIS_BUDGETS`, plus `NO_ANALYZED_MESSAGE`/`NO_MATCH_MESSAGE` copy constants. All tested in
`view.test.ts` (incl. `shouldShowFirstUse:190-200`, canonical copy:136-137).

### C3. Map interaction state — real `mapView.ts` reducer
`MapUiState {hoveredSampleId?, selectedSampleId?}`, `hover()/select()`, `tooltipFor()`, and
camera math `zoomBy/panBy/clampZoom/clampPan/applyCamera/cameraToViewportBBox` all present and
pure — covered by `mapView.test.ts` describes.

### C4. Transition rules — confirmed by controller branch + tests
| Rule | Evidence |
|---|---|
| 1. `refreshSearch` only source of `results` | `app.ts` single setter; tested (:850 selection survives search) |
| 2. Camera → only camera + global viewport query | `app.ts` separate path; tested (:1262, :1297) |
| 3. Selection ops touch only selection (+focus on toggle) | tested (:771/:783/:809/:823) |
| 4. `Esc` → blur → close drawers → `clearSelection` only | `render.ts:877-901`; FP-07 |
| 5. Publish states `stored/known/conflict/rejected` + `temporary-unavailable` — **ADD E-P6** | chain in `publishQueue.ts`/`usageAcceptance.ts`/`liveProvider.ts` (16I suite) |
| 6. Missing-V2 → no point, inspector position, publish guarded | `mapView.ts:300`; `render.ts:719`; `mapPosition.ts` `mapVersion="map-v2"` |

---

## 6. D — Component Map (Frozen by this report)

### D1. UI layer — all KEEP as specified, verified present
`app.ts` (KEEP), `render.ts` (KEEP, all testids preserved), `view.ts` (KEEP, EXTEND E-P4/E-P5),
`bootstrap.ts` (KEEP; `SampleMapMachinisteService(doc)`, `scanMaxSamples:200`), `ui/main.ts`
(KEEP), `liveSession.ts` (KEEP), `map/mapView.ts` (KEEP; `pointRadius` Phase-1 approved),
`map/mapRender.ts` (KEEP), `samplemap.css` (KEEP, EXTEND E-P5), `src/main.ts` (KEEP OAuth+POC
harness). Each file is consumed by the verified gate suite; no deviations from the spec's D1
table.

### D2. Core services — untouched invariant boundary (DECISION #17)
`src/map/mapPosition.ts` (frozen V2 formula, `mapVersion="map-v2"`, no V1 fallback),
`src/audio`, `src/classify`, `src/persistence`, `src/pipeline`, `src/search`, `src/machiniste`,
`src/global`, `workers/d1-worker` — all present, consumed as-is, and byte-identical across E-P1
(§13 manifest includes every `.ts` under these trees).

### D3. Defined future components — ADD-phase assignment carries forward unchanged
Low-confidence ring E-P5 (§8.5); publish-status surface E-P6 (§19.5); structured filter panel
E-P4 (§13); tooltip disclaimer E-P5 (§20.3); 768–1023 drawer e2e E-P5 (§27); overlap fan-out
Later (E-gate, §10); saved viewport restore Later (§11.7); confidence threshold UI Later (§11.3).

### D4. Untouchable list — aligned with §9 (frozen invariants)
Magnified map math, persisted V2 positions, audio persistence invariants, Focus/Selection
semantics, batch cap 8, canonical copy, published-point positions, and every `data-testid`
exercised by the 16M/FP Playwright suite (28/28 green at E-P0). Nothing in E-P1 touched any of
these.

---

## 7. E — Carry-Forward Backlog (E-P2 … E-P8), evidence-grounded

| Phase | Spec | Concrete work items evidenced by this reconciliation |
|---|---|---|
| E-P2 Copy + labels | :493-496, DECISION #15 | (C-1) Missing-V2 inspector label `render.ts:719` currently `unavailable` → canonical `Map position unavailable`; (C-2) German analysis labels `render.ts:326-331` (`Analysiert:`/`Fehler:`/`Verbleibend:`) → English product copy; (C-3) axis plain-English tooltips per A3; full dev-string audit. No testid changes. |
| E-P3 Selection/send polish | :498-501 | Expose `selectionCountLabel` tooltips; disabled-state title on `Add to Machiniste` (`render.ts:238`); send panel id/slot validation hint (`render.ts:819-858`). Label projection unit tests. |
| E-P4 Structured filter panel | :503-507 | Grouped class controls + Clear-filters over existing `setClasses`/`setMinConfidence`/`clearSearch` (A5 anchors); keep `filter-class`/`filter-confidence`/`search-clear`; no SearchEngine change. |
| E-P5 Presentation + a11y + responsive | :509-512 | Low-conf ring (§8.5); tooltip disclaimer (§20.3); keyboard point nav + ARIA live regions; dedicated 768–1023 Playwright spec (drawer CSS exists `samplemap.css:669-711`, no e2e yet); optional drag-pan/wheel-zoom gesture e2e (FLOW 3). |
| E-P6 Global publish-status surface | :514-517, DECISION #9 | Additive panel reflecting `stored/known/conflict/rejected/temporary-unavailable` + 7-step chain; offline + live represented; never blocks local map. Currently `main.ts:104-126` logs + markers only. |
| E-P7 Human Layer-C closure | :519-522 | One authenticated OAuth run of FLOW 1 + FLOW 10; upgrades `STEP16I_16M_STATUS` PARTIALLY REAL → REAL. |
| E-P8 Frozen read-only review | :524-526 | 16R DECISIONS compliance; zero unintended diffs; gate baseline intact. |

No invented phases. E-P2's string deviations are the only implementation-side copy deltas found
(§9, C-1/C-2); everything else on this table is prefixed by the spec itself.

---

## 8. Conflicts / Spec-vs-Implementation Findings

No conflict blocks reconciliation (no frozen semantic invariant is violated; no "Definition for
16R" item is unimplemented-missing). Five minor, non-blocking items were found and are correctly
owned by the spec's own E-P2 copy pass:

| # | Severity | Location | Finding |
|---|---|---|---|
| C-1 | Minor (copy) | `render.ts:719` | Missing-V2 position shows lowercase `unavailable`; spec A7 prose uses `unavailable` too, but DECISION #15/A13/FLOW 5 define the canonical CTA: `Map position unavailable`. → E-P2. |
| C-2 | Minor (copy) | `render.ts:326-331` | German analysis status labels (`Analysiert:`/`Fehler:`/`Verbleibend:`) — dev/test-era strings; DECISION #15 canonical copy is English and E-P2 requires "no dev-facing strings leak". → E-P2. |
| C-3 | Minor (copy) | `render.ts:719` vs `view.ts:62-100` | Position renders 3-dp fixed `X: …  Y: …`; F-checklist "X/Y" consistent — no change needed (documented as confirmed) |
| C-4 | Minor (naming) | `app.ts:683-701` | Method `findSimilarForSelected` + comment say "current selection"; it uses `focusedRecord` — behavior matches spec (focus-driven, FLOW 7/A7); doc-only nit, no change. |
| C-5 | Confirm-absent (non-asset) | — | No hidden global publish-surface (correct: spec defers to E-P6); no 768–1023 e2e (correct: spec defers to E-P5); no low-conf ring (correct: spec defers to E-P5). These are *deferred by spec*, not missing. |

The audit §2 axis-prose SPEC BUG record (`FINAL_UI_UX_DESIGN_SPEC.md` §7.2) is re-confirmed
per DECISION #1: the implementation is correct (NOISY left / TONAL right), and it is **not**
re-opened or re-fixed.

---

## 9. Frozen Invariant Confirmation (mapped to E-P0 evidence)

All 19 frozen invariants were declared VERIFIED in `STEP16R_EP0_BASELINE_REPORT.md`; E-P1
re-conforms each to its test anchor without re-running gates:

| Invariant | Evidence (test anchor) |
|---|---|
| V2 `mapPosition` authoritative; no V1 fallback / no on-read recompute | `mapPosition.ts` (`mapVersion="map-v2"`); live guard `rec.mapPosition === computePosition(...)`; `mapView.test.ts` Missing-V2 |
| Focus ≠ selection; focus 0..1; selection 0..8 independent; survives zoom+filter | `app.test.ts:771,783,809,823,835,850,882,896,910,933,707,742`; FP-03/07 |
| 9th not addable; service >8 defensive rejection | `app.test.ts:835,563`; `MAX_BATCH_SLOTS=8` `machinisteService.ts:38` |
| Missing-V2: no point + `Map position unavailable` + publish-guarded | `mapView.ts:300`; `render.ts:719`; `mapPosition.ts` |
| One active preview; ObjectURL owned by PreviewService; no audio persisted | `app.test.ts:624` (INV-1), 1038, 1107, 1163 (SM-AUDIT-007); `previewService.ts` |
| Tags never written back; tags ≠ classification (INV-2 structural) | `view.test.ts` INV-2; results/inspector separate sections |
| Selection-based, direct-reference Machiniste send with read-back | `app.test.ts:896,910`; 16M-10/18; `machinisteService.ts` read-back |
| Results change only via `refreshSearch`; camera never mutates positions/selection | `app.test.ts:850,882,1297` |
| Global loading bounded (500/page, ≤2 pages, 250ms); state line never "whole map empty"; global errors keep local | `globalMapIntegration.test.ts:A-L/E`; `render.ts:531-540`; 16M-16 |
| First-use = canonical empty + single CTA exactly when `resultCount===0 && !hasFilter && idle` | `view.test.ts:190-200`; FP-01/02 |
| Canonical copy frozen (DECISION #15) | `view.ts:182,184,188`; `render.ts:520,531-540` (see §8 C-1 for the only delta) |
| Esc keyboard contract (blur → drawers → selection only) | `render.ts:877-901`; FP-07 |
| Camera runtime-only, never persisted; Cmd/Ctrl+0 reset | `mapView.test.ts`; `app.test.ts:1262`; FP-08 |

---

## 10. Deferred vs Missing

**Deferred by the spec (present-in-spec, not-yet-in-code — correctly so):**
- E-P2 copy pass (C-1/C-2 strings); E-P3 polish titles/hints; E-P4 grouped filter panel;
  E-P5 low-conf ring + tooltip disclaimer + a11y polish + 768–1023 e2e (incl. FLOW-3 gesture e2e);
  E-P6 publish-status surface; Later: overlap fan-out, saved viewport restore, confidence
  threshold UI, owner-filter control; ≤767 desktop support (documented non-goal).

**Missing (spec requires, code lacks, and no E-phase owns it):** none found.

Every spec "Current state" claim reconciles to real code; every "Definition for 16R" gap is
either already true or explicitly phased.

---

## 11. Layer-C Human Boundary

- `STEP16I_16M_STATUS.md` verdict **B — PARTIALLY REAL**; 16I 11/11, 16M 23/23; interactive
  browser OAuth (Layer C) is BLOCKED — a human session only (DECISION #19; spec E-P7).
- Automated coverage already in place *behind* the boundary: OAuth-equivalent live PAT runs
  (`scripts/step16m-live-verify.ts`, `scripts/live-verify-16i.ts`) verify real sample list → real
  decode → real pipeline → real IndexStore → real search → real Machiniste read-back on a live
  SyncedDocument, and real worker publication (`map-v2` point verified this session at
  x=0.6556 y=0.5398, FLOW 8/10 live hooks).
- FLOW 1 step 1 (unauthenticated `#login`) and FLOW 10 step 1 (authenticated publish after
  verified usage) are the two human-auth touch points. All other steps are offline-automated.

---

## 12. Deferred-Phase Integrity Notes (E-P1 scope guard)

- No source test was created, modified, or re-run during E-P1; `STEP16R_EP0_BASELINE_REPORT.md`
  remains the authoritative gate evidence (tsc 0/0; app vitest 576/576 in 32 files; worker
  vitest 19/19 in 2 files; `vite build` PASS; Playwright 28/28; 16I 11/11; 16M 23/23;
  zero 16R product-source changes).
- The only file-written deliverables of E-P1 are documentation files under the repo root
  (`STEP16R_EP1_RECONCILIATION_REPORT.md`); DECISION #16 permits spec/E-plan doc mutation only.

---

## 13. Verdict & Integrity Verification

### 13.1 Write-protection verification
A SHA-256 manifest of every product-source and config file (115 files: all `.ts` under
`src/`, `workers/d1-worker/src|test|migrations`, `scripts/`, `e2e/`; plus `package.json`,
`package-lock.json`, `vite.config.ts`, `playwright.config.ts`, `index.html`, `harness.html`,
`tsconfig.json`, and the worker's `package.json|lock|wrangler.toml|vitest.config.ts|tsconfig.json`;
`.env` excluded as secret-bearing) was captured at E-P1 start and re-captured at E-P1 end.

- Before: `…/T/opencode/ep1-before.txt` (115 lines)
- After:  identical (re-computed and diffed — 0 differing lines)

Chained check: `shasum -a 256` of the 115 files → truncated to bare paths → sorted → compared.
Both manifests agree byte-for-byte ⇒ **zero product-source modification during E-P1**.

### 13.2 Reconciliation coverage check
A0–A15: 15/15 anchored; B1–B11: 11/11 anchored; C1/C2/C3/C4: all rows/exports/rules anchored;
D1/D2/D3/D4: frozen; E-P2…E-P8 carry-forward: materialized with evidence; conflicts: 5 minor,
0 blocking; invariants: 19/19 conformed to E-P0 evidence; deferred: fully separated; Layer-C:
documented. Map: 100% of A/B mapped to real anchors ⇒ E-P1 exit criterion met.

### 13.3 Verdict

> **E-P1 PASS — DOCUMENTATION RECONCILED**
>
> Every spec UX area (A0–A15), flow (B1–B11), state-model element (C1–C4) and component
> (D1–D4) maps to real code and existing tests. The Component Map is frozen. No blocking
> spec-vs-implementation contradiction exists; the five minor copy deltas are E-P2's
> designated work. Deferred work is separated from missing work; nenhum missing item exists.
> Zero product-source files changed during E-P1 (byte-identical 115-file SHA-256 manifest).
> E-P1 may close; E-P2 (copy + labels pass) may begin only with explicit authorization.