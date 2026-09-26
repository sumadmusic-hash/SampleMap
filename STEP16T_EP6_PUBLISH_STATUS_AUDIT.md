# STEP16T — E-P6 GLOBAL PUBLISH-STATUS SURFACE AUDIT

Status: **PARTIAL (read-only audit, no code/test/build changes made)**
Authoritative source: `STEP16R_PRODUCT_UX_SPEC.md` (frozen by 16R DECISIONS; the only file permitted to be in flux).
Companion: `FINAL_UI_UX_DESIGN_SPEC.md` §19.5 "Usage-acceptance gate" (line 1063).

> Scope honesty: the earlier STEP16S slice (bpm/numFavorites/numUsages) was
> mislabeled "E-P6". E-P6 is **not** the metadata slice. E-P6 is the **Global
> publish-status surface** defined by the 7-step semantic chain (frozen
> invariant #9). See §2.

---

## §1. Locate the E-P6 roadmap entry and describe its scope

- Roadmap ADD row (`STEP16R_PRODUCT_UX_SPEC.md` line 462):

  | Component | Phase | Requirement | Design-ref |
  |---|---|---|---|
  | Global publish-status surface (stored/known/conflict/rejected/temporary-unavailable) | E-P6 | additive panel/section; reflects the 7-step chain | §19.5 |

- E-P6 increment definition (`STEP16R_PRODUCT_UX_SPEC.md` lines 514–517):

  > E-P6 — Global publish-status surface (§19.5)
  > Additive panel/section reflecting `GlobalPublishQueue`/usage-acceptance states and the
  > 7-step chain; offline-first + live worker both represented; never blocks the local map.
  > **Exit:** publish-state unit tests + live worker roundtrip.

- Frozen invariant #9 (`STEP16R_PRODUCT_UX_SPEC.md` lines 597–599) — the semantic backbone E-P6 must reflect:

  > Global publish is a strict 7-step semantic chain; transfer ≠ publication; publishing is
  > gated on verified usage acceptance; offline-first pending is a first-class state; the
  > publish-status surface (stored/known/conflict/rejected/temporary-unavailable) is E-P6.

## §2. Freeze the term

"E-P6" means the **Global publish-status surface**: an additive UI panel/section that reflects
the 7-step publish chain and the usage-acceptance gate, showing **stored**, **known**,
**conflict**, **rejected**, and **temporary-unavailable** states, with **offline-first pending**
and **live-worker delivery** both represented, and which **never blocks the local map**.

It is **not** the bpm/numFavorites/numUsages metadata slice (that is STEP16S, already
implemented and reported in `STEP16S_EP6_IMPLEMENTATION_REPORT.md` — itself a mislabeled
name). It is also **not** the readonly global-*map* status line `map-global-state`
(16K/16L: `Global: loading… / available / no points in viewport / unavailable (local map still
works)`, `src/ui/render.ts` lines 568–628) — that line reports the global map READ surface,
not the publish-status of local analysis results.

## §3. Fresh feature or existing partial/complete?

Judge line: does a user-visible surface (panel/section) currently reflect the five E-P6 states
plus offline/live delivery, fed by `GlobalPublishQueue`/usage-acceptance state?

**Verdict: PARTIAL.** The complete 7-step chain (transfers→acceptance→queue→provider→worker/D1→
stored/known/conflict/rejected/temporary-unavailable) exists and is tested in the domain and
worker layers; the **E-P6 UI surface itself does not exist** and the binary local marker cannot
currently distinguish conflict/rejected/temporary-unavailable from plain pending.

### Evidence (what exists)

| Layer | Evidence | Location |
|---|---|---|
| Persisted acceptance/delivery marker (Option A) | `globalPublish?: { usageAcceptedAt: string; delivery: "pending" \| "published" }` | `src/persistence/indexStore.ts:117–120` |
| Candidate + validation (16D) | `createPublishCandidate` / `validatePublishCandidate` | `src/global/publish.ts` |
| Publish queue write semantics (16D) | `GlobalPublishQueue`; statuses `pending/in-flight/succeeded/retryable/failed`; batch/dedup/backoff; error classification; `PublishConflictError` | `src/global/publishQueue.ts` (state machine lines 61–103, flush 292–390) |
| Usage acceptance orchestration (16H) | `acceptUsageAndEnqueue`, `flushPendingPublications`, `reconstructPending`, `markDelivered`; predicates `isSendSlotAccepted`/`isPocAccepted` | `src/global/usageAcceptance.ts` |
| Contract outcomes (16A) | `GlobalPublishItemOutcome = stored \| already-known \| rejected(reason)`; `GlobalIndexError` taxonomy (conflict, rate-limited, temporary-unavailable, …) | `src/global/contract.ts:157–160, 218–224` |
| Worker HTTP API (16F) | `POST /samples/lookup`, `/content/lookup`, `/publish`; `GET /map`, `/health` | `workers/d1-worker/src/index.ts` |
| Worker provider (16F) | atomic per-item D1 batch; pre-read conflict check (no last-write-wins); `classifyPublishOutcome` → stored/already-known/conflict | `workers/d1-worker/src/provider.ts:272–392, 529–551` |
| Browser transport (16F) | `CloudflareGlobalAdapter` | `workers/d1-worker/src/browserAdapter.ts` |
| Provider resolution (16I) | live adapter when `VITE_GLOBAL_WORKER_URL`, else `offlineProvider` (every publish → `rejected: temporary-unavailable` → retryable) | `src/global/liveProvider.ts:31–52, 83–106` |
| Bootstrap (16H/16I POC wiring) | queue bootstrapped in `main()`; `reconstructPending`; Machiniste verification → `acceptUsageAndEnqueue` → `flushPendingPublications` | `src/main.ts:104–126, 419–443` |
| Reuse + global map read (16J/16K/16L) | `globalIndex` wired as `GlobalLookup` + `refreshGlobalPoints` + `map-global-state` | `src/ui/main.ts:25–38`; `src/ui/bootstrap.ts:96,125,169` |

### Evidence (what is missing)

| Missing | Evidence |
|---|---|
| **No E-P6 UI surface.** Zero publish references in `src/ui/app.ts`, `src/ui/view.ts`, `src/ui/render.ts` (grep: `publish|globalPublish|usageAccepted|delivery` → no matches). The only Machiniste "status" text is the *transfer* summary `Applied: X  Read-back: Y  Slots: Z` (`src/ui/render.ts:310–319`), plus `Selected: …` pending-send label (`src/ui/render.ts:1009–1010` fed by `app.ts:918`). Neither reflects publish status. |
| **Queue not mounted in the UI.** `SampleMapAppDeps` (`src/ui/bootstrap.ts:96–169`) wires `globalIndex` only as `GlobalLookup` for reuse/map; no `GlobalPublishQueue` or publish-state read path is passed to the app (`src/ui/app.ts:253` constructor deps, `src/ui/main.ts`). The queue lives only in `main.ts` (POC path). |
| **No server publish-status read.** Worker exposes lookup (`known`, read), but no per-sample publish history/status endpoint; conflict/rejected/temporary-unavailable history is not queryable live. |
| **Non-binary states not persisted.** The local marker collapses everything not "published" to `pending`. conflict (terminal, queue marks `failed`) and non-retryable rejection (queue `failed`) and temporary-unavailable (queue `retryable`) all leave the persisted marker `pending`; a terminal `conflict` is indistinguishable from "accepted, never flushed" by reading the record alone. |
| **No e2e/UI tests.** Tests for the E-P6 surface: zero. `e2e/ep6-metadata.spec.ts` is the STEP16S metadata slice (same "ep6" tag, different deliverable). Grep of `e2e/` + `src/e2e/harness/main.ts` + `src/e2e/chain.offline-e2e.test.ts` for `publish|accepted|delivery|usageAccepted` → no matches. |

## §4. Target roadmap row and sourcing file/line

- Row: **D3 "Global publish-status surface (stored/known/conflict/rejected/temporary-unavailable)"**, phase **E-P6**, ref **§19.5** — `STEP16R_PRODUCT_UX_SPEC.md:462`.
- Increment body: `STEP16R_PRODUCT_UX_SPEC.md:514–517`.
- Design-ref: `FINAL_UI_UX_DESIGN_SPEC.md:1063` (§19.5 "Usage-acceptance gate").

## §5. Map the 7-step chain to §19.5

The chain reflected by E-P6 is (semantics quoted from the spec mouthpiece module
`src/global/usageAcceptance.ts` + `src/global/publishQueue.ts`; each step has code + tests):

1. **Local analysis** of lossless audio → gate-passed, persisted record (`SampleIndexRecord`).
2. **Verified transfer to Machiniste** (direct reference; commit + applied + read-back; no re-upload) — the acceptance *evidence*.
3. **Usage acceptance** (16G/16H): sample-level only; transfer ≠ publication; B is never implicitly accepted because it shares A's contentHash (`usageAcceptance.ts:15–19` test `usageAcceptance.test.ts:478`).
4. **Publish candidate** (`createPublishCandidate`, 16D) — no re-analysis, no audio bytes.
5. **Enqueue + flush** (`GlobalPublishQueue`, 16D): batching, sampleId dedup, per-item outcome handling; offline-first pending is first-class (`publishQueue.ts:42–43`).
6. **Provider delivery** (`GlobalSampleIndex`, 16A): stored / already-known / rejected(reason) per item.
7. **Delivery state reflection** (16H): local marker upgraded `pending → published` only for provider-succeeded items; the GlobalSampleIndex remains authoritative on restart (`usageAcceptance.ts:26–27`).

§19.5 requirement "reflect the states": stored → outcome `stored`; known → `already-known`
(publish) or lookup `known`; conflict → `rejected` reason containing `conflict` (terminal, never
overwritten); rejected → non-retryable `rejected` (validation-rejected, version-incompatible);
temporary-unavailable → `rejected` reason `temporary-unavailable` / transport error (retryable).
All five states exist in the **domain/queue/worker**; **none is surfaced in the UI** (§3).

## §6. One-line status

E-P6 = **PARTIAL**: the full 7-step publish chain, offline-first pending, conflict-safety, and
non-flight persistence are implemented and unit-tested (16A/16D/16F/16H/16I/16J/16K); the
required **ADD panel/section** reflecting stored/known/conflict/rejected/temporary-unavailable
(live + offline) is absent.

## §7. Existing-implementation-bias note

Because the chain already exists (step 16H wiring in `main.ts`), the temptation is to call E-P6
"most of the work is done". The honest accounting: the underlying publication machinery is
complete, but the surface deliverable is a distinct UI increment — queue injection, a
status projection to the five states, a panel/section — that has **zero** implementation,
**zero** UI test, and **zero** e2e coverage today. The mislabeling of STEP16S as "E-P6" adds
confusion: `STEP16S_EP6_IMPLEMENTATION_REPORT.md` and `e2e/ep6-metadata.spec.ts` describe the
metadata slice, not this surface; neither should be counted as E-P6 progress.

## §8. Execution

Read-only audit. No source, test, spec, CSS, manifest, persistence, fixture, or report was
modified; no builds or test runs were executed. All lines cited were read directly.

## §9. Persistence

- Marker: `globalPublish?: { usageAcceptedAt: string; delivery: "pending" | "published" }`
  (`src/persistence/indexStore.ts:117–120`). Two strings; survives `assertNoAudioBytes`
  (indexStore.ts:143–173); no migration, no `SCHEMA_VERSION` bump; absence = "not yet
  usage-accepted" (line 110).
- Write sites: `acceptUsageAndEnqueue` (`usageAcceptance.ts:155–158`), `markDelivered`
  (`usageAcceptance.ts:201–204`).
- Read sites: `reconstructPending` (`usageAcceptance.ts:240–243`), `markDelivered`
  (`usageAcceptance.ts:200`), test assertions.
- **Gap:** the marker models acceptance + binary delivery only. The five E-P6 states are not
  persisted (see state matrix §10). Under frozen component discipline #17
  (`STEP16R_PRODUCT_UX_SPEC.md:619–622`), `src/persistence` is consumed as-is by UI increments;
  extending the marker would require a technical step, not an E-P6 UI increment.

## §10. State matrix (E-P6 states ↔ code)

| E-P6 state | Domain source | Queue item → terminal? | Persisted marker | UI surface today |
|---|---|---|---|---|
| stored | `publishAnalysisResults` → `{status:"stored"}` (`provider.ts:548–550`) | `succeeded` | `delivery: "published"` (`markDelivered`) | none |
| known | `already-known` (`contract.ts:159`; `provider.ts:546,550`) or lookup `known` (`provider.ts:200–205`) | `succeeded` | `delivery: "published"` | none |
| conflict | `rejected` reason `"conflict: …"` (`provider.ts:541–545`; `publishQueue.ts:362–365`, never overwritten) | `failed` (terminal, visible in queue, `PublishConflictError`) | stays `"pending"` (no record of reason) | none |
| rejected | `rejected` (validation-rejected, version-incompatible) (`publishQueue.ts:375–379`) | `failed` (terminal) | stays `"pending"` | none |
| temporary-unavailable | `rejected` reason `temporary-unavailable` (`offlineProvider` `liveProvider.ts:42–49`; transport `publishQueue.ts:318–338`; `provider.ts:363–372`) | `retryable` (→ `failed` after maxAttempts) | stays `"pending"` | none |
| offline-first pending | first-class queue state (`publishQueue.ts:42–43`; `main.ts:119`) | `pending`/`retryable` | `delivery: "pending"` | none |

### E-P6 surface → current UI mapping failure

- The UI cannot today render stored/known/conflict/rejected/temporary-unavailable *per sample*:
  read of the record yields only `pending|published`; the queue (which does hold
  `failed`+`lastOutcome.reason` / `retryable` / `succeeded`) is never handed to the app.

## §11. UI / view / render audit

- `src/ui/app.ts`: zero publish references; `pendingSamples` (lines 84–85, 918) is the pending
  *send selection*, unrelated. `SampleMapAppDeps` has no queue/publish state (`app.ts:253`).
- `src/ui/view.ts`: no publish status; only `selectionCountLabel` (line 346).
- `src/ui/render.ts`: the single "status" texts are `machinisteResultLabel`
  (lines 310–319, transfer summary) and `map-global-state` (lines 568–628, global map read);
  `Selected: …` (lines 1009–1010). No publish panel/section exists.
- The only publish-status text that exists anywhere is the **POC console log** in `main.ts`
  ("Usage ACCEPTED for …", "Publish delivery: submitted=…"), which is not the SampleMap UI and
  is reachable only through the POC harness button.

## §12. Provider / worker audit

- Routes (`workers/d1-worker/src/index.ts:113–217`): lookup/content-lookup/publish/map/health.
  No publish-status/state-history endpoint for the E-P6 "stored/known" read (a `stored` state is
  only *inferable* via `lookupSamples` → `known`).
- Provider (`provider.ts`): conflict-safe (pre-read, no last-write-wins), atomic per item,
  idempotent (`content ON CONFLICT DO NOTHING`, upsert guard), audio-free on every boundary.
- Offline path (`liveProvider.ts:31–52`): honest `temporary-unavailable` → retryable, markers
  persist, delivery resumes on a later live provider. Matches E-P6 "offline-first + live both
  represented" on the machinery side (UI aside).

## §13. Test audit

- Domain/worker (existing, strong):
  - `src/global/publish.test.ts` — 41 tests (candidate, dedup, batching, stored/already-known/
    rejected classification, conflict-never-overwritten, retryable vs failed, offline
    enqueue-without-provider, flush-does-not-mutate-local-index, full domain flow).
  - `src/global/usageAcceptance.test.ts` — 21 tests (acceptance predicates, offline flush →
    pending marker, restart reconstruction, already-known → published, conflict → never
    published, sample-level-not-content-level, audio-free marker, published upgrade).
  - `src/global/liveProvider.test.ts` — 7 tests (offline temporary-unavailable retryable,
    empty lookups, offline when no URL).
  - `src/global/contract.test.ts` — 30 tests; `workers/d1-worker/test/provider.test.ts`,
    `browserAdapter.test.ts`.
- **Gaps:** no UI/view test renders any publish status; no app-level test wires a queue; no
  Playwright spec covers the surface (`e2e/` has ep2/3/4/5/*, step16m, final-ui-phase1,
  ep6-metadata only); harness/offline-chain e2e contain zero publish references. E-P6 exit
  criterion "publish-state unit tests + live worker roundtrip" is unmet.

## §14. E2E harness audit

- `src/e2e/harness/main.ts` (booted by `harness.html`): no publish/acceptance/delivery surface;
  `makeMeta` supports the STEP16S metadata slice only.
- `e2e/ep6-metadata.spec.ts` exercises the STEP16S slice (EP6-01 inspector blocks, EP6-02
  metadata refresh) — not the publish-status surface, despite the "ep6-" prefix.

## §15. Data flow (existing chain, end-to-end)

```
audiotool sample ──► analysisPipeline ──► SampleIndexRecord (analyzed, V2 mapPosition)
   │
   ├─► [UI] Send to Machiniste (selection, direct ref)          src/ui/app.ts:918+
   │       └─► committed + applied + readBackMatches            machinisteService
   │
   ├─► [16H] isUsageAccepted(evidence)                          usageAcceptance.ts:107
   │       └─► true: createPublishCandidate(record)             usageAcceptance.ts:152
   │              │  ▸ index.put(globalPublish {accepted,"pending"})   :155–158
   │              └─► GlobalPublishQueue.enqueue(candidate)     publishQueue.ts:256
   │                     │  (offline-first: queue exists w/o provider; raw in ratelimited)
   │                     └─► flush()  (batch)                    publishQueue.ts:292
   │                            └─► GlobalSampleIndex.publishAnalysisResults(/publish)
   │                                   live adapter / offlineProvider / worker+D1 provider
   │                                   → stored | already-known | rejected(reason)
   └─► [16H] markDelivered(succeeded…) → delivery:"published"   usageAcceptance.ts:189
              ▸ restart: reconstructPending() re-enqueues pending markers   :235
```
The chain is closed and durable (Option A). **Only the E-P6 surface — a panel reading
`record.globalPublish` + `queue.snapshot()` and projecting the five states — is absent.**

## §16. Alignment table

| STEP16R requirement | Status | Evidence |
|---|---|---|
| Additive panel/section reflecting `GlobalPublishQueue`/usage-acceptance states | **MISSING** | no publish refs in `app.ts`/`view.ts`/`render.ts`; queue not injected (§3, §11) |
| Reflects stored/known/conflict/rejected/temporary-unavailable | **MISSING (UI); PRESENT (domain)** | five states all exist as queue/worker outcomes (§10); no surface renders them |
| Offline-first + live worker both represented | **MISSING (UI); PRESENT (machinery)** | `liveProvider.ts:31–52`, `main.ts:116–119`; no offline/live indicator in UI except POC log |
| Never blocks the local map | **PASS** | publish is fully decoupled; `map-global-state` error path never breaks local map (`render.ts:615–628`) |
| Exit: publish-state unit tests + live worker roundtrip | **MISSING** | see §13 |

## Frozen-invariant check (relevant subset)

- #9 (7-step chain semantics) — PASS in machinery; surface requirement unmet (this audit is E-P6 itself; not yet done).
- #15 (frozen copy) — no new copy introduced; nothing violated.
- #16 (gate discipline) — not exercised this audit (read-only; recorded suite is pre-audit: app 609/609, worker 19/19, tsc 0, build PASS, Playwright 45/45 from the STEP16S run).
- #17 (component discipline) — a UI-only E-P6 increment must not modify `src/global`, `src/persistence`, `src/machiniste`, or `workers/d1-worker`. The current code honors this; the recommended slice below also honors it by injecting (not rewriting) the queue.

## STEP16S interaction (naming collision)

- `STEP16S_EP6_IMPLEMENTATION_REPORT.md` — the metadata slice bpm/numFavorites/numUsages.
  The "EP6" in that name refers to the slice, not the publish-status surface; do not treat it as
  E-P6 completion.
- `e2e/ep6-metadata.spec.ts` — Playwright for the slice (EP6-01/02). Not publish-status.
- If E-P6 UI is built, a distinct spec name is required (e.g. `ep6-publish-status.spec.ts`) —
  and the next phase should stop reusing "ep6" for the metadata slice to avoid future confusion.

## Blockers

1. **Terminal-state observability**: to honor "conflict is surfaced visibly, never silently
   overwritten" in the *UI*, the app needs per-sample non-binary publish state — either inject
   `GlobalPublishQueue` snapshot (queue currently holds `failed`/`retryable`/`lastOutcome.reason`;
   viable without touching `src/global`) or extend the persisted marker (needs a technical step;
   frozen #17 forbids in a UI increment).
2. **Status read from the live worker**: the E-P6 exit mentions "live worker roundtrip"; the
   worker has no status endpoint today (inferable via `lookupSamples` → `known`). A status read
   would be a worker-side change → separate technical step, out of the E-P6 UI scope unless the
   roundtrip means exercising the existing `/publish` + `/samples/lookup` paths.
3. T1 (E-P5A, `BLOCKED — THRESHOLD OWNERSHIP NOT FOUND`) is unaffected by this audit.

## Readiness classification

- **Chain + persistence + worker: READY** (16A/16D/16F/16H/16I — all tested).
- **E-P6 UI surface: ABSENT** (no code, no tests, no e2e).
- **Overall E-P6: NOT STARTED for the deliverable surface**; the phase bumps to PARTIAL the
  moment the additive panel ships and to COMPLETE at the "publish-state unit tests + live
  worker roundtrip" exit.

## Smallest next slice (proposal for the successor increment — NOT implemented here)

Constraint: UI-only; frozen #17 (no `src/global`/`src/persistence`/`src/machiniste`/
`workers/d1-worker` writes); offline-first and live both displayed; never blocks the map.

1. **Inject (read-only) `GlobalPublishQueue`** into `SampleMapAppDeps`/`SampleMapApp` —
   `main.ts` already constructs it; pass it down (bootstrap is `src/ui`, allowed).
2. **`publishStatusOf(app, sampleId)` projection** (view.ts): merge
   `availableQueueItem.lastOutcome.reason` / `status` with `record.globalPublish.delivery` →
   one of `stored | known | conflict | rejected | temporary-unavailable | pending |
   published | none` (per-state label + color class + testid, frozen copy style).
3. **Additive section** (render.ts) inside the inspector / map drawer: per focused sample's
   publish status + a compact queue summary (accepted N, stored M, retryable K, failed R);
   offline vs live indicator from the injected provider kind; no new modals, no blocking.
4. **Unit tests** (status projection matrix incl. conflict → terminal visible, temp-unavailable →
   retryable shown in both offlineProvider and live path) + optional Playwright spec
   `ep6-publish-status.spec.ts` (offline harness, two fixtures: accepted-published vs
   accepted-conflict).
5. **Live roundtrip** (exit criterion): authenticated session with `VITE_GLOBAL_WORKER_URL` —
   verify `/publish` → `lookupSamples` known (human Layer-C compatible).

### Files E-P6 would touch

- `src/ui/bootstrap.ts` (thread the queue), `src/ui/app.ts` (read-only state projection),
  `src/ui/view.ts` (labels/types), `src/ui/render.ts` (section), `src/ui/samplemap.css`
  (panel styles), `src/ui/ep6-publish-status.test.ts` (new), `e2e/ep6-publish-status.spec.ts`
  (new), `src/e2e/harness/main.ts` (fixture states).
- **Non-goals:** no `src/global/*`, no `src/persistence/*`, no `workers/*` changes; no new
  worker endpoint unless a separate technical step approves it.

## Gate evidence (pre-audit, from the STEP16S run — not re-run, audit is read-only)

- `vitest` app: 609/609; worker: 19/19; `tsc --noEmit` 0/0; `vite build` PASS; Playwright 45/45.
- E-P6-specific test counts referenced (§13) are independent of the above and were read, not run.