# STEP43 — Hierarchical Sound-Type Classification Design & Audit Report

**Author:** Analysis audit pipeline (heuristic-v1 vs. proposed hierarchy)
**Date:** 2026-09-09
**Status:** Design + Audit (no code changed; STEP42 accepted as the authoritative classification baseline)

---

## Verdict

`heuristic-v1` is not salvageable by tuning: its failures are **structural, not parametric**. The 22-class flat race (a) hard-codes `loop` as a competing class via a `duration > 2.5 → 1.5` shortcut, (b) runs on V1 aggregate features only while richer V2 features (pitch, harmonicity, crest, transient strength, attack/decay, flux) are already computed on every record and go unused, (c) forces top-5 softmax output so every sample always reports 4 secondaries and a confidence band of 0.22–0.58 that cannot distinguish "decisive" from "guess".

**Recommendation: replace `heuristic-v1` with a 3-stage hierarchy — `structure` binding (stage 0), `soundFamily` (stage 1), `soundType` + optional `subtype` (stage 2) — emitting `classificationVersion: "hier-v1"`, with all contract changes strictly additive.** `primaryClass` / `secondaryClasses` / `semanticClassification` keep their existing surface and vocabulary so searchEngine, IndexedDB, global D1, hydrate, SoundCharacter, Find Similar, and Sound Space are unaffected.

---

## 1. Evidence base

- **Dataset:** STEP42 audit (accepted). 123,756 catalog metadata rows (`step42-metadata.ndjson`, live Audiotool enumeration, 53,885 one-shot / 69,871 loop) + 120 fully pipeline-analyzed records (`step42-analysis.ndjson`; mean confidence 0.326, min 0.2245, max 0.5791).
- **Replication gate:** `heuristic-v1.scoreClass` + top-5 softmax (T=0.5) re-implemented verbatim and validated against stored pipeline output for all 120 rows — **0/120 mismatches** (primary, confidence, secondary order all byte-identical). Evidence below is therefore based on the exact production scoring, not an approximation.

---

## 2. Root-cause analysis — why the flat race fails

### 2.1 `loop` saturation is a hard dominance bug

`heuristicClassifier.ts:96`: `loop` scores **1.5** whenever `duration > 2.5`. No musical class can tie it:

| class | theoretical max | reason |
|---|---|---|
| pad | 1.35 | sustained .5 + tonal .35 + !transient .3 + mid .2 |
| lead/synth | 1.3 / 1.3 | tonal .5 + sustained .4 + bright-mid .3 |
| kick | 1.4 (but needs dark+short) | — |

Observed consequences on real data (120 rows):
- **72/120 (60%) are classified `loop`**, including **12 one-shots** (samples whose library kind is one-shot, e.g. `way down kick 180` at 170 s, long vocal takes, full-track recordings).
- The structure lib says **43% of all 53,885 one-shots are > 2.5 s** (p75 = 9.22 s, max ≈ 998 s), so this is not a data anomaly — long one-shots are normal.
- **Loop-removal counterfactual** (re-rank the same 120 after dropping `loop` from the race; all 72 loop rows re-run through the validated scoring):
  `pad 43 · noise 13 · lead 11 · synth 5`. The hidden structure behind the `loop` label is **musical/sustained content**, exactly what the surface class `loop` destroys.

### 2.2 Musicality is swallowed, not labeled

Machine-derived musical hints (substring tags/names: piano, guitar, bass, 808, synth, pad, bell, strings, pluck, riff, melody): **23 rows, of which 15 (65%) collapsed to `loop`** (`loop 15, kick 3, bass 2, hihat 1, pad 1, guitar 1`). The class `loop` therefore stores "longish" and hides "musical/drum/…", losing the very axis users browse on.

### 2.3 Sub-0.35 s one-shot subtype collapse (drum mislabels)

15 analyzed rows are ≤ 0.34 s; **10 are classified `kick`**, including machine-named samples whose name is the authoritative subtype oracle:

| duration | stored class | oracle (machine name/tags) |
|---|---|---|
| 0.040 s | kick | `Hihat` (name IS "Hihat") |
| 0.042 s | kick | `hh [freezer]` |
| 0.101 s | kick | `Trapaholic Snare (9)` |
| 0.166 s | kick | `snare02` |
| 0.176 s | kick | `DNB SNARE 2` |
| 0.300 s | hihat | `BRLY_ALVE_clap_rapport` |
| 0.330 s | hihat | `uptempo kick 58 xtra` (tags: kick, drum) |
| 0.337 s | kick | `pluck 1` (tag: bass) |

Mechanism: for ultra-short material V1 `transientDensity` is frequently 0 (envelope slew detection misses it), so `hihat` loses its transient + noisy points and `kick` wins on `short + dark`. The rules require "well-formed" transients, which the hardest real one-shots (40–200 ms) do not provide. Design implication: **subtype must be decided by onset-shape (V2 `attackTimeSec`/`decayTimeSec`/`crestFactor`/`transientStrength`) or explicitly deferred (ambiguous), never by the same flat race.**

### 2.4 `noise` swallows vocal/musical/fx content

5 rows classified `noise`: `rap01b` (25.5 s rap vocal), `Recording` (19.2 s singing), `c00lkid-lets-do-again` (4.6 s), `vinylstop` (1.8 s turntable stop), `ÆHR_BASS_ENERGY_NoKey` (1.9 s **bass one-shot**). Their V1 flatness 0.72–0.84 + bandwidth > 3000 trigger `noise`, but SoundCharacter `tonality` on the vocal rows is **0.82–0.91** — i.e. the already-computed V2 tonality/pitch evidence (see §4.2) would flag these as musical/vocal, and it is never consulted.

### 2.5 Calendar-grade "confidence"

Top-5 softmax (T=0.5) over raw heuristic sums maps every input into a narD band:

- confidences ∈ [0.2245, 0.5791], mean 0.3262; **72.5% below 0.35**.
- **Average 4.00 secondaries per record** — the format always emits 4; there is no "ambiguous / not sure" state.
- Top-5 conf entropy mean ≈ 1.53 (of ≤ 1.61 for 5-way uniform), i.e. near-flat distributions are the norm.
- Example (STEP18 validation row `Flume Tennis Snare`): raw openhat 0.90 vs noise 0.70 → softmaxes to 0.32 vs 0.21. A 0.32 confidence cannot be read as "reliable" by any downstream consumer.
- Confidence is uncalibrated to accuracy; nothing in the format distinguishes a "correct but low" label from "lucky".

---

## 3. What the data says the structure axis must be

The structural axis is **not a sound-quality question** — it is already answered by library metadata that is persisted per record (`SampleIndexRecord.kind`, `durationSeconds`):

| axis source | one-shot (n=53,885) | loop (n=69,871) |
|---|---|---|
| duration p25 / med / p75 | 0.45 / 1.72 / 9.22 s | 6.85 / 12.8 / 21.1 s |
| duration > 2.5 s | **43.0%** | 91.7% |
| duration ≤ 2.5 s | 57.0% | **8.3%** |

A pure `duration > 2.5 ⇒ loop` surrogate would mislabel **43% of one-shots and 8.3% of loops** — the heuristic used in production does exactly this. The correct design binds structure from `(sampleKind, durationSeconds)` rather than inferring it from the same feature race used for timbre:

- `structure = oneShot` when `sampleKind=one-shot` (drum hits, fx, short plucks; 28% ≤ 0.5 s).
- `structure = loop` when `sampleKind=loop` (91.7% ≥ 2.5 s; short loops 8.3% kept as `loop-short`).
- `structure = sustainedPhrase / longOneShot` when `sampleKind=one-shot` and `duration > ~4 s` (long vocals, pads, fields, full takes — the 43%).

Feature corroboration within the 120 (one-shot vs loop medians; Cohen's **d**): zcr 0.028→0.061 (**d=0.64**), rms 0.095→0.134 (**d=0.61**), centroid 1.47k→3.29k (**d=0.48**), rolloff 2.54k→6.29k (**d=0.42**), bandwidth (**d=0.33**); attack 1.44→0.023 s; transient density 1.78→0.86. Loops are sustained, quieter, duller, with many hits; one-shots are loud, bright, fast-onset — the aggregate features genuinely separate the *classes* but the current scorer reduces the separation to one threshold.

---

## 4. Proposed hierarchy

### 4.1 Contract (strictly additive)

```
analysis.hier (new, optional on read):
  structure: "one-shot" | "loop" | "sustained-phrase"        # stage 0
  family:    "drums" | "musical" | "vocal" | "fx" |          # stage 1
             "atmosphere-noise" | "unknown"
  type:      ClassId                                          # stage 2 (existing vocabulary)
  subtype?:  SubtypeId                                        # stage 2b (drumOntology, 16 ids)
  confidence: number                                          # family-conditional calibrated
  ambiguous: boolean                                          # explicit "not decisive"
  classificationVersion: "hier-v1"
```

Surface contract **unchanged** (backwards compat, verified by code inventory):

| consumer | reads | impact of hier-v1 |
|---|---|---|
| `search/searchEngine.ts:182-183` | matches if primary OR any secondary ∈ accepted set | none — vocabulary/taxonomy preserved |
| `persistence/indexStore.ts` `:218-227,:285-286,:294-295` | type/`query({primaryClass})`/`matchesClass` | none — `db.ts:46` primaryClass index untouched |
| `global/schema.ts,validation.ts,schemaValidation.ts,contract.ts` | `isKnownClass(primaryClass)` | none — new hier fields optional & separately validated |
| `global/hydrate.ts:100-111` | passthrough + `reconcileSemanticClassification` | none — primary/secondary fed identically |
| `classify/semanticClassification.ts:44,119` | audio family veto from primaryClass | none — family veto still audio-wins |
| SoundCharacter / Find Similar / Sound Space | (grep: map/, similarity/ never read primaryClass) | none |
| STEP41 persistence/global D1 codec | Record shape | none — only additive optional fields |

Surface mapping decision: with `structure` bound at stage 0, the surface class `loop` is **no longer the winner of a timbre race**; it is emitted as the stage-2 type when `structure=loop` **and** family is not confidently drums/musical (mirroring today's library-browsing behavior). The class filter in search keeps working; a structural facet is a separate additive index (not built in this step).

### 4.2 Stage inputs (all already computed, no new DSP)

- V1 (`AudioFeatures`, persisted): duration, transientDensity, spectralCentroid, spectralBandwidth, spectralRolloff, spectralFlatness, zeroCrossingRate, attack, rms, peak.
- V2 (`AudioFeaturesV2`, computed on every record by `v2Dsp.analyzeAudio`, soundCharacter coverage 1.000 with no null dims in the audit): `transientStrength`, `attackTimeSec`, `decayTimeSec`, `crestFactor`, `spectralFlux`, `spectralSlope`, `pitchHz`, `pitchConfidence`, `harmonicity`, `inharmonicity`. For drums-vs-musical, musical-vs-vocal separation these are the discriminative inputs `heuristic-v1` never sees (null-safe by contract).
- Attributes (persisted): `kind`, `durationSeconds`, tag lexemes with subtype meaning (drumOntology lexicon already exists at `src/classify/drumOntology.ts` — used only by semanticClassification today). Tags remain **semantic evidence, not ground truth**, per STEP42.

### 4.3 Scoring structure

- **Stage 0 — structure:** deterministic bind from `(kind, durationSeconds)` + degenerate guard. Rule: `loop` ⇐ `kind=loop`; `sustained-phrase` ⇐ `kind=one-shot & duration>4`; else `one-shot`. The 2.5 s band is gone from classification; short loops (**8.3%**) stay `loop` but are flagged `loop-short` in `structure` semantics (they *are* loops, just short).
- **Stage 1 — family:** a small scored model over V1+V2 (harmonicity, pitchConfidence, transientStrength, attack/decay, crest, flatness, bandwidth). Rules inherited from validated `scoreClass` weights but keyed per-family; the family output feeds a calibrated softmax with **family-conditional temperature**. Observed family evidence to handle explicitly: vocals (rap/singing, V1-flat 0.7–0.8, V2-tonality 0.8–0.9), bass one-shots, long-B-musicals vs noise-bed, turntable/FX.
- **Stage 2 — type/subtype:** within family. Drums: kick/snare/clap/hihat/openhat/tom/cymbal/percussion using **onset-shape V2 features** (attack/decay/crest/transientStrength) so 40–200 ms hits stop collapsing to kick; **`ambiguous` flag** when the top-2 margin is below the family's calibrated threshold (expected for ≤ 0.15 s hats/snares: report `drum-hit` family + possible-types list instead of a confident wrong subtype). Musical: bass/piano/guitar/strings/keys/synth/pad/lead. Subtype (`drumOntology` 16 ids) written **only** when (a) family=drums and (b) either an oracle tag with UI-usable label or a near-top-margin acoustic disambiguation passes the threshold.
- **Confidence:** family-conditional calibrated probabilities (per-family base rates from the library + micro-verified labels, see §5), not raw 5-way softmax. `classificationVersion: "hier-v1"` emitted; `heuristic-v1` retained as read-only legacy label for old rows (data is immutable).

---

## 5. Evaluation protocol (real dataset, no synthetic fixtures)

1. **Dataset expansion:** extend the accepted 120 with a sampleKind-stratified draw (~ +60: 30 short one-shots ≤ 0.5 s, 30 loops ≥ 4 s) via `scripts/step42-classification-audit.ts --resume` (reuses persisted metadata; re-analyzes selected ids through the real `AnalysisPipeline`).
2. **Oracle construction (no new ground truth labels needed):**
   - *Subtype oracle:* machine-derived names/tags (STEP42 already yields concrete negatives: `Hihat`@kick, `hh [freezer]`@kick, `Trapaholic Snare (9)`@kick, `snare02`@kick, `DNB SNARE 2`@kick, `uptempo kick 58 xtra`@hihat, `BRLY_ALVE_clap_rapport`@hihat).
   - *Family oracle:* musical-hint detectors already used above (23/120) + drum-lexicon tags.
   - *Structure oracle:* `(sampleKind, durationSeconds)` — this is ground truth by definition.
3. **Metrics:** per-stage accuracy vs oracle where defined; structure-recall = % rows not mislabeled by loop shortcut (baseline 60%); loop-masking = % musical-hint rows absorbed by `loop` (baseline 65%); subtype-collapse = % subtype-oracle rows dumped into `kick` (baseline 10/15 = 67%); calibration Brier per family; `ambiguous`-rejection coverage; margin-vs-correctness correlation.
4. **Gates:** `npx tsc --noEmit` clean; `vitest run src/classify src/pipeline/analysisPipeline.test.ts` 54/54; searchEngine class-filter tests unchanged; flags for unknown `isKnownClass` never regressed.

---

## 6. Implementation plan (non-breaking phases)

- **Phase A — contract only:** additive `hier` fields in schema/validation and `SampleIndexRecord`; `classificationVersion` bump; no scoring change. Test: schema accepts optional hier, rejects bad confidence/type; old records round-trip.
- **Phase B — stage 1 family:** scored family model on V1+V2; evaluate on 120 (+ tags oracle).
- **Phase C — stage 0 structure binding + loop de-racing:** structure from kind+duration; `loop` only surface type via mapping (§4.1); re-evaluate the loop-removal counterfactual as the expected distribution (pad/lead/synth/noise).
- **Phase D — stage 2 type/subtype + `ambiguous`:** onset-shape disambiguation for drums; subtype only on margin/tag threshold; confidence family-calibrated.
- **Phase E — release gate:** eval protocol §5, 54+ tests, audit re-run, README contract doc updated; old `heuristic-v1` rows re-classified in place at next analysis pass with `classificationVersion: "hier-v1"`.

---

## 7. Residual limitations

- No ground-truth labels exist in the repo: §2's "wrong subtype" claims rely on machine-name/tag oracles (valid for subtype, not for family). The eval protocol keeps oracle-based claims as bounds, not absolutes.
- 120-row audit is small; Phase 0 of the protocol regenerates a stratified sample before Phase B tuning.
- V2 features are null-safe but a minority of fields (e.g. `spectralFlux` in the current `fromV1` path) can be null — stage models must be null-conditional like the V2 contract requires.

---

## 8. Traceability

- Evidence computation: `/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step42/evidence43.mjs` → `evidence43.json` over the accepted STEP42 NDJSONs (metadata 123,756 rows; analysis 120 rows). Replication validation: 0/120 mismatch.
- Code read for rules: `src/classify/heuristicClassifier.ts` (full), `src/audio/featureExtractor.ts`, `src/analysis/audioFeaturesV2.ts`, `src/analysis/soundCharacter.ts`, `src/classify/taxonomy.ts`, `src/classify/drumOntology.ts`.
- No production source files were modified by this step.