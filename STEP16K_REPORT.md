# Step 16K — Global Map Integration: Final Report

## 1. Audit

Full codebase exploration of `src/ui/`, `src/map/`, `src/global/`, `src/pipeline/`, `src/persistence/`, `src/similarity/` confirmed:

- **Architecture rule**: NO second analysis pipeline. Global data flows through existing `GlobalLookup → GlobalAnalysisResult → SampleIndexRecord`.
- **Content identity** (`contentHashVersion + contentHash`) is the merge key — not sample name or sampleId.
- `GlobalSampleIndex.queryMapViewport(viewportQuery)` returns `GlobalMapPoint[]` with bounding box, limit, cursor — viewport-orientated loading required.
- Camera must NOT be reset by global loading; filters must NOT change camera.
- `mapPoints()` already handles content-identity dedup via `contentIdentityKey()`.
- `selectGlobalPoint()` flow: check local match → resolve sample metadata → enqueue + run pipeline (16J reuse) → refreshSearch.

## 2. Design

**Minimal change set** — 5 existing files modified, 1 new test file, no new types:

| Change | File | Description |
|--------|------|-------------|
| Extend `MapPoint` | `src/ui/map/mapView.ts` | Add `origin?: "local" \| "global"` |
| Add converters | `src/ui/map/mapView.ts` | `globalMapPoints()`, `mergeMapPoints()` |
| Render global | `src/ui/map/mapRender.ts` | Accept `globalPoints` + `onSelectGlobal`; merge and render |
| Controller logic | `src/ui/app.ts` | `refreshGlobalPoints()`, `selectGlobalPoint()`, new deps |
| Bootstrap wiring | `src/ui/bootstrap.ts` | Return `globalIndex` + `resolveSample` |
| Render wiring | `src/ui/render.ts` | Pass global data to map; trigger refresh on camera change |
| Mount entry | `src/ui/main.ts` | Call `refreshGlobalPoints()` if globalIndex present |

## 3. Production Changes

### `src/ui/map/mapView.ts`
- Added `origin?: "local" | "global"` to `MapPoint` interface
- Added `globalMapPoints(points: GlobalMapPoint[]): MapPoint[]` — converts global map data with `origin: "global"`
- Added `mergeMapPoints(local: MapPoint[], global: MapPoint[]): MapPoint[]` — merges local+global with local precedence by content identity

### `src/ui/map/mapRender.ts`
- Added `globalPoints: GlobalMapPoint[]` and `onSelectGlobal?: (point: MapPoint) => void` to `SampleMapRenderOptions`
- Merge local + global points in `renderSampleMap()` before rendering
- Click handler routes global-only points to `onSelectGlobal`

### `src/ui/app.ts`
- Added `globalIndex?: GlobalSampleIndex` and `resolveSample?: (id: string) => Promise<SampleMeta | undefined>` to `SampleMapAppDeps`
- Added `globalPoints: GlobalMapPoint[]` state
- Added `refreshGlobalPoints()` — bounded viewport query, error-swallowed (graceful degradation)
- Added `selectGlobalPoint(point)` — local check → resolve → enqueue → pipeline (16J reuse) → refreshSearch

### `src/ui/bootstrap.ts`
- Returns `globalIndex` and `resolveSample` in deps when available

### `src/ui/render.ts`
- `renderMapPanel` passes `globalPoints` + `onSelectGlobal` to map renderer
- `onCamera` triggers `refreshGlobalPoints()`

### `src/ui/main.ts`
- `mountAuthenticated` calls `refreshGlobalPoints()` if globalIndex is provided

## 4. Tests

**20/20 tests PASS** in `src/ui/globalMapIntegration.test.ts`:

| Test | What it verifies |
|------|------------------|
| A (×2) | `globalMapPoints()` correctly converts `GlobalMapPoint[] → MapPoint[]` with all fields + origin |
| B | Content dedup: local + global same hash → 1 point, local takes precedence |
| C | Different content hashes → 2 merged points |
| D | KNOWN: global points appear on map without local records |
| E | UNKNOWN: `selectGlobalPoint` enqueues + creates runner for unknown sample |
| F (×2) | UNAVAILABLE: `refreshGlobalPoints` swallows errors, keeps previous state; local search still works |
| G | Camera: `refreshGlobalPoints` does not alter mapCamera |
| H | Selection: `selectGlobalPoint` selects existing local record |
| I | Inspector: selected record has all inspector fields |
| J | Preview: `previewUrlFor` returns Audiotool preview URL |
| K | Similarity: `findSimilar` works with global sample fingerprint as query |
| L | Machiniste: selected record can be sent to Machiniste |
| M (×3) | No audio bytes in globalMapPoints, mergeMapPoints, or local MapPoints |
| N | Viewport bound: `refreshGlobalPoints` queries with bounded limit |
| O (×2) | Identity: same contentHash → single point; local + two global same hash → one merged |

## 5. Functional Verification

| Check | Status |
|-------|--------|
| Global points render on map | ✓ Test D |
| Local precedence on merge | ✓ Test B, O |
| Content dedup across origins | ✓ Test B, O |
| Camera not affected by global load | ✓ Test G |
| UNKNOWN sample → local analysis pipeline | ✓ Test E |
| UNAVAILABLE backend → graceful degradation | ✓ Test F |
| Inspector shows all fields from resolved global sample | ✓ Test H, I |
| Preview works via Audiotool reference | ✓ Test J |
| Similarity search works with global fingerprint | ✓ Test K |
| Machiniste send works with resolved global sample | ✓ Test L |
| No audio bytes in any map point model | ✓ Test M |
| Bounded viewport query | ✓ Test N |

## 6. Live Verification

| Check | Status |
|-------|--------|
| `GET /map` responds with `mapVersion` and `points[]` | ✓ VERIFIED (empty array as expected — no global samples published yet) |
| Response format matches `GlobalMapViewportResult` contract | ✓ VERIFIED |
| End-to-end: publish global sample → `GET /map` returns point → UI renders | NOT VERIFIED (no global sample published) |

## 7. Regression

| Suite | Result |
|-------|--------|
| App tests | 499/499 ✓ |
| Worker tests | 19/19 ✓ |
| tsc --noEmit | clean ✓ |
| vite build | pass ✓ |

## 8. Open Questions

1. **E2E global publish → map render**: To fully verify end-to-end, a global sample must be published via `POST /samples` and then `GET /map` queried. This requires either a real backend publish or a scripted roundtrip test. The 16J infrastructure already confirmed the publish → lookup flow works; 16K adds the `/map` layer on top.

## 9. FINAL VERDICT

**PARTIALLY VERIFIED** — All offline tests pass (20/20 + 499/499 regression). Live endpoint responds correctly. Full end-to-end (publish global sample → see it on the map → select → resolve → analyze) requires publishing a global sample to the live backend, which is outside the scope of this step's test infrastructure. The code path is exercised by unit tests and the live `/map` endpoint is confirmed responsive.
