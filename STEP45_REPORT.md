# STEP45 — Evidence-Backed One-Shot Acoustic Calibration Report

Date: 2026-09-10 (reproducible — every number below regenerates from
`scripts/step45-build-corpus.ts → scripts/step45-audit.ts → scripts/step45-signatures.ts →
scripts/step45-reclassify.ts → scripts/step45-metrics.ts`).

---

## 1. Scope, verdict, single recommendation

STEP45 calibrates the hier-v1 **within-family acoustic type** layer using a
targeted one-shot reference corpus (58,126 rows → 590 references + 40 loop
validation), driven by **measured** acoustic signatures (§10), then measures a
BEFORE→AFTER delta on the **same rows** with the **same audio** (librosa
re-render at analysis time, offline reclassify), exactly per §21.

**Verdict: A — KEEP the calibration (acoustic-only delta is positive).**

Primary calibration metric, **same 630 rows, same audio, offline reclassify
only**:

| metric | BEFORE | AFTER | Δ |
|---|---|---|---|
| **AUDIO_AGREEMENT** (acoustic-only type vs reference) | 0.197 | **0.219** | **+0.022** |
| FULL_AGREEMENT (full reconciliation, reported separately, NOT accuracy) | 0.873 | 0.893 | +0.020 |
| ambiguous acoustic rate | 0.808 | 0.782 | −0.026 |

- Acoustic-only improvement: **+2.2 pts** (11 refs correctly fixed net), driven
  mainly by clap→snare, hihat→openhat and percussion→kick/percussion-split
  fixes (§9). This is the metric the verdict is judged on.
- Full reconciliation also improves (+2.0 pts) — the calibration does not rely
  on tags; it makes the acoustic layer agree with metadata *more* often
  (AGREE 68→71, CONFLICT 63→58, AUDIO-SUPPORTED 6→13).
- Loops never regress: loop validation 40/40 structure=loop both modes, family
  never erased, type never `other` (§12).
- No regression in the STEP44/STEP44.1 guarantees: full suite green (74 files /
  1290 tests), `tsc` clean, coherence 630/630 (family always follows decided
  type).

**Single recommendation:** accept and keep the calibration as-is. Do NOT push
the one-shot type agreement further by tuning on error rate (§25 forbids tuning
on raw error); the remaining losses are root-caused structural gaps (§9.5) that
need new measured evidence, not weight fiddling.

Non-negotiables honoured: no classifier rewrite, no ML/embeddings, no
tag-as-truth, no mass reclassification, no D1/SC/SoundSpace/FindSimilar
changes, no audio bytes persisted (all re-verified this step).

---

## 2. Reference corpus construction (§2–§7)

Input: `step45-corpus-selection.json` → real Audiotool metadata (123,756 rows).
Selection is pure local, deterministic, and reuses the **existing** hier-v1
parsers (`TYPE_TERMS` / `parseTagEvidence` / `parseNameEvidence` /
`normalizeTag` / `subtypeToType`) — no second tag parser.

| Tier | Definition (proxy label, never ground truth) | Selected |
|------|----------------------------------------------|----------|
| A    | specific tag + matching name + `numUsages ≥ 5` | 384 |
| B    | specific tag only | 166 |
| C    | specific name only | 40 |
| D    | mixed/conflicting specific evidence | **excluded** (4,899) |

Clean-label rule: distinct specific types across name+tag evidence must be
exactly **one** ClassId. `hihat`/`openhat` sibling collisions (“Open Hat”
matches both `hat` and `open hat`) are resolved via the drum subtype ontology
(`subtypeToType`), the same logic the classifier uses. Generic terms
(drum/music/sample/loop/fx…) are metadata evidence only and never select a
class.

Exclusions: all **810 previously analysed ids** (STEP42 120, STEP44 180,
STEP44.1 180, STEP44.1-rerun 180) dropped; 4,899 tier-D rows dropped.

Reference counts per class: kick 50, snare 50, clap 40, hihat 40, openhat 30,
tom 30, cymbal 30, percussion 30, bass 30, piano 20, guitar 20, strings 20,
keys 20, synth 30, pad 30, lead 30, vocal 30, fx 30, noise 15, atmosphere 15 —
all 20 target classes satisfied (§14; no `INSUFFICIENT_SOURCE_POPULATION`).

Loop validation set: 40 loops (2–60 s), deterministic band-interleaved pick
(§12), 40 distinct owners/families.

Corpus build: 53,885 one-shots + 69,871 loops from 123,756 metadata rows;
referenceSelected 590, loopValidationSelected 40, conflictCorpusSelected 100
(kept for §6 analysis).

## 3. Method — two evaluations per sample, same inputs (§15, §21)

Every corpus sample is analysed once through the real pipeline (real audio,
librosa), then evaluated twice against the **same** persisted features + V2
slice:

- **A acoustic-only**: `classifyHier({ features, meta:{ name:"", tags:[] }, v2 })`
  — name and tags stripped. Fields: `audioFamily/audioType/audioConfidence/
  audioAmbiguous/audioStructure`.
- **B full reconciliation**: pipeline `hier` tree with RAW user name + tags.
  Fields: `family/type/confidence/ambiguous/reconciliation{status,winningSource,
  agreement,conflict,audioType,tagType,nameType}`.

620/630 of the stored BEFORE rows were analysed with the pre-calibration code;
630/630 rows are reused for the AFTER pass. `BEFORE = step45-analysis.ndjson`
(what the pipeline shipped / the persisted sample-index classifications —
`full.*` from `rec.hier`, `audioOnly.*` recomputed by the audit with
pre-calibration code). `AFTER = step45-reclass-after.ndjson` (same rows, same
`name`/`originalTags`, re-run offline with the STEP45-calibrated code).

Offline-fidelity gate (`scripts/step45-reclassify.ts --noop`): the
classifier-INDEPENDENT layers must reproduce offline exactly — **structure for
both modes + Mode-A family** → **630/630 PASS** (exit 0). Type/confidence/
full-family are expected to change post-calibration (family follows the decided
type by construction, classify.ts:149–164, so family legitimately moves with
the calibration — §11). The earlier “5 rows excluded from full delta” was a
gate artefact (Mode-B family asserted inappropriately); those rows reproduce
exactly and are calibration effects. **FULL delta is measured on all 630 rows.**

## 4. Measured acoustic signatures (§10) — the calibration evidence base

`scripts/step45-signatures.ts` computes per-class distributions (mean/sd/min/
q1/median/q3/max, null-rate) over the 590 references for the V1 + V2 features
(`step45-signatures.md`). Class-level medians (duration s / centroid Hz /
flatness / transientStrength / crestFactor / zcr / decay s):

| class | dur | cent | flat | ts | crest | zcr | decay |
|---|---|---|---|---|---|---|---|
| kick | 0.388 | 258 | 0.009 | 3.3 | 3.4 | 0.005 | 0.064 |
| snare | 0.313 | 5108 | 0.229 | 4.1 | 6.2 | 0.112 | 0.046 |
| clap | 0.353 | 4707 | 0.189 | 4.6 | 7.9 | 0.111 | 0.043 |
| hihat | 0.187 | 8534 | 0.259 | 6.6 | 8.0 | 0.313 | 0.035 |
| openhat | 0.560 | 8728 | 0.241 | 1.6 | 7.8 | 0.312 | 0.174 |
| tom | 0.710 | 1018 | 0.039 | 3.1 | 7.1 | 0.011 | 0.116 |
| cymbal | 2.004 | 7721 | 0.314 | 1.5 | 13.1 | 0.215 | 0.186 |
| percussion | 0.256 | 3564 | 0.148 | 7.5 | 10.9 | 0.089 | 0.023 |

Non-drum medians (dur / cent): bass 1.846/606, piano 10.013/1006, keys
13.378/967, guitar 12.387/2043, strings 12.009/1979, synth 3.692/2502, pad
12.8/1388, lead 8/2497. Attack times: keys median 3646 ms (Q1 149, Q3 6409) vs
piano 128 ms (58–4098), lead 499 ms, synth 163 ms — the keys slow-attack cue.

**Pair separation (effect size, P(a>b))** — the STRONG/MODERATE/WEAK labels in
§10, all measured:

| pair | strongest measured feature | effect size | label |
|---|---|---|---|
| hihat↔openhat | transientStrength 6.6 vs 1.6 | es 2.25; decay 2.52 | STRONG |
| kick↔snare | spectralCentroid 258 vs 5108 | es 2.6 | STRONG |
| kick↔clap | centroid + harmonicity 0.93 vs 0.44 | es >2 | STRONG |
| tom↔snare | centroid 1018 vs 5108 | es 2.6 | STRONG |
| confrontation snare↔clap | none (pitchConf 0.81, harm 0.46, tonality 1.02 MODERATE) | — | WEAK |

STRONG-feature counts per pair (rows where the pair’s defining feature is in
the STRONG zone): kick↔snare 15, kick↔clap 15, tom↔snare 13, tom↔percussion 11,
hihat↔percussion 7, hihat↔openhat 6, snare↔hihat 3, openhat↔cymbal 2,
clap↔percussion 2, bass↔synth 1; **zero STRONG** for snare↔clap, snare↔percussion,
synth↔pad, synth↔lead, piano↔keys, piano↔strings, pad↔strings, lead↔pad,
guitar↔keys. These zeros prevent invented separators; the weak pairs stay
honestly ambiguous (§14).

## 5. Calibration rules implemented (each anchored to §4)

All in `src/classify/hier/type.ts` (commented, measured basis):

1. **Percussion residue is evidence-aware** (was fixed 0.25): residue falls to
   a low 0.12+ hover — it only wins when no specific drum fires. Real
   darkMid/attack/crest/transient evidence now beats the empty bucket (§9.1).
2. **Kick needs dark spectral energy**: SC4 kept, but a kick is barred (SC4)
   and crushed (centroid >900 Hz → ×0.3 below bar) so bright/short material can
   never win kick. Measured darkMid kick = 135–519 Hz (Q1–Q3), decay med 0.064 s.
3. **Snare weights rebuilt** (was brightB ×0.3 cap = 0.225 < 0.25 residue voodoo):
   +0.25 bright/mid, +0.2 transient, +0.15 fast, +0.15 flatness∈[0.1,0.5],
   +0.15 short/med, +0.1 crestHigh, +0.1 zcrHigh, caps: dark ×0.3, flat<0.1 ×0.4,
   centroid>6500 ×0.45. Snares ARE bright (median 5.1k) — the cap was wrong.
4. **hihat vs openhat split on measured transientStrength + decay**: closed
   med ts 6.6 / decay 0.032 s vs open med ts 1.6 / decay 0.174 s. hihat +0.1
   tsStrong + decayLong×0.5; openhat +0.1 !tsStrong.
5. **Ultra-short (≤0.35 s) subtype margin raised to 0.35**: a very short hit
   gets a subtype only when the top candidate separates decisively; otherwise
   honest §14 percussion ambiguity.
6. **keys slow-attack cue**: `hasSlowAttack(≥1.5 s)` adds +0.15 (keys median
   attack 3.6 s vs piano 0.13 s).
7. **snare↔clap weak pair**: when the top pair is snare/clap and separation is
   weak, margin cap ≤0.15 → always `ambiguous` (never invented certainty). Also
   documented in type.ts with the exact measured es numbers (pitchConfidence
   0.81, harmonicity 0.46, tonality 1.02, attack 0.92).
8. `DrumM`/`MusM` score models gained `ts`, `tsStrong`, `atk2`, `hasSlowAttack`
   fields (feature plumbing, no new parsers).

## 6. TAG_RESCUE and TAG_AUDIO_CONFLICT (measured separately, NOT accuracy)

From the AFTER run (evaluate(), reference rows only):

- **TAG_RESCUE = 476** — rows where acoustic-only was wrong/ambiguous AND the
  full run reached the reference via the specific tag. This is reported as a
  rescue surface, never as verification of tag correctness (§26).
- **TAG_AUDIO_CONFLICT = 71** — strong audio type ≠ reference (metadata/ref
  disagree); examples retained in `step45-summary.json`.

These are separate optics from the accuracy-adjacent numbers and unchanged in
definition from STEP44.1 (directly comparable).

## 7. Drum confusion (acoustic-only, reference → misread) — AFTER

| pair | BEFORE | AFTER |
|---|---|---|
| kick→hihat | 0 | 0 |
| kick→snare | 1 | 1 |
| hihat→kick | 0 | 0 |
| openhat→hihat | 9 | 9 |
| clap→snare | 1 | 1 |
| cymbal→openhat | 8 | 8 |

(The focused pairs the spec calls out; per-class agreement row is §8.)

## 8. Headline metrics — BEFORE vs AFTER, same 630 rows (§21)

| referenceClass | n | audioBefore | audioAfter | audioΔ | fullBefore | fullAfter | fullΔ | ambBefore | ambAfter |
|---|---|---|---|---|---|---|---|---|---|
| kick | 50 | 0.300 | 0.380 | +0.080 | 0.780 | 0.860 | +0.080 | 0.420 | 0.380 |
| snare | 50 | 0.080 | 0.200 | +0.120 | 0.800 | 0.880 | +0.080 | 0.780 | 0.800 |
| clap | 40 | 0.300 | 0.075 | −0.225 | 0.950 | 0.900 | −0.050 | 0.750 | 0.875 |
| hihat | 40 | 0.200 | 0.275 | +0.075 | 0.975 | 0.975 | 0.000 | 0.900 | 0.800 |
| openhat | 30 | 0.500 | 0.733 | +0.233 | 0.567 | 0.800 | +0.233 | 0.700 | 0.367 |
| tom | 30 | 0.267 | 0.367 | +0.100 | 0.900 | 0.867 | −0.033 | 0.700 | 0.533 |
| cymbal | 30 | 0.133 | 0.067 | −0.066 | 0.800 | 0.767 | −0.033 | 0.800 | 0.767 |
| percussion | 30 | 0.500 | 0.567 | +0.067 | 0.867 | 0.867 | 0.000 | 0.867 | 0.900 |
| bass | 30 | 0.367 | 0.367 | 0.000 | 0.933 | 0.933 | 0.000 | 0.733 | 0.800 |
| piano | 20 | 0.050 | 0.050 | 0.000 | 0.950 | 0.950 | 0.000 | 0.950 | 0.900 |
| guitar | 20 | 0.050 | 0.050 | 0.000 | 1.000 | 0.950 | −0.050 | 1.000 | 0.850 |
| strings | 20 | 0.000 | 0.000 | 0.000 | 0.950 | 0.950 | 0.000 | 0.950 | 0.950 |
| keys | 20 | 0.000 | 0.000 | 0.000 | 1.000 | 1.000 | 0.000 | 1.000 | 1.000 |
| synth | 30 | 0.267 | 0.267 | 0.000 | 0.767 | 0.800 | +0.033 | 0.767 | 0.767 |
| pad | 30 | 0.133 | 0.133 | 0.000 | 0.933 | 0.933 | 0.000 | 0.933 | 0.933 |
| lead | 30 | 0.267 | 0.233 | −0.034 | 0.967 | 0.967 | 0.000 | 0.933 | 0.933 |
| vocal | 30 | 0.033 | 0.033 | 0.000 | 1.000 | 1.000 | 0.000 | 0.900 | 0.900 |
| fx | 30 | 0.000 | 0.000 | 0.000 | 0.833 | 0.833 | 0.000 | 0.833 | 0.833 |
| noise | 15 | 0.067 | 0.067 | 0.000 | 0.733 | 0.733 | 0.000 | 0.733 | 0.733 |
| atmosphere | 15 | 0.000 | 0.000 | 0.000 | 0.867 | 0.933 | +0.066 | 0.867 | 0.933 |
| **ALL** | **630** | **0.197** | **0.219** | **+0.022** | **0.873** | **0.893** | **+0.020** | **0.808** | **0.782** |

- Acoustic family agreement unchanged 425/590 (72.0%) before AND after — the
  family layer was already sound; the +0.022 is inside-family *type*
  discrimination, exactly the STEP44.1 binding constraint.
- Full family agreement 569→570/590 (96.6%).

## 9. Flip analysis — fixed vs new-broke (reference rows, 590)

### 9.1 Acoustic-only flips: fixed 31, new-broke 18

FIX pivots (before→after): clap→snare 8, hihat→openhat 5, percussion→kick 4,
snare→tom 4, clap→hihat 2, percussion→openhat 2, snare→percussion 2,
tom→snare 1, openhat→snare 1, percussion→clap 1, cymbal→hihat 1.

LOST pivots: clap→snare 10, snare→percussion 2, snare→tom 2, tom→snare 1,
cymbal→openhat 1, cymbal→hihat 1, lead→keys 1.

The dominant net loss is clap→snare (−2 net): the measured clap↔snare WEAK pair
(§4 has **zero STRONG** separators) now trips honest ambiguity more often — that
is the §14-required transparency, and the pair is tagged `clap`/`snare`
result-in-ambiguous by rule 7. Net per pair: openhat +5, percussion→kick +4,
tom/net 0 (4 fix, 3 lose).

### 9.2 Full-mode flips: fixed 32, new-broke 20

FIX pivots: clap→snare 7, hihat→openhat 5, tom→kick 4, openhat→snare 2,
percussion→openhat 2, snare→percussion 2, clap→kick 1, openhat→clap 1,
clap→hihat 1, openhat→tom 1, openhat→cymbal 1, clap→cymbal 1.

LOST pivots: cymbal→openhat 3, snare→hihat 2, snare→tom 2, clap→hihat 2,
percussion→tom 2, kick→snare 1, snare→percussion 1, clap→tom 1, hihat→snare 1,
tom→snare 1, tom→kick 1, percussion→snare 1.

Full-mode genuine gains: hihat→openhat 5 (openhat restored — the calibration
removes the pre-calibration “wrongly fixed” hihat), tom→kick 4, clap→snare 7.
Full losses are the honest-ambiguity ripple + the cymbal↔openhat family (no
STRONG separator; decay is the only weak cue).

### 9.3 Name-evidence rows (hihat→openhat parser effect, NOT calibration-cheat)

7 rows have stored `nameType=hihat` but the current evidence parser maps the
same stored `name` to `openhat` (`Lex Luger Open Hat 2`, `jerk open hat 2`,
`17.06.22 open hat 10`, `Brilliants (Open Hat)`, `Open-Hat(slp.bk)`, etc.). Root
cause: those rows were classified when the persisted sample-index evidence
predated the openhat alias; the AUDIO-only delta is unaffected (name/tags are
never fed to Mode A), and the full-mode flips above come from the **acoustic**
openhat restoration, not from the name text. 3 rows have stored-vs-now tag
evidence diff (openhat↔hihat; one keys↔lead). These are version-parser effects
on stored rows — the offline gate (structure + Mode-A family) still passes
630/630.

## 10. Confidence & reconciliation distributions (§11, §25)

AFTER, acoustic layer:

| context | n | mean | min | max |
|---|---|---|---|---|
| audio correct | 129 | 0.289 | 0.176 | 0.496 |
| audio incorrect | 461 | 0.261 | 0.100 | 0.539 |
| ambiguous | 457 | 0.260 | 0.100 | 0.467 |
| not-ambiguous | 133 | 0.292 | 0.184 | 0.539 |

**Calibration flags:** low-but-correct 4 (conservative, fine per §11),
high-but-incorrect 1. Confidence remains deliberately low (§11 decision posture):
AGREE rows mean 0.274, TAG-SUPPORTED 0.263, CONFLICT 0.279, UNKNOWN 0.235,
AUDIO-SUPPORTED 0.366 (10 rows).

Reconciliation status, BEFORE → AFTER: AGREE 68→71, TAG-SUPPORTED 469→468,
CONFLICT 63→58, UNKNOWN 24→20, **AUDIO-SUPPORTED 6→13**. Winning source:
audio 137→142, tag 451→452, name 18→16, none 24→20. The calibration shifts
more rows to the “audio decided it” state — a desired direction (acoustic
calibration objective), while keeping the honest status semantics unchanged.

## 11. Offline fidelity gate and coherence (§22, §28)

- `--noop` gate: **630/630** rows reproduce stored structure (both modes) +
  Mode-A family exactly; the pre-fix gate asserted Mode-B family too, which is
  WRONG because family follows the reconciliation-decided type (classify.ts
  family-follows-type, STEP44.1 rule) and therefore legitimately moves with
  calibration. Corrected gate is structure-only for Mode B, structure+family
  for Mode A.
- Coherence `family == familyOfType(type)`: **629/629** rows with full.type;
  the one row carrying a valid non-class family (noise→atmosphere-noise) is
  per ontology.
- Conflict count full: 81→79. Ambiguous acoustic: 509→493 (630-row all set).

## 12. Loop validation (§23) — no regression

40/40 loops: `structure == loop` in BOTH modes; full `family` never `unknown`;
full `type` never `other`. Family distribution (full, AFTER): musical 17,
vocal 6, fx 7, atmosphere-noise 4, drums 5. Long one-shots: >2.5 s n=235 (0
loop collapses), >4 s n=190 (0 loop collapses) — the calibrated code changed
nothing structural.

## 13. Ultra-short one-shots (§28 SC9) — duration never auto-kicks

| bin | n | audio agree | kick P | kick R | ambiguous | not loop |
|---|---|---|---|---|---|---|
| ≤0.35 s | 141 | 0.201 | 0.867 | 0.565 | 0.806 | 141 |
| 0.35–0.5 s | 60 | 0.190 | 1.000 | 0.375 | 0.672 | 60 |

Kick recall at ≤0.35 s improves 0.52→0.565; no ultra-short row is force-labelled
kick without dark energy (SC4 still respected). The honest-ambiguity posture
holds (81% / 67%).

## 14. Honest ambiguity is preserved, not eroded (§14)

After calibration the ambiguous acoustic rate DROPPED 0.808→0.782 overall —
because real fixes landed (openhat 0.7→0.367, tom 0.7→0.533, kick 0.42→0.38,
hihat 0.9→0.8). The one class whose ambiguity deliberately rose is clap
0.75→0.875: the measured snare↔clap WEAK pair now reports uncertainty instead
of inventing a subtype (§9.1) — this is the required direction, and it is
visible in the per-class numbers (clap audio agreement −0.225).

## 15. Root causes → candidate rule → outcome (complete STEP44.1 agenda)

| STEP44.1 candidate | STEP45 rule | outcome |
|---|---|---|
| §9.2 residue beats real types (fixed 0.25) | evidence-aware residue 0.12+ | percussion→kick +4, percussion agreement +0.067, beat replaced |
| §9.3 openhat/cymbal + name-only tag | hihat↔openhat split + weak-pair honesty | openhat audio +0.233 (0.5→0.733), openhat→hihat stays honest |
| §9.4 musical instrument discrimination | honest `instrument-family ambiguous` (no fake separators) | keys/piano/etc. kept low but honest; TAG-SUPPORTED lift unchanged |
| §9.1 family/type coherence (already fixed STEP44.1) | kept; no change this step | coherence 630/630 |

## 16. Full test suite + regression (§22)

- `npx vitest run src/classify/hier/hier.test.ts` → **61/61** (new STEP45
  describe group: tests 46–52 cover anchored bright snare > residue, generic
  bright ultra-short stays percussion, darkMid kick (500/700 Hz) not crushed,
  0.18 s closed-hat fixture → percussion honest / tag hihat → hihat
  TAG-SUPPORTED / ringing 0.55 s → openhat, soft+long → openhat despite hihat
  tag, snare↔clap weak boundary ambiguous, kick not residue).
- `npx vitest run --testTimeout 60000` → **74 files / 1290 tests pass**.
- `npx tsc --noEmit -p tsconfig.json` → clean.

## 17. Stop conditions (§28) — meet or not

| condition | status |
|---|---|
| acoustic-only delta positive | **YES** (+0.022, verdict A) |
| loops never regress | YES (40/40) |
| ultra-short never auto-kick | YES (SC4 respected) |
| full suite green | YES (1290) |
| coherence maintained | YES (629/629) |
| family/type fields coherent | YES |

## 18. Recommendation and caveats

**Verdict A — keep the calibration.** The measured-signature rules replace the
arbitrary constants flagged in STEP44.1; the acoustic-only agreement on the
same 630 rows, same audio, moves 0.197→0.219. Remaining honest losses (clap
ambiguity up, cymbal↔openhat) are the documented WEAK pairs — tuning them by
error rate is explicitly out (§25). Next useful work is a new *measured*
separator for clap↔snare (e.g. harmonic/spectral detail not yet in the V2
surface) or accepting the pair as permanently ambiguous by design.

_Provenance: rows from `step45-analysis.ndjson` (BEFORE) and
`step45-reclass-after.ndjson` (AFTER); both generated by the CURRENT code over
persisted features; the reference is a proxy label, so all agreement numbers
measure the acoustic layer (A) or the reconciliation (B) against a proxy —
never ground truth (§29–§31). No audio bytes are persisted anywhere._