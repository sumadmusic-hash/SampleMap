# STEP44 — Hierarchical Sound-Type Classification (`hier-v1`) Implementation Report

**Status:** Implemented + evaluated (additive; `heuristic-v1` untouched)
**Date:** 2026-09-09
**Version:** `hier-v1` (identifiers `HierClassifier` id `"hier"`)
**Surface:** unchanged — `primaryClass` / `secondaryClasses` / `confidence` reuse the existing 22-class taxonomy and shapes (SC11); persistence is strictly additive (SC12).

---

## 1. Verdict

`hier-v1` ships a 3-stage hierarchy — **structure (stage 0) → sound family (stage 1) → family-conditional type + optional drum subtype (stage 2)** — then an explicit metadata **reconciliation** stage and a **decision-confidence** computation. It is wired into `AnalysisPipeline` as an additive, optional dependency; when present every new record persists `classificationVersion: "hier-v1"` + a full `hier` tree. The old `heuristic-v1` path, surface vocabulary, search, SoundCharacter, Find Similar, Sound Space, V2 `SC-v1`, and the D1 codec are **unchanged and untouchched** (SC11/SC12). No mass migration runs; old records simply omit the optional `hier` field.

The implementation fixes the STEP42 structural failures as designed in STEP43 §2–4:

| STEP42 failure (heuristic-v1) | hier-v1 behaviour |
|---|---|
| `loop` hard-dominates via `duration > 2.5` race (60% loop labels) | `loop` is a **structure** (`kind=loop`), not a type in the timbre race; kind is authoritative (SC1/SC2) |
| 65% musical-hint rows collapse into `loop` | musical hint → musical/vocal family evidence; `loop` never wins a type race |
| 10/15 ultra-short one-shots auto-`kick` | kick **requires dark spectral energy** (SC4); ultra-short prefers family + `ambiguous` subtype |
| `noise` swallows vocal/musical/fx (V1 flatness only) | family rules are **actively gated** by pitch/harmony and sustained-tonal evidence; atmosphere requires a positive bed signature |
| "calendar-grade" confidence, always 4 secondaries | decision confidence = f(family share, type margin, reconciliation); top-3 runners only; explicit `ambiguous` flag |

---

## 2. Contract (additive)

`src/classify/hier/types.ts`:

```
HierClassification {
  structure: "one-shot" | "loop" | "sustained-phrase"
  family:    "drums" | "musical" | "vocal" | "fx" | "atmosphere-noise" | "unknown"
  type:      ClassId                  // existing 22-class vocabulary
  subtype?:  SubtypeId                // existing drumOntology (16 ids), only when consistent with type
  confidence: number                  // decision confidence, [0.05, 0.95]
  ambiguous: boolean
  classificationVersion: "hier-v1"
  evidence: { audio: { familyScores }, name: NameEvidence, tag: TagEvidence }
  reconciliation: { status, winningSource, agreement, conflict, audioType, nameType?, tagType? }
}
```

- `SampleIndexRecord` gains optional `hier?: HierClassification` (indexStore.ts, STEP44 doc comment). Old records and the `heuristic-v1` branch are untouched (verified: legacy test asserts `classificationVersion: "heuristic-v1"` and `hier` undefined).
- `AnalysisPipeline` deps gain optional `classifyHier?: (input) => Promise<HierResult>`; `buildRecord` gains `classificationVersion` + `hier`. `run()` computes V2 first, then calls `classifyHier` with `{ features, meta:{kind,durationSeconds,name,tags}, v2: analysisV2.features }`; the record stores `classificationVersion: "hier-v1"` and the hier surface as `primaryClass/secondaryClasses/confidence` (SC11).
- `bootstrap.ts` wires the real `HierClassifier`.

**Stop-condition gate (§3/§45):** none triggered — no ML/embeddings/UMAP/t-SNE/ANN, no audio bytes (`assertNoAudioBytes` invariant), no external services, no D1 schema change, no changes to SoundCharacter/Find Similar/Sound Space/`V2.SC-v1`, no changes to any `heuristic-v1` row.

---

## 3. Design decisions (& the weights)

### Stage 0 — structure (`structure.ts`)
Deterministic bind from `(kind, durationSeconds)`, **no timbre race** (SC1/SC2):
- `kind=loop` → `loop` (even short loops); the `duration > 2.5 → loop` shortcut is gone.
- `kind=one-shot` & `duration > 4` → `sustained-phrase` (long one-shots are full takes; never mis-gated to loop).
- else `one-shot`. `SUSTAINED_PHRASE_THRESHOLD_SEC = 4`.

### Stage 1 — family (`family.ts`)
Independent, bounded, additive scores per family over null-safe V1/V2 (`harmonicity`, `pitchConfidence`, `transientStrength`, `attackTimeSec`, `decayTimeSec`, `crestFactor`, `spectralFlux`, `spectralFlatness`, `spectralCentroidHz`, `spectralSpreadHz`):

- **drums** = max(0.35 transient, 0.2 crest, 0.15 fast-attack, 0.15 short-hit, 0.15 low/mid, 0.15 hint) − (0.25 long-phrase gate when sustained-phrase) − (0.2 tonal gate).
- **musical** = 0.3 harmonic + 0.2 pitch + 0.2 tonal + 0.1 sustained + 0.15 sustained-tonal + 0.2 hint; ×0.4 when unvoiced/flat with no hint.
- **vocal** = 0.3 pitch + 0.2 harmonic + 0.15 vocal-band + 0.25 hint; ×0.4 unvoiced-gate when no pitch & no hint.
- **fx** = 0.25 flux(>0.8) + 0.2 inharmonic + 0.2 impact + 0.2 wide-band + 0.25 hint.
- **atmosphere-noise** = 0.25 unpitched + 0.25 unharmonic + 0.25 flat(noisy **and** sustained>1.5s) + 0.15 sustained + 0.1 hint; minus 0.35 voiced-gate, minus 0.3 tonal-gate (flat<0.3 is a line, not a carpet), minus 0.3 evolving-gate (flux>0.8); **×0.25 bedless-gate** when no positive bed signature (flatNoisy&sustained, or wide-band, or sustained, or hint). This is the fix for "absence of voice ≠ noise": `test/reconcile`+42/44 rely on it — a generic mid sample stops flipping to noise and reports family `unknown` at base confidence 0.1.

Decision: top family wins when score ≥ 0.3 **and** margin ratio (top−second)/top ≥ 0.12; otherwise `unknown` (no fabricated winner).

### Stage 2 — type (`type.ts`)
Scored **only within the selected family** (no global 22-class race). Drums and musical use separate metric sets (both V2-preferred, null-safe):

- **kick (SC4/§14):** requires dark spectral energy (centroid < 250 hard for a confident kick; mid material ×0.25, bright → negligible). Never auto-decided by duration.
- **snare/ clap/ hihat/ openhat/ tom/ cymbal/ percussion:** onset-shape based (attack/decay/crest/transientStrength). Clap is penalized ×0.5 on long decay (an open hat/crash is not a clap); cymbal requires a genuinely long ring (>1.2 s) — these two rules separate `openhat` (bright + long decay, mid duration) from clap/cymbal decisively.
- **Ultra-short drums (≤0.35 s):** subtype emitted only when the top-vs-second margin ≥ 0.35; otherwise `percussion` + `ambiguous` (correct family, honest subtype). Medium hits (0.35–0.5 s) keep the standard ≥ 0.18 margin bar so a clean 0.45 s snare is still a snare.
- **musical:** bass (dark/sub-low), piano (tonal+hammer onset, 0.5–3.5 s), guitar (tonal+pluck, 0.5–2 s), strings (sustained non-transient tonal), keys (tonal sustained mid, 0.5–2.5 s), synth (mid tonal sustained), pad (sustained smooth), lead (pitchy sustained bright). `other` (with `ambiguous`) when no candidate fires — a zero-support winner is never fabricated.
- **vocal / fx:** single-type within family. **atmosphere-noise:** `noise` vs `atmosphere` by flatness/bandwidth/sustained.

### Evidence + reconciliation (`evidence.ts`, `reconcile.ts`)
- Name and tags parsed **separately**; boundary-aware phrase matching (`"skick" ≠ kick`, `"808 Kick Punchy" = kick`).
- `TYPE_TERMS` per ClassId; `GENERIC_TERMS` (drum/music/sample/sound/loop/fx/audio/…) are recorded as generic but **never fix a precise type** (§21).
- Subtype evidence reuses the existing `drumOntology` lexicon (`subtypeToType` maps closedhat→hihat, openhat→openhat).
- 5-state reconciliation (§23): **AGREE** (strong audio + matching metadata), **TAG-SUPPORTED** (weak audio, metadata adopts type at *low* confidence — never tag-truth, §26), **AUDIO-SUPPORTED** (strong audio, no usable metadata type), **CONFLICT** (strong audio ≠ metadata, audio wins §24, disagreement preserved), **UNKNOWN** (weak audio + no usable metadata). Metadata pointer precedence name > tag; on weak audio both name+tag types are adopted.

### Confidence (`classify.ts` `computeConfidence`)
Decision confidence, **not** a statistical probability (§11):

```
base = familyShare × (0.5 + 0.5 × typeMargin)      family unknown → base 0.1
AGREE ×1.1 · TAG-SUPPORTED ×1.15 · CONFLICT ×0.8
missing V2 ×0.85
clamp [0.05, 0.95], round4
```

### Surface mapping (SC11)
`primaryClass = family === "unknown" ? "other" : type`; secondaries = top-3 within-family runners × 0.35 (only positive confidences), vocabulary exactly the existing 22 classes (invariant test over real runs).

---

## 4. Evaluation (real dataset; ~180 rows; proxy oracles; §29–§31 scope)

Corpus = the accepted STEP42 120-row ordered scan + 60 stratified additions (30 short one-shots ≤0.5 s, 30 loops ≥4 s), re-analyzed through the **real `AnalysisPipeline`** with `hier` wired (`scripts/step42-classification-audit.ts`; `STEP44_HIER=1 … --audit-samples 120 --stratified 60` → `step44-analysis.ndjson`, 180 rows; 2 decode-failures skipped). Each row carries **both** surfaces over the same real audio/features: heuristic-v1 in `legacy`, hier-v1 in `primaryClass`+`hier`. Metrics table generated by `npx tsx scripts/step44-eval.ts`:

| metric | heuristic-v1 (baseline) | hier-v1 | target / note |
|---|---|---|---|
| loops labelled `loop` (of n_loops=105) | 84% | 0% | loops keep `kind=loop`; label is a structure, not a race (SC1) |
| `loop` labels overall (n=180) | 63% (113) | 0% (0) | musical-hint→loop collapse eliminated |
| loop rows whose `structure` stays `loop` (SC2) | — | 100% (105/105) | kind authoritative; no duration gate |
| ultra-short one-shots ≤0.5 s → `kick` | 13/24 | 6/24 | duration NEVER auto-kicks (SC4); surviving kicks are dark |
| ultra-short → `percussion` + ambiguous | — | 4/24 (17 of 24 ambiguous overall) | honest fallback over wrong certainty (§14) |
| one-shots → `loop` | 33% | 0% | no tag/duration race on one-shots |
| confidence min / max | 0.2245 / 0.5791 | 0.1583 / 0.4731 | bounded [0.05, 0.95] |
| confidence mean / <0.35 / <0.30 | — / 72.5% / — | 0.2594 / 96% / 81% | honesly low when uncertain (§11) |
| rows with ≥1 secondary class | 100% (always 4) | 99% (3:161, 2:15, 1:2, 0:2) | top-3 runners only (§15) |
| explicit vocal tag → `vocal` | — | 90% (18/20) | tag corroborates, never truth (§26) |
| reconciliation distribution | — | TAG-SUPPORTED 84, UNKNOWN 73, AUDIO-SUPPORTED 12, CONFLICT 8, AGREE 3 | 5-state (§23) |
| family distribution | — | musical 140, drums 36, atmosphere-noise 2, vocal 1, fx 1 | — |
| ambiguous flag set | — | 87% | explicit uncertainty (§28) |
| subtype resolved (drum ontology) | — | 20/180 | optional, only when consistent with type (§15) |

Highlight reset cases on real audio (from the corpus):
- `Juul perc` 0.122 s → heuristic `kick` 0.28; hier **percussion + ambiguous** (SC4; the STEP42 auto-kick).
- `OTHER LOOP` 14 s, tag `rap` → heuristic `loop` 0.28; hier structure `loop`, family musical, type **vocal** (TAG-SUPPORTED, low confidence) — no loop-collapse, vocal tag corroborates rather than verifies.
- `YK kick 2` 0.21 s → both `kick`; hier AGREE, confidence 0.35 vs heuristic 0.25.

**Interpretation, scoped honestly:** confidence dropped further below heuristic (96% < 0.35). That is deliberate — with 87% of rows ambiguous and reconciliation dominated by TAG-SUPPORTED/UNKNOWN, the classifier refuses to be certain on proxy evidence. Per §29–§31 this ~180-row corpus can only bound family/structure behaviour; universal calibration is **not** claimed. The "loop label eliminated" line is the SC1/C2 design (loop is a structure on `kind`), not a regression: search-by-loop continues to use `kind`.

---

## 5. Compatibility & gates

- **SC11:** surface vocabulary = the existing 22 classes (`ALL_CLASSES` invariant test over real rows, incl. reconciliation-promoted families). `searchEngine`, `IndexedDB` primaryClass index, D1/hydrate/`isKnownClass` all unchanged.
- **SC12:** `hier` is additive-only. Pipeline test asserts: with `classifyHier` → `classificationVersion: "hier-v1"` + well-formed `hier` (+ `assertNoAudioBytes` passes); without → `heuristic-v1` record with `hier` undefined and `classifier.classify` invoked. Legacy rows untouched; no migration.
- **Typecheck:** `npm run typecheck` clean. **Tests:** full repo `vitest run` → **74 files, 1283/1283 pass**, including the new `src/classify/hier/hier.test.ts` (54 tests: structure 1–6, drums 7–14, ultra-short 15–18, musical 19–25, vocal 26–28, fx/bins 29–33, reconciliation 34–42, null-safe V2 43–45, invariants, `HierClassifier` contract) and the two new pipeline integration tests.

---

## 6. Non-goals / deferred

- The optional structural facet index (`kind`-filterable search) noted in STEP43 §4.1 is **not** built here.
- `loop` stays a structural attribute; the ClassId `loop` is no longer emitted by hier surfaces (legacy rows keep whatever they had). Downstream loop browsing uses `kind` (dataset: 69,871 loops).
- Re-classifying historical `heuristic-v1` rows is out of scope (SC12): future pipeline passes write `hier-v1` naturally.

---

## 7. Traceability

- Sources: `src/classify/hier/{types,structure,family,type,evidence,reconcile,classify,round}.ts`, `src/classify/hierClassifier.ts`, `src/pipeline/analysisPipeline.ts`, `src/persistence/indexStore.ts`, `src/ui/bootstrap.ts`.
- Tests: `src/classify/hier/hier.test.ts` (54), pipeline integration in `src/pipeline/analysisPipeline.test.ts` (+2).
- Audit/eval: `scripts/step42-classification-audit.ts` (STEP44-hier mode), `scripts/step44-eval.ts`.
- Data: `/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step42/step44-analysis.ndjson` (180), `step44-audit-summary.json`, `step44-full.log`; metadata base `step42-metadata.ndjson` (123,756).
- Non-negotiable bounds honoured: no ML/embeddings, no audio bytes in records, no external services, no D1 schema change, no changes to STEP37/39/40 outputs.

---

## 8. Addendum (2026-09-09, STEP44.1) — family/type coherence fix

STEP44.1 measured that hier-v1 could emit `hier.family` contradicting the
decided type on `TAG-SUPPORTED` rows (e.g. `type=vocal`, `family=musical`):
35/180 rows in the STEP44 audit (19.4%). Root cause: `classify.ts` promoted the
metadata family only when the acoustic family was `unknown`. **Fix applied in
STEP44.1:** `family = familyOfType(type)` whenever the tag/name adopts the type
(the acoustic picture remains in `evidence.audio.familyScores`). Type,
confidence and reconciliation logic are unchanged by construction.

Effects (measured):
- Coherence `family == familyOfType(type)`: **180/180** on the re-audit set.
- Step44 re-audit on the fixed code (regenerated at
  `/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step44.1-step44rerun/step44-analysis.ndjson`):
  loop collapse 63%→0, loop-structure 105/105, ultra-short kick 6/24,
  voc-tag→vocal 18/20, reconciliation TAG-SUPPORTED 84 / UNKNOWN 73 /
  AUDIO-SUPPORTED 12 / CONFLICT 8 / AGREE 3 (all unchanged); family
  distribution musical 110 / drums 38 / vocal 23 / atmosphere-noise 6 / fx 3
  (was musical 140 / drums 36 / vocal 1 / fx 1 / atmosphere-noise 2) — the 30
  shifted rows now carry their type’s family.
- Full suite 1283/1283 green; `npm run typecheck` clean.