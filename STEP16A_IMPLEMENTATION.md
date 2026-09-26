# STEP 16A — Global Index Contract — Implementation

**Date**: 2026-09-02
**Type**: Contract-layer implementation (NO backend, NO database, NO provider)
**Baseline before**: 325 tests / 22 files — tsc 0 errors — Build PASS
**After**: 356 tests / 23 files — tsc 0 errors — Build PASS

> This step implements ONLY the contract/abstraction layer between the SampleMap
> core and a future global backend. No provider, database, HTTP, auth, sync,
> global map backend, or UI was implemented. Design source: `STEP16_DESIGN.md`
> (esp. §20 Global Index Contract, §7 identity, §11 versioning, §14 map, §17
> batching/idempotency, §10 trust).

---

# 1. What was introduced

New feature directory: **`src/global/`**

- **`src/global/contract.ts`** — the `GlobalSampleIndex` contract interface and
  all its payload/result types.
- **`src/global/validation.ts`** — pure, contract-level structural validation
  (shape/version/enum/range + no-audio enforcement + feature-recomputation
  cross-check). **Not** backend logic.
- **`src/global/contract.test.ts`** — 31 contract tests.

No existing production file was modified. All new code lives under
`src/global/`.

---

# 2. Contract operations

The `GlobalSampleIndex` interface exposes four async, read-oriented,
batch-shaped, audio-free operations:

| Operation | Purpose |
|-----------|---------|
| `lookupSamples(sampleIds[])` | Fast-path sampleId lookup → known/unknown (reuse without audio) |
| `lookupContentIdentities(identities[])` | Content-level lookup by `(contentHash, contentHashVersion)` → canonical result + all sample references |
| `publishAnalysisResults(batch)` | Publish gate-passed analyses (metadata only, idempotent) |
| `queryMapViewport(query)` | Bounded viewport/bbox map query (Tier-1); NO "get everything" |

Error taxonomy: `GlobalIndexError` distinguishes `not-found`,
`validation-rejected`, `version-incompatible`, `conflict`, `rate-limited`,
`temporary-unavailable` — with **no HTTP status codes** (backend-agnostic).

---

# 3. Types introduced

- `GlobalAnalysisResult` — the canonical content-bound analysis
  (contentIdentity, classificationVersion/primaryClass/confidence/
  secondaryClasses, analysisVersion, analysisBuild, map{mapVersion,x,y},
  similarity, analysisSourceFormat, gatePassed). **Content-bound, no sample
  metadata, no audio.**
- `GlobalSampleLookupHit` — `known | unknown` discriminated union (explicit,
  never bare null/undefined).
- `GlobalContentLookupHit` — content identity + canonical analysis + all
  `sampleIds[]` + `representativeSampleId` (the `sample_ref → content` shape).
- `GlobalPublishResult` / `GlobalPublishBatch` / `GlobalPublishOutcome` —
  publish input (sampleId + contentIdentity + analysis + features) and
  per-item idempotent outcomes (`stored | already-known | rejected`).
- `MapViewportQuery` / `GlobalMapViewportResult` / `GlobalMapPoint` — bounded
  viewport query + pagination cursor.
- `GlobalIndexError` — backend-agnostic error union.

---

# 4. Existing types reused (no duplicates)

The contract deliberately references existing authorities rather than
re-implementing:

| Concept | Reused from |
|---------|-------------|
| Content identity | `AudioContentIdentity`, `contentIdentityKey` (`src/identity/audioContentIdentity.ts`) |
| Map position | `MapPosition` + `mapPosition()` (`src/map/mapPosition.ts`) |
| Similarity fingerprint | `SimilarityFingerprint` + `SIMILARITY_VERSION` + `computeSimilarityFingerprint()` (`src/similarity/similarityFingerprint.ts`) |
| Classification | `ClassId`, `SecondaryClass` (`src/persistence/indexStore.ts`), `ALL_CLASSES` taxonomy (`src/classify/taxonomy.ts`) |
| Features | `AudioFeatures` (`src/persistence/indexStore.ts`) |
| Source format | `AnalysisSourceFormat` (`src/audio/sourceFormat.ts`) |
| No-audio invariant | `assertNoAudioBytes` (`src/persistence/indexStore.ts`) |

The representative-selection rule is **not reimplemented** — the contract
transports the representative's `sampleId` and documents that the rule lives in
`selectRepresentative` (`audioContentIdentity.ts`). Timestamps / `publishedAt`
are intentionally not in the contract (server-managed, provider-specific).

---

# 5. Why `sampleId` and `contentHash` are separate lookup paths

Per `STEP16_DESIGN.md` §7: `contentHash` is only derivable after
download→decode→canonicalize→hash. If the global index were keyed only by
`contentHash`, a client would have to fully analyze an unknown sample just to
ask "is this known?" — destroying the reuse benefit.

Therefore the contract offers **two first-class, separate paths**:

- `lookupSamples(sampleId[])` — the **fast-path** (cheap known-sample reuse).
- `lookupContentIdentities((contentHash, contentHashVersion)[])` — the
  **content-level** path (dedup across sampleIds).

This matches the relational `sample_ref → content` model (multiple sampleIds →
one content identity). `sampleId` is treated as a *validated cache* (OQ-2),
`contentHash`/`contentHashVersion` as the canonical content identity.

---

# 6. Data never transferred

The contract contains **no audio-byte field** and no audio-upload stand-in:
- no `ArrayBuffer`, `Uint8Array`, `Blob`, decoded PCM, or waveform;
- no `audio`/`bytes`/`blob`/`audioUrl` payload field;
- only metadata, hashes, fingerprints, versions, map coordinates, features
  (structural quantities needed to recompute projections).

This is enforced at runtime by `validatePublishResult`, which calls the
existing `assertNoAudioBytes` (throws on any byte container). A dedicated test
("audio-byte safety") proves a payload carrying `ArrayBuffer`/`Uint8Array`/
`Blob` is rejected and that the publish type structurally exposes no audio
field.

---

# 7. Error semantics

Distinct outcomes (no HTTP codes): `not-found`, `validation-rejected`,
`version-incompatible`, `conflict`, `rate-limited`, `temporary-unavailable`.
A provider adapter maps these to its concrete transport later.

---

# 8. Versioning preserved (independent)

Publish/results carry the separate version fields `contentHashVersion`,
`analysisVersion`, `analysisBuild`, `classificationVersion`, `mapVersion`, and
`similarityVersion`. They are **never merged** into one global version (a later
`similarity-v2` must not imply `pcm-v2`). Validation checks each on its own path
and rejects unsupported `similarityVersion`.

---

# 9. Trust model (V1) — documented, structure-enabled

The contract does **not** implement a consensus/voting/reputation system.
Instead, `validation.ts` provides the pure structural checks the V1 model
requires (`STEP16_DESIGN.md` §10):
- schema/enums/ranges (`confidence ∈ [0,1]`, `map.x/y ∈ [0,1]`, 64-hex
  `contentHash`, lossless-only `analysisSourceFormat`, `gatePassed === true`);
- **feature-recomputation cross-check**: `mapPosition` and
  `computeSimilarityFingerprint` are pure functions of `audioFeatures`, so the
  server (or any validator) can verify the submitted map position and
  fingerprint **without audio** and reject contradictions.

The documented limitation stands: the server cannot prove a client-reported
`contentHash`/classification/features without audio (no raw audio ever
uploaded).

---

# 10. Consciously NOT implemented

- Database / Cloudflare D1 / Supabase / Neon / PostgreSQL.
- HTTP client / fetch for a global index / API endpoints.
- Authentication / authorization.
- Offline sync / pending-publish queue.
- Global map backend / WebGL.
- UI and map-UI changes.
- SearchEngine / AnalysisPipeline / contentHash / similarity logic changes.
- Provider adapter (later: 16E).
- Any new local database migration or New local store.

These are later increments (16B–16H).

---

# 11. Open questions / architecture risks (carried from design)

- OQ-2 — `sampleId` permanence: treated as **validated cache**, reconciled by
  contentHash; the contract encodes both paths so a stale sampleId mapping is
  not authoritative.
- OQ-8 — real WAV-vs-FLAC `contentHash` equality remains **NOT VERIFIED**;
  the contract is format-agnostic and does not depend on it for the contract's
  validity.
- OQ-1 / OQ-7 — Audiotool terms on republishing; the contract does not gate
  *policy* (public/self only) — that is a later integration concern, not a
  contract concern.

---

# 12. Next steps

- **16B** — Global Record Schema (serialization + concrete versioned schema from
  §8/§11/§20).
- **16C** — Local/Global lookup service (consult contract; hydrate local index;
  fall through to local analysis).
- **16D** — Publish queue (pending-publish store, metadata-only, idempotent
  flush).
- **16E/16F** — Backend adapter + provider implementation (provider chosen then).
- **16G/16H** — Global map query + integration.

---

# 13. Verification (exact, measured)

```
Production files changed:    0
Production files created:    3  (src/global/contract.ts, validation.ts, contract.test.ts)
Tests:                       356 / 356 passed (23 files)   [325 baseline + 31 new]
New tests:                   31
TypeScript (tsc --noEmit):   PASS (0 errors)
Build (npm run build):       PASS (~590ms; pre-existing chunk-size warning only)
```

The regression baseline (325 tests, 22 files) is preserved and extended; no
existing test was rewritten, no production file was touched, and no UI/backend/
raw-audio types entered the contract.
