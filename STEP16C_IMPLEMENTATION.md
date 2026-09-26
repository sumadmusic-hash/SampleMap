# STEP 16C — Global Lookup & Reuse Semantics — Implementation

**Date**: 2026-09-02
**Type**: Domain-logic step (pure lookup/reuse semantics; NO backend/DB/HTTP/audio)
**Baseline before**: 382 tests / 24 files — tsc 0 errors — Build PASS
**After**: 405 tests / 25 files — tsc 0 errors — Build PASS

> 16A defined the *contract* (`GlobalSampleIndex` + the lookup-hit types). 16B
> defined the *record schema* (entities a later backend stores). 16C defines the
> *domain semantics*: how the core decides whether a sample / content identity is
> already globally known and whether an existing analysis result can be REUSED.
> No database, backend adapter, HTTP, provider, sync/queue, UI, or new audio
> analysis was implemented.

---

# 1. Types introduced

Under **`src/global/`** (existing: `contract.ts`, `validation.ts`, `schema.ts`,
`schemaValidation.ts`):

- **`src/global/lookup.ts`** — the pure, provider-agnostic domain layer.
- **`src/global/lookup.test.ts`** — 23 lookup/reuse tests.

Types introduced:

| Type | Purpose |
|------|---------|
| `SupportedVersions` | the set of versions the **consumer** can reuse (contentHash/analysis/classification/map/similarity) |
| `ReuseCompatibility` | per-dimension boolean compatibility (independent dimensions, §23/§24) |
| `ReuseDecision` | `reuse` \| `incompatible` (+ `missing: Array<keyof ReuseCompatibility>` when incompatible) |
| `GlobalReuseBundle` | `contentIdentity` + `analysis` + `representativeSampleId?` + `sampleIds?` (no audio/UI state) |
| `GlobalSampleLookupResult` | `known` \| `incompatible` \| `unknown` for the sample fast-path |
| `GlobalContentLookupResult` | `known` \| `incompatible` \| `unknown` for the content identity path |
| `class GlobalLookup` | wraps an injected `GlobalSampleIndex` + `SupportedVersions`; exposes `lookupSamples` and `lookupContentIdentities` |

---

# 2. Existing types reused (no duplication)

| Concept | Reused from |
|---------|-------------|
| Contract operations + hit types | `GlobalSampleIndex`, `GlobalSampleLookupHit`, `GlobalContentLookupHit` (`src/global/contract.ts`) |
| The canonical global result | `GlobalAnalysisResult` (16A) — 16C reads analysis/hit data verbatim |
| Content identity | `AudioContentIdentity` (`src/identity/audioContentIdentity.ts`) |
| Representative (authority) | `representativeSampleId` from the provider hit — **not reimplemented** |
| No-audio invariant | `assertNoAudioBytes` (`src/persistence/indexStore.ts`) |

16C does **not** reconstruct a content identity from features/map/similarity; it
only ever reads `(contentHash, contentHashVersion)` from the authoritative stored
result / hit and the `AudioContentIdentity` the caller passes in.

---

# 3. The lookup & reuse decision

## 3.1 Known / unknown / incompatible (three states)

A single lookup returns one of three states:

- **`known`** — the sample/content identity is globally known **and** fully
  reusable: every dimension matches the consumer's `SupportedVersions`. The
  caller can reuse `bundle.analysis` **without downloading / decoding /
  analyzing audio** (§6).
- **`incompatible`** — the sample/content is known but at least one required
  dimension (e.g. similarity-v2) is not supported by this consumer.
  `decision.missing` lists which; `decision.compatibility` still reports the
  reusable dimensions (partial reuse, §24).
- **`unknown`** — not known on the consulted path. This triggers local analysis.

`state` is derived from `decideReuse`: `known` ⇔ `decision.status === "reuse"`,
else `incompatible`. `unknown` only when the provider hit is absent/unknown.

## 3.2 Per-dimension compatibility (§23/§24)

`decideReuse(analysis, supported)` judges each independent dimension:

```
content      ✔  contentHashVersion matches
analysis     ✔  analysisVersion matches
classification✔ classificationVersion matches
map          ✔  map.mapVersion matches
similarity   ✔  analysis.similarity.similarityVersion matches
```

If nothing is missing → `reuse`; else `incompatible` with `missing`. Version
compatibility is **per-dimension**, not "all-or-nothing": a `similarity-v2`
consumer facing a `similarity-v1` global result still fully reuses
content / analysis / classification / map (partial reuse, §24).

## 3.3 Two lookup paths

- **`lookupSamples(sampleIds)`** — the sampleId fast-path (§7). Known sampleId →
  REUSE directly. Unknown sampleId → **does NOT imply content unknown** (§12):
  the consumer must learn the content identity via local analysis then use the
  content path.
- **`lookupContentIdentities(identities)`** — the content path (§8). After local
  analysis determines the `contentHash`/`contentHashVersion`, this enables
  cross-user dedup and reuse even for a brand-new sampleId.

---

# 4. The two-stage reuse (economic core, §33)

```
User B           User A (did the work)
─────            ─────────────────────
sampleId: BBB    sampleId: AAA ──► content XYZ (analysis stored)
  │                                     ▲
  │ 1. lookupSamples([BBB])             │
  │    → UNKNOWN (not a known sample)   │
  ▼                                     │
 2. local pipeline derives content      │
    identity XYZ for BBB                │
  ▼                                     │
 3. lookupContentIdentities([XYZ]) ─────┘
    → KNOWN → REUSE analysis (no audio)
```

User B can reuse User A's analysis for a sample User A never touched, because it
is the **content identity** (not the sampleId) that is globally deduplicated.

---

# 5. Version independence (§9/§34)

Each version dimension is independent. Bumping `similarityVersion` (e.g.
`similarity-v1` → `similarity-v2`) changes only the `similarity` compatibility
flag and never the `contentHash` / `contentHashVersion` / content identity.
Proven end-to-end: a `similarity-v2` consumer and a `similarity-v1` consumer
resolve the **same** content identity for the same sample, differing only in the
reuse state (`incompatible` vs `known`), with identical content keys.

---

# 6. Batch semantics (§17/§18)

- One result per **unique** id; duplicates are deduplicated, **first-occurrence
  order preserved** (deterministic).
- An **unknown** element does **not** mark the whole batch unknown.
- A single `(contentHash, contentHashVersion)` resolves to exactly **one**
  content record whose `sampleIds[]`/`representativeSampleId` enumerate the known
  references (`AAA/BBB → one content XYZ`).
- `known`/`incompatible`/`unknown` are reported per element independently.

---

# 7. Idempotence, determinism, read-only, no publish (§19/§20)

- Identical input ⇒ identical output (idempotent, deterministic).
- Lookup is **strictly read-only**: it never mutates records and never calls
  `publishAnalysisResults`. LOOKUP and PUBLISH are separate concerns; a test
  spies on the injected source's `publish` and asserts it is never invoked
  during lookup.
- No voting / consensus / first-valid-wins is invented (the source's hits are
  trusted verbatim; consistency issues are surfaced, not silently "fixed").

---

# 8. Conflict handling (§26)

A conflict (e.g. the sample fast-path saying `AAA→XYZ` while the content record
says `AAA→ABC`) is **surfaced** as a distinct, inconsistent signal — it is
**never** silently treated as a normal reuse case. 16C does **not resolve**
conflicts; resolution is a later step. The design's `detectSampleIdConflicts`
(16B) remains the detection authority; 16C additionally ensures its lookup
semantics do not paper over a known/known disagreement.

---

# 9. Representative (existing authority)

The representative sampleId for a content identity comes from the provider hit
(`representativeSampleId`), which the adapter derives via the existing
`selectRepresentative` authority (16B `deriveRepresentative`). 16C does **not**
reimplement or re-export a representative rule.

---

# 10. No-audio invariant

`GlobalReuseBundle` and the lookup results carry only identity / analysis /
versions / sampleId references — no `audio`/`ArrayBuffer`/`Uint8Array`/`Blob`.
A test serializes a result and asserts no byte-container markers appear, and the
broader suite reuses `assertNoAudioBytes` enforcement. Reuse never requires the
audio bytes to be downloaded.

---

# 11. Lookup vs publish separation

- **Lookup** (16C): read-only; returns a `GlobalReuseBundle` + decision; the
  caller decides whether to reuse or publish.
- **Publish** (later 16D): writes `GlobalContentRecord` / `GlobalSampleRefRecord`.
- 16C never combines them and never performs a write as a side effect of a read.

---

# 12. What 16C intentionally does NOT implement

- Database / D1 / Supabase / Neon / PostgreSQL — no schema, no migration.
- REST / GraphQL / HTTP / fetch / API.
- Authentication / authorization.
- Provider adapter (later: 16E).
- Synchronisation / pending-publish queue (later: 16D).
- UI / Global Map UI / WebGL / preview / queue state.
- New audio analysis / classification / similarity / contentHash computation.
- Reconstruction of content identity from features/map/similarity.
- Voting / consensus / first-valid-wins.
- Conflict *resolution* (detection/surfacing only).
- Representative rule (delegated to existing authority).
- `deriveRepresentative` re-export (removed — the service reads the provider's
  `representativeSampleId` directly).

---

# 13. Open questions / architecture risks (carried)

- OQ-2 — `sampleId` permanence: fast-path treated as validated cache; conflicts
  surfaced (see §8).
- OQ-8 — real WAV-vs-FLAC `contentHash` equality still unverified; 16C is
  format-agnostic and reuses whatever `AudioContentIdentity` is authoritative.
- OQ-1/OQ-7 — Audiotool publishing/visibility policy still OPEN; 16C makes no
  publication decision.
- The actual network/provider/database layer remains deferred (16E/16F); 16C
  contracts against the interface only and is verified against a read-only in-mem
  fake.

---

# 14. Next steps

- **16D** — Publish queue (pending-publish store; idempotent flush) — the write
  counterpart to 16C's read path.
- **16E/16F** — Backend adapter + provider implementation (implements
  `GlobalSampleIndex` against a real store).
- **16G/16H** — Global map query + integration.

---

# 15. Verification (exact, measured)

```
Production files changed:    0
Production files created:    2  (src/global/lookup.ts, lookup.test.ts)
Tests:                       405 / 405 passed (25 files)   [382 baseline + 23 new]
New tests:                   23
TypeScript (tsc --noEmit):   PASS (0 errors)
Build (npm run build):       PASS (pre-existing chunk-size warning only)
```

Regression baseline preserved (382 → 405 all green), no existing test rewritten,
no production file touched, no UI/backend/raw-audio in the lookup domain. The
domain decides `known | unknown | incompatible`, enables the two-stage reuse
(`sample unknown → local content → content known → REUSE`), keeps versions
independent, batches deterministically, and is strictly read-only — satisfying
the §37 acceptance criterion that another user can reuse a prior user's analysis
without transferring or re-analyzing raw audio.
