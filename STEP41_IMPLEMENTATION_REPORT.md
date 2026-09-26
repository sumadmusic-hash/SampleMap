# STEP41 — V2 Global Knowledge Contract & Hydration (Compact Canonical SoundCharacter)

**Status:** IMPLEMENTED + LIVE-VERIFIED (D1)
**Date:** 2026-09-09
**Frozen baseline:** STEP40_COMPACT_SIMILARITY_PERSISTENCE_REPORT.md → verdict **A** (16-bit default).

---

## 0. Executive Summary (A/B/C verdict)

| Option | What it is | Verdict |
|---|---|---|
| **A — 16-uint + null mask** | `V2.SC-v1`: 1 null-mask byte + 8×uint16, base64 (24 chars), stored as JSON TEXT in D1, hydrated into local `analysisV2` | **ADOPTED (default)** |
| B — 8-uint packed | 9-byte pack at 8-bit; would double quantization error vs 16-bit | REJECTED (documented fallback, STEP40-consistent) |
| C — full float JSON | 8 floats + mask as raw JSON (~150–180 chars in D1); defeats the compaction goal | REJECTED |

**Decisive evidence (live D1 round-trip, real remote DB):** published block returned verbatim from remote D1; decoded character matches canonical within quantization tolerance; hydrated local record carries `analysisV2` v2.0.0, quality `featureCoverage 0.875`; `rankSimilar` on live-hydrated data returned similarity `1.0` (7 shared dims) with zero re-analysis.

**Why (short):** 17-byte layout is one byte of overhead per dimension versus C while keeping ≤1/65535 error per dim versus B. The null-mask bit is authoritative — a null dimension is absent from ranking (`sharedDimensionCount` correct) and never artificially imputed.

---

## 1. STEP41 Additions (8th version lane)

A new independent version lane exists on the global knowledge block, **distinct** from every pre-existing lane:

- `codecVersion = "V2.SC-v1"` — the 17-byte pack layout (EVERYTHING in this step is versioned under this token).
- `analysisVersion = "2.0.0"` (`ANALYSIS_VERSION`) — the V2 analysis that produced the SoundCharacter.
- `similarityVersion = SIMILARITY_ALGORITHM_VERSION` ("2.0.0") — rank-compatible engine pin.
- `soundSpaceVersion = SOUND_SPACE_ALGORITHM_VERSION` ("1.0.0") — sound-space pin.
- `classificationVersion` + `confidence` — cross-checked against the analysis classification (never independent).
- `durationMs` — positive integer, must agree with `features.duration` within 2 ms.

The block is `GlobalSoundCharacterKnowledge` in `src/global/contract.ts`:

```ts
interface GlobalSoundCharacterKnowledge {
  codecVersion: "V2.SC-v1";
  packed: string;              // base64 of 17 bytes
  analysisVersion: string;     // pinned ANALYSIS_VERSION
  similarityVersion: string;   // pinned SIMILARITY_ALGORITHM_VERSION
  soundSpaceVersion: string;   // pinned SOUND_SPACE_ALGORITHM_VERSION
  classificationVersion: string;
  confidence: number;
  durationMs: number;
}
```

---

## 2. What was implemented

### 2.1 Codec — `src/global/soundCharacterCodec.ts` (+ 17 tests, green)
- `PACKED_SOUND_CHARACTER_BYTES = 17`; bit mask: bit0=brightness, 1=density, 2=transient, 3=duration, 4=tonality, 5=noisiness, 6=dynamics, 7=complexity.
- Encode: `q = round(clamp(v,0,1) * 65535)`; Decode: `q / 65535`; null dim → mask bit=1 and slot=0; **null mask authoritative** (decode reads mask, not slot).
- `packedToBase64`/`base64ToPacked` — RFC 4648; `encodeSoundCharacterToBase64` (24 chars) / `decodeSoundCharacterFromBase64` (returns `undefined` on malformed/corrupt input — never throws).
- 17-byte golden content verified; 0↔0 and 1↔1 exact; midpoint 0.5 exact; clamp out-of-range.

### 2.2 Hydration (the Find-Similar-without-reanalysis path) — `src/global/hydrate.ts`
- When `globalAnalysis.soundCharacterV2` is present **and** decodes, builds local `analysisV2 = { analysisVersion, features: fromV1AudioFeatures(v1Features) with durationSec = durationMs/1000, soundCharacter, quality: computeSoundCharacterQuality }`. The half-open `duration` null dim survives pack/hydrate.
- Corrupt block → treated as absent (same as legacy V1-style global reuse); NEVER fabricated.
- Hydration never overwrites unrelated local fields (classification, map, fingerprint, tags, status); still metadata-only (`assertNoAudioBytes` passes — test-proven).
- D1 never stores audio or UI state; x/y are persisted analysis results, colors derive from a static `semanticDotColor` map, radius stays render-derived (see §25).

### 2.3 Publish — `src/global/publish.ts`
- `createPublishCandidate` packs `record.analysisV2.soundCharacter` into the block (importing codec + engine/projector/analysis versions).
- A record without `analysisV2` publishes with the block omitted (additive; candidate still passes `validatePublishCandidate`).

### 2.4 Validation (both authorities)
- `src/global/validation.ts::validateSoundCharacterV2Knowledge` wired into `validatePublishResult`; `src/global/schemaValidation.ts::validateSoundCharacterV2Record` wired into `validateContentRecord`.
- Shared rules: codecVersion pin, `base64 → 17 bytes → validateSoundCharacter`, analysisVersion pin to `ANALYSIS_VERSION`, similarity/sound-space pins, classificationVersion+confidence cross-check vs analysis, `durationMs` ∈ ℝ₊ int within 2 ms of `features.duration*1000`.
- Version-pin design note: the block's analysis/similarity/sound-space versions are *dotted* numeric lanes (e.g. "2.0.0"); the legacy `VERSION_RE` only admits dash-shaped tokens, so these three are validated by exact pin rather than the token regex (matches the other versioned authorities: `SIMILARITY_ALGORITHM_VERSION`, `SOUND_SPACE_ALGORITHM_VERSION`, `ANALYSIS_VERSION`).

### 2.5 D1 provider & schema — `workers/d1-worker/`
- `migrations/0002_sound_character_v2.sql`: **`ALTER TABLE content ADD COLUMN sound_character_v2 TEXT;`** (nullable, JSON TEXT, additive, never BLOB).
- `src/provider.ts`: `sound_character_v2` in both SELECTs + content upsert (now 19 placeholders). Upsert is **backfill-only**: `ON CONFLICT(content_hash, content_hash_version) DO UPDATE SET sound_character_v2 = COALESCE(content.sound_character_v2, excluded.sound_character_v2)` — never clobbers a stored block. `rowToAnalysis` parses the JSON block, **omits on corrupt JSON** (row still readable), and the no-audio guard still runs on returned analysis.
- `test/fakeD1.ts`: added `isV2KnowledgeBackfill` matcher + COALESCE branch, `corruptSoundCharacterV2` hook, `dumpTables`; fixed acceptor regexes to allow digits in column identifiers (they previously dropped `sound_character_v2`, the only digit-bearing column — found and fixed during the new tests).

### 2.6 Point-size preflight (§25) — NO CODE CHANGE NEEDED
`pointRadius(zoom, emphasized)` in `src/ui/map/mapView.ts:165` is `void zoom; return emphasized ? 5*1.35 : 5` — zoom-independent; `BASE_POINT_RADIUS_PX = 5`, `SELECTED_POINT_SCALE = 1.35`; renderer divides by camera zoom (`mapRender.ts:227-228`). Regression tests already exist at `src/ui/map/mapView.test.ts:502-546` (constant 5px across zoom 0.5–8). Documented only; §25 requirement was *preflight*, no deficiency found.

---

## 3. Evidence (exact numbers)

### 3.1 Unit / integration (main project)
- `npx tsc --noEmit` (main) — **0 errors**.
- `npm test` — **73 files / 1227/1227 passed** (baseline 1186 across 71 files → **+41** STEP41 tests).
  - `src/global/soundCharacterCodec.test.ts` — 17 green.
  - `src/global/hydrate.test.ts` — 9 green (including `rankSimilar` on hydrated records, self-exclusion, corrupt→absent, no-audio).
  - `src/global/schema.test.ts` — STEP41 block describe (valid block, block-canonical JSON, absent=additive, corrupt packed, wrong length, bad codecVersion, bad similarity/soundSpace versions, classification/confidence disagreement).
  - `src/global/contract.test.ts` — STEP41 block shape (optional/additive, verbatim carry + assertNoAudioBytes, broken packed rejected, confidence disagreement, durationMs disagreement).
  - `src/global/publish.test.ts` — STEP41 candidate carries block; queue→provider payload carries it; block omitted without `analysisV2`.
- `npm run build` — build OK (one pre-existing chunk-size warning, unchanged).

### 3.2 Worker / D1 (test harness)
- `npx tsc --noEmit` (worker, includes `../src`) — **0 errors**.
- `npx vitest run` (worker) — **23/23 passed** (baseline 19 → **+4** STEP41 round-trip tests: verbatim block on both lookup paths; CHANGED-block re-publish keeps first block (COALESCE); block-less re-publish preserves stored block; corrupt stored JSON omitted, no crash).

### 3.3 E2E
- `npx playwright test` — **176/176 passed** (baseline unchanged).

---

## 4. §22 — Live D1 verification (REAL Cloudflare D1, executed)

User-authorized under strict non-destructive conditions. **Target:** `samplemap-global` (D1 uuid `fc5221fa-57d8-4fd8-ac8c-11b623a06ad6`), worker via `wrangler dev --remote` (local workerd + remote D1).

### Pre-migration state (recorded before any mutation)
- `content` table existed with **20 columns** (0001 shape, **no `sound_character_v2`**), `sample_ref` existed; **73 sample_ref rows, 11 content rows** of pre-existing data confirmed via remote `SELECT count(*)`.
- `d1_migrations` ledger was **empty**, yet 0001 tables existed (0001 was applied earlier without migration bookkeeping — pre-existing anomaly, NOT introduced here).
- Schema-only export (`--no-data`) and per-table data exports saved as backups; sha256 recorded:
  - `pre_migration_schema.sql` … `pre_sample_ref_data.sql` (73 INSERTs) `33be9f5e…e503` · `pre_content_data.sql` (11 INSERTs) `0451f19e…a734`.

### Migrations applied
- `wrangler d1 execute samplemap-global --remote --file migrations/0002_sound_character_v2.sql` — pure **`ALTER TABLE content ADD COLUMN sound_character_v2 TEXT`**: nullable, no DROP, no rewrite, no deletion, no BLOB.
- Bookkeeping: recorded `0001_initial.sql` + `0002_sound_character_v2.sql` in `d1_migrations` so a future `wrangler d1 migrations apply --remote` no longer attempts to re-apply already-present schema and fail.
- 0001 itself was **not** re-executed (tables already exist).

### Post-migration schema/data integrity
- `PRAGMA table_info(content)` → `sound_character_v2` present (1 column).
- `sample_ref_rows = 73`, `content_rows = 11` (unchanged); `non_null_blocks = 0` (existing rows remain NULL — additive); no NULL-ed hashes/classes (corruption check passed).

### Live Publish → Hydrate round-trip (one canonical payload, validated locally with 0 issues)
- `POST /publish` → `{"items":[{"status":"stored"}],"accepted":true}`.
- `POST /samples/lookup` → `status:known`, `soundCharacterV2` **verbatim** equal to the published block (`codecVersion "V2.SC-v1"`, `packed "CGZmmZmAAAAAszMzM0zNzMw="` 24 chars, versions 2.0.0/2.0.0/1.0.0, heuristic-v1, 0.9, 400).
- `POST /content/lookup` → same block verbatim; `representativeSampleId` correct (lex-min rule from a real multi-row table — a second pre-existing point was present).
- `GET /map` → live point at `(0.4, 0.6)` with correct representative, alongside the pre-existing 16I point (existing data intact).
- Hydration (`buildRecordFromGlobalAnalysis` on the live-returned analysis):
  - `BLOCK_VERBATIM true` · `CHAR_MATCH_LIVE_vs_CANONICAL true` (decoded brightness 0.4, density 0.6, transient 0.5000076…, duration null, … within 1 LSB).
  - Hydrated `analysisV2.analysisVersion = "2.0.0"`, `soundCharacter` matches canonical, `quality.featureCoverage = 0.875` (7/8), `assertNoAudioBytes` passes.
  - **`rankSimilar(liveHydrated, [twin]) → similarity 1.0, sharedDimensionCount 7`** — Find Similar works on live-hydrated data with NO audio re-analysis.

### Cleanup & final state
- Test rows deleted (`sample_ref LIKE 'samples/step41-live-%'`, the one test content identity) → remote back to **73 / 11 rows, 0 non-null blocks**; `wrangler dev` stopped.
- Warnings/anomalies: (1) pre-existing `d1_migrations` ledger gap for 0001 (now recorded); (2) `wrangler d1 list` `num_tables` counter is unreliable (showed 0 while 2 tables existed); (3) write-path auth on the Worker remains an open product decision (OQ-9) — live round-trip used the permissive dev binding, not a deployed production endpoint.

---

## 5. Non-goals respected
- No UI redesign, no sync scheduler, no ML/embeddings/ANN index, no D1 sync implementation, no changes to local IndexedDB write paths.

## 6. Artifacts
- `src/global/soundCharacterCodec.ts` (+ `.test.ts`) · `src/global/contract.ts` · `src/global/schema.ts` · `src/global/validation.ts` · `src/global/schemaValidation.ts` · `src/global/publish.ts` · `src/global/hydrate.ts` · new `src/global/hydrate.test.ts` · extended `schema/contract/publish` tests.
- `workers/d1-worker/src/provider.ts` · `workers/d1-worker/migrations/0002_sound_character_v2.sql` · `workers/d1-worker/test/{fixtures,provider,fakeD1}.ts`.
- Backups + live-verify artifacts under `/var/folders/…/T/opencode/step41-live/` (pre-migration schema/data exports, publish payload, content-lookup response, hydrate-check output).