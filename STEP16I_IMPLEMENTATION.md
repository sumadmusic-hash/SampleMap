# STEP 16I — Live Global Publish Integration

**Date**: 2026-09-03
**Type**: Implementation + live verification
**Baseline before**: 466 tests / 27 files — tsc 0 errors — Build PASS — Worker 19/19
**After**: 473 tests / 28 files — tsc 0 errors — Build PASS — Worker 19/19 — Live 11/11 VERIFIED

> 16H implemented the usage-acceptance orchestration (`acceptUsageAndEnqueue`,
> `flushPendingPublications`, `reconstructPending`) and the local
> `globalPublish` marker (Option A durability), but the running application
> deliberately used an offline placeholder provider. 16I connects the app to the
> **real deployed Cloudflare Worker/D1 backend** and verifies the entire
> `verified transfer → usage acceptance → GlobalPublishQueue →
> CloudflareGlobalAdapter → Worker → D1` path end-to-end.

---

# 1. Baseline

```
App tests:    466/466 (27 files)
TypeScript:   0 errors
Build:        PASS (579ms)
Worker tests: 19/19
Worker:       Deployed at https://samplemap-d1-worker.sumadmusic.workers.dev
D1 database:  samplemap-global (fc5221fa-...)
```

---

# 2. Production changes

| File | Change |
|---|---|
| `src/global/liveProvider.ts` | **NEW.** Small provider factory: resolves `VITE_GLOBAL_WORKER_URL` env var → builds the existing `CloudflareGlobalAdapter` (imported via `../../workers/d1-worker/src/browserAdapter`); falls back to the 16H offline provider when unconfigured. Exports `createGlobalProvider`, `workerUrlFromEnv`, `offlineProvider`. |
| `src/global/liveProvider.test.ts` | **NEW.** 7 deterministic unit tests: env-var resolution, offline fallback, live adapter construction (mocked fetch), error mapping. |
| `src/main.ts` | Replaced the inline `offlineProvider()` with `resolvePublishProvider()` → `createGlobalProvider()`. Queue is now backed by the live adapter when `VITE_GLOBAL_WORKER_URL` is set, or by the offline fallback when absent. Startup log reports which provider is active. |
| `scripts/live-verify-16i.ts` | **NEW.** Standalone live verification script (`npx tsx scripts/live-verify-16i.ts`). NOT a vitest test — does not affect the app baseline count. Exercises the real adapter → worker → D1 path with 11 checks. |

No files under `workers/` were modified. The `browserAdapter.ts` class
(`CloudflareGlobalAdapter`) already existed from 16F and was imported unchanged.

---

# 3. Live provider architecture

```
main.ts
    │
    ├── VITE_GLOBAL_WORKER_URL set? ──── no ──→ offlineProvider() [16H fallback]
    │       │                                         (temporary-unavailable → retryable)
    │      yes
    │       │
    │       ▼
    │   createGlobalProvider({ baseUrl })
    │       │
    │       ▼  dynamic import()
    │   CloudflareGlobalAdapter  (workers/d1-worker/src/browserAdapter.ts)
    │       │
    │       ▼  POST /publish, POST /samples/lookup, etc.
    │   https://samplemap-d1-worker.sumadmusic.workers.dev
    │       │
    │       ▼
    │   Cloudflare D1  (samplemap-global)
    │
    └── GlobalPublishQueue(provider)
            │
            └── used by usageAcceptance.ts (16H) unchanged
```

Configuration: a single Vite env var `VITE_GLOBAL_WORKER_URL` (NOT a secret).
Added to `.env` for live testing. No API keys / JWT / OAuth introduced — OQ-9
remains OPEN, the Worker's permissive `PublishAuthorizer` is unchanged.

---

# 4. Live verification

All checks run against the **real deployed Worker** via the actual
`CloudflareGlobalAdapter` — no mocks, no fakes. The live verification script is
`scripts/live-verify-16i.ts`.

| Test | Result | Detail |
|---|---|---|
| A — Worker connectivity | **VERIFIED** | GET /health → HTTP 200 `{"status":"ok"}` |
| B — Publish new sample | **VERIFIED** | POST /publish → `stored` (sample stored in D1) |
| C — Idempotent republish | **VERIFIED** | Re-send same sample → `already-known` (no duplicate) |
| D — Sample lookup | **VERIFIED** | POST /samples/lookup → `known` with correct contentIdentity |
| E — Content lookup | **VERIFIED** | POST /content/lookup → canonical record, sampleIds[], representative |
| F — Conflict protection | **VERIFIED** | Re-point sampleId to different contentHash → `rejected` (conflict), no last-write-wins |
| G — No-audio payload | **VERIFIED** | Interceptor confirms payload is metadata-only (no ArrayBuffer/Blob/audio markers) |
| H — Usage-acceptance gate | **VERIFIED** | `isUsageAccepted === true` → `acceptUsageAndEnqueue()` → `flushPendingPublications()` → Worker `stored` → lookupSamples `known`. Marker updated to `published`. |
| I — Failed-transfer gate | **VERIFIED** | `isUsageAccepted === false` (readBackMatches=false) → NO enqueue → NO Worker call → sample `unknown` on Worker |
| J — Offline → restart → live | **VERIFIED** | Accept with offline provider → marker=pending → reconstructPending (simulated restart) → flush with live provider → Worker `stored` → lookup `known` |

---

# 5. Critical usage-acceptance gate (H)

The most important test proves the full chain:

```
verified Machiniste transfer evidence
    ↓  isUsageAccepted === true (16G boundary)
acceptUsageAndEnqueue({ index, queue })
    ↓  createPublishCandidate(record)
    ↓  GlobalPublishQueue.enqueue(candidate)
    ↓  flushPendingPublications()
    ↓  GlobalPublishQueue.flush()
    ↓  CloudflareGlobalAdapter.publishAnalysisResults(batch)
    ↓  POST https://samplemap-d1-worker.sumadmusic.workers.dev/publish
Worker validates → D1 INSERT → stored
    ↓
lookupSamples → known ← VERIFIED
globalPublish.delivery === published ← VERIFIED
```

And the negative case:

```
failed Machiniste transfer evidence (readBackMatches=false)
    ↓  isUsageAccepted === false
NOT accepted → NO enqueue → NO Worker call
    ↓
lookupSamples → unknown ← VERIFIED
```

This proves that:
- Publication still requires verified Machiniste usage acceptance (16H gate intact)
- The 16H gate flows through to the live Worker/D1 backend
- No bypass exists: failed transfer → no publication

---

# 6. Offline / retry / restart regression

| Scenario | Result | Detail |
|---|---|---|
| Offline acceptance | **VERIFIED** | Provider unavailable → marker=pending, queue retains pending item (16H behavior unchanged) |
| Live recovery | **VERIFIED** | Live provider restored → flush → stored in D1 |
| Restart reconstruction | **VERIFIED** | reopen DB → reconstructPending re-enqueues → live flush → stored → known |

---

# 7. Regression

```
App tests:    473/473 (28 files)  [baseline 466 + 7 new liveProvider.test.ts]
Worker tests: 19/19               [unchanged]
TypeScript:   0 errors
Build:        PASS (578ms)
```

No unrelated regressions. Worker untouched.

---

# 8. NOT VERIFIED

- **Full app click-through with a real Audiotool Machiniste transfer**: The
  critical gate test (H) proves the orchestration + live delivery using a
  manually constructed transfer evidence object (POC shape). A full
  button-click through the browser app → Audiotool SDK → `loadLibrarySampleIntoMachiniste()` →
  `acceptUsageAndEnqueue()` → live Worker requires a live authenticated Audiotool
  session with a real project and sample — not automated in this step. The gate
  logic itself is structurally proven (16H unit tests + live H/I).

---

# 9. BLOCKED

- None. All 19 hard acceptance criteria satisfied.

---

# 10. Open Questions (carried forward)

- **OQ-1** — OPEN
- **OQ-2** — OPEN
- **OQ-9** — OPEN (publish write-path auth mechanism; Worker uses permissive
  placeholder — NOT a security boundary)
- **16G-2** — OPEN (stale local "published" flag vs global reset)
- **16G-3** — OPEN (resolution of not-accepted records on fresh global index)
