# SAMPLEMAP V1 — STEP 15B REPORT

## Implementation

Created:
- `src/map/mapPosition.ts`
- `src/map/mapPosition.test.ts`

Modified:
- None. No existing production file was changed.

New exported API (`src/map/mapPosition.ts`):
- `mapPosition(features: AudioFeatures): MapPosition` — pure, deterministic.
- `MapPosition { x: number; y: number }` — both in `[0, 1]`.
- `mapVersion = "map-v1"`.

`mapPosition` reuses the existing `AudioFeatures` type from
`src/persistence/indexStore.ts` — no parallel feature interface was created.
No new DSP features, no audio downloads, no UI, no new dependency.

## Map Position

X: `x = clamp01(tonalNoiseRatio)` — NOISY (0) <-> TONAL (1).

Y: `y = clamp01((ln(max(spectralCentroid, 100)) - ln(100)) / (ln(8000) - ln(100)))`
- 100 Hz -> 0, 8000 Hz -> 1; values < 100 Hz clamp to 0, > 8000 Hz clamp to 1.
- Logarithmic scaling as specified in Step 15A.

## Version

`mapVersion = "map-v1"` (module constant; not persisted).

## Persistence

New persisted fields: NONE.

X/Y are computed on-read from the already-persisted `audioFeatures`. No
`mapX`/`mapY` fields stored, so a future mapping change needs no re-analysis or
re-download.

## Tests

Before: 191 tests / 18 files
After:  207 tests / 19 files (added 16 tests in 1 new file; none deleted/weakened)

Covered: X (0/1/middle/out-of-range low+high), Y (100/8000/<100/>8000/knowm
frequencies 100–8000 monotonic), X independent of centroid, Y independent of
tonal ratio, determinism (identical input -> identical output), purity (input
not mutated), map-version constant.

## TypeScript

PASS (`npx tsc --noEmit` clean; only pre-existing build chunk-size warning, not
an error).

## Build

PASS (`npm run build` succeeds; only the pre-existing cosmetic >500 kB chunk
warning).

## Production Changes

None outside scope. `SampleIndexRecord`, `IndexStore`, `AudioFeatures`,
`analysisPipeline` and the existing classification were all left untouched.
Classification remains fully independent of position (Step 15B adds no
similarity engine and no relation between class and x/y).

## Verdict

DONE — all Step 15B acceptance criteria met (mapPosition exists, uses the exact
Step 15A formulas, pure + deterministic, X/Y tested, no new features, no new
persistence, classification unchanged, regression green, tsc clean, build OK).
