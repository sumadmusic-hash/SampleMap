# STEP44.1 — Targeted One-Shot Reference Corpus & Calibration Report

Date: 2026-09-09 (reproducible — every number below regenerates from
`scripts/step44.1-build-corpus.ts → scripts/step44.1-audit.ts → scripts/step44.1-eval.ts`).

## 1. Scope, verdict, single recommendation

STEP44.1 builds a targeted, diverse, high-quality **one-shot** reference corpus
out of the real Audiotool catalogue (53,885 one-shots of 123,756 total rows) and
runs the **current** `AnalysisPipeline` (hier-v1) twice per sample — once
**acoustic-only**, once with **full metadata reconciliation** — to calibrate
hier-v1 and decide whether to proceed.

**Verdict: B — CALIBRATE hier-v1 AGAIN.** The family/structure layer is sound
(loops never collapse, structure never auto-kicks, fields stay coherent), but
the *within-family acoustic type* layer is the binding constraint on a one-shot
corpus: acoustic-only type agreement is **17.6%** (41/590 direct, unambiguous
correct hits) while full-reconciliation agreement reaches **88.3%**, driven by
`TAG_RESCUE` (476 rows). Concrete root-caused calibration candidates are in
§9. STEP45 should carry them; they are rule/weight changes inside the existing
hier-v1 engine, not a new architecture (C is not justified).

Non-negotiables honoured: no classifier rewrite, no ML/embeddings, no
tag-as-truth, no mass reclassification, no D1/SC/SoundSpace/FindSimilar
changes, no audio bytes persisted.

---

## 2. Reference corpus construction (§1–§7)

Input: `step42-metadata.ndjson` (123,756 live Audiotool rows). Selection is pure
local, deterministic, and reuses the **existing** hier-v1 parsers
(`TYPE_TERMS` / `parseTagEvidence` / `parseNameEvidence` / `normalizeTag` /
`subtypeToType`) — there is no second tag parser.

Reference derivation per one-shot row, from name + tag evidence only:

| Tier | Definition (proxy label, never ground truth) | Selected |
|------|----------------------------------------------|----------|
| A    | specific tag + matching name + `numUsages ≥ 5` (p50=2, p75=9) | 472 |
| B    | specific tag only | 107 |
| C    | specific name only | 11 |
| D    | mixed/conflicting specific evidence | **excluded** (4,899) |

Clean-label rule: the distinct specific types across name+tag evidence must be
exactly **one** ClassId. `hihat`/`openhat` sibling collisions (“Open Hat”
matches both the `hat` hihat phrase and the `open hat` openhat phrase) are
resolved via the existing drum subtype ontology (`subtypeToType`), the same
logic the classifier uses. Generic terms (drum/music/sample/loop/fx…) are
metadata evidence only and never select a class.

Selection: all 20 target classes **SATISFIED** (per-class counts in §4 table;
targets per §14, shortfall would have been reported as
`INSUFFICIENT_SOURCE_POPULATION`). All 180 previously-analyzed ids
(STEP42 + STEP44 corpora) excluded. Diversity is deterministic (tier → usage →
owner → naming-family quotas): **345 distinct owners** across 590 references,
39–50 distinct naming families per drum class.

Loop validation set: 40 loops (2–60 s), deterministic band-interleaved pick
across tag bands → drums 7 / musical 7 / vocal 7 / fx 7 / atmosphere-noise 6 /
generic 6; 40 distinct owners/families; STEP42/44 overlap excluded (95 rows
dropped).

## 3. Method — two evaluations per sample (§15)

Every corpus sample is analysed ONCE through the real pipeline (real audio),
then evaluated twice against the **same** features:

- **A acoustic-only**: `classifyHier({ features, meta:{ kind, duration,
  name:"", tags:[] }, v2 })` — name and tags stripped. Fields:
  `audioFamily/audioType/audioConfidence/audioAmbiguous/audioStructure`.
- **B full reconciliation**: the pipeline’s persisted `hier` tree (raw user
  name + tags + V2). Fields: `family/type/confidence/ambiguous/reconciliation`.

629/630 rows analysed (1 `DECODE_FAILED` individual sample; 0 content-hash
duplicates). Rows: 590 references + 39 loop validation (one loop decode-failed).

## 4. Headline metrics — acoustic-only vs full reconciliation

Primary calibration metric is **AUDIO_AGREEMENT** (acoustic-only type vs the
reference; the reference is a proxy label, so this measures the *acoustic layer
alone*). Full agreement is reported separately and NEVER as accuracy on truth.

| referenceClass | n | audioAgree | fullAgree | audioAmbig | medDur(s) |
|---|---|---|---|---|---|
| kick | 50 | 0.340 | 0.800 | 0.400 | 0.356 |
| snare | 50 | 0.000 | 0.880 | 0.880 | 0.400 |
| clap | 40 | 0.250 | 0.925 | 0.775 | 0.278 |
| hihat | 40 | 0.125 | 0.975 | 0.875 | 0.167 |
| openhat | 30 | 0.400 | 0.533 | 0.600 | 0.504 |
| tom | 30 | 0.167 | 0.833 | 0.767 | 0.632 |
| cymbal | 30 | 0.033 | 0.833 | 0.733 | 1.806 |
| percussion | 30 | 0.367 | 0.833 | 0.833 | 0.394 |
| bass | 30 | 0.500 | 0.900 | 0.800 | 1.987 |
| piano | 20 | 0.000 | 0.950 | 0.950 | 12.195 |
| guitar | 20 | 0.000 | 0.950 | 0.950 | 11.963 |
| strings | 20 | 0.000 | 1.000 | 0.950 | 12.588 |
| keys | 20 | 0.000 | 0.950 | 0.950 | 19.200 |
| synth | 30 | 0.433 | 0.933 | 0.933 | 3.770 |
| pad | 30 | 0.233 | 0.967 | 0.967 | 20.517 |
| lead | 30 | 0.233 | 0.933 | 0.933 | 6.424 |
| vocal | 30 | 0.000 | 0.967 | 0.867 | 4.999 |
| fx | 30 | 0.033 | 0.867 | 0.800 | 3.494 |
| noise | 15 | 0.000 | 0.733 | 0.733 | 5.814 |
| atmosphere | 15 | 0.000 | 1.000 | 0.933 | 26.399 |
| **ALL** | **590** | **0.176** | **0.883** | 0.817 | 1.204 |

- Acoustic **family** agreement against the reference’s family: **72.7%**
  (full: 96.8%). The family layer is comparatively healthy; the gap to 17.6%
  type agreement is inside-family *type* discrimination.
- Only **41/590 (6.9%)** were direct acoustic hits that were correct AND
  unambiguous; 549/590 needed some form of assistance.
- Tier effect on full agreement: A 88.8% (472), B 90.7% (107), C 45.5% (11 —
  all openhat, name-only; see §9.3).

## 5. TAG_RESCUE and TAG_AUDIO_CONFLICT (measured separately, NOT accuracy)

**TAG_RESCUE = 476** of 590 — rows where the acoustic-only result was wrong or
ambiguous AND the full run reached the reference via the specific tag
(`(audioType≠ref OR ambiguous) AND fullType==ref AND full.tagType==ref`); 457 of
them are `TAG-SUPPORTED`, 19 `AGREE`. This is the metadata lift: for one-shot
types, hier-v1 leans on user tags heavily, and its confidence stays low while
doing so (mean 0.263). It is the honest, §26-compliant mechanism — but its
scale is the reason this is a calibration step, not a proceed.

**TAG_AUDIO_CONFLICT = 71** — rows where the metadata reference exists but the
audio is **strong** and disagrees; these are candidate manual-review rows and,
when audio wins, they are recorded as `CONFLICT` (audio/tag never auto-declared
winner). Examples: `Industrial Kick` (ref kick, audio clap → full clap
CONFLICT, tags `kick,distortion,industrial`), `No Dribble kick - [Astro]` (ref
kick, audio tom → tom CONFLICT), `rawstyle kick` (audio vocal → openhat
CONFLICT), all 6 of the `snare→clap` hard snares, `DEATH HAT 2` (hat→openhat),
`skypierr ~ open hat 6` (openhat→lead).

## 6. Drum confusion (acoustic-only, reference → misread)

| ref \→ audio | kick | snare | clap | hihat | openhat | tom | cymbal | perc |
|---|---|---|---|---|---|---|---|---|
| kick (row n=50) | 17 | 1 | 1 | 0 | 0 | 6 | 0 | 5 |
| snare (n=50) | 0 | 0 | 13 | 7 | 3 | 0 | 3 | 23 |
| clap (n=40) | 0 | 1 | 10 | 1 | 2 | 1 | 0 | 23 |
| hihat (n=40) | 0 | 0 | 3 | 5 | 2 | 0 | 3 | 24 |
| openhat (n=30) | 0 | 0 | 3 | 9 | 12 | 0 | 0 | 3 |
| tom (n=30) | 0 | 7 | 4 | 0 | 1 | 5 | 0 | 5 |
| cymbal (n=30) | 0 | 0 | 4 | 2 | 8 | 0 | 1 | 2 |
| percussion (n=30) | 0 | 2 | 7 | 2 | 0 | 3 | 1 | 11 |

*(Columns are the 8 drum classes only; a reference row’s column sum can be below
its row n because hits outside the drum band are omitted.)*

Spec-called pairs: kick↔hihat **0/0**, kick→snare 1, hihat→kick 0, openhat→hihat
**9**, clap→snare 1, cymbal→openhat **8**. The dominating failure is *everything
collapses toward `percussion`* (a fixed residue score of 0.25 beats many real
types once their band penalties apply) plus the clap/noise family confusion.

## 7. Ultra-short one-shots (verify duration NEVER auto-kicks; SC9)

| bin | n | audioAgree | kickP | kickR | amb | structure≠loop |
|---|---|---|---|---|---|---|
| ≤ 0.35 s | 139 | 0.201 | 1.00 | 0.52 | 0.806 | **139/139** |
| 0.35–0.5 s | 58 | 0.190 | 1.00 | 0.10 | 0.672 | **58/58** |

Duration never auto-kicks structure on this corpus (0 loop labels under 0.5 s).
Kick precision is 1.00 in both bins (no false kicks) but recall drops from 0.52
(≤0.35) to 0.10 (0.35–0.5): medium-thump kicks stop reading as kick. Per-class
accuracy for every class is in `step44.1-summary.json` (`perClassAccuracy`).

## 8. Long one-shots (>2.5 s / >4 s) and loops (SC10/SC11)

Long one-shots never become loops (`structure=loop` count **0** in both bins)
and type classification remains possible, but acoustic-only agreement is low
and mostly ambiguous:

| bin | n | audioAgree | amb | structure=loop |
|---|---|---|---|---|
| >2.5 s | 235 | 0.136 | 0.923 | 0 |
| >4 s | 190 | 0.147 | 0.926 | 0 |

Loop validation set (39 rows): `structure=loop` on **39/39** for BOTH
evaluations; family/type **never erased** (family≠unknown and type≠other on all
39). Family distribution musical 17 / vocal 6 / fx 7 / atmosphere-noise 4 /
drums 5 — the loop set is diverse and stays in SampleMap untouched.

## 9. Defects → root cause → candidate rule (each with measured basis)

### 9.1 FIXED this step — family/type coherence (measured)
**Pattern:** 35/180 STEP44 rows (19.4%) and the STEP44.1 smoke rows had
`hier.family` contradicting the decided type (e.g. `type=vocal`,
`family=musical`) on `TAG-SUPPORTED`. **Root cause:** `classify.ts` promoted
the metadata family only when the acoustic family was `unknown`. **Candidate
rule:** always set `family = familyOfType(decided type)` on tag/name adoption
(acoustic picture stays in `evidence.audio.familyScores`). **Measured
improvement:** type/confidence logic is identical by construction; STEP44.1
full run on the fixed code → **coherence 629/629 (100%)**, conflict/ambiguity
distributions unchanged (TAG-SUPPORTED 464, CONFLICT 59, UNKNOWN 6, AGREE 60);
full suite 1283/1283 green; STEP44 180-row re-audit family distribution shows
the 30 shifted rows now in their type’s family (musical 140→110, vocal 1→23).

### 9.2 RESIDUE BEATS REAL TYPES (drums) — candidate rule for STEP45
**Pattern:** snare 0/50, hihat 5/40, and 78/300 drum rows land on `percussion`.
**Root cause:** `drumScore("percussion")` returns fixed **0.25**; real bright
types are multiplied down (snare `brightB ×0.3` caps at 0.225 < 0.25; hihat
`!brightB ×0.4` similar). **Candidate rule:** make the residue evidence-aware
(floor only when no specific evidence fired, or raise the specific terms’
weight so a substantiated specific type beats the empty bucket).

### 9.3 OPENHAT/CYMBAL/NAME-ONLY TAG — candidate rule for STEP45
**Pattern:** openhat→hihat 9, cymbal→openhat 8; openhat full agreement only
53.3% (worst), Tier C (name-only) 45.5%. **Root cause:** `openhat` decays ≤1.2 s
and `cymbal` needs >1.2 s; short crashes/rides land in openhat; and the hat
name/tag phrase collision (see §2) makes many openhat rows ambiguous at the
evidence level. **Candidate rule:** add decay-length + crest discrimination
between openhat and cymbal, and treat hat/openhat name evidence as
hat-subtype evidence (already exists in the ontology) during reconciliation.

### 9.4 MUSICAL INSTRUMENT DISCRIMINATION — candidate rule for STEP45
**Pattern:** piano/guitar/strings/keys acoustic-only **0/20 each** — every
sustained pitched one-shot reads `lead`/`synth`. **Root cause:** `musicalScore`
uses duration/centroid/tonality/transient; no instrument-timbre discriminator
exists for these classes. **Candidate rule:** prefer honest
`instrument-family ambiguous` acoustic output (keep `TAG-SUPPORTED` lift),
and/or add the melodic-homogeneity cue already computed in V2 as a weak term;
accept lower acoustic agreement here by design rather than pretending.

### 9.5 CONFIDENCE — measured, no threshold change here
Full-layer confidence: correct mean 0.318 vs incorrect 0.238
(min 0.155, max 0.591); **highOnIncorrect = 0** (no confident-but-wrong full
decision). 12 full-correct rows sit below 0.20 (low-but-correct — conservative,
acceptable per §11). No threshold tuning was performed: the observed patterns
have root causes (§9.2–9.4), and §25 forbids tuning on raw error rate.

## 10. Confidence & reconciliation distributions

| context | n | audio mean | full mean | min | max |
|---|---|---|---|---|---|
| audio correct | 104 | 0.289 | — | 0.157 | 0.462 |
| audio incorrect | 486 | 0.260 | — | 0.100 | 0.467 |
| full correct | 521 | — | 0.318 | 0.158 | 0.591 |
| full incorrect | 69 | — | 0.238 | 0.155 | 0.457 |
| reconciliation AGREE | 60 | 0.280 | 0.368 | 0.157 | 0.591 |
| reconciliation TAG-SUPPORTED | 464 | 0.263 | 0.312 | 0.100 | 0.534 |
| reconciliation CONFLICT | 59 | 0.266 | 0.223 | 0.155 | 0.467 |
| reconciliation UNKNOWN | 6 | 0.241 | 0.266 | 0.157 | 0.313 |
| reconciliation AUDIO-SUPPORTED | 1 | 0.392 | 0.414 | 0.392 | 0.414 |

AUDIO-SUPPORTED at the full layer is rare (1 row) because the corpus is
metadata-dense; AGREE rows are the only “high-confidence” population and only
reach ~0.37. This is the deliberate §11 decision-confidence posture.

## 11. STEP44 comparison (refresh after the coherence fix)

The STEP44 180-row audit was re-run on the fixed code
(`step44.1-step44rerun`): loop collapse 63%→0, loop-structure ok 105/105,
ultra-short kick 13/24→6/24, one-shot→loop 33%→0, voc-tag→vocal 18/20,
reconciliation TAG-SUPPORTED 84 / UNKNOWN 73 / AUDIO-SUPPORTED 12 / CONFLICT 8
/ AGREE 3 — unchanged by the fix as designed; only the family distribution
moved (musical 140→110, vocal 1→23, +atmos/fx/drums) because the 30 shifted
rows now carry their type’s family. STEP44.1 extends that audit from 180 rows
(weighted to loops/musical) to 629 rows (weighted to one-shots).

## 12. Recommendation and SC compliance

**Recommendation: B — CALIBRATE hier-v1 AGAIN (STEP45 agenda in §9.2–9.4).**
Do not proceed on the current within-family type weights for one-shot corpora;
nothing here justifies architecture revision (C) or stopping structure work (A
premature).

| Success criterion | Status |
|---|---|
| SC1 corpus predominantly one-shot | ✓ 590/629 reference rows (93.8%) |
| SC2 loops don’t dominate type calibration | ✓ loops isolated in a 39-row validation set |
| SC3 substantially new vs STEP42/44 | ✓ all 180 previous ids excluded; corpus designed per-class |
| SC4 multiple independent samples/class | ✓ ≥15 per class (targets hit except noted), 345 owners |
| SC5 diverse/high-quality | ✓ owner+fam quotas, Tier A/B only except openhat C |
| SC6 acoustic-only measured separately | ✓ 17.6% vs full 88.3% (distinct numbers) |
| SC7 tags as evidence not hidden truth | ✓ rescue/conflict reported separately; tags verbatim |
| SC8 rescue/conflict measured separately | ✓ 476 rescue / 71 conflict |
| SC9 ultra-short measured independently | ✓ two bins, kickP/R, never auto-kick |
| SC10 long one-shot measured independently | ✓ >2.5/>4 bins, structure never loop |
| SC11 loops separate validation | ✓ 39-row loop set, structure 39/39, no erasure |
| SC12 no audio bytes persisted | ✓ feature/V2 numbers + hashes only |
| SC13 no SC/FindSimilar/SoundSpace/D1/STEP40-41 codec changes | ✓ |
| SC14 no mass reclassification | ✓ hier additive; legacy rows untouched |
| SC15 reproducible exact numbers | ✓ deterministic scripts; artifacts listed below |

Artifacts: `step44.1-reference-corpus.ndjson` (630), `step44.1-analysis.ndjson`
(629), `step44.1-summary.json`, `step44.1-full.log`, `step44.1-corpus-selection.json`,
`step44.1-audit-summary.json`, `step44.1-step44rerun/step44-analysis.ndjson` (180)
in `/var/folders/…/opencode/step44.1{,-step44rerun}`; builder/audit/eval in
`scripts/step44.1-{build-corpus,audit,eval}.ts`.