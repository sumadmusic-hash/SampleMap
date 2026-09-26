# STEP 15I REPORT — Content Identity, Deduplication & Map Points

**Date**: 2026-09-02
**Baseline**: 270 tests / 20 files — tsc clean — build OK
**Result**: 287 tests / 21 files — tsc clean — build OK

---

## A — Implemented

Step 15I is implemented as a **projection-layer deduplication of Map Points**
by Audio Content Identity, layered strictly ON TOP of the existing 15H
contentHash pipeline. The 15H architecture was **not** redesigned:

- **New module** `src/identity/audioContentIdentity.ts` — the `AudioContentIdentity`
  type, a deterministic content-identity key, and a versioned representative
  selection rule.
- **New test module** `src/identity/audioContentIdentity.test.ts` — 17 tests.
- **`mapView.ts` enhanced** — `MapPoint` now carries the content identity +
  all member `sampleIds`; `mapPoints()` groups records by content identity and
  emits exactly one point per unique identity.
- **Test fixture added** — `buildPcmWavBytesWithExtraChunk` in
  `src/audio/fixtures.ts` (minimal, no production-architecture change) to prove
  cross-container contentHash equality (§11).
- **No schema change**: `SampleIndexRecord` already carries `contentHash` /
  `contentHashVersion` from 15H; 15I adds no new persisted fields. The pipeline,
  queue, index schema, search engine, preview, machiniste, inspector, selection,
  zoom/pan are untouched.

## B — Data Model

New type:

```ts
interface AudioContentIdentity {
  contentHash: string;        // SHA-256 hex of canonicalized PCM
  contentHashVersion: string; // e.g. "pcm-v1"
}
```

`MapPoint` (already existed as display type) extended:

```ts
interface MapPoint {
  sampleId: string;                     // representative (lex-smallest)
  sampleIds: readonly string[];         // ALL Audiotool samples in the group
  contentIdentity: AudioContentIdentity; // TRUE identity of the point
  name / owner / primaryClass / confidence / originalTags; // from representative
  x / y;                                // from representative's audioFeatures
}
```

Representative rule versioned: `REPRESENTATIVE_VERSION = "representative-v1"`.

## C — Identity Rules

The central chain (spec invariant):

```
Audiotool Sample ID  ->  Sample Reference
(contentHashVersion, contentHash)  ->  Audio Content Identity  ->  Map Point
```

- A Map Point's identity is **`(contentHashVersion, contentHash)`**, NOT
  `sampleId`.
- Group key: `contentIdentityKey(id) = "contentHashVersion:contentHash"`.
- Records **without** a contentHash (legacy / pre-15H) degrade gracefully: each
  such record forms a unique identity (one record = one point), so existing
  behavior is preserved and no record is lost or falsely merged.

## D — Representative Selection

Rule: **lexicographically smallest `sampleId`** in the group.

- Deterministic, reproducible, independent of scan order and job order.
- Versioned via `REPRESENTATIVE_VERSION = "representative-v1"`.
- Classifier data and original Audiotool tags of each member remain their own;
  the point displays the **representative's** name/owner/class/tags. No member
  is destroyed; all are preserved in `sampleIds`.

## E — Deduplication

`mapPoints(records)`:

1. Skips non-`analyzed` / featureless records (unchanged from 15B).
2. Groups balanced records by content identity.
3. Dedupes `sampleIds` within a group (Set), sorts, picks the representative.
4. Emits exactly ONE point per identity, positioned from the representative's
   `audioFeatures` via the unchanged `mapPosition()` (15B invariant preserved).

Effects:

- `A,B,D → X`, `C → Y`  ⇒  2 Map Points (§9).
- Idempotent re-analysis of the same sample ⇒ 1 point, 1 sample reference (§10).
- Same content, different Audiotool IDs ⇒ 1 point with `sampleIds = [AAA, BBB]` (§13).

## F — Tests

```
before:  270 tests
after:   287 tests   (+17, all from Step 15I)
```

New tests cover (§11–§14) exactly:

- `AudioContentIdentity` type: key determinism, hash difference, version difference.
- `selectRepresentative`: lex rule, order-independence (BBB/AAA/CCC reversed),
  single-element, version constant.
- **Cross-format contentHash (§11)**: two WAV containers with identical PCM but
  different container bytes (extra `LIST` chunk) produce the **same** `contentHash`.
- Different PCM content ⇒ **different** `contentHash` (§12).
- **Dedup**: same-hash → 1 point; different-hash → 2 points; A=B=X, C=Y → 2 points
  with correct `sampleIds` (§9).
- **Idempotency**: duplicate record of same sample → 1 point (§10).
- **Representative order-independence** (§14), representative metadata used,
  legacy (unhashed) graceful degradation.

## G — Verification

| Claim | Status |
|---|---|
| 1 content identity = 1 map point | **VERIFIED** (unit tests) |
| Same content across different containers → same contentHash (WAV vs WAV-with-extra-chunk) | **VERIFIED** (unit test, §11) |
| Different content → different contentHash | **VERIFIED** (unit test, §12) |
| Different Audiotool IDs, same content → 1 point, sampleIds=[AAA,BBB] | **VERIFIED** (unit test, §13) |
| Representative = lex-smallest, order-independent | **VERIFIED** (unit tests, §14) |
| Idempotent re-analysis → 1 point | **VERIFIED** (unit test, §10) |
| Legacy/unhashed records degrade gracefully (no loss, no false merge) | **VERIFIED** (unit test) |
| Existing 270 tests stay green | **VERIFIED** (287/287 pass) |
| No audio bytes in IndexedDB/Queue/Index stores | **VERIFIED** (no schema change; `assertNoAudioBytes` untouched and all prior INV-1 tests pass) |
| **Real WAV vs real FLAC** file of the same sample → same contentHash | **NOT VERIFIED** (needs authenticated PAT + browser decode; same limitation as 15H §13-1; canonical determinism is proven at the PCM level in unit tests) |

## H — Build

```
TypeScript (npx tsc --noEmit): 0 errors
Build (npm run build):         OK
Tests (npm test):              21 files, 287 tests, 287 passed, 0 failed
```

---

## STEP 15I RESULT

```
STEP 15I RESULT:
  DONE
  Tests: 287 passed / 0 failed  (270 baseline + 17 new)
  tsc: clean
  build: OK
  Content Identity + Deduplication + Map Points implemented on top of the
  15H contentHash pipeline without redesign. 1 content identity = 1 map
  point; deterministic lex-smallest representative; all existing features
  (search/filter/preview/selection/zoom/pan/inspector/machiniste) preserve
  their behavior. Real WAV-vs-FLAC equality remains NOT VERIFIED (needs an
  authenticated live probe), identical to the pre-existing 15H limitation.
```