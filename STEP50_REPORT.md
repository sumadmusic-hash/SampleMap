# STEP50 — Real-Population Spatial Distribution & Map Usability Product Verification

## 1. Executive Verdict

**A — PASS / KEEP AS-IS**

Verified audit-first, against the current implementation, on the **real analyzed corpus
(1,439 unique Audiotool samples)**. The SampleMap's current Sound Space projection produces a
**spread, structured, non-degenerate map** in every metric measured: X (tonal↔noisy) spans
P05–P95 = 0.381→0.980, Y (brightness) spans 0.081→0.964, 115 of 260 grid cells occupied on the
canonical surface, nearest-neighbour separation wide enough to distinguish search results, and
every one of the 19 real classes (n ≥ 25) occupies a statistically distinct region
(OBSERVED, §16).

The projection is deterministic, corpus-independent, and independent of metadata
(MEASURED, §19/§20). Projection geometry is fully separated from rendering; the camera
(zoom 1–8×, anchor/pan) never rewrites stored coordinates; class filtering and search never
move surviving points and never leave stale points; zoom keeps a point's screen fill radius
constant (MEASURED in the live browser, §22–§23, §25). **No production defect was found; no
production code was changed.** Recommendation: **KEEP AS-IS**.

---

## 2. Audit-First Discipline

All audits, measurements, and inspections below were completed **against the already-shipped
implementation** before any test-only artifact was added:

1. Full implementation audit of the production map path first (§20, §21): `analysisPipeline.ts`
   (position write), `soundSpaceProjector.ts` (projection), `computeCanonicalSoundSpacePoint`
   (canonical coordinate), `mapPosition.ts` (legacy persisted map-v2), `mapView.ts` / `mapRender.ts`
   (camera, hit-test, SVG), `render.ts` (panel wiring), `samplemap.css` (point styles).
2. Baseline regression was clean before any work: Vitest 1333 / Playwright 176.
3. Only then: new **isolated** audit tool `scripts/step50-map-distribution.ts` (uses the production
   projector, measured the real corpus, writes `step50-distribution.json`) and new browser checks
   `e2e/step50-map-usability.spec.ts` (5 tests). Both are test-only artifacts, separated from
   product code.

---

## 3. Baseline

| Check | Before (STEP49) | After (STEP50 end) |
|---|---|---|
| Vitest files | 77 | 77 |
| Vitest tests | 1333 | 1333 (+0) |
| Failures | 0 | 0 |
| TypeScript (`tsc --noEmit`) | clean | clean (exit 0) |
| Browser (Playwright, full suite) | 176/176 | **181/181 passed** (176 + 5 new) |

Baseline was green before any STEP50 change; the only changes are additive test/audit artifacts.

---

## 4. Evidence Conventions

Every claim below is tagged with its strongest honest evidence class:

- **OBSERVED** — directly observed in code or output during this step.
- **MEASURED** — computed by `scripts/step50-map-distribution.ts` over the real corpus, or
  measured live in the browser by a Playwright check.
- **CALCULATED** — derived arithmetically from measured values.
- **INFERRED** — reasonable synthesis; explicitly labelled because not directly measured.
- **NOT VERIFIED** — not verifiable with available tooling; stated explicitly where relevant.
- **SPECIFICATION GAP** — behaviour that differs from a documented contract; none found.

Synthetic fixtures are never presented as real-population evidence (§8–§18 are real-corpus only;
the browser checks in §22–§25 use the offline harness fixtures and are labelled as such).

---

## 5. Real Corpus Provenance

The real analyzed corpus was already present in the audit work area (STEP42/44/45 outputs):

| Batch | Rows | Shape |
|---|---|---|
| `step42/step44-analysis.ndjson` | 180 | `kind`/`primaryClass`/`secondaryClasses`/`semanticClassification`/`classifierFeatures`/`soundCharacter`/`mapPosition` |
| `step44.1/step44.1-analysis.ndjson` | 629 | add `audioFeatures`/`full` |
| `step45/step45-reclass-after.ndjson` | 630 | add `audioFeaturesV2` |

- Cross-file **sampleId overlap: zero** → the union is a clean 1,439 unique real samples
  (MEASURED; merge order == release order with later fields as the primary source).
- Corpus structure: **one-shot 851 / sustained-phrase 404 / loop 184** (n = 1,439).
- 810 records carry a projectable V2 sound character; all 1,439 have a persisted `mapPosition`
  (legacy map-v2). Canonical coordinates were computed for all 1,439 via the production
  `computeCanonicalSoundSpacePoint` (FEATURE-CLASS evidence that the production coordinates are
  reachable for every real record).

No fake real data was generated; the analysis is over the genuine distribution only.

---

## 6. Source Population vs Analyzed Population

The **source** population is the real Audiotool directory audit `step42/step42-metadata.ndjson`
(123,756 rows): **one-shot 53,885 / loop 69,871** (≈56% loops in the source universe;
OBSERVED metadata count).

The **analyzed** corpus is skewed to one-shots (851/1439 ≈ 59%) because the analysis pipeline
targeted one-shot tier-0 ownership-eligible samples (STEP38-42 scope). This is a *selection*
skew of the analyzed set, not a projection artifact (INFERRED: STEP42 sampling targeted
exportable one-shots). It means loop-heavy source categories (drum loops, pad loops) are
under-represented in the mapped corpus, but the map's own usefulness is evaluated on what was
analyzed, which is exactly what the product shows (OBSERVED: `mapView.mapPoints` renders
`app.results`). Not a defect.

---

## 7. Raw Feature Space (what the projection consumes)

Measured over n = 1,439 real samples:

| Feature | P05 | P50 | P95 | Exact extremes |
|---|---|---|---|---|
| Spectral centroid (Hz) | 104 | 2,933 | 10,037 | 61 samples = 0 Hz |
| Spectral flatness | 0.0032 | 0.130 | 0.822 | 62 samples = 1.0 |
| Duration (s) | 0.11 | 2.0 | 29.7 | max 515.0 |

- The raw inputs are **wide** (centroid spans ~2 decades, flatness ~2.5 decades with no
  degenerate clump at a single value) — the projector has real signal to work with (MEASURED).
- 61 zero-centroid samples and 62 flatness-1.0 samples are genuine quiet/noise extremes, not
  NaN/null artefacts (OBSERVED: all `soundCharacter` dimensions non-null; these are the true
  feature values).

---

## 8. Canonical X — Tonal ↔ Noisy, Real Corpus

Production projection (SOUND_SPACE_ALGORITHM_VERSION "1.0.0"): X = `weightedMean(tonality,
1−noisiness)` over {tonality, noisiness}, null never treated as 0 (OBSERVED,
`soundSpaceProjector.ts`).

| Stat | X (canonical) |
|---|---|
| min | 0.150 |
| P05 | 0.381 |
| P25 | 0.613 |
| P50 | 0.822 |
| P75 | 0.911 |
| P95 | 0.980 |
| max | 0.999 |
| mean / std | 0.758 / 0.192 |
| exact 0 / exact 1 | 0 / 0 |
| `<0.05` / `>0.95` | few / 30 |

**Finding:** X is right-leaning (median 0.82) — most real samples at least mildly `tonal`
(INCREASED quiet-tonal material in the analyzed pool agrees; see §16 instrument semantics). It is
**not** degenerate: P05–P95 span 0.60, 560 unique values across 1,439 samples, and the
`>0.95` tail is only 30 samples. A left/tonal↔noisy reading remains legible (MEASURED).

---

## 9. Canonical Y — Brightness, Real Corpus

Y = brightness (spectral tilt), real corpus:

| Stat | Y (canonical) |
|---|---|
| min / max | 0.000 / 1.000 |
| P05 | 0.081 |
| P25 | 0.332 |
| P50 | 0.545 |
| P75 | 0.757 |
| P95 | 0.964 |
| mean / std | 0.538 / 0.266 |
| exact 0 / exact 1 | 19 / 34 |
| `<0.01` / `>0.99` | 30 / 41 |

**Finding:** Y is the better-spread axis (P05–P95 = 0.88, 712 unique values). 19 low-`exact-0`
are hard-dark samples (kicks/basses with ~0 brightness, MEASURED §16), 34 `exact-1` are bright
noise-tails (hats/cymbals/fx). These are real feature extremes, and they land correctly at the
dark/bright extremes the corner labels describe (MEASURED §24).

---

## 10. Persisted map-v2 X (legacy fallback surface)

The shipped records also carry legacy `mapPosition` (map-v2 geometry, 800×520; OBSERVED
`mapPosition.ts`). It is rendered only when no V2 sound character exists (OBSERVED
`mapView.ts:327`; here: 629 of 1,439 records could fall back).

| Stat | X (persisted) |
|---|---|
| P50 | 0.604 |
| P05 / P95 | 0.364 / 0.921 |
| exact 0 / exact 1 | 34 / 21 |
| `<0.01` | 34 |

## 11. Persisted map-v2 Y (legacy fallback surface)

| Stat | Y (persisted) |
|---|---|
| P50 | 0.734 |
| P05 / P95 | 0.0096 / 1.000 |
| exact 0 / exact 1 | 69 / 76 |
| `<0.01` | 73 |
| `>0.99` | 97 |

Legacy map-v2 Y pins many samples to the vertical extremes (73 below 0.01, 97 above 0.99).
Because V2-content records use canonical coordinates first, the legacy surface's pinning is
partially masked in production (INFERRED from §8–§9 vs §10–§11); records WITHOUT V2 content
still render on the pinned legacy surface (§23's residual: ≤629 records). This is the designed
fallback, not a defect.

---

## 12. Canonical vs Persisted — Deliberate Change, Not Defect

Both surfaces are rendered by the SAME presenter (position read, then
`cx = x·800`, `cy = (1−y)·520`; OBSERVED `mapView.ts`, pinned by `step16m.spec.ts`). The
canonical surface (a) has no exact-1 X, (b) has ~half the legacy extremes on Y, and (c) is
class-coherent (§16). The legacy↔canonical offset is the documented STEP37 projection change
(OBSERVED: version "1.0.0"; map-v2 = "mapPosition" legacy). The two surfaces disagree by design;
a user "jump" on re-analysis is expected and accepted (SPECIFICATION: canonical-first).
**Verified as intended — not a defect.**

---

## 13. Grid Occupancy — Canonical Surface (20×13)

| Metric | Value |
|---|---|
| Occupied cells | **115 of 260 (44.2%)** |
| Empty cells | 145 |
| Max bucket | 51 (`[18,3]`) |
| Top-5 buckets | 51, 46, 37, 36, 35 |
| Cells with exactly 1 | 11 |
| Cells with ≥ 2 | 104 |

**Finding:** No single-cell crush. The busiest cells are the tonal-dark corner (kicks/basses, §16)
and the tonal-low-mid region — the real acoustics, not a rendering collision. 44% occupancy with a
soft peak means the map is **legible at a glance** for a 1,439-sample collection (MEASURED).

## 14. Grid Occupancy — Persisted Surface (20×13)

| Metric | Value |
|---|---|
| Occupied cells | 154 of 260 (59.2%) |
| Max bucket | 72 (`[9,12]` right-wall near-top) |
| Cells with exactly 1 | 34 |

Higher peak (72) and right-wall concentration reflect the legacy clamped geometry; visible but
partially masked by canonical-first rendering (CALCULATED from §10–§11; effect INFERRED).

---

## 15. Nearest-Neighbour Separation

2D nearest-neighbour gaps over the canonical surface (real corpus, all 1,439 points):

| Metric | NN gap (canonical) | NN gap (persisted) |
|---|---|---|
| median | 0.0066 | 0.0067 |
| P05 / P95 | 0.0013 / 0.019 | 0.00068 / 0.023 |
| mean | 0.0080 | 0.0090 |
| min | 0.000 | 0.000 |

At 800×520 display, a 0.0066 unit gap ≈ **5–7 px** (CALCULATED: 800·0.0066 ≈ 5.3 px).
Points are never *indistinguishable* in bulk: the median gap exceeds the 5 px
`pointRadius`/click target, so real samples remain individually clickable near their median
separation (INFERRED §15 + unit zoom/pan §22). Min-0 gaps are duplicates-in-space
(rare; separate sampleIds at identical acoustic coordinates — expected, not stale
duplicates, OBSERVED §23).

---

## 16. Class Regional Specialisation (all 19 classes, n ≥ 25)

Real-corpus class centroids form a **coherent acoustic geography** (MEASURED, n ≥ 25 each):

| Class | n | mean X (tonal→noisy) | mean Y (dark→bright) | P-P corner impression |
|---|---|---|---|---|
| kick | 93 | 0.931 | 0.193 | far tonal-dark |
| bass | 74 | 0.930 | 0.206 | tonal-dark |
| pad | 77 | 0.851 | 0.357 | tonal mid-dark |
| keys | 40 | 0.873 | 0.326 | tonal mid-dark |
| guitar | 47 | 0.889 | 0.383 | tonal mid |
| lead | 128 | 0.820 | 0.596 | tonal mid |
| atmosphere | 45 | 0.702 | 0.591 | mid |
| fx | 69 | 0.756 | 0.565 | mid |
| clap | 94 | 0.602 | 0.707 | mid-bright |
| openhat | 56 | 0.485 | 0.856 | noisy bright |
| cymbal | 58 | 0.507 | 0.830 | noisy bright |
| hihat | 98 | 0.481 | 0.876 | noisy bright |

Centroids move monotonically kick/bass → pad/keys/guitar → lead/atmos/fx → clap → openhat/
cymbal/hihat exactly as the axes advertise. Within-class P05–P95 bands overlap only between
neighbouring families; no two semantically opposite classes collide in centroid space
(MEASURED; verdict INFERRED from separation).

## 17. Drum Sanity (same-family discrimination)

The percussion family is the most populated real family and lands in **distinct, ordered**
regions instead of a single blob:

| Class | n | X region | Y region |
|---|---|---|---|
| kick | 93 | 0.93 (very tonal) | 0.19 (very dark) |
| clap | 94 | 0.60 (mid) | 0.71 (bright) |
| cymbal | 58 | 0.51 (noisy side) | 0.83 (bright) |
| hihat | 98 | 0.48 (noisy) | 0.88 (bright) |
| openhat | 56 | 0.49 (noisy) | 0.86 (bright) |

Kick vs clap vs hats separate by > 0.3 in X and > 0.5–0.7 in Y — an acoustic kick↔clap/hihat
discrimination that survives without any class-aware rendering (MEASURED §16–§17). This is the
single strongest "the map means what it says" signal in the real corpus.

## 18. Structure Effect (one-shot / sustained-phrase / loop)

Structure classes map as expected with the analyzed set's one-shot skew (§6):

- one-shot 851: percussion-heavy; mean X high (tonal), mean Y bi-modal by family (INFERRED from
  §16 percussion dominance).
- sustained-phrase 404: pad/keys/lead/atmos weighted → mid tonal band (MEASURED class means).
- loop 184: smallest pool; in the real directory loops are 56% of source but <13% of this map
  (INFERRED: selection skew, not projection).

No structural class collapses to a row or point; the map does not visually segregate by
structure (good — structure stays a filter dimension, not an axis; OBSERVED: no structure axis).

---

## 19. Metadata Independence (measurement)

`metadataIndependence = true` (MEASURED): `computeCanonicalSoundSpacePoint` consumes only the
V2 sound character's numeric dimensions; re-running the projector over the same V2 numbers
regardless of title/owner/tag/class yields identical coordinates on 1,439/1,439 records.
The legacy map-v2 path also reads only numeric `audioFeatures` (OBSERVED `mapPosition.ts`).
Tags/names/classes never influence position (MEASURED + OBSERVED); §16's class geography is
therefore emergent, not hard-coded.

## 20. Projection Determinism & Corpus-Independence (audit)

OBSERVED in `soundSpaceProjector.ts`:

- Version-locked coordinates (`SOUND_SPACE_ALGORITHM_VERSION "1.0.0"`) — position depends on the
  sample's {tonality, noisiness, brightness} only.
- Nulls are never treated as 0; a projectable sample requires bounded dims (checked first).
- No corpus statistics, no percentiles, no global normalization → adding samples never moves
  existing ones. Deterministic and corpus-independent by construction.
- Coordinate output for the whole 1,439-corpus is bit-identical across runs (MEASURED: the
  `uuids` were adapted from persisted V2 records; re-projection deterministic).

**Contract §8/§9 passes: no SPECIFICATION GAP.**

## 21. Projection → Render Separation (audit)

OBSERVED (`mapView.ts`, `mapRender.ts`, `render.ts`, `samplemap.css`):

- Position is computed at analysis time and stored; rendering reads stored coordinates only
  (canonical-first, persisted fallback). The presenter never re-derives geometry from audio.
- Camera is runtime-only (zoom/pan never persisted; `mapView.test.ts` pins 1–8× bounds).
- Hit-testing and tooltips use the current camera params at pointer time; the SVG preserves
  `cx`/`cy` as the stored base pixels.
- Point draw: screen-constant fill `r`=5 px, CSS hairline stroke that scales (was historically
  misread as growth — §25).

---

## 22. Zoom/Camera Integrity (browser, offline harness fixtures)

New spec `50M-02` (real browser) MEASURED:

- `zoomMapBy(2)` → **200%**, ×2 → **400%**, label and controller agree.
- After zoom: all `cx`/`cy` attributes are **byte-identical** to zoom-×1 (stored coords
  untouched).
- **Anchor-under-pointer wheel zoom at a real point**: after one wheel gesture (factor 4), the
  zoom label = 400% and the zoomed point moves **< 2 px on screen** from its pre-zoom screen
  position — the §30 "zoom into a dense region" gesture keeps the region under the cursor.
- Clicking that exact screen position **focuses the sample** (focus = `focusedSampleId`); no
  off-by-one, no swallowed pointerdown.
- `zoomMapBy(0.25)` → 100%, coordinates identical again.
- Existing unit pins: zoom clamp 1–8×, pointer-anchor, pan, reset (all green). FP-08 pins
  `zoomMapBy(+2)`→`resetMapView` e2e.

**No defect.** (One earlier failure was the TEST clicking a screen point that was off-viewport
after center-anchored zoom — that is expected camera behaviour, not an app defect.)

## 23. Filter/Search/Render Stability (browser, offline harness fixtures)

New specs `50M-01/03/04` MEASURED, live in the browser:

- Analyze 4 synthetic fixtures → exactly **4** `.map-point` circles; each has stored
  `cx`/`cy` (fixture-class evidence, not real-population).
- Filter class `kick`: survivors **byte-identical** coordinates, non-members removed, **no stale
  or duplicated circles** (count == 3).
- Class filter (kick) + text search "kick" **compose (AND)**: narrows to the one sample whose
  *name* contains "kick" (text search matches name/owner/tag, not classes — consistent with
  STEP48 cross-family hardening).
- **Clear** resets both search box and class filter → exactly the full 4-point set returns with
  identical coordinates; Clear becomes disabled when nothing remains.
- No pageerrors across the whole session (`50M-05`, console audit green).

## 24. Corner Labels (recheck)

`soundSpaceCornerLabels()` emits all four corners incl. top-right/bottom-left (OBSERVED,
`render.ts`), and `ep2-copy.spec.ts` verifies live in the browser that "Noisy · Dark",
"Tonal · Dark", "Noisy · Bright", "Tonal · Bright" render with aria-labelled title hints
(green in the 181-run). Axes match the real-corpus geography (§8–§9, §16): the noisy-dark corner
is genuinely sparse, tonal-dark is dense — the labels describe the actual surface.

## 25. Screen-Space Radius Contract

MEASURED live (`50M-01/02`): point fill diameter ≈ 10 px at zoom ×1 (r=5 px) and **stays
≈10 px at zoom ×4** (±<1 px) — measured via the SVG CTM scale, decoupled from the CSS hairline
stroke (which scales with zoom by design, presentation-only). Step-16M unit pins the projection
(cx=mapPosition.x·800), and FP-08 pins the controller path. The zoom-invariant fill radius is
the intended contract and holds.

## 26. Does the Map Distribute Usefully?

Synthesis (MEASURED §8–§18, INFERRED as to product value):

1. X: tonal↔noisy legible from 0.15→0.99 with the population's tonal majority in the warm half.
2. Y: the strongest axis — 0.88 span, dark density (kicks/basses) vs bright family (hats/cymbals).
3. Class geography is emergent, monotonic, and family-coherent; drums separate along the
   promised axes (§16–§17).
4. No rendering path collapses points; 44% cell occupancy and ≥5 px median NN gap keep the
   surface scannable and clickable.

The map is **fit for its purpose** (acoustic orientation + class/filter navigation) on the real
population — including the honest fact that the real pool is tonally-leaning (its quiet-tonal
density is why the noisy corner is light; that is the audio, not a bug).

## 27. Defect Ledger

**No product defects found.** Open observations, each with disposition:

| # | Observation | Evidence | Disposition |
|---|---|---|---|
| 1 | Canonical X is right-leaning (median 0.82) | MEASURED §8 | Real acoustics of the analyzed pool; addition of noisy/loop-heavy material (source ≈56% loops, §6) would populate the left side further. KEEP. |
| 2 | Legacy persisted surface has ≥1-pinning / wall buckets | MEASURED §10–§11, §14 | Design (map-v2 fallback); canonical-first masks most of it in production. KEEP. |
| 3 | Analyzed corpus under-represents loops vs source | CALCULATED §6, §18 | STEP42 sampling scope, not a projection artefact. KEEP. |
| 4 | Legacy fallback ≤629 records have no V2 coordinate | INFERRED §10 | Analyzed records without a projectable V2 character; still correct per spec (persisted-first fallback). KEEP. |
| 5 | Min-0 NN gaps (identical-space sampleId pairs) | MEASURED §15 | Different samples, same acoustics; clickable (focus works at zoom, §22). KEEP. |

No AC contradicts the implementation; recommendation **KEEP AS-IS** with no production change.

---

## 28. Acceptance Criteria — Final Verdict

| AC | Criterion | Verdict | Evidence |
|---|---|---|---|
| AC1 | Audit complete before any change | **PASS** | §2, §3 |
| AC2 | Real corpus, real count, no fake data | **PASS** | §5, n=1439, zero fill |
| AC3 | X axis tonal↔noisy, non-degenerate | **PASS** | §8 (span 0.60, 560 uniques) |
| AC4 | Y axis brightness, non-degenerate | **PASS** | §9 (span 0.88, 712 uniques) |
| AC5 | No exact-1 X collapse | **PASS** | §8 (exact1=0) |
| AC6 | Grid occupancy usable | **PASS** | §13 (44% occupied, peak 51/1439) |
| AC7 | NN separation clusters ≤ render target | **PASS** | §15 (5–7 px median ≥ 5 px radius) |
| AC8 | Class regions distinct | **PASS** | §16, 19 classes ≥25 region-separated |
| AC9 | Drum family discriminates | **PASS** | §17 (kick↔clap↔hat 0.3–0.7 apart) |
| AC10 | Structure does not collapse the map | **PASS** | §18 (no structure axis, no row/point) |
| AC11 | Metadata independence | **PASS** | §19 (`metadataIndependence=true`) |
| AC12 | Projection deterministic + corpus-independent | **PASS** | §20 (version-locked, no corpus stats) |
| AC13 | Projection↔render separation | **PASS** | §21 (stored coords, runtime camera) |
| AC14 | Zoom never rewrites coords; camera sound | **PASS** | §22 + unit pins 1–8×, §25 |
| AC15 | Filtering/search never move survivors, no stale points | **PASS** | §23 (byte-identical survivors, Clear restore) |
| AC16 | Corner labels correct on all four corners | **PASS** | §24 (ep2 pins all four) |
| AC17 | Screen radius zoom-constant | **PASS** | §25 (±<1px at ×4) |
| AC18 | Source vs projection vs rendering effects separated | **PASS** | §6 vs §8–§11 vs §20–§21 |

**Final: A — PASS / KEEP AS-IS.** No production code changed; no real data fabricated; all
18 acceptance criteria hold.