# STEP28 IMPLEMENTATION REPORT

## §0 Verdict

**STEP28 PASS — PERSISTENT SOUND COLLECTIONS IMPLEMENTED AND VALIDATED**

Persistent Sound Collections (IndexedDB, references-only, lifecycle CRUD, dirty
tracking, honest errors, unsupported-version surfacing, confirm dialogs, frozen
V1/V2 surfaces) are implemented, tested and validated against a full regression
baseline: typecheck clean, **1095/1095** vitest (65 files), **19/19** d1-worker,
**176/176** Playwright (156 baseline + 20 STEP28 E28-01..E28-20 with real page
reload), build PASS.

---

## §1 Executive Summary

STEP28 persists the STEP27 working "My Sounds" collection (and any additional
user-created collections) as **references only** — sampleIds plus metadata — in a
dedicated IndexedDB object store. It adds a full lifecycle: create, rename, save,
save-as, load, switch, delete, and an explicit confirmation dialog for
unsaved-switch and delete (with "samples NOT deleted" messaging). Every corrupt
and unsupported-version record is surfaced honestly to the user; no silent
repair, truncation, deduplication, deletion or guessing. The frozen V1 and V2
surfaces remain completely untouched.

**Key files added:**
- `src/analysis/collectionPersistence.ts` — pure serialization/validation core
- `src/analysis/collectionPersistence.test.ts` — 30 tests (P01..P17)
- `src/persistence/collectionStore.ts` — `CollectionStore` interface + IndexedDB adapter
- `src/persistence/collectionStore.test.ts` — 14 tests (S-01..S-11)
- `src/persistence/collection.bench.perf.test.ts` — 5 envelope tests
- `src/ui/step28.collection.test.ts` — 22 app-level integration tests

**Key files modified:**
- `src/persistence/db.ts` — SCHEMA_VERSION 2→3, `collections` store added
- `src/ui/app.ts` — STEP28 collection-persistence actions/state/deps
- `src/ui/view.ts` — STEP28 manager view-models
- `src/ui/render.ts` — STEP28 collection manager panel + confirm dialogs
- `src/ui/samplemap.css` — STEP28 manager styles
- `src/ui/bootstrap.ts` — CollectionStore wired into browser deps
- `src/e2e/harness/main.ts` — CollectionStore wired into e2e harness deps

---

## §2 Repository Baseline (pre-STEP28)

| Gate | Before | After |
|------|--------|-------|
| typecheck | 0 errors | 0 errors |
| vitest | 1024 / 1024 (61 files) | 1095 / 1095 (65 files) |
| d1-worker | 19 / 19 | 19 / 19 |
| Playwright | 156 / 156 | 176 / 176 (156 baseline + 20 STEP28) |
| build | PASS | PASS |

Net test delta: **+71 tests** (30 core + 14 store + 22 app + 5 perf)
plus **+20 Playwright e2e** (E28-01..E28-20 with real reload).

---

## §3 Files Changed

### Created (6 files)
| File | Purpose |
|------|---------|
| `src/analysis/collectionPersistence.ts` | Pure persistence core: schema version, normalize, create, validate, serialize, withUpdated |
| `src/analysis/collectionPersistence.test.ts` | 30 pure tests (P01..P17) |
| `src/persistence/collectionStore.ts` | `CollectionStore` interface + `IndexedDBCollectionStore` adapter |
| `src/persistence/collectionStore.test.ts` | 14 IndexedDB adapter tests (S-01..S-11) |
| `src/persistence/collection.bench.perf.test.ts` | 5 performance envelope tests |
| `src/ui/step28.collection.test.ts` | 22 app-level integration tests |
| `e2e/step28.spec.ts` | 20 Playwright e2e tests (E28-01..E28-20) with real reload |

### Modified (7 files)
| File | Change |
|------|--------|
| `src/persistence/db.ts` | SCHEMA_VERSION 2→3; `STORES.collections`; v2→v3 migration |
| `src/ui/app.ts` | STEP28 collection lifecycle state/actions; `collectionStore?` dep |
| `src/ui/view.ts` | STEP28 manager view-models and label constants |
| `src/ui/render.ts` | STEP28 `renderCollectionManagerPanel` + `renderCollectionList` + confirm dialogs |
| `src/ui/samplemap.css` | STEP28 manager styles |
| `src/ui/bootstrap.ts` | CollectionStore wired into `SampleMapAppDeps` |
| `src/e2e/harness/main.ts` | CollectionStore wired into e2e harness deps |

### Unmodified
All V2 surfaces (`soundCharacter`, `soundSpaceProjector`, `searchEngine`,
`discovery`, `similarityRanking`), the Machiniste/publish pipeline, and the
STEP27 pure boundary (`collection.ts`) are **completely untouched**.

---

## §4 Architecture

```
  UI (render.ts / view.ts)
          │
          ▼
  app.ts (SampleMapApp — lifecycle orchestration, dirty state, confirm dialogs)
          │
          ├──────────────────────────┐
          ▼                          ▼
  collectionPersistence.ts     collectionStore.ts
  (PURE boundary — serialize,    (IndexedDB adapter — list, get, put, delete;
   validate, normalize, create;   validates on read via the pure boundary;
   never any DOM/IDB/network)     audio-ban enforced defensively)
          │
          ▼
     db.ts (SCHEMA_VERSION 3, migrations)
          │
          ▼
     ElasticDB → fake-indexeddb / real IndexedDB
```

**Key invariant:** the pure core never touches IndexedDB; the store never
serializes. `validatePersistedCollection` runs on both write (via
`serializeCollection`) and read (via `get`/`list`), so corrupt data is always
detected and surfaced.

---

## §5 Persistence Schema

**IndexedDB store:** `collections` (keyPath `"id"`, optional index `updatedAt`).
**Schema version:** 3 (incremented from 2; v2→v3 migration creates the store).

**Persisted document shape** (metadata + references only, no audio bytes):
```ts
interface PersistedSoundCollection {
  id: string;              // immutable, collision-resistant (UUID or high-entropy fallback)
  name: string;            // 1–100 Unicode code points, trimmed
  sampleIds: readonly string[];  // at most 50, no duplicates, authoritative order
  createdAt: number;       // ms epoch, immutable after creation
  updatedAt: number;       // ms epoch, advanced ONLY after successful persistence
  version: string;         // "1.0.0" — persistence schema version (distinct from in-memory)
}
```

**Migration:** `SCHEMA_VERSION` incremented to 3. `openDatabase` upgrade
callback: `oldVersion < 3 && oldVersion >= 2` creates the `collections` store
(keyPath `"id"`, index `"updatedAt"`). `oldVersion < 1` creation path includes
the store for fresh databases.

---

## §6 Collection Lifecycle

| Action | Behavior |
|--------|----------|
| **New Collection** | Resets working set to empty; `activeCollectionId = null`; name = "New Collection"; dirty = false (nothing persisted). |
| **Rename** | Updates `collectionName` via `normalizeCollectionName`; marks dirty; invalid names set error and dirty. |
| **Save** | If `activeCollectionId === null` → save-as semantics (create new). Else reads existing, applies `withUpdatedCollection`, puts, stamps `updatedAt`, clears dirty. Failure: dirty stays true, error surfaced, retry allowed. |
| **Save As** | Always creates a new collection with fresh id; preserves current name + ordered sampleIds. Never overwrites. |
| **Load** | Reads by id; restores ONLY name + ordered sampleIds (§28). Registers current index records in `knownRecords` for availability. Re-resolves stale ids against current index. Dirty = false. Does NOT restore selection/preview/focus/search/filters/Discovery/Machiniste/playback; no reanalysis. |
| **Switch** | If dirty → unsaved-switch confirmation dialog (Save & Switch / Discard & Switch / Cancel). If clean → direct load. |
| **Delete** | Explicit confirmation ("samples NOT deleted"). On success, removes from store. If deleted collection was active → `activeCollectionId = null`, dirty = true (working set becomes an unsaved draft). |

**Boot:** `activeCollectionId = null` always. No auto-restore, no hidden
"last-used" persistence. The manager lists stored collections on open.

---

## §7 Error Handling

| Scenario | Behavior |
|----------|----------|
| Corrupt stored record | `validatePersistedCollection` returns `ok: false`, `kind: "corrupt"`. Surfaced in manager as "Corrupt — kept, not deleted". Never dropped, repaired, truncated, deduplicated or guessed (§20). |
| Unsupported version | `kind: "unsupported-version"` with `unknownVersion` string surfaced. Row preserved. Delete button disabled. Never mutated, deleted or version-guessed (§21). |
| Save failure | Working set unchanged. `collectionDirty = true`. Error message surfaced. Retry allowed (§26). |
| Load of missing/corrupt | `loadError` surfaced. Working set unchanged. |
| Delete failure | Collection preserved. `deleteError` surfaced. |
| `collectionStore` absent | Manager opens; all persistence actions surface "persistence unavailable" error. Buttons disabled. |

---

## §8 Stale Sample Behavior

On load and on `openCollection`, `refreshCollectionKnownIds()` re-syncs the
current index via `index.getAll()`. Every loaded sampleId that still exists in
the index is marked **available** (record resolvable, preview playable, focusable).
Every loaded sampleId that no longer exists in the index is marked **unavailable**
with the honest "Unavailable sample" label — it is **never** dropped, never
crashes and never silently repaired (§36, §27/§28).

---

## §9 Frozen Surface Verification

**V1 (STEP16M/16R/16V/17/19A):** selection, preview, Machiniste, usage
acceptance, publish, global index — **untouched**. STEP28 never writes to
`selectedSampleIds`, `focusedSampleId`, `previewSampleId` or any V1 state field.
The `loadCollection` action deliberately does NOT restore these (§28).

**V2 (STEP20/24/25/26):** SoundCharacter, AudioFeaturesV2, DSP, similarity,
projection, filtering, Discovery, SearchEngine — **untouched**. The collection
manager uses `refreshCollectionKnownIds` (which calls `index.getAll()`) to
re-resolve members against the CURRENT V2 index; it never re-analyzes,
reprojects or mutates any V2 state.

**STEP27 (sound collection boundary):** `collection.ts` with
`COLLECTION_MAX_SAMPLES = 50`, `emptyCollectionState`, `addToCollection`,
`removeFromCollection`, `clearCollection` — **untouched**. STEP28 adds persistence
on top; the STEP27 pure boundary and all STEP27 tests remain unchanged.

---

## §10 Tests

### Core persistence boundary (P01..P17) — `collectionPersistence.test.ts`
30 tests, 100% pure (no IndexedDB):
P01 deterministic serialization; P02 round-trip equality; P03 create defaults;
P04 50-member boundary; P05 51 rejected; P06 duplicate rejected; P07 invalid id;
P08 invalid name; P09 name normalization (trim, ≤100 code points, emoji
surrogate pairs); P10 unsupported version; P11 missing fields; P12 invalid
timestamps; P13 order preserved; P14 stale ids preserved; P15 immutability;
P16 withUpdatedCollection; P17 create guards + newCollectionId uniqueness.

### IndexedDB adapter (S-01..S-11) — `collectionStore.test.ts`
14 tests against real fake-indexeddb:
S-01 put/get; S-02 list empty; S-03 deterministic ordering (updatedAt DESC,
id ASC); S-04 update in place; S-05 delete + no-op; S-06 same-name allowed;
S-07 reload across close/reopen; S-08 corrupt surfacing + put refuses corrupt;
S-09 unsupported version preserved; S-10 isolation (no touch to samples/jobs),
audio-ban on put; S-11 write failure propagated.

### App integration — `step28.collection.test.ts`
22 tests against real indexeddb + full app controller:
initial state; manager list; create/rename/dirty; save (no active → save-as);
save updates updatedAt; save-as creates fresh id; save failure stays dirty;
load restores name+ids only; load surfaces unsupported-version; delete active →
dirty; delete non-active unchanged; switch triggers confirm; save-then-switch;
cancel switch; load doesn't restore selection/focus; stale members shown
unavailable; list surfacing corrupt+unsupported entries; dirty marks from
STEP27 mutations; openCollection refreshes availability.

### Performance envelope — `collection.bench.perf.test.ts`
5 tests: create <100ms, save 50 <100ms, load <100ms, list 100 <250ms,
delete <100ms — all within target (measured against real fake-indexeddb).

---

## §11 Playwright

E2E Playwright suite: **176/176** passing (156 frozen baseline + STEP27 E27-01..
E27-23, plus **20 new STEP28 tests E28-01..E28-20** in `e2e/step28.spec.ts`).

The STEP28 e2e tests drive the REAL UI in REAL Chrome with the REAL IndexedDB
`"samplemap"` database and assert persistence across genuine browser reloads
(`page.reload()`):

| Test | Scenario |
|------|----------|
| E28-01 | boot: `activeCollectionId === null`, no auto-restore, empty manager list |
| E28-02 | adds → dirty; New Collection resets working set |
| E28-03 | rename → dirty `*` marker in status label |
| E28-04 | save with no active → creates new, dirty=false |
| E28-05 | **reload** → saved collection reappears in manager list |
| E28-06 | load restores name + ordered ids only (selection stays empty) |
| E28-07 | **reload** → order persists exactly through save → reload → load |
| E28-08 | Save As creates a new entry, never overwrites |
| E28-09 | switch triggers unsaved-switch dialog (Save/Discard/Cancel) |
| E28-10 | cancel switch → dialog closes, dirty working set preserved |
| E28-11 | discard-and-switch loads the target, drops working set |
| E28-12 | save-and-switch persists dirty edits then loads target (**reload** verified) |
| E28-13 | delete → explicit confirmation with "samples NOT deleted" |
| E28-14 | cancel delete → collection preserved |
| E28-15 | confirm delete → removed, active-collection id nulled |
| E28-16 | **reload** → deleted collection stays deleted |
| E28-17 | stale-member collection loads, member preserved (never dropped) |
| E28-18 | cap 50: 51st add is a no-op, **reload** → order/members identical |
| E28-19 | keyboard: manager toggle opens/closes via Enter |
| E28-20 | console audit: no unhandled application errors across the session |

The STEP28 e2e suite exercises the same real app + harness code path as the
156-test baseline, proving the new render/CSS/manager work and the reload
durability of the `collections` object store.

---

## §12 Performance

All performance targets met in unit-level `collection.bench.perf.test.ts`
against real fake-indexeddb:

| Operation | Target | Actual (typical) |
|-----------|--------|-----------------|
| create (empty) | <100ms | <5ms |
| save 50-member | <100ms | <15ms |
| load (get) | <100ms | <5ms |
| list 100 | <250ms | <50ms |
| delete | <100ms | <5ms |

---

## §13 Console Audit

No unhandled application errors across the STEP28 test session. The Playwright
console audit (E27-23) already confirms no console errors on the baseline.
STEP28 app tests use real IndexedDB and register no global error handlers that
would mask uncaught exceptions.

---

## §14 Build

`npm run build` — PASS (752ms, chunks ≤500kB warning is pre-existing). No new
chunks or lazy-load boundaries added by STEP28.

---

## §15 Evidence Classification

| Test file | Classification | Notes |
|-----------|---------------|-------|
| `collectionPersistence.test.ts` | **CONSTRUCTED** | Pure boundary; hand-crafted fixtures, no real audio |
| `collectionStore.test.ts` | **REAL** (IndexedDB) | Real fake-indexeddb; no audio |
| `step28.collection.test.ts` | **REAL** (IndexedDB + app) | Real indexeddb + real controller + FIXTURE-class V2 analysis |
| `collection.bench.perf.test.ts` | **REAL** (IndexedDB) | Performance envelope against real storage |
| STEP27 tests (unchanged) | MIX | Pre-existing, unchanged by STEP28 |
| Playwright (156) | REAL | Pre-existing baseline |

---

## §16 Deviations

1. **Collection list ordering (§46):** The spec required a deterministic
   documented decision for list ordering. Decision: `updatedAt DESC` (most
   recently updated first) with `id ASC` as the stable tiebreak. This is
   deterministic, stable, and a natural UX (recently active collections first).
   Implemented in `collectionStore.ts:compareRows`.

2. **Save with no active collection:** The spec implied Save requires an active
   backing collection. Implemented: when `activeCollectionId === null`, Save
   behaves as Save-As (creates a new persisted collection). This avoids a dead
   button and is the natural UX.

3. **refreshCollectionKnownIds enhanced:** To resolve loaded collection members'
   records for focus/preview/name display, `refreshCollectionKnownIds` now also
   hydrates `knownRecords` from the current index. This is harmless (registry
   growth bounded by index size) and avoids requiring a separate re-resolution
   step on load.

4. **Delete active collection dirty semantics:** When the active collection is
   deleted, the working set persists and `collectionDirty` is set to `true` iff
   the working set is non-empty (an honest signal that there is no backing
   collection). If the working set is empty after delete, dirty stays `false`.

---

## §17 Open Questions

None. The formerly-deferred E28 Playwright e2e suite (E28-01..E28-20) has been
implemented and passes with real browser reloads against the same persistent
`"samplemap"` IndexedDB database. The full STEP28 surface is now covered end to
end (unit → adapter → app → e2e → perf).

---

## §18 Final Verdict

**STEP28 PASS — PERSISTENT SOUND COLLECTIONS IMPLEMENTED AND VALIDATED**

All required infrastructure is in place:
- Pure persistence core (P01..P17 validated)
- IndexedDB adapter (S-01..S-11 validated, including corrupt/unsupported-version/isolation)
- App lifecycle (22 app-level tests validated)
- Performance envelope (all targets met)
- E2E with REAL browser reload (E28-01..E28-20, all passing)
- Full regression: typecheck 0, vitest 1095/1095, d1 19/19, Playwright 176/176, build PASS
- Frozen V1/V2 surfaces completely untouched

The STEP28 codebase is production-eligible with respect to persistence
correctness, honest error surfacing, frozen-surface invariants and regression
safety.
