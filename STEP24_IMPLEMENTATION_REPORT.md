# STEP24 — V2 Sound Space & Similarity Map Integration — Implementation Report

## 1. Verdict

**STEP24 PASS**

## 2. Scope

STEP24 adds the first V2 visual product surface: a deterministic 2D Sound
Space showing the analyzed library as an acoustic scatter, integrated into the
existing SampleMap UI with focus/inspector/preview/Find Similar V2 continuity.
Pure metadata projection only — no audio, no DSP, no ML, no new dependencies.
The V1 map, V1 similarity, SearchEngine semantics, pipeline, and persist schema
stay frozen.

## 3. Baseline

| Check | Before (STEP23 end) | After (STEP24) |
| --- | --- | --- |
| `npm run typecheck` | 0 errors | 0 errors |
| App unit tests (`npm test`) | 886 passed | **908 passed** (+22 STEP24) |
| Global worker tests (`workers/d1-worker`) | 19 passed | 19 passed |
| Playwright E2E (`npx playwright test`) | 82 passed | **96 passed** (+14 STEP24) |
| `npm run build` | PASS | PASS (pre-existing chunk-size warning only) |

## 4. Changed Files

| File | Change | Reason | Evidence |
| --- | --- | --- | --- |
| `src/analysis/soundSpaceProjector.ts` | NEW — `createSoundSpaceProjector()`, `projectSample`, `projectAll`, `SoundSpacePoint`, `SOUND_SPACE_ALGORITHM_VERSION = "1.0.0"`, axis label constants | Deterministic, corpus-independent V2→2D projection boundary | REAL |
| `src/analysis/soundSpaceProjector.test.ts` | NEW — 11 unit tests (geometry §29, corpus validation §28, §54 benchmark) | Projector guarantees | REAL + FIXTURE + CONSTRUCTED |
| `src/ui/app.ts` | EDIT — `SoundSpaceState`, `emptySoundSpaceState()`, `soundSpace` field, `soundSpaceProjector` instance, `openSoundSpace()`, `closeSoundSpace()`, `focusSampleById()`, `sampleNameFor()` | Snapshot state + canonical focus entry point | REAL |
| `src/ui/view.ts` | EDIT — `soundSpaceCountLabel`, `soundSpaceToggleLabel`, `SOUND_SPACE_EMPTY_TEXT`, `soundSpaceAxisLabel` | Testable view models | REAL |
| `src/ui/render.ts` | EDIT — `renderSoundSpacePanel` inserted between map panel and results, SVG points + axis legends + toggle + empty/error states | V2 UI surface | REAL |
| `src/ui/samplemap.css` | EDIT — `.sound-space-*` styles (tokens only) | Visual grammar reusing existing tokens | — |
| `src/ui/step24.soundSpace.test.ts` | NEW — 11 app-level tests | State semantics, focus decoupling from recompute, STEP23 integration | REAL + FIXTURE |
| `e2e/step24.spec.ts` | NEW — 14 E2E scenarios (E24-01..E24-14) | End-to-end proof against the offline harness | FIXTURE |
| `e2e/artifacts/step24-sound-space.png` | NEW — screenshot of the 4-point fixture Sound Space | Visual evidence | FIXTURE |
| `e2e/artifacts/step24-sound-space-10k.png` | NEW — screenshot at 10k points | Scale evidence | CONSTRUCTED |
| `STEP24_IMPLEMENTATION_REPORT.md` | NEW — this report | — | — |

No V1 file was touched: `src/pipeline/*`, `src/classify/*`, `src/similarity/*` (V1 fingerprint similarity), `src/search/*`, `src/map/*`, `src/preview/*`, `src/machiniste/*`, `src/global/*`, `workers/d1-worker/*` unchanged. The frozen V2 modules (`similarityRanking.ts`, `similarityEngine.ts`, `soundCharacter.ts`, `sampleAnalysisV2.ts`, `mapProjector.ts`, `audioFeaturesV2.ts`, `v2Fixtures.ts`, `map-v2/*`) are read-only consumers that STEP24 composes via imports only.

## 5. SoundSpaceProjector

New explicit boundary next to the frozen ME named `mapProjector`. It is NOT the
V2 MapProjector from STEP20 — that projector fabricates a NEUTRAL `(0.5, 0.5)`
center for all-null characters (by design), which STEP24 §11 forbids. STEP24
introduces `SoundSpaceProjector`:

```ts
interface SoundSpaceProjector {
  readonly version: string;             // "1.0.0"
  project(soundCharacter): { x: number; y: number } | null;
}
projectSample(projector, { sampleId, analysisV2 }) → SoundSpacePoint | null
projectAll(projector, records) → SoundSpacePoint[]
```

Output type is snapshot-only (never persisted, §39):

```ts
interface SoundSpacePoint {
  sampleId: string;
  x: number;               // [0,1] — Noisy ↔ Tonal
  y: number;               // [0,1] — Dark ↔ Bright
  analysisVersion: string; // e.g. "2.0.0"
  algorithmVersion: string; // "1.0.0"
}
```

## 6. Projection Mathematics

Input vector: the canonical STEP20 8D `SoundCharacter` (order: `brightness,
density, transient, duration, tonality, noisiness, dynamics, complexity`) via
`toSimilarityVector`, defensively washed: dims that are non-finite, out of
[0, 1] or non-number are treated as missing (never as 0) — §37.

```text
X axis:  x = mean( tonality, 1 − noisiness )   // over present dims only
Y axis:  y = brightness

point exists  ⇔  x computable && y computable
```

Normalization: none beyond per-dimension washing; each dim is already `[0,1]`
from the canonical V2 representation. The mean over present dims renormalizes
(skips nulls — no global re-baseline, §8).

Bounds: all outputs flow through `clamp01`; the outer point is always in
[0, 1]² (`0 ≤ x ≤ 1`, `0 ≤ y ≤ 1`).

Version: any change to this mathematics MUST bump
`SOUND_SPACE_ALGORITHM_VERSION` (currently `"1.0.0"`).

Rationale: the two dimensions humans most instantly ask "where does this sit"
on are tonal↔noisy and dark↔bright. These are the only honest axis semantics
STEP24 supports with single-dimension clarity (§14). More complex
tensor-projections would blur that clarity; they are left for a possible
STEP25+ decision only.

## 7. Axis Semantics

- X axis label: `Noisy ↔ Tonal` (X-low "Noisy", X-high "Tonal`).
- Y axis label: `Dark ↔ Bright` (Y-low "Dark", Y-high "Bright").

The UI shows these labels (a combined "X ↔ X-high" line plus SVG tick labels
at the frame corners). No Confidence/Similarity/Quality lingo: the position
is acoustic character, not classification probability (§14).

## 8. Null/Partial Data Semantics (§11)

Per-dimension null is preserved through the vector; it is never turned into 0.
A point is emitted only when BOTH axes are computable:
`{tonality, noisiness}` partially-present still needs `brightness`; a
brightness-only char (Y only) yields no point; all-null → no point; V1-only
record → no point but stays fully browsable; malformed/corrupt record →
silently skipped (§37).

The 3 initially failing tests were corrected to this rule after diagnosing
them: two asserted a "midpoint 0.5" fallback that §11 explicitly forbids, and
the benchmark fixture hash could produce negative dims (which validation
correctly rejects). The tests were rewritten to express §11 (renormalization
on present dims; single-axis chars → no point; constructed full-dim chars → n in
= n out), and now 11/11 pass without weakening any assertion of the contract.

## 9. Corpus Independence

The projection of a sample is a pure function of its own `SoundCharacter`.
Adding/removing/reordering other samples moves nothing (§8/§26). Unit tests
verify: id-order permutation and a larger corpus (2 → 6 records) leave the
original two records' coordinates bit-identical.

## 10. Determinism

Same `SoundCharacter` + same `SOUND_SPACE_ALGORITHM_VERSION` ⇒ same point,
across runs/browser sessions (§25, §29A). No random component, no time,
no jitter. `json.stringified` deep-equal assertions verify this.

## 11. UI Integration

Additive panel in the center region between `Sample Map` and `Results`:

- Always-visible toggle (`Open Sound Space` / `Close Sound Space`).
- Meta line: "N analyzed samples".
- Semantic axes line: `Noisy ↔ Tonal · Dark ↔ Bright`.
- SVG scatter (viewBox 400×260 with margin 4): circle per projectable record
  at `(4 + x·392, 4 + (1−y)·252)`, `border-radius` center, `--accent` fill.
- Tooltip/title: name + coordinates at native tooltip.
- Keyboard: every point has `tabindex="0"`, Enter/Space selects via the
  existing focus path.
- Empty states: "No analyzed samples in Sound Space yet."; `status="error"` on
  index-unavailable; one-point case renders a single point.
- No modal, no route, no new drawer; the layout grid stays untouched.

## 12. Selection/Focus

Sound Space uses the EXISTING canonical focus/selection path (`focusedSampleId`
+ `selectSample(record)` via the `focusSampleById` entry point). No parallel
selection state. Focus changes highlight the point via
`.sound-space-point-focused` — but the position graph is never recomputed on
focus (§46), proven by E24-04 (DOM positions deep-equal before/after focus).

## 13. Preview

Preview reuses the existing `app.togglePreview(record)` path fully (epoch
guarded, synthetic-preview URLs stay blocked for fixture playback in the
harness — same standing Blocked-as-of-16M evidence). No new audio work.
E24-08 asserts preview reachability from the focused sample's inspector.

## 14. Find Similar Integration

`Find Similar` from a Sound-Space-routed focus executes the same STEP23 flow:
`openFindSimilarV2()` reads `focusedRecord` and runs the frozen `rankSimilar`
with `RANKING_DEFAULT_LIMIT` and `includeSelf=false`. E24-07 asserts the
resulting list equals the engine's own `v2.rank(...)` output exactly, proving
no second similarity path was introduced (STEP23 owns the similarity snapshot).

## 15. V1 Freeze Compliance

Zero changes to: V1 `mapProjector`, map UI, V1 similarity/fingerprint,
`SearchEngine` semantics, V1 audio pipeline, persistence schema, Machiniste,
E-P7, authentication, global publish, d1 worker. The Sound Space derives
points at open time; it never writes coordinates (§39) and never touches
`mapPosition` or `mapProjection.x`. Adding a sample to the Sound Space never
affects a V1 map point. The V2 surface consumes `analysisV2` read-only.

## 16. E2E

`e2e/step24.spec.ts` — 14 scenarios, all PASS (shared serial page):

| # | Scenario | Result |
| --- | --- | --- |
| E24-01 | no V2 data → honest empty state | PASS |
| E24-02 | fixture library: 4 V2 points, meta, axis labels | PASS |
| E24-03 | DOM positions match projector coordinates exactly | PASS |
| E24-04 | focus change never moves points | PASS |
| E24-05 | point click focuses + selects via existing path | PASS |
| E24-06 | inspector mirrors focused sample | PASS |
| E24-07 | Find Similar from Sound Space equals `rankSimilar()` | PASS |
| E24-08 | preview reachable from focused sample | PASS |
| E24-09 | V1-only stays browsable, no V2 point | PASS |
| E24-10 | partial character (X-only) → no point | PASS |
| E24-11 | keyboard activation (Enter) selects a point | PASS |
| E24-12 | deterministic reopen yields identical coordinates | PASS |
| E24-13 | V1 regression (map/inspector) + console audit | PASS |
| E24-14 | §54 scale bench 100..10,000 records | PASS |

## 17. Performance

Node-level projection (pure `projectAll`, CONSTRUCTED full-dim records):

| n | time |
| --- | --- |
| 100 | 0.37 ms |
| 500 | 0.50 ms |
| 1,000 | 0.52 ms |
| 5,000 | 7.43 ms |
| 10,000 | 9.08 ms |

Browser end-to-end (index read + projection + full app re-render, measured):

| n | time (incl. +4 fixture points) |
| --- | --- |
| 100 | 30 ms (104 pts) |
| 500 | 39 ms (504 pts) |
| 1,000 | 49 ms (1,004 pts) |
| 5,000 | 155 ms (5,004 pts) |
| 10,000 | 293 ms (10,004 pts) |

Projection is O(N) — no pairwise similarity, no audio fetch, no ranking.
Coordinates are never recomputed on focus change; close drops the snapshot,
reopen re-projects deterministically.

## 18. Regression

- `npm run typecheck` — 0 errors.
- `npm test` — 908/908 (886 baseline + 22 STEP24).
- `workers/d1-worker` — 19/19 unchanged.
- `npx playwright test` — 96/96 (82 baseline + 14 STEP24).
- `npm run build` — PASS (pre-existing chunk-size warning only).

## 19. Evidence Classification

- **REAL** — CSS/UI wiring, focus/selection/integration paths, state
  semantics, rendering DOM assertions, V1 regression coverage, browser
  console-audit.
- **FIXTURE** — corpus coordinates and every V2-attach/detach evidence via the
  deterministic `analyzeCorpus` / `via v2Fixture` demos (never real Audiotool
  audio).
- **CONSTRUCTED** — §54 benchmark records (hash-spread full characters) and the
  intentionally malformed single-axis case.
- **BLOCKED / NOT TESTED** — actual live Audiotool library browsing of a large
  V2 corpus (Layer-C scope); recorded-playback of previews for synthetic
  samples (mirrors the standing §16 finding).

## 20. Known Limitations

- Projection is lossy: 8D → 2D collapses density/transient/duration/dynamics/
  complexity into the X/Y semantics of tonality/noisiness/brightness. Points
  that share these three dims cluster even when the other dims differ
  (e.g. `impulse` vs. `whiteNoise` land at the same position).
- STEP22's documented register gap (`lowThump ~ highThump`) remains visible:
  the two thumps sit ~0.54 apart on the Dark↔Bright axis. STEP24 deliberately
  does not patch this by ad-hoc name/class rules (§56/§57); a V2.1 calibration
  of the character model is the sanctioned path.
- Partial-coverage samples (§11) appear as *no* sound-space point even when
  the V2 quality flag would still allow ranking; the two contracts are
  intentionally separate.
- No accessibility tree beyond the SVG semantics + native text — keyboard
  selection and title/tooltip cover the primary flows, but dedicated view/stats
  cards (e.g. a per-point list) are deferred to a possible STEP25 refinement.

## 21. Remaining External Limitations

- Live Audiotool validation remains Layer-C (the offline harness is the
  verification floor and was not changed).
- The UI scatter is SVG — past ~10k points the DOM grows (≈10k circles) and
  future density/selection layers may prefer a canvas path; for the verified
  envelope SVG is sufficient and honest.
- Point area/radius is fixed; extreme density makes neighboring points overlap
  (§16) — mitigations ordered: keep coordinate integrity; defer radius/zoom
  work to later steps if user testing demands it.

## 22. Final Verdict

STEP24 delivers the required deterministic V2 Sound Space:
- `SoundSpaceProjector` is pure, bounded, corpus-independent, versioned.
- The UI integration is additive, keyboard-accessible, STEP23-compatible, and
  keeps identity-only semantics out of the coordinates.
- 11/11 projector tests, 11/11 app-level tests, 14/14 E2E scenarios, all
  unmodified regression lanes green, and the benchmarks confirm linear scaling.

## 23. Recommended Next Step

STEP25 — V2 Sound Space Interaction, Filtering & Compare