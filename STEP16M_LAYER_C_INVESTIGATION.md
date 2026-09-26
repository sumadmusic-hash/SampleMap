# STEP 16M — Layer C Investigation: Minimal Path to Close (Real Audiotool Session)

**Date:** 2026-09-03 · **Type:** Investigation only — no production changes, no new features, no redesign.
**Scope guards honored:** no credentials/PAT/OAuth-token/cookie printed, logged, embedded, or committed; no `.env` touched; no speculative implementation.

---

## 1. Current Layer C Status

- **Layer A (REAL browser / offline harness):** PASS — 20/20 Playwright assertions.
- **Layer B (live D1 backend read path):** PASS — `/health`, `/map`, `/samples/lookup`, CORS all live.
- **Layer C (live Audiotool Sample Pool + OAuth session + online Machiniste):** currently **BLOCKED** → overall Step 16M verdict **PARTIAL PASS**.

**Important correction/clarification found during investigation:** the word "BLOCKED" in the 16M report meant *no live OAuth **browser** session was available in the 16M environment*. It did **not** mean the Audiotool backend interactions are unproven. In fact each backend capability in the chain has **already been live-verified** against the real Audiotool backend — but **exclusively via a Personal Access Token (PAT) in Node**, never via OAuth in a browser (see §3, §4).

---

## 2. What Is Already Implemented

All of the following production code exists and is wired:

| Piece | Module |
|---|---|
| Browser OAuth flow (`audiotool({clientId, redirectUrl, scope}).login()`) | `src/main.ts:130`, SDK `browser-auth` |
| Real Sample Pool listing (`samples.list` pagination) | `src/ui/bootstrap.ts:145` `pageFetcher` |
| Real sample metadata (`samples.get`) | `src/ui/bootstrap.ts:108` `resolveSample` |
| Lossless analysis-source selection (WAV→FLAC) | `src/pipeline/sourceSelection.ts` `selectLosslessSource` |
| Real network audio fetch of a signed URL | `src/ui/bootstrap.ts:73` `browserFetchAudio` (`fetch(source.url)`) |
| Real Web Audio decode | `src/ui/bootstrap.ts:49` `browserDecode` |
| Analysis pipeline + classifier + features + map + persist + search | real service stack (steps 15–16) |
| Machiniste direct-reference (`samples/{uuid}`, no re-upload) | `src/machiniste/machinisteService.ts`, `src/machiniste.ts` |
| Live SampleMap UI wiring over an authenticated client + opened doc | `src/ui/main.ts` `mountAuthenticated` + `mountSampleMap` |
| Global publication orchestration (accept → enqueue → flush) | `src/main.ts` (POC) + `src/global/*` |
| **Full live end-to-end proof over a REAL sample via PAT in Node** | `scripts/step16m-live-verify.ts` |

The single largest piece of evidence is `scripts/step16m-live-verify.ts`, which **already runs the complete requested chain against the real Audiotool backend** (PAT-in-Node), covering exactly the objective's chain:

```
real sample list → real get → real WAV download → real Node WAV decode
→ REAL AnalysisPipeline (gate, hash, extractFeatures) → REAL HeuristicClassifier
→ REAL mapPosition → REAL IndexStore → REAL SearchEngine
→ REAL MachinisteService.send on a LIVE SyncedDocument → read-back verification
```

Every hop is implemented and live-proven to work against the real backend.

---

## 3. What Is Actually Missing

The evidence (STEP15G_LIVE, STEP16K_LIVE, STEP16F_LIVE, `scripts/step16m-live-verify.ts`, `SAMPLEMAP_V1_STATUS.md`) shows:

| Capability | Live-proven? | Via |
|---|---|---|
| Sample Pool list / get / WAV / FLAC download / decode | YES | PAT in Node |
| Real project open (`listProjects` + `open` + `doc.start`) | YES | PAT in Node |
| Machiniste `samples/{uuid}` direct-reference on a LIVE doc (read-back) | YES | PAT in Node |
| Full analysis/classification pipeline over a real sample | YES | PAT in Node |
| Global publish to deployed D1 worker (`POST /publish` → accepted) | YES (synthetic metadata only) | no auth needed |
| **OAuth browser login completing** (`audiotool().login()` with interactive credentials) | **NEVER done** | — |
| **Real SampleMap UI DOM over a live session** (map SVG, click→selection→inspector→send) | **NEVER done** | — |
| Real **preview playback** in a browser (Web Audio + ObjectURL) | NO | — |
| Publishing a **real analyzed sample** to `/map` (D1 `points[]` currently empty) | NO | — |

**So what is missing is not algorithm/backend/data-path code.** It is:

1. **(Environmental) An interactive, logged-in Audiotool browser session.** Every backend capability works; only the OAuth *login completion* (typing credentials once) is unperformed. This is a human/credentials environment gap, not a code gap.
2. **(Tiny glue) A live browser entry that completes OAuth, opens the user's first project, and hands the session to the already-written `mountAuthenticated` so the **real SampleMap UI** renders against the live pool.** Today no entry point does this: `index.html` mounts the OAuth *POC* (`src/main.ts`), `harness.html` mounts the *fixture* harness, and `mountAuthenticated` (`src/ui/main.ts`) has **zero callers**.
3. **(Small optional) Publishing one real analyzed sample** to the GlobalSampleIndex — the code path exists (`acceptUsageAndEnqueue` + `flushPendingPublications` in `src/main.ts`), it just was never run with a *real analyzed* record; `/map` returns `points:[]` for real data.

---

## 4. Required Authentication / Scopes

- **OAuth scope already sufficient:** the SDK factory uses a single scope string. The codebase uses `VITE_SAMPLE_SCOPE = project:write`, and the contrary operations already exercised under it include sample list/get/download, project list/open, and Machiniste modify. No additional scope is required for: reading the Sample Pool, sample metadata, preview/lossless URLs, opening/modifying a Nexus project, or creating/modifying a Machiniste entity.
- **Assigning `samples/{uuid}` reference:** already proven (PAT live) and requires no extra permission beyond normal sample access — the backend accepts a `samples/{uuid}` of a foreign public sample without a re-upload.
- **PAT vs browser:** A **PAT is only used on the Node/backend path** (`scripts/*.ts`, `src/cli.ts`). The **browser path uses OAuth only**; no PAT/token should ever be placed in `VITE_*` browser env or UI. A real logged-in Audiotool browser session **is sufficient** for the browser UI path.
- **GlobalSampleIndex publish:** the deployed Worker's publish write-path is currently permissive (OQ-9 is open) and needs no token; this is documented as an open question, not to be invented here.

---

## 5. Minimal Browser Environment

To execute Layer C once in a real browser:

1. Local Vite dev server on a fixed port — **already set**: `:5176` (`vite.config.ts`, `strictPort`).
2. System Chrome — **already the Playwright channel** (`playwright.config.ts` `channel: "chrome"`). (OAuth PKCE needs a real/interactive browser or an authenticated Playwright context with an existing Audiotool cookie; a *headless-with-no-session* tab cannot complete interactive sign-in by itself.)
3. **One OAuth callback URL** registered with the Audiotool app that matches the served origin (e.g. `http://127.0.0.1:5176/`, per `.env.example`/SDK docs) — **environment/registration, not code**.
4. **An existing Audiotool login** (one interactive sign-in, or a preserved session cookie) on the target origin.
5. `VITE_AUDIOTOOL_CLIENT_ID` set in `.env` (**already present** in the local `.env`); `VITE_SAMPLE_SCOPE=project:write` (**already present**).
6. A **user project** that can be opened (for the Machiniste send) — required by `mountAuthenticated`'s `doc`; the flow picks the user's first project like `src/main.ts` and `scripts/step16m-live-verify.ts` already do.
7. The Machiniste entity is created lazily if absent (as `src/main.ts`/harness already do) — a pre-existing device is **not** required.
8. No special browser flags needed beyond normal (the earlier `SharedArrayBuffer` fix removes the cross-origin-isolation dependency).

Nothing above requires hardware, a server deployment, or new dependencies.

---

## 6. Minimal Manual Test Procedure

A single interactive pass (matches the existing `scripts/step16m-live-verify.ts` asserts, but in-browser via the real UI):

1. `npm run dev` (Vite on `:5176`).
2. Open `http://127.0.0.1:5176/` in system Chrome; click **Log in with Audiotool**; complete one interactive sign-in (or reuse an existing session cookie) → POC shows `authenticated as "<user>"` and the real Sample Pool list.
3. Open the **SampleMap UI** (this is the only step needing the §5 glue) so the real map renders from `client.samples.list`.
4. `Start Scan` → `Analyze` (budget 10) → confirm real samples get analyzed/classified and appear as map points.
5. Click a point → inspector shows real name/class/position.
6. Send the selection to the Machiniste → confirm read-back `applied/readBackMatches=true` in a real project document.
7. Play preview → confirm audible playback in the browser.
8. (Optional) Let the top analyzed sample publish → confirm it appears in `GET /map` (`points` no longer empty) and `/samples/lookup`.
9. Confirm the browser console has no errors (mirrors 16M-20) and no credential is printed/logged anywhere.

---

## 7. Required Code Changes — the key question

**Answer: For the Node/PAT path — NONE.** The complete chain is already implemented *and* live-proven; Layer C (backend data path) is, as far as code goes, **already closed**.

**For an in-browser (OAuth) run of the REAL SampleMap UI — exactly one small glue addition** (not a redesign, not a new feature, not touching OAuth/security/credentials):

- **ONE new entry point** (~15 lines) that, *after* the existing `audiotool(...)` login in `src/main.ts` succeeds (status `"authenticated"`):
  1. opens the user's first project (`client.projects.listProjects({pageSize:5})` → `client.open(name)` → `doc.start()`),
  2. calls the **already-written** `mountAuthenticated(root, { client, doc })` (`src/ui/main.ts`),
  3. optionally triggers `app.analyze(budget)` + a publish of the top analyzed record via the **already-written** `acceptUsageAndEnqueue`/`flushPendingPublications`.

  All three building blocks (`OAuth`, `mountAuthenticated`, `publish queue`) exist and are independently proven; this only **wires them together in one browser entry** and is invoked from `index.html` (or a sibling `live.html`). It does **not** replace the POC's OAuth path, does **not** create fake OAuth, and does **not** weaken auth.

**Not required:** no new dependencies, no changes to `bootstrap.ts`/`buildBrowserDeps`, `mountAuthenticated`, `SampleMapMachinisteService`, `GlobalPublishQueue`, scopes, `.env`, or the Worker.

---

## 8. Security Considerations

- PAT is read **only** in Node processes (`scripts/*.ts`, `src/cli.ts`) from `.gitignore`'d `.env`; it is **never** injected into the browser, `VITE_*` env, or UI. Confirmed: no PAT references in `src/e2e/`, `harness.html`, `playwright.config.ts`, `vite.config.ts`; `dist/` contains no env file, `.env` is git-ignored.
- The browser path uses **OAuth** (SDK PKCE), not PAT — this keeps credentials out of the browser/UI entirely.
- No credential, token, cookie, or PAT value appears in this report, in tests, logs, screenshots, or generated files. Screenshot artifacts (`16M-*.png`, Layer A fixtures) contain only synthetic data.
- Global publish requires no token today (OQ-9 open). If a write-token were later added, it must remain a server/Node secret and never reach `VITE_*`/browser code.
- Any live Layer C run must avoid logging authenticated metadata that could leak session context and must ensure the sample list/URLs shown in the UI are not persisted to the repo.

---

## 9. Acceptance Criteria for Layer C

A **single real authenticated session** (either OAuth browser or, for the data path, PAT Node — already met) must demonstrate, with read-back/console evidence and nothing persisted to the repo:

1. Real Sample Pool listing returns real samples (pageCount tokens work). — *PAT: done*
2. `samples.get` returns real metadata (name `samples/{uuid}`, owner, duration, lossless URLs). — *PAT: done*
3. Real WAV (and FLAC) bytes download and decode. — *PAT: done* (browser decode separately A-verified)
4. Full REAL analysis: `extractFeatures` + `HeuristicClassifier` on the real decoded audio → valid, discriminating classification. — *PAT: done*
5. Record persisted with correct `sampleId` and **no audio bytes**; `SearchEngine` returns it. — *PAT: done*
6. Sample selected → canonical `samples/{uuid}` reference produced (`toSampleName`). — *PAT: done*
7. `SampleMapMachinisteService.send` against a **live SyncedDocument** commits with `readBackMatches=true` for the real reference. — *PAT: done*
8. **Real usable sample:** the channel points at the referenced sample (no re-upload), verified by read-back. — *PAT: done*
9. (Optional) The analyzed sample **publishes** to the live Worker and appears in `GET /map` / `/samples/lookup` (`points[]` non-empty for real data). — *NOT yet done; code path exists*
10. (Browser-only) The real SampleMap UI renders, selection→inspector works, preview plays. — *NOT yet done; blocked on OAuth login completion + §5 glue*

Items 1–8 are **already met** (PAT Node). Only items 9–10 remain for a fully green browser Layer C.

---

## 10. Recommendation: NEXT ACTION

> **Can we close Layer C simply by running the existing implementation in the correct authenticated Audiotool browser environment, or does the code still need changes?**

**Both, but overwhelmingly "just run it."** The backend/data-path code is **complete and live-proven** (PAT Node) — for that path no code change is needed at all. What remains is:

1. **The one interactive ingredient nobody can automate from here:** a **real, logged-in Audiotool browser session** (one manual sign-in, or a reused session cookie). This is an environment/credentials gap, not a code gap.
2. **One minimal, additive glue entry point** (≈15 lines, §5/§7) so the *already-written* `mountAuthenticated` mounts the real SampleMap UI onto that session, and optionally publishes the top analyzed sample. This is wiring existing, proven pieces together — not new architecture, not a redesign, not fake OAuth.
3. **Run `scripts/step16m-live-verify.ts` for a final green** Node/Layer-C data report (no code change), and, if the standing machine-user is acceptable, **publish one real analyzed sample** and confirm the `/map` points array populates.

**Explicit statement:** No substantive code change is strictly necessary to prove the Layer C *data path*. If the goal is a *browser-UI* Layer C with the real map over the live pool, only the ~15-line glue entry from §5/§7 is required. Nothing in this investigation justifies redesigning, replacing, or weakening the existing OAuth architecture.

**Do not start a new development phase.** The next action is environmental: obtain one authenticated browser session, apply the §5/§7 glue if browser-UI proof is desired, run the existing `scripts/step16m-live-verify.ts`, and re-run the 16M regression. Only then re-issue the Layer C tag (BLOCKED → VERIFIED) and consider the final `PASS`.
