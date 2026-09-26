# STEP47 — One-Shot Classification Product & Data Integrity Audit Report

- **Step:** STEP47
- **Audit class:** Product & data integrity (audit-first — no tuning, no rules, no behavior changes)
- **Command:** `npx vitest run --testTimeout 60000` × `npx tsc --noEmit -p tsconfig.json`
- **Date:** 2026-09-10

---

## §1. Executive Verdict

**VERDICT: B — Correct.** The one-shot classification + data model behaves correctly as a
SampleMap product. Every audited product invariant holds; the data model is disciplined
(metadata-only persistence, additive optional fields, no audio bytes ever written, acoustic
coordinates never influenced by tags/popularity). The STEP46 body of knowledge (intrinsically
ambiguous boundaries — snare/clap, openhat/cymbal, synth/lead, instrument pairs) is **not a
data-integrity defect**: the system reports those honestly as low-confidence/ambiguous rather
than fabricating confidence. Two minor, non-blocking hardening findings (see §15): the
persisted-record validator does not (yet) enforce family↔type coherence, and the additive
surface mapping can emit cross-family `secondaryClasses` on the metadata-adoption path.

---

## §2. Overview & Scope

Audited four dimensions against the current production code (no changes made):

1. **Classification correctness** — structure, hierarchy, type, reconciliation
   (`src/classify/hier/*`, `src/classify/semanticClassification.ts`).
2. **Metadata/reconciliation correctness** — name/tag evidence, conflict handling, additivity.
3. **Analysis/data lifecycle** — pipeline wiring, persistence, reload, reanalysis
   (`src/pipeline/analysisPipeline.ts`, `src/persistence/indexStore.ts`, `src/global/hydrate.ts`).
4. **Product usefulness** — search/filtering contract, map semantics, Sound Space separation,
   eligibility, preview lifecycle, Machiniste handoff (§14 matrix).

Non-goals: no accuracy tuning, no rule changes, no schema/migration work; the duration-band
lassification (§4) is checked for *integrity*, not tuned.

---

## §3. Critical Data Flow (audited)

```
Scan (libraryScanner) → SampleMeta (Audiotool)
  → eligibility gate  (eligibility.ts:101-119; app.ts:715 — enqueue ONLY eligible)
  → job queue         (one-shot before loop, own before foreign: eligibility.ts:156-214)
  → analysisPipeline
       ├─ decode      (transient DecodedAudio, never persisted)
       ├─ V1 features (extractor)
       ├─ V2         (analysisV2, ANALYSIS_VERSION "2.0.0" — sampleAnalysisV2.ts:20)
       ├─ classifyHier (hier.surface → primaryClass; classificationVersion "hier-v1";
       │               pipeline.ts:276-290)
       ├─ semanticClassification (additive STEP38 layer; pipeline.ts:387)
       ├─ mapPosition (computePosition at ANALYSIS TIME; pipeline.ts:296)
       └─ persist     (assertNoAudioBytes enforced; indexStore.ts:265-268)
  → consumers
       ├─ SearchEngine (index.getAll → filters → deterministic sort; searchEngine.ts:92-135)
       ├─ Map / Sound Space (pure projections over persisted records; mapView.ts:351-354)
       └─ Machiniste (direct sample references; selection ≤ MAX_BATCH_SLOTS=8)
```

Every stage boundary is pure/deterministic. Persisted records are metadata-only by an enforced
invariant (§12).

---

## §4. One-Shot vs Loop vs Sustained-Phrase Integrity

`classifyStructure` (structure.ts:25-31) binds structural identity from **authoritative
metadata only**:

| Rule | Behavior | Source |
|---|---|---|
| `kind === "loop"` | → `loop` (regardless of duration) | structure.ts:27 |
| `kind === "one-shot"` AND `duration > 4s` | → `sustained-phrase` | structure.ts:28-29 |
| otherwise | → `one-shot` | structure.ts:30 |

**Duration is never allowed to flip kind.** The old `duration > 2.5 → loop` race is gone
(structure.ts:9-12): a short loop stays a loop, a one-shot stays a one-shot at every band.
The STEP47 audit duration bands (≤0.35 / 0.35–0.5 / 0.5–0.6 / >0.6 / >2.5 / >4s) were checked
for *drift* — none found: sub-4s one-shots do not become loops; only the explicit >4s
sustained-phrase rule triggers a non-one-shot result. The `≤0.35`/`0.5–0.6` bands feed the
type-stage "ultra-short"/"med" gates (type.ts:59-61, 111-113) but never structural identity.

The **one-shot-first product principle** is confirmed: queue priority drains one-shots
before loops (eligibility.ts:35-43).

*Targeted test: STEP47 Integrity §4 (3 tests).*

---

## §5. Hierarchy & Family↔Type Coherence

Families (`types.ts:29-35`): `drums | musical | vocal | fx | atmosphere-noise | unknown`.
`FAMILY_TYPES` (types.ts:38-49) is consistent with `familyOfType` (evidence.ts:86-96) —
verified entry-by-entry.

**Runtime coherence is guaranteed by construction:**
- **Audio path:** type is scored family-conditional (type.ts:194-213) — no global 22-class
  race, so a type can never leave its family.
- **Metadata path:** when a name/tag type is adopted under weak audio, the family is re-derived
  to follow the decided type (`familyOfType(metaType)`, classify.ts:157-163). Verified
  end-to-end (TAG-SUPPORTED fixture: acoustic drums + "bassline" → `family: musical,
  type: bass`, coherent).
- **Only exception:** `type: "other"` — the honest "no acoustic candidate fired" marker
  (type.ts:177-181, 195-196) has no family of its own (`familyOfType("other") = "unknown"`).
  The invariant is therefore: *family unknown ⇒ type "other"; otherwise type "other" is the
  sole allowed mismatch*; every fixture in the audit sweep satisfies it.

Surface mapping reuses the legacy `ClassId` vocabulary verbatim (classify.ts:97-111) so
search/`isKnownClass` are untouched — `ALL_CLASSES` membership verified for every fixture.

*Targeted test: STEP47 Integrity §5 (5 tests).*

---

## §6. Metadata Reconciliation (name/tag evidence channels)

Two independent evidence parsers (evidence.ts:154-180) feed a dedicated reconciliation stage
(reconcile.ts:72-163). States: `AGREE`, `TAG-SUPPORTED`, `AUDIO-SUPPORTED`, `CONFLICT`,
`UNKNOWN`.

- Tags/name are **never audio truth** and **never rewrite a raw tag** (evidence.ts:20,
  reconcile.ts doc, semanticClassification.ts:25).
- Generic terms (drum/music/sample/...) never fix a precise type (evidence.ts:71-75).
- Winner precedence: audio > name/tag; on tag↔name disagreement no type is claimed
  (reconcile.ts:56-60).
- Tag evidence in STEP38's `semanticClassification` refines **within** the audio family only;
  conflict discounts, never overrides (semanticClassification.ts:115-149).
- `winningSource` (reconcile.ts / types.ts:82) records which surface produced the decided
  type — persisted so the decision stays auditable.

**Finding (§15 V2):** on the TAG-SUPPORTED cross-family adoption path, the surface
`secondaryClasses` are derived from the *original acoustic family's* runner set
(classify.ts:100-109 uses `typeSc.runners` computed against `familySc.family`), which can
differ from the adopted family. Minor; see §15.

*Targeted test: STEP47 Integrity §5/§6.*
*Existing coverage: reconcile states + semantic layer (hier.test.ts, semanticClassification.test.ts).*

---

## §7. Eligibility & Popularity Semantics

`computeAnalysisEligibility` (eligibility.ts:89-128):

- OWN (stable account id match) → **always eligible** (eligibility.ts:101-103).
- FOREIGN → eligible **iff** `numFavorites >= 1 OR numUsages >= 1` (eligibility.ts:108-119);
  reason strings are stable: `own | foreign-favorite-and-usage | foreign-favorite |
  foreign-usage | foreign-no-signal | identity-unavailable`.
- `undefined` counters are **never coerced positive** (`undefined ⇒ 0`; eligibility.ts:24-26,
  105-106) — a counterless record can never unlock the gate.
- Missing identity → foreign rules; ownership is never wrongly claimed (eligibility.ts:124-127).
- Gate is **enqueue-only**: never deletes analyzed records, never forces re-analysis on
  metadata change (eligibility.ts:14-16; app.test.ts:2041).

**Popularity is exclusively a gate/discovery signal** (§22): the two counters appear only in
metadata + eligibility/priority — never in `confidence`, `classification`,
`similarityFingerprint`, or map coordinates (confirmed by contract: they are absent from
`HierClassifyInput`, `computePosition` inputs, and SoundCharacter extraction).

*Targeted test: STEP47 Integrity §3/§7 (3 tests). Existing: eligibility.test.ts (17).*

---

## §8. Map Semantics — Acoustic-Only, Never Popularity/Tags

`computePosition(features, decodedAudio)` (mapPosition.ts:85-94) is the **sole** authoritative
V2 position computation, run **once at analysis time** (pipeline.ts:296):

- **X** = whole-sample multi-window flatness → log SNR (tonal↔noisy).
- **Y** = log-scale `spectralCentroid` (dark↔bright).
- Fixed anchors, no corpus normalization, no re-ranking (mapPosition.ts:19-21) → fully
  deterministic and independent of the rest of the library.

Inputs are `AudioFeatures + DecodedAudio` **only**. There is no path by which name, tags,
favorites, usages, or classification can affect coordinates — structurally impossible by the
function signature. `mapVersion = "map-v2"` is pinned (mapPosition.ts:34).

*Targeted test: STEP47 Integrity §8/§9.* Existing: mapPosition.test.ts (23).

---

## §9. Sound Character / Sound Space Separation

Three independent projections, all driven by V2 acoustic knowledge — no cross-contamination:

| Projection | Source | Where |
|---|---|---|
| SampleMap `mapPosition` (map-v2) | flatness + centroid (at analysis time) | mapPosition.ts |
| Sound Space point (canonical display) | `analysisV2.soundCharacter` via `computeCanonicalSoundSpacePoint` | soundSpaceProjector.ts |
| Legacy `mapProjector` (frozen) | SoundCharacter weight projection (`X_AXIS_WEIGHTS`/`Y_AXIS_WEIGHTS`) | mapProjector.ts:51-78 |

Map view precedence (mapView.ts:321-325, 351-354): projectable Sound Character → canonical
Sound Space coordinate; else persisted `mapPosition` (data-availability fallback); else
**Missing-V2 → record is not placed**. There is **no V1-feature-derived recompute fallback**
(mapPosition.ts:14-16 anti-fallback; mapView.test.ts:139-144, 208-211).

STEP38 semantic classification explicitly "never affects map coordinates" (indexStore.ts:70-72,
semanticClassification.ts:9-10). Colors may reflect the semantic subtype (UI), but positions
never do.

*Targeted test: STEP47 Integrity §8/§9.* Existing: mapView.test.ts ("canonical wins",
"no V1 fallback").

---

## §10. Filtering & Search Contract

`SampleMapSearchEngine` (searchEngine.ts) is a read-only, deterministic projection over the
index (index.getAll):

- **Text fields searched:** `name`, `originalTags`, `owner` only (searchEngine.ts:34, 203-218).
- **Class filter:** single `ClassId`s AND the taxonomy groups `drums | musical | other`
  (searchEngine.ts:77-81, 166-179), OR-ed, matching `primaryClass` OR any `secondaryClass`
  (searchEngine.ts:181-184).
- **Default status** = `analyzed`; `gone`/other excluded unless explicitly requested
  (searchEngine.ts:83-85) — verified by targeted test.
- **Relevance** = text-match strength + confidence when text present; pure confidence ordering
  when not (searchEngine.ts:117-120); total deterministic comparator with sampleId tiebreaker
  (searchEngine.ts:137-163).
- **Popularity is absent** from match and score: verified — two records identical except
  `numFavorites`/`numUsages` produce identical results and scores.

*Targeted test: STEP47 Integrity §10.* Existing: searchEngine.test.ts (19).

---

## §11. Ambiguity Contract — Honest Reporting

The system is built to say "I can't decide" rather than fabricate:

- `family === "unknown"` when no family separates (family.ts:265-275, min score 0.3 / min
  margin 0.12) → `type: "other"`, `ambiguous: true`, low confidence (base 0.1;
  classify.ts:73-74).
- No acoustic candidate fires → `type: "other"` honestly, never the first candidate
  (type.ts:177-181).
- Ultra-short drum hits with sub-decisive margin route to the percussion residue with
  `ambiguous: true` rather than a confident guess (type.ts:182-188, §14).
- snare↔clap separation is intentionally capped below the ambiguity bar (type.ts:168-172);
  reconciliation then falls back to tag/name evidence — matching STEP46's measured finding
  that no strong V2 feature separates that pair.
- Confidence is a **decision** confidence with documented multipliers and hard cap 0.95 /
  floor 0.05 (classify.ts:37-43, 65-94) — never a claimed statistical probability
  (family.ts:16, types.ts:117).

*Targeted test: STEP47 Integrity §7/§11 (unknown → other, ambiguous, UNKNOWN state).*

---

## §12. Persistence, Reload & Serialization Invariants

`assertNoAudioBytes` (indexStore.ts:179-209) is enforced on every `IndexStore.put`
(indexStore.ts:265-268) and deep-walks nested objects; `Float32Array` is reserved solely for
the `embedding` field. Verified: rejects `Blob`/`ArrayBuffer`/`Float64Array`, accepts the
embedding exception and a full hier-v1 record.

Read path validates structural well-formedness (`isWellFormedIndexRecord`, indexStore.ts:
227-260); corrupt rows are treated as absent (self-healing re-analysis), **never deleted**
(indexStore.ts:218-221, 275-276). All additive STEP38/STEP44 blocks are optional metadata
(indexStore.ts:74-89) and survive the invariant.

Reload path: `buildRecordFromGlobalAnalysis` (hydrate.ts:50-132) reproduces the same record
shape from a global analysis (map position copied verbatim, hydrate.ts:118; V2
SoundCharacter decoded to analysisV2 for Sound Space + Find Similar, hydrate.ts:67-84).

*Targeted test: STEP47 Integrity §12.* Existing: indexStore.test.ts (23), hydrate.test.ts (9).

---

## §13. Reclassification Safety

There is **no standalone "reclassify"** entry point in the codebase — the only way to
reclassify a record is the full analysis pipeline, which recomputes features, V2,
`mapPosition`, fingerprint, and hier **atomically into one record overwrite**
(pipeline.ts:263-311). Therefore a stale/partial reclassification (new class, old position;
new V2, old fingerprint) is structurally impossible. The classifier itself is deterministic
(identical audio+meta ⇒ identical hier and surface), so repetition is idempotent. Global reuse
(16J) only *adds* a compatible global analysis when versions match (analysisReuse.test.ts:261);
incompatible versions never overwrite.

---

## §14. Product Capability Matrix

| # | Product question ("can I …") | Today | Where |
|---|---|---|---|
| 1 | Find samples by sound class/group | ✅ | search class filter (groups drums/musical/other) |
| 2 | Understand why a sample is classified | ✅ | persisted `hier.evidence` + `reconciliation` (types.ts:105-127) |
| 3 | Trust a decision / know its strength | ✅ | decision confidence 0.05–0.95, documented multipliers |
| 4 | Get an honest "can't decide" | ✅ | unknown family / `other` type / `ambiguous` / low confidence (§11) |
| 5 | Read a sample's true acoustic character | ✅ | mapPosition + Sound Character are acoustic-only (§8/§9) |
| 6 | Never have tags clobber acoustic truth | ✅ | additive hier, reconciliation precedence, conflict flag (§6) |
| 7 | Never leak popularity into results | ✅ | counters are gate-only (§7/§10) |
| 8 | Send samples to Machiniste by reference | ✅ | direct sample references; batch ≤ MAX_BATCH_SLOTS=8 |
| 9 | Preview audio without leaks | ✅ | preview ObjectURLs created + revoked (previewService.ts:144-149, 232-277) |
| 10 | Persist audio-free records | ✅ | `assertNoAudioBytes` enforced on every put (§12) |
| 11 | Keep old/legacy records working | ✅ | additive optional fields, Missing-V2 explicit, corrupt rows filtered |

Verified indirectly: focus is independent of batch selection (render.ts:461, app.ts focus vs
`selectedSampleIds`) and batch selection is capped at 8 (view.ts:365-369, step27 test) —
product invariants G/H.

---

## §15. Violations & Gaps

**No product-critical violations found.** All twelve STEP46/STEP47 product invariants hold.

**Gaps (minor, hardening only):**

- **V1 — Persisted-record validator omits family↔type coherence** (`isWellFormedHierClassification`,
  types.ts:159-172, checks fields but not that `familyOfType(type) === family` modulo
  `type === "other"`). No runtime path produces a mismatch (construction guarantees it, §5),
  but a hand-edited/corrupted row could pass the validator. The check is cheap and belongs
  there.
- **V2 — Cross-family secondary classes on the metadata-adoption path.** When weak acoustic
  audio (family X) adopts a name/tag type of another family Y (classify.ts:151-164), the
  surface `secondaryClasses` still come from X's runner set (classify.ts:100-109). A record
  surfaced as `bass` can therefore carry `snare`/`clap` secondaries, making search-group
  matching via `secondaryClasses` (searchEngine.ts:181-184) leak it into the `drums` filter.
  Low severity (only reachable on ambiguous audio), cosmetic for search grouping.
- **V3 (informational)** — `family` may in principle be a concrete family while `type ===
  "other"` (no candidate fired). This is the documented `other` exception (§5); the invariant
  owned by the validator must carve it out. Not observed as a problem in the sweep.

---

## §16. Regression & Verification

Spec commands executed, nothing skipped:

- **`npx vitest run --testTimeout 60000`** → **75 files / 1312 tests, all passing**
  (baseline 74/1290; net +1 file / +22 tests from the new targeted audit suite
  `src/step47Integrity.test.ts`).
- **`npx tsc --noEmit -p tsconfig.json`** → exit 0 (clean).

---

## §17. Final Verdict

**B — Correct.** As a product, the current one-shot classification + data model is sound:
disciplined metadata-only persistence, enforced no-audio-bytes invariant, additive optional
classification layers, acoustic-only map/Sound Space coordinates, gate-only popularity,
honest ambiguity reporting, atomic re-analysis. STEP46's ambiguous boundaries are reported
honestly through the reconciliation/ambiguity machinery rather than masked. The two findings
in §15 are hardening/cosmetic, not integrity defects.

---

## §18. Single Recommendation

**KEEP — keep the current system as-is.** Verdict B is justified by the audit: no product
data-integrity defect exists and nothing needs changing before the next step. Continue the
banked effort on the only open, pre-existing gap — **runtimes the synths/leads & instrument
pairs AI resolver** (STEP46) — which is an *accuracy* concern, not an integrity one. The two
§15 hardening items (persisted-validator family↔type coherence check; cross-family secondary
classes) are trivially small, additive, and non-breaking — they should be picked up whenever
the next code-touching step lands, packaged as pure hardening, and verified against this
audit suite (`src/step47Integrity.test.ts`), which pins every invariant verified above.