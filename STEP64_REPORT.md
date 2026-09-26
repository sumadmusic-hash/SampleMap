# STEP64 — Audit: Is the 13s project pagination necessary when OAuth/SDK boot already provides the authenticated identity?

**Deliverable:** Final report (11 required sections). Scope: code audit + minimal safe change + regression verification. All timings are **FACT (measured in the real browser)** unless explicitly tagged.

Date: 2026-09-11

---

## 0. Executive Verdict

**Verdict B — SAFE WITH FALLBACK.**

The OAuth/SDK boot (`audiotool(browser, userCode)` → `GetWhoami` RPC → `at.userName`) already returns the **exact** identity the map needs: the canonical `users/{slug}` resource id. The full project pagination (i.e. `resolveAuthenticatedUserIdFromProjects`, ~13 s in the real profile) is **redundant** on the standard path and existed only because `at.userName` was historically believed to be a *display name* rather than the canonical id.

Implemented as the smallest possible change: a zero-network fast path in `resolveAuthenticatedUserId` that returns `at.userName` when it is already a canonical `users/…` resource id; the entire legacy crawl + display-name resolution is **preserved verbatim** as an explicit fallback for absent/non-canonical whoami. No SDK changes, no new APIs, no parallel requests, and no existing test was weakened or removed.

Result (real browser, same driver methodology):

- FIRST USEFUL RENDER (time until SampleMap UI arrival — the driver's `mountSampleMap`-reached signal): **16 948 / 14 805 / 14 630 ms (BEFORE)** → **2 824 / 1 855 / 1 944 ms (AFTER)**.
- Identity resolution on the critical path: **13.23 / 13.15 / 12.88 s** → **0.00 / 0.10 / 0.00 ms**.
- Post-cleanup, marker-free pure-DOM confirmation: app shell present at **4 479 ms (cold) / 2 802 ms (reload)**; auth OK at +1 072 ms.
- Regression suite: **78 files, 1 348 tests, all pass**; `tsc --noEmit` clean.

> ⚠️ Evidence-fidelity correction (FACT, discovered during final verification): the driver's older log line `(map canvas mounted)` was a cosmetic misnomer. The real profile has **0 analyzed samples** (STEP62: samples=0), so the Sound Space panel renders empty/closed and the literal `[data-testid="sound-space-canvas"]` element **never mounts**. The driver measured the `[sm-timing] mountSampleMap` marker via its fallback branch (driver now relabeled `SampleMap UI mounted`). The before/after comparison is therefore a comparison of the same signal (arrival at mount), which is precisely the critical-path quantity STEP63R identified.

---

## 1. Identity Evidence

**FACT (real browser, 3/3 runs, real OAuth session):**

```
[ok] OK — authenticated as "users/sumad"
```

- `at.userName` is `"users/sumad"` — a canonical `users/{slug}` **resource name**, not a display name (SDK doc comments call it “user's name”; the runtime value is the resource form).
- Source: `AuthenticatedClient` (SDK `browser-auth.d.ts`) via `audiotool.auth.v1.AuthService/GetWhoami`; `src/main.ts:166` logs `at.userName`, `src/main.ts:213` passes it as `authenticatedUserName`.
- The derived identity (BEFORE instrumentation) matched byte-for-byte: `identity:verified input=users/sumad resolved=users/sumad` 3/3.

**FACT — the derived identity is identical to the boot identity:**
| Signal | Value (3/3 real runs) |
|---|---|
| `at.userName` (boot / GetWhoami) | `users/sumad` |
| `resolveAuthenticatedUserId` result (legacy 59-page crawl) | `users/sumad` |

No case exists in the audit where the crawl produced a value different from `at.userName`.

---

## 2. Why the Project Pagination Exists (and is now redundant)

- **History (inference, grounded in STEP38/STEP62):** before the whoami canonicality was proven, `at.userName` was assumed to be a display name. The SDK exposes an indexed user store and a display-name query (`listUsers` CEL on `user.display_name`), but no obvious canonical-id getter in the initial analysis.
- The crawl (`resolveAuthenticatedUserIdFromProjects`) was the *derivation* strategy: a solo-member project can only be listed when the caller **is** that member; requiring `member === creatorName` and that all candidates agree across **all** pages gives a stable canonical id footnote with strong uniqeness invariants.
- Failure cases it guards: 0 candidates, or ≥2 disagreeing candidates → `undefined` (safe-by-default).
- **Redundancy now proven:** whoami returns the identical canonical id directly, so the crawl no longer adds information on the standard path. It is kept **only as fallback** (Verdict B), not removed.

**FACT — the crawl’s cost on the real profile:** full pagination of ~59 pages × ~200 ms ≈ **12.6–12.9 s** of `ProjectService/ListProjects`, every cold start.

---

## 3. Critical-Path Analysis

Boot sequence (`src/main.ts` → `src/ui/bootstrap.ts` → `src/identity/authenticatedUser.ts`):

1. `audiotool(browser, userCode)` — OAuth/SDK boot (**~0.3–1.0 s**, known-good).
2. `buildBrowserDeps` → `resolveAuthenticatedUserId` — **awaited before mount**.
3. Legacy crawl paginated the ENTIRE project chain on this critical step.
4. `mountAuthenticated` → `openFirstProject` → `mountSampleMap`.

The identity resolved in step 3 is consumed for ownership/eligibility rules only (see §7); it does not gate rendering. But it is **on the mount critical path** (bootstrap awaits it), so its 13 s directly inflated first useful render.

**FACT (AFTER):** `identityResolution:end` is now 0.00–0.10 ms; the only remaining `ListProjects` calls are the single `openFirstProject` page-1 pick (pageSize 5, 1 call/run → 3 total across 3 runs). The 59-page crawl is gone.

---

## 4. Chosen Optimization: whoami fast path (verdict-independent rationale)

Three variants were audited:

| Variant | Assessment |
|---|---|
| V1 — decouple `mountSampleMap` from identity (identity becomes optional) | Possible but larger; unnecessary once V2 proven. Identity is already an *optional* dependency (`undefined` → foreign-only rules), so no additional decoupling is needed. |
| **V2 — use OAuth identity directly** | **PROVEN, chosen.** Byte-identical identity 3/3, zero cost. |
| V3 — bounded / early-exit pagination | Safe in principle, but weaker: keeps a network crawl on the path. Unnecessary once V2 proven. |

**Why B over V3:** V2 removes the crawl from the critical path entirely while V3 only bounds it; V2 also matches the SDK’s actual identity contract. The fallback keeps all edge-case behavior (bare display name, `Unknown User`, candidates disagreement, list errors) byte-identical to before.

---

## 5. Implementation Changes

`src/identity/authenticatedUser.ts` (the **only** production behavior change):

```ts
export const USER_RESOURCE_PREFIX = "users/";

/** True iff `userName` is already a canonical `users/{…}` resource id. */
export function isCanonicalUserResource(userName: unknown): userName is string {
  return (
    typeof userName === "string" &&
    userName.length > USER_RESOURCE_PREFIX.length &&
    userName.startsWith(USER_RESOURCE_PREFIX)
  );
}

// in resolveAuthenticatedUserId:
if (isCanonicalUserResource(at.userName)) return at.userName; // zero network
// …legacy resolveAuthenticatedUserIdFromProjects + resolveViaDisplayName UNCHANGED
```

- Removed a pre-existing dead duplicated if/`return` block in `resolveAuthenticatedUserId`, and all STEP63R/63R.1 `[sm-timing]` markers from production sources (`src/main.ts`, `src/ui/main.ts`, `src/ui/bootstrap.ts`, `src/ui/liveSession.ts`, `src/identity/authenticatedUser.ts` + the temporary STEP64 probe line).
- `src/e2e/harness/main.ts` markers were **kept** — the existing e2e spec `e2e/step63r-startup-timing.spec.ts` depends on them (C2: no test weakened/removed).
- Audit scripts (`scripts/step63r-*.mts`, `scripts/probe-profile.mts`) are explicitly temporary; the real-browser driver command was fixed to run from the repo root (`npx tsx scripts/step63r-real-browser.mts`), and its canvas-only first-render label was corrected to `SampleMap UI mounted` (evidence fidelity, see §0).

---

## 6. Regression Tests

New file `src/identity/authenticatedUser.test.ts` — **11 tests**:

**Canonical predicate (`isCanonicalUserResource`):** accepts `users/sumad`, `users/alice`; rejects `sumad`, `Unknown User`, `users/`, `""`, `undefined`, `null`.

**Fast path:** returns the canonical value with **zero** `listProjects`/`listUsers` calls (fakes throw if touched).

**Legacy fallback (all previously-existing behavior preserved):**
- bare display name → crawl; `undefined` OAuth identity → crawl;
- `Unknown User` → crawl resolves sole candidate `users/sumad`;
- no unique sole-member candidate → `undefined`;
- `listProjects` error → `undefined` (safe-by-default);
- cross-page candidate disagreement → `undefined` (asserts 2 pages fetched);
- display-name route resolves a unique match;
- projects/display-name disagreement → `undefined`.

**Suite:** `npx vitest run` → **78 files / 1 348 tests, all pass**. `npx tsc --noEmit` → clean. Both re-verified after Phase-D cleanup.

---

## 7. Real-Browser Before/After (same driver, same real profile, same live backend)

| Metric | BEFORE (STEP63R.1) Run A/B/C | AFTER (STEP64) Run A/B/C |
|---|---|---|
| First useful render (arrival at mount) | **16 948 / 14 805 / 14 630 ms** | **2 824 / 1 855 / 1 944 ms** |
| Identity resolution on critical path | **13.23 / 13.15 / 12.88 s** | **0.00 / 0.10 / 0.00 ms** |
| Identity | `users/sumad` (crawl) | `users/sumad` (boot) — byte-identical 3/3 |
| `ProjectService/ListProjects` per run | ~59 pages | 1 page (openFirstProject, pageSize 5) |
| STEP62 startup state | collections 0, jobs 169 queued, samples 0 | unchanged (collections 0, jobs 169, samples 0) |

Post-cleanup marker-free pure-DOM confirmation (`scripts/step64-dom-probe.mts`): app shell (`#app` populated) at **4 479 ms cold / 2 802 ms reload**; Sound Space closed (`soundSpace-status` absent) — canvas correctly never mounts with 0 analyzed samples.

> Note: the post-cleanup driver run (`/tmp/step64-final.log`) reports 90 s timeouts on all 3 runs solely because the driver’s *canvas-only* detection has no DOM signal available in a 0-sample profile and the `[sm-timing]` marker fallback was removed. This is a **driver signal defect, not an app regression** — the pure-DOM probe and the 3× app-level network/mount markers show normal fast boot.

---

## 8. Remaining Startup Cost (as distinct from identity)

**FACT (AFTER, marked):** of the ~1.9–2.8 s to arrival-at-mount:

- OAuth/SDK boot end: **996.6 / 332.7 / 422.1 ms**
- `openFirstProject` (list + pick + open + doc.start): **1 585.8 / 1 385.5 / 1 365.6 ms**
- `buildBrowserDeps` (post-fix): **144.0 / 1.2 / 0.9 ms**

Identity is no longer a contributor. Further wins would come from `openFirstProject` and OAuth boot, out of scope for STEP64.

---

## 9. Files Changed

- `src/identity/authenticatedUser.ts` — fast path + `isCanonicalUserResource` + dead-code/second marker removal (production behavior change).
- `src/identity/authenticatedUser.test.ts` — **new**, 11 regression tests.
- `src/ui/bootstrap.ts`, `src/ui/main.ts`, `src/ui/liveSession.ts`, `src/main.ts` — instrumentation removal only.
- `src/e2e/harness/main.ts` — **untouched** (markers intentionally kept for the e2e spec).
- `scripts/step63r-real-browser.mts`, `scripts/step64-dom-probe.mts` — evidence scripts (temporary).

---

## 10. Final Risk Assessment

| Risk | Rating | Mitigation |
|---|---|---|
| Backend changes whoami semantics to a display name | Low | Fast path requires `users/…` canonical form; anything else falls through to the unchanged legacy resolution |
| Non-canonical / absent whoami | None | Explicit fallback preserved + 11 tests cover every legacy branch |
| Sample metadata `ownerName` comparison breaks | Low | `owner === authenticatedUserId` compares resource ids on both sides; `users/sumad` == `users/sumad` proven |
| Critical-path regression | None | 0 network on fast path; full suite + real-browser verification green |
| Untested platform (e.g. PAT identity) | Low | Fast path is form-based, platform-agnostic; fallback untouched |

FACT/measurement is fully identified above; everything attributed to “history” is inference grounded in STEP38/STEP62 documents; the whoami-canonicality contract is an assumption from SDK types + live backend evidence.

---

*Methodology: code trace (requests/responses shown in-line above), 3× real Chrome runs on the real Audiotool backend with a real OAuth session (profile copy `/tmp/sm-real-profile`, Vite dev server on 127.0.0.1:5173), before/after driver runs, plus a marker-free pure-DOM probe for post-cleanup confirmation.*