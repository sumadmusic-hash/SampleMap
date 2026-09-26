# 16Q SPEC BLOCKER REPORT — Map position not reconstructable from persisted features

Status: **BLOCKER — analysis only. No code changed. Waiting on minimal spec decision.**

---

## 1. Conflict

STEP 16Q §1 requires the V2 X-axis to use a **whole-sample multi-window flatness** computed
over **decoded audio** (`DecodedAudio`, windows of 2048 frames, hop 1024, ≤16, median).
STEP 16Q §4 wants `computePosition(features, decodedAudio)` as the authority.

But the existing Step 16C/16D/16M architecture computes every map position **on the fly from
the persisted `AudioFeatures` alone** — no audio — via `mapPosition(features)` ("§26:
recompute, not re-analyze"). The persisted `AudioFeatures` contains only the **1024-sample
one-shot `spectralFlatness`** (`featureExtractor.ts`), **not** any whole-sample flatness.

Therefore a V2 position built from decoded audio **cannot be reconstructed** from the
persisted `audioFeatures`. Any consumer that recomputes `mapPosition(features)` would
silently produce a V1 (single-window) position → the exact "old + new semantics in parallel"
that §4 forbids.

The binding requirements are mutually incompatible as written:

- V2 position requires whole-sample flatness from audio (16Q §1).
- `AudioFeatures` must not change (16Q §5).
- Persistence must not change (16Q §5).
- Global must not change (16Q §5).
- No parallel old/new position semantics (16Q §4).
- Recompute-from-features must keep working audio-free (16D §26, 16Q §8).

You cannot have a position that depends on audio, persist only audio-derived features (not the
position), and still recompute it audio-free.

---

## 2. Why it is unavoidable

- **`spectralFlatness` is insufficient by design** — it is one 2048→1024∗ FFT at the sample
  start. V2 *must* replace it with a whole-sample median over N windows, which is a genuinely
  different computation over raw PCM.
- **`AudioFeatures` is the only persisted proxy** — the record stores features, not audio and
  not the map. With V1, `mapPosition(features)` happened to be audio-free, so recompute
  worked. With V2, the needed quantity is not in `AudioFeatures`, so recompute from features
  is mathematically impossible without either (a) persisting the V2 position, (b) extending
  `AudioFeatures`, or (c) re-decoding audio (forbidden by §26 / no-audio invariant).

∗ V1 `FFT_SIZE = 1024`; V2 uses 2048. Both single-FFT-based for persisted `spectralFlatness`.

---

## 3. Current affected paths (verified)

`SampleIndexRecord` (`src/persistence/indexStore.ts:36-89`) has **no `map` field** — map
position is a derived value, recomputed at read time in every consumer:

| Path | File | Behavior |
|------|------|----------|
| Publish | `src/global/publish.ts:142` | `createPublishCandidate` builds `analysis.map = { mapVersion, x, y }` via `mapPosition(record.audioFeatures)` — **recomputes, generates** the position for the global candidate. |
| Validation | `src/global/validation.ts:93-106` | recomputes `mapPosition(result.features)` and **cross-checks** the submitted `analysis.map.x/y` against features (consistency gate). |
| Global contract | `src/global/contract.ts`, `schema.ts` | defines `analysis.map` shape; carried in the candidate/published result. |
| Harness | `src/e2e/harness/main.ts:301` | recomputes `p = mapPosition(rec.audioFeatures)` for DOM placement + determinism test. |
| 16M live verify | `scripts/step16m-live-verify.ts:236` | recomputes and cross-checks position vs record. |
| UI/map | `src/ui/map/*` | reads positions derived from features for rendering. |

So **both** "compute the position" (publish/harness/UI) and "validate the position"
(validation) depend on `mapPosition(features)` being audio-free and reproducible from
`AudioFeatures`.

---

## 4. Recommended resolution

Adopt your preferred model: **persist the authoritative V2 `mapPosition` at analysis time
(when decoded audio is present), and have all downstream consumers read/validate the stored
position — never recompute whole-sample flatness from features.**

Concretely the V2 data flow becomes:

1. **Analysis time (audio available):** compute whole-sample flatness → V2 position →
   store as map metadata on the record. This is the single authoritative position.
2. **Publish:** read the stored `map.x/map.y` (no audio, no recompute of flatness).
3. **Validation:** validate *consistency* — e.g. that `analysis.mapVersion === V2` and that
   the stored position is present/in-range — but **must not** attempt to re-derive
   whole-sample flatness from `audioFeatures`.
4. **Harness/UI:** read the stored position; the determinism/recompute tests are re-scoped to
   assert the *stored* position is stable and persists across reload, not that it equals
   `mapPosition(audioFeatures)`.

This keeps: no `AudioFeatures` change, no corpus normalization, no parallel semantics (only
one stored V2 position), determinism, reload-stability, audio-free downstream.

---

## 5. Exact spec text that must change

The conflict lives in **$26 / the "recompute, not re-analyze" invariant** and its duplicated
justifications. Proposed edits (wording to be confirmed by the spec owner):

1. **`src/global/publish.ts:110-112` + `140-141` + `142`**
   - Current: “Map position is recomputed from `audioFeatures` via the existing `mapPosition`
     authority (§26: recompute, not re-analyze). … Map position is a pure function of
     audioFeatures — recomputed, never downloaded.”
   - Must become: “The V2 map position is a **persisted analysis result** stored at analysis
     time from decoded audio. Publish reads the stored `map.x/map.y`; it does **not**
     recompute whole-sample flatness from `audioFeatures` (impossible / would be V1).”
   - Code: replace `const pos = mapPosition(record.audioFeatures)` with reading the stored
     position.

2. **`src/global/validation.ts:90-106`** — “derived-value cross-check WITHOUT audio: map +
   fingerprint are pure functions of features.” The **map** is no longer derivable from
   features. Must change so validation checks the stored V2 position for presence/range/
   version consistency instead of re-deriving it; fingerprint remains a pure function of
   features and keeps the existing cross-check.

3. **`src/global/contract.ts` / `schema.ts` / `contract.test.ts` / `schema.test.ts`** — the
   single-authority test “delegates to the single authority (mapPosition), no second
   projection” (`contract.test.ts:235-237`) and the `deriveMapPosition`/`mapPosition` equality
   assertions become invalid for V2 and must be re-scoped.

4. **`src/e2e/harness/main.ts:301`** + **`e2e/step16m.spec.ts:163`** + **`scripts/step16m-live-verify.ts:236,274-275`** —
   determinism/recompute assertions must read the stored V2 position and assert stability
   (persisted, reload-stable), not equality with `mapPosition(audioFeatures)`.

5. **`src/map/mapPosition.ts`** — `mapVersion` changes to a V2 token; the old
   `mapPosition(features)` body (single-window `1 - flatness`) is replaced by
   `computePosition(features, decodedAudio)`. The V1-only accessor is removed to avoid dual
   semantics.

The governing spec line that must be amended is **Step 16D §26** (“recompute derived fields,
don’t re-analyze”): for *map position*, V2 moves from “recompute from features” to
“persist at analysis and read/validate downstream.” Similarity fingerprint and classification
remain recomputed-from-features and are untouched.

---

## 6. Code changes required AFTER the spec decision (not now)

- `src/map/mapPosition.ts`: add `computePosition(features, decodedAudio)` computing
  whole-sample multi-window flatness (2048/Hann/hop 1024/≤16/median) + log-SNR X + log-Y;
  bump `mapVersion` to V2; remove V1 body/`mapPosition(features)` accessor.
- `src/map/mapPosition.test.ts`: new X/Y/multi-window/determinism tests per 16Q §6; drop
  V1-only assertions.
- Persistence (`SampleIndexRecord`): add a map position field (analysis result), populated by
  the analysis pipeline when decoded audio exists.
- `src/global/publish.ts`: read stored position.
- `src/global/validation.ts`: validate stored position (presence/range/version), drop
  feature-recompute cross-check for map.
- `src/global/contract.ts` / `schema.ts` + tests: re-scope single-authority map assertions.
- `src/e2e/harness/main.ts` + `e2e/step16m.spec.ts` + `scripts/step16m-live-verify.ts`: read
  stored position; assert stability/persistence.
- `scripts/analyze-map-x.ts`: AFTER comparison path uses `computePosition(features, decoded)`
  at analysis (audio available), not recompute from features.
- `src/ui/map/*`: read stored position (no feature recompute).

---

### ADOPTED ARCHITECTURE DECISION (binding, approved 16Q)

The conflict is resolved by the "recommended resolution" from §4, ratified as binding for V1:

**Map Position V2 is a persisted analysis result.** It is computed exactly once at analysis
time (where `decodedAudio` is available) and stored on `SampleIndexRecord`. Downstream
consumers (Publish, Validation, Global, Harness, UI) **read and validate the persisted V2
position** and **must never reconstruct it from `AudioFeatures`.**

This is the explicit, granted exception to the Step 16D §26 "recompute, not re-analyze"
assumption, scoped to `mapPosition` only:

> **Map Position V2 is persisted at analysis time because its authoritative computation
> requires decoded audio. Downstream consumers must read and validate the persisted V2
> position and must not reconstruct it from `AudioFeatures`.**

Binding rules (ratified):

1. `AudioFeatures` is NOT extended; no whole-sample flatness is added to it.
2. Audio is NOT persisted. `SampleIndexRecord` gains an explicit `mapPosition` field
   (persisted analysis result) — the one approved persistence change.
3. No V1 `mapPosition(features)` fallback exists. A missing persisted V2 position means the
   consumer reports a clear Missing-V2 state; it never computes a V1 position.
4. Similarity fingerprint and classification remain recomputable-from-features, unchanged.
5. No corpus normalization; determinism and reload-stability hold because the stored
   position is a pure function of decoded audio + fixed anchors, computed once.

Per the approval, implementation of the §6 changes may now proceed. See
`STEP16Q_IMPLEMENTATION.md` for the executed result.
