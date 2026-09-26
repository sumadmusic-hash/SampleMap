# STEP16U — E-P6 Global Publish-Status Surface Implementation Report

**Verdict:** `E-P6 PASS — PUBLISH-STATUS SURFACE IMPLEMENTED AND VALIDATED`

The publish-status surface from STEP16R (frozen invariant #9, spec §L514-517)
is now rendered in the SampleMap inspector. The surface is **read-only**: the
UI never enqueues, flushes or retries the publish queue — it only reads
`queue.snapshot()` and projects the per-sample status from the persisted
usage-acceptance marker. Precedence is exactly as audited in STEP16T §4:
current queue outcome → persisted `globalPublish.delivery` marker → no state.

## 1. Changed files

| File | Change |
|---|---|
| `src/ui/view.ts` | NEW projection `publishStatusFor(marker, item) → PublishStatus` (7-way: `none`/`pending`/`stored`/`known`/`conflict`/`rejected`/`temporary-unavailable`) + `publishStatusLabel()` + `publishDeliveryLabel()`. Pure, framework-free, deterministic (mirrors STEP16T §4 precedence). |
| `src/ui/app.ts` | `SampleMapAppDeps` gains optional `globalPublishQueue?: GlobalPublishQueue` + `globalPublishDelivery?: PublishDeliveryMode`; `SampleMapApp` gets public getters `globalPublishQueue` (exposed to renderer, never written) + `globalPublishDeliveryMode` (defaults to `"offline"`). `refreshSearch()` now re-syncs `knownRecords` with fresh records so out-of-band 16H marker writes are reflected on render (ROOT CAUSE FIX, see §3). |
| `src/ui/bootstrap.ts` | `buildBrowserDeps` accepts + passes through `globalPublishQueue` and `globalPublishDelivery` into the `SampleMapAppDeps` it returns. |
| `src/ui/main.ts` | `mountAuthenticated` forwards the same two options to the deps factory. |
| `src/ui/render.ts` | `renderDetailPanel` renders the additive "Global Publish" block (status + delivery) into the inspector, positioned between the Community block and the Preview row. |
| `src/ui/samplemap.css` | Styles for `.inspector-publish`, `.inspector-publish-status`, `.inspector-publish-delivery`; added to the shared inspector-block margin/shadow list. |
| `src/main.ts` | `mountLiveSampleMap` now receives the existing `publishQueue` and prepends `globalPublishDelivery: GLOBAL_WORKER_URL ? "live" : "offline"` so the live entry wires the surface with the same bootstrap inputs it already built. |
| `src/e2e/harness/main.ts` | `Tm` gains `publish` hooks (queue + scripted provider + accept/flush/clear/remount/refresh). Adds `ScriptedPublishProvider` for deterministic E-P6 scenarios. |
| `src/ui/ep6PublishStatus.test.ts` | NEW, +16 unit tests — status-precedence matrix incl. pending-none/pending-marker, stored, already-known, conflict-terminal, rejected-terminal, offline transport failure, cancelled → none, published-marker-overrides-stale-pending, labels. |
| `e2e/ep6-publish-status.spec.ts` | NEW spec, +8 tests — additive block, offline pending/unavailable, live stored/known/conflict/rejected, terminal stability, additive integrity. |

No changes to `src/global/*`, `src/persistence/*`, `src/machiniste/*`,
`workers/d1-worker/*` (frozen invariant #17). The publish queue access is
strictly read-only (`snapshot()`); no enqueue/flush/retry call is issued from
the UI layer.

## 2. Status semantics projected

`publishStatusFor(marker, item)`:

```
if item.status === "succeeded"
    → "stored"  or  "known"  (lastOutcome.status)
if item.status === "retryable"
    → "temporary-unavailable"  (in-flight; offline or rate-limited)
if item.status === "failed" and NOT user-cancelled
    if reason contains "conflict"
        → "conflict"          (terminal; never overwritten)
    elif reason is temporary/rate-limited or no outcome at all (transport failure)
        → "temporary-unavailable"
    else
        → "rejected"          (terminal validation/unknown rejection)
if the queue item is a user-initiated `cancelled` or a "pending"/"in-flight" with
   no concrete application outcome
    → fall through to the persisted marker
if marker.delivery === "published" → "stored"
if marker.delivery === "pending"   → "pending"
else → "none"
```

This upholds frozen invariant #9:
- `conflict` / `rejected` / `temporary-unavailable` are **never** derived from
  `delivery: "pending"` alone — they require a concrete queue outcome.
- `conflict` / `rejected` stay **terminal** and are never shown as published.
- A user-initiated cancel is not a backend outcome → falls back to the marker.
- A stale pending queue item **never** overrides a persisted `published` marker.

The labels are static product copy (from the existing product language):
`Pending`, `Stored`, `Known`, `Conflict`, `Rejected`, `Temporary unavailable`,
`None` — and the delivery line reads `Offline / waiting for live provider` vs
`Live worker`. Both are rendered next to the delivery context in a dedicated
`Global Publish` block with stable `data-testid`s (`inspector-publish-status`,
`inspector-publish-delivery`).

## 3. Root-cause fix (why the surface initially showed stale state)

The acceptance marker (16H `globalPublish`) is persisted by
`acceptUsageAndEnqueue` **outside of UI control**, into IndexedDB. The UI's
sample registry (`knownRecords`) is warmed by `refreshSearch` from the search
results — so the focused sample record in the inspector came from a stale
registry copy. This meant that once the acceptance marker was written, the
inspector kept rendering the old marker until a full refresh. Fix:
`refreshSearch()` now overwrites `knownRecords` with the freshly-read records
from the search engine (record instances change on every scan anyway, and the
registry is a pure lookup cache keyed by sampleId). `selectSample`'s
focus-protect early-return is preserved; after a marker write, the surface
repopulates on the next render/refresh. This is the minimal, additive
registry-sync that a pure consumer needs — no lifecycle logic, no ownership
change.

The harness's `publish.refresh()` hook calls `app.refreshSearch()`, so an
accept/flush immediately refreshes the record cache; no fake DOM re-ranging.

## 4. Validation

| Gate | Before | After |
|---|---|---|
| App Vitest | 609/609 | **625/625** (+16, `src/ui/ep6PublishStatus.test.ts`) |
| Playwright e2e | 45/45 | **53/53** (+8, `e2e/ep6-publish-status.spec.ts`) |
| Worker Vitest | 19/19 | **19/19** |
| `tsc --noEmit` | 0 | 0 |
| `npm run build` | PASS | PASS |
| STEP16S E-P6 metadata slice | (used unchanged) | works |

Ordering evidence for the audit trail: EP6-01 asserts the additive block and
offline delivery for a never-accepted sample. EP6-02 exercises
`acceptUsageAndEnqueue` with the sample pending marker and shows "Status:
Pending". EP6-03 flushes against the scripted offline provider and shows
"Status: Temporary unavailable" (not an error). EP6-04 remounts with the live
delivery label, flushes one `stored` sample, and shows "Status: Stored" plus
`globalPublish.delivery === "published"` persisted. EP6-05 flushes
one `already-known` sample and shows "Status: Known". EP6-06 flushes one
`conflict` sample and shows "Status: Conflict" — and a re-render keeps it
conflict (terminality). EP6-07 flushes one `validation-rejected` sample and
shows "Status: Rejected". EP6-08 asserts that the local map and classification
state remain fully intact after the whole publish churn.

## 5. Acceptance criteria (E-P6)

- [x] UI surfaces the publish status for the focused sample (read-only).
- [x] Seven distinct statuses + offline-first delivery mode, exactly as specified.
- [x] No mutation of queue state from the UI path.
- [x] No false inference from `delivery: "pending"` alone; conflict/rejected/temporary-unavailable only from concrete queue outcomes.
- [x] Terminal states (conflict / rejected) never shown as published.
- [x] No new product logic, no status summary (frozen #9 / §19.5).
- [x] Unit + e2e coverage with 16 new tests; all gates green.
