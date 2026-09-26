# SAMPLEMAP V1 — STEP 15F REPORT

## STEP 15F RESULT

### Files created:
- None. (`ui-probe.html` / `ui-probe.ts` were temporary throwaway harnesses used
  for the headless browser probe and were deleted afterwards — not part of the
  product.)

### Files modified:
- `src/ui/map/mapView.ts` — pure camera math (Step 15F §6–§11): `MapCamera`,
  `MIN_ZOOM`/`MAX_ZOOM`/`DEFAULT_ZOOM`, `ZOOM_STEP`, `DRAG_THRESHOLD_PX`,
  `POINT_HIT_RADIUS_PX`, `defaultMapCamera()`, `clampZoom()`, `clampPan()`,
  `zoomBy()` (anchor-stable), `panBy()`, `applyCamera()`, `pointAt()`
  (camera-aware hit test for hover/click).
- `src/ui/map/mapRender.ts` — SVG gets a transformed content group
  `<g class="map-content" transform="translate(panX panY) scale(zoom)">`; axis
  labels + background stay in screen space. Pointer-drag pan (threshold 4px),
  wheel zoom around pointer, hover/click through the camera. Sample circles
  keep their untouched base cx/cy.
- `src/ui/app.ts` — runtime-only `mapCamera` state + `setMapCamera()`
  (clamped), `zoomMapBy()`, `resetMapView()`. Camera is never persisted; it is
  not reset by filters, clearSearch or selection changes.
- `src/ui/render.ts` — map panel now renders zoom controls `[−] [100%] [+]`
  `[Reset View]` (Step 15F §20) and passes `camera`/`onCamera` to the renderer.
- `index.html` — CSS for `.map-zoom-controls`, hovered-point ring, grab cursor.
- `src/ui/map/mapView.test.ts` — 16 new pure camera/hit-test/invariance tests.
- `src/ui/app.test.ts` — 8 new controller camera tests.

### Tests before:
243 tests
### Tests after:
267 tests
### Test files before:
20
### Test files after:
20 (all new tests were added to the two existing map/app suites)

### Zoom:
- `[+]` / `[−]` buttons step by `ZOOM_STEP = 2` (1 → 2 → 4 → 8), wheel/trackpad
  zoom uses `factor = exp(-deltaY * 0.0015)` and zooms around the pointer
  position (`zoomBy` keeps the base point under the cursor fixed). Tested in
  Node and in the headless browser probe (100% → 400% → reset).

### Pan:
- Pointer drag on empty map surface pans; movement below `DRAG_THRESHOLD_PX
  (4)` never pans (a stray move cannot trigger a pan). Bounds clamp keeps the
  map always covering the viewport (`panX ∈ [W(1-zoom), 0]`, `panY ∈
  [H(1-zoom), 0]`).

### Reset:
- `[Reset View]` restores `zoom = 1, panX = 0, panY = 0` — the full map is
  visible again. Verified in Node + browser probe.

### Pointer/Click separation:
- A press on/near a sample point selects it and never starts a drag; starting a
  drag on a point is impossible, so a pan can never swallow selection. Drag on
  background only. Real trusted input (headless Chrome CDP): click on a point
  selects + Inspector updates; drag on background pans without selecting.

### Hover:
- Pointer coordinates are converted through the SVG letterbox mapping and the
  current camera (`pointAt`), so after zoom/pan the correct point is
  identified. Probe: tooltip over the correct sample after wheel zoom.

### Selection:
- Unchanged single `selected` (Steps 15C–15E). Works before/after zoom and pan
  (unit tests + browser probe).

### Filter interaction:
- Filters change the visible sample set only; the camera is left untouched
  (explicit controller test: zoom → setClasses → clearSearch → camera equal).

### Position invariance:
- `mapPoints(records)` returns byte-identical x/y for any camera (zoom 1/2/4/8,
  arbitrary pan). Sample positions remain exactly `mapPosition(audioFeatures)`;
  `mapPosition` itself is unchanged. §18 test present: camera never rewrites
  coordinates.

### Persistence changes:
- None. Camera state is runtime-only; no `mapZoom`/`mapPanX`/`mapPanY` fields
  are added to IndexedDB or `SampleIndexRecord`.

### MIN_ZOOM: 1
### MAX_ZOOM: 8
### DEFAULT_ZOOM: 1

### TypeScript:
PASS (`npx tsc --noEmit` clean).

### Build:
PASS (`npm run build` succeeds; only the pre-existing chunk-size warning).

### Production changes:
- UI layer only. `AnalysisPipeline`, `JobRunner`, `FeatureExtractor`,
  `Classifier(Registry)`, `IndexStore`, `QueueStore`, `SearchEngine`,
  `SampleMapMachinisteService` and `mapPosition` are all unchanged.

### Architecture changes:
- SVG gets a camera transform layer: screen-space background/axis labels +
  transformed content group (points). Camera lives in the app controller as
  runtime state; all math is pure in `mapView.ts`. No rendering engine, no new
  dependency, no state library.

### Verified:
- 267 / 20 tests green, tsc clean, build OK.
- Headless Chrome (probe page using the real `renderApp` + real `mapRender`
  with synthetic records, because the V1 UI only mounts after authentication):
  initial view 100% / `translate(0 0) scale(1)`; Zoom In ×2 → 400% /
  `translate(-1200 -780) scale(4)`; Reset → 100%; wheel zoom around pointer →
  157% with anchor-stable transform; drag-pan with bounds clamp (panY clamped
  at the limit); real trusted click selects and updates the Inspector; hover
  tooltip correct. No exceptions recorded.

### Blocked:
- Authenticated browser interaction with a real, populated Audiotool library
  (live samples, audio preview) remains BLOCKED — the existing OAuth limitation
  (Step-14) still applies. No simulated login and no fabricated results.

### Authenticated browser interaction:
BLOCKED

### Not implemented:
Zoom/pan are implemented; NOT implemented per §29: Find Similar, Similarity
Engine, k-NN / Euclidean search, Clustering, Heatmap, automatic grouping, ML,
new audio features, new classification, Machiniste workflow, Sample Editing,
Waveform Editor, tag editing, Library Census. Pinch-zoom (optional touch) and
unlimited zoom are intentionally not implemented; no point re-arrangement,
collision avoidance or jitter (overlapping points stay overlapped, §19).

### Verdict:
DONE — zoom (with bounds), pan (with bounds), reset, click/drag separation,
hover, selection and filters all verified; position invariance holds; no
persistence, no dependency, no core-system changes; all 23 acceptance criteria
met.