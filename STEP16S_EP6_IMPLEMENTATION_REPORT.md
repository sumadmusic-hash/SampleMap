# STEP16S E-P6 Implementation Report — Metadata Slice (bpm / numFavorites / numUsages)

**Verdict:** `E-P6 PASS — METADATA SLICE IMPLEMENTED AND VALIDATED`

Small, isolated metadata slice implementing the read-only audit from STEP16R. Records now carry three flat, additive Audiotool source/community values (`bpm`, `numFavorites`, `numUsages`), analysis pipelines copy them verbatim from `SampleMeta`, an explicit metadata-only refresh updates them at scan time without touching analysis, and the inspector exposes them in two clearly separated blocks (Musical / Community) with no rating or popularity score invented.

## 1. Changed files

| File | Change |
|---|---|
| `src/persistence/indexStore.ts` | `SampleIndexRecord` gains optional `bpm?`, `numFavorites?`, `numUsages?` (flat, documented). No migration, no `SCHEMA_VERSION` bump. |
| `src/pipeline/analysisPipeline.ts` | `buildRecord()` copies `meta.bpm` / `meta.numFavorites` / `meta.numUsages` verbatim (`bpm 0` preserved). |
| `src/global/hydrate.ts` | `buildRecordFromGlobalAnalysis()` copies the same three fields from the resolved meta (undefined when meta is absent). Identical semantics to the pipeline path. |
| `src/ui/app.ts` | New `applyMetadataRefresh()` + integration in `startScan()` (runs over the added+changed set). Pure `get → shallow-copy 3 fields → put`. |
| `src/ui/view.ts` | `DetailView` gains `musical: MusicalView` (bpm) and `community: CommunityView` (numFavorites/numUsages). `bpm===0` preserved raw; legacy records project `null`. |
| `src/ui/render.ts` | Inspector renders the Musical block (`BPM: …`, `bpm===0 → —`) and Community block (`Favorites: …` / `Usages: …`). No score/rating UI. |
| `src/ui/samplemap.css` | Shared block styles for `.inspector-musical` / `.inspector-community`. |
| `src/e2e/harness/main.ts` | Fixture `SampleMeta`s now carry varied `bpm`/`numFavorites`/`numUsages`; `fetchCount` exposed as a live getter (audio re-fetch proof). |
| `src/persistence/indexStore.test.ts` | +4 (roundtrips ×3 + legacy-readable). |
| `src/pipeline/analysisPipeline.test.ts` | +2 (verbatim copy; `bpm 0` preserved). |
| `src/ui/step16L.test.ts` | +2 (hydrate copies slice; meta-absent → undefined). |
| `src/ui/app.test.ts` | +3 (metadata refresh semantics; partial meta no-clobber; `bpm 0` refresh). |
| `src/ui/view.test.ts` | +4 (musical/community projection; `bpm 0` raw; legacy nulls; no rating/popularity fields). |
| `e2e/ep6-metadata.spec.ts` | NEW spec, +2 (inspector blocks; metadata-only refresh no-audio-refetch). |

## 2. Data model

Flat additive optionals on `SampleIndexRecord` (matching the existing flat metadata pattern — not nested under `community:{}`):

```ts
bpm?: number;          // Audiotool double; 0 = "no tempo set", preserved as-is
numFavorites?: number; // int32 counter >= 0, raw
numUsages?: number;    // int32 counter >= 0, raw
```

- Old records simply omit the fields and stay fully readable (`undefined`, not zeroed).
- `bpm = 0` is a preserved source value; the UI renders it as `—` (see §5).
- No `qualityScore`, no `popularityScore`, no normalization formula, no rating. The community values are raw Audiotool counters and are never folded into `confidence`, `relevance`, `classification`, `mapPosition`, or search sorting.

## 3. Metadata refresh flow

`startScan()` already classifies fresh `SampleMeta`s as added/changed/unchanged. After the normal enqueue, `applyMetadataRefresh(meta)` is now invoked for every observed fresh meta (`added` + `changed`):

```
fresh SampleMeta (from scan pool)
        ↓ applyMetadataRefresh
index.get(sampleId) → existing record?
        ↓ no            ↓ yes
   (skip; it will be   shallow-copy { ...existing }
    created by the     write bpm / numFavorites / numUsages
    analysis queue)    → index.put(refreshed)   ← metadata-only write
```

- If the record does not exist yet (an `added` sample), the refresh is a safe no-op — the record is created later by the normal analysis job.
- Only the three fields are assigned; everything else on the existing record is preserved verbatim by the atomic object swap.
- If a fresh meta omits a field, the existing stored value is kept (no clobbering to `undefined`) and `bpm: 0` on a fresh meta is stored as `0`.
- It never downloads audio, never decodes, never re-extracts features, never re-classifies, never recomputes `mapPosition`, and never starts a `JobRunner`.

## 4. Persistence compatibility

- No IndexedDB schema migration and no `SCHEMA_VERSION` bump — the three fields are plain additive JSON properties.
- Legacy records without the fields: verified readable with all existing invariants intact (test: `reads a legacy record that omits the metadata fields`).
- New records: `put`/`get` roundtrip all three (`bpm` incl. `0`, `numFavorites`, `numUsages`).
- `assertNoAudioBytes` continues to hold — the refresh only ever adds numbers and append-only records carry no audio bytes.

## 5. Inspector changes

Two clearly separated blocks, rendered between Original Tags and Map Position:

```
Musical
  BPM: 128          (d.musical.bpm === 0 || null → "BPM: —")

Community
  Favorites: 42     (numFavorites ?? "—")
  Usages: 187       (numUsages ?? "—")
```

- `bpm === 0` (source value "not set") renders `BPM: —`; legacy records (no field) render the same.
- No stars, no rating, no popularity badge, no quality score anywhere in the inspector (enforced by e2e + unit tests).
- No changes to the result rows, tooltip, map encoding, or any sort/filter surface (§6 of the spec remains untouched).

## 6. Tests

| File | Added | Coverage |
|---|---|---|
| `indexStore.test.ts` | +4 | bpm roundtrip (incl. `0`), numFavorites roundtrip, numUsages roundtrip, legacy record without fields stays readable |
| `analysisPipeline.test.ts` | +2 | `buildRecord` copies meta → bpm/favorites/usages verbatim; `bpm 0` preserved |
| `step16L.test.ts` | +2 | `buildRecordFromGlobalAnalysis` copies slice from resolved meta; undefined when meta absent (same semantics) |
| `app.test.ts` | +3 | metadata refresh updates the slice while `primaryClass`/`confidence`/`audioFeatures`/`mapPosition`/`analyzedAt`/`analysisBuild` stay identical; partial meta never clobbers; `bpm 0` preserved on refresh |
| `view.test.ts` | +4 | musical/community projection; `bpm 0` raw (`—` at render); legacy → nulls; no rating/popularity/quality fields |
| `e2e/ep6-metadata.spec.ts` | +2 | inspector blocks (normal BPM, `bpm 0 → —`, Favorites/Usages, no rating text); metadata-only refresh preserves analysis and does not re-fetch audio |

The refresh tests explicitly prove **no analysis / re-fetch chain**: `createRunnerCalls` stays empty and the store write happens exactly once (app), and the live `fetchCount` is byte-identical across the scan (e2e).

## 7. Build / TypeScript status

| Gate | Result |
|---|---|
| `tsc --noEmit` (app) | 0 errors |
| `tsc --noEmit` (workers/d1-worker) | 0 errors |
| `vitest run` (app) | 609/609 (32 files; baseline 594 + 15 new) |
| `vitest run` (workers/d1-worker) | 19/19 (unaffected — worker only consumes passage types) |
| `npm run build` | PASS (pre-existing >500 kB chunk advisory only) |

## 8. E2E status

`playwright test` → **45/45** (43 frozen E-P0…E-P5A + 2 new EP6 in `e2e/ep6-metadata.spec.ts`), `fullyParallel: false`, shared page per spec.

## 9. Confirmation: no audio re-fetch / decode for metadata refresh

Confirmed by construction and by test:

- `applyMetadataRefresh` is a `index.get` → object swap of three numeric fields → `index.put`. It has no path to `fetchAudio`, `decode`, `extract`, `classify`, or `computePosition`, and no `JobRunner` is created.
- App unit test: `createRunnerCalls === []`, exactly one store write, analysis fields deep-identical.
- E2e `EP6-02`: the live `__sm.fetchCount` counter is unchanged after a rescan that refreshes metadata on an already-analyzed record.

## 10. Confirmation: no changes to E-P5 / E-P6 invariants

Re-verified with the existing suites, all green:

- V2 `mapPosition` stays authoritative; a missing V2 stays without a map point.
- Focus ≠ selection; arrow-key navigation (E-P5A T4) untouched.
- Selection survives filters; selection ≤ 8 cap intact.
- Search/filter/sort mutate neither map position nor selection.
- Camera stays runtime-only; Esc clears neither filters nor search.
- No audio is persisted (`assertNoAudioBytes` enforced through `put`).
- Machiniste Direct Reference, first-use flow, send/preview/similar surfaces unchanged.
- E-P0…E-P5A remain green (43/43 prior e2e tests unchanged and passing).

## 11. Remaining future work

Intentionally NOT implemented (explicitly out of this slice, pending Product decisions):

- Favorites/Usages/BPM sorting and filtering (`SearchSort`/`IndexQuery` untouched).
- Popularity ranking / derived scores.
- Map-point encoding or tooltip extensions from community data.
- Result-row exposure of the metadata.
- T1 (low-confidence visual ring) remains BLOCKED per the E-P5A report.