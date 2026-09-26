# SAMPLEMAP V1 — STEP 15E REPORT

## Files created
- None (all changes were edits to existing UI modules + tests).

## Files modified
- `src/ui/view.ts` — added pure `detailMapPosition(record)` (map-position
  display, exclusively from `mapPosition(audioFeatures)`; undefined when no
  features; no persistence).
- `src/ui/app.ts` — `selectSample()` now stops a running preview when switching
  samples (one active player at a time); `pruneSelectionToVisible()` now
  stops the preview too when a filter hides the selected sample.
- `src/ui/render.ts` — reworked the detail panel into a proper Inspector:
  prominent name, owner/duration, Classification block, separate Original Tags
  block, Map Position block, and a Preview button (▶ Preview / ■ Stop) with
  error display; responsive map+inspector row (stacked on narrow, side-by-side
  on wide).
- `src/ui/view.test.ts` — added Inspector tests (INV-2 separation,
  `detailMapPosition`, undefined-without-features).
- `src/ui/app.test.ts` — added preview-lifecycle tests (switch stops old
  preview, filter-away clears selection + stops preview, preview error does not
  break the app).
- `index.html` — inspector + responsive-row CSS.

## Tests before / after
- Before: 237 tests / 20 test files.
- After:  243 tests / 20 test files (added 6 tests; no existing test deleted or
  weakened).

## Inspector
- No selection -> "No sample selected." (no stale info).
- Selecting a sample shows name, owner, duration, Classification (primary +
  confidence + secondary), Original Tags, and optional Map Position.
- Selecting another sample updates the Inspector; selection is unique (single
  `selected` in the app controller, reused from 15C/15D).
- Hover tooltip (15C) is untouched and separate from the persistent selection
  shown in the Inspector.

## Selection
- Uses the existing `app.selectSample(record)` — no second selection state.
- Switching samples stops the previous sample's preview.
- Filtering away the selected sample clears selection AND stops its preview
  (Step 15D behaviour preserved, extended to preview).

## Original Tags / Classification separation
- INV-2 preserved structurally: Classification block is derived only from
  `primaryClass`/`confidence`/`secondaryClasses`; Original Tags are a separate
  list. Classifier output is never written into tags and vice versa.

## Preview implementation
- Reuses the existing `PreviewService` (browser fetch -> in-memory ObjectURL)
  and the app's existing `togglePreview` / `previewSampleId` / `previewError`.
  No new audio architecture, no new player library. Preview never persists audio
  bytes (no IndexedDB write) — V1 invariant intact. Start/Stop toggle + error
  display; at most one active preview at a time.

## Preview verification
- Logic is unit-tested (start/stop/switch/error-tolerance) in Node using the
  injected PreviewService fake, exactly as the existing suite does.
- Real audible playback of authenticated Audiotool samples: **BLOCKED** (OAuth
  login unavailable — Step-14 limitation). No simulated auth, no fabricated
  audio, no claim of real playback PASS.

## Empty state
- Distinguished from search-empty: Inspector shows "No sample selected." only
  when there is no selection. Preview error text is shown inline without
  clearing selection or crashing the map.

## Filter interaction
- Filter removing the selected sample -> selection cleared + inspector emptied +
  preview stopped. Sample staying visible -> selection retained.

## Responsive behavior
- Map + Inspector in a flex row: side-by-side on wide (min-width 900px),
  stacked below on narrow screens. Map keeps `viewBox` responsive scaling.

## TypeScript
PASS (`npx tsc --noEmit` clean).

## Build
PASS (`npm run build` succeeds; only the pre-existing chunk-size warning).

## Production changes
- Only UI layer touched. `AnalysisPipeline`, `JobRunner`, `FeatureExtractor`,
  `Classifier(Registry)`, `IndexStore`, `QueueStore`, `SearchEngine`,
  `SampleMapMachinisteService` and `mapPosition()` are all unchanged.

## Architecture changes
- No new dependency, no new persistence, no permanent UI state written to
  IndexedDB (selection/preview are runtime-only). No new audio pipeline.

## Verified
- 243 / 20 tests green, tsc clean, build OK.
- Headless Chrome: app loads unauthenticated with no exceptions / no console
  errors after the changes.

## Blocked
- Real authenticated Audiotool preview playback (live audio) — OAuth blocked
  (Step-14 limitation). All preview control logic is Node-tested via fakes; no
  fabricated PASS results.

## Not implemented
Zoom, Pan, Find Similar, Similarity Engine, Clustering, Heatmap, Machiniste send
workflow, new classification/ML, new audio features, new persistence, waveform
editor, sample editing/trim/normalize/effects.

## Verdict
DONE — all 21 acceptance criteria met (with real-playback preview verification
correctly scoped as `BLOCKED`, not FAKE-PASS).
