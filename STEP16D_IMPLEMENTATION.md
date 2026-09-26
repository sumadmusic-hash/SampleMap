# STEP 16D — Global Publish Queue / Write Semantics — Implementation

**Date**: 2026-09-02
**Type**: Domain/write-semantics step (publish queue; NO backend/DB/HTTP/audio)
**Baseline before**: 405 tests / 25 files — tsc 0 errors — Build PASS
**After**: 445 tests / 26 files — tsc 0 errors — Build PASS

> 16A defined the *contract* (READ + WRITE operations on `GlobalSampleIndex`).
> 16B defined the *record schema*. 16C defined the *read/reuse domain semantics*.
> 16D defines the *write domain semantics*: turning a locally produced analysis
> into a publishable candidate, queuing it, deduplicating it, batching it, and
> handing it to the injected `GlobalSampleIndex.publishAnalysisResults(...)`.
> No backend, backend adapter, HTTP, database, auth, provider-specific code,
> or audio uploads/storage were implemented.

---

# 1. Goal

The READ side (16C) decided `known | unknown | incompatible`. The WRITE side
(16D) lets a locally analyzed sample be **controlled, deduplicated, versioned,
and audio-free published** for the later global index:

- a local analysis becomes a publish **candidate** without re-analysis;
- the candidate is **queued**, **deduplicated** (per sample-ref), **batched**,
  and submitted to the injected `GlobalSampleIndex`;
- the queue is **offline-first** (works without a provider) and **audio-free**;
- READ and WRITE stay strictly separated.

---

# 2. Architecture

```
                    LOCAL USER
                        │
                        ▼
                 Audio Analysis          (existing pipeline, untouched)
                        │
                        ▼
                SampleIndexRecord        (local index — never mutated by publish)
                        │
                        ▼
              GlobalPublishCandidate     (publish.ts — createPublishCandidate)
                        │
                 validatePublishCandidate (reuses 16A validatePublishResult)
                        │
                        ▼
              GlobalPublishQueue         (publishQueue.ts)
                        │  enqueue → deduplicate (per sampleId)
                        ▼
                        │  flush() → batch
                        ▼
          GlobalSampleIndex              (provider, injected)
                        │
                        ▼
          publishAnalysisResults(batch)  → GLOBAL INDEX
```

---

# 3. Candidate (`GlobalPublishCandidate`)

`src/global/publish.ts` defines the write-side input. It **reuses** the existing
16A transport shape `GlobalPublishResult` — no parallel candidate type:

```
sampleId            → the sample_ref
contentIdentity     → (contentHash, contentHashVersion)  [authoritative]
analysis            → GlobalAnalysisResult (classification/map/similarity/versions/gate)
features            → feature-derived quantities (for server recomputation)
```

**NO** `AudioBuffer`, `ArrayBuffer`, `Blob`, `Uint8Array`, PCM, or
WAV/FLAC/MP3 bytes anywhere.

`createPublishCandidate(record: SampleIndexRecord)` is a thin adapter from the
persisted local pipeline output. It:
- reuses `assertNoAudioBytes` (throws on any audio byte container);
- requires `status === "analyzed"`, `contentHash`, `contentHashVersion`,
  `analysisSourceFormat`, `similarityFingerprint`, classification + features
  (else throws `PublishCandidateError` — never publishes);
- recomputes the map position from `audioFeatures` via the existing
  `mapPosition` authority (**§26: recompute derived fields, never re-analyze**);
- re-asserts eligibility via `validatePublishCandidate`.

---

# 4. Eligibility

`validatePublishCandidate(candidate)` returns `{ ok }` / `{ ok:false, issues[] }`.
It **delegates to the existing `validatePublishResult`** (16A) — the single set
of rules — checking: no-audio, non-empty sampleId, contentIdentity agreement
between the top-level edge and the canonical `analysis`, version-token shapes,
64-hex contentHash, source format, `gatePassed === true`, known class, confidence
& map ranges, similarity version, and **derived-value cross-check** (map +
fingerprint recomputed from `features`).

The quality gate is **not duplicated**: a locally-rejected / non-analyzed
record is rejected in `createPublishCandidate`, and the structural
`gatePassed === true` is enforced by the shared validator. Rule §12 holds:
**lokal rejected → global published is impossible**.

---

# 5. Queue (`GlobalPublishQueue`)

`src/global/publishQueue.ts`. An in-memory, domain-level publish queue. It is
**not** the local analysis `QueueStore` (`src/persistence/queueStore.ts`), which
tracks per-sample **analysis jobs** (queued/processing/analyzed/failed/gone/
skipped). The publish queue tracks per-sample-ref **publish operations** — a
semantically distinct concern (§9/§28). Persistence is explicitly deferred (§40).

- Constructor: `new GlobalPublishQueue(provider, options)` — provider must
  implement the existing `GlobalSampleIndex`.
- `enqueue(candidate)` → `"queued" | "duplicate"`.
- `flush()` → drains up to `batchSize` pending/due items as ONE
  `publishAnalysisResults(batch)` call.
- `cancel`, `pruneSucceededAndFailed`, `clear`, `pendingCount`,
  `itemsByStatus`, `snapshot`.

---

# 6. Deduplication (content vs sample-ref)

- **Sample-level idempotency**: `enqueue` is keyed on `sampleId`. A second
  enqueue of a non-`failed` item with the same `sampleId` returns `"duplicate"`
  (a `succeeded` item is also duplicate — the reference is already globally
  known; a re-queue would duplicate domain work).
- **Content-level dedup is delegated to the provider**: the existing contract
  `publishAnalysisResults` already collapses duplicate content identities
  (`already-known`) while still registering new `sample_ref`s. The queue sends
  full payloads; the server does content-level collapsing. Results:
  - `AAA→X, BBB→X` → **two** queue items (two sample refs) sharing one content
    identity — §16 (G) verified.
  - `AAA→X, BBB→Y` → two items, distinct content keys — §16 (H).
  - `AAA→X, AAA→X` → one item — §16 (I).

---

# 7. Batching

`flush(batchSize)` collects up to `batchSize` pending (or backoff-due retryable)
items, oldest-first, and submits them in a single `publishAnalysisResults(...)`
call (§21/§31).

- `batchSize` is **deterministic, configurable, provider-independent**
  (default `50`, small local constant — no invented external value).
- **Empty batch**: `flush()` with nothing due returns
  `{ submitted:0, ... }` and never calls the provider (§17 test K).
- Any in-flight items whose transport throws are marked retryable.

---

# 8. Error handling

Per-item outcomes and transport errors are classified (reusing the 16A
`GlobalPublishItemOutcome` / `GlobalIndexError` taxonomy):

| Outcome / error | Classification | Queue effect |
|-----------------|----------------|--------------|
| `stored` | success | `succeeded` |
| `already-known` | success (idempotent) | `succeeded` |
| `validation-rejected` | non-retryable (§19) | `failed` (terminal) |
| `version-incompatible` | non-retryable (§19) | `failed` (terminal) |
| `temporary-unavailable` | retryable (§19) | `retryable` |
| `rate-limited` | retryable (§19) | `retryable` |
| `conflict` | **always terminal, visible** (§26/§42) | `failed` with `lastError="conflict…"` |
| transport throw | retryable | `retryable` |

A **conflict is never silently overwritten**: it always lands in `failed` (never
`retryable`, never auto-resolved). No voting / consensus / force-overwrite logic
exists (§23/§43/§44).

---

# 9. Retry semantics

The domain layer only marks an item `retryable` and schedules a local
`nextRetryAt` backoff. **No `setTimeout`, `fetch`, or exponential-backoff
network engine** is implemented (§20). Transport/network retry scheduling is the
provider's responsibility in a later step. `attemptCount`/`maxAttempts`
(`maxAttempts`, default 3) bound retries; an item becomes terminal `failed`
after exhaustion.

---

# 10. State machine

```
pending ──► in-flight ──► succeeded
               │
               ├──► retryable ──(backoff due)──► in-flight ... (≤maxAttempts)
               │
               └──► failed   (terminal: validation-rejected /
                               version-incompatible / conflict / exhausted)
```

Minimal and deterministic; no workflow engine.

---

# 11. Audio safety (hard invariant)

`GlobalPublishCandidate` is a pure metadata shape. The hardened checks:
- `assertNoAudioBytes` runs when creating a candidate from the local record;
- `validatePublishCandidate` → `validatePublishResult` throws on any byte
  container;
- test **E**, **Q**, **K** and the "no audio in queue / batch / payload" suite
  serialize the candidate, queue snapshot, flush result and provider payload and
  assert no `ArrayBuffer` / `Uint8Array` / `Blob` / `AudioBuffer` / `wavData` /
  `flacData` markers appear.

---

# 12. Offline behavior

The queue accumulates candidates **without a provider**. `enqueue` is a local
in-memory operation and works regardless of server availability; `flush` only
publishes when a provider is injected and reachable (test **T**). A failing
provider leaves items `retryable` for a later flush — **no hard dependency**
between global-server availability and local functionality (§29).

---

# 13. Provider abstraction / READ-WRITE separation

- The queue depends only on the existing `GlobalSampleIndex` interface —
  provider-specific (D1/Supabase/Neon/fetch) imports are absent from the domain
  layer.
- Tests inject a fake `GlobalSampleIndex` and inspect the exact payload (§34).
- **READ never triggers WRITE**: `enqueue`/`flush` never call `lookupSamples`/
  `lookupContentIdentities`; and the 16C read services are untouched.
- **WRITE never mutates the local index**: the local `SampleIndexRecord` is only
  *read* to build a candidate; `IndexStore`/`QueueStore`/Preview/Machiniste/
  Search are never written by publish (§28/§30).

---

# 14. Version independence

The candidate carries versions independently and verbatim from the local record:
`contentHashVersion`, `analysisVersion`, `analysisBuild`,
`classificationVersion`, `mapVersion`, `similarityVersion` (+
`representativeVersion` is schema-side). Bumping one (e.g. `similarity-v2`) does
not change the content identity, so `pcm-v1`/`similarity-v1` remain independent
(§25; test **S**).

---

# 15. Conflict handling

Conflicts are surfaced as a distinct terminal outcome and never auto-resolved
(§42). This Queue's job is to *model* the outcome so the caller can see it, not
to pick "local wins" vs "global wins".

---

# 16. NOT implemented (explicitly out of scope)

- Backend, HTTP, REST, GraphQL, D1/Supabase/Neon/PostgreSQL, auth/PAT/OAuth,
  deployment, rate-limit server, migrations, global map endpoint/viewport API.
- Canvas/WebGL/UI/Find-Similar UI/map clustering.
- Community voting, reputation, moderation, review/approval.
- `force overwrite` / conflict resolution.
- Content verification with audio / audio upload / central audio storage.
- Re-analysis to publish (candidate is built from the already-persisted local
  result).
- Persistence for the publish queue (deferred; currently in-memory).
- Network retry engine (`setTimeout`/`fetch`/exponential backoff).

---

# 17. Open Questions (carried, not "solved")

- **OQ-1 / OQ-7** — Audiotool visibility / publishing policy remains OPEN. 16D
  does not invent a hard `public === publishable` rule or an Audiotool-terms
  decision; eligibility is technical, and visibility is an explicit open
  extension point (a later policy step maps visibility → publishability).
- **OQ-2** — `sampleId` permanence / validated-cache reconciliation: conflicts
  surfaced, resolution deferred.
- **OQ-8** — real WAV-vs-FLAC `contentHash` equality still not verified; the
  pipeline produces one `contentHash` regardless of container.
- **V1 trust boundary**: `contentHash` is taken as an asserted content identity;
  server-side validation cannot prove the hash belongs to the audio without the
  audio (documented, §24).

---

# 18. Test status

40 new tests (`src/global/publish.test.ts`) cover the required matrix:

| Case | Covered | Notes |
|------|---------|-------|
| A valid candidate | ✓ | analyzed record → valid candidate, `ok:true` |
| B missing contentHash | ✓ | throws `PublishCandidateError` |
| C missing contentHashVersion | ✓ | throws |
| D quality gate failed | ✓ | `status != analyzed` rejected |
| E audio bytes | ✓ | `ArrayBuffer`/`Blob` rejected |
| F duplicate candidate | ✓ | same sampleId → one queue item |
| G same content, diff samples | ✓ | one content op (2 sample refs) |
| H different content | ✓ | two content ops |
| I same sample | ✓ | idempotent enqueue |
| J batch | ✓ | single `publishAnalysisResults` call |
| K empty batch | ✓ | returned 0, no provider call |
| L retryable (temporary-unavailable) | ✓ | item `retryable` |
| M rate-limited | ✓ | item `retryable` |
| N validation-rejected | ✓ | terminal `failed` |
| O version-incompatible | ✓ | terminal `failed` |
| P conflict | ✓ | terminal, visible, never auto-resolved |
| Q provider payload | ✓ | captured & inspected, no audio |
| R idempotency | ✓ | no duplicate domain work |
| S version independence | ✓ | map/similarity don't change content identity |
| T offline | ✓ | queue accumulates w/o provider; retryable |
| integration flow (§33) | ✓ | local→candidate→queue→batch→provider |
| + cancel / prune / mixed-outcome / no-audio / read-write | ✓ | |

**before:** 405/405 — **after:** 445/445 (26 files). No existing test rewritten.

---

# 19. Build status

- `npx tsc --noEmit` → **PASS (0 errors)**
- `npx vitest run` → **445 passed**
- `npm run build` → **PASS** (~540 ms; pre-existing chunk-size warning only)

Production files changed: **0**. Production files created: **3**
(`src/global/publish.ts`, `src/global/publishQueue.ts`, `publish.test.ts`).

---

# 20. Verification report (§49)

```
STEP 16D — IMPLEMENTATION REPORT

Status:
DONE

Production files created:
- src/global/publish.ts          (candidate + eligibility + local-record adapter)
- src/global/publishQueue.ts     (publish queue: dedup / batch / errors / retry)
- src/global/publish.test.ts     (40 tests)

Production files changed:
- (none)

Tests:
before: 405/405
after:  445/445
passed: 445
failed: 0

TypeScript:
PASS
errors: 0

Build:
PASS

Verified:
- local analyzed result → candidate without re-analysis (createPublishCandidate)
- same content discovered twice → no duplicate content-analysis work (content dedup)
- two sampleIds → same content identity (AAA/BBB → X) → two sample refs, one content
- queue operates offline (enqueue without provider)
- later real GlobalSampleIndex can be injected without rebuild (interface only)
- all audio bytes excluded from candidate / queue / batch / payload
- conflicts surfaced as terminal, never auto-overwritten
- versions independent (map/similarity don't alter contentHashVersion)
- no new backend assumption in the domain layer
- all 405 prior (16C) tests still green

Not verified:
- real backend publish (no real backend provider exists in this step) — simulated
  via an injected fake GlobalSampleIndex only
- publish-queue persistence (deferred to a later step)

Blocked:
- (none)

Open Questions:
- OQ-1 / OQ-7  Audiotool visibility / publishing policy (open extension point)
- OQ-2         sampleId permanence / validated-cache reconciliation (conflict surfaced)
- OQ-8         real WAV-vs-FLAC contentHash equality
- V1 trust     contentHash accepted as asserted identity (no audio to verify)

Out of scope:
- backend / HTTP / REST / GraphQL / D1 / Supabase / Neon / PostgreSQL
- auth / PAT / OAuth / deployment / hosting / rate-limit server / migrations
- global map endpoint / viewport API / Canvas / WebGL / UI / clustering
- community voting / reputation / moderation / review
- audio upload / central audio storage / content verification with audio
- network retry engine / force-overwrite / consensus logic
```
