# STEP42 — Classification Implementation & Real-Dataset Audit Report

**Audit scope:** current classification implementation (HeuristicClassifier `heuristic-v1`, semantic layer `semantic-v1`, V2 SoundCharacter `2.0.0`) vs. the **real current SampleMap sample set**.
**Date:** 2026-09-09 · **Method:** strictly read-only, reproducible · no audio bytes persisted · user tags exported verbatim.

---

## 1. Data model & provenance

### 1.1 Which source was used, and what is available/missing

| Audit field | Source | Available in dataset |
|---|---|---|
| `sampleId` (`samples/{uuid}`) | **LIVE Audiotool metadata** (real) | ✔ all 123,756 |
| `name` / `kind` / `bpm` / `durationSeconds` | **LIVE Audiotool metadata** (real) | ✔ |
| `visibility` / `ownerName` / `numUsages` / `numFavorites` | **LIVE Audiotool metadata** (real) | ✔ |
| **raw/original user tags** | **LIVE Audiotool metadata** (real, verbatim) | ✔ |
| `primaryClass` / `confidence` / `secondaryClasses` | **DERIVED** — current `HeuristicClassifier` over real lossless audio | ✔ on the 120-sample audit subset |
| `classificationVersion` | DERIVED | ✔ (`heuristic-v1`) |
| `semanticClassification` (family/subtype/source/conflict/tagEvidence) | **DERIVED** — current `reconcileSemanticClassification` | ✔ |
| `analysisV2.soundCharacter` + `quality` | **DERIVED** — current canonical V2 chain | ✔ |
| *persisted SampleMap IndexedDB records* | **NOT FOUND on this machine** → audited via reproducible derivation | ✘ (see 1.3) |

Per-repo decision: **do not substitute fixtures for missing real data.** The metadata rows are real and complete; all classification-family columns were **derived by the current code over real audio** (the same code path the app runs, `AnalysisPipeline.run`), and are labeled DERIVED throughout. Nothing fabricated.

### 1.2 Field availability matrix (what was asked vs. what exists)

| Required field | 123,756-row metadata | 120-row analysis |
|---|---|---|
| sampleId | ✔ | ✔ |
| name | ✔ | ✔ |
| raw/original user tags | ✔ (verbatim) | ✔ (verbatim) |
| stored primaryClass | n/a (never stored remotely) | ✔ as DERIVED |
| confidence | n/a | ✔ as DERIVED |
| classificationVersion | n/a | ✔ (`heuristic-v1`) |
| analysisV2 / SoundCharacter | n/a | ✔ (`2.0.0`, featureCoverage=1.000) |

### 1.3 Why there is no "persisted SampleMap index" to audit directly

- No browser IndexedDB profile with `localhost:5176` data was found on this machine (checked Chrome, Chromium, Edge, Arc, Safari, Firefox, temp/Playwright profiles; searched for the known sample uuid and `samplemap`/`5176` origins).
- No in-repo export/snapshot artifact containing stored classification exists.
- The compact D1 `sound_character_v2` dataset was **explicitly excluded** as the primary source; it intentionally lacks tags/evidence/classification context.

→ Fallback applied (there were literally two other options): the **verified live Audiotool OAuth/sample-library access (PAT)** was used to enumerate the real current sample set and construct a reproducible temporary audit dataset. Audio bytes are downloaded transiently for analysis and released; **nothing audio is written**.

### 1.4 Dataset artifacts (reproducible)

| Artifact | Path |
|---|---|
| Audit script (reproducible, committed) | `scripts/step42-classification-audit.ts` |
| Summary + provenance | `/var/folders/…/T/opencode/step42/step42-audit-summary.json` |
| Metadata rows (123,756) | `…/step42-metadata.ndjson` (29 MB) |
| Analysis rows (120) | `…/step42-analysis.ndjson` |
| Skipped/undecodable rows | `…/step42-skipped.ndjson` |
| Re-run | `npx tsx --env-file=.env scripts/step42-classification-audit.ts --out <dir> --audit-samples 120` (first run enumerates; `--resume` reuses stored metadata) |

---

## 2. Current classification implementation (code-level inventory)

### 2.1 Position in the pipeline (`src/pipeline/analysisPipeline.ts`)

Per job: resolve metadata → `selectLosslessSource` (WAV then FLAC, MP3 never) → fetch (transient) → container gate → `fileHash` → decode → PCM gate → canonical PCM → `contentHash` → `extractFeatures` → `classifier.classify(features)` (:252) → **canonical V2 analysis** `canonicalV2Analysis` (analyzeAudio → computeSoundCharacter → quality, validated `validateSampleAnalysisV2`, reject-if-invalid) (:259–266) → similarity fingerprint + V2 map position → record build → `index.put`. The record embeds `primaryClass/confidence/secondaryClasses/classificationVersion` and the STEP38 additive `semanticClassification = reconcileSemanticClassification(classification, meta.tags)` (:355–358). `originalTags` are stored **verbatim** (:340).

### 2.2 HeuristicClassifier (`src/classify/heuristicClassifier.ts`, `id="heuristic"`, `version="heuristic-v1"`)

Rule booleans over `AudioFeatures` (:36–46):

| Rule | Condition |
|---|---|
| short / medium / sustained / loop | duration `<0.5s` / `0.5–1.5` / `>1.5` / `>2.5` |
| transient | `transientDensity > 5` |
| noisy | `spectralFlatness > 0.6` |
| tonal | `spectralFlatness < 0.35` |
| dark / mid / bright | centroid `<400` / `400–3000` / `>3000` |
| fastAttack | `attack < 0.02` |

Each of the 22 classes scores a weighted sum of these booleans (:48–101); a notable shortcut is **`loop` = `1.5` when `duration > 2.5`** (:96). Output (:104–129) ranks all classes, softmaxes **the top-5** with temperature `T=0.5`, and returns the argmax as `primaryClass` + sorted top-4 `secondaryClasses` (confidences rounded to 4 dp). Because the top-5 are usually close in score, confidences are low and *interpretable as "top-of-a-tight-race"*, not as absolute quality.

### 2.3 Semantic layer `semantic-v1` (`src/classify/semanticClassification.ts`, `src/classify/drumOntology.ts`)

- `SEMANTIC_CLASSIFICATION_VERSION = "semantic-v1"`; `REFINEMENT_CONFIDENCE_EPSILON = 0.04`; `CONFLICT_CONFIDENCE_DISCOUNT = 0.8` (:32–36).
- Rules (verified in tests): audio family is authoritative; tags refine a **family-matching** drum subtype (`source="audio+tags"`, confidence +ε, cap 1.0); a tag whose subtype belongs to a **different family** is a **conflict** → audio wins (`source="audio"`, confidence ×0.8); first tag wins deterministically; favorites/usages never enter the arithmetic; tags preserved verbatim in `tagEvidence`.
- Drum ontology: 16 subtypes — `kick, snare, clap, closedhat, openhat, ride, crash, tom, shaker, tambourine, rim, cowbell, bongo, conga, clave, percussion-other`; hierarchies: `hihat→closedhat|openhat`, `cymbal→ride|crash`, `percussion→shaker|tambourine|rim|cowbell|bongo|conga|clave|other`. Musical classes (`bass`, `synth`, …) pass through untouched.

### 2.4 Normalization (`src/classify/normalizeTag.ts`)

`normalizeTag`: lowercase → non-alphanumeric → single spaces → trim. **Raw tags are never overwritten**; normalization is only for matching.

### 2.5 SoundCharacter V2 (`src/analysis/soundCharacter.ts`, version `2.0.0`)

8 dims `[0,1]` or `null` (`brightness, density, transient, duration, tonality, noisiness, dynamics, complexity`); `computeSoundCharacterQuality → {overall, featureCoverage}`. In the audit subset every dim was determinable (`featureCoverage` mean = **1.000**, no null dims).

---

## 3. Real dataset stats (metadata — REAL, live Audiotool, enumerated 2026-09-09)

| Metric | Value |
|---|---|
| **Samples (complete enumeration)** | **123,756** (1238 pages, `stopped=false`) |
| one-shot | 53,885 (43.5%) |
| loop | 69,871 (56.5%) |
| Samples with ≥1 user tag | 117,081 (94.6%) |
| **Distinct raw user tags** | **19,299** |
| Avg tags per sample | 1.859 |
| Avg tags per *tagged* sample | 1.965 |
| Samples with lossless source (WAV or FLAC) | included in stats; analysis subset 121/121 attempted had sources |

Top raw user tags (count over all 123,756): `drum` 9,189 · `vocal` 8,475 · `guitar` 5,478 · `Trap` 5,119 · `kick` 4,327 · `bass` 3,641 · `percussion` 3,494 · `rap` 3,469 · `piano` 3,457 · `snare` 2,980 · `ambient` 2,148 · `fx` 2,059 · `synthesiser` 1,954 · `phonk` 1,708 · `House` 1,639 · `HipHop` 1,613 · `sample` 1,608 · `drums` 1,534 · `LoFi` 1,521 · `hat` 1,456 · `vox` 1,256 · `hit` 1,238 · `perc` 1,157 · `DrumAndBass` 1,137 · `Dubstep` 1,100 … (`808` 2,082).

> Caveat: enumeration order is the live library listing order (recency-ordered). The first 121 entries are therefore **newer uploads**, which skews the derived subset toward loops (see §4).

---

## 4. primaryClass distribution (DERIVED ↔ current classifier, n=120)

| primaryClass | count | % | mean conf | min conf | max conf |
|---|---|---|---|---|---|
| **loop** | 72 | 60.0 | 0.319 | 0.276 | 0.512 |
| kick | 10 | 8.3 | 0.323 | 0.247 | 0.484 |
| bass | 9 | 7.5 | 0.464 | 0.380 | 0.579 |
| hihat | 7 | 5.8 | 0.333 | 0.266 | 0.497 |
| openhat | 6 | 5.0 | 0.297 | 0.266 | 0.320 |
| noise | 5 | 4.2 | 0.389 | 0.289 | 0.553 |
| lead | 4 | 3.3 | 0.272 | 0.264 | 0.295 |
| guitar | 4 | 3.3 | 0.225 | 0.225 | 0.225 |
| pad | 3 | 2.5 | 0.247 | 0.247 | 0.247 |

Overall confidence: **mean 0.326, min 0.2245, max 0.5791** — typical of the top-5-softmax formulation. No class reached the drum `>0.5` "recognized" bar in this subset.

**Distribution bias:** all but 9 of the 120 meet `duration > 2.5s` and therefore score the `loop=1.5` shortcut → `loop` dominates. This is a real property of the current classifier, not a sampling artifact only: a long sample is almost always `loop`, regardless of content (see conflicts §7).

Semantic `source` on the subset: `audio` 119, `audio+tags` 1 (`Booms Kick`, tags `drum,kick,kick` → subtype `kick`, confidence 0.484+ε=0.524). Secondary classes are dominated by `lead` (81), `pad` (81), `synth` (71), `strings` (70) — the "waterballast" of the softmax tail.

---

## 5. user tags (REAL — both scopes)

- Global: see §3 (19,299 distinct; 94.6% tagged).
- **Audit subset (120):** 111 tagged (92.5%), 9 untagged, **173 tag instances, 118 distinct tags**, avg 1.44 tags/sample. Most frequent in subset: `drum` 9, `rap` 6, `piano` 5, `kick` 5, `ambient` 5, `sample` 4, `HipHop` 4, `Trap` 4, `pad` 3, `chill` 3, `percussion` 3, `guitar` 3. Raw verbatim examples: `rikkard`, `okayyy`, `-jjnhbhgb`, `wpx`, `$elly`, `SummerGames`, `coryxkensin`, `nbayoungboy` — i.e. community tags are **non-canonical** (producer aliases, "type beat" artists, memes), confirming tags must stay a secondary, evidence-only signal.

---

## 6. Cross-table primaryClass × user tags (DERIVED subset n=120)

Confined to tags that map to a drum-family concept; cells = samples:

| | `kick` | `snare` | `clap` | `hihat` | `hat` | `chh` | `percussion` | `perc` | `drum` | `808` | `bass` | `piano` | `guitar` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **openhat** | 1 | 1 | – | – | 1 | 1 | – | – | 2 | – | – | – | – |
| **kick** | 2 | – | – | 1 | 1 | – | 2 | 1 | 2 | 1 | 1 | – | – |
| **hihat** | 1 | – | 1 | – | – | – | – | – | 1 | – | – | – | – |
| **loop** | 1 | – | – | – | – | – | 1 | – | 4 | – | – | 4 | 3 |
| **bass** | – | – | – | – | – | – | – | – | – | 1 | 1 | – | – |
| **lead** | – | – | 1 | – | – | – | – | – | – | – | – | – | – |

Widest real contingency across the full 120 rows (top pairs): `loop ⨯ rap` 4, `loop ⨯ piano` 4, `loop ⨯ Trap` 4, `loop ⨯ drum` 4, `loop ⨯ pad` 3, `loop ⨯ guitar` 3, `kick ⨯ percussion` 2, `openhat ⨯ drum` 2, `kick ⨯ kick` 2. Roughly half of all `loop` rows carry non-drum, genre/artist tags (`rap`, `chill`, `tekken`, `LoFi`…), i.e. **tag semantics are mostly genre/artist/utility, not instrument** — a key input for the future reconciliation layer.

---

## 7. Known classification conflicts (REAL, n=10 of 120; `semanticClassification.conflict=true`)

`normalizeTag`→`drumOntology.tagToSubtype` on the subset resolves 10 samples whose tags point to a **different family** than the audio-derived class:

| sampleId (tail) | name | raw tags | audio class (family) | semantic conf (×0.8) |
|---|---|---|---|---|
| `…1a13b-074` | Flume Tennis Snare | `snare` | openhat | 0.2562 |
| `…28fa5-4e1` | clap | `clap` | lead | 0.2109 |
| `…c0c42-638` | deo . perc | `percussion` | loop | 0.4099 |
| `…e1b41-687` | ketamine kick 17 xtra | `drum, kick` | openhat | 0.2562 |
| `…dd101-067` | Kick Mvssi | `percussion` | kick | 0.3872 |
| `…05f16-e36` | uptempo kick 58 xtra | `kick, drum` | hihat | 0.2349 |
| `…810b1-28b` | space_hat_closed_vhs | `chh, hat, closed` | openhat | 0.2305 |
| `…747b4-a89` | Hihat | `perc, synthesiser, percussion, drum, hihat` | kick | 0.2263 |
| `…f11c2-988` | way down kick 180 | `kick, drum` | loop | 0.2530 |
| `…31bd6-17f` | BRLY_ALVE_clap_rapport | `clap` | hihat | 0.2349 |

Rules honour the design: **audio wins, tags never override the family, confidence ×0.8.** Additionally observed (non-flagged but content-vs-class mismatches beyond the subtype ontology): `snare02`→kick, `hh [freezer]`→kick (0.04 s !), `pluck 1` (tagged `bass`)→kick, `Trapaholic Snare (9)`→kick, `SNARE.107.NEPT`→openhat, `Hi hat roll`→hihat ✔, `emu hhat o 1`→openhat ✔.

### Code-level systemic findings (worth fixing in a later reconciliation layer)
1. **`loop` saturation:** `duration>2.5 ⇒ score 1.5` bucket dominates; `way down kick 180` is a 170 s **kick-titled** recording → `loop`. Long one-shots/vocals (`whatever you want vocals`, 69 s; full-track uploads 177–405 s) always → `loop`.
2. **Ultra-short one-shots → kick:** <0.2 s transients classify `kick`/`hihat` nondeterministically (`hh [freezer]` 0.04 s → kick).
3. **snare/openhat/hihat proximity:** bright, noisy transients hover around `openhat 0.32 / hihat 0.29 / cymbal 0.16`, producing the lowest confidences in the corpus.
4. **Feature anomalies:** several rows show `spectralCentroid=0, flatness=1.0` (e.g. `vinylstop`, `The Weeknd – Faith 1`, `way down kick 180`, `minimal`, `yooooooooooo`) — degenerate/near-silent or silence-headed audio; the classifier still emits a low-confidence class. SoundCharacter `featureCoverage` stayed 1.000, so this is a feature-extraction edge, not a character gap.
5. **Genre/artist tags never resolve** (`tagToSubtype` returns `undefined`, no conflict) — they simply pass through as evidence-less `tagEvidence` candidates; fine per design.

**Cross-validation of the derived method:** the audit's first row, `Flume Tennis Snare`, reproduces the previously **verified live run** (STEP18) to within rounding — `openhat 0.3203` vs recorded `0.320`, secondaries `noise@0.2147,hihat@0.1758,cymbal@0.159,snare@0.1302` vs recorded `noise@0.21,hihat@0.18,cymbal@0.16,snare@0.13`, same 0.645 s, same centroid 5703.

---

## 8. Existing tests / audits (as of this STEP)

| Artifact | Content | Status |
|---|---|---|
| `src/classify/classifier.test.ts` (12 tests) | HeuristicClassifier behavior: kick/hat/bass & noise fixtures, secondary sorted/deduped, top-5 distribution, determinism, NaN/∞-safe, degenerate-feature safety; ClassifierRegistry dedup; taxonomy disjointness | ✔ green (re-run 2026-09-09: 54/54 across classify+pipeline tests) |
| `src/classify/semanticClassification.test.ts` (23 tests) | normalizeTag; 16-subtype ontology; tag→subtype resolution incl. `Wood Block`→`clave`; refinement ε, conflict ×0.8, cap≤1, first-tag-wins, determinism, tag verbatim evidence; semantic colors distinctness/fallbacks | ✔ green (23/23) |
| `src/classify/test-helpers.ts` | fixture profiles (`kickFeatures`, `hatFeatures`, `bassFeatures`, `noiseFeatures`, `makeFeatures`) | used by tests |
| STEP38 report | semantic layer design + validation | ✔ |
| STEP18 live verification | **1 real sample** verified end-to-end incl. classification (`openhat 0.320…`) via live WAV | reproduces in this audit (§7) |
| **Prior accuracy/precision/recall/conflict audit** | **none exists** — this report is the first | — |

No precision/recall exists: there is no ground-truth label set. The de-facto proxy here is **tag agreement on family-matching drum classes** = `audio+tags`: **1/120**; **conflict rate** = **10/120 (8.3%)** on the subset.

---

## 9. Sound-Type taxonomy (current, unchanged by this audit)

### 9.1 22 audio classes (`TAXONOMY`, `ALL_CLASSES`, `src/classify/taxonomy.ts`)

- **drums (8):** `kick`, `snare`, `clap`, `hihat`, `openhat`, `tom`, `cymbal`, `percussion`
- **musical (8):** `bass`, `synth`, `piano`, `guitar`, `strings`, `keys`, `pad`, `lead`
- **other (6):** `vocal`, `fx`, `atmosphere`, `noise`, `loop`, `other`

### 9.2 16 drum subtypes (`SUBTYPE_IDS`, `SUBTYPE_LABELS`)

| id | label | parent family |
|---|---|---|
| kick | Kick | kick |
| snare | Snare | snare |
| clap | Clap | clap |
| closedhat | Closed Hat | hihat |
| openhat | Open Hat | hihat |
| ride | Ride | cymbal |
| crash | Crash | cymbal |
| tom | Tom | tom |
| shaker | Shaker | percussion |
| tambourine | Tambourine | percussion |
| rim | Rim | percussion |
| cowbell | Cow Bell | percussion |
| bongo | Bongo | percussion |
| conga | Conga | percussion |
| clave | Clave | percussion |
| percussion-other | Other Percussion | percussion |

### 9.3 Version pins
`classificationVersion="heuristic-v1"` · `SEMANTIC_CLASSIFICATION_VERSION="semantic-v1"` · `ANALYSIS_VERSION="2.0.0"` (all present in every analysis row; uniq-checked).

---

## 10. Sample audit table — 120 real samples (DERIVED classification)

Order = live library order; `C` = conflict flag. (`sub` = semantic subtype, `sConf` = semantic confidence, `dur` = seconds, `centroid` = Hz, `flat` = spectral flatness, `attack` = s, `td` = transient density, `scQ` = SoundCharacter quality overall.)

| # | sampleId | name | kind | raw tags | primaryClass | conf | subtype | sConf | C | dur(s) | centroid | flat | attack | td | scQ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `0001a13b-074` | Flume Tennis Snare | one-shot | snare | openhat | 0.320 | openhat | 0.256 | ⚑ | 0.65 | 5703 | 0.43 | 0.000 | 0 | 0.50 |
| 2 | `0001a43b-ed6` | Juul perc | one-shot | pierre | kick | 0.283 | kick | 0.283 | . | 0.12 | 4328 | 0.17 | 0.000 | 0 | 0.40 |
| 3 | `0001c0b8-f7a` | OTHER LOOP | loop | rap | loop | 0.276 | loop | 0.276 | . | 14.01 | 2386 | 0.14 | 4.836 | 0 | 0.34 |
| 4 | `0001e452-0d9` | piano-loop-where-did-i-go | loop | piano | loop | 0.276 | loop | 0.276 | . | 29.09 | 691 | 0.04 | 3.640 | 2 | 0.26 |
| 5 | `00028fa5-4e1` | clap | loop | clap | lead | 0.264 | lead | 0.211 | ⚑ | 2.39 | 3225 | 0.24 | 0.800 | 1 | 0.47 |
| 6 | `0002aafb-279` | (2) | one-shot | okayyy | lead | 0.264 | lead | 0.264 | . | 1.57 | 3924 | 0.06 | 0.059 | 3 | 0.43 |
| 7 | `00031345-892` | chicago free 3 Real | loop | sample | bass | 0.457 | bass | 0.457 | . | 13.51 | 180 | 0.00 | 1.973 | 1 | 0.23 |
| 8 | `00040961-c60` | 2nd part to 123 | one-shot | ooh, vox | loop | 0.276 | loop | 0.276 | . | 6.09 | 685 | 0.03 | 0.807 | 0 | 0.29 |
| 9 | `0004d31f-338` | audiotool live recording | one-shot | nut | openhat | 0.320 | openhat | 0.320 | . | 0.59 | 4598 | 0.37 | 0.016 | 2 | 0.48 |
| 10 | `0004dbe9-b21` | rap01b | one-shot | rap, HipHop | noise | 0.289 | noise | 0.289 | . | 25.54 | 11571 | 0.76 | 1.696 | 2 | 0.34 |
| 11 | `00050555-dec` | PAD-DreamzOvNorth3 | one-shot | pad | loop | 0.321 | loop | 0.321 | . | 5.25 | 641 | 0.03 | 0.629 | 12 | 0.24 |
| 12 | `000521ae-85a` | scratch | one-shot | HipHop | hihat | 0.285 | hihat | 0.285 | . | 1.12 | 8571 | 0.70 | 0.117 | 5 | 0.32 |
| 13 | `000550bd-171` | drake ovo type pad synth | loop | pad, rap, chill, wavy | loop | 0.276 | loop | 0.276 | . | 14.77 | 1466 | 0.08 | 6.272 | 2 | 0.26 |
| 14 | `0006530c-63d` | blest 808 4 | one-shot | 808 | bass | 0.380 | bass | 0.380 | . | 0.92 | 56 | 0.00 | 0.037 | 8 | 0.20 |
| 15 | `000698b2-2cc` | love12 | one-shot | - | loop | 0.276 | loop | 0.276 | . | 19.42 | 1229 | 0.03 | 6.533 | 1 | 0.33 |
| 16 | `0006a718-f51` | Welcome to japan | loop | japanese, koto, asain | loop | 0.316 | loop | 0.316 | . | 28.68 | 0 | 1.00 | 0.789 | 3 | 0.31 |
| 17 | `0008d2d3-465` | $outhern Tw!l!ghtz 2 | loop | smoke, smooth, mystic, chill | loop | 0.360 | loop | 0.360 | . | 14.88 | 3663 | 0.08 | 1.422 | 3 | 0.34 |
| 18 | `0009dcb3-5a0` | YK kick 2 | one-shot | melodic | kick | 0.247 | kick | 0.247 | . | 0.21 | 475 | 0.01 | 0.005 | 0 | 0.28 |
| 19 | `000a85b2-78f` | Cymatics - Scarlet Piano Loop 23 - 160 BPM A# Min | loop | piano | loop | 0.276 | loop | 0.276 | . | 12.00 | 809 | 0.07 | 0.093 | 1 | 0.26 |
| 20 | `000b3aa5-47d` | night lovell type | loop | night | loop | 0.276 | loop | 0.276 | . | 9.90 | 977 | 0.01 | 2.512 | 1 | 0.26 |
| 21 | `000c0c42-638` | deo . perc | loop | percussion | loop | 0.512 | loop | 0.410 | ⚑ | 4.87 | 6236 | 0.58 | 1.675 | 5 | 0.41 |
| 22 | `000c3d4f-e78` | Recordingdrums | loop | rap | pad | 0.247 | pad | 0.247 | . | 1.71 | 2505 | 0.14 | 1.440 | 3 | 0.35 |
| 23 | `000d3762-909` | looperman-l-3000920-0215533-kendrick-lamar-type-flute | loop | vocal | loop | 0.276 | loop | 0.276 | . | 8.40 | 812 | 0.04 | 0.384 | 2 | 0.26 |
| 24 | `000dc49b-bb6` | SpotiMate.io - Bad with Goodbyes - DatYunginG5_ Foolio | loop | harp | loop | 0.321 | loop | 0.321 | . | 33.70 | 2714 | 0.17 | 2.235 | 5 | 0.35 |
| 25 | `000e1b41-687` | ketamine kick 17 xtra | one-shot | drum, kick | openhat | 0.320 | openhat | 0.256 | ⚑ | 0.55 | 5115 | 0.50 | 0.012 | 0 | 0.40 |
| 26 | `000e3145-16d` | sad night 1 | loop | guitar | loop | 0.276 | loop | 0.276 | . | 18.85 | 1311 | 0.04 | 17.978 | 1 | 0.27 |
| 27 | `000eb892-af3` | other melody | loop | hi | loop | 0.276 | loop | 0.276 | . | 26.50 | 720 | 0.00 | 0.656 | 1 | 0.26 |
| 28 | `000fcd29-cba` | Cymatics - Humble FX 6 - Hoover | one-shot | synthesiser | loop | 0.360 | loop | 0.360 | . | 6.40 | 4825 | 0.16 | 0.645 | 1 | 0.37 |
| 29 | `00101039-2ca` | looperman-l-2163416-0204215-dawn-chance-the-rapper-piano | loop | Trap | loop | 0.276 | loop | 0.276 | . | 15.24 | 1061 | 0.01 | 13.360 | 3 | 0.27 |
| 30 | `0010369c-e94` | Recording | one-shot | Drum | loop | 0.276 | loop | 0.276 | . | 4.64 | 2458 | 0.10 | 0.801 | 1 | 0.30 |
| 31 | `00108566-0bf` | Recording | one-shot | singing | noise | 0.289 | noise | 0.289 | . | 19.16 | 10323 | 0.72 | 0.267 | 1 | 0.44 |
| 32 | `0011044c-22e` | real haven | loop | rage | loop | 0.512 | loop | 0.512 | . | 13.71 | 3778 | 0.40 | 0.012 | 0 | 0.47 |
| 33 | `00110496-7e4` | the other part to the flute mel | loop | flute | loop | 0.276 | loop | 0.276 | . | 11.57 | 966 | 0.01 | 2.908 | 1 | 0.27 |
| 34 | `0011287c-cc6` | spacey break 2 bars | loop | latin | loop | 0.387 | loop | 0.387 | . | 3.00 | 3952 | 0.16 | 0.012 | 6 | 0.51 |
| 35 | `001298cd-ec1` | STABBER | loop | breakcore | loop | 0.276 | loop | 0.276 | . | 6.00 | 1310 | 0.06 | 0.006 | 5 | 0.39 |
| 36 | `0012e957-36a` | we need jungle im afraid | one-shot | jungle, sample, voice, clip | loop | 0.276 | loop | 0.276 | . | 13.75 | 933 | 0.07 | 0.586 | 2 | 0.36 |
| 37 | `00149afc-d08` | vinylstop | one-shot | stop | noise | 0.340 | noise | 0.340 | . | 1.78 | 0 | 1.00 | 0.801 | 2 | 0.31 |
| 38 | `001545d4-e4e` | peter | one-shot | lani | guitar | 0.225 | guitar | 0.225 | . | 1.02 | 727 | 0.01 | 0.027 | 0 | 0.29 |
| 39 | `001694fa-bd3` | looperman-l-2921434-0194800-pierre-bourne-type | loop | - | loop | 0.276 | loop | 0.276 | . | 6.00 | 2501 | 0.05 | 4.267 | 0 | 0.33 |
| 40 | `0016d4cc-454` | bells | loop | love, 0000, Trap | loop | 0.276 | loop | 0.276 | . | 12.00 | 2026 | 0.02 | 0.000 | 3 | 0.41 |
| 41 | `00181410-283` | pietroo | one-shot | ambient | guitar | 0.225 | guitar | 0.225 | . | 1.16 | 2559 | 0.24 | 0.070 | 1 | 0.30 |
| 42 | `00184c25-628` | MMP - Rupture - Henry Bataille 2 | one-shot | vocal | loop | 0.360 | loop | 0.360 | . | 16.28 | 3294 | 0.24 | 12.181 | 2 | 0.40 |
| 43 | `001a36c7-36a` | c00lkid-lets-do-again | loop | forsaken | noise | 0.474 | noise | 0.474 | . | 4.56 | 10664 | 0.84 | 0.691 | 2 | 0.35 |
| 44 | `001ab8d6-c8c` | 8082 | one-shot | theremin | bass | 0.470 | bass | 0.470 | . | 3.62 | 119 | 0.00 | 0.021 | 5 | 0.27 |
| 45 | `001adc47-7ec` | Cxdy - Virgo (808) | one-shot | - | bass | 0.579 | bass | 0.579 | . | 1.71 | 152 | 0.00 | 0.023 | 9 | 0.23 |
| 46 | `001b8256-e49` | emu hhat o 1 | one-shot | drum | openhat | 0.270 | openhat | 0.270 | . | 0.51 | 4565 | 0.00 | 0.006 | 0 | 0.38 |
| 47 | `001bc231-7f3` | hitori de remix piano 2 | one-shot | hitori | loop | 0.276 | loop | 0.276 | . | 10.67 | 1771 | 0.02 | 1.040 | 2 | 0.28 |
| 48 | `001c4b28-61e` | Drum loop | loop | - | loop | 0.276 | loop | 0.276 | . | 10.67 | 569 | 0.03 | 0.331 | 2 | 0.30 |
| 49 | `001d72d5-0fb` | 136_Africa 170 BPM | loop | Trap | loop | 0.276 | loop | 0.276 | . | 22.61 | 814 | 0.00 | 7.829 | 1 | 0.29 |
| 50 | `001dd101-067` | Kick Mvssi | one-shot | percussion | kick | 0.484 | kick | 0.387 | ⚑ | 0.13 | 254 | 0.00 | 0.000 | 0 | 0.27 |
| 51 | `001e2685-e30` | trust Vocal | loop | - | loop | 0.512 | loop | 0.512 | . | 27.38 | 6171 | 0.50 | 0.122 | 0 | 0.36 |
| 52 | `001e52a2-b1d` | Hi hat roll | one-shot | - | hihat | 0.406 | hihat | 0.406 | . | 0.15 | 7782 | 0.46 | 0.000 | 13 | 0.50 |
| 53 | `001e6f35-e30` | Trapaholic Snare (9) | one-shot | 808 | kick | 0.337 | kick | 0.337 | . | 0.10 | 4725 | 0.27 | 0.006 | 10 | 0.39 |
| 54 | `001f070e-44e` | rio - easports 808 | one-shot | rio, leyva, 808 | guitar | 0.225 | guitar | 0.225 | . | 1.32 | 2031 | 0.17 | 0.122 | 5 | 0.24 |
| 55 | `001f8cc9-e9b` | Greatfull riff 1 | loop | acidrock | loop | 0.276 | loop | 0.276 | . | 8.33 | 659 | 0.00 | 1.280 | 0 | 0.28 |
| 56 | `0020114c-c20` | Tyler the Creator - Sometimes extended 112 | loop | 11 | loop | 0.276 | loop | 0.276 | . | 14.23 | 777 | 0.01 | 0.046 | 2 | 0.29 |
| 57 | `002049e9-662` | G#6 | one-shot | piano | pad | 0.247 | pad | 0.247 | . | 2.34 | 2582 | 0.03 | 0.017 | 1 | 0.42 |
| 58 | `00205f16-e36` | uptempo kick 58 xtra | one-shot | kick, drum | hihat | 0.294 | hihat | 0.235 | ⚑ | 0.33 | 3577 | 0.38 | 0.000 | 0 | 0.44 |
| 59 | `0020f033-eb1` | emo4 lead guitar1 | loop | guitar | loop | 0.316 | loop | 0.316 | . | 32.60 | 0 | 1.00 | 16.428 | 1 | 0.34 |
| 60 | `002206a9-7cb` | nba youngboy | loop | nbayoungboy | loop | 0.276 | loop | 0.276 | . | 11.71 | 895 | 0.01 | 1.115 | 2 | 0.27 |
| 61 | `002229bf-6c7` | whatever you want vocals (177bpm) | one-shot | vocals | loop | 0.512 | loop | 0.512 | . | 69.15 | 4703 | 0.49 | 67.425 | 1 | 0.37 |
| 62 | `00227a48-03e` | hi hats | one-shot | broke | hihat | 0.266 | hihat | 0.266 | . | 0.37 | 9312 | 0.08 | 0.043 | 0 | 0.41 |
| 63 | `0022c5c6-759` | ÆHR_BASS_ENERGY_NoKey | loop | dubsap | noise | 0.553 | noise | 0.553 | . | 1.88 | 10260 | 0.82 | 0.012 | 1 | 0.48 |
| 64 | `0022e4a6-0fc` | The Weeknd - Faith 1 | loop | the, weeknd | loop | 0.316 | loop | 0.316 | . | 19.20 | 0 | 1.00 | 15.180 | 0 | 0.33 |
| 65 | `002431b9-74b` | Barbara Mason - I'm in Love With You (192  kbps) (1) | loop | hh | loop | 0.276 | loop | 0.276 | . | 21.04 | 1324 | 0.01 | 3.579 | 3 | 0.28 |
| 66 | `0025e9e5-f77` | Cymatics - Eternity Piano Dry 9 - 90 BPM B Maj | loop | LoFi, LoFi, Trap | loop | 0.276 | loop | 0.276 | . | 10.67 | 1712 | 0.14 | 1.399 | 3 | 0.30 |
| 67 | `00268bf3-57c` | Vinyl Crackle | loop | recording | loop | 0.321 | loop | 0.321 | . | 6.21 | 2577 | 0.12 | 2.149 | 8 | 0.44 |
| 68 | `0026917a-bc1` | patrice rushen - number one | loop | disco | loop | 0.360 | loop | 0.360 | . | 405.20 | 3299 | 0.06 | 70.507 | 4 | 0.39 |
| 69 | `0026a9de-7dc` | Cymatics - Real Talk - 138 BPM F Min | loop | ambient | bass | 0.470 | bass | 0.470 | . | 13.94 | 135 | 0.00 | 1.283 | 6 | 0.26 |
| 70 | `002705a1-ca6` | drum break | loop | ambient | loop | 0.321 | loop | 0.321 | . | 10.41 | 1047 | 0.05 | 0.006 | 5 | 0.35 |
| 71 | `00272d3f-059` | Frenchcore_Kick_5_G (Psy) | one-shot | french, niggas | kick | 0.283 | kick | 0.283 | . | 0.30 | 3111 | 0.29 | 0.000 | 0 | 0.41 |
| 72 | `00275837-887` | snare02 | one-shot | SummerGames | kick | 0.291 | kick | 0.291 | . | 0.17 | 4095 | 0.03 | 0.000 | 0 | 0.47 |
| 73 | `002810b1-28b` | space_hat_closed_vhs | one-shot | chh, hat, closed | openhat | 0.288 | openhat | 0.231 | ⚑ | 1.08 | 9212 | 0.64 | 0.000 | 1 | 0.61 |
| 74 | `00282e28-f15` | e and b uke | loop | ukulele | loop | 0.276 | loop | 0.276 | . | 7.66 | 951 | 0.02 | 0.469 | 3 | 0.28 |
| 75 | `00297ece-21a` | nice | loop | ok | loop | 0.512 | loop | 0.512 | . | 8.44 | 6679 | 0.57 | 6.960 | 1 | 0.41 |
| 76 | `002a1584-801` | jersey club | loop | jersey, club, sample, melody | loop | 0.276 | loop | 0.276 | . | 26.48 | 538 | 0.00 | 13.380 | 2 | 0.28 |
| 77 | `002a1cd6-467` | bensound-summer | loop | dance | lead | 0.295 | lead | 0.295 | . | 2.37 | 3528 | 0.08 | 0.027 | 7 | 0.29 |
| 78 | `002b281e-f1a` | hh [freezer] | one-shot | hat | kick | 0.291 | kick | 0.291 | . | 0.04 | 8241 | 0.19 | 0.000 | 0 | 0.48 |
| 79 | `002c2353-3f7` | KATANA | loop | okay | loop | 0.276 | loop | 0.276 | . | 7.38 | 2474 | 0.03 | 2.864 | 1 | 0.27 |
| 80 | `002cd707-937` | What!? | one-shot | what | bass | 0.501 | bass | 0.501 | . | 0.55 | 346 | 0.00 | 0.035 | 2 | 0.32 |
| 81 | `002dbd9b-79b` | Tegga Track 2 | loop | HipHop | loop | 0.276 | loop | 0.276 | . | 13.14 | 535 | 0.00 | 5.962 | 0 | 0.27 |
| 82 | `002dc413-219` | moving on | loop | singing | loop | 0.276 | loop | 0.276 | . | 9.00 | 2081 | 0.23 | 7.248 | 0 | 0.31 |
| 83 | `002dc6c9-f73` | Kick - 28 | one-shot | alien | guitar | 0.225 | guitar | 0.225 | . | 0.58 | 2367 | 0.24 | 0.023 | 2 | 0.32 |
| 84 | `002e0251-e74` | at gc lofi piano chords 144bpm | loop | piano | loop | 0.276 | loop | 0.276 | . | 13.33 | 593 | 0.02 | 2.101 | 3 | 0.27 |
| 85 | `002fef16-a1c` | string emsemble 2 | one-shot | vi, violin | loop | 0.360 | loop | 0.360 | . | 17.07 | 3686 | 0.24 | 0.859 | 0 | 0.37 |
| 86 | `002ff2fa-5bb` | $elly tha Plug | loop | - | loop | 0.276 | loop | 0.276 | . | 30.00 | 845 | 0.03 | 0.058 | 3 | 0.28 |
| 87 | `002ff6f6-366` | 120 Bpm Guitar Loop | loop | guitar | loop | 0.276 | loop | 0.276 | . | 7.72 | 1014 | 0.05 | 1.419 | 2 | 0.32 |
| 88 | `00306c3c-8ee` | Coryxkenshin senpai rap | loop | meme, coryxkensin, yandere | loop | 0.360 | loop | 0.360 | . | 25.45 | 7794 | 0.07 | 1.858 | 1 | 0.37 |
| 89 | `00307126-d46` | Subbass X | one-shot | bass | bass | 0.415 | bass | 0.415 | . | 0.35 | 229 | 0.01 | 0.021 | 3 | 0.25 |
| 90 | `003103c0-f85` | Jamie Ray - COUNTRY TRAPPER OF DA YEAR (Official Audio) | loop | rap | loop | 0.316 | loop | 0.316 | . | 177.04 | 0 | 1.00 | 74.693 | 2 | 0.34 |
| 91 | `00310a34-695` | ultimopezzo2 | loop | drum | loop | 0.360 | loop | 0.360 | . | 7.93 | 3100 | 0.01 | 0.187 | 1 | 0.31 |
| 92 | `003181dc-06f` | A very beautiful Authentic sky in tekken | loop | piano, tekken, tekken, chill | loop | 0.276 | loop | 0.276 | . | 29.58 | 956 | 0.01 | 16.742 | 4 | 0.30 |
| 93 | `00318f96-f98` | AD1_12_Pad_Lp-124_Gm | loop | pad | loop | 0.276 | loop | 0.276 | . | 7.74 | 1197 | 0.03 | 0.336 | 3 | 0.29 |
| 94 | `0031bfeb-0fd` | wutang cream pt.6 | loop | ambient | loop | 0.276 | loop | 0.276 | . | 21.58 | 2000 | 0.09 | 10.136 | 3 | 0.37 |
| 95 | `003272cd-3e6` | Skepta & JME Freestyle (Acapella) 139.500 BPM [ ezmp3.cc ] | loop | nah | loop | 0.276 | loop | 0.276 | . | 114.36 | 2933 | 0.07 | 5.741 | 2 | 0.40 |
| 96 | `0032fd6d-b9d` | Trippie Redd Type Melody | loop | rage, HipHop, trippie, redd | loop | 0.276 | loop | 0.276 | . | 12.39 | 2925 | 0.03 | 0.244 | 0 | 0.34 |
| 97 | `00352724-73f` | pluck 1 | one-shot | bass | kick | 0.247 | kick | 0.247 | . | 0.34 | 447 | 0.00 | 0.011 | 0 | 0.26 |
| 98 | `00352dc5-5a4` | Booms Kick | one-shot | drum, kick, kick | kick | 0.484 | kick | 0.524 | . | 0.16 | 311 | 0.01 | 0.006 | 0 | 0.25 |
| 99 | `00364d90-a59` | The Legend of Zelda - Ocarina Of Time Pt 2 | loop | universal, rap, zelda | loop | 0.276 | loop | 0.276 | . | 3.44 | 2486 | 0.03 | 0.238 | 1 | 0.32 |
| 100 | `003747b4-a89` | Hihat | one-shot | perc, synthesiser, percussion, drum, hihat | kick | 0.283 | kick | 0.226 | ⚑ | 0.04 | 9839 | 0.25 | 0.000 | 0 | 0.53 |
| 101 | `00381b4a-ce5` | crest 80 Gm | loop | lyre | loop | 0.321 | loop | 0.321 | . | 24.00 | 1526 | 0.02 | 0.075 | 5 | 0.28 |
| 102 | `00394f6f-531` | EAPU PLUCK | one-shot | monte, booker | bass | 0.446 | bass | 0.446 | . | 1.08 | 205 | 0.00 | 0.006 | 0 | 0.29 |
| 103 | `003a50c5-02d` | Sample #6 (125BPM) | loop | bvb | loop | 0.276 | loop | 0.276 | . | 15.36 | 2172 | 0.11 | 0.229 | 0 | 0.26 |
| 104 | `003a71f3-755` | CARTERS REAL ONE SHOT PART | one-shot | goon | loop | 0.276 | loop | 0.276 | . | 33.33 | 2785 | 0.17 | 25.594 | 1 | 0.39 |
| 105 | `003be734-8a9` | minimal 1.4 | loop | - | loop | 0.276 | loop | 0.276 | . | 5.00 | 2304 | 0.06 | 1.061 | 1 | 0.38 |
| 106 | `003c840a-890` | yooooooooooo | loop | speech | loop | 0.316 | loop | 0.316 | . | 10.92 | 0 | 1.00 | 5.549 | 5 | 0.35 |
| 107 | `003ca430-b86` | 1-33333 | one-shot | vientos | hihat | 0.497 | hihat | 0.497 | . | 0.12 | 9162 | 0.71 | 0.037 | 16 | 0.43 |
| 108 | `003d4b10-87f` | SNARE.107.NEPT | one-shot | - | openhat | 0.266 | openhat | 0.266 | . | 0.58 | 3386 | 0.29 | 0.000 | 0 | 0.43 |
| 109 | `003dba4f-862` | echo drums | loop | -jjnhbhgb | bass | 0.457 | bass | 0.457 | . | 14.74 | 84 | 0.00 | 2.752 | 1 | 0.31 |
| 110 | `003dd6ad-d5f` | TD_140_Full Drum Loop_4_FRK | loop | drum | loop | 0.512 | loop | 0.512 | . | 6.86 | 9507 | 0.42 | 2.085 | 3 | 0.45 |
| 111 | `003e6fec-8f6` | 707rimloop | loop | wpx | loop | 0.387 | loop | 0.387 | . | 13.24 | 4347 | 0.24 | 0.000 | 6 | 0.53 |
| 112 | `003ecb28-530` | shells hitting ground | one-shot | shells, bullet, shot, gun | lead | 0.264 | lead | 0.264 | . | 1.66 | 4864 | 0.01 | 0.012 | 2 | 0.55 |
| 113 | `003f11c2-988` | way down kick 180 | loop | kick, drum | loop | 0.316 | loop | 0.253 | ⚑ | 170.67 | 0 | 1.00 | 10.675 | 4 | 0.36 |
| 114 | `003f4647-298` | Hearts of Iron 4 - high resistance sound effect | one-shot | sound, sound, effect, VideoGame | loop | 0.276 | loop | 0.276 | . | 3.08 | 1810 | 0.09 | 0.656 | 0 | 0.31 |
| 115 | `004091da-8bb` | Destroy Pluto Lab Melody (prod. VxCxOUS) 120 bpm C Melodic Minor | loop | vxcxous | loop | 0.512 | loop | 0.512 | . | 14.73 | 4688 | 0.36 | 7.430 | 0 | 0.34 |
| 116 | `00431bd6-17f` | BRLY_ALVE_clap_rapport | one-shot | clap | hihat | 0.294 | hihat | 0.235 | ⚑ | 0.30 | 6137 | 0.57 | 0.000 | 0 | 0.44 |
| 117 | `004377bf-975` | SUB | loop | sub | pad | 0.247 | pad | 0.247 | . | 1.92 | 1230 | 0.03 | 0.960 | 3 | 0.23 |
| 118 | `0043ec33-b14` | DNB SNARE 2 | one-shot | DrumAndBass | hihat | 0.294 | hihat | 0.294 | . | 0.18 | 4081 | 0.37 | 0.012 | 0 | 0.44 |
| 119 | `00446343-0b4` | get like me | loop | gunna | loop | 0.360 | loop | 0.360 | . | 17.45 | 4178 | 0.25 | 7.413 | 0 | 0.34 |
| 120 | `0044e831-3f6` | TAINY_85_drum_loop_nsdmc | loop | drum | loop | 0.360 | loop | 0.360 | . | 5.65 | 4199 | 0.27 | 0.017 | 5 | 0.39 |

Skipped (undecodable in Node, WAV container unsupported variant): `samples/00416898-6618-50b7-b537-5751fa3b2f55` (`DECODE_FAILED`).

---

## 11. Reproducibility, caveats & recorded constraints

- **Reproduce:** `npx tsx --env-file=.env scripts/step42-classification-audit.ts --out <your-dir> --audit-samples 120`. Phase B is deterministic given the same library ordering + PAT scope; `--resume` reuses stored metadata and skips re-enumeration.
- **Caveats to record:**
  1. **Classification columns are DERIVED, not persisted** — no local SampleMap IndexedDB with stored records existed here (verified, §1.3). When a real persisted index exists, re-run the same phase and swap the provenance labels.
  2. Subset is the **first 120** of the recency-ordered library → over-represents `loop`/newer uploads; do not generalize proportions beyond this subset. The global metadata stats (§3) are complete (123,756).
  3. Node decode supports 16-bit RIFF WAV only; 1 sample skipped (`DECODE_FAILED`). Browser decode may differ for non-16-bit WAV/FLAC.
  4. Confidence is a **top-5 softmax fraction**, not an accuracy measure.
- **STEP42 constraints honoured:** read-only; no classification/taxonomy changes; no audio export; raw tags preserved verbatim; no silent fixture substitution; provenance distinguishes *REAL / LIVE / DERIVED / unavailable* (§1).

### Recommendation (for the future reconciliation layer — audit materially informs it)
The data shows the reconciliation layer should (a) **demote the `loop=1.5` shortcut** (or resolve loop vs. content via sub-sampling), (b) treat **family-conflict tags (`conflict=true`)** as correction candidates *only at non-drum/musical boundaries with high tag specificity*, (c) never let genre/artist tags (the majority of real tags: `Trap`, `phonk`, `nbayoungboy`…) influence class, (d) surface `tagEvidence` + `conflict` in the UI, and (e) define a ground-truth set for recall/precision (none exists today).