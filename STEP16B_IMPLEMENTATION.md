# STEP 16B — Global Record Schema — Implementation

**Date**: 2026-09-02
**Type**: Data-model step (serializable record schema; NO database/backend/API)
**Baseline before**: 356 tests / 23 files — tsc 0 errors — Build PASS
**After**: 382 tests / 24 files — tsc 0 errors — Build PASS

> 16A defined the *contract* (what operations are possible). 16B defines the
> *record schema* (the concrete, serializable entities a later backend stores).
> No database, Cloudflare D1 / Supabase / Neon, REST/GraphQL, HTTP, auth, sync,
> provider adapter, UI, or new audio analysis was implemented.

---

# 1. Types introduced

New feature directory additions under **`src/global/`** (existing from 16A:
`contract.ts`, `validation.ts`):

- **`src/global/schema.ts`** — the record entities + derived-relationship and
  conflict helpers + re-exported version constants.
- **`src/global/schemaValidation.ts`** — structural validation for the schema
  records (shape/version/enum/range + no-audio enforcement).
- **`src/global/schema.test.ts`** — 26 schema tests.

Types introduced:

| Type | Level | Purpose |
|------|-------|---------|
| `GlobalSampleRefRecord` (`kind: "sample_ref"`) | sample reference | `sampleId` (PK) → `contentIdentity` edge + `publishedAt` |
| `GlobalAnalysisRecord` | analysis | classification / map / similarity / version metadata / source format |
| `GlobalContentRecord` (`kind: "content"`) | content | THE dedup key: content identity → analysis + features + version set + provenance |
| `GlobalVersionSet` | version metadata | all independent versions together |
| `SampleIdentityConflict` | conflict data | a sampleId mapped to >1 content identities |

Helpers: `collectSampleIds`, `deriveRepresentative`, `detectSampleIdConflicts`.

Naming mirrors the `sample_ref → content` entity names from the design.

---

# 2. Existing types reused (no duplication)

| Concept | Reused from |
|---------|-------------|
| Content identity | `AudioContentIdentity`, `contentIdentityKey`, `selectRepresentative`, `REPRESENTATIVE_VERSION` (`src/identity/audioContentIdentity.ts`) |
| Map position/version | `MapPosition`, `mapPosition()`, `mapVersion` (`src/map/mapPosition.ts`) |
| Similarity fingerprint | `SimilarityFingerprint`, `SIMILARITY_VERSION`, `computeSimilarityFingerprint()` (`src/similarity/similarityFingerprint.ts`) |
| Classification | `ClassId`, `SecondaryClass`, `AudioFeatures` (`src/persistence/indexStore.ts`), `ALL_CLASSES` taxonomy (`src/classify/taxonomy.ts`) |
| Source format | `AnalysisSourceFormat`, `isAnalysisSourceFormat` (`src/audio/sourceFormat.ts`) |
| sampleId shape | `isSampleName` (`src/library/sampleRef.ts`) |
| No-audio invariant | `assertNoAudioBytes` (`src/persistence/indexStore.ts`) |

Representative selection is **not reimplemented**: `deriveRepresentative` is a
thin projection that delegates to the established `selectRepresentative`
(representative-v1). No second `selectRepresentative` exists.

---

# 3. Relationship `sample_ref → content`

```
sample_ref (sampleId PK)  ──contentIdentity──►  content (contentHash:contentHashVersion PK)
                                                    │
                                                    ├── analysis
                                                    ├── features
                                                    └── versions
```

- Multiple `sample_ref`s map to one `content` (`AAA/BBB → content XYZ`).
- The reverse (`content → sampleIds[]`) is derived by `collectSampleIds` over the
  `sample_ref` set — it is a query over the FK, **not denormalised** onto the
  content record (keeps the schema minimal and consistent).
- `sampleId ≠ contentHash`: `sample_ref` and `content` are distinct entities;
  only `contentHash`/`contentHashVersion` form the content identity.

---

# 4. The analysis level

`GlobalAnalysisRecord` carries the globally reusable result without duplicating
the content identity (the owning `content` provides the key):

- **classification**: `classificationVersion`, `primaryClass`, `confidence`,
  `secondaryClasses[]`.
- **map**: `mapVersion` + `position { x, y }` (version always with coordinates).
- **similarity**: `SimilarityFingerprint` (`similarityVersion` + `values`).
- **version metadata**: `analysisVersion`, `analysisBuild`.
- **technical**: `analysisSourceFormat` (`wav | flac`) + `gatePassed === true`.

`audioFeatures` live on the `content` record (not inside analysis) so a later
projection upgrade (map-v2/similarity-v2) recomputes without audio.

---

# 5. Map / similarity versioning

- Map: `mapVersion` always accompanies `x/y` — never bare coordinates.
- Similarity: `similarityVersion` always accompanies the fingerprint — the
  existing `SimilarityFingerprint` type is reused, no second fingerprint type.

---

# 6. Why both `sampleId` and `contentHash` exist

- `sampleId` = the `sample_ref` key (cheap fast-path known-sample reuse, per
  STEP16_DESIGN §7). Treated as a **validated cache** (OQ-2).
- `contentHash`/`contentHashVersion` = the `content` key (canonical content
  identity, dedup across sampleIds).

They are separate lookup paths (`lookupSamples` vs `lookupContentIdentities`).
The schema models both as separate entities connected by the `contentIdentity`
edge.

---

# 7. Data stored globally

- `sampleId`, `contentIdentity` (`contentHash` + `contentHashVersion`).
- The canonical analysis (classification, map, similarity, source format, gate).
- `audioFeatures` (to recompute projections without audio).
- Optional `fileHash`.
- Version metadata (`GlobalVersionSet`) + provenance timestamps
  (`firstPublishedAt`, `updatedAt`).

---

# 8. Data deliberately NOT stored globally

- **No raw audio**, decoded PCM, waveforms, preview/ObjectURLs.
- **No sample metadata** (`name`, `tags`, `owner`, `visibility`, `description`)
  — these are volatile, per-user Audiotool metadata, not audio-bound analysis
  (task §20).
- **No UI / local state**: selection, camera/zoom, preview, search, queue/job
  state.
- **No `content → sampleIds`** denormalised list (derived via FK query).
- Representative is **derived**, not stored (a function of which sampleIds are
  known; the global representative may differ from a local one by design —
  STEP16_DESIGN §8.2).

---

# 9. No-audio invariant

`GlobalContentRecord` and `GlobalSampleRefRecord` are plain JSON objects; the
schema exposes no `audio`/`bytes`/`buffer`/`blob`/`arrayBuffer`/`wavData`/
`flacData`/`mp3Data` field. Validation calls the existing `assertNoAudioBytes`
(throws on any byte container), and tests prove `ArrayBuffer`/`Uint8Array` are
rejected.

---

# 10. fileHash decision

`fileHash = SHA-256(source container bytes)`; `contentHash = SHA-256(canonical
PCM)`.

- **Used globally?** Optional only (`fileHash?` on `GlobalContentRecord`).
- **Duplicate detection?** `fileHash` identifies the *file*, so it can help
  detect exact duplicate *files*; but content dedup already uses `contentHash`
  (the canonical audio identity), which is the correct dedup level for
  content-level reuse.
- **Needed for another user's reuse?** No. Another user needs `contentHash`,
  analysis, `audioFeatures`, versions — not the source-file hash. A malicious
  client can claim any string for `fileHash` and the server cannot verify it
  without the file (same boundary as `contentHash`).
- **Rationale for keeping it optional:** it is a cheap provenance signal for
  file-level investigations / abuse, but it is **not** required for reuse, so it
  is not a mandatory field. This follows the §19 minimality rule ("don't store
  both just because they exist").

---

# 11. Validation

`schemaValidation.ts` provides `validateSampleRefRecord` and
`validateContentRecord` (throw on audio bytes; return a list of structural
issues otherwise). Checks:

- required fields and `sampleId` shape (`samples/{uuid}` via `isSampleName`).
- valid version strings, valid 64-hex `contentHash`, required
  `contentHashVersion`.
- finite, bounded map coordinates (`[0,1]`).
- fingerprint version + values in `[0,1]`.
- classification shape (known class, confidence `[0,1]`).
- cross-field consistency: `versions.*` match the analysis field versions;
  `contentHashVersion` matches identity.
- lossless-only `analysisSourceFormat`, `gatePassed === true`.
- ISO-8601 timestamps; `fileHash` shape if present.

**Boundary:** without audio, the schema cannot prove a client-reported
`contentHash`/classification/features actually correspond to the Audiotool
audio. That limitation is preserved and documented — no audio revalidation.

---

# 12. Immutability / update & conflict & version boundaries

- **Identity (immutable):** `contentHash`, `contentHashVersion`.
- **Versioned results (replaceable/refreshable):** analysis, map, similarity,
  features. No update API is implemented (16B defines data only).
- **Provenance metadata:** `firstPublishedAt`, `updatedAt`.
- **Conflict signal:** `detectSampleIdConflicts` surfaces sampleIds mapped to
  >1 distinct content identities (e.g. User A→AAA→XYZ, User B→AAA→ABC). This is
  **detection only** — resolution is a later step, not silently accepted.
- **Version compatibility:** a new version (e.g. `similarity-v2`) may coexist
  with `similarity-v1` under the same content identity; old results are not
  overwritten in a way that breaks old clients. Independence is encoded: bumping
  `similarityVersion` in `GlobalVersionSet`/analysis never alters
  `contentHash`/`contentHashVersion` (tested).

---

# 13. What 16B intentionally does NOT implement

- Database / D1 / Supabase / Neon / PostgreSQL schema (no `CREATE TABLE`, no
  migration).
- REST / GraphQL / HTTP / fetch / API implementation.
- Authentication / authorization.
- Provider adapter (later: 16E).
- Synchronisation / pending-publish queue (later: 16D).
- UI / Global Map UI / WebGL.
- New audio analysis / classification / similarity / contentHash computation.
- Representative rule (delegated to existing authority).
- Conflict *resolution* (detection only).

---

# 14. Open questions / architecture risks (carried)

- OQ-2 — `sampleId` permanence: `sample_ref` treated as validated cache; the
  schema's conflict signal lets a backend reconcile a sampleId whose content
  disagrees.
- OQ-8 — real WAV-vs-FLAC `contentHash` equality **NOT VERIFIED**; the schema is
  format-agnostic and stores a single `contentHash` regardless.
- OQ-1/OQ-7 — Audiotool publishing/visibility policy **OPEN**: the schema stores
  **no** visibility field and forces **no** publication of private samples; the
  V1 public/self-only publish rule stays a later integration/policy concern (not
  silently encoded).
- Conflict resolution and provider migration mechanics are deferred to later
  steps per design (§22 OQ-3/4).

---

# 15. Next steps

- **16C** — Local/Global lookup service (consult the contract/schema; hydrate
  local index; fall through to local analysis).
- **16D** — Publish queue (pending-publish store; idempotent flush).
- **16E/16F** — Backend adapter + provider implementation.
- **16G/16H** — Global map query + integration.

---

# 16. Verification (exact, measured)

```
Production files changed:    0
Production files created:    3  (src/global/schema.ts, schemaValidation.ts, schema.test.ts)
Tests:                       382 / 382 passed (24 files)   [356 baseline + 26 new]
New tests:                   26
TypeScript (tsc --noEmit):   PASS (0 errors)
Build (npm run build):       PASS (~580ms; pre-existing chunk-size warning only)
```

Regression baseline preserved (356 → 382 all green), no existing test rewritten,
no production file touched, no UI/backend/raw-audio types in the schema. The
data model lets a later backend adapter fully identify an already-analyzed
sample (`sample_ref → content`) and hand the canonical analysis to another user
for reuse without ever transferring or storing raw audio — the §37 acceptance
criterion.
