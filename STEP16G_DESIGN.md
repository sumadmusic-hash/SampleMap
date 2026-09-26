# SampleMap — Step 16G: Publication / Usage Acceptance Gate (DESIGN ONLY)

**Status: DESIGN COMPLETE**
**Date:** 2026-09-03
**Scope:** Design-only. No production implementation, no schema/DB/Worker/API/UI changes,
no analysis/identity changes, no ratings/likes/voting/trust. This document defines the V1
publication/usage-acceptance **policy** and the **design** for Step 16H to implement.

---

## 1. Purpose

Define the minimal V1 policy controlling when a locally analyzed sample becomes eligible for
the global SampleMap, and where the "usage acceptance" gate sits in the existing pipeline.

Core product principle (unchanged from the brief):

> A sample being analyzed does NOT automatically make it globally publishable.
> A sample becomes eligible for the global SampleMap only after a user has successfully
> transferred that sample from SampleMap into Machiniste.

Successful transfer is a much stronger signal of actual usefulness than merely scanning,
analyzing, previewing or selecting a sample.

This step answers *what* the gate is, *where* it sits, and *how it fails/retries* — without
implementing any of it and without inventing social/trust/consensus features.

---

## 2. Current Architecture Facts (verified against the codebase)

Verified by direct inspection of the existing sources (no assumptions):

### 2.1 Transfer (Machiniste)
- `src/machiniste/machinisteService.ts` — `SampleMapMachinisteService.send(
  samples, machinisteId, slots)` performs a **single atomic `doc.modify(...)`
  transaction** that creates a document-local `Sample` entity per input sample and points a
  `MachinisteChannel[slot].sample` at it, then performs a **read-back pass against committed
  `doc.queryEntities` state**.
  - Returns `MachinisteSendResult`: `{ machinisteId, committed, slots[], errors[] }`.
  - Per-slot `MachinisteSlotResult`: `{ slot, sampleName, applied, readBackMatches,
    sampleEntityId, errors[] }`.
  - `committed === true` ⇔ the transaction was applied (all-or-nothing).
  - `readBackMatches === true` per slot ⇔ the committed state actually contains the pointer
    we wrote and the Sample entity we created.
- `src/machiniste.ts` — `loadLibrarySampleIntoMachiniste(doc, sample)` returns
  `MachinisteTestResult` with `directReferenceApplied`, `readBackMatches`, `created`,
  `errors[]`. (Used by `src/main.ts` and `src/cli.ts` for the opt-in test button/CLI.)
- `src/machiniste.test.ts`, `src/machiniste/machinisteService.test.ts` — cover the
  happy path + validation/failure modes.

### 2.2 Local analysis
- `src/pipeline/analysisPipeline.ts` — `AnalysisPipeline.run(sampleId, analysisBuild)`:
  resolve metadata → select lossless source → fetch (transient audio) → container gate →
  fileHash → decode → decoded-PCM gate → canonical PCM → contentHash → extract features →
  classify → `index.put(record)` → release audio. Stores a `SampleIndexRecord` with
  `status: "analyzed"`, classification, `audioFeatures`, `analysisSourceFormat`,
  `fileHash`, `contentHash`, `contentHashVersion`, `similarityFingerprint`.
  **None of this publishes globally.**
- `src/persistence/indexStore.ts` — `SampleIndexRecord` shape; `assertNoAudioBytes`
  hard invariant.

### 2.3 Global publish infrastructure (exists, tested, NOT wired into the UI)
- `src/global/contract.ts` — `GlobalSampleIndex` interface:
  `lookupSamples | lookupContentIdentities | publishAnalysisResults | queryMapViewport`.
  No raw audio, no provider terms. Identity is the existing model.
- `src/global/publish.ts` — `GlobalPublishCandidate = GlobalPublishResult`;
  `createPublishCandidate(record)` adapts a local analyzed `SampleIndexRecord` into a
  publishable candidate **without re-analyzing** (map position recomputed from
  `audioFeatures`). `validatePublishCandidate` delegates to the single `validatePublishResult`.
- `src/global/publishQueue.ts` — `GlobalPublishQueue`: **in-memory** queue with
  sampleId-level idempotency (`enqueue` duplicate), batching (`flush(batchSize)`), retry with
  backoff + `maxAttempts`, per-item outcome classification (stored/already-known →
  succeeded; conflict → terminal; temporary-unavailable/rate-limited → retryable).
  Explicit note: *"Persistence is explicitly deferred to a later step (§40). The queue
  currently operates in-memory."*
- `src/global/lookup.ts` — provider-agnostic global lookup service.
- `src/global/schema.ts`, `validation.ts` — content-hash/fingerprint/gate validation.

### 2.4 Provider / deployment (16F, live)
- `workers/d1-worker/` — Cloudflare Worker + D1 provider (`CloudflareGlobalSampleIndex`,
  `src/provider.ts`) and `CloudflareGlobalAdapter` (`src/browserAdapter.ts`, client `fetch`
  transport). D1 schema: `sample_ref` (sampleId → content identity) + `content` (canonical
  row per content identity) with content dedup, `already-known`, conflict protection, and
  lex-min representative selection. Live-verified (16F-12). `PublishAuthorizer` is permissive
  / injectable by design (OQ-9).

### 2.5 Key observation: no auto-publish path today
`GlobalPublishQueue` and `GlobalSampleIndex.publishAnalysisResults` are referenced only by
**tests** (`src/global/publish.test.ts`, `lookup.test.ts`). There is **no call site in
`src/main.ts`, `src/ui/`, or `src/cli.ts`** that enqueues or flushes a publish. Therefore the
current app does NOT auto-publish on analysis — the gate has no code to block yet; Step 16H
establishes the publish seam AND the gate together.

### 2.6 Identity model (existing, reused unchanged)
- Audiotool sample identity: `sampleId` = `samples/{uuid}` (the `sample_ref`).
- Exact file identity: `fileHash` (SHA-256 of the exact source container bytes) — kept on the
  local record; not a publication key.
- Audio content identity: `contentHash` + `contentHashVersion` (SHA-256 of versioned canonical
  PCM; `identity/audioContentIdentity.ts`).
- Perceptual similarity: `similarityFingerprint` + `similarityVersion` (similarity-v1).
- Representative: `selectRepresentative` = **lexicographically smallest sampleId**
  (deterministic, `identity/audioContentIdentity.ts`); `REPRESENTATIVE_VERSION =
  "representative-v1"`. Single authority; **not redesigned**.

### 2.7 Open questions
- **OQ-1** — Which Audiotool visibility/policy rules govern global publishing of analysis?
  OPEN. STEP16_DESIGN recommendation for V1: publish only public + self samples (conservative).
- **OQ-9** — Publish write-path authentication. OPEN; `PublishAuthorizer` is a permissive/
  injectable placeholder, explicitly NOT a security boundary. **16G does not solve OQ-9.**

---

## 3. Problem Statement

Today there is no product-level gate between "this sample passed analysis" and "this sample is
globally published." The publish queue and provider exist, but nothing connects a real, verified
human action (using a sample) to global publication. Without a gate, analysis alone (which can
happen for any readable sample, including samples a user never actually uses) would make
samples visibly global across the community — known as "analysis = publication," which the
brief explicitly rejects.

The V1 requirement: **a sample becomes globally publishable only after a user successfully
transfers it into Machiniste** (a real, verified use). Successful transfer is a binary,
actionable, product-level signal with an existing, reliable success boundary in the codebase.

---

## 4. V1 Publication Policy

- **Local discovery, scanning, previewing, analyzing, classifying, map-positioning,
  content-hashing, and similarity-fingerprinting are all LOCAL-ONLY.** None of them publish
  globally. They may write to the user's local `IndexStore` record but never to the global index.
- **Global knowledge** is consumed, not recomputed: if the content identity is already globally
  known, users reuse the existing global analysis (skip unnecessary local audio analysis) via
  `GlobalSampleIndex.lookupSamples` / `lookupContentIdentities`. The global index is the
  community-built knowledge base; analysis work is distributed.
- **Usage acceptance** is the single binary enabler: it occurs **only after a real, successful
  Machiniste transfer** (see §6).
- **Global publication** happens after usage acceptance: publish the *existing* local analysis
  result to the global index. No re-analysis, no global audio download/storage; only
  metadata/analysis/identity per the existing contract.

Binary flow (exactly as specified):

```text
not usage-accepted
        ↓
successful Machiniste transfer
        ↓
usage-accepted
        ↓
eligible for global publication
```

No ratings, stars, likes, reputation, voting, ML trust scores, consensus, multi-user approval,
or usage thresholds (5/10/25 users) in V1. `usageCount` is explicitly **not** a V1 feature and
is only mentioned as a possible future monotonic extension — not implemented, not required.

---

## 5. Precise Definition of Usage Acceptance

**Usage-accepted** := the machine-observable fact that, for a given `sampleId`, a real
`SampleMapMachinisteService.send(...)` (or the verified POC helper `loadLibrarySampleInto-
Machiniste`) reported **transfer success** for that sample per the success boundary in §6.

Usage acceptance is a **per-sample-reference (sampleId-level)** predicate. It is NOT a
content-level predicate and NOT a global flag on content (see §10).

V1 is strictly binary: a sample is either usage-accepted (because a verified transfer
succeeded for that sampleId) or it is not. There is no partial/rating state.

---

## 6. Transfer-Success Boundary (what "successful transfer" is)

The publication event MUST NOT fire merely because a button was clicked, a transfer was
requested, a transaction object was constructed, or an API call was attempted.

The reliable success signal is the **returned result of the existing transfer operation**,
observed after the atomic commit AND after the read-back verification:

**Primary boundary (source of truth):** `SampleMapMachinisteService.send()` returns per-slot:
- `slot.readBackMatches === true` **and**
- `slot.applied === true` **and**
- `result.committed === true` and `result.errors.length === 0` for the batch.

`readBackMatches` is the strongest available signal: it re-queries the **committed document
state** (`doc.queryEntities`) and confirms that the channel pointer equals the Sample entity we
created, and that the Sample entity's `sampleName` equals the sample reference we wrote. This is
a genuine read-back verification, not just "send returned."

**Secondary/fallback boundary:** for the single-sample POC path,
`loadLibrarySampleIntoMachiniste()` reports `directReferenceApplied === true` AND
`readBackMatches === true` AND `created === true` AND `errors.length === 0`. Used only where
that helper is the integration point.

**Failure ⇒ NOT usage-accepted:** any of the following means the sample is NOT usage-accepted
and MUST NOT be published:
- `committed === false` (transaction rejected)
- `slot.applied === false` or `slot.readBackMatches === false` for the sample's slot
- any top-level `error` (e.g. MachinisteNotFound, validation, out-of-range slot)
- a thrown/transport-level failure

**Implementation-requirement note for 16H (do NOT invent the boundary now):** The success
signal is the return value of `send()`/`loadLibrarySampleIntoMachiniste()`. Unlike a bare
`fetch()`-style "API called", this boundary already includes an atomic commit + read-back
verification, so it is sufficiently reliable for V1 usage acceptance. No new
"transfer success" flag needs to be invented; 16H should consume these existing return values.
(The one gap is persistence of the accepted fact across app restarts, addressed in §8 and listed
as an explicit 16H decision in §14.)

---

## 7. Publication Sequence

Normal flow:

```text
LOCAL_ANALYZED  (AnalysisPipeline.run -> status "analyzed" in IndexStore)
      ↓
user requests Machiniste transfer
      ↓
SampleMapMachinisteService.send(...)  /  loadLibrarySampleIntoMachiniste(...)
      ↓
transfer SUCCESS  (readBackMatches=true)
      ↓
usage acceptance  (per sampleId)
      ↓
GlobalPublishQueue.enqueue(createPublishCandidate(localRecord))
      ↓
GlobalPublishQueue.flush()
      ↓
GlobalSampleIndex.publishAnalysisResults(batch)
      ↓
global index
```

Failure flow:

```text
transfer FAILS (committed=false | readBackMatches=false | errors non-empty)
      ↓
NO usage acceptance
      ↓
NO global publication  (nothing enqueued)
```

Sequencing invariants:
- Local analysis must already exist (`createPublishCandidate` requires
  `record.status === "analyzed"`) — publication never initiates analysis.
- Usage acceptance MUST be derived from the transfer success boundary, never assumed.
- Enqueue happens only after acceptance; flush only when a provider is available (the existing
  queue is offline-first).

---

## 8. Failure / Retry Semantics (transfer succeeded, publish failed)

**The two operations are NOT one atomic transaction** and the design does NOT pretend they are.
The existing `send()` transaction is separate from `publishAnalysisResults`. State is modeled
explicitly:

```text
Machiniste transfer = SUCCESS
Global publish       = FAILED
```

The sample WAS genuinely used, so usage acceptance must NOT be lost merely because the
subsequent network publication failed.

**Design (smallest reliable mechanism, reusing existing primitives — no distributed
transaction):**

1. **Decouple acceptance from delivery.** A successful transfer marks the sample as
   usage-accepted and this acceptance is the durable product fact. Publication delivery is a
   separate concern handled by the existing `GlobalPublishQueue`.
2. **Reuse the existing in-memory publish queue semantics** (already implemented in
   `publishQueue.ts`): `enqueue()` then `flush()`; `already-known` counts as success;
   `temporary-unavailable`/`rate-limited` are retryable with backoff + `maxAttempts`;
   `conflict` is terminal + surfaced. This already provides exactly the retry/dedup needed.
3. **Idempotency makes retry safe.** Because re-publishing the same sampleId is idempotent at
   the provider (`already-known`) and at the queue (sampleId-level duplicate), retrying after a
   failed publish is safe and does not create canonical duplicates.
4. **16H persistence decision (explicit, deferred):** the current `GlobalPublishQueue` is
   **in-memory** (its comment says persistence is deferred to a later step). For V1 durability
   of "usage-accepted + not-yet-published", 16H should decide between:
   - (a) persist a tiny per-sample "usage-accepted / publish-pending" marker (e.g. in the local
     `IndexStore` record — a domain field, not a new DB) so an accepted-but-unpublished sample
     is re-enqueued on next app start; **or**
   - (b) accept V1 as ephemeral: acceptance lives only in the running app session, and a failed
     publish simply shows a retry affordance; on restart the user re-transfers (idempotent).
   This is a concrete Step 16H requirement (see §14) — the design does NOT pick it by fiat, and
   neither option invents a distributed transaction. Either way, if the transfer already
   succeeded, repeating the transfer (or re-enqueueing) is idempotent and never duplicates
   canonical content.

**Guarantee:** acceptance is never lost purely because of a network publish failure in the
session; it is re-attempted via the queue (option a) or re-expressible by idempotent
re-transfer/enqueue (option b).

---

## 9. Idempotency (same sample transferred again)

Reuses existing global semantics — no new mechanism.

- **Queue level:** `GlobalPublishQueue.enqueue()` is idempotent per sampleId — a second
  enqueue for the same non-terminal sampleId returns `"duplicate"` and creates no second item.
- **Provider level:** `publishAnalysisResults` collapses duplicate content identities
  (`already-known`), registers a new sample reference only once, and preserves
  conflict-protection. Re-publishing the same sampleId → already-known.
- **Transfer level:** re-transferring the same sample is a normal Machiniste transaction; if it
  succeeds again it simply re-affirms acceptance (which is idempotent). It never duplicates
  canonical content.

A second successful transfer of the same sample does NOT create a duplicate canonical record.
The same `sampleId → contentIdentity` mapping is maintained by the existing `sample_ref`
semantics.

---

## 10. Content Identity Interaction (two sampleIds with same contentHash)

Example: `sample A → content X`, `sample B → content X`.

The existing content-identity model already guarantees **one canonical content identity**
(`content` PK on `(content_hash, content_hash_version)`) while allowing **both sample
references** (`sample_ref` rows A and B) — with content dedup and lex-min representative
selection. This is unchanged.

**Usage acceptance is sample-reference-level (not content-identity-level).** Reasons:

1. The transfer signal is inherently per-sample-reference: a user transfers *this sample*
   (`sampleId A`) into a Machiniste channel. Acceptance attaches to that sample reference.
2. Making acceptance content-level would let one accepted transfer of A implicitly publish
   every other sampleId sharing content X (e.g. B), which overstates the product signal for B
   and effectively turns acceptance into a content-identity replacement. The brief explicitly
   forbids accidentally converting usage acceptance into a content-level identity replacement.
3. Content-level dedup still operates at the provider: once A or B is published, the canonical
   content row exists; publishing the other later adds only its own `sample_ref` and reuses the
   content (no re-analysis).

Therefore: **publication payloads remain per-sample-reference(sampleId)**, and the provider's
existing content dedup (not acceptance) collapses identical content. Representative stays the
existing lex-min rule; no second representative mechanism is invented.

---

## 11. Existing Globally-Known Samples (User B discovers globally-known Sample A)

Behavior:

- **Reuse global analysis:** User B's app first consults the global index
  (`lookupSamples([sampleId])` / `lookupContentIdentities`). If the content identity is
  globally known, User B reuses the canonical global analysis and **does not perform
  unnecessary local audio analysis** (no download/decode of already-known audio).
- **Still can transfer:** User B may still transfer the original Audiotool sample into
  Machiniste (a legitimate local use) — this is independent of global knowledge.
- **May produce a usage event:** User B's successful transfer can create another
  usage-acceptance (for B's sample reference). But **V1 does NOT require multiple usage events**
  for publication. A single successful transfer of any given sample reference is sufficient to
  make that reference eligible.
- **Publication of a globally-known sample** should practically be a no-op at the provider
  (`already-known` for the content; possibly a new `sample_ref` if B's sampleId differs). The
  queue still treats it as success.

The design does not use "number of users who used sample X" as a gate (explicitly out of scope).

---

## 12. Security Boundary / OQ-9 Separation

16G does **not** solve OQ-9. The current `PublishAuthorizer` is intentionally
permissive/injectable and is **not** a production security boundary.

16G only establishes:

> "A successful usage acceptance produces a publish request."

It explicitly does **not** invent: OAuth architecture, JWT implementation, API keys, a user
account system, Cloudflare Access, or rate-limit policy. Those belong to the later OQ-9
decision. The gate here is a *product* gate (usage), not an *authentication* gate. If OQ-9 later
adds attestation, it composes on top of usage acceptance without changing this policy.

---

## 13. State Machine

Conceptual per-`sampleId` state model. **These are conceptual states, not necessarily
persisted states** (see §8 option a/b; 16G does not add any persistence):

```text
LOCAL_ANALYZED
      │
      ▼
TRANSFER_REQUESTED
      │
      ├── failure ──→ LOCAL_ANALYZED
      │
      ▼
TRANSFER_SUCCEEDED   (committed=true, readBackMatches=true)
      │
      ▼
USAGE_ACCEPTED
      │
      ▼
PUBLISH_PENDING
      │
      ├── publish success ──→ GLOBALLY_PUBLISHED
      │
      └── publish failure ──→ PUBLISH_PENDING   (retry; acceptance retained)
```

Notes:
- `PUBLISH_PENDING ── publish success ── GLOBALLY_PUBLISHED` includes both `stored` and
  `already-known` provider outcomes (both mean "present globally").
- `PUBLISH_PENDING ── publish failure ── PUBLISH_PENDING` is the retry loop (§8). Conflict is a
  terminal *delivery* failure but is surfaced (never silently overwritten), and acceptance is
  still retained; it does not roll back usage acceptance.
- Whether these states are persisted (option a) or live only in the running session (option b)
  is a Step 16H implementation decision; the list above is the deterministic model in either case.

---

## 14. Required Step 16H Implementation Changes

These are the minimum, focused code changes to implement the policy. **Design-only now; 16H
actual code.** No architecture/DB/Worker/schema/API/analysis/identity changes beyond these.

1. **Establish the publish seam.** Introduce a small orchestration function (e.g.
   `publishAfterUsageAcceptance(...)`) in the app layer that:
   - takes the transfer result for a sampleId;
   - checks the §6 success boundary (`committed`+`applied`+`readBackMatches`, or the POC
     helper's flags);
   - on success, reads the local analyzed record and enqueues
     `createPublishCandidate(record)` into the existing `GlobalPublishQueue`;
   - on failure, does NOT enqueue.
   This is the only place where "analysis → global publish" is connected to a verified human
   action. Wiring the existing queue/provider into the app UI/main is part of this step
   (currently there is no call site).
2. **Add no new algorithm.** Reuse `createPublishCandidate`, `GlobalPublishQueue`,
   `GlobalSampleIndex.publishAnalysisResults`, and lex-min representative.
3. **Durability decision (choose at 16H):**
   - Option (a): add a minimal, domain-level "usage-accepted / publish-pending" marker to the
     local `SampleIndexRecord` so accepted-but-unpublished samples are re-enqueued after a
     restart (no new DB, no schema change — a field on the existing record).
   - Option (b): accept ephemeral acceptance + a user-facing retry affordance; document the
     trade-off. Re-transfer/enqueue stays idempotent.
   Either is acceptable; the design requires 16H to make one explicit choice and to keep
   publication idempotent and non-duplicating.
4. **Tests (16H):** extend the existing `publish.test.ts` / add an orchestration test proving:
   transfer success → enqueue; transfer failure → no enqueue; re-transfer idempotent; publish
   failure retains acceptance; two sampleIds same content still yield one canonical content.

**Deferred to a non-16G/16H decision (not required for Step 16H readiness):** OQ-9 auth
mechanism; Audiotool republishing legal review (OQ-1); persistence/durability of the queue to a
durable store; `usageCount`.

---

## 15. Explicit Non-Goals

- No production implementation in 16G.
- No new database tables; no schema changes (including no D1/schema changes).
- No new API endpoints; no changes to the Cloudflare Worker.
- No UI redesign; no changes to the analysis algorithm, similarity-v1, map-v1, or content
  identity.
- No ratings / stars / likes / reputation / voting / ML trust scores / consensus / multi-user
  approval / usage thresholds (5/10/25).
- No `usageCount` implementation (future-extension only, not a V1 requirement).
- No `GlobalSampleIndex` contract changes (the contract already carries everything needed).
- No distributed transaction between transfer and publish.
- No speculative Audiotool APIs; no fake authentication.
- No persistence added by 16G itself (16G is design; only 16H may add the minimal §8 marker
  under its explicit decision).

---

## 16. Open Questions

| OQ | Question | Status / Design note |
|---|---|---|
| OQ-1 | Audiotool visibility/publishing policy (which samples may be republished globally) | **OPEN.** Conservative V1 recommendation (STEP16_DESIGN): publish only public + self samples. 16G places the usage gate; OQ-1 still governs *which samples are eligible*. Out of scope for 16H correctness. |
| OQ-9 | Publish write-path authentication mechanism | **OPEN.** Deliberately not solved by 16G. Composes on top of usage acceptance later. |
| OQ-2 | `sampleId` permanence over long horizons | **OPEN** (step 16). Unaffected by 16G. |
| 16G-1 | Durable retention of "usage-accepted / publish-pending" across app restarts (option a vs b in §8/§14) | **16H decision.** The design leaves both valid; 16H must choose. |
| 16G-2 | Does the app currently need a visible "publish status" affordance? | **16H UX decision** (not a 16G requirement). The gate semantics are fixed; only presentation is open. |
| 16G-3 | `usageCount` future extension | **Deliberately not a V1 requirement.** Possible monotonic counter later, behind OQ-9 attribution. |

---

## 17. Acceptance Criteria

- A sample that is only discovered/scanned/analyzed/classified/map-positioned/hashed is
  **never** globally published.
- A sample becomes globally publishable **only after** a real, verified successful Machiniste
  transfer (per the §6 boundary) — not on click/request/construct/attempt.
- A failed transfer never yields usage acceptance and never publishes.
- Transfer success followed by publish failure **retains** usage acceptance (no loss, no
  distributed transaction), and is retried idempotently via the existing queue.
- Re-transferring the same sample is idempotent and never creates duplicate canonical content.
- Two sampleIds sharing one contentHash still yield **one canonical content identity**, both
  sample references preserved, representative = existing lex-min rule.
- Already globally-known samples: users reuse global analysis (no unnecessary re-analysis) and
  may still transfer; V1 requires **no** multiple-usage threshold.
- No OQ-9/auth architecture, no ratings/likes/voting/trust/consensus/thresholds in the design.
- Global record shape is exactly the existing `GlobalPublishResult` (nothing added/missing).
- 16G introduces **zero** production code changes (baseline preserved: 445 tests, 0 tsc
  errors, build pass).

---

## Appendix A — How to ship this in 16H (reference, not this step's deliverable)

```text
local IndexStore["analyzed"] ──► [orchestration] ──► transfer.send()
        │                                              │success(readBackMatches)
        │                                              ▼
        │                                     createPublishCandidate(record)
        │                                              │
        └───────────── do NOT enqueue ──┐              ▼
                                        ├────► GlobalPublishQueue.enqueue() ──► flush() ──► publishAnalysisResults
        failure returns to LOCAL_ANALYZED                                   (retry/backoff/already-known/conflict)
```

---

## Status

`DESIGN COMPLETE`

## Production Changes

`0`

## Tests

`445 passed (26 files)` — recorded baseline; unchanged.

## TypeScript

`npx tsc --noEmit` → exit `0` (0 errors)

## Build

`npm run build` → PASS (vite, 528ms)

## Open Questions

- **OQ-1** — Audiotool visibility/publishing policy (OPEN; conservative V1 recommendation: public + self samples).
- **OQ-9** — Publish write-path auth (OPEN; deliberately not solved in 16G).
- **OQ-2** — `sampleId` long-horizon permanence (OPEN, step-16 scope; unaffected).
- **16G-1** — Durability of "usage-accepted / publish-pending" across restarts (a vs b) — Step 16H decision.
- **16G-2** — Publish-status UI affordance — Step 16H UX decision.
- **16G-3** — `usageCount` future extension — deliberately not a V1 requirement.

## Step 16H Readiness

**READY.** Implementation can proceed without further architectural decisions: the usage
gate is fully specified (success boundary, sequence, failure/retry, idempotency, content-identity
interaction, globally-known-sample behavior), and all required mechanics
(`createPublishCandidate`, `GlobalPublishQueue`, `GlobalSampleIndex.publishAnalysisResults`,
lex-min representative) already exist and are tested — 16H wires them behind the transfer-success
boundary and makes one explicit durability choice (16G-1). OQ-9 (auth) and OQ-1 (republishing
legal policy) are out of scope for 16H correctness.
