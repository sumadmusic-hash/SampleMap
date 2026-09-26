# FINAL UI/UX — Phase 1 Implementation Report (Shell / Action Bar / First-Use)

Implements the **Phase 1 UI foundation** of the frozen `FINAL_UI_UX_DESIGN_SPEC.md`
v1.1 on the hardened SampleMap codebase. Design authority: `FINAL_UI_UX_DESIGN_SPEC.md`
(design-only). No frozen core module was modified or recomputed by the UI.

## CHANGED FILES

| File | Change |
|---|---|
| `src/ui/samplemap.css` | **NEW.** Single styling surface for the app (design tokens §5, shell §6, point states §5.4/§8.2, responsive §27, z-index §34.7, reduced-motion). |
| `src/ui/render.ts` | Shell restructure: `.app-shell` (sticky header with brand + **global search** + actions, 3-column `.app-content`, sticky `.action-bar` with status + selection pill + Add CTA), first-use overlay, focus-preserving re-render, document keyboard shortcuts (Esc / ⌘/Ctrl+F / ⌘/Ctrl+0), `import "./samplemap.css"`. |
| `src/ui/view.ts` | New pure projections: `selectionCountLabel` (0/1/`(max)`/N), `selectionPillLabel` (clamped `N / 8`), `shouldShowFirstUse`. |
| `src/ui/app.ts` | `clearSelection()` — clears **only** the batch selection (focus, preview, search, filters deliberately untouched; §17.5 / §28.1). |
| `src/ui/map/mapRender.ts` | Added `selectedSampleIds?: readonly string[]` option → `map-point-in-selection` class, additive with the focused `map-point-selected` (§17.2). Post-audit §8.1 fix: radius now consumed from the pure `pointRadius` view-model (zoom-compensated). |
| `src/ui/map/mapView.ts` | Post-audit §8.1 fix: pure `pointRadius(zoom, emphasized)` = `max(4, 6/zoom)` (§8.1), focused/selected ×1.35 (§8.2). No position map/math touched. |
| `src/ui/map/mapView.test.ts` | Post-audit §8.1 regression tests: 5 new tests (base 6px, zoom compensation, 4px floor, ×1.35 emphasis, purity). |
| `index.html` | Inline app styles trimmed to login/console essentials; theme now owned by the CSS module. |
| `harness.html` | Inline styles trimmed to e2e-critical chrome (`.scan-*` / `.analysis-*` / `.machiniste-status` / `#harness-log`). |
| `src/e2e/harness/main.ts` | Eagerly materializes the offline Machiniste entity and exposes `__sm.machinisteId` (test-support only). |
| `src/ui/view.test.ts` | +1 describe: `selectionCountLabel` / `selectionPillLabel` (clamping, overshoot) / `shouldShowFirstUse` matrix. |
| `src/ui/app.test.ts` | +1 test: `clearSelection` clears selection only, preserving focus + search + filters; idempotent. |
| `e2e/final-ui-phase1.spec.ts` | **NEW.** 8 Phase-1 e2e tests (FP-01…FP-08). |

## UI FEATURES IMPLEMENTED

- **App shell (§6):** sticky dark header (brand dot + index status, **global search** that replaces the per-panel query, Refresh index, responsive drawer toggles), 3-column grid `240px | minmax(420px,1fr) | 320px` with filter rail / map-as-dominant / inspector rail, full-height `min-height:100vh`.
- **Action bar (§18):** persistent bottom bar — contextual status left; `N / 8` pill (`is-selected`/`is-maxed` states, exact copy `N selected (max)` at 8) + **Add to Machiniste** (reuses `app.sendToMachiniste`, disabled until selection > 0) right.
- **First-use state (§25):** map-overlay with canonical copy ("No analyzed samples yet." + "Connect Audiotool & start indexing" CTA → `app.startScan`); hidden once the scan leaves idle.
- **Selection presentation (§17.2):** batch-selected points get the `--selection` treatment independently of the focused point; the two classes are additive.
- **Point radius (§8.1, post-audit):** zoom-compensated `max(4, 6/zoom)` in base px so on-screen size stays stable; focused/batch-selected ×1.35. Pure presentation — V2 positions, map math and persistence untouched.
- **Keyboard (§17.1/§28.1):** `Esc` clears selection only (never search/filters) and closes drawers; `⌘/Ctrl+F` focuses search; `⌘/Ctrl+0` resets the camera.
- **Focus preservation:** text controls keep focus + caret across the full re-render on every keystroke.
- **Responsive foundation (§27):** `1024–1279` (220/300 side rails), `768–1023` (single column + filter/inspector drawers via shell state classes), `≤767` (out-of-V1 mobile notice), `prefers-reduced-motion`.

## CORE FILES TOUCHED

**None.** The frozen §16 surface was not modified: `src/map/*`, `src/audio/*`,
`src/classify/*`, `src/persistence/*`, `src/pipeline/*`, `src/machiniste/*`,
`src/global/*`, and the worker are untouched. Persisted V2 positions are consumed,
never recomputed; PreviewService/send/previewEpoch/hydrateGlobalSample version-gate
survive unchanged. `workers/d1-worker/dist/index.js` remains the known stale artifact
(untouched; not used as evidence — source `src/provider.ts` is clean).

## TESTS

- **Unit (vitest):** `576` passed (was `567`) — `+9` (3 view projections, 1 `clearSelection`, 5 §8.1 radius regression tests).
- **E2E (playwright, chrome, offline harness):** `28` passed (was `20`) — `+8` Phase-1 tests:
  FP-01 first-use overlay + idle bar, FP-02 CTA → scan → point cloud, FP-03 focus≠selection,
  FP-04/05 selection pill + in-selection point styling + counts, FP-06 action-bar Add batch send
  (accepted gate: real Machiniste refs, no audio), FP-07 Esc semantics (§28.1), FP-08 ⌘/Ctrl+0 camera reset.

## REGRESSION CHECK

1. `npx tsc --noEmit` — PASS.
2. `npx vitest run` — 576/576 (> 567 baseline) — PASS.
3. `npm run build` — PASS (vite, chunk-size warning only, pre-existing).
4. `npx playwright test` — 28/28 (> 20 baseline) — PASS.
5. V2 map math / `mapVersion = "map-v2"` — untouched; UI renders persisted positions only (FP-02/FP-07 coordinate + point-count checks pass).
6. focus ≠ selection — intact (unit "4. focus can differ from selection" + FP-03: plain click focuses, pill stays 0/8).
7. `MAX_BATCH_SLOTS = 8` cap — intact (unit "6. capped at MAX_BATCH_SLOTS" + FP-05 counts to 4/8; "(max)" copy covered by unit projection tests, not reachable with the 4 fixtures).
8. Preview / persistence / Machiniste / global / worker — untouched; harness changes are additive `__sm.machinisteId`; all 16M console-audit tests green.

## REMAINING UI WORK (honest)

Phase 1 delivered the shell; later phases of the spec remain visual/feature polish:

- **Structured filter panel (§13):** the filter rail still uses the compact control row (class/confidence/sort + Clear); the spec's grouped class controls and "Clear filters" link are not restyled.
- **Map point treatments (§8.5):** low-confidence inner ring, density-via-overlap/glow, and the §20.3 tooltip copy ("Classification is an estimate…") are **not** yet implemented — new math-free UI work only.
- **Responsive drawers (§27, 768–1023):** CSS + shell classes are in place but not e2e-verified (viewport not in the harness suite).
- **Search affordances:** live per-filter result counts / results-while-typing debounce not yet added (input re-renders per keystroke).
- **`(max)` pill styling** is exercised only via unit tests (fixture library has 4 samples; extend fixtures to 8+ to e2e it).
- Legacy step-16 panel copy ("Search / Filters", "Analysiert", "Verbleibend", "No samples match your filters.") still appears inside redesigned regions; a canonical-copy pass is pending.