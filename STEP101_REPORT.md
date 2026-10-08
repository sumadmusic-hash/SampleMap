# STEP101 — Stop discarding the drum type: §14 abstention re-anchored (+12.6 pp acoustic accuracy)

**Date:** 2026-10-08 · **Baseline commit:** `6d386b7` (STEP100) · **Type:** behaviour change
in the hierarchical drum type decision + test updates.

**Verdict:** implemented and verified on real audio. **Acoustic drum-type accuracy
19.3 % → 31.9 %** on the reliable one-shot corpus; shipped output on that subset
**unchanged** (112/135); `tsc` clean · `vite build` ok · **90 files / 1601 tests**.

---

## 1. What STEP100 left behind

STEP100 established that the reconciled accuracy (83 %) is circular — its ground truth is
the same name/tag text the classifier consumes — and that the honest metric is the
**acoustic-only** path: **26/135 = 19.3 %**, or **23.6 %** among the rows where the
acoustic classifier commits to the drums family. It also showed *why*: acoustic decisions
were dominated by **`percussion` (52 of 135 = 39 %)**, because the STEP44 §14 gate
overwrites the type with `percussion` whenever a hit is ≤ 0.35 s and the within-family
margin is below 0.35. Measured per label: hihat 0/17, cymbal 0/7, clap 1/12.

## 2. The change

`src/classify/hier/type.ts`, `decideWithin` — the §14 branch:

```diff
   if (veryShort && rawMargin < ULTRA_SHORT_SUBTYPE_MIN_MARGIN) {
-    type = "percussion";
     ambiguous = true;
   }
```

The gate was doing two things: flagging uncertainty, and **destroying the computed
type**. Only the first is the honest signal §14 was created for, so only the second is
removed. The best-scoring type is reported, `ambiguous` still marks it as unresolved —
which also means `audioStrong` and therefore metadata adoption behave exactly as before.

## 3. Verification (real audio, non-circular metric)

**Offline A/B** (`scripts/step100-offline-eval.ts`, identical stored features):

| metric | before | after |
|---|---|---|
| reconciled (audio+name+tag) | 112/135 = 83.0 % | **112/135 = 83.0 %** (unchanged) |
| **acoustic-only** | 26/135 = 19.3 % | **43/135 = 31.9 %** (+12.6 pp) |

Per-sample in the acoustic path: **21 fixed, 4 regressed** (net +17). The 21 are claps,
hi-hats, snares and kicks that were being collapsed into `percussion`; the 4 regressions
are samples whose own user label is `percussion` and which now receive a concrete type —
i.e. exactly the abstention that §14 was designed to prefer.

A margin-gate sweep confirmed the mechanism and that this variant is the right one:

| gate value | acoustic-only |
|---|---|
| 0.35 (baseline) | 19.3 % |
| 0.15 | 17.8 % |
| 0.10 | 23.7 % |
| 0.05 | 29.6 % |
| 0.00 (type kept, **without** the `ambiguous` flag) | 31.9 % |
| **0.00 + `ambiguous` kept (shipped)** | **31.9 %** … and reconciled **unchanged** |

Dropping the type overwrite alone (gate 0.00) reaches the same acoustic number but throws
away the uncertainty flag — which is what keeps the reconciled output stable. Shipping the
flag is what makes this safe.

**Full online corpus confirmation** (383 samples re-downloaded, re-analysed, real WAV):

| | before | after |
|---|---|---|
| reliable one-shots, shipped output | 112/135 = 83.0 % | **112/135 = 83.0 %** |
| per-sample on the reliable subset | — | **0 fixed / 0 regressed** |
| all 383 rows, shipped `primaryClass` | — | **4 rows changed** |

The 4 changed rows are **all outside the reliable subset** — their labels are unreliable by
construction (name and tag do not agree) — and they are the only shipped-visible effect:
`DS11` percussion→synth, `HiHat 5` percussion→clap, `DD_Tom_5` tom→snare,
`BREAK RIDE CYMBAL` percussion→clap. Metadata is byte-identical between the two runs
(0 rows changed tags/name/kind) and both runs cover the same 383 sample ids, so the
difference is the code, not the library.

### Why this is still the right trade

The corpus is 100 % tag-labelled by construction, so metadata already rescues the correct
type there — which is why the shipped output on the reliable subset does not move. But
only ~10.6 % of the enumerated library (528 of 5,000) carries an unambiguous drum tag at
all; for the remaining ~89 % there is no type evidence to adopt, so **the acoustic type is
the shipped output**. That is the population this change improves, by +12.6 pp on a metric
that cannot be gamed by metadata.

## 4. Test updates (deliberate, not cosmetic)

Three tests pinned the old behaviour and were re-stated to the new one, each keeping the
assertion that mattered and adding the preserved uncertainty flag:

| test | was | now |
|---|---|---|
| 14 | "short ambiguous hit → percussion, NOT kick" | best-scoring type reported, `ambiguous` true, still **not** kick |
| 47 | "generic short bright transient stays percussion" | reports `snare`, `ambiguous` true, still **no fabricated subtype** |
| 49 | "closed-hat profile → percussion (tags rescue to hihat)" | closed-hat profile resolves to **`hihat`** directly, `ambiguous` true; the ringing-hat → `openhat` part is untouched |

Test 49 is the clearest illustration: the acoustic classifier now reaches the same answer
the tag provided, so the "rescue" is no longer needed.

## 5. Reversal of a documented design decision

STEP44 §14 chose "prefer correct family + ambiguous subtype over a confident guess", and
this change keeps the *family* and the *ambiguity* but no longer discards the type. It is a
conscious reversal of the type-overwrite, justified by measurement: resolving gains
12.6 pp on 21 samples while costing 4 (`percussion`-labelled) abstentions. A one-line
revert restores the previous behaviour.

## 6. Verification summary

| check | result |
|---|---|
| `tsc --noEmit` | clean |
| `npm run build` | ok |
| `vitest run` | 90 files / **1601 tests**, two consecutive clean runs |
| offline A/B | acoustic 19.3 % → 31.9 %; reconciled unchanged |
| full online corpus | reliable subset 112/135 unchanged, 0/0; 4 shipped rows changed |

## 7. Traceability

* Source: `src/classify/hier/type.ts` (`decideWithin`, §14 branch).
* Tests: `src/classify/hier/hier.test.ts` tests 14, 47, 49.
* Tooling: `scripts/step100-offline-eval.ts`, `scripts/step98-drum-corpus.ts`.
* Corpora: `…/T/opencode/step100-features/` (old code), `…/step101-after/` (new code).
* Prior art: `STEP100_REPORT.md` (the circularity finding), `STEP44_HIERARCHICAL_CLASSIFICATION_REPORT.md`
  §14 (the ultra-short fallback being re-anchored).
