# STEP27 — V2 Sound Collections & Discovery Curation — Implementation Report

## 1. Verdict

STEP27 is **done**: a pure, session-local, user-curated Sound Collection layer
("My Sounds") is fully implemented, tested end-to-end, and regression-clean.
The collection is capped at **50**, duplicate-safe by sampleId identity,
insertion-ordered, explicitly user-controlled, and **never persisted**. Add
controls mount on Discovery, Search and the Sound Space and all share the same
pure boundary. Compare (≤4, collection order) and the honest arithmetic-mean
"Collection average" summary are derived and never mutate the collection, the
selection, focus or any frozen V1/V2 surface. Evidence is REAL/FIXTURE/
CONSTRUCTED per §44; nothing is blocked. STEP28 is **not** started.

## 2. Scope

- **In scope (STEP27):** the session-local collection boundary, its
  cross-source add surface, Compare, Select All, the honest character summary,
  stale-member handling, view/render/CSS surface, unit/app/e2e tests, perf
  bench, this 29-section report.
- **Out of scope (frozen):** V1 selection/preview/Machiniste/E-P7/persistence
  and all V2 algorithms (SoundCharacter, AudioFeaturesV2, V2 DSP,
  similarityEngine/ranking, soundSpaceProjector/Filter, discovery + score).
  STEP27 consumes them **read-only** (§5).

## 3. Baseline

- STEP26 frozen: typecheck 0 errors; app/core vitest **984/984**;
  d1-worker **19/19**; Playwright **133/133** (118 STEP25 + 15 STEP26);
  `npm run build` PASS; STEP26 report + CSS complete.

## 4. Changed Files

| File | Kind | What |
| --- | --- | --- |
| `src/analysis/collection.ts` | new | Pure boundary + summary (`COLLECTION_VERSION` `1.0.0`, `COLLECTION_MAX_SAMPLES` 50, add/remove/toggle/clear/contains/isFull, `summarizeCollection`, `collectionCharacterOf`). |
| `src/analysis/collection.test.ts` | new | Core unit tests C01..C17 + version pin (**18**) — all pure/constructed. |
| `src/analysis/collection.bench.test.ts` | new | Perf bench 10/50/100/500/1,000 with cap 50 (§31). |
| `src/ui/app.ts` | edit | `collection`/`collectionCompare`/`collectionKnownIds` state; add/remove/toggle/clear/open/close/compare/select actions; `collectionMembers`, `collectionSummary`, `collectionCompareCharacters` getters; `recordForSample`; refresh hook (§15). |
| `src/ui/view.ts` | edit | `COLLECTION_EMPTY_TEXT`, `COLLECTION_FULL_TEXT`, `COLLECTION_AVG_LABEL`, `COLLECTION_UNAVAILABLE_LABEL`, `collectionCounterLabel`, `collectionAddLabel`, `collectionSelectAllLabel`. |
| `src/ui/render.ts` | edit | Collection panel, Compare panel, per-source Add buttons (Discovery/Search/Sound-Space-focused), collection visual mark on Sound Space points. |
| `src/ui/samplemap.css` | edit | Collection panel + summary + collection mark styles. |
| `src/ui/step27.collection.test.ts` | new | App integration tests (**21**) against a REAL IndexedDB index + SearchEngine. |
| `e2e/step27.spec.ts` | new | E2E **E27-01..E27-23** (§36). |

## 5. Hard Freeze Compliance

No frozen product file was modified. `collection.ts`, `view.ts` additions and
the render/app additions reference V2 through the existing public exports only:
`SOUND_CHARACTER_DIMENSIONS` (config), `SoundCharacter` (with eight
`number | null` dims), `rankSimilar`, `visibleSoundSpacePoints`/projector,
`recordMatchesFilter`, `discovery` — all consumed read-only. V2 numeric output
is never recomputed or adjusted; coordinates stay frozen.

## 6. Collection Boundary (§4–§17)

`SoundCollectionState = { sampleIds: readonly string[]; open: boolean }`
(session-local only). `emptyCollectionState()` is the deterministic initial
state. Actions are pure and immutable: a real change returns a new state, a
no-op returns the same object (`Object.freeze` tested, C10):
- `addToCollection` — appends to the END; duplicate re-add **moves** to the
  end; add past the cap is a no-op (§8).
- `removeFromCollection` — filters the id, preserves relative order; unknown id
  → no-op.
- `toggleCollectionSample` — present→remove, absent→add (cap still applies).
- `clearCollection` — empties but preserves `open`.
- `collectionContains` / `isCollectionFull` — read-only predicates.

## 7. Duplicate Safety & Identity (§26)

Membership is exclusively by `sampleId` — never by name, index, or object
identity (C11: two record objects with the same id are one member). A duplicate
add never branches; re-adding an existing member refreshes its position to the
end (C08, E27-05/E27-10).

## 8. Cap & Full State

`COLLECTION_MAX_SAMPLES = 50`. The 51st add is a no-op with **no automatic
eviction** (C09, E27-18). Removing a member admits exactly the next add
(E27-19). The panel surfaces the honest `Collection is full.` status without
blocking the panel (§8 UX), and `isCollectionFull` gates the boundary itself —
every source (Discovery/Search/Sound Space) hits the same cap because all Add
controls route through `addToCollection` (§9).

## 9. Cross-Source Add Surface (Discovery / Search / Sound Space)

Every source row mounts the same `collectionActionButton`:
- Discovery rows → `collection-add-<id>`; Search result rows →
  `collection-add-search-<id>`; Sound-Space-focused point →
  `collection-add-focused-<id>`.
- The label is `Add` / `Added` (view-model `collectionAddLabel`), itself the
  state signal. Clicking mutates **only** the collection (E27-02/03/04/05).

## 10. Independence Guarantees (§30)

No automatic intelligence: nothing auto-adds, auto-sorts, auto-selects or
auto-evicts. The collection is fully independent of `selectedSampleIds`,
`focusedSampleId`, preview, Discovery results, search, and the Sound Space
filter (E27-13, app tests). Add/remove/toggle mutate no other surface.

## 11. Compare (§19)

`openCollectionCompare()` derives `sampleIds.slice(0, 4)`:
- <2 members → stays closed (never opens);
- 2–4 → all members in collection order;
- >4 → the **first 4 in explicit collection order**;
- never mutates the collection or the batch selection (E27-11/12, app tests).
`closeCollectionCompare()` only closes the derived surface.
`collectionCompareCharacters` resolves names + SoundCharacter through the same
registry as the V2 Compare (honest `null` → "—").

## 12. Select Collection (§20)

`selectCollection()` **explicitly** replaces `selectedSampleIds` with the
collection, in collection order, bounded by the existing `MAX_BATCH_SLOTS`
(the collection can hold 50; the batch sends at most 8). It uses the existing
selection API — no parallel selection logic — and integrates cleanly with
`openSoundSpaceCompare()` (E27-16). It is never automatic.

## 13. Character Summary (§22–§25)

`summarizeCollection(records)` is pure, deterministic, O(8N), no new DSP/ML:
- per canonical dimension: arithmetic mean over **PRESENT** values
  (`null`/absent ignored, never counted as 0);
- a dimension with no present value anywhere → `null` ("—");
- no present values anywhere (or no records) → the summary itself is `null`
  (the surface renders "—");
- type keyed by `SOUND_CHARACTER_DIMENSIONS` — the same contract
  `toSimilarityVector` uses.
UI label is fixed copy `Collection average · N` — never "AI profile" or
"predicted sound". `SoundCharacter` keeps its eight `number | null` fields
untouched.

## 14. Stale & Unavailable Members (§27–§28)

A member whose index record is gone stays in the collection (never dropped,
never crashing) and renders the honest `Unavailable sample` row; its preview
button is disabled while the record is unresolvable (E27-17). V1-only members
that never had a character contribute a null summary (tolerated).

## 15. Index-Refresh Guarantee

`refreshSearch()` and every collection mutation re-snapshot the CURRENT index
ids into `collectionKnownIds` (only when the collection is non-empty). An
index refresh/search never clears a collection member, and a re-added stale
member re-degrades to `available` once its record is back.

## 16. App State & Actions (§39)

State: `collection: SoundCollectionState`, `collectionCompare:
SoundSpaceCompareState`, private `collectionKnownIds: ReadonlySet<string>`.
Actions: `addToCollection`, `removeFromCollection`, `toggleCollectionSample`,
`clearCollection`, `openCollection` (re-syncs availability), `closeCollection`
(also closes Compare), `openCollectionCompare`, `closeCollectionCompare`,
`selectCollection`, `isCollectionMember`, `recordForSample`.
Getters: `collectionMembers` (availability per current snapshot),
`collectionSummary`, `collectionCompareCharacters`.

## 17. Collection Panel ("My Sounds")

Sections: header (counter + toggle `collection-toggle`), actions row
(`collection-select-all`, `collection-compare-toggle`, `collection-clear`),
status (full/empty), member list `collection-list` (rows
`collection-result-<id>` with `collection-name-<id>`,
`collection-preview-<id>`, `collection-remove-<id>`), summary grid
(`collection-summary-*`), and the derived Compare table. Mounted between the
Sound Space and the results panel in the map region.

## 18. Counter & Honest States

`collectionCounterLabel(n)` → `My Sounds · n` (`· 0` initially). Empty state
copy is the exact `No sounds collected yet.\nAdd sounds from Discovery, Search,
or Sound Space.` Full state shows `Collection is full.` without blocking the
panel. Closing the panel never clears members (E27-06/22).

## 19. Sound Space Visual Mark

Collection members receive the class `sound-space-point-collection` — a
**visual-only** stroke/fill accent. Point `cx`/`cy` are the frozen projector
coordinates; membership never recomputes or moves a point (E27-13 asserts
positions are byte-identical before/after collection mutation).

## 20. Accessibility & Keyboard

The Collection toggle/counter are `role=status`/`role=alert`-labelled; every
control has an `aria-label`; the toggle is a real `<button>` and reachable by
keyboard (`Enter` opens/closes, E27-20). Member names route to focus like the
other result rows, and preview/remove/select-all/compare/clear are plain
buttons so the whole surface is keyboard-operable.

## 21. View Models

Deterministic, exact-copy helpers in `view.ts`: the two status strings, the
`Collection average` label, the `Unavailable sample` label, `My Sounds · n`,
`Add`/`Added`, and the bounded Select All label (`Select All (8 of N)` when the
collection beats `MAX_BATCH_SLOTS`). `characterValueLabel` maps `null` → "—".

## 22. Session Locality & No Persistence

The collection lives only on the app instance. There are **no** writes to
localStorage, IndexedDB, the URL, or the D1 worker for collection state. A page
reload loses it by design; nothing rehydrates it.

## 23. Unit Tests (Core)

`src/analysis/collection.test.ts` — **18/18** (C01..C17 + version pin): initial
state, insertion order, duplicate no-op, re-add-to-end, remove-order, toggle,
clear-keeps-open, 50-cap/overflow no-op/no-eviction, immutability
(Object.freeze), id-identity, single/multi/partial/all-null summary, mixed
dimensions, determinism. All-constructed, no IndexedDB/DOM.

## 24. App Integration Tests

`src/ui/step27.collection.test.ts` — **21/21** against a REAL IndexedDB index +
REAL SearchEngine with FIXTURE/constructed V2 stamps: boundary semantics,
cross-source add, independence from focus/selection/preview/discovery/filter,
Compare (<2/2–4/>4, order, never-mutating), Select All + bound, summary
(single/multi/partial-null/all-null + label), stale member (index delete →
available=false, no crash), index-refresh-never-clears.

## 25. E2E (§36)

`e2e/step27.spec.ts` — **E27-01..E27-23 all pass** (real UI + four fixture
waveforms, `__sm.v2.attach`, real IndexedDB). Coverage: initial state; add from
Discovery/Search/Sound Space; duplicate; counter; remove; clear; insertion
order; re-add; Compare 2 + cap 4; no selection/focus/coordinates mutation;
summary values; null "—"; Select All; stale member; 50 cap + next-add-admitted;
keyboard; preview path (settles to playing-or-error like STEP24, since audio
playback is synth-blocked); console audit (no unhandled errors).

## 26. Performance (§31)

`src/analysis/collection.bench.test.ts` (constructed, cap 50:

```
STEP27_BENCH_POOL  addToCapMs  fullBoundaryMs  summaryMs
10                 0           0.08            0.084
50                 0           0.18            0.015
100                0.1         0.26            0.014
500                0.4         1.96            0.015
1000               0.9         4.04            0.017
```

Boundary stays sub-ms to low-ms even against a 1,000-pool; the O(8N) summary is
sub-millisecond at every pool. Bounds asserted: worst boundary < 2 000 ms.

## 27. Regression (§43)

No tests were deleted or weakened.
- `npm run typecheck` — **0 errors**
- `npx vitest run` (app + core) — **1024/1024** (984 baseline + 18 core +
  21 app integration + 1 bench)
- `workers/d1-worker` `npm test` — **19/19**
- `npx playwright test` (full) — **156/156** (133 baseline + 23 STEP27)
- `npm run build` — **PASS**

## 28. Evidence Classification

- **REAL:** full app/e2e runs against real IndexedDB + real SearchEngine +
  real similarity/filter/DSP code paths; the perf bench executes the actual
  boundary/summary functions.
- **FIXTURE:** e2e V2 audio stamps (`v2AnalysisFor`) computed by the REAL V2
  DSP over the four fixture waveforms; STEP21 corpus via `analyzeCorpus`.
- **CONSTRUCTED:** boundary no-audio tests, cap/bench pools, null-character
  records, memory search in benches.
- **BLOCKED:** none. (Audio playback stays synth-blocked per STEP24 §16M-19;
  tested for wiring only, matching the established STEP24/25 pattern.)

## 29. Acceptance Checklist (§45) & Final Verdict

- [x] Session-local collection, cap 50, duplicate-safe (id), insertion order,
      re-add moves to end, remove/clear/toggle — pure boundary + tested.
- [x] Add controls on Discovery, Search, Sound Space sharing one boundary;
      add mutates only the collection.
- [x] Independent of selection/focus/preview/discovery/filter; no automatic
      behavior.
- [x] Compare <2 closed / 2–4 all / >4 first-4 collection order; never mutates.
- [x] Select All replaces the batch via the existing API, bounded to 8.
- [x] Summary = `Collection average`, arithmetic mean over present values,
      null ignored, all-null → "—".
- [x] Stale members → `Unavailable sample`, never dropped, never crash; index
      refresh never clears the collection.
- [x] Counter, empty + full honest states, keyboard, console audit.
- [x] Unit (18) + app (21) + e2e (23) + perf bench; full regression green.
- [x] V1 + V2 frozen surfaces untouched (read-only consumption).
- [x] STEP28 **not started**.

STEP27 is complete and release-clean. The next step (STEP28, as scoped
separately) should not be started without a new session and spec.