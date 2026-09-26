# STEP61 — Own Upload Identity & Population Flow Audit

**STEP61 VERDICT: B — TECHNICALLY FEASIBLE, LIVE VERIFICATION INCOMPLETE.**

> "Does this Audiotool sample belong to the currently authenticated user?" — **YES** is technically supportable in *two independent ways*, both demonstrated against the live backend this session:
> - `sample.owner_name == <stable-id>` (LIVE VERIFIED)
> - `projects.listProjects → creatorName/userNames` (stable id, LIVE VERIFIED via PAT)
> The current production code path (`user.display_name` lookup) resolves correctly against the live backend for this account (`users/sumad`), but the **browser end of that path** — whether `at.userName` from GetWhoami equals the `display_name` used by `listUsers` — remains **BLOCKED** (no browser OAuth session here; GetWhoami returns an empty payload under a PAT). That is the only missing live link, and a project-based fallback would remove even the display-name assumption.

## 1. Executive Verdict

**B — TECHNICALLY FEASIBLE, LIVE VERIFICATION INCOMPLETE.**

Why not A: the rule `sample.owner == authenticatedUser` is supported by the actual API (resource-name equality on `users/{id}`-shaped values) and was exercised against the *real* backend, but the production identity chain as wired today (`at.userName` → `listUsers(display_name)` → id) could not be browser-live-probed end-to-end in this environment.

Why not C/D: no alternative mechanism is *required* — the stable-id comparison is already exactly what `eligibility.ts` does, and a display-name-free identity source (project membership) exists in the installed SDK.

Scale evidence (live): this account owns **~3,586 samples** (702/98 one-shot/loop in first 800) while a Start Scan discovers at most **200** unfiltered; the Audiotool sample pool exceeds **10,000** (walked without exhaustion). Layers A and B are not conveniences — they are the only paths that reach the populations involved. Layer C is already enforced by the existing verified-transfer seam.

## 2. Current User Identity

| Aspect | Finding | Class |
|---|---|---|
| Browser identity surface | `AuthenticatedClient.userName: string` only; no stable id field | TYPE/API VERIFIED — `browser-auth.d.ts:32-46` |
| Origin of `userName` | `POST https://rpc.audiotool.com/audiotool.auth.v1.AuthService/GetWhoami` → `whoami.userName` | CODE VERIFIED — `nexus/dist/index.js:2080-2118` |
| GetWhoami under PAT | returns `{"whoami":{}}` — **empty**; a PAT carries no OIDC identity claims | LIVE VERIFIED (this session) |
| `User.name` | unique resource name, e.g. `users/sumad` (observed = slug, *not* a UUID despite "users/{uuid}" doc phrasing) | TYPE/API VERIFIED + LIVE VERIFIED |
| `User.display_name` | mutable display name; filterable via `users.listUsers` | TYPE/API VERIFIED + LIVE VERIFIED |
| Stable identifier for *me* (currently) | derived: `resolveAuthenticatedUserId(client, userName)` — single `listUsers({filter:'user.display_name == <name>'})`, requires exactly one match + `displayName === name` + `name` has `users/` prefix | CODE VERIFIED — `src/identity/authenticatedUser.ts` |
| Alternative stable id source | `projects.listProjects` → `project.creatorName` / `project.userNames` (both `users/{slug}`) | TYPE/API VERIFIED + LIVE VERIFIED (all 5 listed projects: creator `users/sumad`, sole member `users/sumad`) |
| No "me"/current-user RPC | `UserService` exposes `ListUsers/GetUser/BatchGetUsers` only; no `GetCurrentUser` | TYPE/API VERIFIED — `user_service_pb.d.ts`, `audiotool-client.d.ts:66` |

## 3. Sample Ownership

Question 1 answers:
- **Stable user identifier?** Yes, by contract: proto field 4 documented as *"The Owner of the Sample in the form of `users/{user}`"* — LIVE VERIFIED: observed values are `users/<handle>` (e.g. `users/sumad`, `users/tye_master_83`, `users/xzajgih3_gmail_com`), string-comparable to `user.name`.
- **Display name?** No — it is not a display string; real values carry no formatting/debiana. 
- **Nullable / missing?** Yes, empirically. LIVE VERIFIED: public samples exist with `ownerName: ""` (e.g. `samples/0001a13b-...`, `displayName "Flume Tennis Snare"`, `numUsages: 20`); `filter: sample.owner_name == ""` returned 20 rows.
- **Mutable?** The field is a resource reference; values are stable handles. Renaming mechanics not observable here — INFERRED "stable for the lifetime of the account" from the resource-name contract + stable identity convention.
- **Guaranteed unique?** Values such as `users/sumad` are database keys; LIVE VERIFIED all 20 rows of an owner-filtered page match one candidate.
- **Available for every sample?** No — empty-owner samples exist (above).
- **Consistently returned by `samples.list()`?** Yes for owned rows (allMatch=true across pages); mismatches confirmed only for `""` rows.

Question 2: **no stronger field exists** — no `ownerId`/`userId`/`creatorId` on `SampleMeta`/`SamplePending` (TYPE/API VERIFIED — `sample-api.d.ts:56-83`).

## 4. Ownership Matching (PRIMARY QUESTION)

> Can SampleMap reliably determine whether a sample was uploaded by the current user? — **YES, PARTIAL browser-side; fully possible with a small identity-source change.**

Three verified facts assemble the YES:

1. `sample.ownerName` **is** the stable user resource name comparable to `user.name` (LIVE VERIFIED).
2. A live CEL owner filter round-trips exactly: `samples.list({filter: 'sample.owner_name == "users/sumad"'})` returned 20/20 owned rows (page 2 too) — LIVE VERIFIED.
3. Identity is derivable *without display-name guessing* from a `projects.listProjects` result where the user is a member (with single-member projects `creator == userNames[0] == me`) — LIVE VERIFIED data shape.

The ONE residual unverified link: today's production code obtains the id via `display_name` resolution, and `user.display_name == at.userName` (OIDC claim) cannot be proven without a browser OAuth session — **BLOCKED**. Its blocker is cosmetic: a project-membership identity path eliminates display names entirely. Risk if the display-name path *fails*: never a wrong own-claim; fallback is "everything foreign" (`identity-unavailable`) per `eligibility.ts` — safe-by-default, CODE VERIFIED.

## 5. Search Capability (`client.samples.list` — Nexus 0.0.17)

All of the following verified live today (via the PAT client, read-only):

| Option | Live result | Class |
|---|---|---|
| `filter` (CEL) | `sample.owner_name == "users/sumad"` works | LIVE VERIFIED |
| `textSearch` | `textSearch: "kick"` → 5 hits (owners `users/dtriplej`, `users/fearlessdependant`) | LIVE VERIFIED |
| `orderBy` | `"sample.create_time desc"` accepted | LIVE VERIFIED |
| `pageSize` | 100 accepted | LIVE VERIFIED |
| `pageToken` | next-page iteration works; no global cap in the API | LIVE VERIFIED |
| filterable fields | `name/display_name/description/owner_name/num_favorites/num_usages/bpm/sample_type/play_duration/create_time/update_time/clearance/tags/favorited_by_user` | TYPE/API VERIFIED — `sample-api.d.ts:203-246` |
| tags filter | CEL `sample.tags` filterable (field listed) | TYPE/API VERIFIED (live probe narrowed to owner/text/order) |
| favorited_by_user | filterable, `+=` semantic | TYPE/API VERIFIED |
| boolean syntax | `"guitar & (jazz | funk)"`, `"!bass & guitar"` per doc | TYPE/API VERIFIED |

**Litmus answers for §9:** arbitrary "search": yes; pagination beyond the first page: yes (unbounded in API); the **200-sample ceiling is ours alone** (app.ts:442,709; bootstrap.ts:203), not the API's; filters by owner/kind/tags/counters are server-side available.

## 6. Local Registration / Analysis Path

```
discovery (SampleMeta)
  → app.ts startScan()  →  computeEligibilityFromMeta + priorityGroupOfMeta
  → queue.enqueue(sampleId, analysisBuild, priorityGroup)   (IndexedDB, one job per sampleId; idempotent per build; failed→backoff; same-build "existing")
  → JobRunner.analyze(budget 10|100|1000)  (MAX_CONCURRENCY=1)
  → analysisPipeline (quality gate → decode → extract → classify → hier classify → content hash → position)
  → indexStore.put (SampleIndexRecord keyed by sampleId, pure metadata)
  → map renders record.mapPosition
  → previewUrlFor(record) lazily resolves preview
  → (publish seam: usageAcceptance) → GlobalPublishQueue → D1
```

Search-driven entry check: the **only** pipeline entry is `queue.enqueue(...)` (app.ts:726-730 wrapped in eligibility). An explicit user "Analyze" choice would be a *second caller* of the exact same entry point — `queue.enqueue(meta.name, analysisBuild, priorityGroupOfMeta(meta, authenticatedUserId))` — followed by an existing `analyze(budget)` run. Dedup: one job per sampleId in the queue; already-analyzed samples collide on the index key and only receive metadata refresh (`applyMetadataRefresh`, app.ts:772-782). **No architectural conflict; no schema change; no re-analysis machinery needed.** (CODE VERIFIED)

## 7. Current Own-Sample Limitations

The current system cannot enumerate own uploads automatically:

- **200-discovery ceiling** (cap in `app.ts:709` we refuse to exceed) against an own population of **~3,586** for the probed account — one scan in the default unfiltered feed surfaces only a small, arbitrary subset of own samples (many own samples never even *appear* in the default listing, which is global/public-leaning).
- The scan's unfiltered listing does not prefer own samples; creators of content are not differentiated by the listing — LIVE: unfiltered page of 100 returned own-share 0/100 for this account.
- **Eligibility is not the blocker for own** — own samples are eligible when *discovered* (`own` → always, priority group 0/2/4) — the failure sits upstream: the scan never discovers most own samples.
- **Revisit behavior**: delta scans re-see only listing-returned samples; unchanged rows unchanged; repeated scans never heal the coverage gap.
- **Empty-owner samples** (≥20 LIVE VERIFIED) are always treated as foreign (eligibility requires `owner.length > 0`) — samples whose owner field the server omits can never be auto-owned. If any of these were mine, they'd be missed silently.
- **Own dedup** works for analyzed rows: one job per sampleId; already-analyzed rows only get the metadata slice refresh.

## 8. Proposed Population Model Evaluation

| Layer | Proposed | Compatible with existing architecture? |
|---|---|---|
| **A — Own uploads** (always analyzed) | Scan with `sample.owner_name == <myId>` → eligibility marks them `own` (already), priority already own-first | YES — owner filter live-verified; identity resolution exists (display-name path) with a live-verified project-membership alternative. Population estimate for this account: ~3,586/LOW effort to surface in batches. |
| **B — User-driven search** (`kick`/`909`/tags → preview → Analyze) | `textSearch` + CEL filters + pagination all live-verified; entry = same `queue.enqueue` | YES — requires only a new UI commitment + a one-call analysis entry. The explicit-user-choice bypass of the popularity gate is a *routing* decision, not a pipeline change. |
| **C — Global knowledge** (transfer → D1) | unchanged, already the only admission rule | YES — untouched by A/B. |

Constraint audit vs frozen rules: A and B don't touch coordinates/classification/similarity (audio-derived only, qualityGate unchanged, numFavorites/numUsages stay discovery-only), don't persist audio, don't add ML, keep Sound Space separate. The only policy question A itself raises: an *explicit* cap on how much own backlog to analyze per run (budget already exists: 10/100/1000).

## 9. Architecture Impact

| Change | Classification |
|---|---|
| Layer A — own-filtered scan (additional scan pass or filter parameter on the scanner) + identity source hardening (project-membership identity fallback) | **SMALL CHANGE** (module-local; scanner/app only; pipeline untouched) |
| Layer B — search UI + explicit per-sample "Analyze" invoking `queue.enqueue` then `analyze` | **SMALL CHANGE** (UI + one entry point; queue/pipeline/index unchanged) |
| Layer C | **NO CHANGE REQUIRED** |
| D1 admission | **NO CHANGE REQUIRED** |
| Own-identity source swap (display-name → project membership) | **SMALL CHANGE** (`authenticatedUser.ts` adapter only) |
| Anything in audio analysis, hashing, coordinates, classification, Sound Space, D1 schema | **UNKNOWN-nope: none needed — all no-change** |

## 10. Risks / Edge Cases

1. **Missing owner metadata** — LIVE VERIFIED: samples exist with `ownerName === ""`. Current code handles them safely (never wrongly own); but any own-upload enumeration depending solely on `owner_name` will silently skip them.
2. **Duplicate display names** — display-name path is collision-safe (undefined when ambiguous) and would silently degrade to everything-foreign.
3. **Renamed users** — display-name path depends on current display name; resource-name (`users/{id}`) values are rename-proof. Migration risk is one-directional.
4. **Unauthenticated / identity unavailable** — non-fatal by design (bootstrap.ts:130-137); the entire fallback is "foreign rules only".
5. **Pagination** — pageToken verified to page 2+ under filters; pools > 10k unfiltered pages; own population (3.6k) fits in 36 pages at pageSize 100 ≈ fine.
6. **Large own populations** — 3,586 for the probed account is well inside queue/index scale; budget-driven analysis naturally amortizes it; no cap regression observed.
7. **Repeated scans** — idempotent per (sampleId, build); queue re-enqueue only after failure/backoff; metadata slice refreshes counters only.
8. **Already analyzed samples** — queue returns "existing"/"added" deterministically; index rows keep analysis fields (non-regression).
9. **Duplicate sample ids** — impossible at the queue (keyed by sampleId).
10. **Popularity eligibility interaction** — the foreign gate (`fav≥1 || use≥1`) is *not* entangled with ownership; explicit-user choices for foreign samples and own-filters operate on separate seams.
11. **Local vs global ownership semantics** — local `indexStore.owner` is a copy; nothing in D1 is owner-keyed; ownership only modulates *eligibility* and *priority*, not truth.
12. **Single-member-project identity derivation** — verified consistent for this account (5/5 projects `creator==userNames[0]==users/sumad`), but an account whose first listed project is a *shared* project needs the multi-project agreement rule; 0-project accounts need a fallback (display name) — hence B verdict.

## 11. Recommended Next Step

**STEP62 — Own-Upload Population (Layer A)**: (i) harden identity resolution to derive the stable `users/{slug}` from project membership (keeping the display-name path as fallback), and (ii) extend Start Scan with an **owner-filtered pass** (raise "no unbound scan" by making the first pass `sample.owner_name == <me>`, pageToken-driven, capped by the *existing analysis budget* rather than `scanMaxSamples: 200`) so every own upload becomes an analysis candidate, as the frozen rule demands. Layer B's search-driven analyze seam is already prepared in §6 — it is intentionally *not* part of STEP62.

---

## Verification (relevant suites, this session)

- `npx tsc --noEmit -p tsconfig.json` → **PASS**
- `npx vitest run` (root, 77 files) → **PASS 1337/1337**
- Live probes (Node + `AT_PAT`, READ-ONLY; scripts created → run → deleted; no production changes, no worker/D1 writes):
  - `projects.listProjects` → 5/5 projects `creator=users/sumad`, sole member `users/sumad` — LIVE VERIFIED
  - `batchGetUsers(users/sumad)` → `displayName="sumad"` — LIVE VERIFIED
  - `listUsers(display_name=="sumad")` → exactly 1 → `users/sumad` (round-trip) — LIVE VERIFIED
  - `samples.list(filter owner_name=="users/sumad")` p1+p2 → 20/20 + pagination — LIVE VERIFIED
  - Own population count: ≈3,586 (36 pages × 100); own kind balance first 800: one-shot 702 / loop 98 — LIVE VERIFIED
  - Unfiltered pool enumeration: ≥10,000 samples in ≤100 pages, token never exhausted — LIVE VERIFIED
  - `textSearch:"kick"` → 5 hits (foreign owners present); `orderBy:"sample.create_time desc"` — LIVE VERIFIED
  - Empty-owner reality check: `owner_name==""` filter → 20 rows; first unfiltered record had `ownerName:""` — LIVE VERIFIED
  - `GetWhoami` with PAT → `{"whoami":{}}` (PAT carries no identity claims; browser-only OIDC) — LIVE VERIFIED (└ BLOCKED for browser-only whoami)
- d1-worker unit suite (23/23) unchanged from this session's STEP60 run; not re-run for §17's minimum.