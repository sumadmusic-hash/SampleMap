/**
 * STEP24 — V2 Sound Space projector: the deterministic 2-D acoustic scatter.
 *
 * This is a NEW, separate projection boundary next to the frozen STEP20 V2
 * `mapProjector` (`src/analysis/mapProjector.ts`). The frozen MapProjector is
 * NOT reused here because STEP24 has different product requirements:
 *
 *  - fully-null characters must yield NO point (§11) — MapProjector fabricates
 *    a NEUTRAL (0.5, 0.5) position for them by design;
 *  - axes must carry documented human semantics (§14) — MapProjector's
 *    weighted axes are deliberately unexplained baseline weights;
 *  - V1 `mapPosition` / V2 `MapProjector` coordinates stay completely
 *    independent (§24); STEP37 makes THIS projector the canonical Sound Space
 *    boundary that map surfaces consume (`computeCanonicalSoundSpacePoint`).
 *
 * ALGORITHM (SOUND_SPACE_ALGORITHM_VERSION "1.0.0") — pure, deterministic,
 * corpus-independent, bounded. Canonical source vector: the STEP20
 * `SoundCharacter` in canonical order (via `toSimilarityVector`); no DSP, no
 * audio, no metadata (id/name/class never influence the position — §57).
 *
 *   X axis  — semantic "Noisy ↔ Tonal":
 *       x = weightedMean(tonality, 1 − noisiness) over the dims that are
 *           present; a dim contributes only when defined.
 *   Y axis  — semantic "Dark ↔ Bright":
 *       y = brightness.
 *
 * Null semantics (§11): null is NOT treated as 0. A dimension contributes
 * only when present. A POINT EXISTS iff BOTH axes are computable, i.e. the
 * character has ≥1 value in {tonality, noisiness} AND brightness set
 * (documented minimum-dimension threshold). Characters failing that produce
 * NO point (graceful omission, never a fabricated coordinate).
 *
 * Defensive robustness (§37): dims outside [0, 1] or non-finite are treated
 * as missing (never leak into the output); results are always clamped to
 * [0, 1]². The projection is a pure function of the single record — adding /
 * removing / reordering other samples can never move a point (§8/§26).
 */
import { clamp01 } from "./normalize";
import { toSimilarityVector, validateSoundCharacter } from "./soundCharacter";
import type { SoundCharacter } from "./soundCharacter";
import type { SampleAnalysisV2 } from "./sampleAnalysisV2";

/** Algorithm version — any projection change MUST bump this version. */
export const SOUND_SPACE_ALGORITHM_VERSION = "1.0.0" as const;

/** Axis label constants — the ONLY axis semantics of the 1.0.0 projector. */
export const SOUND_SPACE_X_LOW = "Noisy";
export const SOUND_SPACE_X_HIGH = "Tonal";
export const SOUND_SPACE_Y_LOW = "Dark";
export const SOUND_SPACE_Y_HIGH = "Bright";
export const SOUND_SPACE_NAME = "Sound Space";

/**
 * One deterministic, ephemeral point in the Sound Space. Derived state —
 * NEVER persisted into the sample record (§39): `SampleIndexRecord →
 * projector → SoundSpacePoint`.
 */
export interface SoundSpacePoint {
  /** Identity of the ranked/inspected sample (canonical `samples/...` id). */
  sampleId: string;
  /** X coordinate in [0, 1]: 0 = Noisy, 1 = Tonal. */
  x: number;
  /** Y coordinate in [0, 1]: 0 = Dark, 1 = Bright. */
  y: number;
  /** `analysisVersion` of the source analysis (e.g. "2.0.0"). */
  analysisVersion: string;
  /** `SOUND_SPACE_ALGORITHM_VERSION` the point was produced under. */
  algorithmVersion: string;
}

/** Canonical dimension indices (position in `SOUND_CHARACTER_DIMENSIONS`). */
const DIM = {
  brightness: 0,
  noisiness: 5,
  tonality: 4,
} as const;

/**
 * Defensive per-dimension washing for the projector (§37): a valid projection
 * input dim is a finite number in [0, 1]; everything else (NaN, ±Infinity,
 * out-of-range, non-number, null/undefined) is treated as MISSING — a missing
 * dim never becomes 0, so it can never poison an axis.
 */
function saneVector(char: SoundCharacter): ReadonlyArray<number | null> {
  return toSimilarityVector(char).map((v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null,
  );
}

/**
 * Weighted mean over present dims only (like the SHARED-DIM renormalization of
 * the frozen similarity engine): `null` contributes are skipped, the remaining
 * weights renormalize. Returns null when NO contribute is present.
 */
function meanOf(values: ReadonlyArray<number | null>): number | null {
  let n = 0;
  let acc = 0;
  for (const v of values) {
    if (v === null) continue;
    n += 1;
    acc += v;
  }
  return n === 0 ? null : acc / n;
}

/**
 * The pure projector boundary. `project(soundCharacter)` returns the (x, y)
 * coordinates or `null` when the character is not projectable (both axes must
 * be derivable; see the file header for the exact rule). Pure, deterministic,
 * corpus-independent.
 */
export interface SoundSpaceProjector {
  /** `SOUND_SPACE_ALGORITHM_VERSION` the instance was created under. */
  readonly version: string;
  /**
   * Project a SoundCharacter to [0, 1]². Returns `null` when the character is
   * not projectable (the §11 minimum-dimension threshold). Same input + same
   * version ⇒ same output, always.
   */
  project(soundCharacter: SoundCharacter): { x: number; y: number } | null;
}

export function createSoundSpaceProjector(): SoundSpaceProjector {
  return {
    version: SOUND_SPACE_ALGORITHM_VERSION,
    project(soundCharacter) {
      // Structural invalidity (missing keys etc.) → no point (§37).
      if (!validateSoundCharacter(soundCharacter).valid) return null;
      const v = saneVector(soundCharacter);

      // X: Noisy ↔ Tonal — tonality up, noisiness down (inverted contribution).
      const xContrib: Array<number | null> = [
        v[DIM.tonality],
        v[DIM.noisiness] === null ? null : clamp01(1 - (v[DIM.noisiness] as number)),
      ];
      // Y: Dark ↔ Bright — brightness only (honest axis semantics, §14).
      const yRaw = v[DIM.brightness];

      // §11: point exists iff BOTH axes are computable.
      const x = meanOf(xContrib);
      if (x === null || yRaw === null) return null;
      return { x: clamp01(x), y: clamp01(yRaw) };
    },
  };
}

/**
 * Project one persisted record's `analysisV2`. Returns `null` when the record
 * has no V2 analysis (V1-only), an unsupported structure, or an
 * under-determined character (§11) — the caller SKIPS the point and keeps
 * rendering the rest of the library (§37).
 */
export function projectSample(
  projector: SoundSpaceProjector,
  record: { sampleId: string; analysisV2?: SampleAnalysisV2 },
): SoundSpacePoint | null {
  const v2 = record.analysisV2;
  if (!v2 || typeof v2 !== "object") return null;
  const xy = projector.project(v2.soundCharacter);
  if (!xy) return null;
  return {
    sampleId: record.sampleId,
    x: xy.x,
    y: xy.y,
    analysisVersion: v2.analysisVersion,
    algorithmVersion: projector.version,
  };
}

/**
 * Project a whole record set to points, skipping the unprojectable. Pure:
 * the result for any sample depends ONLY on that sample's own analysis
 * (corpus independence / candidate-order independence per §8/§25).
 */
export function projectAll(
  projector: SoundSpaceProjector,
  records: Iterable<{ sampleId: string; analysisV2?: SampleAnalysisV2 }>,
): SoundSpacePoint[] {
  const out: SoundSpacePoint[] = [];
  for (const record of records) {
    const p = projectSample(projector, record);
    if (p) out.push(p);
  }
  return out;
}

/**
 * STEP37 — the SINGLE canonical V2 Sound Space coordinate boundary.
 *
 * Every rendering surface that places a sample by sound-character consumes
 * this function so the product renders ONE coherent Sound Space:
 *
 *   V2 analysis → computeCanonicalSoundSpacePoint → map rendering
 *
 * It is exactly the 1.0.0 projector math (X = weightedMean(tonality,
 * 1 − noisiness) over present dims; Y = brightness; point iff both computable;
 * output clamped to [0, 1]²). The module-level projector is stateless, so the
 * canonical point is deterministic and corpus-independent like the projector.
 */
const CANONICAL_SOUND_SPACE_PROJECTOR = createSoundSpaceProjector();

export function computeCanonicalSoundSpacePoint(
  record: { sampleId: string; analysisV2?: SampleAnalysisV2 },
): SoundSpacePoint | null {
  return projectSample(CANONICAL_SOUND_SPACE_PROJECTOR, record);
}

/**
 * STEP37 — the canonical four-corner label model.
 *
 * The coordinate system is: x=0 → `SOUND_SPACE_X_LOW` (Noisy), x=1 →
 * `SOUND_SPACE_X_HIGH` (Tonal); y=0 → `SOUND_SPACE_Y_LOW` (Dark), y=1 →
 * `SOUND_SPACE_Y_HIGH` (Bright) after the renderers' Y inversion. Each corner
 * therefore carries its X-pole first, Y-pole second, using ONE terminology
 * set (the projector axis constants) and ONE capitalization style (Title
 * Case). Rendering both map surfaces from these four labels removes the
 * previous missing-top-right and lower-left-overlap defects deterministically.
 */
export interface MapCornerLabels {
  /** x=0, y=1 (left, top). */
  topLeft: string;
  /** x=1, y=1 (right, top). */
  topRight: string;
  /** x=0, y=0 (left, bottom). */
  bottomLeft: string;
  /** x=1, y=0 (right, bottom). */
  bottomRight: string;
}

export function soundSpaceCornerLabels(): MapCornerLabels {
  return {
    topLeft: `${SOUND_SPACE_X_LOW} · ${SOUND_SPACE_Y_HIGH}`,
    topRight: `${SOUND_SPACE_X_HIGH} · ${SOUND_SPACE_Y_HIGH}`,
    bottomLeft: `${SOUND_SPACE_X_LOW} · ${SOUND_SPACE_Y_LOW}`,
    bottomRight: `${SOUND_SPACE_X_HIGH} · ${SOUND_SPACE_Y_LOW}`,
  };
}
