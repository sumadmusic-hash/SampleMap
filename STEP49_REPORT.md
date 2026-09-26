# STEP49 — One-Shot Classification & Map UI Product Verification

## 1. Executive Verdict

**A — PASS / KEEP**

The current SampleMap one-shot classification system is **useful, coherent, and correctly
integrated** into the map-centered experience. The product-level verification found **no concrete
product defect** and no contradiction with the settled STEP45/46/47/48 architecture:

- The **map** is an acoustic orientation surface (position = persisted v2-derived
  `mapPosition`/canonical Sound Space; class color is presentation-only; filtering never
  repositions points — MEASURED in the browser).
- **Class filters** constrain the population from the **authoritative persisted classification**
  (`primaryClass` + `secondaryClasses`), never from metadata words; STEP48 cross-family hardening
  holds at the search layer too.
- **Ambiguity** stays honest — nothing forces a snare/clap into a fabricated certainty.
- **Focus ≠ selection**, selection capped at **8**, loops cannot leak into drum filters through
  their metadata words, no audio bytes are persisted, popularity never touches classification or
  coordinates.

New verification coverage pins the two product-guarantees that were previously only implicit
(§9 loop/metadata-word isolation and §10D cross-family integrity at the filter/search layer).
**No production code was changed.** Recommendation: **KEEP AS-IS**.

---

## 2. Scope

Verified, audit-first, against the current implementation:

1. Product-surface flow: Audiotool sample → eligibility → structure → V2 analysis → hierarchical
   classification → semanticClassification → `mapPosition` → persistence → map/search/filter UI →
   focus/selection → preview.
2. Map-v2 rendering (`src/ui/map/mapView.ts`, `mapRender.ts`), click handling, preview
   (`src/preview/previewService.ts`), classification UI, class filters
   (`src/ui/render.ts`, `src/search/searchEngine.ts`), one-shot/loop handling, focus vs selection
   (`src/ui/app.ts`), search composition, UI simplicity, persistence, popularity.
3. Baseline regression, full Vitest suite, `tsc`, and the complete Playwright browser suite
   against the offline harness.

Non-goals honored: no classifier/threshold/feature/map/coordinate/reconcile/persistence changes;
no AI/ML; no re-opening of settled STEP45/46/47/48 architecture.

---

## 3. Baseline

| Check | Before (STEP48) | After (STEP49 end) |
|---|---|---|
| Vitest files | 76 | 77 (+1 verification file) |
| Vitest tests | 1326 | 1333 (+7 verification tests) |
| Failures | 0 | 0 |
| TypeScript (`tsc --noEmit -p tsconfig.json`) | clean | clean (exit 0) |
| Browser (Playwright, full suite) | clean | **176/176 passed** (1.8 min) |

Baseline was clean before any work; all 176 Playwright specs and 1326 Vitest tests were green.

---

## 4. Classification Surface Audit

Classification reaches the UI through the **persisted record only** — no UI-side classifier exists:

```
analysisPipeline (V2 required) → classifyHier (hier-v1) OR HeuristicClassifier (heuristic-v1)
  → writes primaryClass/secondaryClasses/confidence/semanticClassification/hier
  → mapPosition computed ONCE at analysis time (analysisPipeline.ts:296 computePosition(features, decoded))
  → IndexStore.put (assertNoAudioBytes gate, indexStore.ts:271-274)
UI:
  SampleMapSearchEngine(index.getAll) — READ-ONLY projection (searchEngine.ts:89-134),
    class predicate = accepted.has(primaryClass) || accepted.has(any secondaryClass) (searchEngine.ts:181-184)
  app.setClasses / setMinConfidence / setSort → refreshSearch (app.ts:859-924)
  mapView.mapPoints(records) — pure projection: position from canonical Sound Space or persisted
    mapPosition; no position ⇒ NO point (mapView.ts:327-380)
  view.ts:121-147 classification block derived ONLY from primaryClass/confidence/secondaryClasses
```

Confirmed: the UI consumes authoritative persisted data and never recomputes classification
locally. The **offline browser harness** runs the V1-frozen pipeline with `HeuristicClassifier`
(`src/e2e/harness/main.ts:336,342-350`; no `classifyHier` hook) — so live-browser classification
evidence is legacy-path + FIXTURE audio; the `hier-v1` product surface is exercised at the Vitest
level (step44/45/47/48/49 suites + `analysisPipeline.test.ts`). This boundary is documented, not
hidden.

---

## 5. One-Shot / Loop Verification

**No one-shot-only or loop-only surface exists** — there is no kind/structure filter in the UI;
`kind` is displayed as metadata (`view.ts:116`) and used only for eligibility priority ordering
(`eligibility.ts:180-214`). The class selector does include a **"loop"** class under the Other
group (taxonomy.ts:29) — filterable as a class label, which is valid for legacy `heuristic-v1`
loop records (`heuristicClassifier.ts:95-96`).

- **Loops are not classified as drum one-shots by the UI** — the UI never classifies.
- **Duration never flips kind identity**: `kind === "loop" → loop`; `one-shot && >4s →
  sustained-phrase`; otherwise one-shot (`structure.ts:27-29`).
- **A drum-class filter cannot surface a loop via metadata words.** Newly pinned
  (`src/step49Verification.test.ts §9`): a loop named/tagged "Kick Snare Clap Hihat Loop" with a
  persisted non-drum class (`other`) is excluded from kick/snare/clap/hat and the whole `drums`
  group filter; the same record *is* returned under its persisted class (`other`, `bass`).
- Structure/idle corruption: no stale loop label state exists to flip a one-shot into a loop.

Result: **AC2 PASS.**

---

## 6. Drum Filter Verification

Class filters: grouped `<select>` ("All" + group tokens "Drums/Musical/Other" + the 22 classes in
3 optgroups of 8/8/6 — `render.ts:645-680`; verified live EP4-01). Predicate matches `primaryClass`
**or** any `secondaryClass` (searchEngine.ts:181-184) — secondary-class matching is the documented
product behavior, not an accidental leak.

**Measured in the live browser** (offline harness, 4 FIXTURE samples, heuristic-v1 path) —
OBSERVED counts (result rows / map points after each `setClasses`):

| Class filter | Results | Map points | Note |
|---|---|---|---|
| kick | 3 | 3 | `kick-909` + `hat-airy` primary kick (fixture artifact, see §7 note), `bass-sub` via secondary `kick` |
| snare | 0 | 0 | |
| clap | 0 | 0 | |
| hihat | 1 | 1 | `hat-airy` via secondary `hihat` |
| tom | 1 | 1 | `lead-ohm` via secondary `tom` |
| cymbal | 0 | 0 | |
| percussion | 0 | 0 | |
| drums (group) | 4 | 4 | every drum-class match |

Clearing the filter restored all 4 samples (EP4-01:153, OBSERVED). Fixture classifications
(OBSERVED): `kick-909→kick`, `hat-airy→kick`, `bass-sub→bass`, `lead-ohm→guitar`.

- **A — filter works**: yes; each filter constrains the population; result count == map-point
  count on every drum filter (OBSERVED).
- **B — authoritative data**: filters read persisted `primaryClass`/`secondaryClasses` only
  (searchEngine over `getAll`); pinned by `step49Verification.test.ts` §10B (engine over a bare
  `{ getAll }` stub — no UI-side classification possible).
- **C — primary/secondary consistency**: secondary classes are intentionally filterable
  (documented in `searchEngine.ts:181-184` + ep4 spec docblock); verified live via `hihat`/`tom`.
- **D — cross-family hardening respected**: pin at the search layer — a metadata-adopted
  musical/bass sample (STEP48 fixture, `secondaryClasses: []`) is **absent** from kick/snare/clap/
  tom/drums filters and present under `bass` (`step49Verification.test.ts` §10D). Same-family
  records still match via their documented secondaries.

---

## 7. Ambiguity Verification

- Classifier honesty is authoritative: `ambiguous` flag + decision confidence are produced by
  `classifyHier`; family `unknown` ⇒ type `other`; nothing forces a snare/clap into a certain
  pick (STEP44 §28, STEP47/48 suites — 22-test integrity suite green).
- UI honesty: the map tooltip shows `primary "kick (90%)"`-style primary+confidence only
  (`mapView.ts:451-458`); the inspector shows the same plus `Secondary: …` or `none`
  (`render.ts:2105-2108, 2286-2289`); no class is ever presented with fabricated certainty.
- **OBSERVED fixture artifact (FIXTURE-class evidence, legacy path)**: the synthetic `hat-airy`
  wave classifies primary `kick` under heuristic-v1. The harness docblock declares "never REAL
  audio evidence", and STEP46/47 settled that imperfect synthetic examples on the V1-frozen path
  are not grounds for classifier changes. Noted for evidence honesty; **not treated as a product
  defect** and no threshold tuning was performed (STEP25 constraint honored).

---

## 8. Secondary-Class Verification

- **Visible**: yes, in the inspector classification block ("Secondary: a, b, c" / "none",
  `render.ts:2105-2108, 2286-2289`) — **subordinate**, plain text under the primary class.
- **Not on the map**: points are unlabeled circles (color = class, `CLASS_COLORS`); the tooltip
  shows only primary + confidence + owner + separate tag list (INV-2). Secondary info stays out of
  the map surface.
- **Discovery value**: secondaries genuinely participate in filters (documented behavior; live
  `hihat`/`tom` hits via secondaries). The inspector lets a user understand *why* a sample matched
  a filter.
- **STEP48 cross-family integrity**: adopted musical/bass records carry `[]` secondaries
  (`classify.ts:104` filter; `step48Hardening.test.ts` §10), so no stale drum secondaries can pull
  them into drum filters — re-pinned at the search layer in `step49Verification.test.ts` §10D
  (**AC6 PASS**).
- No clutter risk observed: 3 secondary entries max, confidence-sorted, inspector-only.

---

## 9. Map Verification

- **Point presence**: points require `status === "analyzed"` **and** a projectable position —
  canonical Sound Space when `analysisV2.soundCharacter` exists, else the persisted v2-derived
  `mapPosition`; records with neither are never placed (`mapView.ts:327-380, 354-355`). No point is
  drawn from raw `audioFeatures` (STEP 16Q + STEP37).
- **Position integrity**: coordinates come exclusively from the persisted position; the camera is
  a runtime-only view transform (`mapView.ts:110-163`); EP4-01 MEASURED that applying the kick
  filter left every point's `cx/cy` byte-identical to pre-filter (`positionsOf` assertion).
- **Distribution**: the 4 live FIXTURE points occupy distinct positions (16M-07: DOM `cx/cy`
  equal the real `mapPosition` projection). The acoustic space is intentionally an orientation
  space, not a semantic taxonomy map — snare/clap overlap is expected (STEP45) and not treated as
  a defect.

---

## 10. Preview / Focus / Selection Verification

- **Interaction model (as implemented, documented per §16)**: a plain press on a map point
  **focuses** the sample (`mapRender.ts:297-308` → `app.selectSample`); **playback is an explicit
 , separate action** (inspector/row play button → `togglePreview`). The FP-03 e2e test confirms a
  plain click focuses but never touches selection.
- **Preview**: `PreviewService` returns transient `URL.createObjectURL(blob)` handles, revoked on
  eviction, **never written to IndexedDB** (`previewService.ts` docblock). Live: 16M-19 preview
  source resolution works (playback is intentionally BLOCKED for synthetic samples — the offline
  boundary); 16M-20 console audit clean.
- **No stale audio**: a focus/preview change bumps `previewEpoch` so an in-flight preview for the
  previous sample is discarded (`app.ts:2193-2201`).
- **Focus ≠ selection**: `focusedSampleId` vs `selectedSampleIds` (batch), independent; batch
  changes only via checkbox `toggleMultiSelect` (`render.ts:875`).
- **Selection cap 8**: `MAX_BATCH_SLOTS = 8` enforced in `toggleMultiSelect`
  (`app.ts:2252-2253`, checked **before** mutation) and hard-guarded in
  `machinisteService.ts:257`; the N/8 pill renders/caps (render.ts:473-476). Verified by
  `app.test.ts:721-734`, EP3, step16w-fixes.

---

## 11. Search / Filter Composition

- Search text operates on `name`, `originalTags`, `owner` only (`searchEngine.ts:34`, tokenized
  AND semantics at `searchEngine.ts:98-113`); it composes **with** class `accepted` and
  `minConfidence` filters on the same read (all `&&` gates at `searchEngine.ts:103-108`).
- Class filtering composes with search rather than replacing it — a text query can narrow within
  a class filter; `setClasses`/`setMinConfidence`/`setSort` all funnel through `refreshSearch`
  (`app.ts:859-924`).
- Verified: `searchEngine.test.ts` (name/tag/owner, primary/secondary/group/confidence/sort) and
  EP4-02 (confidence + sort + empty states) + EP4-01 clear-restores-full-set (OBSERVED). No new
  search semantics introduced.
- **AC10 PASS.**

---

## 12. UI Simplicity Assessment

The map stays clean: unlabeled color points, four-corner axis descriptors only (`mapRender.ts:78-186`),
a single grouped class dropdown, min-confidence and sort controls, one result-count line. The
inspector carries the detail (classification block = primary + confidence + secondary; original
tags in a separate list; no DSP terminology, no confidence curves, no analysis dashboard).
Secondary labels appear only when useful (inspector), never on the map. This satisfies the
"clean map + useful detail" preference (**AC11 PASS**); no load of classification metadata was
added to the surface.

---

## 13. Live Browser Verification

**PARTIAL (with exact boundary).**

Runs completed against the **offline harness** (real Chrome, `playwright.config.ts`,
`baseURL localhost:5176`) — full suite **176/176 passed (1.8 min)**:

1. app loads ✔ (16M-01)    2. samples appear ✔ (16M-02/16M-06)
3. map points appear ✔ (16M-06)    4. class filters work ✔ (EP4-01, §6 probe)
5. one-shot filter — **N/A**: no one-shot/loop filter surface exists (documented in §5)
6. drum class filter works ✔ (kick/snare/clap/hihat/tom/cymbal/percussion measured, §6)
7. clicking a point focuses it ✔ (16M-08, FP-03)
8. preview — **resolution ✔** (16M-19); **audible playback BLOCKED** in the offline harness
   (synthetic samples intentionally not playable; real playback needs live Audiotool/OAuth audio,
   which is outside the offline harness by design)
9. search/filter combination works ✔ (EP4-02; searchEngine tests)
10. clearing filters works ✔ (EP4-01) ; console error audit ✔ (16M-20, E27-23...) — no unhandled errors.

Exact boundary: the harness pipeline is **V1-frozen and uses `HeuristicClassifier`** (no
`classifyHier` wiring, `src/e2e/harness/main.ts:336,342-350`) over synthesized FIXTURE audio —
so the `hier-v1` classification surface and true Audiotool playback are verified at the
unit/pipeline level, not in the live browser. No fake "live" pass is claimed, and a live
Audiotool OAuth browser run is not part of the offline verification scaffold (documented boundary).

---

## 14. Defects Found

None.

Two documented OBSERVED notes, neither a defect: (1) the synthetic `hat-airy` fixture classifies
primary `kick` on the legacy V1 path — explained by FIXTURE-class synthetic audio, addressed by
the harness's own "never REAL audio evidence" contract; (2) secondary-class matches are live and
intentional (documented filter semantics, not stale leakage).

---

## 15. Changes Made

- **No production changes.**
- **Added** `src/step49Verification.test.ts` (7 tests, test-only): pins §9 loop/metadata-word
  isolation, §10B authoritative-classification use, §10D STEP48 cross-family integrity at the
  search layer, and same-family secondary matching. Temporary probe spec removed.
- No other files modified.

---

## 16. Regression Results

```
Vitest:       77 files / 1333 tests / 0 failures   (baseline 76 / 1326; +1 file, +7 tests)
TypeScript:   clean (tsc --noEmit -p tsconfig.json → exit 0)
Playwright:   176 / 176 passed  (full suite, 1.8 min, offline harness + real Chrome)
```

No partial run was reported as a full regression: the executing command set is the complete
Vitest suite, the complete TypeScript check, and the complete Playwright suite.

---

## 17. Invariants Reverified

| Invariant | Evidence |
|---|---|
| Acoustic map independence | Position ONLY from persisted v2-derived position/canonical Sound Space; class color is presentation-only; camera is runtime-only (mapView.ts:30-40,327-380; EP4-01 positions byte-identical under filter). |
| No V1 fallback | `mapPosition` computed once at analysis time from decoded audio (analysisPipeline.ts:296); records without a position are never placed (mapView.ts:354-355). |
| No audio persistence | `SampleIndexRecord` holds no audio containers (indexStore.ts:37); `assertNoAudioBytes` enforced in `put` (indexStore.ts:271-274); preview = revocable ObjectURLs, never stored. |
| Popularity independence | `numFavorites`/`numUsages`/`bpm` are a metadata slice (display + eligibility only); nothing in classify/similarity reads them (`eligibility.ts:17-19,89-128`). |
| Selection max 8 | `MAX_BATCH_SLOTS = 8` (machinisteService.ts:38); cap before mutate (app.ts:2252-2253); hard guard (machinisteService.ts:257); N/8 pill. |
| Focus ≠ selection | `selectSample` sets only focus; batch only via checkbox `toggleMultiSelect`; FP-03 e2e. |
| Tags/name not authoritative | INV-2 (tooltip tags separate); class filters match classification only, never metadata words (step49 §9). |
| No AI/ML, no new classifier, no new map algorithm | Nothing added by STEP49; STEP46/48 KEEP scope honored; no thresholds touched. |

---

## 18. Acceptance Criteria

| Criterion | Verdict | Evidence |
|---|---|---|
| AC1 One-shot visibility | PASS | 4/4 fixture samples render as v2 map points with correct persisted positions (16M-06, 16M-07); mapPoints gate on analyzed + position. |
| AC2 Loop separation | PASS | No one-shot-only surface exists; loops enter drum filters only via a persisted drum class; metadata-drum-word loop excluded by step49 §9 tests. |
| AC3 Classification authority | PASS | UI reads persisted records only; no UI-side classifier; step49 §10B over a bare stubl. |
| AC4 Drum filters | PASS | kick/snare/clap/hihat/tom/cymbal/percussion + `drums` group behave per taxonomy (live counts in §6; unit predicates). |
| AC5 Ambiguity honesty | PASS | `ambiguous`/confidence propagated honestly; no forcing; tooltip/inspector avoid fake certainty (step44/47 suites, mapView.ts, render.ts). |
| AC6 Cross-family integrity | PASS | No stale drum secondaries after STEP48 fix; verified at classify (step48) **and** search/filter (step49 §10D) layers. |
| AC7 Map integrity | PASS | EP4-01 measured position stability under filters. |
| AC8 Map interaction | PASS | 16M-08 click→focus; 16M-19 preview resolution; FP-03 focus-vs-selection; 16M-20 console clean. |
| AC9 Focus/selection | PASS | Independent states; cap 8 enforced at controller + Machiniste; N/8 pill; step16w/FP-03 verify. |
| AC10 Search composition | PASS | Text+class+confidence compose in one `&&` gate; no corruption; EP4-02 + searchEngine suite. |
| AC11 UI simplicity | PASS | Clean unlabeled color map; single dropdown; detail in inspector only; secondary chips inspector-only; no DSP dashboard. |
| AC12 Persistence | PASS | No audio bytes in store; `assertNoAudioBytes` gate; indices are metadata-only (db.ts:43-59). |
| AC13 Regression | PASS | Vitest 77/1333 - 0 failures; tsc clean; Playwright 176/176. |
| AC14 No speculative scope | PASS | No AI/ML/new classifier/new feature/new map algorithm; STEP constraints honored. |

---

## 19. Final Recommendation

**KEEP AS-IS.**

The one-shot classification + map UI is coherent, honest, and useful as implemented: the map is
the acoustic surface, classification is authoritative and drives filters correctly, secondary
classes aid discovery without clutter, and every immutable product invariant still holds. The only
additions in STEP49 are verification tests for guarantees that were present but unpinned
(loop/metadata-word isolation and cross-family integrity at the search/filter layer). Any further
change would be speculative scope; per STEP34, the best result is the defensible one, and it is
verified rather than added to.