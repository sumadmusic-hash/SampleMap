# STEP96 — Loop-safe hierarchical classification: a loop never claims a one-shot drum type

**Date:** 2026-10-08 · **Baseline commit:** `6895fda` (STEP95) · **Type:** behaviour
change in the hierarchical classifier + tests. No schema, pipeline, persistence,
map, UI or worker change.

**Verdict:** implemented · verified (`tsc` clean, `vite build` ok, **90 files /
1598 tests** app + **23 tests** worker green).

> This step resolves a work-in-progress edit that was left uncommitted in the
> working tree after STEP95. The uncommitted version neutralised the type of
> **every** loop; this report records the narrower, scoped rule that was actually
> shipped, and why.

---

## 1. The defect

Stage 2 of `hier-v1` scores a **family-conditional** type from acoustic features.
For a loop that is fed through that race unchanged, the winner is the type of the
**loudest / most characteristic single hit** — so a drum loop surfaces as `kick`,
`snare`, `clap`, `hihat`, `openhat`, `tom`, `cymbal` or `percussion`. That is a
category error: those eight `ClassId`s are members of `FAMILY_TYPES.drums`
(`src/classify/hier/types.ts:41`) and denote **one-shot hits**, while a loop is
multi-hit sequence material. The surface then advertises a one-shot class for a
sequence, and `searchEngine`/class filters inherit the mislabel.

---

## 2. The decision: scope the rule to the drums family

A loop must not claim a **one-shot drum type**. It does not follow that a loop may
not claim *any* type:

* `musical`, `vocal`, `fx` and `atmosphere-noise` loop types are
  decision-bearing and useful. STEP44 §4 documents exactly this: `OTHER LOOP`, a
  14 s sample tagged `rap`, resolves to `structure: "loop"`, `family: musical`,
  `type: "vocal"` (`STEP44_HIERARCHICAL_CLASSIFICATION_REPORT.md:124`).
* Neutralising every loop would push the majority of the catalogue into the
  single surface class `other`: the STEP43 real enumeration measured **123,756**
  catalogue rows of which **69,871 (56.5 %) are loops**
  (`STEP43_HIERARCHICAL_CLASSIFICATION_REPORT.md:19`). That is a large
  information loss for a defect that only concerns one-shot drum hits.

**Shipped rule:** when the acoustic winner of a loop is a `drums`-family type, the
type is neutralised to `UNKNOWN_TYPE` (`"other"`) — the family decision is
untouched. All other families are unchanged.

**Trigger:** `familyOfType(rawTypeSc.type) === "drums"`. Because
`FAMILY_TYPES.drums` contains exactly the eight one-shot drum types, "is a drums
type" and "is a one-shot drum type" coincide; `percussion` is included (it denotes
a one-shot fallback, not a sequence).

---

## 3. Exact implementation changes

### `src/classify/hier/classify.ts`

| Change | Detail |
|---|---|
| Stage 2 result kept for reconciliation | `classifyType(...)` is evaluated into `rawTypeSc` and its result stays the source of the reconciled `audioType`/`audioStrong`. (The abandoned WIP edit had skipped Stage 2 entirely for loops; the baseline `6895fda` had no loop rule at all.) |
| Loop neutralisation | `drumOneShotTypeOnLoop = structure === "loop" && familyOfType(rawTypeSc.type) === "drums"`. When true, the scoring view becomes `{ scores: {}, type: UNKNOWN_TYPE, marginRatio: 0, runners: [], ambiguous: true }` — the exact `TypeScoring` shape the unknown-family guard uses (`type.ts:223-225`). No scores, no runners, no margin, and `ambiguous` set so the record does not claim a confident type. |
| Reconciliation sees the REAL type | `audioType = rawTypeSc.type` and `audioStrong = familySc.family !== "unknown" && !rawTypeSc.ambiguous` are taken from `rawTypeSc`, **not** from the neutralised view. Rationale: suppressing a type must not demote the acoustic evidence, otherwise a tag could flip the family of a decisively-drum loop, violating §24 ("strong audio wins"). |
| Final guard | After metadata adoption: `if (structure === "loop" && familyOfType(type) === "drums") type = UNKNOWN_TYPE;` — a tag or name may fix the **family**, but never turns a loop back into a one-shot drum hit. |

`familyOfType` was already imported; no new import, no new module, no signature
change. The public shape of `HierClassification`/`HierResult` is unchanged and
`isWellFormedHierClassification` still accepts the result (`"other"` is the
documented exception that is valid with any family, `types.ts:178-181`).

### `src/classify/hier/hier.test.ts`

Four new tests (6d–6g) plus two loop fixtures. 6b/6c (the pre-existing
in-progress tests) are unchanged and still pass.

---

## 4. Verified behaviour (fixture-level evidence)

Produced by running the real `classifyHier` over purpose-built fixtures (the same
input shapes the test suite uses) while this step was developed:

| Case | structure | family | type | surface | ambiguous | reconciliation |
|---|---|---|---|---|---|---|
| drum loop, no metadata | loop | drums | **other** | other | true | AUDIO-SUPPORTED, `audioType=kick` |
| drum loop, tag `kick` (matches) | loop | drums | **other** | other | true | **AGREE** |
| drum loop, tag `bass` (contradicts) | loop | drums | **other** | other | true | **CONFLICT**, audio wins, family stays drums, `audioType=kick` |
| ambiguous drum loop, tag `snare` | loop | drums | **other** | other | true | TAG-SUPPORTED, `tagType=snare` |
| **musical loop** (sub bass) | loop | musical | **bass** | bass | true | type preserved |
| **vocal loop** (singing hook) | loop | vocal | **vocal** | vocal | false | type preserved |
| control: one-shot kick | one-shot | drums | kick | kick | false | unchanged |
| control: one-shot sub bass | one-shot | musical | bass | bass | false | unchanged |

Consequences, stated honestly:

* A neutralised drum loop no longer publishes drum **secondaries** either
  (`runners: []`), so the surface makes no one-shot claim at all.
* A neutralised drum loop carries a **lower confidence** (`marginRatio: 0`),
  e.g. 0.21 (AUDIO-SUPPORTED) / 0.23 (AGREE) / 0.15 (CONFLICT) on the fixtures
  above. That is deliberate: no type was decided, so the decision should not look
  as confident as a one-shot kick (0.32).
* Matching metadata still reads `AGREE` and contradicting metadata still reads
  `CONFLICT`; only the final type is neutral. The real acoustic type stays
  observable in `reconciliation.audioType`.

---

## 5. Verification

| Check | Command | Result |
|---|---|---|
| Hier classifier suite | `npx vitest run src/classify/hier/hier.test.ts` | **67/67 pass** (was 63; +4) |
| Full app suite | `npx vitest run` | **90 files / 1598 tests pass** (was 1594) |
| Typecheck + build | `npm run build` | clean (`tsc --noEmit`) · vite build ok |
| Worker suite (unaffected) | `cd workers/d1-worker && npm test` | **23/23 pass** |

Pre-existing build note, unchanged by this step: the main bundle is ~911 kB and
Vite warns above 500 kB.

---

## 6. Not changed / non-goals

* No change to `family.ts`, `type.ts`, `structure.ts`, `reconcile.ts`,
  `evidence.ts`, the taxonomy, the flat `heuristic-v1` classifier, the pipeline,
  persistence, the map, the UI or the D1 worker.
* No migration and no version bump: `hier-v1` records already written are not
  rewritten (STEP44 SC12 additivity preserved). Existing rows keep whatever type
  they had; the rule applies to future analysis passes.
* The `loop` ClassId remains unreachable from the hier surface — loop browsing
  stays on `kind`, as STEP44 §6 decided.

---

## 7. Open gap

This step was verified on fixtures, **not** re-measured on the real 2 474-record
browser corpus used by STEP87: those artifacts
(`/var/folders/.../T/opencode/step87/`) no longer exist and no Chrome profile copy
is present, so reconstructing the corpus was out of proportion for this scoped
change. The scoping argument therefore rests on the documented catalogue
composition (§2) plus the fixture evidence (§4). A real-corpus re-measurement of
the drum-loop share and of the confidence shift remains the honest next
validation step.

---

## 8. Traceability

* Sources: `src/classify/hier/classify.ts` (`classifyHier`), `src/classify/hier/types.ts`
  (`FAMILY_TYPES`, `UNKNOWN_TYPE`, `isWellFormedHierClassification`),
  `src/classify/hier/type.ts:223-225` (the mirrored guard), `src/classify/hier/evidence.ts`
  (`familyOfType`), `src/classify/hier/reconcile.ts` (§23–§26 semantics).
* Tests: `src/classify/hier/hier.test.ts` tests 6b–6g (67 total in the file).
* Prior art: `STEP44_HIERARCHICAL_CLASSIFICATION_REPORT.md` (§4 loop example,
  §6 non-goals, SC1/SC2/SC11/SC12), `STEP43_HIERARCHICAL_CLASSIFICATION_REPORT.md`
  (catalogue composition and the `loop`-dominance defect), `STEP95` (the drum-scale
  re-anchoring immediately preceding this step).
* Non-negotiable bounds honoured: no ML/embeddings, no audio bytes in records, no
  external services, no D1 schema change, no change to STEP37/39/40 outputs.
