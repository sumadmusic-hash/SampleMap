# STEP16R E-P5A Implementation Report — Presentation, Accessibility & Responsive Hardening

**Verdict:** `E-P5A PASS — PRESENTATION / A11Y / RESPONSIVE HARDENING COMPLETE`
**T1 status:** `BLOCKED — THRESHOLD OWNERSHIP NOT FOUND` (see §8)

## 1. Verdict

`E-P5A PASS — PRESENTATION / A11Y / RESPONSIVE HARDENING COMPLETE`

E-P0..E-P4 stayed frozen and untouched. This epoch delivered the E-P5A slice of
STEP16R: explicit classification-disclaimer and map-position tooltip copy (T2),
live-region announcement of scan/analysis/action status (T3), keyboard point
navigation on the map that never mutates selection and never fires from inside
form controls (T4), plus dedicated 768–1023px responsive e2e coverage and the
optional gesture-cut-of-scope camera-safety e2e (T5/T6). T1 (low-confidence
visual ring) remains explicitly BLOCKED pending a Product/Classifier threshold
ownership decision — see §8.

All automated, build, type and live verification gates pass:

| Gate | Result |
|---|---|
| `tsc --noEmit` (app) | 0 errors |
| `vitest run` (app) | 594/594 (32 files; `app.test.ts` 57 → 62, +5 new) |
| `tsc --noEmit` (workers/d1-worker) | 0 errors |
| `vitest run` (workers/d1-worker) | 19/19 |
| `npm run build` | PASS (pre-existing >500 kB chunk advisory only) |
| Playwright full e2e | 43/43 (34 frozen + 9 new across 3 specs) |

## 2. Changed files

| File | Change | Manifest-tracked |
|---|---|---|
| `src/ui/app.ts` | New controller method `focusAdjacent(delta)` for arrow-key point navigation (T4) | yes |
| `src/ui/render.ts` | T2 classification disclaimer ×2; T3 `role=status`/`aria-live=polite` ×3; T4 `onKeyDown` arrow branch gated on the map element + form-control guard; drawer-open state carried across re-renders (T5) | yes |
| `src/ui/map/mapRender.ts` | svg `tabindex="0"`; `.map-tooltip-note` in `showTooltip` (T2) | yes |
| `src/ui/app.test.ts` | +5 unit tests: `SampleMap UI : arrow-key point navigation (E-P5A T4)` | yes |
| `src/ui/samplemap.css` | `.map-tooltip-note`, `.inspector-classification-note`, `.sample-map-svg:focus-visible`; 768–1023 header-search shrink (T5 bugfix) | no (by design) |
| `e2e/ep5-a11y.spec.ts` | NEW — EP5A-01..04 | yes (new path) |
| `e2e/ep5-responsive.spec.ts` | NEW — EP5A-05..08 | yes (new path) |
| `e2e/ep5-gesture.spec.ts` | NEW — EP5A-09 | yes (new path) |

The path-set diff vs the E-P4 baseline is exactly the three new `e2e/ep5-*.spec.ts`
paths; the content diff is exactly the four tracked files above. The final
`src/ui/samplemap.css` change is documented here exactly as with E-P4
(CSS is not part of the frozen manifest scope). No frozen domain file changed —
`src/persistence/*`, `src/map/mapPosition.ts`, `src/classify/*`, `src/global/*`
and all other invariants' implementation files have identical sha256 hashes.

## 3. T2 — Classification & position disclaimer copy

Two helper notes were added; both are pure presentation (`aria-hidden` not set —
the copy is meaningful to a screen-reader user):

- **Inspector classification note** — `Classification is an estimate, not a
  ground truth.` rendered in `.inspector-classification-note` immediately after
  the classification block in both the local inspector
  (`renderDetailPanel`) and the global inspection panel
  (`renderGlobalInspection`). It sits INSIDE the classification section and is
  never fused into the tags section (INV-2: a unit-visible assertion in
  `ep5-a11y.spec.ts` EP5A-01 confirms the tags list never contains `estimate`).
- **Map tooltip note** — `Position is an impression of timbre, not a precise
  acoustic measurement.` rendered in `.map-tooltip-note` at the foot of the
  hover tooltip (map `showTooltip`).

Both are covered end-to-end in EP5A-01.
Copy strings are exact per the E-P5A directive; they are text-only with no
adjustable threshold, so they carry **no** T1 implication.

## 4. T3 — ARIA live regions

Three status regions now announce on update via `role="status"` +
`aria-live="polite"`:

| Region | testid / role | Content |
|---|---|---|
| Scan | `scan-status` (`role=status`) | library scan status/progress |
| Analysis | `analysis-status` (`role=status`) | queue budget / analyzed / failed |
| Actions | `action-status` (`role=status`) | send / filter / selection-feedback summary |

The pre-existing status region at `render.ts` (~`send-status`) already carried a
`role`; it is left byte-for-byte unchanged (frozen E-P1 scope). EP5A-02 asserts
the three `role=status` regions exist with `aria-live="polite"`.

## 5. T4 — Keyboard point navigation

Controller semantics (`app.focusAdjacent(delta: 1 | -1)`):

- Moves `focusedSampleId` along the current filtered `results` order only;
- never opens/clears batch selection. `selectedSampleIds` is asserted unchanged
  after every arrow step (both unit + e2e);
- enters the first/last result from no focus; wraps at the ends;
- no-ops on empty filtered results.

Keydown wiring (`render.ts` omega `onKeyDown`):

- Arrow keys move focus **only** when the event target is inside
  `.sample-map-svg` (the svg now also carries `tabindex="0"`, keeping
  `role=application` + aria-label);
- `INPUT`/`SELECT`/`TEXTAREA` targets short-circuit arrows (verified in
  EP5A-03 by typing arrows in the global search, and EP5A-04 via a non-map
  button);
- `Escape` (blur + close drawers + `clearSelection`), `Cmd/Ctrl+F`, and
  `Cmd/Ctrl+0` still work **globally**, including while a form control is
  focused — the arrow guard no longer swallows the frozen shortcuts (this was
  caught by EP5A-04 during development and is asserted there);
- re-render preserves keyboard focus on the map application region so a
  sequence of arrow presses stays continuous.

## 6. T5 — Responsive (768–1023) coverage

`e2e/ep5-responsive.spec.ts` is an isolated spec: it creates its own page with
a 768×1024 viewport and re-checks the 1023/1024 boundary via `setViewportSize`.
The GLOBAL `playwright.config.ts` is untouched.

EP5A-05 Drawer chrome at 768: one-column grid, filter rail → left overlay
drawer (`position:fixed`, x≈0), inspector → bottom drawer, no horizontal
overflow.
EP5A-06 Drawer behavior: drawer toggles + Esc close; filters usable inside the
drawer; Esc clears **selection** (intended §V1 semantics, consistent with
`final-ui-phase1.spec.ts`) while leaving filters/search intact; `Clear filters`
restores the full set.
EP5A-07 Selection/filter invariants at 768: hiding filter preserves
`selectedSampleIds` + `focusedSampleId`; inspector bottom drawer opens over the
map row; cleared filter restores the hidden sample still selected.
EP5A-08 Boundary: 1023px still drawer mode, 1024px negative control re-checks
3-column layout + no overflow.

### Two real bugs fixed by T5

1. **Header horizontal overflow at 768–1023 (~28px).** `.header-actions`
   extended past `document.documentElement.clientWidth`. Fixed by letting
   `.header-search` flex-shrink (`min-width: 0; max-width: 360px; margin: 0`)
   inside the 768–1023 media block.
2. **Re-render silently closed open drawers at 768–1023.** `renderApp`
   rebuilt `.app-shell` with a pristine className (`app-shell`), dropping
   `filter-open`/`inspector-open` on every state change — so changing a filter
   inside the drawer closed it mid-interaction. `renderApp` now captures the
   previous shell's drawer flags and reapplies them on the rebuilt shell
   (exercised by EP5A-06/07).

## 7. T6 — Gesture safety (optional, covered)

EP5A-09 drives a real wheel-zoom and drag-pan on the empty map surface and
asserts only the runtime camera changes. It snapshots `<circle> cx/cy`,
persisted `mapPosition` records, `selectedSampleIds`, `focusedSampleId`, and
the rendered point count before/after and asserts they are byte-identical.
Camera preconditions discovered during development and asserted in the spec:
at zoom 1 the map exactly fills the viewport so `clampPan` pins pan to (0,0) —
the test zooms in first, then drags up-left (which yields negative, clampable
pan). Focus/selection are seeded through the harness (see §9, fixture-geometry
notes) and survive every gesture.

## 8. T1 — BLOCKED (threshold ownership decision)

`T1 — LOW-CONFIDENCE VISUAL RING` is **NOT implemented** and is marked

    BLOCKED — THRESHOLD OWNERSHIP NOT FOUND

- The prior **threshold ownership investigation** (delivered before E-P5A)
  found no confidence flag/threshold anywhere in the product, classifier, or
  persistence layers — confidence is a softmax probability over the top-5,
  compared against T=0.5, with `primaryClass + secondary = 1.0` and
  `round4`, and a `lowConfidence` UI-flag is explicitly absent.
- Per the E-P5A directive, **no** confidence threshold, classifier rule,
  persistence field, or UI-side calculation was invented as a workaround.
- **Decision note (frozen protocol):** T1 requires a future
  `Product / Classifier Threshold Ownership Decision`, i.e. who owns the
  low-confidence threshold (Product, Classifier, or a data pipeline contract),
  what its value/semantics are, and whether it should be a versioned
  classifier-time flag (`lowConfidence`) stored on the analysis result
  (V2-`mapPosition` pattern) rather than a UI-side comparison.
- **E-P5A reaches PASS independently of T1.** T1 is tracked as blocked, not
  filed as an E-P5A defect.

## 9. Fixture-geometry note (harness)

The offline fixture's V2 `mapPosition` values are degenerate at default zoom:
`kick-909` and `bass-sub` share the exact bottom-right SVG corner pixel
(x=800, y=520), `lead-ohm` sits on the right edge, `hat-airy` on the top edge —
so a `boundingBox()`-centre map click misses (verified by probe: the click
points were rendered over the corner → focus/hover can't land). The E-P5A specs
therefore seed focus/selection through the harness (`__sm.selectSample` /
`toggleMultiSelect`) and hover only interior points; EP4-style point-click
coverage remains in EP4. This is a **fixture artifact**, not a product defect —
real samples occupy interior map coordinates.

## 10. Invariants & frozen scope confirmation

- Frozen suite regression: all 34 pre-existing Playwright tests still pass
  (full run 43/43), including `step16m.spec.ts` (23 checks), `final-ui-phase1`,
  `ep2/ep3/ep4`.
- Manifest vs `ep4-after.txt` (118 paths): path-set delta = exactly
  `+3` new e2e specs; content delta = `src/ui/app.ts`, `src/ui/render.ts`,
  `src/ui/map/mapRender.ts`, `src/ui/app.test.ts`; `src/ui/samplemap.css`
  changes documented (CSS outside manifest scope by protocol).
- No frozen/domain file changed; selection/filter/camera/position invariants
  re-verified by the full unit + e2e runs above (16I/16M suites green).