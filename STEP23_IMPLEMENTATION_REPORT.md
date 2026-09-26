# STEP23 — V2 Similarity Integration & Product Search Surface — Implementation Report

## 1. Verdict

**STEP23 PASS**

## 2. Executive Summary

STEP23 surfaced the frozen STEP22 `rankSimilar()` engine as the first real V2
product workflow: a persistent "Find Similar" action in the inspector region
that, once invoked for the focused sample, ranks the index over the canonical
8-dim V2 `SoundCharacter` and renders the ranked snapshot (query header,
`Similarity NN%` scores, shared-dimension tooltips), with row preview via the
existing toggle path and row selection via the existing V1 focus path. A later
focus change never re-ranks an open snapshot (stale-query policy §29/§30);
Close drops the snapshot entirely; reopening recomputes a fresh deterministic
list from the current focus. V1-only samples stay fully browsable but never
rank in the V2 surface, and are never auto-analyzed by it (§47).

| Check | Before (STEP22 end) | After (STEP23) |
| --- | --- | --- |
| `npm run typecheck` | 0 errors | 0 errors |
| App unit tests (`npm test`) | 872 passed | **886 passed** (+14 STEP23) |
| Global worker tests (`workers/d1-worker`) | 19 passed | 19 passed |
| Playwright E2E (`npx playwright test`) | 70 passed | **82 passed** (+12 STEP23) |
| `npm run build` | PASS | PASS (pre-existing chunk-size warning only) |

## 3. Changed Files & V1 Landscape

| File | Change | Evidence |
| --- | --- | --- |
| `src/ui/app.ts` | EDIT — `SimilarityStateStatus` (`idle|ready|empty|error`), `SimilarityV2Row`, `emptySimilarityState()`, `similarityV2` state field, `openFindSimilarV2()` / `closeFindSimilarV2()`; imports of `rankSimilar`/`RANKING_DEFAULT_LIMIT`/`resolveQueryCharacter`/`SimilarityResult` | REAL |
| `src/ui/view.ts` | EDIT — pure view-models: `similarityV2Header`, `similarityV2ScoreLabel`, `similarityV2LimitedLabel`, `similarityV2StatusText` | REAL |
| `src/ui/render.ts` | EDIT — `renderSimilarityV2Panel` inserted into the inspector region between `renderSimilarPanel` and `renderSendPanel`; panel renders ONLY the snapshot (button always present, disabled without focus) | REAL |
| `src/ui/samplemap.css` | EDIT — `.similarity-v2-*` panel styles on existing design tokens | — |
| `src/e2e/harness/main.ts` | EDIT — test-only `__sm.v2` controls: `attach(keys?)` / `detach(keys?)` (stamp/remove deterministic V2 analyses on analyzed fixtures) and `rank(sampleId)` (the REAL `rankSimilar` top-10); helpers `profileOf`/`v2AnalysisFor` | FIXTURE |
| `src/ui/step23.similarityV2.test.ts` | NEW — 14 node tests (4 view-model, 6 open/close semantics, 3 mixed 70/30 library, 1 partial shared-dims) | REAL + FIXTURE + CONSTRUCTED |
| `e2e/step23.spec.ts` | NEW — 12 browser scenarios E23-01..E23-12 against the offline harness | FIXTURE |
| `e2e/artifacts/step23-similarity-v2-panel.png` | NEW — artifact screenshot of the open V2 surface | — |
| `STEP23_IMPLEMENTATION_REPORT.md` | NEW — this report | — |

**V1 freeze honored.** No V1 code changed: `src/pipeline/*`,
`src/audio/featureExtractor.ts` (V1 features), `src/classify/*`,
`src/similarity/*` (V1 fingerprint similarity incl. `similaritySearch`),
`src/search/*` (text search), `src/map/*` (V1 map projection), the Machiniste
service and the global publish surfaces are byte-identical. Frozen V2 modules
are untouched too: `src/analysis/similarityRanking.ts`,
`similarityEngine.ts`, `soundCharacter.ts`, `sampleAnalysisV2.ts`,
`audioFeaturesV2.ts`, `v2Fixtures.ts`, and `map-v2/*`.

## 4. Surface Architecture & UX

**Surface** — The app has no modal/drawer system; the integration-point audit
(detail panel, V1 similar panel, send panel) identified the inspector region as
the additive location. The V2 surface therefore lives there:

- An always-present `inspector-find-similar-v2` button (`Similar Sounds`
  section), disabled without a focused sample (native `title`: "Select a
  sample to find similar sounds").
- Once invoked: the query header (`Similar to: <query name>`, snapshot),
  an optional `Limited analysis` note, a status line for the empty/error
  modes, and a ranked list (`similarity-v2-list`) of rows with
  `similarity-v2-result-<id>` / `similarity-v2-preview-<id>` /
  `similarity-v2-name-<id>` / `similarity-v2-score-<id>` testids, plus a
  `similarity-v2-close` button.

**Row actions** — Preview (`▶`) reuses `app.togglePreview(record)`
(byte-identical existing path: epoch-based stale-fetch discard, single playing
preview, `previewUrlFor` resolution unchanged). Name click reuses
`app.selectSample(record)` (focus + inspector + map selection — the same V1
browsing path). No new audio/DSP/preview fetch is performed by ranking itself
(§31): the list hydrates rows from persisted metadata only.

**No V1 UI change** — the panel is purely additive in the inspector; the V1
map, results list, filters, action bar, send panel and publish/status blocks
are untouched (E23-11 asserts map=4 points, results=4 rows, inspector intact
after all V2 flows).

## 5. Ranking Integration (frozen engine composed)

`openFindSimilarV2()` is pure orchestration over the frozen STEP22 contract:

1. Focus — `focusedRecord` (registry-resolved; mirroring the inspector).
2. Presence — no `analysisV2` or `resolveQueryCharacter(record)` returning
   `null` (structurally invalid character) → `status: "empty"` with
   `"This sample has no V2 sound-character analysis yet."` (never fabricated,
   never auto-analyzed — §47).
3. No focus → `status: "empty"` + "Select a sample to find similar sounds.";
   `index` dependency absent → `status: "error"` ("local index unavailable"
   — an infrastructure failure, never shown as a valid empty result).
4. One `index.getAll()` read → `rankSimilar(focused, records, { limit:
   RANKING_DEFAULT_LIMIT /* 10 */, includeSelf: false })` → rows hydrated from
   that **same snapshot read** (no second index pass); `queryLimited =
   quality.featureCoverage < 1`; any thrown error → `status: "error"` with the
   message.

**Policies** — `RANKING_DEFAULT_LIMIT = 10`; `includeSelf = false`; no
`minFeatureCoverage` gate by default; sort is solely the engine's contract
`similarity DESC, sampleId ASC` — the UI never re-sorts; duplicates are
deduped by the engine; zero-shared-dimension candidates are excluded by the
null policy and never rendered as `Similarity 0%`.

## 6. Snapshot & Stale-Query Semantics (§29/§30)

- The open surface is **tied to its query**: `querySampleId`/`queryName` are
  captured at open; the header reads `Similar to: <query name>`.
- An open snapshot is **never re-ranked** by a focus change: selectSample from
  a row (or anywhere) leaves the open panel byte-identical (E23-04, plus a
  deep-equality unit test on the state object).
- No recompute while viewing; no watch/refresh timer; results are in-memory
  only and **not persisted** (§44).
- `closeFindSimilarV2()` resets to `emptySimilarityState()`; reopening
  recomputes — same input, byte-identical deterministic output (E23-10 + unit
  test).

## 7. Sort & Label Contract (§9/§24)

- Score label is exactly `Similarity NN%` (rounded, clamped to 0..100);
  the word "Confidence" is never used. Shared-dimension transparency rides
  only in the quiet `title` attribute (`Shared dimensions: N/8`).
- `Limited analysis` is shown **only** when data-backed: `status === "ready"`
  and `quality.featureCoverage < 1` on the query record (the coverage control
  itself is not exposed — §10).
- Empty surface says "No similar samples found." (ready with zero rows);
  missing-V2 and no-focus surfaces carry their errors in plain text.

## 8. Degradation, Partial Data & V1-only Samples (§35/§47)

- **Partial V2 query** — STEP22 shared-dim semantics hold in the UI: with a
  2-dim partial query, 1-shared-dim candidates rank (≈1.00 when equal on the
  shared dim), the 8/8 candidate matching both shared dims scores exactly
  `1`, and the zero-shared candidate is excluded (unit test, `Partial data —
  shared-dimension semantics`).
- **V1-only query** — honest empty state ("no V2 sound-character"); the record
  is never auto-analyzed by the surface (asserted both in node — the persisted
  record still lacks `analysisV2` after the open — and in the browser).
- **Mixed library acceptance (§34)** — 100 samples: 70 V2 (10 corpus
  profiles × 7) + 30 V1-only → all 100 browsable through the V1 search
  surface (`app.results.length === 100`), results rank exclusively V2 rows and
  match the engine output exactly, with a hard cap of 10, and a V1-only query
  in that library yields the honest empty state.
- **Ready-empty** — a V2 query with zero rankable V2 candidates (browser:
  only one V2 sample attached) renders "No similar samples found." with no
  rows (E23-07).

## 9. Unit / Integration Tests

`src/ui/step23.similarityV2.test.ts` — 14 tests, all green:

- **View-models (4)** — header/ʼ—/labels/clamping, limited-label gating,
  status-text mapping for every status.
- **Open/close semantics (6)** — no-focus empty; V1-only empty with
  no-auto-analysis (§47); `index`-unavailable `error`; deterministic REAL
  ranking + self-exclusion + row hydration + 0 < sim ≤ 1 bounds; snapshot
  stability under focus change (deep-equality) + re-invoke re-ranking on the
  NEW query; close→empty-state, reopen→fresh deterministic recompute.
- **Mixed library §34 (3)** — 70/30 browse-all, V2-only ranking with exact
  engine match, V1-only query honest-empty.
- **Partial data §35 (1)** — constructed partial characters; shared-dimension
  semantics, exact-similarity bounds, zero-shared exclusion.

Fixtures: `makeSample()` (CONSTRUCTED record metadata) for V1-only rows and
`analyzeCorpus(name, 44100)` (FIXTURE-class V2 analyses — see §16).

## 10. E2E (E23-01..E23-12)

`e2e/step23.spec.ts` — 12 scenarios against the offline harness on a real
Chrome page, shared serial flow (index + analyze once, then drive the
surface); assertions never hardcode a ranking order — all expected orders come
from `__sm.v2.rank()` (the REAL `rankSimilar` over the same persisted index):

| # | Scenario | Verdict |
| --- | --- | --- |
| E23-01 | No focus: button disabled + title; open yields empty "Select a sample" | PASS |
| E23-02 | Open ranks via REAL `rankSimilar`, excludes the query, exact DOM order | PASS |
| E23-03 | Top result equals `rankSimilar()[0]`; scores match `Similarity NN%`; shared-dim title | PASS |
| E23-04 | Row click focuses+selects (one selected map point, inspector populated); snapshot header unchanged | PASS |
| E23-05 | Preview reachable from a row (wired to `togglePreview`; synthetic playback stays blocked, §16M-19) | PASS |
| E23-06 | Re-open re-ranks on the NEW focus; full B→C chain with engine equality at each hop (§50) | PASS |
| E23-07 | Single-V2 library → ready-empty "No similar samples found." | PASS |
| E23-08 | V1-only sample stays browsable (results row + map point), ranks as empty, never auto-analyzed | PASS |
| E23-09 | Keyboard activation (Enter/Space open, Enter selects a row) | PASS |
| E23-10 | Close drops the snapshot; reopen recomputes an identical fresh list | PASS |
| E23-11 | V1 regression: map=4 points, results=4 rows, inspector intact | PASS |
| E23-12 | Console audit: no uncaught errors beyond benign/404-preview noise | PASS |

## 11. Performance & Propagation Boundaries

- Ranking cost: one `index.getAll()` + O(8·N) in-memory scoring; N=100 in the
  mixed test completes within the unit-test budget and at browser scale the
  four-fixture harness ranks in a single click frame.
- No audio, DSP, or preview fetch is performed by ranking (§31); the harness
  `fetchCount` is untouched by any V2 surface interaction (scan/analyze are
  the only fetch sites).
- The panel renders from app state only — no second cache or data source was
  introduced (existing in-memory index + IndexedDB store reused, §32); V2
  state changes drive the same existing `onChange → render` loop.

## 12. Invariants

- The V1 pipeline, classifier, V1 fingerprint similarity, search engine, map
  projection, Machiniste service and global publish surfaces are unchanged.
- The frozen V2 modules (STEP20/STEP21/STEP22 analysis + ranking) are
  unchanged; STEP23 composes `rankSimilar`/`resolveQueryCharacter`/
  `RANKING_DEFAULT_LIMIT` as imports only.
- The V2 surface never mutates records: `openFindSimilarV2` performs zero
  persisted writes; results hold no references the store could leak through
  (rows are plain metadata refs).
- `includeSelf = false` always; the query can never appear in its own list.
- `similarity ∈ (0, 1]` on every rendered row; no zero-similarity filler.

## 13. Compatibility

- `analysisV2` remains an additive optional field on the persisted V1 record
  shape; records written by older app versions (no V2) stay valid and produce
  the honest empty state rather than errors.
- The UI keeps its single persisted view-contract (V1 map/search/filters);
  V2 state is never written to storage or URLs, so reloads and back-nav behave
  exactly as V1 (§43/§44).
- No worker contract, publish queue, or shared type changes — `workers/
  d1-worker` tests unchanged (19/19).

## 14. Security

- The surface renders only persisted metadata; no new network endpoints,
  no credentials, no untrusted HTML (`textContent`-style DOM building as in
  V1 — no injection surface added).
- Preview stays behind the existing `PreviewService` concurrency/ObjectURL
  hygiene and `togglePreview`'s epoch guard; nothing new fetches audio.

## 15. Scope Control (deliberately NOT implemented) & Known Limitations

Deliberately out of scope per the STEP23 spec: URL routing/deep-linking (§43),
persistence of similarity results or UI state (§44), auto-V2-analysis of
V1-only records (§47), any Machiniste batch action (§48), publish-surface
changes (§49), hybrid text+acoustic scoring (§23), `MapProjector`/`map-v2`
changes (§20), and any coverage control (§10 — only the data-backed
"Limited analysis" note).

Not tested / known limitations:

- **Playback evidence** — browser preview of a ranked row is reachable and
  wired, but actual audio playback of the synthetic fixture URLs remains
  BLOCKED by construction (same class as the pre-existing §16M-19 finding);
  live-sample preview stays a Layer-C concern.
- **Record scale** — performance is asserted on the 100-sample mixed library
  (node) and 4-fixture harness (browser); a 10k-scale browser run was not
  executed (the engine's STEP22 benchmark remains the perf anchor).
- **V2 freshness vs. records** — if a record's V1 features were reanalyzed
  while a V2 snapshot is open, the snapshot is intentionally not re-computed
  (frozen snapshot per §30); reopen to refresh.
- The STEP22 calibration deviation (relation 6 — `lowThump ~ highThump`) is a
  STEP22-known V2.0 calibration gap, NOT introduced or changed here; STEP23
  deliberately does not assert it either direction.

## 16. Evidence Classification (§16)

- **REAL** — app/view/render wiring and behavior under test (unit + browser
  flows run the production code paths: inspector panel, focus/selection,
  ranking via the frozen engine itself).
- **FIXTURE** — harness V2 analyses stamped by `__sm.v2.attach` (deterministic
  V2 DSP over the synthetic fixture waveforms the pipeline decodes) and the
  `analyzeCorpus(..)` node-level fixtures; the acceptance flows are
  FIXTURE-class, never claimed as "REAL audio evidence".
- **CONSTRUCTED** — `makeSample()` V1-only records and the hand-built partial
  `SoundCharacter` characters used for §35 shared-dimension coverage.
- **NOT TESTED / BLOCKED** — real audio thumb-playback in the browser
  (BLOCKED for the synthetic fixture URLs; see §15) and live Audiotool library
  behavior (Layer-B, out of scope for the offline harness).

## 17. Next Step

STEP24 — V2 Visual Sound Space & Similarity Map Integration

## 18. Verification Commands

- `npm run typecheck` — 0 errors.
- `npx vitest run src/ui/step23.similarityV2.test.ts` — 14 passed.
- `npm test` — 886 passed (51 files; baseline 872 + 14 STEP23).
- `cd workers/d1-worker && npm test` — 19 passed.
- `npx playwright test` — 82 passed (baseline 70 + 12 STEP23).
- `npm run build` — PASS (pre-existing chunk-size warning only).
