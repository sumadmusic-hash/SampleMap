# STEP 16 DESIGN — Global SampleMap Index

**Date**: 2026-09-02
**Type**: Architecture / Design spec (NO production code in this step)
**Baseline verified**: 325 tests / 22 files — tsc 0 errors — `npm run build` OK
**Production files changed**: 0 — **Production files created**: 0

> This document is a **decision basis** for the later global-index
> implementation. It intentionally implements **no backend, no database, no
> API, no UI, no global index**. It only analyses the current codebase, designs
> a data model and flows, and records decisions and open questions.

---

# 1. Executive Summary

SampleMap today is a **local-only distributed-analysis client**: every user
downloads, decodes and analyzes a sample themselves, even when that sample is
already known to another user. Step 16 proposes a **global shared index** of
analysis results so that:

```
User A analyzes Sample X once  ──►  Global Index  ──►  User B/C reuse the result
```

The central optimization is that **analysis work is done once, and results are
shared**, while audio bytes are never uploaded. This is *distributed computation
with a central shared index*, not P2P.

The single most important architectural decision this spec analyses is the
**lookup-key question**: should the global index be keyed by Audiotool
`sampleId`, by `contentHash`, or by both? The conclusion (D16-02/D16-03) is:
**both, on separate first-class lookup paths**, because they serve different
purposes (cheap known-sample reuse vs. content-level deduplication).

The design remains **version-safe**: `contentHashVersion`, `analysisVersion`,
`representativeVersion`, `mapVersion`, and `similarityVersion` stay independent.
Bumping one never cascades into the others, and a new similarity/map version
never re-derives a contentHash.

Everything here is grounded in the current codebase and the verified facts from
earlier steps (especially the verified "underlying audio can't be changed"
claim). Where evidence is absent, items are explicitly **OPEN / NOT VERIFIED**
and never asserted as fact.

---

# 2. Current State

Verified from the actual code in the repository (`/Users/sumad/SampleMap`).

## 2.1 Persistence (`src/persistence/`)
- **IndexedDB** (`db.ts`, `SCHEMA_VERSION = 2`); object stores `samples`
  (keyed by `sampleId`) and `jobs` (keyed by `sampleId`).
- `IndexStore` (`indexStore.ts`) — CRUD + `query()` over local
  `SampleIndexRecord`; enforces `assertNoAudioBytes` on every `put`.
- `SampleIndexRecord` shape (verified): `sampleId, owner, visibility, name,
  kind, originalTags, primaryClass, confidence, secondaryClasses,
  classificationVersion, audioFeatures, analysisVersion, analyzedAt,
  analysisBuild, status, embedding?` plus 15H fields `analysisSourceFormat?`,
  `fileHash?`, `contentHash?`, `contentHashVersion?` plus 15J field
  `similarityFingerprint?`.
- `QueueStore` (`queueStore.ts`) — job state keyed by `sampleId`; statuses
  `queued/processing/analyzed/failed/gone/skipped`; idempotent `enqueue`,
  retry/backoff, `nextDue`.

## 2.2 Pipeline (`src/pipeline/`)
- `analysisPipeline.ts` — per-job flow:
  `resolve → selectLosslessSource → fetch → container gate → fileHash →
  decode → decoded-PCM gate → canonicalize → contentHash →
  computeSimilarityFingerprint → extractFeatures → classify → index.put →
  release`. Idempotency key `(sampleId, analysisBuild)`.
- `qualityGate.ts` — `GATE_REJECT` includes `NO_LOSSLESS_SOURCE`,
  `INVALID_WAV_CONTAINER`, `NOT_PCM_WAV`, `INVALID_FLAC_CONTAINER`,
  `INVALID_PCM`, `DECODE_FAILED`. Admits only lossless WAV/FLAC analysis
  sources; MP3/preview are playback-only.
- `sourceSelection.ts` — WAV before FLAC; no lossless → not analyzable.
- `jobRunner.ts` — sequential (concurrency 1) queue consumer with budgets
  10/100/1000, pause/resume, retry/backoff, stuck-recovery.

## 2.3 Audio (`src/audio/`)
- `canonicalPcm.ts` — `CANONICAL_PCM_VERSION = "pcm-v1"`; 48 kHz mono s16 LE,
  deterministic linear resampler (no AudioContext).
- `audioHash.ts` — `fileHash` (SHA-256 of source bytes) and `contentHash`
  (SHA-256 of a versioned serialization of canonical PCM).
- `featureExtractor.ts` — 13 features over decoded mono PCM; spectral features
  use the first 1024 samples (onset snapshot).

## 2.4 Identity (`src/identity/audioContentIdentity.ts`)
- `AudioContentIdentity { contentHash, contentHashVersion }`;
  `contentIdentityKey = "version:hash"`; `REPRESENTATIVE_VERSION =
  "representative-v1"` with lex-smallest-`sampleId` representative selection;
  `selectRepresentative()`.

## 2.5 Similarity (`src/similarity/`)
- `SIMILARITY_VERSION = "similarity-v1"` (8-component fingerprint, weighted
  Euclidean distance, `similarity = 1 − d`).
- `findSimilar` dedupes results by content identity, excludes the query's own
  identity, compares only compatible versions.

## 2.6 Map (`src/map/mapPosition.ts`)
- `mapVersion = "map-v1"`; `X = tonalNoiseRatio`, `Y = log spectralCentroid`
  (100 Hz→0, 8000 Hz→1). Classification is independent of position.
- `mapView.ts` `mapPoints()` emits **one Map Point per content identity**, using
  the representative's metadata; the point carries `sampleIds[]` + identity.

## 2.7 Search (`src/search/searchEngine.ts`)
- Read-only `SampleMapSearchEngine` over the local index; text/tag/class/
  confidence/status filters; deterministic total ordering (a `sampleId`
  tie-breaker after the chosen sort key). Filters run client-side over
  `getAll()`.

## 2.8 UI & integration
- `app.ts` (controller, DOM-free), `bootstrap.ts` (browser wiring),
  `render.ts`/`view.ts` (DOM projection), `main.ts`/`cli.ts` (POC surfaces).
- `previewService.ts` owns ObjectURL lifecycle; `machinisteService.ts` maps
  samples via direct `samples/{uuid}` reference into a Machiniste (single
  transaction).
- `libraryScanner.ts` delta-scans `samples.list` paged; `known` provider uses
  local `analyzedAt` as last-seen.

## 2.9 Verified facts relevant to Step 16 (from prior steps)
- Audiotool `Sample` exposes `name = samples/{uuid}`, `ownerName`, `visibility`
  (`public | unlisted | private`), `displayName`, `tags`, `kind`, URLs
  (`wavUrl/flacUrl/mp3Url/previewMp3Url`). VERIFIED (60-sample live set,
  STEP15G).
- **"The underlying audio can't be changed."** — from the protobuf doc for
  `Sample.update_time`. VERIFIED (STEP15G). Implication: once a `sampleId`'s
  audio content is hashed, the `contentHash` for that sample is stable for the
  lifetime of the sample. This is the strongest current evidence for
  `sampleId → contentHash` being a stable mapping **while the sample exists**.
- WAV+FLAC of the same sample match in sample-rate/channels/bits/frames/
  duration at the header level. VERIFIED (STEP15G) — supports contentHash
  equality across containers, but note the design keeps real WAV-vs-FLAC
  **contentHash** equality as **NOT VERIFIED** (needs authenticated live probe;
  STEP15J.O1).
- Real WAV-vs-FLAC `contentHash` equality remains **NOT VERIFIED**.

## 2.10 What is NOT present today (absence noted)
- No global index, no backend, no DB, no API endpoints, no auth for a global
  index, no Cloudflare D1 / Supabase / Neon, no upload, no multi-user sharing.
- No persistent data about a `sampleId` beyond the local record keyed by it.
- No evidence in the repo about Audiotool's exact deletion/re-assignment policy
  for sample IDs over long horizons (see OQ-2).

---

# 3. Problem

The current local-only model has two costly effects:

1. **Redundant re-analysis**: the same sample is downloaded, decoded, gated,
   canonicalized, hashed, extracted and classified independently by every user.
   Analysis is the expensive, irreproducible-labor step the project wants to
   make "once".
2. **No shared knowledge**: even though the analysis output is deterministic
   for a given audio content (gated + versioned), nothing allows one user to
   benefit from another user's already-computed result.

The **core cost driver** is the number of *new* analyses actually the
infrastructure costs should track the 10,000 new results, not the 100,000 lookups.

---

# 4. Goals

- **G1 — Known-sample reuse**: if a `sampleId` (or its `contentHash`) is already
  in the global index, a later client can populate its local index **without
  downloading/decode/analysis**.
- **G2 — Content-level deduplication**: multiple `sampleId`s with the same
  `contentHash` collapse to one content identity, reusing 15I/15J determinism.
- **G3 — Distributed computation, central shared index**: anyone's valid new
  analysis becomes available to all; cost scales with new analyses, not reads.
- **G4 — No raw audio upload**: audio bytes are never part of any protocol;
  `assertNoAudioBytes` invariant extends conceptually to the global index.
- **G5 — Version-safe evolution**: independent version constants; old results
  stay valid under old versions; a new similarity/map version does not
  re-derive a contentHash.
- **G6 — Offline-first**: the local index keeps working when the global index is
  unreachable; sync happens opportunistically.
- **G7 — Incremental, backward-compatible build**: the later implementation
  proceeds in verifiable increments and never ships a half-integrated system.

---

# 5. Non-Goals (this step and the immediate implementation horizon)

- ❌ No backend, database, Cloudflare D1 / Supabase / Neon implementation.
- ❌ No API endpoints, no auth infrastructure, no rate limiting built.
- ❌ No P2P.
- ❌ No raw-audio upload, no audio hosting.
- ❌ No ML system, embeddings service, or ANN/webgl similarity engine.
- ❌ No multi-user voting / reputation / consensus system (not needed for V1;
  see §10).
- ❌ No WebGL map migration.
- ❌ No complete global UI; no automatic infrastructure provisioning.
- ❌ No changes to existing production files, existing tests, or existing
  version constants in this step.

---

# 6. Local vs Global Architecture

## 6.1 Responsibility split

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ LOCAL INDEX (IndexedDB)      │        │ GLOBAL INDEX (external DB)   │
│  - local cache of results    │        │  - canonical analysis per    │
│  - local search/filter/sort  │   app  │    content identity          │
│  - local UI state, selection │  ───►  │  - contentHash → sampleIds   │
│  - offline availability      │  sync  │  - sampleId → identity/result│
│  - "my" samples, "my" tags   │  ◄───  │  - map + similarity data     │
│    and 15I representative    │        │  - versioned, deduplicated   │
│  - queue/job state           │        │  - NEVER audio bytes         │
└──────────────────────────────┘        └──────────────────────────────┘
```

## 6.2 What is only local
- UI state, selection, camera (map zoom/pan), preview ObjectURLs.
- `originalTags`, `owner`, `name`, `visibility` (sample metadata — volatile,
  per-user view, §12).
- Queue/job state, analysis budgets, scan cursor (`latestKnown`).
- The **representative choice** per content identity (dependent on which
  sampleIds a user has locally; global representative differs — see §8).

## 6.3 What is global
- Canonical, versioned analysis results keyed by content identity:
  `contentHashVersion`, `contentHash`, `analysisVersion`, classification
  (primary + secondaries + confidence + classificationVersion), `mapVersion`
  (+ x,y), `similarityVersion` (+ fingerprint), `analysisSourceFormat`,
  `contentHash` provenance.
- A mapping `sampleId → contentIdentity` (+ the analysis result back-reference),
  so a cheap lookup short-circuits download/decode.

## 6.4 What is synced (both directions)
- New/upstream: a locally produced valid analysis result (publish).
- Downstream: known results for looked-up sampleIds / content hashes (reuse).

## 6.5 What is NEVER global
- Raw audio bytes, decoded PCM, waveforms, file contents, preview/ObjectURLs.

---

# 7. The Critical Question: sampleId vs contentHash

## 7.1 The fundamental asymmetry

`contentHash` is derived only after
`download → decode → canonicalize → hash`. If the global index were keyed
**only** by `contentHash`, a client would have to fully analyze an unknown
sample just to *ask* "is this known?" — destroying the reuse benefit.

Therefore the global index should also offer a **direct `sampleId → existing
result`** mapping so that:

```
User B resolves sampleId abc123 ──► global lookup ──► known ──► no download/decode/analyze
```

## 7.2 Is `sampleId` a suitable lookup key?

- `sampleId` is `samples/{uuid}` — a compact, stable lexical identifier; the
  canonical Audiotool sample reference used throughout the app
  (`sampleRef.ts`: `toSampleName`, `isSampleName`). It is already the primary
  local record key and the machiniste direct-reference key.
- **Evidence for stability of audio content per sample**: "The underlying audio
  can't be changed." is **VERIFIED** (STEP15G). This means the *audio content
  for a given sampleId is stable while the sample exists*, so a cached
  `sampleId → contentHash` mapping remains valid for the sample's lifetime.
- **Gap / NOT VERIFIED**: the repo does not verify that a `sampleId` is
  **permanent across the whole Audiotool library** (i.e. that Audiotool never
  deletes a sample or re-points/re-uses an ID over long horizons). See OQ-2.
  Until verified, treat `sampleId` as a **cached fast-path key with
  validation**, not as eternal truth.

## 7.3 Problems with deleted / changed samples

- If Audiotool deletes a sample, a cached `sampleId → result` is stale. The
  local scanner already marks gone samples `gone`; the global layer must tolerate
  missing/stale `sampleId` mappings and never treat them as authoritative about
  the *content*.
- Because audio content is immutable per sample, a *changed audio* would imply a
  *changed sampleId* (a different `samples/{uuid}`). So a sampleId mapping is
  either correct (position 1:1, stable) or gone; it should not silently map to
  different audio. This makes `sampleId → contentHash` a *safe cache* subject to
  deletion only.

## 7.4 Recommendation

- **Store both, on separate lookup paths**:
  - `BySampleId(sampleId)` → returns the analysis result (fast-path reuse).
  - `ByContentIdentity(contentHash, contentHashVersion)` → returns the
    canonical result + all known `sampleIds` (content-level dedup and
    similarity/map queries).
- **Validation invariant**: the global record is authoritative *per content
  identity*. A `sampleId` mapping is a cache; when a client re-encounters a
  sampleId whose cached contentHash disagrees with a fresh local compute, the
  global record is reconciled by contentHash (never overwritten blindly by the
  new sampleId).

## 7.5 Modelling sampleId ↔ contentIdentity

- **Entity `sample_ref`**: `{ sampleId (PK), contentIdentityKey (FK to content), publishedAt }`.
- **Entity `content`**: `{ contentHash (PK), contentHashVersion, analysis..., representativeSampleId }`.
- Inverse index `contentHash → sample_refs[]` enabled by the FK; representative
  computed per content (§8). This is the relational shape that satisfies both
  directions.

---

# 8. Content Identity & Sample References

## 8.1 Rule (reuse 15I)

Two `sampleId`s map to the same content identity iff they share
`(contentHashVersion, contentHash)` — identical to the existing 15I
`contentIdentityKey`.

## 8.2 Representative in the global index

- 15I `representative-v1` selects the **lexicographically smallest sampleId**
  among the samples *present locally*. In a global index the candidate set is
  the **union of all sampleIds** sharing contentHash. Applying the same
  `representative-v1` rule to the global set yields a deterministic,
  order-independent global representative — consistent with the existing rule.
- Consequence to document: a local representative (based on the user's subset)
  may differ from the global representative (based on the full union). This is
  expected and harmless — the two are computed independently under the same
  versioned rule; UI keeps showing the local representative; the global one is
  a suggestion/enrichment.

## 8.3 Idempotent writes & merging

- A publish is idempotent: writing an already-known content identity is a
  no-op for the canonical analysis and an **upsert append** of new `sample_ref`s
  only for that identity.
- Merging must never re-derive `contentHash`; it reconciles `contentHash`-level
  records only.

---

# 9. Lookup & Analysis Flow

## 9.1 Ideal flow (target)

```
Audiotool Library (sampleId known)
   │
   ▼
Global lookup(sampleId)
   │
   ├─ KNOWN ───────────────► populate Local Index from global result ──► done (no audio)
   │
   └─ UNKNOWN ─► Local analysis (existing pipeline, unchanged)
         │  download→decode→gate→canonicalize→contentHash→extract→classify→fingerprint
         │
         ▼
      Global lookup(contentHash, contentHashVersion)
         │
         ├─ KNOWN ──► adopt global canonical result (not the fresh local one),
         │            publish only the sample_ref ──► Local Index
         │
         └─ NEW ─────► Publish (analysis result + sample_ref) ──► Local Index
```

## 9.2 Race condition (two users analyzing the same sample concurrently)

Two clients publish the same content identity at nearly the same time. To avoid
duplicates the server must make the **content record identity-idempotent**:

- The canonical analysis is written under a **deterministic primary key** =
  `contentIdentityKey` (`version:hash`). A second concurrent publish of the
  same key is resolved by upsert semantics (first-writer-wins for the canonical
  fields, union-append for `sample_ref`s), **not** by creating a second row.
- A DB unique constraint on `contentHash` (or the composite key) provides the
  hard guarantee against duplicate canonical records (advisory: also make
  `sample_ref (sampleId)` unique per sampleId, so a sampleId maps to exactly one
  content identity).

## 9.3 Order preservation

The local pipeline stays unchanged for the analysis itself; Step-16 integration
inserts the global lookup **before** enqueueing work and the publish **after**
a successful local analysis — it does not alter gate/decode/classify semantics.

---

# 10. Trust / Malicious Data (V1 model)

## 10.1 What the server can validate mathematically (without audio)

- **Schema/type** validation of every submitted field.
- **Hashes**: `contentHash` is 64 hex chars; `contentHashVersion`,
  `analysisVersion`, `classificationVersion`, `mapVersion`,
  `similarityVersion` must be known/enumerated values.
- **Ranges**: `confidence ∈ [0,1]`; `map.x/y ∈ [0,1]`; similarity fingerprint
  length must equal the version's expected component count; fingerprint values
  ∈ [0,1]; non-finite values rejected.
- **Internal consistency (recomputation without audio)**: `map(x,y)` can be
  re-derived **from the submitted `audioFeatures`** (mapPosition is a pure
  function); `similarityFingerprint` can be re-derived from `audioFeatures`
  (computeSimilarityFingerprint is pure). Therefore the server can *cross-check
  map position and fingerprint against the submitted features* and reject
  mismatches. (The server does not need `audio` to verify these two.)
- **Mutual hashes**: the server can verify `fileHash` is a plausible hex (but
  cannot recompute it without the file), and can verify a `contentHash`-format
  string but **cannot recompute contentHash without canonical PCM/audio**.

## 10.2 What the server cannot validate without audio

- **The `contentHash` itself** (implies the audio content) — th needs the audio
  bytes, which we deliberately never upload.
- **The classification** — `primaryClass`/`confidence` derive from features but
  are model output; there is no cryptographically verifiable "ground truth".
- **The `audioFeatures`** — `rms/peak/duration/…` derive from the PCM and cannot
  be independently checked without the audio.

## 10.3 Consequences

- A malicious client **can** submit a wrong classification (or wrong features),
  because those cannot be proven wrong without the audio.
- A client **cannot** easily fake a wrong map position or similarity fingerprint
  that contradicts its own submitted features (server recomputes and rejects).
- A client **can** claim an arbitrary contentHash; because we do not upload audio,
  the server treats `contentHash` as the client's self-declared identity key.

## 10.4 V1 protections (minimal)

1. Full schema + range validation.
2. Recomputation of `map(x,y)` and `similarityFingerprint` from submitted
   `audioFeatures`; reject inconsistent submissions.
3. Unique constraints on content identity and sampleId (anti-duplicate).
4. Publish requires the **quality gate passed** flag and `analysisSourceFormat
   ∈ {wav, flac}` + a valid `analysisVersion` (i.e. only results the local
   pipeline could have produced are accepted structurally). The server cannot
   re-run the gate without audio, but it can reject out-of-enum submissions.
5. Optional, later: an authenticated submitter id for abuse remediation — but no
   voting/reputation/consensus in V1.

## 10.5 Is "first valid result wins" acceptable for V1?

Yes — for these reasons:
- All results are fragile under a shared, deterministic pipeline and versioned;
  disagreement among honest clients is expected to be ~0.
- There is no verified "ground truth" to vote on; a consensus system would add
  complexity without a basis.
- The primary model is *reuse of an already-analyzed sample*, not crowd truth.
  A later **confidence/consensus** mechanism is only a forward consideration
  (see §22/OQ-…), not a V1 requirement. **No multi-user voting is invented** in
  this step.

---

# 11. Versioning

## 11.1 Independent versions (existing, verified)

| Concern | Constant | Value | Changes when |
|---------|----------|-------|--------------|
| Analysis features | `analysisVersion` | `features-v1` | feature set / extractor contract changes |
| Canonical PCM / contentHash | `contentHashVersion` (= `CANONICAL_PCM_VERSION`) | `pcm-v1` | PCM spec / resampler / format changes |
| Representative rule | `representativeVersion` | `representative-v1` | representative-selection rule changes |
| Map projection | `mapVersion` | `map-v1` | X/Y mapping changes |
| Similarity fingerprint | `similarityVersion` | `similarity-v1` | fingerprint/weights/distance changes |

## 11.2 Compatibility rules

- A global result is **reusable** when it is internally consistent AND its
  `contentHashVersion`, `analysisVersion`, `mapVersion` and `similarityVersion`
  are all supported by the consuming client (and the classification version is
  known).
- **Reuse expiry**: a result is stale for a given concern when the client's
  supported version for that concern advances. E.g. if a client now supports
  `similarity-v2`, an old `similarity-v1` fingerprint is still reusable for map
  and classification, but the client should either (a) recompute similarity
  locally from the **already-present `audioFeatures`** (no re-download needed,
  since features are persisted) or (b) mark similarity as "needs refresh". It
  must **not** silently mix `similarity-v1` and `similarity-v2` results.
- **Independence invariant**: bumping `similarity-v1 → similarity-v2` or
  `map-v1 → map-v2` does **not** change `contentHash`. A content identity is a
  property of the audio (`pcm-v1`), not of any learned projection. Only a
  `pcm-v1 → pcm-v2` change re-derives `contentHash` (a new content identity).

## 11.3 When a re-analysis is required

Exactly when the canonical *content-relevant* result for a supported version is
absent or stale. Because `audioFeatures` are persisted locally, most projection
upgrades (`map-v2`, `similarity-v2`) are re-derivable **without re-downloading
audio** — only a `contentHashVersion` (pcm) change or a missing record forces
the full gate→decode→canonicalize→hash path.

---

# 12. Audio Content vs Audiotool Sample Metadata

## 12.1 The two concerns

- **Audio Content** — the thing identified by `contentHash`/`contentHashVersion`.
  Deterministic, immutable per sample (VERIFIED), version-bound.
- **Sample Metadata** — `name`, `originalTags`, `description`, `owner`, `kind`,
  `visibility`, `displayName`. Volatile, per-user, may change while audio stays
  the same.

## 12.2 Global data bound to audio content (canonical, shared)
`contentHash`, `contentHashVersion`, `analysisVersion`, classification,
`mapVersion`+x/y, `similarityVersion`+fingerprint, `analysisSourceFormat`,
feature-derived quantities needed to recompute projections.

## 12.3 Global data bound to sampleId (a per-sample reference)
The `sample_ref` edge and its `publishedAt`. Optionally the **most-recent
*public* metadata snapshot** used by the global representative *display* — but
this is a convenience copy, **not** authoritative. Name/tags/owner/visibility
remain Audiotool's live source of truth.

## 12.4 What must be re-fetched, not re-analyzed
- On metadata change: re-fetch `SampleMeta` (cheap, no audio decode).
- The analysis result (class/features/fingerprint/map) is **not** invalidated by
  a metadata change.

## 12.5 What must be re-analyzed
- Only when the *audio content* for a looked-up sampleId is missing/stale OR
  when a supported pcm version requires a new contentHash.

---

# 13. Public / Private Samples

The global system must **not** assume every Audiotool sample may be published.

## 13.1 V1 rule (proposed, conservative)

- **Publish an analysis result only for samples the user is allowed to infer
  from** — for the strictest V1: only for samples that are **`public`** OR the
  user's **-owned** samples, and then **only the analysis** (never audio,
  never private metadata beyond what is already public).
- **Never publish private/unlisted-unavailable samples' analysis** into the
  global index in V1. Rationale: leaking *"this private sample exists and is
  a kick"* is information leakage, even without audio.
- A client looks up any sampleId for *reading* the user's own local cache, but
  only public/self samples contribute to the shared index.

## 13.2 Evidence note — **OPEN / NOT VERIFIED**

The applicable **Audiotool API / Terms / Privacy** rules are **not** evidenced
inside this repository. The `SampleMeta.visibility` enum
(`public | unlisted | private`) is verified as the field surface, and STEP15G
observed `59 public / 1 unlisted` in a 60-sample set — but the **policy** on
storing/re-publishing analysis derived from another user's sample is **NOT
documented in the repo**. Per the task, this is marked **OPEN (OQ-7)** and no
unauthoritative legal claims are made. The V1 rule above is *proposed, to be
confirmed against Audiotool terms* before implementation.

## 13.3 Deleted / no longer accessible samples
Handled like `gone` in the pipeline: a sampleId lookup that returns a `gone`
or inaccessible sample is dropped from candidate publishing; a cached result
for content identity whose *only* representative is gone is still usable for
map/similarity (content identity does not depend on a live representative
sample for those numeric projections) but its metadata display degrades.

---

# 14. Global Map — Millions of Samples

## 14.1 Problem
Rendering 10M SVG nodes is not acceptable. The current SVG map (800×520,
`map-v1`) is a fixed view over the local index — it stays valid for local V1.

## 14.2 Proposed global map tiers (no premature migration)

- **Tier-1 — Viewport / bounding-box query (immediate)**: the global map API
  takes a normalized tile/viewport (x-range, y-range, zoom/level) and returns
  **only the points intersecting that viewport**, bounded (e.g. a max count).
  Server does the bbox filter; client renders the returned subset.
- **Tier-2 — Zoom-dependent aggregation / clustering (when a viewport returns
  too many points)**: group into buckets (e.g. grid cells by zoom level) and
  return cluster centroids + counts. Represent density without emitting
  individual points.
- **Tier-3 — Canvas renderer (later, only if needed)**: the existing SVG is
  fine through the local + early-global scale; switch to Canvas (and only
  *additionally* evaluate WebGL) when point counts in a viewport exceed the
  comfortable SVG range. **No WebGL migration project is started now.**

## 14.3 Scale guidance (proposal, to be validated with real data)

- SVG stays viable for up to a few thousand points in a viewport.
- Above ~10k points in a viewport, use clustering/density (Tier-2).
- Canvas becomes worthwhile from the low tens of thousands; WebGL only in the
  high hundreds-of-thousands/millions case (Tier-3, exploratory).

## 14.4 Note
`mapPosition` is a pure function of features, so map x/y may be recomputed
client-side from persisted features too; global map serves as a shared precomputed
cache for scale, not the only source.

---

# 15. Search / Filter Architecture

## 15.1 Separation

- **Global data**: canonical analysis (content-level), sampleId references.
- **User query/filter/selection**: stays local — text, tags, class, confidence,
  status, sort, multi-select, preview.

## 15.2 What should be server-side (global) for scale
- **By-subset retrieval**: "given viewport/class/content-set, fetch the matching
  canonical sample refs" — bounded paging. This is about *where to get data*,
  not about the local filter UI.
- **Bulk lookup** by `sampleId[]` / `contentHash[]` (§17 batching).

## 15.3 What stays local
- The full `SearchEngine` (text/tag/class/confidence/status/sort) runs over the
  local `IndexStore`, which is now hydrated from global results. No change to
  `SearchEngine` semantics; it just operates on a richer local index.

---

# 16. Offline / Cache

## 16.1 Modes

| Mode | Global reachable | Behaviour |
|------|------------------|-----------|
| Global available | yes | lookup → reuse; unknown → local analysis → publish |
| Global unavailable | no (but local cache populated) | local cache → reuse if known; otherwise local analysis |
| Offline | no | local analysis; enqueue pending publish |

## 16.2 Publish-after-offline (pending publish queue)

- When a valid local analysis completes while the global index is unreachable,
  queue it into a **pending-publish store** (persisted, metadata only — no
  audio).
- On next connectivity, flush: for each pending publish, do the idempotent
  publish (content-identity upsert is safe even if another client already
  published; the unique-key semantics collapse duplicates).
- The pending-publish store is a **new local concern** (future implementation);
  it must obey `assertNoAudioBytes`.

## 16.3 Cache-hydration
Later sessions reuse the local index immediately (offline-correct) and
opportunistically refresh stale sampleId mappings from the global index.

---

# 17. Batching & Cost

## 17.1 Request shapes (favor batches)

- **Batch lookup** by `sampleId[]` (e.g. the scanned page) and/or
  `contentHash[]` — one round-trip instead of N.
- **Batch publish** — publish several content identities and their sample_refs
  in one request; the server upserts each, ignoring already-known.
- **Local queue** — unchanged; the JobRunner/budget stays the source of
  sequential analysis work.

## 17.2 Cost model (the decisive metric)

The infrastructure cost should track **new analyses**, not lookups:

```
100,000 sample lookups
↓ 90,000 already global (read-only, cheap)
↓ 10,000 new analyses (publish)
Cost ≈ proportional to 10,000 new results
```

- Reads (lookups) use cheap batched reads; writes (publishes) are bounded by
  genuinely new analyses because the unique-key upsert makes duplicate publishes
  near-zero cost.
- A "cache-hit rate" is the key operational lever: maximize `known` before
  downloading. The `sampleId` fast-path (D16-02) exists precisely to raise this
  rate without audio work.
- **Read/write ratio** is expected to be heavily read-dominated over time
  (many users reading shared results, few producing new ones). This favors
  read-optimized storage + caching (see §18).

## 17.3 Backoff / retry
Reuse the existing `QueueStore` retry/backoff pattern for publish attempts (or a
small dedicated pending-publish store) so transient network failures don't
re-analyze.

---

# 18. Infrastructure — requirements only, NO provider decision

The data model must be provider-agnostic. Requirements derived from the design:

| Requirement | Derived need | Priority |
|-------------|--------------|----------|
| Relational, transactional constraints | unique `contentHash`, unique `sampleId`, FK `sample_ref→content` (idempotent upserts) | High |
| Key/value fast-path | `lookupBySampleId` / `lookupByContentHash` | High |
| Geospatial / viewport queries | Tier-1 map bbox (x,y ranges + zoom) | Medium-High |
| Millions of rows | partitionable/content-keyed, read-scaling | Medium |
| Batch reads/writes | multi-key get, bulk upsert | High |
| API layer | thin contract over the DB (HTTP) | High |
| Auth | authenticated clients (for abuse remediation); not full per-user PKI in V1 | Medium |
| Rate limiting | protect read endpoints + publish abuse | Medium |
| Cost model | reads cheap, writes bounded by new analyses | High |
| Backups / migration | versioned schema, idle-migration path | Medium |

**No provider is chosen now** (no Cloudflare D1 / Supabase / Neon decision). The
design is provider-agnostic; a later infra step evaluates candidates against
these requirements. GitHub / GitHub Pages is a deployment target for the
**frontend only**, not the global datastore (§19).

---

# 19. GitHub Not a Global Database

- GitHub / GitHub Pages are suitable for hosting/deploying the **static
  frontend** (Vite build) — consistent with the current repo being a Vite app.
- GitHub **is not** a running global sample datastore: no transactional unique
  constraints, no geospatial queries, no batch reads driven by queries, no
  server-side validation of publishes, not designed as a mutable shared DB with
  concurrent writers.
- The Global Index requires a **real backend/database layer** (see §18). This
  is documented as a firm architectural boundary, not an implementation.

---

# 20. API Abstraction (conceptual contract, no implementation)

The core must depend on an **Global Sample Index contract**, implemented by a
backend adapter, so the core never imports D1/Supabase/Neon directly.

```
SampleMap Core
   │
   ▼
Global Index Contract (interface)
   │
   ▼
Backend Adapter (D1/Supabase/Neon/…)
   │
   ▼
Cloud Provider
```

## 20.1 Conceptual interface (names are indicative, adjustable)

```ts
// Conceptual — NOT implemented.
interface GlobalSampleIndex {
  // Fast-path: known sampleIds → their canonical analysis (sampleId → content).
  lookupSamples(sampleIds: string[]): Promise<SampleLookupHit[]>;

  // Content-level lookup (contentHash, contentHashVersion) → canonical result.
  lookupContentIdentities(hashes: ContentIdentity[]): Promise<ContentResultHit[]>;

  // Publish locally produced, gate-passed analysis (metadata only, no audio).
  publishAnalysisResults(results: PublishBatch): Promise<PublishOutcome>;

  // Global map viewport query (bbox + zoom) for Tier-1/clustering.
  queryMapViewport(viewport: MapViewportQuery): Promise<MapViewportResult>;
}
```

## 20.2 Publish payload (summarily; no audio)
Per result: `sampleId`, `contentHash`, `contentHashVersion`, `analysisVersion`,
`analysisBuild`, `classificationVersion`, `primaryClass`, `confidence`,
`secondaryClasses[]`, `mapVersion`, `mapX`, `mapY`, `similarityVersion`,
`similarityFingerprint`, `analysisSourceFormat`, `gatePassed` (boolean flag).

## 20.3 Contract purity
The interface is **async, read-oriented, batch-shaped, audio-free**. The core
knows only this contract; the adapter resolves the provider.

---

# 21. Migration (existing local index → global)

## 21.1 Baseline
Existing local `SampleIndexRecord`s already contain `contentHash`,
`contentHashVersion`, `analysisVersion`, `fileHash`, `analysisSourceFormat`,
`audioFeatures`, `classificationVersion`, `similarityFingerprint?` (15J). They
already carry everything needed to publish **without re-downloading or
re-analyzing**.

## 21.2 Migration path
1. **Backfill / publish local**: iterate local `analyzed` records with a valid
   `contentHash`; batch-publish each (metadata only). No audio work.
2. **Cross-check**: if a local record's contentHash is already global, no re-edit;
   just attach the sample_ref. If blank (pre-15H legacy), treat as
   `contentHash`-unknown and leave out of the global publish (or re-derive only
   if supported).
3. **Local stays authoritative for the user**: merging global results never
   overwrites the user's local tags/selection; only canonical analysis fields may
   be refreshed/reconciled by contentHash.
4. **Version handling**: legacy records with older `analysisVersion` are
   published as-is under their version (they carry their own
   `classificationVersion`/`mapVersion`); projections re-derivable from
   `audioFeatures` need no audio.

**No re-analysis is required** when a valid local result already exists (G2/G7).

---

# 22. Open Questions (must be answered before implementing Step-16)

Each entry: question · why relevant · current evidence · options ·
recommendation (if any) · what must be verified.

---

**OQ-1 — Which Audiotool visibility/policy rules govern global publishing of analysis?**
- Why: determines whether we may publish analysis for another user's sample.
- Evidence: `SampleMeta.visibility ∈ {public, unlisted, private}` verified;
  STEP15G observed 59 public / 1 unlisted in 60 samples; **no terms/legal doc
  in repo**.
- Options: (a) publish only public + self samples (recommended conservative V1);
  (b) publish all readable samples; (c) opt-in per sample.
- Recommendation: (a) for V1; re-evaluate with Audiotool terms.
- Must verify: Audiotool API/terms on derived-data republishing.

**OQ-2 — Are `sampleId` values permanent / non-reusable over long horizons?**
- Why: the whole `sampleId` fast-path depends on a stable sampleId ↔ content
  mapping.
- Evidence: "the underlying audio can't be changed" VERIFIED (per-sample content
  stability); sampleId is a UUID-like `samples/{uuid}`; **no verification of
  long-horizon deletion/re-assignment policy in repo**.
- Options: trust + validation-on-reconcile (recommended); require fresh
  confirm per hit.
- Recommendation: treat `sampleId` as a **validated cache**; reconcile on
  contentHash disagreement.
- Must verify: Audiotool deletion/re-use policy for sample IDs.

**OQ-3 — Which backend query form supports millions of map points?**
- Why: affects provider choice (§18) and Tier-1/2 design.
- Evidence: not yet tested; map is a pure function so positions are
  recomputable.
- Options: bbox on a 2D index; grid pre-aggregation; columnar store.
- Recommendation: start with viewport bbox + bounded results; add clustering
  later if needed.
- Must verify: representative data volumes; measure against target provider.

**OQ-4 — Schema migration mechanics for the global record as versions evolve?**
- Why: independent versions require forward-compatible storage.
- Evidence: local schema already avoids per-field migration (SCHEMA_VERSION=2);
  projections recomputable from features.
- Options: store latest canonical + feature-derived fields; recompute
  projections; never backfill audio.
- Recommendation: store canonical analysis + keep `audioFeatures` to re-derive
  projections without audio.
- Must verify: chosen provider's migration tooling.

**OQ-5 — How to authenticate / authorize global write (publish) in V1?**
- Why: abuse/trust (§10) and to attribute publishes.
- Evidence: no global auth exists; local app uses Audiotool OAuth.
- Options: (a) require an authenticated client token (recommended) with
  rate-limit; (b) open writes validated structurally; (c) per-user API keys.
- Recommendation: minimal authenticated write path + rate limiting; no
  reputation/voting in V1.
- Must verify: feasible identity signal available to the client.

**OQ-6 — When does a local result need re-analysis vs recomputation?**
- Why: cost control (§17); audio vs projection upgrades (§11).
- Evidence: `audioFeatures` persisted; projections pure.
- Options: recompute from features for map/similarity upgrades; full analysis
  only on missing/stale contentHash.
- Recommendation: recompute-from-features where possible (`map-v2`,
  `similarity-v2`); full pipeline only for `pcm` changes or missing.
- Must verify: version-upgrade policy agreed before v2 ships.

**OQ-7 — Do we want a later confidence/consensus layer, and under what basis?**
- Why: trust model (§10); avoid premature voting.
- Evidence: no ground truth available per audio; V1 = first-valid-wins.
- Options: none (recommended V1); optional later consensus across multiple
  submitters.
- Recommendation: defer; document as future, not invented now.
- Must verify: when/if misclassification complaints arise.

**OQ-8 — What real WAV-vs-FLAC `contentHash` equality actually holds live?**
- Why: content identity correctness across containers.
- Evidence: header-level match VERIFIED; exact contentHash equality across a
  real WAV and real FLAC of the same sample remains **NOT VERIFIED** (needs an
  authenticated live probe, inherited from 15H/15I/15J-O1).
- Options: run a live probe; if unequal, revisit canonical PCM/hashing or
  document container-specific identity.
- Must verify: authenticated live download of both formats for the same sample
  and comparison of `contentHashOf(canonicalizePcm(decode))`.

---

# 23. Decision Log

## ESTABLISHED (from prior steps, verified)
D16-00 — `contentHash (contentHashVersion)` is the Audio Content Identity key.
D16-00a — `contentIdentityKey = "version:hash"`; `representative-v1` = lex-smallest
  sampleId.
D16-00b — `fileHash` = SHA-256 of source bytes (file identity, separate concern).
D16-00c — `map-v1`, `similarity-v1`, `analysisVersion`/`classificationVersion`
  are independent, versioned, never cascade.
D16-00d — Analysis is lossless-only (WAV/FLAC); MP3/preview never analyzed.
D16-00e — No raw audio may ever be persisted (IndexedDB, queue, and — by
  extension — the global index).

## PROPOSED (this step)
D16-01 — Global Index exists separately from Local Index.
- Status: PROPOSED. §6.
D16-02 — sampleId is a first-class lookup key (fast-path).
- Status: PROPOSED. As a validated cache, reconciled by contentHash. §7.
D16-03 — contentHash remains the Audio Content Identity (canonical, dedup key).
- Status: PROPOSED. §7/§8/§20.
D16-04 — Global canonical record is keyed by contentIdentityKey; unique
  constraint; sample_ref (sampleId) unique FK.
- Status: PROPOSED. §8/§9.
D16-05 — Publish is idempotent; duplicate concurrent writes collapse via
  unique keys (not duplicate rows).
- Status: PROPOSED. §9/§17.
D16-06 — V1 trust = schema/range validation + recomputation of map/fingerprint
  from submitted features + "first valid result wins".
- Status: PROPOSED. No voting/consensus. §10.
D16-07 — Global map = viewport/bbox + bounded results; clustering later; Canvas
  later; **no WebGL now**.
- Status: PROPOSED. §14.
D16-08 — Search/filter/select/preview stay local; global supplies data only.
- Status: PROPOSED. §15.
D16-09 — Offline: local cache reuse; pending-publish queue on reconnect.
- Status: PROPOSED. §16.
D16-10 — Batching for lookup+publish; cost tied to new analyses.
- Status: PROPOSED. §17.
D16-11 — API contract separation (Core → Contract → Adapter → Provider); no
  provider chosen yet.
- Status: PROPOSED. §18/§20.
D16-12 — Migration reuses local records without re-analysis.
- Status: PROPOSED. §21.
D16-13 — Publish only public/self samples in V1 (policy to be confirmed).
- Status: PROPOSED/OPEN (depends on OQ-1). §13.

## OPEN
D16-14 — Provider selection (D1/Supabase/Neon/…) — deferred (OQ-3/OQ-4/OQ-5).
- Status: OPEN.
D16-15 — Real WAV-vs-FLAC contentHash equality — NOT VERIFIED (OQ-8).
- Status: OPEN.
D16-16 — Audiotool terms on republishing derived analysis — OPEN (OQ-1).

## REJECTED / DELIBERATELY DEFERRED
D16-17 — contentHash-only global key (rejected: kills sampleId fast-path). §7.
D16-18 — P2P / decentralized index (rejected: centralized shared index wanted).
D16-19 — WebGL map migration now (deferred, §14).
D16-20 — Multi-user voting / reputation in V1 (deferred, §10).
D16-21 — Raw audio anywhere in global (rejected, invariant §6.5).

---

# 24. Non-Goals (explicit, recalled)
Already enumerated in §5: no backend/DB/auth/P2P/raw-audio/ML/webgl/voting/global
UI/provisioning. The constant `STEP16_DESIGN.md` freeze applies.

---

# 25. Required Document
This file, `STEP16_DESIGN.md`, covers sections 1–26 per the task brief.

---

# 26. Recommended Step-16 Implementation Plan (proposal, not this step)

Derived from the analysis — each is an **incremental**, independently verifiable
sub-step. All must preserve the existing 325/22 green baseline and the
`assertNoAudioBytes` invariant.

- **16A — Global Index Contract (interface, no provider)**: the
  `GlobalSampleIndex` interface + payload types; pure TS contract with tests.
  Production code: contract + types only.
- **16B — Global Record Schema**: concrete, versioned global schema derived from
  §8/§11/§20 (content, sample_ref, version fields); serialization + validation
  helpers; no DB yet.
- **16C — Local/Global Lookup**: a `GlobalLookupService` that, for scanned
  sampleIds, consults the (injected) global contract; on hit, hydrates the local
  index from canonical results (no audio); on miss, falls through to local
  analysis (unchanged pipeline). Integrates into scanner/enqueue path.
- **16D — Publish Queue**: local pending-publish store (metadata only) +
  idempotent publish after successful local analysis; offline→reconnect flush.
- **16E — Backend Adapter**: implements the contract against a chosen provider
  behind an adapter; provider selected only now (§18/OQ-3..5).
- **16F — Backend Implementation**: the provider-side schema, upserts, unique
  constraints, bbox query, rate limiting, auth for writes — deployed in the
  sandbox/CI, not production.
- **16G — Global Map Query**: Tier-1 viewport/bbox endpoint over the global
  index; bounded results; later clustering.
- **16H — Integration**: wire 16C/16D/16E/16G into `app.ts`/`bootstrap.ts` behind
  the contract; keep offline-first; add e2e for lookup→reuse and
  analyze→publish→adopt paths (synthetic, no real backend).

**Order rationale**: contract → schema → local lookup/publish (UI-independent,
testable offline with an in-memory fake adapter) → real adapter/backend → global
map → integration. This keeps every increment green and reversible. Nothing is
implemented in this problem step.

---

## Appendix — Verification for this step

```
Production files changed:    0
Production files created:    0
Tests:                        325 / 325 passed (22 files)  [measured]
TypeScript (tsc --noEmit):    0 errors                      [measured]
Build (npm run build):        PASS                           [measured]
```

This step implemented nothing; it only read code and produced this spec.
