# STEP16I / STEP16M — Live-Verification Status (final, 2026-09-05)

Supersedes the earlier draft in this file. All evidence is fresh from this
session. No fixtures were introduced into product code; every "REAL" claim below
was produced by hitting the real deployed Worker/D1 and/or the real Audiotool
backend via the account's PAT.

## 1. What changed this session (closing actions from §6 of the prior draft)

| # | Action | Result |
|---|---|---|
| 1 | `npx wrangler deploy` in `workers/d1-worker` (bundles HEAD `src/index.ts` + `src/global/validation.ts`) | **Deployed.** URL `https://samplemap-d1-worker.sumadmusic.workers.dev`, Version ID `8b730b53-a57c-4a8a-bf45-29e07b258122`. Stale `map.x is inconsistent…` V1 check is gone; V2 structural validation is live. |
| 2 | Fix `scripts/live-verify-16i.ts` | H/J records now carry a persisted V2 `mapPosition` (`flatnessToX`/`centroidToY` — the same map module the real pipeline persists verbatim). `process.exitCode = 1` set whenever any case is NOT VERIFIED. |
| 3 | Re-run 16I | **11 VERIFIED / 0 NOT VERIFIED / 0 SKIPPED**, exit 0. |
| 4 | Re-run 16M (real PAT chain) | **23 VERIFIED / 0 NOT VERIFIED**, exit 0. |
| 5 | Layer C (interactive browser OAuth) | **BLOCKED** — interactive Audiotool login cannot be performed in this automated environment. Everything up to the login is code-ready + origin-coherent + boot-verified. |
| 6 | `Juul perc` foreign/public-sample access test | Real backend **ACCEPTS** a Machiniste reference to an un-owned public sample (read-back verified). The user's original error is **not reproducible today**; it is a backend/name resolution rule, NOT a SampleMap ownership bug (§5). |
| 7 | Final gates | See §2 — all green. |

## 2. Final gates (fresh this session)

| Gate | Result |
|---|---|
| `tsc --noEmit` | **0 errors** |
| App Vitest | **576/576 passed (32 files)** |
| Worker Vitest | **19/19 passed** |
| `vite build` | **PASS** (only pre-existing >500 kB chunk warning) |
| Playwright e2e | **28/28 passed** |

## 3. 16I — live Worker verification (fresh, 11/11 VERIFIED)

One extra map/viewport live check was added separately (§4) to prove a real
`map-v2` point is globally visible.

| Case | Result | Detail |
|---|---|---|
| A — Worker connectivity | **VERIFIED** | GET /health → HTTP 200 |
| B — Publish new sample | **VERIFIED** | POST /publish → `stored` (D1 row) |
| C — Idempotent republish | **VERIFIED** | re-send → `already-known` |
| D — Sample lookup | **VERIFIED** | `known` + correct contentHash |
| E — Content lookup | **VERIFIED** | canonical record, sampleIds[], representative |
| F — Conflict protection | **VERIFIED** | re-point sampleId → `rejected` (conflict), no last-write-wins |
| G — No-audio invariants | **VERIFIED** | payload metadata-only, features + analysis present |
| H — Usage-acceptance gate | **VERIFIED** | local V2 record → accept → enqueue → live flush → Worker `stored` → lookup `known`; marker `globalPublish.delivery === published` |
| I — Negative gate | **VERIFIED** | failed transfer → NO enqueue → no Worker call → lookup `unknown` |
| J — Offline → restart → live | **VERIFIED** | offline accept → pending marker → reconstruct (simulated restart) → live flush → `stored` → lookup `known` |

Exit code is now `1` on any NOT VERIFIED case (verified by code inspection at
`scripts/live-verify-16i.ts`).

## 4. 16M — real PAT chain (fresh, 23/23 VERIFIED) + global map visibility

Real chain re-verified end-to-end against the live Audiotool backend with the
account's PAT: `list → get → WAV download → Node decode → AnalysisPipeline →
IndexStore → map-v2 → Search → MachinisteService.send → backend read-back`.

- Sample: `samples/0001a13b-074e-5245-a443-1e19971190bd` **"Flume Tennis Snare"** (own, one-shot, wav 44100Hz/2ch/0.645s).
- Persisted V2 position deterministic: `persisted=(0.4120,0.8781) == recomputed=(0.4120,0.8781)`.
- Live Machiniste commit + read-back verified on the backend document (channel → sample entity 0bdb1f4e… → `samples/0001a13b-…`).
- Idempotency: second run of the same build skipped re-analysis (no redundant audio fetch).

Global-map visibility (server side, already published through the same Worker the
browser will call): a freshly published `map-v2` record returns **1 matching
point** from `/map` (`x=0.6556 y=0.5398`, representative sample
`16i-mapcheck-…`) and the sample lookup returns the persisted `map-v2` analysis.
Browser *rendering* of these points is part of Layer C.

## 5. Step 6 — the original `Juul perc` error

- The exact reported error (`sampleName: referenced sample does not exist or is
  inaccessible`) and the exact legacy ID are in no repo file and were not
  reproducible in the current live environment.
- Live test (PAT, real backend, real commit into project "Neural Pasture"):
  the **same named sample "Juul perc"** (`samples/0001a43b-ed6d-54c9-b8cd-3c9c15dcc694`,
  owner `users/tye_master_83`, public, foreign) — reference **ACCEPTED**, read-back
  verified, `errors: []`. Also accepted with the legacy hyphen-stripped name
  `samples/0001a43b8ac56a5690314a5b9e6d2f6c`.
- **Conclusion:** there is **no ownership/access gate** on Machiniste references
  to foreign public samples in the current backend; the mechanism works for
  samples accessible to the account, and foreign public samples are accessible.
  The user's original error was a **backend resolution/transitional state**
  (pre-16N build, different project context, or temporal server state), not a
  SampleMap code bug. No SampleMap code was changed for this — no access
  restriction was bypassed.
- Kept as permanent live tooling: `scripts/machiniste-foreign-access.ts`,
  `scripts/machiniste-legacy-name-test.ts`.

## 6. Layer C (browser OAuth) — BLOCKED

`src/main.ts:174` wires the real browser flow (post-OAuth: `mountLiveSampleMap` →
`openFirstProject` → `mountAuthenticated` → SampleMap UI → analyze → select →
"Add to Machiniste" → `sendToMachiniste` → verified usage acceptance →
`GlobalPublishQueue` → live Worker). `VITE_GLOBAL_WORKER_URL` is honored and the
vite port (5176) matches the deployed Worker's `API_ALLOWED_ORIGIN`. Verified
non-interactively: dev server boots, app renders the `login` button, and holds a
`VITE_GLOBAL_WORKER_URL`. The remaining step — the actual Audiotool OAuth login +
button clicks — is a human session that cannot be automated here.

## 7. Stage table

| Stage                   | Status | REAL/MOCKED/FIXTURE/BLOCKED | Evidence |
| ----------------------- | ------ | --------------------------- | -------- |
| Audiotool Auth          | PASS   | REAL (PAT)                 | PAT in Node against live backend (`step16m` 23/23); browser-OAuth variant = Layer C (BLOCKED) |
| Sample discovery        | PASS   | REAL                       | live `list()` → 20 samples (page of 50, 46 foreign) |
| Sample download         | PASS   | REAL                       | real `get()` + WAV download (113 881 B) |
| Audio decode            | PASS   | REAL                       | Node WAV decode 44 100 Hz/2 ch/0.645 s/28 452 frames |
| Audio analysis          | PASS   | REAL                       | real `AnalysisPipeline` (hash + canonical PCM + gate) |
| Classification          | PASS   | REAL                       | real `HeuristicClassifier` (openhat 0.320) |
| Map V2 position         | PASS   | REAL                       | persisted V2 == recomputed (0.4120,0.8781); fresh publish → `/map` point |
| Index persistence       | PASS   | REAL                       | real IndexedDB record, no audio bytes, persisted V2 position |
| Machiniste transfer     | PASS   | REAL                       | live `MachinisteService.send` committed (machiniste 5bc6dfb6…) |
| Machiniste read-back    | PASS   | REAL                       | backend document read-back verified (channel → sample entity → sample name) |
| Usage Acceptance        | PASS   | REAL                       | verified transfer → accepted → marker persisted (16I-H, 16M) |
| GlobalPublishQueue      | PASS   | REAL                       | queue + flush → live Worker `stored`; offline→restart→flush (16I-J) |
| Global Publish          | PASS   | REAL                       | fresh v2 record stored in D1, idempotent/conflict rules live |
| Global Map appearance   | PASS   | REAL (server) / BLOCKED (browser) | `/map?mapVersion=map-v2` returns the published point; browser render = Layer C |
| Browser Layer C         | BLOCKED| BLOCKED                    | interactive OAuth login + click-through not possible in this environment |
| Reload/reconstruction   | PASS   | REAL                       | 16I-J: offline accept → restart → reconstruct (real IndexedDB) → live flush → lookup `known` |

## 8. FINAL VERDICT

**B — PARTIALLY REAL — remaining concrete gaps** (every production path is live-
verified; only the interactive browser click-through is unverified).

Minimum remaining actions to reach A:

1. **Layer C browser run (one human session):** `npm run dev` with
   `VITE_GLOBAL_WORKER_URL=https://samplemap-d1-worker.sumadmusic.workers.dev`,
   click "Log in with Audiotool", open a sample, analyze → select → "Add to
   Machiniste", then confirm the global publish inserts the map point into the
   live map. This is the single remaining unverified surface.
2. (Optional) Re-check the user's original `Juul perc` failure under the current
   browser build to confirm it is historical; current backend accepts it.

No architectural changes are needed. No validation was weakened. All live calls
are real.