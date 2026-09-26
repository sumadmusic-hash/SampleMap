# STEP60 — Sample Population & Curation Architecture Audit

**STEP60 VERDICT: B — CURRENT LOGIC WORKS BUT NEEDS A DEFINED CURATION POLICY.**

## 1. Executive Verdict

The current sample-population pipeline is a **correct, intentionally narrow vertical slice**: candidates come from a capped, paginated Audiotool sample listing (one request per page, no cross-field queries); eligibility is a binary signal gate (ownership / favorites≥1 / usages≥1); analysis is per-sample idempotent with an explicit budget; the global (D1) map is populated **only** through verified transfers via the Machiniste seam; and the browser map merges the full local set with a viewport-bounded D1 query. Nothing in this pipeline is a defect at the current scale, and the three layers the mission care about (relevant→candidate→analyzed→published→displayed) are cleanly separated in code.

However, at **no layer is there a deliberate curation policy**: there is no candidate ranking (only tiers and then raw Audiotool listing order), no per-class balance, no near-duplicate/redundancy measurement or eviction, no quality/confidence-gate on publish or display beyond structural admission, and no personal-relevance signal beyond ownership at publish time. These are gaps relative to a *curation* mandate, not bugs in a *pipeline* mandate. Verdict **B** is therefore chosen, not **C**: there is no concrete, evidence-backed defect that would make the current logic insufficient at the observed scale (STEP50: 1,439 analyzed samples, legible 44% canonical occupancy). Picking C/D purely because a curation policy would be "better in theory" is explicitly prohibited by this step's assumptions.

Evidence summary: D1 carries a strict content-level primary key (`(content_hash, content_hash_version)`) and a `gate_passed = TRUE` admission invariant ([0001_initial.sql](/Users/sumad/SampleMap/workers/d1-worker/migrations/0001_initial.sql)); the publish path resamples nothing from metadata (coordinates come only from audio-derived SoundCharacter/semantic classification); popularity signals gate *eligibility only* and never fold into acoustic truth; and every popularity/feature claim below is tagged with its evidence class.

## 2. Current Dataflow

```
[Audiotool sample pool]
   │  Start Scan → client.samples.list({pageSize:20, pageToken})      A
   ▼
[ScanCursor delta]  (samples.list nextPageToken; stop at maxSamples=200 OR cursor end)
   │  eligibility gate per sample (own → always; foreign → nFav≥1 OR nUsage≥1)   B
   ▼
[IndexedDB queue]  queue.enqueue(job, priorityGroup)  →  JobRunner budget 10/100/1000   C
   │  per job: qualityGate → canonical PCM → computeSoundCharacter → classify → similar → SoundCharacter V2
   ▼
[Local analyzed record]  status=analyzed; fingerprint/hash/coordinates persisted
   │
   ├── local Sample Map render (ALL records)                                  D
   │   (mirror-only: Publish Candidate created only inside the transfer seam)  E
   ▼
[Machiniste transfer]  sample slot → send → read-back verified → isSendSlotAccepted   F
   ▼
[acceptUsageAndEnqueue] → GlobalPublishQueue (idempotent per sample) → flush → HTTP batch   G
   ▼
[D1 worker]  publishAnalysisResults(batch) → content PK dedupe → sample_ref + content rows   H
   ▼
[Browser Sample Map global layer]  queryMapViewport(camera bbox) → ≤2 pages × 500 → mergeMapPoints   I
```

- **A** — [`app.ts`](/Users/sumad/SampleMap/src/ui/app.ts) `startScan` (startScan:694–736) → `scanLibrary(fetchPage, known, {pageSize: 20, maxSamples: 200})`. `fetchPage` wraps `client.samples.list` ([`bootstrap.ts`](/Users/sumad/SampleMap/src/ui/bootstrap.ts):180–183; `scanMaxSamples: 200` at bootstrap.ts:203; `DEFAULT_SCAN_MAX_SAMPLES = 200` at app.ts:442).
- **B** — [`eligibility.ts`](/Users/sumad/SampleMap/src/analysis/eligibility.ts) own→always; foreign→`numFavorites≥1 OR numUsages≥1`; `undefined` treated as 0; gate-only (never retroactively demotes). One-shot-first priority, own-before-foreign (capability tier).
- **C** — [`jobRunner.ts`](/Users/sumad/SampleMap/src/pipeline/jobRunner.ts) budget one of {10, 100, 1000}; `MAX_CONCURRENCY = 1`; persisted queue; failed→retry-after-backoff; stuck `processing` reset to `queued` on start.
- **E** — No direct browser→D1 publish path: publish flows **only** through the verified-usage-acceptance seam (`acceptUsageAndEnqueue`, [`usageAcceptance.ts`](/Users/sumad/SampleMap/src/global/usageAcceptance.ts):132). A Publish Candidate is fabricated at send time ([`publish.ts`](/Users/sumad/SampleMap/src/global/publish.ts) `createPublishCandidate`), not after analysis.
- **F** — [`machinisteService.ts`](/Users/sumad/SampleMap/src/machiniste/machinisteService.ts) `MAX_BATCH_SLOTS`-bounded sends; direct sample-reference (no audio); per-slot read-back verification → `isSendSlotAccepted`.
- **G** — [`publishQueue.ts`](/Users/sumad/SampleMap/src/global/publishQueue.ts): sample-level idempotency (analysisKey), failure taxonomy (network/retry/conflict), offline-first retention.
- **H** — [`provider.ts`](/Users/sumad/SampleMap/workers/d1-worker/src/provider.ts) `publishAnalysisResults`: content-level `already-known` dedupe server-side; `content` PK = content hash identity.
- **I** — [`app.ts`](/Users/sumad/SampleMap/src/ui/app.ts) `refreshGlobalPoints` (1001–1039): camera bbox → `queryMapViewport` → ≤ `GLOBAL_MAP_MAX_PAGES`(2) pages × `GLOBAL_MAP_PAGE_LIMIT`(500); epoch guard; `mergeMapPoints` local-wins per content identity ([`mapView.ts`](/Users/sumad/SampleMap/src/ui/map/mapView.ts)).

**Key architectural fact.** "Analyzed" **does not imply** "globally published / on the global map." The D1 population is a strict subset of the transferred population, which is a strict subset of analyzed records, which is a strict subset of eligible candidates (see §9 R1). Local map = full local record set; global map = transferred-only.

## 3. Current Limits (as-built, measured from code)

| Stage | Current limit | Evidence |
|---|---|---|
| Metadata discovery (per Start Scan) | **200 samples max** (pageSize 20 × up to 10 pages); stops at cursor end otherwise | [`app.ts`](/Users/sumad/SampleMap/src/ui/app.ts):442, 709; [`bootstrap.ts`](/Users/sumad/SampleMap/src/ui/bootstrap.ts):203; [`libraryScanner.ts`](/Users/sumad/SampleMap/src/library/libraryScanner.ts) |
| Analysis candidates (per Start Scan) | all scanned samples that pass eligibility (≤200) | eligibility enqueue in [`app.ts`](/Users/sumad/SampleMap/src/ui/app.ts):694–736 |
| Audio analyses per run | **budget ∈ {10, 100, 1000}**; 1 concurrent | [`jobRunner.ts`](/Users/sumad/SampleMap/src/pipeline/jobRunner.ts) |
| D1 write (publish) | HTTP batch ≤ **PUBLISH_MAX_BATCH || 100**; body ≤ **262144 bytes**; content-level idempotent | [`index.ts`](/Users/sumad/SampleMap/workers/d1-worker/src/index.ts):78, 117, 132, 160 |
| D1 viewport query | browser asks **limit 500**; worker clamps to `min(limit ?? MAP_DEFAULT_LIMIT||200, MAP_MAX_LIMIT||1000)`; **offset cursor**, ORDER BY (map_y, map_x), LIMIT+1 → hasMore | [`app.ts`](/Users/sumad/SampleMap/src/ui/app.ts):1020; [`provider.ts`](/Users/sumad/SampleMap/workers/d1-worker/src/provider.ts):419–420; [`index.ts`](/Users/sumad/SampleMap/workers/d1-worker/src/index.ts):79–80 |
| Browser map points (global) | **≤ 2 pages × 500 = ≤ 1,000** per refresh (epoch guarded) | [`app.ts`](/Users/sumad/SampleMap/src/ui/app.ts):450–451, 1012–1020; [`step16L.test.ts`](/Users/sumad/SampleMap/src/ui/step16L.test.ts):282 |
| Rendered points | **no renderer-side cap** — local records (unbounded) + global (≤1,000) merged and rendered in full | [`mapRender.ts`](/Users/sumad/SampleMap/src/ui/map/mapRender.ts); [`mapView.ts`](/Users/sumad/SampleMap/src/ui/map/mapView.ts) (`MAX_ZOOM` only constrains zoom, not point count) |

**Lacunae.** No persistence-shape cap (D1 grows indefinitely, no eviction — §5); the local IndexedDB index also has no cap/TTL ([`queueStore.ts`](/Users/sumad/SampleMap/src/persistence/queueStore.ts)); the browser map renders **everything** local, so a huge analyzed-but-unpublished local corpus is free to render regardless of D1.

## 4. Current Selection Algorithm (analysis candidates)

- Inputs: one page at a time, `samples.list({pageSize: 20, pageToken})`, **no `orderBy`, no CEL filter, no `textSearch`** ([`bootstrap.ts`](/Users/sumad/SampleMap/src/ui/bootstrap.ts):180–183; API surface at `node_modules/@audiotool/nexus/dist/api/sample-api.d.ts:203–246`). Result order = Audiotool default listing order → **deterministic per call, unspecified by SampleMap** [INFERRED — NOT VERIFIED that upstream order is stable].
- Stop condition: `maxSamples: 200` reached **or** cursor exhausted (whichever first). Nondeterministic "never scanned beyond 200" — the pool is deliberately a capped working set, not an exhaustive crawl. [IMPLEMENTED]
- Per-sample gate: eligibility (own→always; foreign→`nFav≥1 OR nUsages≥1`) decides **enqueue only**, never scan length. [IMPLEMENTED]
- Ordering/priority after gate: capability tier (own one-shot → own loop → one-shot → loop) then **raw API order** — **no ranking, no randomization, no class/balance knob, no favorites/usages ordering**, tags unused for selection. [IMPLEMENTED — the absence is a deliberate minimalism; a random/ranked candidate policy is [MISSING]]
- Determinism: queue order is deterministic given a stable upstream listing and stable sortKey. [IMPLEMENTED]
- Re-run behavior: Start Scan re-enqueues only **new/changed** discovered records (delta via cursor) plus re-adding other eligible; skipped/never-discovered samples are not automatically revisited outside a Start Scan. [PARTIALLY IMPLEMENTED]

**Answer to A-series.** (A1) current algorithm = eligibility-on-listing-order with one-shot-first tiering; (A2) Start Scan retrieves **at most 200** records — a deliberate cap, not the full pool; pagination is pageToken-based and robust *at the API layer* [IMPLEMENTED] but the scan itself is capped; (A3) max candidates/run = 200; analyses/run ≤ budget (10/100/1000); total analyses per sample = 1 (idempotent).

**B-series six-way distinction.** The pipeline *implicitly* distinguishes most states — never discovered (in scan but before eligible check; no registry), discovered-not-eligible (in-memory `ineligibleSkipped` counter during scan only), eligible-not-yet-analyzed (`queued` job), selected-not-analyzed (same), analyzed-not-globally-published (job `analyzed` + **absence** of a globalPublish marker), globally-known-not-displayed (viewport-culling at render). But none of these six states are modeled as an explicit, persisted, first-class state set — eligibility skips are not persisted and "analyzed but unpublished" has no dedicated status. [PARTIALLY IMPLEMENTED]

**B4–B7 lengths.** (B4) "analyzed" can exceed "eligible candidate pool" **only** via records transferred before eligibility existed (legacy), π-by design (needs a Start Scan); (B5) "analyzed-not-globally-published" is a **real, large, persistent** population — every analyzed sample that was never transferred (see §2 key fact); (B6) eligibility gate is **not re-applied to already-analyzed records** — information is added upward, never purged [IMPLEMENTED]; (B7) eligibility is recomputed on each Start Scan, so a record can become newly eligible (e.g., foreign sample gains its first favorite/usage) on the next scan [IMPLEMENTED].

## 5. Current D1 Admission Rule

- **Admission predicate = "sample was transferred through the verified Machiniste seam."** Submit(event) → committed → read-back verified → `isSendSlotAccepted` → `acceptUsageAndEnqueue` → publish queue → batch POST → D1. Analysis alone never publishes. [IMPLEMENTED — cite [`usageAcceptance.ts`](/Users/sumad/SampleMap/src/global/usageAcceptance.ts):132, [`publish.ts`](/Users/sumad/SampleMap/src/global/publish.ts), [`publishQueue.ts`](/Users/sumad/SampleMap/src/global/publishQueue.ts)]
- Structural invariants at rest: `content` PK `(content_hash, content_hash_version)`; `content_hash` must exist as `sample_ref`; **`gate_passed` is required and must be `TRUE`** (no partial/negative gate rows); duplicate content identity is impossible by PK. [IMPLEMENTED — [0001_initial.sql](/Users/sumad/SampleMap/workers/d1-worker/migrations/0001_initial.sql)]
- Content-level dedupe: two sampleIds sharing one content hash collapse to one `content` row (coordinate/semantic truth kept once), while `sample_ref` preserves the distinct Audiotool identity — the correct split for "map density ≠ population" (§9 R6). [IMPLEMENTED]
- `sound_character_v2` nullable, backfilled via COALESCE (V1-era rows preserved indefinitely because row key survives). [IMPLEMENTED — [0002_sound_character_v2.sql](/Users/sumad/SampleMap/workers/d1-worker/migrations/0002_sound_character_v2.sql)]
- **No** quality/confidence gate, no technical-gate re-check at publish time (relies on publish-source validation only), no popularity, **no personal-relevance check beyond existence of the transfer itself**, no near-duplicate measurement, **no eviction/retention cap** (append-only). Global sample count grows unboundedly. [all of the above: [MISSING]/[IMPLEMENTED-absence]]

**Answer to C-series.** (C1=C4) Personality/quality do **not** gate D1 [MISSING]. (C2) Gate abstracts away the single upstream source — yes, imposing policy at this single point works [PARTIALLY IMPLEMENTED — the point exists, the policy is empty]. (C3) Yes — analyzed ≠ globally published (evidence §2). (C5) Yes — no eviction; content rows persist forever [IMPLEMENTED-absence]. (C6) D1 holds "content" rows keyed by hash with gate_passed invariant — a lossless abstraction with a *structural* cap [PARTIALLY IMPLEMENTED]. (C7) Nothing now admits → only structural+gate validation [IMPLEMENTED-absence]. (C8) Classification `confidence`, `similarity`, `primary_class` are **stored**; none are used for admission [IMPLEMENTED — s.a. stored-but-unused]. (C9) No coherence/self-consistency pruning [MISSING]. (C10) Yes — no cap, no eviction [MISSING].

## 6. Current Map Admission Rule

- Display = **full local record set** (unbounded, merged local-wins) **+** viewport-bounded global page (≤1,000/refresh, epoch-guard debounce 250ms). [IMPLEMENTED — app.ts:450–454, 1012–1020, mapView]
- No density/quality/confidence/redundancy/class-balance/relevance rule at the display layer. [MISSING]
- Duplicate-coordinate samples (distinct sampleIds, identical acoustic coords) are allowed to coexist as separate points (seen at STEP50 min-NN gap ≈ 0). [IMPLEMENTED — observed, documented in STEP50_REPORT.md §—]
- Secondary classifications, tags, name, search strings are not display-admission inputs; only the coordinate + primary family/type. [IMPLEMENTED]

**Answer to D-series.** (D1) Display population = local-all + global viewport page; (D2,D3) no deliberate diversity/coverage/redundancy rule at display time — the projector's canonical grid keeps density bounded *structurally* (coordinate→cell), but no *selection* control; (D4=D5) audio-derived truth keeps duplicates-in-acoustic-space undistinguished; (D6) no explicit "do not draw" rule exists; (D7) the display layer *re-renders* the merged set and would benefit from its own display policy (see §10 Layer 3); (D8) map-space density is governed by SoundCharacter projection, not by admission — an admission rule can increase variety only via which rows exist. [IMPLEMENTED semantics / [MISSING] policy]

## 7. Personal-Relevance Capability Audit

| Signal | Available? | Reliable? | Current use | Future potential |
|---|---|---|---|---|
| **Own upload** | Yes — `SampleMeta.ownerName`; identity resolved via `resolveAuthenticatedUserId` (one `users.listUsers` on `user.display_name`, [authenticatedUser.ts](/Users/sumad/SampleMap/src/identity/authenticatedUser.ts)) | **NOT VERIFIED** live (CEL filter `sample.owner_name` exists at `sample-api.d.ts`; whether the listing's `ownerName` matches the stable `users/{uuid}` id compared in `eligibility.ts` is unconfirmed against a real account) | Own → always eligible; own → higher priority tier, [eligibility.ts] | Strongest first-class relevance signal; could drive Candidate Layer 1 (own first) and Layer 3 ranking without metadata→acoustic leakage |
| **Current-project usage** | Yes — `openFirstProject` lists first usable project, pageSize 5 ([liveSession.ts](/Users/sumad/SampleMap/src/ui/liveSession.ts)) | Yes (it is the document the Machiniste seam edits) | None for population — projects gate the *transfer* seam only; not a candidate signal | Could feed "samples already used in my current project" (strong-but-narrow) |
| **Historical user usage** | Partial — `ListProjectsRequest` has CEL filter + page_size ([project_service_pb.d.ts](/Users/sumad/SampleMap/node_modules/@audiotool/nexus/dist/gen/audiotool/project/v1/project_service_pb.d.ts)) but implies listing/opening every project ever | **NOT VERIFIED**; expensive, and "used" ≠ "in a project" today | None | Feasible-in-principle Campaign-layer input; high effort, unproven reliability |
| **SampleMap transfer** | Yes — per-sample verified globalPublish marker + publish queue (local-only today); **no transfer timestamp/count table exists** | Yes for "transfer happened" (Marc-contact verification); **not** a DAW-usage proof (documented) | This is the sole D1 admission rule (§5) | Foundation for "trusted / touched by me" Layer 3 signal; would grant "favorite but never transferred" visibility with a count table |
| **User favorite** | Yes — `SampleMeta.favoritedByUser`, `numFavorites`, CEL `sample.favorited_by_user` | Yes structurally (unverified live) | Only as foreign-eligibility gate signal + metadata slice | Later personal "I favorited this" candidate/ranking signal |
| **Audiotool usage count** | Yes — `SampleMeta.numUsages` | Yes structurally; global (non-personal) by definition | Only as eligibility gate multiplier | Treat strictly as *discovery* signal, never acoustic (frozen constraint §1.4) — no new design work needed |

**Summary** (E-series). E1 own-upload = best available, needs live confirmation [NOT VERIFIED]. E2 current-project = reliable but irrelevance-esque narrow; **never exposed as a Candidate/Display signal** [MISSING]. E3 historical usage = reconstructable in principle only [INFERRED / NOT VERIFIED]. E4 SampleMap transfer = currently the *only* enforced relevance-like signal (D1 admission) but with no provenance metadata (no timestamp, no count) [PARTIALLY IMPLEMENTED]. E5/E6 = eligibility gates only, already wired [IMPLEMENTED].

**Population risk from frozen constraints.** Because foreign eligibility requires `favorites≥1 or usages≥1`, the *entire foreign candidate pool is popularity-biased*; own-upload is the only path to non-popular content (§9 R3). None of these signals ever touches coordinates/classification/similarity (verified: SoundCharacter follows `similarityRanking.ts` weights only; publish resamples nothing). [IMPLEMENTED]

## 8. Quality & Diversity Audit

Concepts that exist vs. are absent — **[IMPLEMENTED] vs [MISSING or [PARTIALLY IMPLEMENTED]]**:

| Concept | Status | Evidence |
|---|---|---|
| Technical audio gate | [IMPLEMENTED] | `qualityGate.ts` — container/header/PCM sanity only; deliberately non-aesthetic (Step 15H) |
| Analysis quality (`overall`, `featureCoverage`) | [PARTIALLY IMPLEMENTED] | `computeSoundCharacterQuality` ([soundCharacter.ts](/Users/sumad/SampleMap/src/analysis/soundCharacter.ts):152), carried in `analysisV2.quality`; optional similarity gate `minCoverage` exists but is **OFF by default** ([similarityRanking.ts](/Users/sumad/SampleMap/src/analysis/similarityRanking.ts):190,205); **not persisted to D1**, not used for any admission/display decision |
| Classification confidence | [IMPLEMENTED] | stored (`confidence`), used in similarity/search ordering; **not** an admission or display gate |
| Preview availability | [IMPLEMENTED] | lazy `previewMp3Url`/`mp3Url`; not a population concept |
| "Sample usefulness" | [MISSING] | no such notion anywhere |
| Redundancy (near-duplicate) control | [MISSING] | only **exact** content-hash collapse in D1; acoustic near-duplicates (small NN gap) render at identical coordinates — STEP50 measured NN-gap as an observation, never as a gate; no eviction of redundant rows |
| Popularity (nFav/nUsage) | [IMPLEMENTED] | gates eligibility; never folded into acoustic truth (verified); not used for ordering/ranking |
| Class/type balance (drums: kick/clap/hat/… balance) | [MISSING] | candidates tier only by capability (one-shot/loop) + own; no class-level knob (STEP50's class regional specialization exists as a *neutral property*, not an engineered balance) |
| Diversity (spread across acoustic space) | [MISSING] | canonical grid limits *map density*, not *selection variety* |

**Redundancy vocabulary for STEP50 evidence.** Duplicates-in-space exist because two *distinct content hashes* (different recordings with audibly similar content) legally share a coordinate — the map can look "denser" near kicking-corner while selection stays uniform. This is precisely what `sound_character_v2` (8-dim representation + `similarity` fingerprint, [0002]) could power as a **redundancy metric** (`cosine`/NN of full 8-dim chars) **without touching the canonical projection** — supported by code, currently unused for this, [PROPOSED].

## 9. Population Risks

- **R1 — Volume ceiling mismatch.** D1 admits *only transferred* samples; the browser map then renders its whole local set. As transfers grow, the local set and the *unbounded* D1 population both grow with **no cap on pipeline scale** (metadata scan 200 ≠ D1 population cap; D1 has none). The product will silently drift from "personal map" to "ever-growing index" unless a curation/eviction policy is added. [MISSING policy / INFERRED]
- **R2 — Deterministic starvation.** With no ordering/randomization and a fixed 200 cap, an upstream listing dominated by one account/class can starve a diverse candidate pool; reversing direction needs deliberate reordering, not code. [MISSING]
- **R3 — Popularity-bound foreign pool.** Foreign eligibility (`nFav≥1 ∨ nUsage≥1`) mathematically excludes long-tail/rare samples unless owned — a *frozen* eligibility rule (must not change), so variety for non-owners must come from elsewhere (owning + a display/curation policy). [IMPLEMENTED constraint, risk acknowledged]
- **R4 — Loop under-representation.** Tier order (one-shot before loop) plus budget caps starves loop samples in small runs; no class-level rebalancing exists. [MISSING]
- **R5 — Unproven personal-identity matching.** Own-upload gating depends on `ownerName` vs `users/{uuid}` comparison that has never been verified live. If it mismatches, own-always-eligible silently degrades to popularity-boundness. [NOT VERIFIED](live)
- **R6 — Density≠Population confusion.** Map density under the canonical grid is a *projection artifact*, not an admission result — readers of the map will read cell fullness as "we gathered everything" when they shouldn't. [INFERRED / documented in STEP50]
- **R7 — Proxy-transfer semantics.** "Transferred" is a *signal of personal contact*, not a guarantee of acoustic value, yet it is the ***only*** D1 admission rule; a batch transfer of redundancy-heavy samples is fully admissible. [IMPLEMENTED, risk acknowledged]

## 10. Proposed Three-Layer Policy (selection → admission → display)

All items labeled **[PROPOSED]** — none implemented.

### Layer 1 — Candidate Policy (browser: who gets analyzed)
- **Stage A — Campaign**: own-upload candidates first (Stage A of §4), then eligible foreign by listing order; 2nd/3rd pages rotate an *acoustic-diversity tiebreak* (8-dim `sound_character_v2` proximity to already-queued) instead of pure page order. Keeps eligibility frozen; adds variety without any new metadata.
- **Stage C — Ownership-cap**: if a page is dominated by one owner, throttle toward other owners (auditable, deterministic).
- Candidate set stays bounded by the 200 cap; fairness is achieved by *which* 200, not by raising the cap.

### Layer 2 — Global Admission Policy (D1)
- **Mandatory**: content-hash uniqueness + `gate_passed` + valid transfer certificate (already enforced).
- **Stage A — quality/technical gate at publish**: require the published record to carry `gate_passed` and a *baseline `featureCoverage` floor*, else defer forever (not delete — keep `sample_ref.gate_passed=FALSE` rows pending, `content` row absent). Structural only, never aesthetic.
- **Stage B — persistence-shape**: total-content cap (e.g., APPEND-only within a per-day batch budget) — protects D1 by rate, not by cherry-picking.
- **Stage C — eviction policy** (optional future): remove *content* rows below a similarity-redundancy threshold only when the map's canonical grid is otherwise full; keep `sample_ref` as history. **NOT** the equals-sign of audio quality.

### Layer 3 — Display Policy (browser map)
- Concatenate local + global but then apply **display rules only** (never delete underlying records):
  - identical-coordinate duplicates → single representative point per cell (popover lists the others); map gets density honesty for free.
  - optional per-class/per-capability balance shown as a control (drums-only vs all), not an admission rule.
- The *filter/search* pipeline already orthogonalizes content (STEP50 50M-04); display rules must ride the same orthogonal axes, never new metadata.

Layer separation is deliberate so that *no* layer has authority to corrupt another: Layer 2 never decides "display", Layer 3 never decides "admission", Layer 1 never decides "truth". This is where "curation" lives: **policy sits at 3 independent points, enforced by the codebase's existing seams** (§2 A–I), not by one giant validator.

## 11. Open Questions

- Q1 — Does-a-`sample.owner_name` CEL filter reliably match the stable `users/{uuid}` id used in eligibility? (Live test needed.) [NOT VERIFIED]
- Q2 — Is upstream Audiotool listing order stable across calls? (Drives determinism claim.) [NOT VERIFIED]
- Q3 — Should "own-upload" ever be demotable by a quality floor? (Currently never — own is always eligible by frozen rule.) [PROPOSED/decide]
- Q4 — Is "transfer" the right *personal-relevance* threshold, or should it also require the sample to be **not** a near-duplicate of something already transferred? [PROPOSED/decide]
- Q5 — What is the max *displayed* map cardinality before the SVG layer degrades (no render cap exists today)? [NOT VERIFIED — measurement missing]
- Q6 — Should `featureCoverage`/`confidence` become a publish gate (Layer 2 Stage A)? [PROPOSED — needs calibration from STEP45-style evidence]
- Q7 — Does a per-owner cap belong in Layer 1, or is that over-fitting the popularity constraint? [decide]
- Q8 — Worker `API_ALLOWED_ORIGIN` / authorizer remain permissive placeholders for authenticated personal use [NOT VERIFIED live]; does the D1 writing user need real auth before population grows? [decide]

## 12. Recommended Next STEP

**STEP61 — Live-verify personal-relevance identity + one redundancy measurement.** Two cheap, deterministic experiments that de-risk R3/R5/R6 BEFORE any policy code:

1. **Own-upload identity probe** (browser, offline-ish): after login, list `client.samples.list({filter: "sample.owner_name = '<displayName>'", pageSize:20})` and compare returned `ownerName`s against the current `authenticatedUserId`; record match/mismatch. Answers Q1, validates §7's strongest signal. (Live Audiotool auth required — blocked in this environment, as with STEP59.)
2. **8-dim near-duplicate counter** (batch script over the STEP45/STEP50 ref-corpus + transferred records): count content-identity clusters, near-duplicate pairs (cosine SNN distance < epsilon of full `sound_character_v2`), and identical-coordinate collisions; report the redundancy distribution the Layer-2/3 policies would have to handle.

Then STEP62 can implement Layer 2 Stage A (feature-coverage publish gate) and Layer 3 dedupe-render using those numbers. The next step must be **measurement + one live probe, not policy code** — the frozen rules forbid speculative design, and a single verified signal (own-upload match) unlocks the highest-value policy (own-first candidacy) with the least risk.

## 13. STEP60 questions → evidence map

Every numbered group above answered: **A1–A3** → §3–4; **B1–B8** → §4 (six-way map + B4–B7); **C1–C10** → §5; **D1–D8** → §6; **E1–E6** → §7; **F1–F8** → §8; §9 pain points → §9 (R1–R7); §10 three-layer decode → §10. All claims tagged with evidence class per §1.7 (IMPLEMENTED/PARTIALLY IMPLEMENTED/AVAILABLE API CAPABILITY/INFERRED/NOT VERIFIED/MISSING/PROPOSED).

## 14. Verification (as-of date below; both PASS)

- `npx tsc --noEmit -p tsconfig.json` → **PASS**
- `npx vitest run` (root, 77 files) → **PASS 1337/1337**
- `npx vitest run` (workers/d1-worker, 2 files) → **PASS 23/23**
- Playwright subset (map render 16M, publish status EP6, transfer EP3, map usability 50M) on a temp 5176 vite harness → **PASS 37/37** (full 202-test suite remains blocked by the pre-existing 5173/5176 vite/playwright port drift, unchanged — not modified for this step, documented in prior steps).
- Full-suite numbers unchanged from STEP59: 1,337 vitest + 23 worker + 19 playwright as run previously.

## 15. Scope

Audit-only. **No production code was modified in STEP60.** The single deliverable is this report. Pointers to files, code refs (file:line), and prior reports (STEP45/STEP50/etc.) are authoritative; where a claim is a live-environment fact, it is tagged NOT VERIFIED because no live Audiotool OAuth/D1 session exists in this environment.