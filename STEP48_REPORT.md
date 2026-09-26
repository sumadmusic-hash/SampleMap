# STEP48 — Audit-First Hardening Report

- **Step:** STEP48
- **Audit class:** Audit-first hardening (validator + surface-mapping integrity — no tuning, no thresholds, no features, no new rules)
- **Command:** `npx vitest run --testTimeout 60000` × `npx tsc --noEmit -p tsconfig.json`
- **Date:** 2026-09-10

---

## §1. Executive Verdict

**VERDICT: A — two real integrity defects existed and are now closed; no remaining action from
STEP48.**

The STEP48 audit confirmed both STEP47 hardening findings and closed them without touching the
classifier, thresholds, features, map, Sound Space, eligibility, popularity scoring, reconciliation
precedence, migrations, or the sound-character path:

1. **Objective A (persisted-validator family↔type coherence):** `isWellFormedHierClassification`
   validated field types but never the family↔type pair, and the read-path
   `isWellFormedIndexRecord` ignored `hier` entirely. Both are now closed (validates, never
   normalizes/repairs; incoherent persisted rows → treated as absent → re-analysis).
2. **Objective B (cross-family secondary leak):** the metadata-adoption path could leave
   acoustic-family `secondaryClasses` (snare/clap/tom) on a musical surface. Now filtered to the
   final adopted family; same-family output is bit-for-bit unchanged.

**Objective C (the "AI resolver" reference):** traced to a single orphaned sentence in my own
`STEP47_REPORT.md:356`. STEP46 does not establish any AI-resolver requirement (verdict B, single
recommendation KEEP). Outcome: **REFERENCED ONLY — nothing to implement.**

Regression: **76 files / 1326 tests / 0 failures; `tsc` exit 0** (was 75 / 1312).

---

## §2. Overview & Scope

Audit-first hardening of the two STEP47 findings, each closed with the smallest, additive,
non-breaking change:

1. `src/classify/hier/types.ts` — `isWellFormedHierClassification` (persisted structural
   validator, family↔type coherence).
2. `src/classify/hier/classify.ts` — `mapToSurface` (no stale acoustic-family secondaries after
   cross-family metadata adoption).
3. `src/persistence/indexStore.ts` — read-path gate continuity so the Objective A guarantee is
   enforceable on persisted rows, not only at the type-check level.

Non-negotiables honored: no classifier/threshold/feature/map/SoundSpace/eligibility/popularity/
sound-character/reconciliation-priority changes; no AI/ML/LLM/embeddings; no migrations; validator
**validates, never normalizes**; invalid persisted rows are preserved, never deleted or repaired;
`assertNoAudioBytes` untouched.

---

## §3. Pre-change Baseline (audit-first)

Re-verified before editing; all green:

| Suite | Result |
|---|---|
| Full regression `npx vitest run --testTimeout 60000` | 75 files / 1312 tests / 0 failures |
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| PIN: STEP47 integrity suite (`src/step47Integrity.test.ts`, 22 tests) | pass |
| PIN: STEP44 hierarchy invariants (`src/classify/hier/hier.test.ts`) | pass |

---

## §4. Objective A — Audit Findings (persisted-validator coherence)

**Finding A1 — `isWellFormedHierClassification` ignores the family↔type pair.**
`src/classify/hier/types.ts:159-172` checked `classificationVersion`, `structure`, `family`,
`type` (non-empty string only), `ambiguous`, `confidence`. A persisted record with
`family:"drums", type:"bass"` (or `"unknown"` + any concrete type) passed structural validation.

**Finding A2 — the read-path validator ignores `hier` entirely.**
`isWellFormedIndexRecord` (`indexStore.ts:227-260`) validated every legacy field but never
touched `r.hier`. Since `put` enforces only the no-audio-bytes invariant, an incoherent `hier`
could be stored and would then be **readable** by `get`/`getAll` and flow into search/map/
similarity/publish projections — the exact corruption the read-path gate exists to exclude.

**Finding A3 — no test fixtures depend on leniency.**
Repository-wide grep showed no hand-crafted `hier` fixtures; every `hier` in tests is
pipeline-produced (coherent), so closing A1/A2 cannot reject legitimate records.

---

## §5. Objective B — Audit Findings (cross-family secondary leak)

`classifyHier` computes `typeSc` from the **original acoustic** family (`classify.ts:130-136`),
then metadata adoption may move the final family (TAG-SUPPORTED path, `classify.ts:151-164`).
`mapToSurface` (`classify.ts:97-111`) then iterated `typeSc.runners` **unfiltered**, so an
acoustic drum hit adopted as `bass` (musical) still produced drum secondaries on the musical
surface.

**Reproduction (measured, STEP47 fixture — acoustic drums, name "bassline 808", V2, 0.3s):**
`familyScores = { drums: 0.8, musical: 0.2, ... }`, `audioType = percussion`, `nameType = bass`,
status `TAG-SUPPORTED`.

| Surface | Pre-fix (projected from unfiltered runners) | Post-fix (observed) |
|---|---|---|
| `primaryClass` | `bass` | `bass` |
| `secondaryClasses` | `clap 0.28, percussion 0.175, tom 0.0831` (drums family) | `[]` |

Same-family control (name "snare break", acoustic drums): unchanged —
`clap 0.28, percussion 0.175, tom 0.0831` kept, all drums family.

---

## §6. Objective C — Audit Findings ("AI resolver" reference)

Traced the **"synths/leads & instrument pairs AI resolver (STEP46)"** claim from
`STEP47_REPORT.md:356`.

- `rg -in "resolver|ai-resolver|AI"` across the repo: the ONLY match for an AI resolver is
  `STEP47_REPORT.md:356` — my own STEP47 §18 sentence.
- `src/` match for `resolver`/`Resolver`: only unrelated UI preview-promise resolvers in
  `src/ui/previewLazyResolution.test.ts:86-104` (bootstrap caching, not classification).
- `STEP46_REPORT.md`: verdict **B**, single recommendation **1. KEEP** the classifier and its
  thresholds exactly as-is (7 strong / 6 moderate / 6 weak / 1 none supported boundaries; no
  feature gap; SoundCharacter adds no new information; only a sampling-with-documentation gap).
  There is no STEP46 requirement, spec, script, TODO, or implementation of an AI resolver.

**Outcome: REFERENCED ONLY.** STEP46 does not establish an AI-resolver requirement; nothing is
implemented and nothing should be. The STEP47 sentence is corrected by this report (§13).

---

## §7. Changes — Objective A (validator hardening, validate-never-normalize)

**`src/classify/hier/types.ts` — `isWellFormedHierClassification`:**
reuses the authoritative `familyOfType` (no ontology duplicated — `evidence.ts:86-96`):

```ts
if (h.type !== UNKNOWN_TYPE) {
  const typeFamily = familyOfType(h.type as ClassId);
  if (typeFamily === "unknown" || typeFamily !== h.family) return false;
}
return true;
```

- `type === "other"` remains the documented exception — valid with a concrete **or** unknown
  family (STEP47 §5/§6); **not** reinterpreted.
- Concrete type + mismatched family → invalid (drums+bass, musical+kick, vocal+snare, fx+piano,
  atmosphere-noise+synth).
- Concrete type + `unknown` family → invalid; off-ontology type strings → invalid (no fallback
  bucket).
- Pure predicate: returns a boolean, never mutates input (§6 edge case 6).

**`src/persistence/indexStore.ts` — read-path continuity:**
`isWellFormedIndexRecord` now requires a present `hier` to be well-formed:

```ts
const hier = r.hier as unknown;
if (hier !== undefined && !isWellFormedHierClassification(hier)) return false;
```

Behavior contract confirmed preserved: an incoherent persisted row → `get` returns `undefined`
(absent) → the pipeline's analyze/NotFound path re-analyzes; `getAll` excludes it from every
projection; the row is **preserved** (count unchanged), never repaired, never deleted; `assertNoAudioBytes`
untouched.

---

## §8. Changes — Objective B (surface filter)

**`src/classify/hier/classify.ts` — `mapToSurface`:** runners that no longer belong to the final
adopted family are skipped:

```ts
for (const c of typeSc.runners) {
  if (c === primaryClass) continue;
  if (familyOfType(c) !== hier.family) continue;
  ...
}
```

- Prefer the final adopted family/type context (`hier.family`), not the acoustic family.
- Never invents new candidates; never touches confidences; same-family output unchanged.
- Unknown family / `other` → runners empty anyway → no-op.

No classifier, threshold, feature, map, or reconciliation logic changed.

---

## §9. Persistence Read-Path Gate (§12 behavior, pinned)

New tests pin: valid row with coherent `hier` → readable; incoherent `hier` → `get` = `undefined`,
`getAll` = excluded, `count` unchanged (1) — the "treated as absent → re-analysis → self-heal"
contract, with rows preserved for a future inspection/repair path. Covered in
`src/step48Hardening.test.ts` §12 and by the pre-existing `indexStore.test.ts` corrupt-row tests.

---

## §10. Regression & Targeted Tests

New suite: **`src/step48Hardening.test.ts` (14 tests)** — validator valid/invalid lists built
from the authoritative `FAMILY_TYPES`/`familyOfType` (no duplicate ontology), §24 edge cases,
cross-family TAG-SUPPORTED adoption (tag and name variants), same-family adoption, persistence
gate, validate-never-mutate.

| Suite | Result |
|---|---|
| `npx vitest run --testTimeout 60000` (full) | **76 files / 1326 tests / 0 failures** (baseline 75/1312; +1 file, +14 tests) |
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| STEP48 hardening suite | 14/14 |
| STEP47 integrity suite (`step47Integrity.test.ts`) | pass |
| STEP44 hierarchy suite (`hier.test.ts`) | pass |
| Persistence (`indexStore.test.ts`) + pipeline (`analysisPipeline.test.ts`) | pass |

---

## §11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Validator change rejects legitimate records | No hand-crafted `hier` fixtures exist; every producer (classifyHier/type adoption/subtype) emits only ontology members → nothing can be newly rejected. Full regression green. |
| Surface filter changes same-family output | Filter matches `hier.family`, which equals the acoustic family in all non-adopted cases → no-op; §11 fixture proves drum secondaries preserved. |
| Read-path gate treats previously-readable corrupt rows as absent | That is the documented intended behavior (absent → re-analyze → self-heal); still verified preserved, never deleted. |
| Ontology duplicated in the validator | `familyOfType`/`FAMILY_TYPES` reused; new tests iterate the table rather than hard-coding member lists. |
| `family`/`type` coherence tightened for `unknown` | Explicit edge cases lock: unknown+other valid; unknown+concrete and off-ontology types invalid. |

---

## §12. Evidence & Files Changed

| File | Change |
|---|---|
| `src/classify/hier/types.ts` | `isWellFormedHierClassification` family/type coherence (reuses `familyOfType`); import. |
| `src/classify/hier/classify.ts` | `mapToSurface` filters runners to `familyOfType(c) === hier.family`. |
| `src/persistence/indexStore.ts` | `isWellFormedIndexRecord` gates a present `hier` on the hierarchy validator. |
| `src/step48Hardening.test.ts` | **new** — 14 tests (§6/§10/§11/§12). |

Adjusted: none of the STEP44/47 invariants, thresholds, taxonomy, features, coordinates,
eligibility, popularity, reconcile-precedence, or persistence format were changed.

---

## §13. Verdict & Single Recommendation

**VERDICT: A** — both STEP47 hardware findings were real integrity defects and are now closed with
minimal, additive hardening; Objective C resolves to **REFERENCED ONLY** and requires no work.

**Single recommendation: PROCEED.** The next step may pursue a justified product question (any
sincere accuracy gap already documented in STEP46), **not** an AI resolver. The "AI resolver"
reference in `STEP47_REPORT.md:356` is corrected here: **STEP46 establishes no AI-resolver
requirement**; banked effort should be directed at the documented STEP46 accuracy body of
knowledge rather than an artificial-intelligence feature that no spec requests.