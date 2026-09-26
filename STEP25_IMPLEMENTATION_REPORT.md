# STEP25 — V2 Sound Space Interaction, Filtering & Compare — Implementation Report

## 1. Verdict

**STEP25 PASS**

## 2. Scope

STEP25 extends the STEP24 Sound Space into an interactive analysis surface:
per-dimension value filters (min/max on all 8 SoundCharacter dims), a
visible-points count label, a cross-sample Compare table driven by the existing
selection (never mutating it), keyboard/hover semantics, and O(N)
filter-as-you-act. Filtering is a pure predicate on the frozen V2
`SoundCharacter` view-model; no audio, no DSP, no ML, no new dependencies, no
persistence, no V1/V2 algorithm change.

## 3. Baseline

| Check | Before (STEP24 end) | After (STEP25) |
| --- | --- | --- |
| `npm run typecheck` | 0 errors | 0 errors |
| App unit tests (`npm test`) | 908 passed | **946 passed** (+38: 17 filter + 21 STEP25) |
| Global worker tests (`workers/d1-worker`) | 19 passed | 19 passed |
| Playwright E2E (`npx playwright test`) | 96 passed | **118 passed** (+22 STEP25) |
| `npm run build` | PASS | PASS (pre-existing chunk-size warning only) |
| STEP25 scale bench (browser) | — | 66/72/118/153 ms @ 100/1k/5k/10k |

## 4. Changed Files

| File | Change | Reason | Evidence |
| --- | --- | --- | --- |
| `src/analysis/soundSpaceFilter.ts` | NEW — `filterByCharacter`, `rangeDim`, `matchesSoundCharacter`, `clearSoundSpaceFilter` primitive, `SOUND_SPACE_FILTER_VERSION = "1.0.0"` | Pure filter boundary over frozen SoundCharacter | REAL |
| `src/analysis/soundSpaceFilter.test.ts` | NEW — 17 unit tests (boundary, null-dim, AND composition, empty-range, versioning) | Filter guarantees | REAL + CONSTRUCTED |
| `src/ui/app.ts` | EDIT — `soundSpaceFilter`, `soundSpaceCompare` fields; `setSoundSpaceFilter()`, `clearSoundSpaceFilter()`, `openSoundSpaceCompare()` (≥2…≤4), `closeSoundSpaceCompare()`, `soundSpaceCompareCharacters` getter, `togglePreviewById()`, `findSimilarForId()` | Snapshot-state actions for filter + compare | REAL |
| `src/ui/view.ts` | EDIT — `soundSpaceFilterSummary`, `soundSpaceVisibleLabel`, `characterValueLabel`, `compareEntryLabel`, `COMPARE_MAX`, `soundSpaceHoverHint`, `soundSpacePointLabel`, `soundCharacterDimensionLabel`, `visibleSoundSpacePoints` | Testable view-models + filter helpers | REAL |
| `src/ui/render.ts` | EDIT — filter grid (2-col, min/max number inputs), visible-count line, Compare toggle + table render, mousedown-based selection for Cmd/Ctrl-click, `isCaretInputType` caret-restore guard | STEP25 UI surface | REAL |
| `src/ui/samplemap.css` | EDIT — `.sound-space-filter-*`, `.sound-space-compare-*`, `.sound-space-point-selected` (tokens only) | Visual grammar reusing existing tokens | — |
| `src/ui/step25.soundSpace.test.ts` | NEW — 21 app-level tests | Filter state/actions, compare semantics, snapshot inviolability | REAL + FIXTURE |
| `e2e/step25.spec.ts` | NEW — 22 E2E scenarios (E25-01..E25-22) | End-to-end proof against the offline harness | FIXTURE |
| `e2e/step24.spec.ts` | EDIT — E24-02 meta-line expectation updated to the STEP25 header format (`4 analyzed samples · All samples`) | Deliberate deviation (§16) | FIXTURE |
| `e2e/artifacts/step25-compare.png` | NEW — Compare panel on 4 fixture points | Visual evidence | FIXTURE |
| `e2e/artifacts/step25-compare-cap4.png` | NEW — 5 selected → cap 4 rows | Cap evidence | FIXTURE |
| `e2e/artifacts/step25-filter-10k.png` | NEW — filter strip over 10k points | Scale evidence | CONSTRUCTED |
| `STEP25_IMPLEMENTATION_REPORT.md` | NEW — this report | — | — |

No V1 file was touched: `src/pipeline/*`, `src/classify/*`, `src/similarity/*`,
`src/search/*`, `src/map/*`, `src/preview/*`, `src/machiniste/*`, `src/global/*`,
`workers/d1-worker/*` unchanged. Frozen V2 algorithmics (`soundCharacter.ts`,
`sampleAnalysisV2.ts`, `similarityEngine.ts`, `similarityRanking.ts`,
`mapProjector.ts`, `soundSpaceProjector.ts`, `audioFeaturesV2.ts`, `v2Fixtures.ts`,
`map-v2/*`) are read-only consumers; STEP25 composes them via imports only.

## 5. Filter Boundary

New explicit pure module next to the frozen V2 character model:

```ts
rangeDim(min, max): { min, max } | null          // both empty → null (inactive)
matchesSoundCharacter(c, filter): boolean        // AND of active dims; null c → false
filterByCharacter(records, filter): SampleAnalysisV2[]  // preserves order
matchesFilterState(filter): boolean              // any active range?
```

Rules (§6 of the STEP25 spec): each dim is `[min,max]` inclusive, default
0..1 inactive; a dim with `null` character value fails an active range (never
treated as 0); multiple dims compose by AND; Clear filters resets every range
to inactive. Filtering is a pure predicate — it never deletes, moves, or
mutates a point (§5: "filtering never deletes/moves points"), and the O(N)
pass is linear in the record count.

## 6. Filter Semantics

- Active min=0/max=1 is equivalent to inactive only when the full default
  range is present; every same-value pair (e.g. min=max=1) is a real
  equality filter.
- `matchesSoundCharacter` fails a `null` character (the "never 0" rule) rather
  than admitting it; the UI shows exactly the filtered set with no ghost rows.
- `clearSoundSpaceFilter()` sets all ranges to `{min:0, max:1}` and the
  visible-count line reads "All samples"; any other combination produces
  "N of M · D dims" via `soundSpaceVisibleLabel`/`soundSpaceFilterSummary`.
- Search and filter compose by AND: `app` re-derives `results` from the full
  index each refresh, then the render pass applies the character filter on top
  (`visibleSoundSpacePoints`). No new search engine was added (§33 stays frozen).

## 7. Search Integration

STEP25 composes with the existing `SearchEngine`/`refreshSearch` path without
touching it: search narrows `results` by the frozen token semantics (matches
`record.name`/tags), then filtering narrows the already-searched set.
Evidence: E25-15 drives search "Deep" (matches the `kick` fixture record name)
and confirms the map shows exactly the kick point, then clears the filter and
sees all four again — proving search-first/filter-second with no cross-engine
state.

## 8. Compare Surface

`openSoundSpaceCompare()` reads the *existing* selection (identity set built by
Ctrl/Cmd-click) and requires ≥2 selected samples or it keeps the panel closed;
the Compare toggle button reflects enabled/disabled state. The panel is a
`<table>` with one row per SoundCharacter dim (all 8, `characterValueLabel`,
null → `—`) and one column per compared sample, capped at
`COMPARE_MAX = 4` via `slice(0,4)` when 5+ are selected. Per-sample action
row: Focus (routes the inspector/focus state), Preview
(`togglePreviewById`, respects the standing "no preview url available"
gate), Find Similar (`findSimilarForId` → `openFindSimilarV2` with the
`rankSimilar` flipped ordering ↔ `__sm.v2.rank` identity mapping).

## 9. Selection, Cap & Non-Mutation

- Compare **never mutates selection**: opening/closing/refreshing the table
  does not deselect or reorder the selection set (E25-19 asserts the toggle for
  a held-out fifth point remains untouched).
- Cap applies at open time only; closing and reopening recomputes from the then-
  current selection deterministically.
- Additive semantics: Ctrl/Cmd-click toggles a point's membership; the toggle
  runs on `onmousedown` (not `click`) because macOS Chrome suppresses `click`
  for ctrl+left-click (context-menu gesture), and `oncontextmenu` is
  `preventDefault`-ed when `ctrlKey`. Plain clicks still focus.

## 10. Snapshot & Session Locality

The Sound Space remains snapshot-only and session-local (§39/§45/§46): open
builds a fresh `SoundSpaceState.recordsById` map, focus/filter/compare/preview
never re-project coordinates, close drops everything, and reopen re-projects
byte-identically. E25-13 asserts the round-tripped `[]`-slices of the
engine-state arrays are deep-equal and every point's `x`/`y` is unchanged, and
E25-20 reopens over the same fixture DOM after full hide/show.

## 11. UI Integration

`renderSoundSpacePanel` now draws, in order: header (count + visible label),
filter strip (per-dim min/max `<input type=number min=0 max=1 step=0.01>`, all
8 dims, 2-column grid), visible-count line, canvas/SVG (only visible points),
and — when the selection size permits — the Compare section below the map.
Inputs commit on `change` (Confirm/Blur), not per keystroke, so typing never
re-renders the map mid-edit; both-empty clears that dim. The compare toggle
reflects live selection size with a disabled tooltip at <2.

## 12. Keyboard & Hover Semantics

- Enter/Space on a focused point selects it via the same state transition as a
  click; focused points keep the `:focus-visible` ring (E25-17).
- Hover updates `soundSpaceHoverHint` text only — never selection, focus, or
  compare membership (E25-18 asserts the DOM state is untouched by hover).

## 13. Preview & Find-Similar Integration

Both reuse the existing inspector paths with zero V1 changes:
`togglePreviewById` routes through the preview bus and surfaces the honest
"no preview url available" for samples without recorded previews (asserted in
app tests); `findSimilarForId` focuses the sample then calls
`openFindSimilarV2`, whose `rankSimilar` first row equals the fixture's
`__sm.v2.rank` head for the same query id (E25-14 compares DOM
`similarity-v2-result-*` rows to the harness).

## 14. V1/V2 Freeze Compliance

Zero changes to: V1 map, `mapProjector`, V1 similarity/fingerprint, SearchEngine
semantics, pipeline, persistence schema, Machiniste, E-P7, auth, publish, d1
worker. The projector VERSION stays `"1.0.0"`; `soundSpaceFilter` gets its own
`"1.0.0"` because it is a new, separately-versioned consumer surface. Arrival/
destruction in the map never writes coordinates or touches `mapPosition`.

## 15. Console Audit

E25-22 (and E25-22's bench phase) closes the page with a console audit:
no window error events, no uncaught exceptions, no failed resource loads.
The caret-restore guard (`isCaretInputType`, §11 detail) exists precisely
because `setSelectionRange` throws on `type="number"` inputs during the global
focus-restore pass; STEP25 routes that pass away from non-caret controls, which
the app-level suite and the audit both exercise.

## 16. Deliberate Deviation: E24-02 Meta Line

STEP25 changed the Sound Space header meta to the two-part format
`soundSpaceCountLabel(n) · soundSpaceVisibleLabel(visible, total)` — e.g.
`4 analyzed samples · All samples`. This is a *presentation* change only
(computed via view-model functions; `soundSpaceCountLabel` itself is
unchanged and its unit tests still pass as-is), but `e2e/step24.spec.ts`
E24-02 asserted the exact old string, so its expectation was updated to the
new combined text. STEP24 logic, projection math, and coordinates are
untouched; this is the only STEP24 E2E edit and it is documented here per the
reporting contract.

## 17. E2E

`e2e/step25.spec.ts` — 22 scenarios, all PASS (shared serial page):

| # | Scenario | Result |
| --- | --- | --- |
| E25-01 | empty state: honest copy + disabled filter/compare chrome | PASS |
| E25-02 | fixture attach: 4 points, meta `4 analyzed samples · All samples` | PASS |
| E25-03 | 8-dim filter grid present, all dim labels | PASS |
| E25-04 | tonality ≥0.9 keeps kick/bass/lead (3 of 4), hat hidden | PASS |
| E25-05 | visible-count line `N of M` updates live | PASS |
| E25-06 | clear filters → all visible again | PASS |
| E25-07 | filter does not move/delete points (DOM coords stable) | PASS |
| E25-08 | Cmd/Ctrl-click toggles selection (`.sound-space-point-selected`) | PASS |
| E25-09 | focus via plain click + Enter/Space routes inspector | PASS |
| E25-10 | compare opens (2+), table grid + dim rows + per-sample columns | PASS |
| E25-11 | compare cell values 0..1 or `—` for null dims | PASS |
| E25-12 | compare toggle disabled at 0/1, enabled at 2+ | PASS |
| E25-13 | snapshot integrity: filter/focus/compare never re-project | PASS |
| E25-14 | Find Similar equals `__sm.v2.rank` rows for the query id | PASS |
| E25-15 | search "Deep" matches kick + filter composes | PASS |
| E25-16 | cap 4 at 5 selected (screenshot step25-compare-cap4.png) | PASS |
| E25-17 | keyboard Enter/Space selects, no mouse required | PASS |
| E25-18 | hover updates hint text, never selection/compare | PASS |
| E25-19 | 5th (uncapped) point stays selectable, selection non-mutating | PASS |
| E25-20 | close + reopen reprojects byte-identically | PASS |
| E25-21 | preview reaches existing path, no V1 regression | PASS |
| E25-22 | §54 scale bench 100..10,000 records + console audit | PASS |

## 18. Performance

Browser end-to-end (attach/put n synthetic records + filter pass + full app
re-render, E25-22 measured in-page):

| n | points | ms | visible |
| --- | --- | --- | --- |
| 100 | 104 | 66 | 46 |
| 1,000 | 1,004 | 72 | 523 |
| 5,000 | 5,004 | 118 | 2,520 |
| 10,000 | 10,004 | 153 | 5,069 |

The filter itself is a single linear predicate over the in-memory snapshot —
no pairwise work, no audio, no ranking — so the marginal cost of filtering is
contained inside the re-render; focus/filter/compare never trigger a
re-projection (O(N) once at open). At 10k the DOM still holds ≈10k circles and
remains within the verified envelope.

## 19. Regression

- `npm run typecheck` — 0 errors.
- `npm test` — 946/946 (886 STEP23 + 22 STEP24 + 17 filter + 21 STEP25).
- `workers/d1-worker` — 19/19 unchanged.
- `npx playwright test` — 118/118 (96 baseline + 22 STEP25).
- `npm run build` — PASS (pre-existing chunk-size warning only).

## 20. Evidence Classification

- **REAL** — filter/view-model wiring, state actions, compare non-mutation,
  keyboard/mousedown semantics, DOM assertions (cells, labels, visible counts,
  cap), caret-restore guard, console audit, STEP24 E2E expectation edit.
- **FIXTURE** — all four fixture V2 sample characters (kick-909, hat-airy,
  bass-sub, lead-ohm) and every E2E scenario via the deterministic offline
  harness (`analyzeCorpus`/`v2Fixture` demos; tonality 0.9330/0.1199/0.9993/
  0.9976, so a ≥0.9 tonality filter keeps exactly 3 of 4).
- **CONSTRUCTED** — §54 benchmark records (hash-knitted full characters) and
  the synthetic null-complexity/`ss-*` records for the `—` cell + 10k bench.
- **BLOCKED / NOT TESTED** — live Audiotool browsing of a large V2 corpus
  (Layer-C scope); recorded playback of previews for synthetic samples
  (mirrors the standing §16 finding).

## 21. Known Limitations

- Compare and filters are keyed off the same `SoundCharacter`; the honest
  `—` for null dims means the table can show a mix of values and gaps, which
  is deliberate (never synthesizes a value).
- The compare view is capped at 4 by the spec; with 5+ selections the held-out
  samples are invisible in the table (still selectable in the map).
- Filter inputs are per-keystroke-inert (commit on change), which by design
  favors large corpora over live typing feedback; a previously live slider came
  with per-keystroke re-render cost and was rejected at review.
- `slice(0,4)` ordering for the cap is selection-order, not character-similar —
  documented and deterministic, not sorted by distance.

## 22. Remaining External Limitations

- Live at-scale Audiotool corpus validation remains Layer-C; the offline
  harness is the verification floor and was not changed.
- The SVG scatter remains as-is past ~10k points; density/zoom remain deferred
  (STEP24's findings carry forward unchanged).
- Region/joint filtering (e.g. a 2D marquee in the scatter) is out of scope for
  STEP25, which delivers per-attribute ranges only.

## 23. Final Verdict

STEP25 delivers the interactive V2 surface:
- Pure, separately-versioned filter boundary with strict null/AND semantics.
- A replayable Compare table over the existing, never-mutated selection,
  capped at 4, with Focus/Preview/Find Similar continuity.
- Snapshot and session-locality held: filtering, focusing, and comparing never
  re-project, and close/reopen is byte-identical.
- 17/17 filter tests, 21/21 app-level tests, 22/22 E2E scenarios, 0 typecheck
  errors, and every regression lane green (946/946, 19/19, 118/118).
- Linear scaling confirmed to 10k records at 153 ms in-browser with a clean
  console audit.

## 24. Recommended Next Step

STEP25 — V2 Sound Space Interaction, Filtering & Compare