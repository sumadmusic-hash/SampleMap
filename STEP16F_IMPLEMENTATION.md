# STEP 16F — Real Cloudflare D1 + Workers Provider — Implementation

**Date**: 2026-09-02
**Type**: Provider/infra step — `CloudflareGlobalSampleIndex` implementing the
existing `GlobalSampleIndex` contract (16A) per `STEP16E_DESIGN.md`.
**Baseline before**: 445 tests / 26 files — tsc 0 errors — Build PASS
**After**: 445 app tests / 26 files — tsc 0 errors — Build PASS; plus
19 provider/adapter tests in the worker subproject — worker tsc 0 errors.

> 16E was a DESIGN step (single `content` table + `sample_ref`; `db.batch()` as
> the atomic primitive; 100-bound-param chunking; `ON CONFLICT DO NOTHING`
> idempotency; conflict = rejected, no last-write-wins; bounded bbox map views;
> no-audio; reads anonymous / writes protected). **16F implements that design**:
> a real Worker + D1 codebase (routing, provider, migrations, browser adapter)
> that reuses the existing pure domain authorities and keeps `src/global/*`
> unchanged. No audio, no fake deployment, no invented auth.

---

# 1. Goal

Deliver the provider that lets the SampleMap `GlobalSampleIndex` contract be
backed by Cloudflare Workers + D1, without inventing new semantics:

- a `CloudflareGlobalSampleIndex` provider over the D1 binding (16E §7–§12);
- a Worker HTTP API routing the four contract areas (16E §13);
- D1 migrations creating `sample_ref` + `content` (16E §5–§6);
- a browser-side adapter implementing the contract over `fetch` (16F-10);
- local tests: an in-memory fake-D1 harness running the REAL provider logic
  (16F-11) + a mocked-fetch adapter test — **explicitly not "real" Cloudflare**;
- no change to any file under `src/global/*`.

The live Cloudflare verification (16F-12) is **blocked** on a real Cloudflare
account/credentials (not an implementation defect).

---

# 2. Scope & Boundaries

Implemented:
- `workers/d1-worker/` subproject (own tsconfig, package.json, vitest config),
  isolated from the app build (root tsconfig includes only `src` + `vite.config.ts`).
- `wrangler.toml` — D1 binding, vars (caps/origins), no secrets.
- `migrations/0001_initial.sql` — `sample_ref` + `content`.
- `src/provider.ts` — `CloudflareGlobalSampleIndex`.
- `src/index.ts` — Worker entry / HTTP API.
- `src/browserAdapter.ts` — browser-side `GlobalSampleIndex` over `fetch`.
- `test/fakeD1.ts` + `test/provider.test.ts` + `test/browserAdapter.test.ts` +
  `test/fixtures.ts`.
- Root `vite.config.ts` gained an `exclude` for `workers/**` so the app baseline
  suite stays exactly 445 (worker tests run via their own config).

Not implemented (deferred / live items — OQ-9, 16F-12):
- real Cloudflare account, D1 provisioning, deployment, wrangler `apply`;
- publish write-path authentication mechanism (OQ-9: NOT invented — injectable
  `PublishAuthorizer` hook, permissive default documented as not-a-boundary);
- rate-limit server implementation (injectable `RateLimiter` stub, §14 of 16E).

---

# 3. Architecture

```
 Browser (SampleMap)
      │  CloudflareGlobalAdapter (src/browserAdapter.ts) — GlobalSampleIndex
      ▼
 Cloudflare Worker HTTP API (src/index.ts)  POST/POST/POST/GET
      │  CloudflareGlobalSampleIndex (src/provider.ts)
      ▼
 D1 binding (migrations/0001_initial.sql)
      sample_ref ──(content_hash, version)──► content
```

Reused existing authorities (no duplication):
- `validatePublishResult` (`src/global/validation.ts`) — structural validation
  including the derived map/similarity recompute from `features` and the no-audio
  throw (16E §15).
- `selectRepresentative` (`src/identity/audioContentIdentity.ts`) — the ONE
  lex-min representative rule (`MIN(sample_id)` in the map path is the same rule).
- `assertNoAudioBytes` (`src/persistence/indexStore.ts`) — the ONE no-audio guard,
  re-run on request payloads and every returned row (16E §16).
- Contract types (`src/global/contract.ts`) — unchanged.

---

# 4. Provider Semantics (`src/provider.ts`)

- **16F-4 `lookupSamples`**: read-only; dedups ids; chunks `IN (...)` by the
  100-bound-param limit; `sample_ref JOIN content`; one hit per unique id.
- **16F-5 `lookupContentIdentities`**: PK content fetch + `sample_ref` refs;
  representative via `selectRepresentative` (single authority).
- **16F-6/7 `publishAnalysisResults`**: per-item `[ref pre-read, content upsert,
  sample_ref upsert]` grouped in ONE `db.batch()` so no item half-commits. Content
  uses `ON CONFLICT DO NOTHING` (idempotent). Sample_ref uses
  `ON CONFLICT(sample_id) DO UPDATE ... WHERE (same content)` so an identical
  re-publish is a no-op (`already-known`) and a re-point to a different content
  is **rejected** (`conflict`, no last-write-wins). Outcomes: `stored` /
  `already-known` / `rejected`. Batch > `maxBatchSize` → `validation-rejected`.
  `assertNoAudioBytes(batch)` at entry.
- **16F-8 `queryMapViewport`**: bounded `WHERE map_version=? AND map_x BETWEEN …
  AND map_y BETWEEN … [AND primary_class=?] ORDER BY map_y,map_x LIMIT ? OFFSET ?`
  — never `SELECT *`; cursor = opaque offset; hard-capped at `maxMapLimit`.
- **16F-9 Worker API**: `POST /samples/lookup`, `POST /content/lookup`,
  `POST /publish`, `GET /map`, `GET /health`. `GlobalIndexError` → HTTP status
  map. Request-body size cap. Restricted CORS/origin. No stack traces leaked.

Errors map to the 6 `GlobalIndexError` kinds: `not-found`→404,
`validation-rejected`→400, `version-incompatible`→422, `conflict`→409,
`rate-limited`→429, `temporary-unavailable`→503.

---

# 5. Verification

App (unchanged baseline):

```
npx tsc --noEmit              → PASS (0 errors)
npx vitest run                → 445 passed (26 files)   [workers/** excluded]
npm run build                 → PASS (pre-existing chunk-size warning only)
```

Worker subproject (`workers/d1-worker`):

```
npm run typecheck             → PASS (0 errors)
npm test / npx vitest run     → 19 passed (2 files)
```

New tests cover: publish stored / already-known / content-dedup (AAA+BBB→X),
conflict re-point rejected with original binding preserved, structural
validation rejection, batch-cap rejection, no-audio rejection, sample lookup
known/unknown + dedup + >100-id chunking, absent content → no hit, map
ordering / cursor pagination / hard cap, adapter route building + error mapping
+ no-audio response guard.

---

# 6. Report

Status: **IMPLEMENTATION COMPLETE (locally tested); LIVE verification BLOCKED**

Verified:
- provider implements the FULL `GlobalSampleIndex` contract (no stubs);
- publish is atomic per item + idempotent + conflict-safe (no overwrite);
- content identity dedup (AAA/BBB → X) and lex-min representative;
- map viewport bounded / deterministic / paginated / capped;
- no-audio enforced on payloads, publish batches, and returned rows;
- Worker routes the four areas with `GlobalIndexError` → HTTP mapping;
- browser adapter round-trips the contract over `fetch` (mocked);
- `src/global/*` untouched; app baseline 445 + build intact.

Not verified (honest, not "real"):
- any real Cloudflare D1 behavior — the integration harness is an in-memory
  `FakeD1` test double, labeled as such, never called "real";
- real `wrangler d1 create/apply`, real deployment, real network/CORS.

Blocked:
- **16F-12 live verification — requires a real Cloudflare account/credentials
  (out of scope; not an implementation error).**

Open Questions (carried from 16E):
- OQ-9 publish auth mechanism (injectable hook, permissive default).
- OQ-8 real WAV-vs-FLAC contentHash equality; OQ-10 single vs normalised tables.

Out of scope (unchanged): audio upload/storage, real auth/rate-limit server,
deployment, spatial bucketing (deferred to ~1M rows per 16E §12), UI/map canvas,
clustering, voting/moderation, force-overwrite.
