# STEP98 — Drum recognition measured against USER TAGS (real library + real audio)

**Date:** 2026-10-08 · **Baseline commit:** `d59b720` (STEP97) · **Type:** measurement
infrastructure + a measured vocabulary extension. No acoustic threshold, weight, schema,
contract or UI change.

**Verdict:** measurement delivered and reproducible · vocabulary gap fixed and verified
(`tsc` clean, `vite build` ok, **90 files / 1601 tests**).

---

## 1. Objective and method

The goal was to improve drum recognition *using the tags users set*. Tags are already
consumed by the classifier as weak evidence (`TAG-SUPPORTED`; a tag never overrides strong
audio). Before tuning anything, the honest first question is **what the tags actually
contain and how well the current classifier agrees with them** — the project's rule is to
calibrate only against measured data.

Three reproducible, read-only measurement tools were built (all metadata-only unless
stated; no credential is printed, no write endpoint is touched, nothing is written into
the repository):

| Script | What it does |
|---|---|
| `scripts/step98-tag-vocabulary.ts` | Enumerates the public library via `samples.list` (AT_PAT) and measures how much of the real tag vocabulary the classifier understands (`TYPE_TERMS`, `TAG_SUBTYPE_ALIASES`, `GENERIC_TERMS`). |
| `scripts/step98-drum-agreement.ts` | Joins tags to the **published** `primaryClass` by sample id (`POST /samples/lookup`, public read) — no audio downloaded. |
| `scripts/step98-drum-corpus.ts` | Downloads the **real WAV audio** of drum-tagged samples and runs the CURRENT pipeline over it, so results describe the code as of STEP97 rather than stale published rows. |

---

## 2. Finding A — the tag vocabulary is mostly *not* type information

Enumerating 5,000 samples (9,115 tag occurrences, 2,529 distinct normalized tags):

| recognition class | occurrences | share |
|---|---|---|
| specific drum subtype | 668 | 7.3 % |
| drum type (`TYPE_TERMS`) | 100 | 1.1 % |
| other type (musical/vocal/fx/…) | 1,717 | 18.8 % |
| generic (drum/music/sample/loop/…) | 587 | 6.4 % |
| **unrecognised** | **6,043** | **66.3 %** |

**The recognised share is 33.7 %.** The unrecognised mass is dominated by *genre and style*
tags — `trap`, `lofi`, `hiphop`, `techno`, `phonk`, `house`, `drumandbass`, `edm`, producer
names — which carry **no sound-type information** and must not be turned into type aliases.
This puts a hard ceiling on how much tag-driven recognition can be "perfected": tags are a
useful secondary signal, not a label set.

### The vocabulary gap that IS real, and the fix

Manual review of the unrecognised tags that co-occur on drum-tagged samples, plus the
unrecognised tags overall, yielded eight genuinely missed drum/instrument terms. All were
added to the existing alias tables (`src/classify/hier/evidence.ts`,
`src/classify/drumOntology.ts`):

| term | occurrences (5 k corpus) | now recognised as |
|---|---|---|
| `synthesiser` (British spelling) | **85** | `synth` |
| `basedrum` / `base drum` | 5 | `kick` |
| `hh` | 4 | `closedhat` |
| `bd` | 3 | `kick` |
| `sd` | 3 | `snare` |
| `snap` | 2 | `clap` |
| `hithat` (misspelling) | 2 | `hihat` |
| `percu` | 1 | `percussion` |

Plus `hit` as a **drums family hint** only (never a type).

**Measured effect (same 5,000-sample corpus, before → after):**

| | before | after | delta |
|---|---|---|---|
| unrecognised occurrences | 6,043 | 5,938 | **−105** |
| recognised share | 33.70 % | **34.85 %** | +1.15 pp |
| drum-evidence occurrences | 768 | 788 | +20 |

A per-tag diff confirms **exactly 8 tags changed class and nothing else** — no tag was
mis-assigned to a wrong type. `808`/`909`/`707` were deliberately **not** added: `808` is
as often an 808 *bass* as a kick, and mapping it to drums would misroute trap bass lines.

Multi-tag composition was measured as a possible structural win (users tag `open` + `hat`
separately): joining a sample's tags recovers a phrase no single tag carries in only
**7 of 5,000 samples** — not worth the complexity.

---

## 3. Finding B — one-shots agree well, loops surface as `other`

### B1. Against the *published* classifications (20,000 samples, no audio)

2,089 samples carried an unambiguous drum tag; 293 of them are present in the global index
(the index covers a small fraction of the public catalogue):

| kind | n | predicted as drums | exact type |
|---|---|---|---|
| one-shot | 212 | 92 % | 69 % |
| **loop** | 81 | **48 %** | 46 % |

These published rows were produced **before** the STEP97 feature fix, so they describe the
broken-feature era — a useful baseline, not the current code.

### B2. Against the CURRENT pipeline (real audio downloaded and analyzed)

383 drum-tagged samples (196 one-shots / 187 loops) analyzed with the code as of STEP97:

| kind | n | drums family | drum type | exact type |
|---|---|---|---|---|
| one-shot | 196 | **94.4 %** | 94.4 % | **76.5 %** |
| loop | 187 | **78 %** | 0 % | 0 % |

**The loop row is STEP96 by design** — a drum-family loop deliberately gets the neutral
type `other` so no single one-shot hit is claimed. The measured consequence, which was not
visible before this corpus:

> **145 of 187 drum-tagged loops (78 %) are correctly recognised as the drums family but
> surface as `primaryClass: "other"`.**

`other` belongs to the taxonomy's *Other* group, not *Drums* — so every drum loop leaves
the drums bucket in the class filter, in search and in the map colouring. For a product
whose content is "hauptsächlich drumsamples", this is a real browsability regression, and
it is the single largest measured effect in this step.

### B3. One-shot accuracy by tag label (n = 196)

| tag label | correct / n | accuracy | drums family |
|---|---|---|---|
| clap | 13 / 13 | **100 %** | 100 % |
| snare | 33 / 39 | 85 % | 95 % |
| hihat | 21 / 25 | 84 % | 100 % |
| kick | 47 / 59 | 80 % | 100 % |
| tom | 6 / 8 | 75 % | 100 % |
| cymbal | 8 / 12 | 67 % | 75 % |
| **percussion** | **22 / 40** | **55 %** | 85 % |
| **total** | **150 / 196** | **76.5 %** | **94.4 %** |

The weakest class is `percussion` (55 %), leaking to `lead`, `snare`, `kick`, `openhat`,
`clap`. This number must be read with care: `percussion` is a **catch-all tag**, so a
sample tagged `percussion` that the classifier calls `snare` is not necessarily wrong —
the tag is. It is therefore a lower bound on quality, not a clean error rate, and it is
**deliberately not tuned against** in this step (fitting a threshold to a noisy catch-all
label would lower real accuracy).

Loop family errors (22 %) are similarly mixed: some are genuine misses (`think break
shaker` → `lead`, `UF_Drum Loop_Broken Beat` → `synth`), others are correct audio wins over
a wrong tag (`t-this-b!tc#-up-synth-01` tagged `kick` is a synth).

---

## 4. What changed in this step

* `src/classify/hier/evidence.ts` — 7 new type aliases (`basedrum`, `base drum`, `snap`,
  `snaps`, `hithat`, `percu`, `synthesiser`), `hit` added as a drums family hint only.
* `src/classify/drumOntology.ts` — short exact markers `bd` (kick), `sd` (snare),
  `hh` (closedhat), plus `basedrum`/`base drum` and `snap`/`snaps`/`percu` phrases, matching
  the existing `chh`/`ohh` precedent for whole-token abbreviations.
* Three reusable measurement scripts (§1).

Verified: `tsc --noEmit` clean, `vite build` ok, **90 files / 1601 tests pass**.

## 5. Explicitly NOT changed

* No acoustic threshold or weight. The measured weaknesses (§3 B3) are label-noisy and must
  not be tuned blind.
* No change to the loop surface class — see §6.
* No re-analysis, no publish, no D1 write.

## 6. Open decision (needs the product owner)

**Should a drum-family LOOP surface as `percussion` instead of `other`?** STEP96 chose the
neutral `other` (the approved option explicitly listed `percussion` among the types to
neutralise). The corpus now shows the cost: 145/187 drum loops leave the drums bucket.
`percussion` would keep them browsable as drums without claiming a specific one-shot hit
(`kick`/`snare`/…) — it is the drums-family class for percussive material. This is a
one-line change in `mapToSurface` plus test updates, and it is a product decision, not a
technical one.

## 7. Traceability

* Scripts: `scripts/step98-tag-vocabulary.ts`, `scripts/step98-drum-agreement.ts`,
  `scripts/step98-drum-corpus.ts`. Outputs (temp, not the repo):
  `/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step98/`.
* Sources: `src/classify/hier/evidence.ts` (`TYPE_TERMS`, `FAMILY_HINT_TERMS`),
  `src/classify/drumOntology.ts` (`TAG_SUBTYPE_ALIASES`), `src/classify/hier/classify.ts`
  (`mapToSurface`, STEP96 loop rule), `src/classify/normalizeTag.ts`.
* Data provenance: live Audiotool `samples.list` metadata (raw user tags, verbatim) via
  AT_PAT; live WAV audio of a bounded subset; public read-only `POST /samples/lookup`.
  No audio bytes persisted, no write endpoint used.
* Prior art: `STEP44_HIERARCHICAL_CLASSIFICATION_REPORT.md` (tag evidence, §21 generic
  terms, §26 tags never truth), `STEP96_REPORT.md` (loop rule), `STEP97_REPORT.md` (feature
  fix that this corpus validates).
