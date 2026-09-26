# STEP26 — V2 Discovery Intelligence & Smart Sample Discovery — Implementation Report

## 1. Verdict

**STEP26 PASS**

## 2. Scope

STEP26 delivers the "Find a sound" smart-discovery surface: an orchestration
layer (`discoverSamples`) over the *frozen* text search, the shared Sound Space
character filter, and the *frozen* `rankSimilar` acoustic ranker. It adds a
session-local discovery model + actions, a dedicated render surface, Sound
Space point highlighting (visual only — coordinates never move), unit/app/e2e
tests, and a scale benchmark. Discovery only *reads* the existing systems:
no new search, no DSP, no ML/embeddings/LLM/ANN/clustering, no persistence of
query/reference/results/highlights, no auto-analysis, and no change to any
V1/V2 algorithm.

## 3. Baseline

| Check | Before (STEP25 end) | After (STEP26) |
| --- | --- | --- |
| `npm run typecheck` | 0 errors | 0 errors |
| App unit tests (`npm test`) | 946 passed | **984 passed** (+38: 22 core + 15 app-level + 1 perf) |
| Global worker tests (`workers/d1-worker`) | 19 passed | 19 passed |
| Playwright E2E (`npx playwright test`) | 118 passed | **133 passed** (+15 STEP26) |
| `npm run build` | PASS | PASS (pre-existing chunk-size warning only) |
| Discovery core bench (in-process) | — | 12.5 ms worst @ 10k records (§24) |

## 4. Changed Files

| File | Change | Reason | Evidence |
| --- | --- | --- | --- |
| `src/analysis/discovery.ts` | NEW — `discoverSamples`, `DiscoveryQuery`, `DiscoveryResultRow`, reason types/labels, `sanitizeDiscoveryLimit`, `hasDiscoveryCriterion`, `DISCOVERY_ALGORITHM_VERSION = "1.0.0"`, `DISCOVERY_DEFAULT_LIMIT = 10`, `DISCOVERY_MAX_LIMIT = 100`, `DISCOVERY_WEIGHTS` | Pure orchestration core over the three frozen sources | REAL |
| `src/analysis/discovery.test.ts` | NEW — 22 unit tests (D01..D18 numbering, incl. tie-break) | Core semantics: single-source, composition, gating, determinism, limits, needle-stack | REAL + CONSTRUCTED |
| `src/analysis/discovery.bench.test.ts` | NEW — 100/500/1k/5k/10k × 4 modes on a seeded pool | §54 scale evidence | CONSTRUCTED |
| `src/ui/app.ts` | EDIT — `DiscoveryStatus`, `DiscoveryRowView`, `DiscoveryState`, `emptyDiscoveryState()`, `discovery` + `discoveryTextDraft` fields; `openDiscovery`/`closeDiscovery`/`setDiscoveryTextDraft`/`useFocusedSampleAsReference`/`clearDiscoveryReference`/`runDiscovery`; `discoveryHighlightedSampleIds` getter | Discovery state model + actions, result registry | REAL |
| `src/ui/view.ts` | EDIT — `discoveryStatusText`, `discoveryScoreLabel`, `discoveryReasonSummary`, `DiscoveryStatusShape` | Exact-surface copy as testable view-models | REAL |
| `src/ui/render.ts` | EDIT — `renderDiscoveryPanel` (query row, run button, reference row, status, results list) in mapRegion; `.sound-space-point-discovery` highlight on existing points | STEP26 surface | REAL |
| `src/ui/samplemap.css` | EDIT — `.discovery-*` + `.sound-space-point-discovery` token block | Visual grammar reusing existing tokens | — |
| `src/ui/step26.discovery.test.ts` | NEW — 15 app-level tests | State/actions, read-only guarantees, highlight set, exact copy | REAL + FIXTURE |
| `e2e/step26.spec.ts` | NEW — 15 E2E scenarios (E26-01..E26-15) | End-to-end proof against the offline harness | FIXTURE |
| `e2e/artifacts/step26-surface-idle.png`, `step26-text-only.png`, `step26-highlight.png` | NEW | Visual evidence | FIXTURE |
| `STEP26_IMPLEMENTATION_REPORT.md` | NEW — this report | — | — |

No V1 file was touched: `src/pipeline/*`, `src/classify/*`, `src/similarity/*`,
`src/search/*`, `src/map/*`, `src/preview/*`, `src/machiniste/*`,
`src/global/*`, `workers/d1-worker/*` unchanged. Frozen V2 algorithmics
(`soundCharacter.ts`, `sampleAnalysisV2.ts`, `similarityRanking.ts`,
`soundSpaceFilter.ts`, `searchEngine.ts`, `soundSpaceProjector.ts`,
`audioFeaturesV2.ts`, `v2Fixtures.ts`, `map-v2/*`) are consumed by import only.

## 5. Core Boundary (§30–§34)

`src/analysis/discovery.ts` is a deterministic, side-effect-free pure core:

```ts
discoverSamples(
  query: DiscoveryQuery,                // { text?, characterFilter?, referenceSampleId?, limit? }
  records: readonly SampleIndexRecord[],
  options: DiscoveryRunOptions,         // { search: SearchEngine }
): Promise<DiscoveryResultRow[]>
```

It never calls `index.put`, never mutates records/filter/query, never persists
anything, and never invents data. An inactive source contributes nothing: with
no text, no active filter, and no reference the module returns `[]` — the app
shows the honest "Find a sound" idle state instead of a fabricated browse
order.

### §51 acceptance list (mapped)

| Requirement | Where | Status |
| --- | --- | --- |
| Discover is read-only over search/filter/rank | §5–§8, §21 | PASS |
| Text source matches the frozen SearchEngine | §6 | PASS |
| Character source = shared Sound Space filter snapshot | §7 | PASS |
| Reference source = frozen `rankSimilar`, self excluded | §8 | PASS |
| Text AND filter = intersection; reference ranks the intersection | §9 | PASS |
| Weighted combined score in [0,1], labeled `Match`, rounded 4dp | §9 | PASS |
| Dedup by sampleId, first-wins; only `analyzed` records | §10 | PASS |
| Deterministic order: score DESC then sampleId ASC | §11 | PASS |
| Limit default 10, max 100, always honored | §11 | PASS |
| Honest empty/error copy, never invented results | §12 | PASS |
| Reference pinning is id-only and clearable | §14 | PASS |
| Session-local, nothing persisted (§45–§46) | §15 | PASS |
| Result rows re-use focus/preview/selection continuity | §16 | PASS |
| Highlight never moves coordinates (§40) | §19 | PASS |
| No auto-analysis, no ML/DSP additions | §22 | PASS |
| Scale to 10k under threshold (§54) | §24 | PASS |

## 6. Text Source (SearchEngine)

Text queries run through the *frozen* `options.search.search({ text,
statuses: ["analyzed"] })`; Discovery keeps only hits whose `sampleId` is in
the caller-supplied pool (the pool, not the engine's store, is authoritative
for membership). Every matched row carries a `text-match` reason whose score is
the frozen engine's search score, verbatim. Evidence: D02, D06, app-level
text-only test, E26-02/E26-03.

## 7. Character Source (shared Sound Space filter)

The filter object passed in `query.characterFilter` is literally
`app.soundSpaceFilter` — the same snapshot the Sound Space surface filters by.
Discovery classifies candidates with the frozen `recordMatchesFilter`
(`soundSpaceFilter.ts`, consumed read-only); every pass gains a
`character-match` reason with score 1. Evidence: D03 accepts the exact
predicate output, E26-05 reuses the DOM-set tonality range and reproduces the
same 3-of-4 set as the Sound Space panel, app-level test asserts predicate
equality per record.

## 8. Reference Source (rankSimilar)

`referenceSampleId` is resolved against the pool (fallback: `knownRecords`),
gated through `resolveQueryCharacter` (a `null`/missing character is
unrankable), then `rankSimilar(refRecord, candidates, { limit: candidates.size,
includeSelf: false })`. Only full-V2, analyzed records appear; the reference
itself is excluded. Every ranked row carries a `similar-to-reference` reason
whose score is the frozen similarity plus `distance` and `sharedDimensionCount`
when present. Evidence: D04/D04b/D08/D12–D13, E26-07 asserts the discovery rows
equal `__sm.v2.rank` output and never contain the reference.

## 9. Composition & Scoring (§34–§36)

- Text ∧ filter: the intersection of the search hit-set and the
  predicate-passing set — a row needs *both* sources.
- Reference ∧ text/filter: reference *ranks the active candidates* (the
  intersection), so `hat` + reference `lead-ohm` yields only `hat-airy`.
- Reference only (no text/filter): ranks the full analyzed pool.
- Score is the **weighted mean of the activated sources** only —
  `DISCOVERY_WEIGHTS = { text: 0.35, character: 0.2, similarity: 0.45 }`
  renormalized over the active set, `rounded` to 4 decimal places, in [0,1].
- Final order: score DESC, then sampleId ASC (ASCII) — byte-for-byte
  reproducible. Evidence: D05–D07, D17, D11 (identical + shuffled input),
  app-level triple-composition test, E26-06/E26-08.

## 10. Pool Gating, Deduplication & Self-Exclusion

- Only `status === "analyzed"` records join the pool.
- Dedupe by `sampleId`, first-wins (even if a duplicate has a non-null
  character, the first pool entry keeps scoring authority).
- The reference sample is always excluded from its own results.
- V1-only records are searchable and filter-failing, but never rankable;
  a reference-only run whose reference is V1-only yields the honest
  "Select a sample to use as a reference." empty state — never an invented
  order. Evidence: D-12, D-13, D-14, app-level + E26-13.

## 11. Limits, Empty & Honest States

`limit` sanitized via `sanitizeDiscoveryLimit`: absent → `DISCOVERY_DEFAULT_LIMIT`
(10); clamped to `[1, DISCOVERY_MAX_LIMIT]` (100); applied after sort. Empty
states never render a fake row: the app shows "No matching sounds found." (no
criterion matched), the dedicated reference copy, or (index missing) "Local
sample index unavailable." — each with a `role` status/alert and no list.
Evidence: D10, D14, app-level idle/empty/error tests, E26-04.

## 12. Determinism (§37)

Same criteria + same index → identical rule results every time: sorting is
total (score DESC, sampleId ASC), reference ranking is the deterministic frozen
ranker, text/filter are deterministic frozen predicates. Proven by D11 (two
feeds, one shuffled) and the app-level re-run snapshot equality; E26-09
re-runs the same reference criteria and observes the identical row set.

## 13. App State & Actions (§39)

`SampleMapApp` gains `discovery: DiscoveryState` (`{ open, status,
referenceSampleId, results, error }`) plus `discoveryTextDraft`. Status is a
closed union `idle | running | ready | empty | error`:

- `openDiscovery()` opens and re-runs; `closeDiscovery()` closes.
- `setDiscoveryTextDraft(text)` updates the *un-submitted* draft — nothing
  runs until the explicit run action (typists never pay a per-keystroke cost).
- `runDiscovery()`: no criterion → `idle`; index missing → `error`;
  reference-only with an unavailable reference → `empty` + reference copy;
  otherwise `ready`/`empty` from the core result.
- `discoveryHighlightedSampleIds` getter — `open && ready` → the result ids;
  else empty. Read-only, snapshot-derived.

## 14. Reference Pinning

`useFocusedSampleAsReference()` stores only `focusedSampleId` (never a record
copy), is stable until `clearDiscoveryReference()`, and neither action touches
focus, selection, or the batch. `clearDiscoveryReference()` sets exactly the
`referenceSampleId` field back to `undefined`. With nothing focused, the former
reports the reference empty state. Evidence: app-level pinning test (focus/
selection asserted unchanged), E26-10/E26-11.

## 15. Session Locality & No Persistence (§45–§46)

Discovery state lives only on the app instance: criteria, reference, results
and highlights are gone on reload; nothing touches URL/localStorage/IndexedDB
beyond the *read* of the existing index. `runDiscovery` never writes the index
(asserted: index byte-identical around a run). E26-14 re-seeds a fresh page and
asserts open=false, empty draft, no reference; E26-12 asserts index + results
immutability.

## 16. Result Registry & Interaction Continuity

Result rows are resolved to `SampleIndexRecord`s and registered into the
existing `knownRecords` map, so a discovery result is focusable, selectable,
and previewable through the *canonical* paths even when it is not in the global
search results — no hard filter change, no V1 selection logic touched. Preview
routes via `togglePreviewById`, name click via `selectSample`. Evidence:
app-level focus integration test, E26-02 focus routing.

## 17. View Models

- `discoveryStatusText(state)` — exact copy: idle `Find a sound`, running
  `Finding sounds…`, ready-empty `No matching sounds found.`, empty uses its
  stored error (reference copy) or the default, error uses its message or
  `Local sample index unavailable.`
- `discoveryScoreLabel(score)` — `Match <pct>%` with the percentage clamped to
  0–100.
- `discoveryReasonSummary(reasons)` — labels joined with `" · "`, falling back
  to `Match` for an empty list.

## 18. Render Surface ("Find a sound")

`renderDiscoveryPanel` renders in mapRegion (between the map and Sound Space):
header toggle (`discovery-toggle`), query row with the text input
(`discovery-text`, placeholder "Describe the sound, e.g. dark kick…") and run
button (`discovery-run`, "Find sounds", Enter submits), reference row
(`discovery-use-reference` "Use focused sample" — disabled with nothing
focused; `discovery-clear-reference` when a reference is set; label
`Reference: <name>` / `No reference set`), a status line, and the results list
with per-row preview/name/score/reasons controls. Draft and filter edits never
re-run discovery — run is explicit.

## 19. Sound Space Highlight (§40)

When discovery is `ready`, points whose `sampleId` is in
`discoveryHighlightedSampleIds` receive the `.sound-space-point-discovery`
class (stroke/brightness styling only). The projector coordinates are frozen:
the highlight is a visual overlay on the existing circles and nothing computes
a new position — E26-09 snapshots every point's `cx`/`cy` before and after a
reference run and asserts the DOM is unchanged.

## 20. Accessibility & Keyboard (§41)

- Draft input has `aria-label` "Discovery search terms"; Enter runs discovery.
- Status line carries `role` (`alert` for error, `status` otherwise) and
  `aria-live="polite"`.
- The toggle/buttons use `aria-label`; the reference pin uses the focused
  sample (keyboard-reachable via `Enter`/`Space` on Sound Space points).
- Preview/name buttons label their targets from the record name.

## 21. Non-Mutation Guarantees (§44)

Discovery runs never change: the index, the global `results`, `focusedSampleId`,
`selectedSampleIds`, `soundSpaceFilter`, or Sound Space points/coordinates.
App-level tests assert each of these around successful runs; E26-12/E26-09
prove it end-to-end.

## 22. Versioning & Freeze Compliance

`DISCOVERY_ALGORITHM_VERSION = "1.0.0"` pins the new orchestration layer; the
three consumed systems are imported read-only and remain untouched at their
frozen versions. No auto-analysis is triggered by discovery; there are no new
dependencies.

## 23. E2E (§50)

`e2e/step26.spec.ts` — 15 scenarios, all PASS (shared serial page):

| # | Scenario | Result |
| --- | --- | --- |
| E26-01 | idle surface: closed by default, "Find a sound", no invented rows | PASS |
| E26-02 | text-only `kick` → single row, score + reason, name routes focus | PASS |
| E26-03 | keyboard Enter on the draft runs discovery | PASS |
| E26-04 | honest empty "No matching sounds found.", no stale rows/highlights | PASS |
| E26-05 | character-only reuses the shared Sound Space filter (tonality ≥ 0.9 → 3 of 4) | PASS |
| E26-06 | text ∩ filter intersection: only the kick survives | PASS |
| E26-07 | reference-only from the focused sample = `__sm.v2.rank`, self excluded | PASS |
| E26-08 | text + reference compose into "Matches search · Similar" | PASS |
| E26-09 | highlight adds the class WITHOUT moving coordinates | PASS |
| E26-10 | "Use focused sample" disabled/enabled by focus state | PASS |
| E26-11 | Clear reference touches ONLY the reference (focus + selection intact) | PASS |
| E26-12 | runs never mutate the global search results | PASS |
| E26-13 | V1-only reference → "Select a sample to use as a reference." | PASS |
| E26-14 | reload + fresh mount drops all criteria (session-local) | PASS |
| E26-15 | console audit: no unexpected errors across STEP26 | PASS |

## 24. Performance (§54)

In-process core bench over a seeded pool (3 samples/source × n; modes
text-only / filter-only / reference-only / text+filter+reference; warm run,
ms/run), bound asserted < 5 s at 10k:

| n | textOnly ms | filterOnly ms | referenceOnly ms | combined ms |
| --- | --- | --- | --- | --- |
| 100 | 0.4 | < 0.05 | 0.5 | 0.1 |
| 500 | 0.1 | < 0.05 | 1.1 | 0.2 |
| 1,000 | 0.2 | < 0.05 | 1.7 | 0.4 |
| 5,000 | 2.6 | < 0.05 | 7.4 | 1.5 |
| 10,000 | 3.9 | < 0.05 | 12.5 | 3.5 |

The core is O(pool) for text/filter (single linear pass each) plus one
deterministic `rankSimilar` over the candidate set — no pairwise audio, no
DSP, no ML. The app-level suite and the 10k unit smoke (41 ms for the whole
suite) sit comfortably inside the envelope; the browser projection cost is
STEP24's, unchanged.

## 25. Regression

- `npm run typecheck` — 0 errors.
- `npm test` — 984/984 (58 files; 946 baseline + 22 core + 15 app-level + 1 perf).
- `workers/d1-worker` — typecheck clean, 19/19 unchanged.
- `npx playwright test` — 133/133 (118 baseline + 15 STEP26).
- `npm run build` — PASS (pre-existing chunk-size warning only).

## 26. Evidence Classification

- **REAL** — the `discoverSamples` orchestration, app state/actions, reference
  pinning, view-models, render surface, highlight wiring, non-mutation
  assertions, console audit, exact copy strings.
- **FIXTURE** — all four fixture V2 characters (kick-909, hat-airy, bass-sub,
  lead-ohm) via `__sm.v2.attach`/`analyzeCorpus`; every E26 scenario; app-level
  tests over the FIXTURE corpus (tonality 0.9330/0.1199/0.9993/0.9976 drive the
  3-of-4 filter and rank assertions).
- **CONSTRUCTED** — discovery unit-test records (D01–D18), the multi-V1 /
  partial-V2 / null-dim constructs, and the seeded 100..10k bench pools.
- **BLOCKED / NOT TESTED** — live Audiotool browsing of a large V2 corpus
  (Layer-C scope); recorded playback of previews for synthetic samples
  (standing §16 finding).

## 27. Final Verdict & Recommended Next Step

STEP26 delivers Smart Sample Discovery as a pure, deterministic, read-only
orchestration over the three frozen sources:
- 22/22 core tests, 15/15 app-level tests, 15/15 E2E, 0 typecheck errors, and
  984/984 / 133/133 / 19/19 regression lanes green, build PASS.
- Reference pinning is id-only and clearable without ever touching
  focus/selection/batch; nothing is persisted.
- Sound Space highlighting is strictly visual — coordinates provably immobile.
- 12.5 ms worst case at 10k records with an honest, never-invented idle/empty/
  reference surface.

Recommended next step: hold STEP26 as the discovery floor — any future work
belongs to STEP27 and must be a separately-scoped step. Do not modify the
frozen search/filter/rank systems as part of STEP27 planning.