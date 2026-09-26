# STEP37 — Map Architecture, Projection Reconciliation & Sound-Space Canonicalization

Date: 2026-09-08 · Scope: map rendering, V2 Sound Space, tests, live verification

## 1. Objective & constraints

Map A and Map B rendered the same sample library through **two different
coordinate functions**, so the main map could not be trusted as a
disk-representation of the V2 Sound Space. STEP37 had to:

1. Identify both implementations and reconcile them mathematically;
2. Prove the difference with live evidence, then pick ONE canonical projection
   — **not** on looks, without arbitrary clamping, and without violating the
   STEP36 guarantees;
3. Fix corner-label defects on both map surfaces (missing top-right label,
   lower-left overlap);
4. Add regression tests, verify live (gates L1–L11), and deliver diagnostics +
   this report.

Explicitly **out of scope** (§2 of STEP37): no UI redesign, no arbitrary
distribution clamping, no change to the audio/storage policy, no change to the
frozen V1 analysis, no regression of any STEP36 guarantee.

## 2. The two maps (architectural audit)

| | **MAP A** (main SampleMap) | **MAP B** (Sound Space panel) |
|---|---|---|
| Entry | `renderMapPanel` → `renderSampleMap` | `app.openSoundSpace()` → `index.getAll()` → `projectAll` |
| View-model | `mapPoints` (pure, content-hash dedup, `toScreen` y-invert) | scatter over `projectAll` |
| Coordinate fn | `computePosition` (`src/map/mapPosition.ts`, `mapVersion="map-v2"`) | `createSoundSpaceProjector()` (`src/analysis/soundSpaceProjector.ts`) |
| X | tonal↔noisy via whole-sample flatness **log SNR** (analysis-time, audio-derived) | `mean(tonality, 1−noisiness)` over present dims only |
| Y | dark↔bright via **log spectralCentroid**; level-mean anchor; `logCentroidTemp` fallback | `brightness` |
| Missing dims | SNR/centroid machinery fabricates a value | null dims never contribute; **no point** iff X or Y uncomputable |
| Color | `classColor(primaryClass)` (heuristic-v1 classifier) | monochrome `var(--accent)` |
| Dedup | content-hash | none |

There is also a frozen, non-rendered baseline V2 projector
(`src/analysis/mapProjector.ts`) used only in its own test — it was the subject
of the old STEP28.5R `C — PROJECTION COMPRESSES SPATIAL DISTRIBUTION` finding,
which is **not reachable** in any product-rendered projection.

### 2.1 Live reconciliation evidence (`map_audit.ts`, live ×200 records)

- MAP A vs MAP B: x-correlation **0.140**, y-correlation **0.618** →
  genuinely different projections.
- MAP A: x mean **0.915**, median 0.972, **90/200 points at x≥0.99 (45%)**
  (right-edge), stddev 0.185.
- MAP B: x mean **0.857**, **only 5 points at x≥0.99**, min-x 0.4467 → the
  canonical range is fully occupied (no empty hole); the brightness spread is
  native (y p10=0.176 vs p90=0.778).
- Conclusion: MAP A's right-edge is caused by MAP A's own SNR-compressed
  feature extraction upstream of the projector — not by any product rendering.
  Full evidence: `/tmp/samplemap-step37-map-audit.json`.

## 3. Canonical determination (mathematical + documented semantics)

**Canonical = MAP B (V2 Sound Space `SOUND_SPACE_ALGORITHM_VERSION "1.0.0"`):**

1. **Documented axis semantics** (§14): x = "Noisy ↔ Tonal" from
   `mean(tonality, 1−noisiness)`, y = "Dark ↔ Bright" from `brightness` —
   the only coordinate contract whose meaning is derivable from source.
2. **Null honesty** (§11): null dims never contribute; a point exists iff both
   axes are computable — it never fabricates a position.
3. **Pure & deterministic**: projection is a pure function of one record
   (corpus independence). No dedup, no camera, no metadata influence (§57,
   id/name/class never affect position).
4. It is the only surface whose corner-label semantics are atomic and
   non-overlapping after the fix below.

Selection rule applied ("whether the map lies"): the two maps differed
materially (**x-corr 0.140**); MAP A's distribution is an artifact of its own
SNR compression; a canonicalized MAP A would simply re-derive positions from
the same geometry MAP B already implements — so the canonical coordinate is the
V2 Sound Character → projector → point pipeline, and the SampleMap renders from
it, with the persisted `mapPosition` kept strictly as a **data-availability
fallback** for pre-V2/unprojectable records (never recomputed from features).

## 4. Canonical coordinate boundary (single function)

`src/analysis/soundSpaceProjector.ts`:

```ts
const CANONICAL_SOUND_SPACE_PROJECTOR = createSoundSpaceProjector();
export function computeCanonicalSoundSpacePoint(record): SoundSpacePoint | null {
  return projectSample(CANONICAL_SOUND_SPACE_PROJECTOR, record);
}
```

All rendering surfaces now consume this one function — one coherent Sound Space.

## 5. Changes

### Source
- `src/analysis/soundSpaceProjector.ts` — added `computeCanonicalSoundSpacePoint`,
  `MapCornerLabels` + `soundSpaceCornerLabels()` (four corners, X-pole · Y-pole,
  Title Case, sourced from the axis constants); header updated for STEP37.
- `src/ui/map/mapView.ts` — `mapPoints` places each point by the **canonical**
  V2 coordinate when the representative has a projectable `soundCharacter`,
  else the persisted `mapPosition` fallback; added `projection` provenance field
  (`"sound-space-canonical" | "map-v2-legacy"`); position never recomputed from
  `audioFeatures` (STEP 16Q preserved).
- `src/ui/map/mapRender.ts` — four-corner labels replace the old edge labels
  (fixes the missing top-right and lower-left-overlap defects); labels stay in
  screen space, never zoom.
- `src/ui/render.ts` — Sound Space scatter uses `soundSpaceCornerLabels()` for
  its four corner labels (fixes missing top-right; single terminology/casing).
- `src/e2e/harness/main.ts` — `readRecords` mirrors `mapPoints` canonical logic
  so the asserted cx/cy always describe what the map actually rendered
  (16M-07 roadmap).

### Tests
- `src/ui/map/mapView.test.ts` — new "STEP37 canonical Sound Space coordinates"
  block (6 tests: canonical preferred, canonical beats legacy, equals projector
  output, legacy fallback, unplaced when neither, determinism).
- `src/analysis/soundSpaceProjector.test.ts` — new "STEP37 canonical coordinate
  + four-corner label model" block (4 tests).
- `e2e/ep2-copy.spec.ts` — asserts the four corner labels (Noisy/Tonal ×
  Dark/Bright, X · Y) + their `<title>` hints.
- `e2e/step24.spec.ts` — E24-02 now also asserts the four Sound Space corner
  labels.

Unit total: **1137** (was 1127). E2E total: **176/176**.

## 6. Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `npm test` | ✅ 1137/1137 |
| `npm run build` | ✅ built |
| `npx playwright test` | ✅ 176/176 (incl. ep2-copy, step24, step16m) |

Note: the one `v2Fixtures` 5 s timeout seen once under full-suite load is a
performance flake (passes in isolation and in re-runs); it is not related to
STEP37.

## 7. Live verification (:5173, 200-record library)

`/tmp/sm37work/live_verify.ts` (artifacts:
`/tmp/samplemap-step37-map-audit.json`, `/tmp/samplemap-step37-live-verify.json`):

| Gate | Result | Evidence |
|---|---|---|
| L1 analyzed == 200 | ✅ | IndexedDB count |
| L2 V2 projectable == 200 | ✅ | 200/200 canonical points |
| L3 0 raw audio bytes | ✅ | 0 byte-ish fields, 0 refs across all records/features/v2 |
| L4 Sound Space 200 points + 4 corner labels | ✅ | meta "200 analyzed samples · All samples"; sticks `Tonal·Bright, Noisy·Bright, Tonal·Dark, Noisy·Dark` |
| L5 rendered map == canonical | ✅ | **200/200 exact matches** (tol 1e-6) vs `computeCanonicalSoundSpacePoint` |
| L6 no unexplained right-edge | ✅ | rendered x≥0.99 = **5**, == canonical 5; mean x 0.857 (old MAP A: 90 points, mean 0.915) — the right-edge compression is gone |
| L7 4 four-corner labels | ✅ | exactly `Noisy·Dark / Tonal·Dark / Noisy·Bright / Tonal·Bright` (+ native title hints) |
| L8 select → inspector | ✅ | real pointerdown on a map point → `.map-point-selected` + `inspector-name` |
| L9 preview intent | ✅ | preview button wired to `togglePreview`, click executes with no page error; full start/stop playback covered by the e2e suite (EP3/EP6/16M/23/27). In the offline live sandbox the STEP36 lazy runtime-metadata seam (`resolveSample` → `client.samples.get`) never settles, so live playback cannot start — an environment limitation, not a regression. |
| L10 Find Similar V2 | ✅ | focus mounts the panel (STEP32 P0), `inspector-find-similar-v2` → query header + 10 ranked rows |
| L11 reload persistence | ✅ | reload → 200 points + 4 axes again |

## 8. Artifacts

- `/tmp/samplemap-step37-map-audit.json` — pre/post reconciliation stats
  (MAP A, MAP B, frozen baseline), correlations, and the `liveVerified` gate
  record.
- `/tmp/samplemap-step37-live-verify.json` — per-gate live evidence.
- `/tmp/sm37work/map_audit.ts`, `/tmp/sm37work/live_verify.ts` — reproducible
  probes (CDP 9222 + vite :5173).