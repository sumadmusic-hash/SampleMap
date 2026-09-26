# STEP 16E — DESIGN: Real Global Index Provider (Cloudflare D1 + Workers)

**Date**: 2026-09-02
**Type**: DESIGN / SPECIFICATION ONLY — no code, no infra, no deployment
**Baseline (verified in repo)**: 445/445 tests (26 files), tsc 0 errors, Build PASS

> This is a technical specification for a later implementation step (16F). It
> designs the real provider that implements the existing, provider-agnostic
> `GlobalSampleIndex` contract (16A) on top of Cloudflare Workers + D1. It does
> NOT change any contract semantics, does NOT modify existing production files,
> and does NOT claim anything "deployed/verified" that is not.

---

# 1. Executive Summary

Steps 16A–16D built a provider-agnostic global layer in `src/global/*`:

* 16A — `GlobalSampleIndex` contract (lookup ×2, publish, map) + structural
  validation + error taxonomy + no-audio invariant.
* 16B — record schema (`sample_ref`, `content`, `analysis`, `map`,
  `similarity`, `GlobalVersionSet`) + derived-relationship/conflict helpers.
* 16C — read/reuse domain semantics (`GlobalLookup`, known/unknown/incompatible,
  version independence, content dedup, conflict surfacing).
* 16D — write domain semantics (`GlobalPublishQueue`, candidate, eligibility,
  batching, retryable/terminal errors, no-audio).

**16E designs the real provider**: a single Cloudflare Worker (implements the
contract) backed by one D1 database (SQLite at the edge) storing the 16B record
entities as relational tables. The browser never talks to D1 directly — it talks
to the Worker, which translates HTTP ↔ the contract. The contract is the
boundary: the Worker is *an implementation of `GlobalSampleIndex`*, nothing more.

This document is a **specification for 16F**. Nothing here is implemented,
deployed, or measured against a live backend.

---

# 2. Verified Repository Facts

Verified by direct inspection (not assumed):

* **`src/global/contract.ts`** (16A) defines:
  * `GlobalSampleIndex` interface: `lookupSamples(sampleIds)` →
    `GlobalSampleLookupHit[]`; `lookupContentIdentities(identities)` →
    `GlobalContentLookupHit[]`; `publishAnalysisResults(batch)` →
    `GlobalPublishOutcome`; `queryMapViewport(query)` → `GlobalMapViewportResult`.
  * `GlobalAnalysisResult` — `{ contentIdentity, classificationVersion,
    primaryClass, confidence, secondaryClasses, analysisVersion, analysisBuild,
    map:{mapVersion,x,y}, similarity, analysisSourceFormat, gatePassed }`.
  * `GlobalSampleLookupHit` = discriminated union `known | unknown`.
  * `GlobalContentLookupHit` — `{ contentIdentity, analysis, sampleIds[],
    representativeSampleId }`.
  * `GlobalPublishResult` = `{ sampleId, contentIdentity, analysis, features }`;
    `GlobalPublishBatch = GlobalPublishResult[]`.
  * `GlobalPublishItemOutcome` = `stored | already-known | rejected{reason}`;
    `GlobalPublishOutcome = { items[], accepted }`.
  * `MapViewportQuery` / `GlobalMapPoint` / `GlobalMapViewportResult`.
  * `GlobalIndexError` = `not-found | validation-rejected | version-incompatible
    | conflict | rate-limited | temporary-unavailable`.
* **`src/global/schema.ts`** (16B) defines stored records:
  * `GlobalSampleRefRecord` — `{ kind, sampleId, contentIdentity, publishedAt }`.
  * `GlobalAnalysisRecord` — `{ classification, map:{mapVersion,position},
    similarity, analysisVersion, analysisBuild, analysisSourceFormat,
    gatePassed }`.
  * `GlobalVersionSet` — `{ contentHashVersion, analysisVersion, analysisBuild,
    classificationVersion, mapVersion, similarityVersion, representativeVersion }`.
  * `GlobalContentRecord` — `{ kind, contentIdentity, analysis, features,
    fileHash?, versions, firstPublishedAt, updatedAt? }`.
  * Helpers `collectSampleIds`, `deriveRepresentative` (delegates to `selectRepresentative`,
    representative-v1 = lex-min sampleId), `detectSampleIdConflicts`.
* **`src/global/validation.ts`** (16A): `validatePublishResult`,
  `isPublishBatchValid`, `deriveMapPosition`, re-exports `mapVersion`,
  `SIMILARITY_VERSION`. Cross-checks map + similarity against `features`
  (pure functions) — the server-side recomputation authority.
* **`src/global/schemaValidation.ts`** (16B): `validateSampleRefRecord`,
  `validateContentRecord`, `isValidContentHash`, `isValidVersionToken`,
  `isValidSampleId`.
* **`src/global/lookup.ts`** (16C): `GlobalLookup`, `SupportedVersions`,
  `ReuseCompatibility`, `ReuseDecision`, `GlobalReuseBundle`,
  `GlobalSampleLookupResult`, `GlobalContentLookupResult`, `decideReuse`.
* **`src/global/publish.ts` + `publishQueue.ts`** (16D):
  `GlobalPublishCandidate`, `createPublishCandidate`, `validatePublishCandidate`,
  `GlobalPublishQueue`.
* **`src/identity/audioContentIdentity.ts`**: `AudioContentIdentity`
  (`{contentHash, contentHashVersion}`), `contentIdentityKey` =
  `"{contentHashVersion}:{contentHash}"`, `selectRepresentative`,
  `REPRESENTATIVE_VERSION = "representative-v1"`.
* **`src/persistence/indexStore.ts`**: `AudioFeatures`, `SampleIndexRecord`,
  `assertNoAudioBytes` (the no-audio runtime authority).
* **`src/similarity/similarityFingerprint.ts`**:
  `SimilarityFingerprint = { similarityVersion, values: number[] }`,
  `SIMILARITY_VERSION = "similarity-v1"`, `computeSimilarityFingerprint`.
* **`src/map/mapPosition.ts`**: `MapPosition`, `mapVersion = "map-v1"`,
  `mapPosition` (pure function of `AudioFeatures`).
* **`src/pipeline/analysisPipeline.ts`** + **`qualityGate.ts`**:
  lossesless-only analysis source, `AnalysisSourceFormat = "wav" | "flac"`,
  technical quality gate; local record stores `contentHash`, `contentHashVersion`,
  `analysisSourceFormat`, `similarityFingerprint`, `audioFeatures`.
* **No existing provider/infrastructure**: there is no `workers/`, `infra/`,
  `wrangler.toml`, D1/Cloudflare code, or `.migrations/` anywhere in the repo.
  16E is greenfield for the provider.

---

# 3. Existing Contract (boundary)

The provider implements these signatures exactly (verbatim from 16A). 16E does
NOT alter them:

```ts
interface GlobalSampleIndex {
  lookupSamples(sampleIds: readonly string[]): Promise<GlobalSampleLookupHit[]>;
  lookupContentIdentities(identities: readonly AudioContentIdentity[]): Promise<GlobalContentLookupHit[]>;
  publishAnalysisResults(batch: GlobalPublishBatch): Promise<GlobalPublishOutcome>;
  queryMapViewport(query: MapViewportQuery): Promise<GlobalMapViewportResult>;
}
```

Key contract invariants the provider must honor:
1. **Read-only lookup** — `lookupSamples`/`lookupContentIdentities` must not
   write anything.
2. **Idempotent publish** — duplicate content identities collapse (`already-known`),
   never duplicate `content` rows.
3. **No audio anywhere** — requests, responses, DB rows, logs.
4. **Independent versions** — `(contentHash, contentHashVersion)` is immutable in
   the content row; versioned results (map/similarity/analysis/classification)
   are replaceable within the same content identity without changing the hash.
5. **Batch-shaped** — batch publish, batch lookup, bounded map query (never
   `SELECT * FROM map`).

---

# 4. Provider Architecture

```
SampleMap Browser (src/global/* domain + a 16F adapter)
        │  HTTP/JSON (metadata only)
        ▼
Cloudflare Worker  ← implements GlobalSampleIndex semantics
        │  D1 Binding (env.DB)
        ▼
    D1 (SQLite, edge)  ← stores sample_ref / content / analysis / map / similarity
```

* The **Worker** is the only component that talks to D1. It exposes HTTP
  endpoints (§13), validates/parses requests, delegates to a pure provider
  module that mirrors the `GlobalSampleIndex` shape, and maps D1 results back
  to contract types.
* The **browser side** gets a 16F adapter implementing the same
  `GlobalSampleIndex` interface by `fetch`ing the Worker. This keeps `src/global/lookup.ts`
  and `publishQueue.ts` untouched — they already depend only on the interface.
* The contract is **the** boundary. D1's limitations are accommodated by the
  adapter, never by silently changing contract semantics.

---

# 5. D1 Schema

Relational tables derived 1:1 from the 16B records. SQLite types; no audio.
Version strings are plain `TEXT`. `contentHash` is a 64-char lowercase hex
`TEXT`.

### `sample_ref`
```sql
CREATE TABLE sample_ref (
  sample_id            TEXT    PRIMARY KEY,       -- Audiotool samples/{uuid}
  content_hash         TEXT    NOT NULL,          -- 64-hex
  content_hash_version TEXT    NOT NULL,          -- e.g. 'pcm-v1'
  published_at         TEXT    NOT NULL,          -- ISO-8601
  UNIQUE (content_hash, content_hash_version, sample_id)
);
CREATE INDEX idx_sample_ref_content ON sample_ref(content_hash, content_hash_version);
```

### `content`
Primary identity `(content_hash, content_hash_version)`. Only data required for
global reuse; no audio.

```sql
CREATE TABLE content (
  content_hash         TEXT    NOT NULL,
  content_hash_version TEXT    NOT NULL,
  -- analysis (classification / map / similarity / version metadata)
  classification_version TEXT NOT NULL,
  primary_class        TEXT    NOT NULL,
  confidence           REAL    NOT NULL,
  secondary_classes    TEXT    NOT NULL,   -- JSON array, e.g. [{"class":"toms","confidence":0.08}]
  analysis_version     TEXT    NOT NULL,
  analysis_build       TEXT    NOT NULL,
  analysis_source_format TEXT  NOT NULL,    -- 'wav' | 'flac'
  gate_passed          INTEGER NOT NULL CHECK (gate_passed = 1),
  -- map
  map_version          TEXT    NOT NULL,
  map_x                REAL    NOT NULL,
  map_y                REAL    NOT NULL,
  -- similarity
  similarity_version   TEXT    NOT NULL,
  similarity_values    TEXT    NOT NULL,   -- JSON number[] (8 components, similarity-v1)
  -- representative / version set
  representative_version TEXT  NOT NULL DEFAULT 'representative-v1',
  -- features (for server-side recompute; metadata only)
  features             TEXT    NOT NULL,   -- JSON AudioFeatures
  -- provenance
  file_hash            TEXT,               -- optional provenance
  first_published_at   TEXT    NOT NULL,
  updated_at           TEXT,
  PRIMARY KEY (content_hash, content_hash_version)
);
```

Rationale:
* `map_version`, `map_x`, `map_y` stored **together** (never bare coords) —
  matches `mapVersion`+position coupling in the schema.
* `similarity_version` stored **with** `similarity_values` — mirrors
  `SimilarityFingerprint`.
* `secondary_classes` and `similarity_values` and `features` are JSON-encoded
  because they are arrays/objects; D1 has no native JSON column, so we store a
  JSON `TEXT` and decode in the provider. (`AudioFeatures` and
  `SecondaryClass[]` are the authoritative types.)

### `analysis` vs `content` vs `map` vs `similarity` — separation
The 16B model keeps `sample_ref`, `content`, `analysis`, `map`, `similarity` as
distinct *concepts*. For V1 scale (§19/§20), a single `content` table with an
embedded `analysis`+`map`+`similarity` JSON-bearing set is simplest and avoids
join complexity, while still matching the record `GlobalContentRecord` (which
already nests analysis/map/similarity under one content row). A fully
normalised 3rd-normal-form split (separate `analysis`/`map`/`similarity` tables)
is possible and is the **documented migration path** (§21) if per-dimension
replacement or row-size growth demands it. This is an explicit
DOCUMENTED-ADAPTER choice, not a silent contract change.

---

# 6. Keys and Indexes

| Purpose | Key / Index |
|---------|-------------|
| Sample fast-path | `sample_ref.PRIMARY KEY (sample_id)` |
| Sample→content lookup | `sample_ref.content_hash`, `.content_hash_version` |
| Content identity | `content.PRIMARY KEY (content_hash, content_hash_version)` |
| Map viewport (V1, no spatial index) | `content.map_x`, `content.map_y` (bounded scan) — §12 |
| Map by version | `content.map_version` |
| Map by class filter | `content.primary_class` (partial, if V1 filters by class) |

For V1, an index on `(map_x, map_y)` is only added if real volumes warrant it
(§19: at 100k rows a bounded bbox scan is acceptable; at 1M+ a spatial index or
bucketing becomes necessary — §12).

---

# 7. Sample Lookup (fast-path)

Contract: `lookupSamples(sampleIds[])` → one hit per sampleId.

SQL (batched via `db.batch()` of per-id selects, or a single
`SELECT ... WHERE sample_id IN (...) JOIN content ...`):

```sql
SELECT s.sample_id,
       s.content_hash, s.content_hash_version,
       c.primary_class, c.confidence, c.secondary_classes,
       c.analysis_version, c.analysis_build,
       c.classification_version, c.analysis_source_format, c.gate_passed,
       c.map_version, c.map_x, c.map_y,
       c.similarity_version, c.similarity_values
FROM sample_ref s
JOIN content c ON c.content_hash = s.content_hash
              AND c.content_hash_version = s.content_hash_version
WHERE s.sample_id = ?
```

* A row exists → `{ status:"known", sampleId, contentIdentity, analysis }`.
* No row → `{ status:"unknown", sampleId }`.
* **Read-only**: no writes. An `IN (...)` variant respects the 100-bound-param
  limit by chunking (§10).

---

# 8. Content Lookup (content identity path)

Contract: `lookupContentIdentities(identities[])` → one hit per content identity
with `sampleIds[]` + `representativeSampleId`.

```sql
-- (1) the content analysis
SELECT ... FROM content WHERE content_hash = ? AND content_hash_version = ?;
-- (2) all sample refs for that content
SELECT sample_id FROM sample_ref
WHERE content_hash = ? AND content_hash_version = ?;
```

* Content present:
  * `sampleIds` = result of (2).
  * `representativeSampleId` = **lex-min sampleId** via the existing
    `selectRepresentative` authority — applied in the provider (or, if very
    large, a `MIN(sample_id)` SQL — same rule, single authority). The provider
    **does not reimplement the rule**; it reuses `selectRepresentative` from
    `src/identity/audioContentIdentity.ts`.
* Content absent → provider returns no hit for that identity (the 16C domain
  layer maps a missing hit to `unknown`).

---

# 9. Publish Semantics

Contract: `publishAnalysisResults(batch)` → per-item `stored | already-known | rejected`.

Desired end-state table(§8 of prompt):

| Input | sample_ref rows | content rows | Outcome |
|-------|-----------------|--------------|---------|
| AAA→X (first) | AA1→X | X:1 | `stored` |
| BBB→X | AAA→X, BBB→X | X:1 (same row) | `stored` (sample ref) / `already-known` (content) |
| AAA→X (repeat) | AAA→X (unchanged) | X:1 | `already-known` |

Implementation (must be atomic per batch item — see §10 on transactional
boundaries):

```
for each batch item:
  1. validate (reuse 16A validatePublishResult) → reject with reason if invalid
  2. app.upsertContent(item)   -- INSERT INTO content ... ON CONFLICT DO NOTHING
                               --  -> new = stored, existing = already-known (content)
  3. app.upsertSampleRef(item) -- INSERT INTO sample_ref ... ON CONFLICT(sample_id) DO NOTHING
                               --  -> new = stored, existing = already-known (ref)
```

Idempotency:
* **Content**: `ON CONFLICT(content_hash, content_hash_version) DO NOTHING`. A
  repeat publish of the same content is `already-known` — never a second row.
* **Sample ref**: `ON CONFLICT(sample_id) DO NOTHING`. Repeat of the same
  sampleId is `already-known`.

A **single content identity must not be duplicated** — enforced by the PK.

---

# 10. Batch Semantics / Atomicity

Facts (verified from official D1 docs):
* D1 `db.batch([...]).` executes a list of prepared statements **atomically**
  (auto-commit; any statement failure rolls back the **entire** sequence).
* There is **no manual `BEGIN TRANSACTION`** through the HTTP API — `batch()` is
  the transaction primitive.
* Limits that force chunking:
  * **100 bound parameters per query** — decisive for `IN (...)` lookups and
    multi-value inserts/clause sizes.
  * 100 KB per SQL statement.
  * ~2 MB max string / BLOB / row; up to 100 columns/table.
  * 30 s max query duration.

Therefore the provider splits an incoming publish batch into **atomic chunks**:
* Each batch item = one `content` upsert + one `sample_ref` upsert = 2 statements.
  Group up to N items into one `db.batch()` such that statement-count/binding
  limits are respected (e.g. batches are never composed of statements exceeding
  the per-statement binding limit). Since each `ON CONFLICT DO NOTHING` upsert is
  a single statement with its own small binding count, **every (content + ref)
  pair should itself be atomic** and independent: if one chunk fails, only that
  chunk rolls back; the others succeed.
* **Provider-level atomicity is deliberately NOT assumed** by the domain queue
  (16D documents partial success as a provider responsibility). The provider
  therefore returns **per-item outcomes**, so a partially successful batch is
  faithfully represented by the `items[]` array — exactly what the contract
  supports.

**Design decision**: group the whole publish batch into one or more `db.batch()`
calls; each `db.batch()` is atomic; the per-item `content`+`sample_ref` writes
for one item are placed in the **same** `db.batch()` so a single item cannot be
half-committed. If a whole `db.batch()` rolls back, every item in it is reported
as `rejected` (temporary-unavailable → retryable) or the provider retries the
chunk.

---

# 11. Conflict Semantics

Prompt target: `AAA → X` then `AAA → Y` must NOT silently overwrite.

Contract behavior: publish returns `rejected` with a reason.

Implementation:
```
content upsert for AAA→Y   -- unaffected (content Y is new/independent)
sample_ref upsert for AAA→Y
  = INSERT INTO sample_ref(sample_id,...) ON CONFLICT(sample_id) DO UPDATE
    SET content_hash = excluded.content_hash,
        content_hash_version = excluded.content_hash_version
    WHERE sample_ref.content_hash <> excluded.content_hash   -- conflict!
    RETURNING ...
```

* If the existing `sample_ref.sample_id` already maps to a **different** content
  identity, the `WHERE` guard fires and the update is skipped → the provider
  surfaces `rejected` with `reason = "conflict: sample mapped to different content"`.
* **No last-write-wins** — conflicting re-points are rejected, not overwritten.
* The 16B `detectSampleIdConflicts` helper is the *analysis/detection* authority;
  the provider uses the same rule at write time.

---

# 12. Map Query / Spatial Strategy

Contract: `queryMapViewport(query)` → bounded points.

```sql
SELECT content_hash, content_hash_version,
       map_x, map_y, primary_class
FROM content
WHERE map_version = ?
  AND map_x >= ? AND map_x <= ?
  AND map_y >= ? AND map_y <= ?
  [AND primary_class = ?]      -- optional class filter
ORDER BY map_y, map_x          -- stable, deterministic
LIMIT ?                        -- bounded (query.limit ?? provider default)
[OFFSET/PAGINATE via cursor]   -- MapViewportQuery.cursor
```

* **Never `SELECT * FROM map`.** The bbox is a hard bounds, and `LIMIT` bounds
  rows. This is the Tier-1 bounded viewport from STEP16_DESIGN.
* **Deterministic ordering** required so `nextCursor` pagination is stable.
* **Spatial bucketing: NOT for 16E.** Rationale:
  * D1 is SQLite; no native geospatial index. A bbox scan at ≤100k rows is a
    small indexed/scan cost.
  * Adding a grid-bucket table now would be a premature spatial engine
    (prompt §12 explicitly warns against this).
  * **Future migration**: at ~1M+ rows, add a `content_grid` table keyed by a
    coarse `(zoom, cell_x, cell_y)` for V1 clustering, or migrate to a
    Postgres/geospatial backend. The contract's `GlobalMapPoint` +
    `MapViewportQuery` (with `zoom` already present) is forward-compatible — no
    contract change needed.

---

# 13. Worker API Design (conceptual — NOT implemented)

A single Worker routing to the four contract areas. Conceptual endpoints:

```
POST /samples/lookup    → lookupSamples(sampleIds[])
POST /content/lookup    → lookupContentIdentities(identities[])
POST /publish           → publishAnalysisResults(batch)
GET  /map               → queryMapViewport(query as query/params)
GET  /health            → liveness (optional)
```

* **Request body**: JSON mirroring the contract input types (metadata only).
* **Response**: JSON mirroring contract output types; `GlobalIndexError` on
  failures via a consistent error envelope.
* **Validation**: reuse the 16A/16B validators server-side; reject
  `validation-rejected` early.
* **Batch size limits**: reject a `POST /publish` body larger than a
  configurable cap (see §14 abuse) before processing.
* **Pagination/limit**: `GET /map` enforces `limit` + `cursor`.
* **Cacheability**: `GET /map` and both lookup POSTs are cacheable (§23). Use
  `Cache-Control` + ETag where the provider can serve immutable content
  identities.

(Exact route names and shapes are finalized in 16F after profiling; these are
proposals grounded in the contract, not commitments to a specific framework.)

---

# 14. Security Model

Two distinct operations → a clear read/write split:

### READ (lookup ×2, map) — anonymous allowed
* Reads are non-sensitive, derived metadata. Anonymous reads keep the global map
  usable by all Audiotool users w/o friction.
* Protected by origin/CORS restrictions + rate limiting, not auth.

### WRITE (publish) — authenticated
* Only trusted clients may inject analyses into the global index.
* **Auth technology is OPEN (OQ-1/OQ-7 + new OQ-9)**: whether to use an
  Audiotool/Nexus token, a Cloudflare Access token, a shared service secret, or
  a per-user API key is a product/security decision for 16F — **not decided here**
  (prompt §14: DON'T invent auth).
* **Spam/abuse prevention** (without a full trust system):
  * Per-client **rate limiting** on `POST /publish` (map to `rate-limited`).
  * **Batch + request-size caps** (reject oversized payloads with
    `validation-rejected`).
  * **Replay/idempotency**: publish is idempotent by design (content + sample-ref
    keys) — a replay is a no-op `already-known`, not a duplicate.
  * **Origin/CORS**: restricted `Access-Control-Allow-Origin` to the SampleMap
    app; reject mismatched `Origin`.

No auth/rate-limit technology is implemented in 16E.

---

# 15. Trust Model

V1 (unchanged):
```
first-valid-wins:
  structural validation
  + recomputation of derived values (map, similarity from features)
  + accepted contentHash (asserted identity)
```

The server **cannot** prove (no audio):
* `contentHash` truly belongs to the Audiotool audio.
* classification is "ground truth".

The server **can** verify (without audio):
* map position = `mapPosition(features)` matches submitted (16A `validatePublishResult`).
* similarity fingerprint = `computeSimilarityFingerprint(features)` matches
  (when same similarity version).
* versions, ranges, structure, `gatePassed`, `assertNoAudioBytes`.

**Not silently changed.** Possible later extensions (NOT implemented in 16E):
audiotool-backed verification (re-derive hash from actual bytes), reputation,
consensus/voting, moderation — each tied to OQ-7/trust evolution.

---

# 16. No-Audio Model

Hard invariant: **no raw audio reaches the global index** — not in D1, Worker
storage, request/response payloads, logs, or queue payloads.

Fixed pipeline (metadata only at every hop):

```
Browser ── metadata only ──► Worker ── metadata only ──► D1
   ▲                                                       │
   └──────────── metadata only ◄───────────────────────────┘
```

* The contract types carry **no** byte containers; `assertNoAudioBytes` is the
  runtime guard, enforced on candidates (16D), payloads, and (in 16F) on each
  D1-bound payload.
* A 16F provider must re-run `assertNoAudioBytes` on every request body and
  every row before writing/returning.
* Audio never traverses the network or is persisted.

---

# 17. Content Hash

Identity = `(contentHash, contentHashVersion)` — **exclusively**. Not
fileHash/map position/features/sampleId/name.

* `fileHash` is optional provenance only.
* `contentHash` is treated as an **asserted** content identity per the V1 trust
  boundary (§15).
* **OQ-8 stands**: real WAV-vs-FLAC `contentHash` equality is **NOT VERIFIED**.
  The design stores a single `content_hash` regardless of container and makes no
  claim that wav and flac of the same music yield equal hashes.

---

# 18. Representative Sample

* Reuse `selectRepresentative` (representative-v1, lex-min sampleId) — the
  single authority in `src/identity/audioContentIdentity.ts`.
* `GlobalContentLookupHit.representativeSampleId` is computed from the `sample_ref`
  set per content identity (SQL `MIN(sample_id)` yields the same result; the
  provider may use either, never a *second* rule).
* `content.representative_version` is stored as `'representative-v1'`
  (versioned, for future rule changes without breaking the identity).

---

# 19. Performance

Expected access patterns (browser-driven, batch-shaped). No fabricated
benchmarks — these are structural, order-of-magnitude analyses.

| scale | lookupSamples (1 id) | content lookup | batch publish | map viewport |
|-------|----------------------|----------------|---------------|--------------|
| 1k | PK index hit, ms | PK+ref index, ms | few statements, ms | bbox scan, ms |
| 100k | PK index hit, ms | PK+ref index, ms | chunked batch, ms–tens ms | indexed/scan, tens ms |
| 1M | PK index hit, ms | PK+ref index, ms | chunked batch, tens ms | scan ~N/bbox cells; OK or migrate |
| 10M | PK index hit, ms | PK+ref, ms | chunked batch, tens ms | **needs bucketing/alternative** (§12) |

Driver / main cost:
* **D1 rows read** is the metered unit; PK lookups read ~1 row; bbox scans read
  the bbox rows. Indexes on `sample_ref(sample_id)`, `content(pk)`, and the
  `sample_ref(content…)` FK are the main lever.
* **Response sizes** bounded by batching and `LIMIT` — never full-table.

The platform constraints that dominate: 100 bound params/query (chunking),
Worker 10ms CPU (Free) / 5min (Paid) per invocation, D1 30s query limit, and the
read/write row budgets (§20).

---

# 20. Cost Model

Pricing verified from official Cloudflare docs (2026-09): 

| | Workers Free | Workers Paid ($5/mo base) |
|---|---|---|
| Requests | 100k/day | 10M/mo incl., then $0.30/M |
| CPU time | 10 ms/invocation | 30M ms/mo incl., then $0.02/M ms |
| D1 rows read | 5M/day | 25B/mo incl., then $0.001/M rows |
| D1 rows written | 100k/day | 50M/mo incl., then $1.00/M rows |
| D1 storage | 5 GB total | 5 GB incl., then $0.75/GB-mo |
| D1 max DB size | 500MB (Free) / 10GB (Paid) | |
| D1 per-invocation read subrequests | 50 (Free) / 1000 (Paid) | |

**Scenario analysis (gross, explicit assumptions; no fake precision):**

Assumptions per scenario: each active user, per active session, does ~20 sample
lookups, ~5 content lookups, ~2 map views, and (only writers) ~1 publish of a few
items; reads ≈ 1 row each; publish ≈ 4 rows written per item (content + ref +
index accounting).

* **1k active users / day**: ~20k lookups×1 row + ~5k content×~3 rows + ~2k map×~15
  rows ≈ **~90k rows read**; publishes ≈ 1k×few = ~5k rows written. **Well within
  the Free tier daily budget** (5M reads / 100k writes). Requests ≈ ~30k/day <
  100k. → **Free is viable.**
* **10k active users / day**: ~900k reads, ~50k writes, ~300k requests. Reads
  fine on Free (5M); writes borderline (50k < 100k); requests **exceed** 100k/day
  Free → **need Workers Paid** (+D1 readily). Modest cost (sub-$1–few-$/mo).
* **100k active users / day**: ~9M reads (> free 5M), ~500k writes (> free
  100k), ~3M requests (> free). Full **Paid** ($5 base + usage). Reads ~9M over
  25B incl → negligible; writes 500k over 50M incl → negligible; requests 3M vs
  10M incl → negligible. **Still sub-$10/mo**, dominated by the $5 base.

Rows-read budgets are the binding constraint at scale — the bounded/map + PK
lookups minimize them.

---

# 21. Migration / Scaling

Path from prototype → small index → large index:

1. **Prototype / small (V1)**: one `content` + `sample_ref` table, single D1 DB,
   Free or Paid plan. This matches where the project is now.
2. **Reach 10GB or ~1M–10M rows**: 
   * **Sharding/partitioning**: D1 is designed for many smaller (10GB) DBs.
     Partition by content-hash prefix (e.g. `content_hash[0..1]` → DB shard N),
     or by tenant. A lookup/publish computed the shard from the key.
   * **Alternative DB**: Postgres (Supabase/Neon) if relational flexibility,
     full-text, or geospatial is needed; the contract boundary (`GlobalSampleIndex`)
     makes swapping **internal to the provider** — `src/global/*` unchanged.
3. **Export**: provider reads rows → re-encode to `GlobalContentRecord`/`sample_ref`
   (they're JSON-serializable) → dump.
4. **Backup**: D1 Time Travel (point-in-time recovery; 30 days Paid / 7 Free) +
   scheduled exports.
5. **Recovery**: re-import exports; Time Travel restore (up to 10 restores/10min).

**Provider-swap guarantee**: because the app talks only to `GlobalSampleIndex`,
replacing the Worker/D1 provider with a Postgres-backed one requires only a new
adapter implementing the same interface — no redesign of `src/global/*`.

---

# 22. Failure Semantics

Map real backend failures to the existing `GlobalIndexError` taxonomy (no new
classes):

| Real-world condition | Contract error |
|----------------------|----------------|
| Request body structurally invalid / out of range | `validation-rejected` |
| Submitted versions unsupported | `version-incompatible` |
| sample_ref re-point → different content | `conflict` |
| D1 daily read/write budget exhausted (Free) / 1027 request cap | `rate-limited` |
| D1 query timeout / transient Worker error / 5xx | `temporary-unavailable` |
| Lookup id present but no row (map) | `not-found` (contextual; lookups use `unknown` hit, map uses empty result) |

Retry guidance (matches 16D): `rate-limited` and `temporary-unavailable` →
retryable; `validation-rejected` / `version-incompatible` → terminal;
`conflict` → terminal+visible.

---

# 23. Cache Strategy

* **Immutable content identities are strongly cacheable**: once `content(X)` is
  first-published it can be served from cache; add a short TTL/ETag on content
  lookups.
* **Lookup results** (`POST /content/lookup`, `POST /samples/lookup`) are safe
  to cache briefly (seconds→minutes) keyed by the identity — a known identity
  rarely changes.
* **Map viewport** (`GET /map`) cacheable with `Cache-Control` on bbox/version;
  ETag/conditional requests reduce re-transfers.
* **Browser cache** + **Worker/HTTP cache (Cache API / CDN cache)**: because
  reads are the metered D1 cost, caching is a direct cost saver. Idempotent
  publishes bypass cache on the write path.
* **Not implemented in 16E** — this is the strategy 16F follows.

---

# 24. Open Questions

**Carried (must remain open):**
* **OQ-1 — Audiotool visibility / publishing policy.** Problem: which
  visibility/policy rules govern global publishing. Impact: what may be
  published, and by whom. Current default: reference the local record's
  `visibility` (public) only if/when policy permits; no hard Audiotool-terms
  rule invented. Needs: Audiotool product/terms decision.
* **OQ-2 — sampleId permanence.** Problem: are `sampleId`s permanent/non-reusable
  over long horizons. Impact: safe to cache `sample_ref → content`; conflict
  reconciliation. Current default: treat as validated cache; conflicts detected,
  not auto-resolved. Needs: Audiotool sample-ID lifecycle guarantee.
* **OQ-7 — consensus / trust evolution.** Problem: whether to add confidence/
  voting/reputation later. Impact: trust model. Current default: V1 first-valid-
  wins. Needs: product decision on trust, if any.
* **OQ-8 — real WAV-vs-FLAC contentHash equality.** Problem: is the same music
  in wav and flac hashed equal. Impact: whether one content row covers both.
  Current default: single `content_hash` regardless; NOT verified. Needs: a live
  two-format analysis of the same audio.

**New (from this design):**
* **OQ-9 — Publish authentication mechanism (tied to OQ-1).** Problem: how to
  authenticate the `POST /publish` write path. Impact: security boundary, spam
  control. Current default: reads anonymous, writes authenticated — mechanism
  unspecified (not invented). Needs: decision on Audiotool/Nexus token vs.
  Cloudflare Access vs. shared secret / API key.
* **OQ-10 — Single-table vs normalised analysis/map/similarity.** Problem:
  whether V1 keeps `analysis`+`map`+`similarity` embedded in `content` or splits
  them into separate tables for per-dimension replacement. Impact: row-size,
  migration path (§21), per-dimension versioned refresh. Current default: single
  `content` table (matches `GlobalContentRecord`), split as a documented future
  migration. Needs: observation of real per-dimension refresh frequency.

---

# 25. Verification (this step)

Because 16E is a **design** step:
* **No production files changed** — verified (only a new `STEP16E_DESIGN.md`
  documentation file added).
* **No tests added or changed** to "fit" an architecture (prompt §25).
* Baseline re-verified by running the existing commands:

```
npx tsc --noEmit  → PASS (0 errors)
npx vitest run    → 445/445 (26 files)
npm run build     → PASS (pre-existing chunk-size warning only)
```

Nothing here claims a live backend; provider behavior is specified, not executed.

---

# 26. Ready for 16F — Implementation Plan

Ordered by dependency, ground in the 16E findings (most critically: use
`db.batch()` as the atomic primitive, chunk by the 100-binding/statement limits,
keep `ON CONFLICT DO NOTHING` idempotency, keep read-only lookups, no audio):

```
16F-1  Repo scaffolding for the provider (workers/ or infra/, wrangler.toml,
       D1 binding, tsconfig, minimal deps) — no infra callout yet.
16F-2  D1 migrations: create sample_ref + content (SQL, versioned under .migrations/).
16F-3  Provider core module mirroring GlobalSampleIndex against the D1 binding
       (pure functions: sample lookup, content lookup, publish, map viewport).
16F-4  Sample lookup (fast-path) with batch/IN chunking.
16F-5  Content lookup (identity path + representative via selectRepresentative/MIN).
16F-6  Publish: idempotent content + sample_ref upserts, per-item outcomes,
       batch() atomic grouping, no-audio guard on payloads.
16F-7  Conflict handling: sample_ref re-point guard → conflict; idempotency
       (repeat → already-known).
16F-8  Map viewport: bounded bbox + LIMIT + cursor; deterministic order.
16F-9  Security: read/write split, rate-limit, origin/CORS, request/batch caps,
       replay-idempotency (per OQ-9 decision).
16F-10 Browser-side adapter implementing GlobalSampleIndex over fetch to the
       Worker (keeps src/global/* unchanged) + unit tests with a mocked fetch.
16F-11 Integration tests: a real-worker/D1-local test harness (e.g. miniflare /
       wrangler dev) running the full read/write/map flow, asserting no-audio,
       conflict, idempotency, and batch structure.
16F-12 Deployed real-backend verification (LIVE, requires account/infra —
       explicitly NOT part of 16E; out of scope until 16F execution).
```

**Explicitly deferred/out of scope for 16F-1..11**: authentication provisioning,
real deployment, real D1 provisioning, rate-limit server implementation — these
need external infra/accounts and are flagged as live-verification items.

---

# 27. Deliverable summary

* **Production files changed**: 0.
* **Production files created**: 0.
* **Documentation created**: `STEP16E_DESIGN.md` (this file).
* **Tests/tsc/build**: unchanged and still green (verified).
```
