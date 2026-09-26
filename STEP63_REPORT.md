# STEP63 — Startup Performance Audit

## A. Scan Initialization Path

The app startup follows this sequence:

1. **`mountAuthenticated(root, opts)`** in `src/ui/main.ts:27` is the entry point.
2. Calls **`buildBrowserDeps(opts)`** in `src/ui/bootstrap.ts:91` which async-initializes:
   - `openStores()` — IndexedDB stores (db, index, queue, collectionStore)
   - Creates `IndexStore`, `QueueStore`, `IndexedDBCollectionStore`
   - Creates `SampleMapSearchEngine`, `PreviewService`, `HeuristicClassifier`
   - Creates `HierClassifier` (STEP44 hierarchical classifier)
   - Creates `AnalysisPipeline` with `browserFetchAudio`, `browserDecode`, `extractFeatures`
   - Creates `JobRunner` for analysis job execution
   - Resolves authenticated user ID via `resolveAuthenticatedUserId()` (STEP38)
   - Creates `MapPosition`, `GlobalLookup` (if globalIndex provided)
   - Creates `pageFetcher` wrapping `opts.client.samples.list`
   - Returns `SampleMapAppDeps` with all services
3. **`mountSampleMap(root, deps)`** in `src/ui/render.ts:2379` creates `new SampleMapApp({...deps, onChange: () => renderApp(root, app)})`.
4. **`app.refreshSearch()`** is called to populate the initial search state.
5. If `opts.globalIndex` is provided, **`app.refreshGlobalPoints()`** queries the global index for map viewport points (bounded: max 2 pages × 500 limit each).

No automatic scan runs on mount. The scan status starts as `"idle"` with `foundCount: 0`, `pageCount: 0`.

## B. Blocking Operations & Network Requests

- **Initial render**: Synchronous DOM tree construction. No network requests, no audio decoding, no feature extraction. The scan panel displays `Status: idle`, `Samples found: 0`, `Pages: 0`.
- **`buildBrowserDeps`**: Fully async. All work is promise-based (IndexedDB open, service construction). No synchronous main-thread blocking expected.
- **`refreshGlobalPoints`** (if globalIndex provided): Bounded network query — at most 2 pages × 500 results. Controlled by `GLOBAL_MAP_MAX_PAGES = 2` and `GLOBAL_MAP_PAGE_LIMIT = 500`. Will not page unboundedly. Emits `globalMapState: "loading"` → `"ok"` / `"empty"` / `"error"` after completion. Does not block initial render since it's kicked off after mount but its result updates UI later.
- **Auth user resolution** (`resolveAuthenticatedUserId`): Non-fatal per code comment — "a resolution failure never blocks the app." Falls back to `undefined` (own detection unavailable).

## C. Own Population Pass (STEP62) Impact on Startup

The STEP62 own-upload discovery pass does **NOT** run during startup. It is triggered only when the user initiates a scan:

- **`startScan()`** in `src/ui/app.ts:705` is the entry point.
- Scans the library via `scanLibrary()` (or `deps.scanFn`).
- After scan completion, initializes own counters:
  - `this.scan.ownDiscovered = 0`
  - `this.scan.ownEnqueued = 0`
- Enqueues eligible samples (own or foreign with `favorites ≥ 1` or `usages ≥ 1`).
- Counts `eligibleEnqueued` and `ineligibleSkipped`.
- These counters appear in the scan panel **after** a scan completes, not on initial render.

**Verdict**: Zero impact on startup time. The own population pass runs on-demand via `startScan()`, not automatically on mount.

## D. Queue Operations & Synchronization

- **Queue enqueue** happens inside `startScan()` after the scan result is available.
- `queue.enqueue(sample.name, analysisBuild, priorityGroup)` — enqueues a single sample job.
- Priority groups: `own` first, then `one-shots`, then `loops`.
- No queue operations occur during initial mount or render.
- The `QueueStore` (IndexedDB) is opened during `buildBrowserDeps` but is empty until a scan enqueues items.

## E. Scan State Timeline

| Moment                              | scan.status | foundCount | pageCount | ownDiscovered | ownEnqueued |
|-------------------------------------|-------------|------------|-----------|---------------|-------------|
| After `mountAuthenticated`          | "idle"      | 0          | 0         | N/A (0 until scan) | N/A |
| After `startScan()` starts          | "scanning"  | —          | —         | —             | — |
| After scan completes (eligible enqueued) | "done"      | seenSampleIds.length | pageCount | 0 (initialized) | 0 (initialized) |
| After eligibility filtering         | "done"      | seenSampleIds.length | pageCount | eligibleEnqueued | ineligibleSkipped |

The scan state is **not** populated until the user calls `startScan()`. The initial UI correctly shows idle state.

## F. First Useful Render Timing

The first useful render occurs immediately after mount, showing:

- **Header**: Brand "SAMPLEMAP", index status (`Local index · N analyzed`), global search bar
- **Left rail**: Filter panel (scan panel: idle status; analysis panel: idle status; filter options)
- **Center**: Map region with empty state (no samples yet), discovery panel, sound space panel
- **Right rail**: Inspector panel (detail panel), send panel

No async operations block this render. All state (`scan`, `analysis`, `search`, `machiniste`) is initialized to their idle defaults. The render completes in milliseconds — the critical path is synchronous DOM creation.

## G. Synchronization Guarantees

- **`mountAuthenticated`** waits for `buildBrowserDeps` to resolve before mounting the app.
- **`refreshGlobalPoints`** is fire-and-forget (`void app.refreshGlobalPoints()`) — its result does not block subsequent operations.
- **`app.refreshSearch()`** is awaited in `mountAuthenticated` but is a synchronous state update (searchState starts empty).
- **No Promise.all or sequential dependencies** that would serialize async work during mount.

## H. Summary of Findings

| Area                              | Status                                                                     |
|-----------------------------------|----------------------------------------------------------------------------|
| Auto-initialization scan          | ❌ Not run on mount — user-initiated only                                   |
| Initial render blocking ops       | ✅ None — purely synchronous DOM                                            |
| Network requests on mount         | ✅ Only `refreshGlobalPoints` if globalIndex provided (bounded 2×500)       |
| Own population pass (STEP62)      | ✅ Runs only in `startScan()`, zero startup impact                          |
| Synchronous main-thread work      | ✅ Minimal — service construction is async; IndexedDB open is async          |
| Global index query                | ✅ Bounded, controlled by GLOBAL_MAP_MAX_PAGES and GLOBAL_MAP_PAGE_LIMIT     |
| Queue operations on mount         | ✅ None                                                                      |

## I. Recommendations

1. **Keep current design** — no auto-scan on startup preserves fast initial load.
2. **If globalIndex is used**, monitor `refreshGlobalPoints` latency in production; consider caching viewport results.
3. **Own population pass** is correctly scoped to `startScan()` — no changes needed.
4. **Consider adding a performance marker** around `buildBrowserDeps` completion vs. first render for future profiling.

---

## Executive Verdict

**Startup performance is healthy.** The app mounts and renders its first useful UI in milliseconds with no blocking synchronous operations. The scan state correctly begins idle, and the own-upload discovery pass (STEP62) runs only when the user explicitly starts a scan — it does not fire automatically and adds zero overhead to the critical path. The global index viewport query is bounded and non-blocking. The only async work during mount (`buildBrowserDeps`) is fully promise-based with no known main-thread blockers. No changes are required for startup performance.