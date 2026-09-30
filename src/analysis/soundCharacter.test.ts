import { describe, it, expect } from "vitest";
import type { SoundCharacter } from "./soundCharacter";
import {
  computeSoundCharacter,
  computeSoundCharacterQuality,
  validateSoundCharacter,
  toSimilarityVector,
  emptySoundCharacter,
} from "./soundCharacter";
import { SOUND_CHARACTER_DIMENSIONS, V2_SIMILARITY_WEIGHTS } from "./config";
import {
  SILENCE,
  PURE_TONE,
  WHITE_NOISE,
  IMPULSE,
  SHORT_PERCUSSION,
} from "./fixtures";

const ALL = { SILENCE, PURE_TONE, WHITE_NOISE, IMPULSE, SHORT_PERCUSSION };

function derived(): Record<keyof typeof ALL, SoundCharacter> {
  return {
    SILENCE: computeSoundCharacter(SILENCE),
    PURE_TONE: computeSoundCharacter(PURE_TONE),
    WHITE_NOISE: computeSoundCharacter(WHITE_NOISE),
    IMPULSE: computeSoundCharacter(IMPULSE),
    SHORT_PERCUSSION: computeSoundCharacter(SHORT_PERCUSSION),
  };
}

describe("computeSoundCharacter", () => {
  const chars = derived();

  it("is deterministic (same input -> identical output) and pure", () => {
    for (const name in ALL) {
      const a = computeSoundCharacter(ALL[name as keyof typeof ALL]);
      const b = computeSoundCharacter(ALL[name as keyof typeof ALL]);
      expect(a).toEqual(b);
    }
  });

  it("produces valid characters: every dim in [0,1] or null, never NaN/Infinity", () => {
    for (const name in ALL) {
      const c = chars[name as keyof typeof chars];
      expect(validateSoundCharacter(c).valid).toBe(true);
      for (const dim of SOUND_CHARACTER_DIMENSIONS) {
        const v = c[dim];
        if (v !== null) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  describe("fixture invariants (relative, deterministic baseline)", () => {
    it("duration: IMPULSE < SHORT_PERCUSSION < WHITE_NOISE < PURE_TONE < SILENCE", () => {
      const d = (k: keyof typeof chars) => chars[k].duration as number;
      expect(d("IMPULSE")).toBeLessThan(d("SHORT_PERCUSSION"));
      expect(d("SHORT_PERCUSSION")).toBeLessThan(d("WHITE_NOISE"));
      expect(d("WHITE_NOISE")).toBeLessThan(d("PURE_TONE"));
      expect(d("PURE_TONE")).toBeLessThan(d("SILENCE"));
    });

    it("tonality: PURE_TONE > SHORT_PERCUSSION > IMPULSE > WHITE_NOISE; SILENCE null", () => {
      const t = (k: keyof typeof chars) => chars[k].tonality as number;
      expect(t("PURE_TONE")).toBeGreaterThan(t("SHORT_PERCUSSION"));
      expect(t("SHORT_PERCUSSION")).toBeGreaterThan(t("IMPULSE"));
      expect(t("IMPULSE")).toBeGreaterThan(t("WHITE_NOISE"));
      expect(chars.SILENCE.tonality).toBeNull();
    });

    describe("tonality: periodicity semantics (STEP88)", () => {
      const t = (k: keyof typeof chars) => chars[k].tonality as number;

      it("a pure tone is strictly more tonal than broadband noise", () => {
        expect(t("PURE_TONE")).toBeGreaterThan(t("WHITE_NOISE"));
      });

      it("a pure tone is strictly more tonal than percussive noise", () => {
        // IMPULSE is the percussive-noise stand-in: broadband, pitchless.
        expect(t("PURE_TONE")).toBeGreaterThan(t("IMPULSE"));
      });

      it("harmonic / tonal material stays high and noise stays low", () => {
        expect(t("PURE_TONE")).toBeGreaterThan(0.8);
        expect(t("WHITE_NOISE")).toBeLessThan(0.3);
      });

      it("a missing pitch does NOT by itself imply high tonality", () => {
        // WHITE_NOISE and IMPULSE have pitchConfidence = null. Renormalizing over
        // the present dims must fall back to the periodicity measure, never to a
        // "no pitch => tonal" default.
        expect(WHITE_NOISE.pitchConfidence).toBeNull();
        expect(IMPULSE.pitchConfidence).toBeNull();
        expect(t("WHITE_NOISE")).toBeLessThan(0.3);
        expect(t("IMPULSE")).toBeLessThan(0.3);
        expect(t("WHITE_NOISE")).toBeCloseTo(WHITE_NOISE.harmonicity as number, 12);
        expect(t("IMPULSE")).toBeCloseTo(IMPULSE.harmonicity as number, 12);
      });

      it("tonality is the weighted mean of the PRESENT periodicity inputs", () => {
        expect(t("PURE_TONE")).toBeCloseTo(0.8 * (PURE_TONE.harmonicity as number) + 0.2 * (PURE_TONE.pitchConfidence as number), 12);
        expect(t("SILENCE")).toBeNull();
      });

      it("tonality never leaves [0,1] and stays finite for out-of-spec inputs", () => {
        for (const name in ALL) {
          const v = chars[name as keyof typeof chars].tonality;
          if (v === null) continue;
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        // harmonicity is the primary term: even with a maximal corroborating
        // pitchConfidence the result cannot exceed 1, and even with a
        // non-finite/absent one it stays inside the range.
        const forced = computeSoundCharacter({
          ...PURE_TONE,
          harmonicity: 0.5,
          pitchConfidence: 1,
        });
        expect(forced.tonality).toBeCloseTo(0.8 * 0.5 + 0.2 * 1, 12);
      });

      it("a strongly gated pitchConfidence cannot dominate a low periodicity score", () => {
        // STEP88 regression: pitchConfidence > 0.7 is guaranteed for any value
        // that exists, so at the old 0.6 weight it forced tonality >= 0.42.
        const noisyButVoiced = computeSoundCharacter({
          ...PURE_TONE,
          harmonicity: 0.05,
          pitchConfidence: 0.75,
        });
        expect(noisyButVoiced.tonality as number).toBeLessThan(0.25);
        expect(noisyButVoiced.tonality as number).toBeCloseTo(0.8 * 0.05 + 0.2 * 0.75, 12);
      });

      it("null DSP features keep their null semantics (no 0-substitution)", () => {
        const harmonicityOnly = computeSoundCharacter({ ...PURE_TONE, pitchConfidence: null });
        expect(harmonicityOnly.tonality).toBeCloseTo(PURE_TONE.harmonicity as number, 12);
        const pitchOnly = computeSoundCharacter({ ...PURE_TONE, harmonicity: null });
        expect(pitchOnly.tonality).toBeCloseTo(PURE_TONE.pitchConfidence as number, 12);
        const neither = computeSoundCharacter({ ...PURE_TONE, harmonicity: null, pitchConfidence: null });
        expect(neither.tonality).toBeNull();
      });
    });

    it("noisiness: WHITE_NOISE > IMPULSE > SHORT_PERCUSSION > PURE_TONE; SILENCE finite", () => {
      const n = (k: keyof typeof chars) => chars[k].noisiness as number;
      expect(n("WHITE_NOISE")).toBeGreaterThan(n("IMPULSE"));
      expect(n("IMPULSE")).toBeGreaterThan(n("SHORT_PERCUSSION"));
      expect(n("SHORT_PERCUSSION")).toBeGreaterThan(n("PURE_TONE"));
      expect(chars.SILENCE.noisiness).not.toBeNull();
      expect(n("SILENCE")).toBeGreaterThan(n("PURE_TONE"));
    });

    it("transient: IMPULSE > SHORT_PERCUSSION > WHITE_NOISE > PURE_TONE; SILENCE null", () => {
      const tr = (k: keyof typeof chars) => chars[k].transient as number;
      expect(tr("IMPULSE")).toBeGreaterThan(tr("SHORT_PERCUSSION"));
      expect(tr("SHORT_PERCUSSION")).toBeGreaterThan(tr("WHITE_NOISE"));
      expect(tr("WHITE_NOISE")).toBeGreaterThan(tr("PURE_TONE"));
      expect(chars.SILENCE.transient).toBeNull();
    });

    it("brightness: WHITE_NOISE > IMPULSE > SHORT_PERCUSSION > PURE_TONE; SILENCE null", () => {
      const b = (k: keyof typeof chars) => chars[k].brightness as number;
      expect(b("WHITE_NOISE")).toBeGreaterThan(b("IMPULSE"));
      expect(b("IMPULSE")).toBeGreaterThan(b("SHORT_PERCUSSION"));
      expect(b("SHORT_PERCUSSION")).toBeGreaterThan(b("PURE_TONE"));
      expect(chars.SILENCE.brightness).toBeNull();
    });

    it("density: IMPULSE > WHITE_NOISE > SHORT_PERCUSSION > PURE_TONE", () => {
      const de = (k: keyof typeof chars) => chars[k].density as number;
      expect(de("IMPULSE")).toBeGreaterThan(de("WHITE_NOISE"));
      expect(de("WHITE_NOISE")).toBeGreaterThan(de("SHORT_PERCUSSION"));
      expect(de("SHORT_PERCUSSION")).toBeGreaterThan(de("PURE_TONE"));
    });

    it("dynamics: IMPULSE > WHITE_NOISE > SHORT_PERCUSSION > PURE_TONE; SILENCE null", () => {
      const dy = (k: keyof typeof chars) => chars[k].dynamics as number;
      expect(dy("IMPULSE")).toBeGreaterThan(dy("WHITE_NOISE"));
      expect(dy("WHITE_NOISE")).toBeGreaterThan(dy("SHORT_PERCUSSION"));
      expect(dy("SHORT_PERCUSSION")).toBeGreaterThan(dy("PURE_TONE"));
      expect(chars.SILENCE.dynamics).toBeNull();
    });

    it("complexity: IMPULSE > WHITE_NOISE > SHORT_PERCUSSION > PURE_TONE", () => {
      const cn = (k: keyof typeof chars) => chars[k].complexity as number;
      expect(cn("IMPULSE")).toBeGreaterThan(cn("WHITE_NOISE"));
      expect(cn("WHITE_NOISE")).toBeGreaterThan(cn("SHORT_PERCUSSION"));
      expect(cn("SHORT_PERCUSSION")).toBeGreaterThan(cn("PURE_TONE"));
    });
  });
});

describe("computeSoundCharacterQuality", () => {
  const chars = derived();

  it("coverage is the fraction of determinable dimensions", () => {
    const qPure = computeSoundCharacterQuality(chars.PURE_TONE);
    expect(qPure.featureCoverage).toBe(1);
    const qSilence = computeSoundCharacterQuality(chars.SILENCE);
    expect(qSilence.featureCoverage).toBe(0.5);
  });

  it("overall is in [0,1] for every fixture", () => {
    for (const name in chars) {
      const q = computeSoundCharacterQuality(chars[name as keyof typeof chars]);
      expect(q.overall).toBeGreaterThanOrEqual(0);
      expect(q.overall).toBeLessThanOrEqual(1);
      expect(Number.isFinite(q.overall)).toBe(true);
      expect(Number.isFinite(q.featureCoverage)).toBe(true);
    }
  });

  it("a fully-indeterminate character scores overall 0 with coverage 0", () => {
    const q = computeSoundCharacterQuality(emptySoundCharacter());
    expect(q.overall).toBe(0);
    expect(q.featureCoverage).toBe(0);
  });

  it("overall is the V2-weight-weighted mean of the present dimension values", () => {
    const char = chars.PURE_TONE;
    const q = computeSoundCharacterQuality(char);
    const expected = SOUND_CHARACTER_DIMENSIONS.reduce(
      (acc, dim, i) => acc + V2_SIMILARITY_WEIGHTS[i] * (char[dim] as number),
      0,
    );
    expect(q.overall).toBeCloseTo(expected, 12);
  });
});

describe("validateSoundCharacter", () => {
  it("rejects NaN/Infinity and out-of-range values on any dimension", () => {
    expect(validateSoundCharacter({ ...emptySoundCharacter(), brightness: NaN }).valid).toBe(false);
    expect(validateSoundCharacter({ ...emptySoundCharacter(), density: 1.5 }).valid).toBe(false);
    expect(validateSoundCharacter({ ...emptySoundCharacter(), transient: -0.1 }).valid).toBe(false);
  });
  it("accepts null dims and missing is an error", () => {
    expect(validateSoundCharacter(emptySoundCharacter()).valid).toBe(true);
    const { brightness: _omit, ...rest } = emptySoundCharacter();
    expect(validateSoundCharacter(rest).valid).toBe(false);
  });
});

describe("toSimilarityVector", () => {
  it("keeps the stable canonical dimension order with nulls preserved", () => {
    const char = computeSoundCharacter(SILENCE);
    const vector = toSimilarityVector(char);
    expect(vector).toHaveLength(8);
    SOUND_CHARACTER_DIMENSIONS.forEach((dim, i) => {
      expect(vector[i]).toBe(char[dim]);
    });
  });
  it("exposes the same order for every fixture", () => {
    for (const name in ALL) {
      const vector = toSimilarityVector(computeSoundCharacter(ALL[name as keyof typeof ALL]));
      expect(vector).toHaveLength(8);
      expect(vector.every((v) => v === null || (v >= 0 && v <= 1))).toBe(true);
    }
  });
});