# STEP 16H — Usage Acceptance → Global Publish (Implementation)

**Date**: 2026-09-03
**Type**: Domain orchestration step (verified-transfer → publish wiring; NO backend/DB redesign, NO worker change)
**Baseline before**: 445 tests / 26 files — tsc 0 errors — Build PASS (523ms)
**After**: 466 tests / 27 files — tsc 0 errors — Build PASS (556ms) — Worker unchanged (19/19 tests, untouched)

> 16A defined the contract, 16B the record schema, 16C read/reuse semantics,
> 16D write/publish-queue semantics, 16E/16F the Cloudflare adapter + D1 worker,
> 16G the DESIGN for wiring a **verified Machiniste transfer** to global
> publication (usage acceptance). 16H IMPLEMENTS that seam: global publication
> now happens ONLY after a real, verified usage acceptance, with Option-A local
> durability (persisted marker on the existing record) and offline-first restart
> reconstruction. No cloud service, no new DB/D1 schema, no worker change.

---

# 1. Goal

STEP16G_DESIGN.md defined that global publication must be gated on genuine,
verified **usage acceptance** — not on raw analysis. 16H implements:

- acceptance predicates against the **existing** transfer result types
  (`SampleMapMachinisteService.send()` and the POC
  `loadLibrarySampleIntoMachiniste()`), enforcing the 16G success boundary;
- an orchestrator `acceptUsageAndEnqueue(...)` that, on verified success, loads
  the analyzed `SampleIndexRecord`, persists a local acceptance marker (Option A
  durability), and enqueues a publish candidate into the existing
  `GlobalPublishQueue` (never on failure);
- offline-first delivery (`flushPendingPublications`) + restart reconstruction
  (`reconstructPending`) that re-enqueues accepted-but-undelivered samples
  idempotently WITHOUT a live provider;
- UI wiring in `main.ts` `runMachinisteTest()` behind the existing verified
  success check, without altering the Machiniste diagnostics path.

No worker/D1 redesign, no new API/DB, no analysis/DSP/ML, no similarity-v1 /
contentHash / GlobalSampleIndex contract change, no Machiniste semantics change,
no ratings/likes/voting/trust/usageCount, no OAuth/JWT/API-keys.

---

# 2. The 16G acceptance boundary (implemented verbatim)

The success boundary from STEP16G_DESIGN §2, applied from the real types:

| Path | Fields checked for acceptance |
|---|---|
| `send()` (plural service) | `result.committed === true` AND `result.errors.length === 0` AND the slot for the target `sampleName` has `applied === true` AND `readBackMatches === true` AND `slot.errors.length === 0` |
| `loadLibrarySampleIntoMachiniste()` (POC single) | `directReferenceApplied === true` AND `readBackMatches === true` AND `created === true` AND `errors.length === 0` |

These are pure predicates (`isSendSlotAccepted`, `isPocAccepted`,
`isUsageAccepted`) over the existing result fields — no new/shaped return type
is invented.

---

# 3. Architecture

```
   VERIFIED Machiniste transfer          (send() / loadLibrarySampleIntoMachiniste)
        │
        ▼  isUsageAccepted(evidence)  ← 16G boundary (pure, exact result types)
   accepted? ── no ──► NOT persisted, NOT enqueued (returns structured reason)
        │ yes
        ▼
   load SampleIndexRecord (index.get)
        │  status === "analyzed"  (else reject, never enqueue)
        ▼
   createPublishCandidate(record)   (reuses 16A/16D, never re-analyzes)
        │
        ▼
   GlobalPublishQueue.enqueue(...)  (sampleId-level idempotent)
        │
        ▼  persist marker (Option A; local only, audio-free)
   record.globalPublish = { usageAcceptedAt, delivery: "pending" }
        │
        ▼ (later / on restart / when provider present)
   flushPendingPublications()  → provider stored / already-known → mark "published"
   reconstructPending()        → offline-first restart re-enqueue
```

Transfer and publish are **NOT atomic**: accepted-but-publish-failed stays
`"pending"` and is retried idempotently via the existing queue. `stored` /
`already-known` = success; `conflict` = terminal (marker not overwritten to
published); temporary/rate-limited = retryable (classification owned by
`GlobalPublishQueue`).

---

# 4. Production changes

| File | Change |
|---|---|
| `src/global/usageAcceptance.ts` | **NEW.** Orchestration: `TransferEvidence`, predicates (`isSendSlotAccepted`/`isPocAccepted`/`isUsageAccepted`), `acceptUsageAndEnqueue`, `markDelivered`, `flushPendingPublications`, `reconstructPending`, outcome/reject-reason types. |
| `src/persistence/indexStore.ts` | Added Option-A local marker field to `SampleIndexRecord`: `globalPublish?: { usageAcceptedAt: string; delivery: "pending" \| "published" }`. Metadata-only (two strings); passes `assertNoAudioBytes`. |
| `src/main.ts` | Wired the seam: opens the local IndexedDB (`safeOpenLocalIndex`), bootstraps an offline-first `GlobalPublishQueue` (`offlineProvider` returns `temporary-unavailable` → retryable), calls `reconstructPending` at startup, and in `runMachinisteTest()` calls `acceptUsageAndEnqueue` + `flushPendingPublications` **after** the existing verified-success check. All wrapped so the diagnostics path can never break. |
| `src/global/usageAcceptance.test.ts` | **NEW.** 21 tests covering required A–J + plural-routing + predicates. |

No changes under `workers/`. The Cloudflare Worker/D1 is untouched and its own
test suite still passes 19/19.

---

# 5. Usage acceptance (gating)

- Acceptance is **sampleId-level only** (stored on the specific `sample_ref`).
  B is never implicitly accepted merely because B shares the `contentHash` of an
  accepted A; B gets its own marker only when B is itself transferred +
  verified. (`createPublishCandidate(B)` is never invoked for B otherwise.)
- Same contentHash → one canonical content via the existing contract +
  representative rule; but publication of sampleId B requires B's own verified
  acceptance.
- Global known samples reuse the global analysis and remain transferable;
  a single usage event is sufficient (no threshold introduced).

---

# 6. Persistence (Option A durability)

`globalPublish` is a local, best-effort marker on the existing
`SampleIndexRecord` — no new DB, no D1 schema, no cloud service. State mapping:

- **not accepted** → `globalPublish` absent
- **accepted / publish pending** → `globalPublish = { usageAcceptedAt, delivery: "pending" }`
- **globally published** → `delivery: "published"` (local flag; the
  `GlobalSampleIndex` remains the authoritative global truth on restart)

The marker is metadata-only and survives `assertNoAudioBytes`. A "published"
flag that is actually gone globally is not recomputed here (OQ-16G-3) — see
Open Questions.

---

# 7. Publish retry + idempotency

- Retry/backoff/maxAttempts/conflict handling is owned by the existing
  `GlobalPublishQueue` (16D), reused unchanged.
- `acceptUsageAndEnqueue` is idempotent at the queue level: a second identical
  verified transfer yields `enqueue = "duplicate"` and a single queue item.
- `reconstructPending` on restart re-enqueues accepted-but-not-published records
  idempotently (queue dedup makes repeats safe), requiring no provider and no
  re-analysis.

---

# 8. UI wiring

In `main.ts`, after a verified POC transfer
(`result.readBackMatches && result.errors.length === 0`), the app:
1. `acceptUsageAndEnqueue({ index, queue }, { kind: "poc", result })` — persists
   the acceptance marker and enqueues the publish candidate;
2. `flushPendingPublications(...)` — attempts delivery through the queue's
   provider and upgrades markers to "published" on provider success.

On a failed transfer nothing is accepted, enqueued, or persisted. At boot,
`reconstructPending` re-queues previously accepted-but-undelivered records.

---

# 9. Verification

- **App tests**: 466/466 passed (27 files) — 21 new in `usageAcceptance.test.ts`.
- **TypeScript**: `tsc --noEmit` → exit 0.
- **Build**: `npm run build` → PASS (556ms; pre-existing chunk-size warning).
- **Worker**: `workers/d1-worker` untouched; its own suite 19/19 passed.

## Required acceptance tests (A–J) — all implemented

| Case | Status |
|---|---|
| A — verified transfer → accepted + enqueued | ✓ |
| B — failed transfer (not committed) → NOT accepted, nothing enqueued | ✓ |
| C — read-back failure → NOT accepted | ✓ |
| D — publish failure → retained as `pending`, marker kept, retryable | ✓ |
| E — restart reconstruction (persisted marker, idempotent, offline) | ✓ |
| F — idempotency: same verified transfer twice → one queue item | ✓ |
| G — already-known = success → marked published | ✓ |
| H — conflict → terminal, local marker NOT overwritten to published | ✓ |
| I — same contentHash, B not transferred → B NOT implicitly accepted | ✓ |
| J — no-audio invariants preserved end-to-end | ✓ |
| (+ plural `send()` slot routing + acceptance predicates) | ✓ |

---

# 10. VERIFIED

- Verified-success gating against the real `send()` and POC result types.
- Publish only on verified usage acceptance; never on failure.
- Option-A local marker persisted on the existing record (no new DB/schema).
- Offline-first: acceptance persists + enqueues without a provider; restart
  reconstruction is idempotent and provider-free.
- sampleId-level acceptance (B not implicitly accepted via shared contentHash).
- Idempotent retry; `already-known` = success; `conflict` = terminal, no
  overwrite; no-audio invariants hold.

# 11. NOT VERIFIED

- Real global delivery against a live worker provider from the running app
  (the app's default provider is the offline `temporary-unavailable` provider;
  a live adapter is not wired in `main.ts`).

# 12. BLOCKED

- None. HARD gates: app tests (466/466), tsc (0), build (PASS) all satisfied ⇒
  **IMPLEMENTATION COMPLETE.**

# 13. Open questions (unchanged from 16G)

- **OQ-1** — remains OPEN (not in 16H scope).
- **OQ-2** — remains OPEN (not in 16H scope).
- **OQ-9** — remains OPEN (not in 16H scope).
- **16G-1** (durability approach) — **RESOLVED this step**: Option A (local
  marker on existing `SampleIndexRecord`; no new DB/D1 schema/cloud service).
- **16G-2** (reconciliation of a stale local "published" flag vs. a global
  reset) — remains OPEN.
- **16G-3** (explicit resolution of not-accepted records on a fresh global
  index) — remains OPEN.
