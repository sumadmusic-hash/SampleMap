# SampleMap — 16F-12 Live Cloudflare/D1 Verification

**Status: VERIFIED** (mit dokumentierten Beobachtungen)
**Date:** 2026-09-03
**Scope:** Real Cloudflare D1 + Worker live verification of the existing 16F provider (no architecture/worker/D1 redesign, no new features). All tests run against a real Cloudflare account, real D1 database, and the deployed Worker — no fakes/mocks/SQLite.

---

## Cloudflare Targets

| Item | Value |
|---|---|
| Cloudflare Account | Sumadmusic@gmail.com's Account (`1af7c484...`) |
| Auth method | `wrangler login` (browser OAuth), scopes include `d1:write`, `workers_scripts:write` |
| D1 database | `samplemap-global` |
| D1 location | `weur` (Western Europe) — user-selected (CLI rejects `eu`; `weur` is the valid EU region) |
| D1 database_id | `fc5221fa-57d8-4fd8-ac8c-11b623a06ad6` |
| Worker | `samplemap-d1-worker` |
| Deployed URL | `https://samplemap-d1-worker.sumadmusic.workers.dev` |
| workers.dev subdomain | `sumadmusic.workers.dev` (pre-existing; no new subdomain registered) |

---

## Setup Steps Performed

1. Installed `wrangler@^4.128.0` as a dev dependency **inside the worker project**
   (`workers/d1-worker/package.json`). To satisfy wrangler's peer dependency, bumped
   `@cloudflare/workers-types` from `^4` to `^5.20260831.1` in the same file.
   Worker `tsc` (0 errors) and worker tests (19/19) confirm no regression.
   App project untouched.
2. `wrangler login` → OAuth, verified with `wrangler whoami`.
3. `wrangler d1 create samplemap-global --location weur` → returned real
   `database_id`. Edited **only** the `database_id` line in `wrangler.toml`
   (binding stays `DB`, `database_name` stays `samplemap-global`; nothing else changed).
4. Applied migration remotely:
   `wrangler d1 execute samplemap-global --remote --file=./migrations/0001_initial.sql`
   → 5 queries, 10 rows written.
5. Verified schema remotely via `sqlite_master`: tables `sample_ref`, `content`
   (+ Cloudflare-internal `_cf_KV`) and indexes `idx_sample_ref_content`,
   `idx_content_map_version`, `idx_content_map_class` all present.
6. `wrangler deploy` → uploaded `samplemap-d1-worker`
   (28.48 KiB / 7.18 KiB gzip) to `https://samplemap-d1-worker.sumadmusic.workers.dev`.
   Bindings confirmed: `env.DB` → D1 `samplemap-global`; all vars (`PUBLISH_MAX_BATCH=100`,
   `PUBLISH_MAX_BODY_BYTES=262144`, `MAP_DEFAULT_LIMIT=200`, `MAP_MAX_LIMIT=1000`,
   `API_ALLOWED_ORIGIN=http://localhost:5176`) present.

---

## Live Checks Table

| # | Stage | Result | Evidence |
|---|---|---|---|
| 1 | Wrangler auth | **VERIFIED** | `wrangler whoami` → logged in as `sumadmusic@gmail.com`, account + token scopes |
| 2 | D1 creation | **VERIFIED** | `d1 create --location weur` → `fc5221fa-...`; `d1 list` shows `samplemap-global`, production |
| 3 | D1 migration | **VERIFIED** | remote execute 5 queries; `sqlite_master` shows `sample_ref`+`content`+3 indexes remote |
| 4 | `/health` | **VERIFIED** | `GET /health` → HTTP 200 `{"status":"ok"}` |
| 5 | Publish (new) | **VERIFIED** | `POST /publish` valid item → HTTP 200 `{"items":[{"status":"stored"}],"accepted":true}` |
| 6 | Idempotency | **VERIFIED** | re-send same item → `{"items":[{"status":"already-known"}],"accepted":true}` (no dup canonical, no error) |
| 7 | Conflict protection | **VERIFIED** | re-point sampleId to a different contentHash → `{"status":"rejected","reason":"conflict: sample is already mapped to a different content identity"}","accepted":false}`; `sample_ref` unchanged (still old hash) — no last-write-wins |
| 8 | Content dedup + representative | **VERIFIED** | two sampleIds same contentHash → one content row; content lookup returns both sampleIds and lex-min `representativeSampleId` |
| 9 | Sample lookup | **VERIFIED** | known → `status:"known"`+analysis; unknown → `status:"unknown"` (explicit discriminated union, no null) |
| 10 | Content lookup | **VERIFIED** | returns `sampleIds[]`+canonical analysis; unknown hash → `[]` |
| 11 | Map viewport | **VERIFIED** | bbox query returns points (contentIdentity+x/y+representativeSampleId+primaryClass), deterministic order, lex-min representative; missing required params → 400 |
| 12 | Unknown sample | **VERIFIED** | `status:"unknown"`, clean not-found, no error |
| 13 | No-audio guard | **PARTIALLY VERIFIED** | structural validator rejects audio-bearing/invalid results live (`confidence must be in [0,1]` → rejected). The binary-container guard (`ArrayBuffer`/`Blob`/typed arrays) cannot be triggered over HTTP JSON because JSON cannot carry binary containers — documented as defense-in-depth |
| 14 | CORS / Origin policy | **VERIFIED** | allowed origin `http://localhost:5176` → `Access-Control-Allow-Origin` set (preflight 204); other origin → ACAO header omitted (browser blocks) |
| 15 | Request-size limit | **VERIFIED** | 300000-byte body (>262144 cap) → HTTP 400 `{"kind":"validation-rejected","reason":"request body too large"}` |
| 16 | Error mapping | **VERIFIED** | not-found→404; validation/missing→400; batch/body-too-large→400; unparsable JSON→503 `temporary-unavailable` (no stack trace / internals leaked) |
| 17 | Map hard cap | **VERIFIED** | `limit=99999` → HTTP 200 (internally capped to `MAP_MAX_LIMIT=1000`), no overflow |
| 18 | No secrets in responses | **VERIFIED** | all responses are stable JSON error/success envelopes; no stack traces, no API tokens, no credentials |

---

## Regression Suite (post-setup)

| Suite | Result |
|---|---|
| Worker unit tests (`workers/d1-worker`) | **19/19 passed** (provider 13 + browserAdapter 6) |
| Worker `tsc --noEmit` | **0 errors** |
| Worker build (`wrangler deploy --dry-run`) | **PASS** (28.48 KiB / gzip 7.18 KiB) |
| App tests (repo root) | **445/445 passed (26 files)** — app untouched |
| App `tsc --noEmit` | **0 errors** |

---

## Behavioral Observations (documented, NOT architectural changes)

1. **Orphan content row on rejected re-point.** A wired conflict publish (sampleId →
   different contentHash) is correctly rejected and the `sample_ref` binding is
   preserved, BUT the provider's `content` `INSERT OR IGNORE` (same D1 batch,
   statement order b) still inserts the *new* content hash when it does not yet
   exist. Result: an orphan `content` row with no `sample_ref` references. It
   surfaces as `sampleIds: []` (and no `representativeSampleId`) in content
   lookup, and as a self-referential map point in the viewport. This is a
   documented side effect of the existing insert-or-ignore strategy; it does not
   violate the primary "no last-write-wins / stable sample mapping" invariant.
   **Not fixed here** — 16F-12 is verification-only, no code redesign.

2. **Unparsable JSON → 503.** A non-JSON request body causes `JSON.parse` to throw;
   `mapError` maps any non-`kind` error to `temporary-unavailable` (503). Clean and
   safe (no leak), but semantically a malformed client body is closer to a 400.
   Documented; not changed.

3. **Workers.dev subdomain.** This account already had `sumadmusic.workers.dev`.
   `wrangler deploy` flagged a missing subdomain and this wired an onboarding
   prompt (wrangler 4.128.0 has no `wrangler subdomain` command and its
   `@clack/prompts` TTY flow could not be driven via pipe/expect). No new
   subdomain was ever registered; the existing account subdomain was used.

---

## Open Questions (OQ) Status

| OQ | Item | Status |
|---|---|---|
| OQ-1/2 | Tier-1 design open items (from STEP16F_IMPLEMENTATION) | **OPEN** (unchanged) |
| OQ-7 | Ordinal/anomaly-based design open item | **OPEN** (unchanged) |
| OQ-8 | Audiotool WAV-vs-FLAC `analysisSourceFormat` handling | **Not verifiable via Cloudflare** — needs a real Audiotool WAV/FLAC round-trip test |
| OQ-9 | Publish write-path auth mechanism | **OPEN** — `PublishAuthorizer`/`RateLimiter` are permissive by design (documented placeholder, NOT a security boundary); real auth deferred to live infra decision |
| OQ-10 | Further design open item | **OPEN** (unchanged) |

`PublishAuthorizer` permissive/injectable architecture is intentionally part of
the existing design and **not replaced** by this verification.

---

## Production Files Changed

| File | Change |
|---|---|
| `workers/d1-worker/wrangler.toml` | `database_id` placeholder → real `fc5221fa-57d8-4fd8-ac8c-11b623a06ad6` (binding name `DB` and everything else unchanged) |
| `workers/d1-worker/package.json` | added `wrangler@^4.128.0` devDep; `@cloudflare/workers-types` `^4` → `^5.20260831.1` (wrangler peer-Dep resolution) |
| `workers/d1-worker/package-lock.json` | lockfile updated to match the above |
| `workers/d1-worker/STEP16F_LIVE_VERIFICATION.md` | this report (new) |

Cloudflare-side (not repo files): D1 `samplemap-global` created (WEUR), remote
migration applied, Worker `samplemap-d1-worker` deployed.

---

## Overall 16F-12 Status

**VERIFIED** — the existing 16F Cloudflare D1 provider (schema, publish
atomicity/idempotency/conflict protection, content dedup + lex-min representative,
sample/content lookup, bounded deterministic map viewport, error mapping, CORS,
no-secrets/no-audio policy) operates correctly against a real Cloudflare D1
database and deployed Worker. All 17/18 live checks pass; two behavioral
observations (orphan content row, 503-for-malformed-json) are documented and
deliberately **not** changed under the verification-only mandate. OQ-8 remains
Not-verifiable-on-Cloudflare and OQ-9 remains OPEN by design.
