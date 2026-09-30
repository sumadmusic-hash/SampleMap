import { describe, it, expect } from "vitest";
import {
  computeSoundCharacter,
  validateSoundCharacter,
  toSimilarityVector,
  computeSoundCharacterQuality,
  type SoundCharacter,
} from "./soundCharacter";
import { SOUND_CHARACTER_DIMENSIONS } from "./config";
import { analyzeCorpus } from "../audio/v2Fixtures";

const _charCache = new Map<string, SoundCharacter>();
function C(name: string): SoundCharacter {
  let c = _charCache.get(name);
  if (!c) {
    c = computeSoundCharacter(analyzeCorpus(name, 44100));
    _charCache.set(name, c);
  }
  return c;
}

describe("SoundCharacter calibration on DSP-extracted corpus (STEP21)", () => {
  it("produces valid characters for every corpus member (dims [0,1]|null, never NaN)", () => {
    for (const name of [
      "silence",
      "pureTone440",
      "lowSine110",
      "highSine2000",
      "whiteNoise",
      "pinkNoise",
      "impulse",
      "shortClick",
      "sustainedTone",
      "swellTone",
      "decayingTone90",
      "percussiveNoiseHit",
      "lowThump",
      "highThump",
      "detunedHarmonic",
      "bellLike",
    ]) {
      const c = C(name);
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

  it("is deterministic and each character exposes the stable similarity vector", () => {
    for (const name of [
      "pureTone440",
      "whiteNoise",
      "impulse",
      "sustainedTone",
      "bellLike",
    ]) {
      expect(C(name)).toEqual(computeSoundCharacter(analyzeCorpus(name, 44100)));
      const v = toSimilarityVector(C(name));
      expect(v).toHaveLength(8);
      SOUND_CHARACTER_DIMENSIONS.forEach((dim, i) => expect(v[i]).toBe(C(name)[dim]));
    }
  });

  describe("brightness", () => {
    it("orders low < pure < high sine, all below full-band noise", () => {
      expect(C("lowSine110").brightness as number).toBeLessThan(C("pureTone440").brightness as number);
      expect(C("pureTone440").brightness as number).toBeLessThan(C("highSine2000").brightness as number);
      expect(C("highSine2000").brightness as number).toBeLessThan(C("whiteNoise").brightness as number);
    });
    it("a decaying 90 Hz body is darker than the 440 Hz reference", () => {
      expect(C("decayingTone90").brightness as number).toBeLessThan(C("pureTone440").brightness as number);
    });
    it("silence brightness is indeterminable (null)", () => {
      expect(C("silence").brightness).toBeNull();
    });
  });

  describe("tonality / noisiness", () => {
    it("pure and short sounds are strongly tonal", () => {
      expect(C("pureTone440").tonality as number).toBeGreaterThan(0.9);
      expect(C("shortClick").tonality as number).toBeGreaterThan(0.9);
      expect(C("bellLike").tonality as number).toBeGreaterThan(0.8);
    });
    it("noise is the least tonal, most noisy; pink sits between, tones are clean", () => {
      expect(C("whiteNoise").tonality as number).toBeLessThan(0.3);
      expect(C("whiteNoise").noisiness as number).toBeGreaterThan(0.8);
      expect(C("pinkNoise").noisiness as number).toBeGreaterThan(C("pureTone440").noisiness as number);
      expect(C("whiteNoise").noisiness as number).toBeGreaterThan(C("pinkNoise").noisiness as number);
      expect(C("pinkNoise").tonality as number).toBeGreaterThan(C("whiteNoise").tonality as number);
      expect(C("pureTone440").noisiness as number).toBeLessThan(0.1);
    });
    it("a percussive noise hit is nearly as noisy as white noise", () => {
      expect(C("percussiveNoiseHit").noisiness as number).toBeGreaterThan(0.8);
    });

    describe("tonality: DSP periodicity semantics (STEP88)", () => {
      const t = (n: string) => C(n).tonality as number;

      it("a pure tone is far more tonal than broadband noise", () => {
        expect(t("pureTone440")).toBeGreaterThan(t("whiteNoise"));
      });

      it("a pure tone is far more tonal than a percussive noise hit", () => {
        expect(t("pureTone440")).toBeGreaterThan(t("percussiveNoiseHit"));
      });

      it("harmonic and clearly tonal material stays high", () => {
        for (const n of ["pureTone440", "lowSine110", "highSine2000", "sustainedTone", "detunedHarmonic", "bellLike", "lowThump", "highThump"]) {
          expect(t(n), n).toBeGreaterThan(0.7);
        }
      });

      it("noise-like and hi-hat / transient material stays low", () => {
        for (const n of ["whiteNoise", "percussiveNoiseHit", "impulse"]) {
          expect(t(n), n).toBeLessThan(0.3);
        }
      });

      it("a missing pitch does NOT imply high tonality: it falls back to harmonicity", () => {
        // On this DSP corpus whiteNoise / percussiveNoiseHit / impulse are
        // genuinely unvoiced, so `pitchConfidence` is null for them. Their
        // tonality must collapse onto the (low) autocorrelation periodicity
        // measure instead of inheriting any "detected pitch" default.
        for (const n of ["whiteNoise", "percussiveNoiseHit", "impulse"]) {
          const f = analyzeCorpus(n, 44100);
          expect(f.pitchConfidence, n).toBeNull();
          expect(t(n), n).toBeCloseTo(f.harmonicity as number, 12);
        }
      });

      it("STEP88 regression: a gated pitchConfidence can no longer plant a tonality floor", () => {
        // pitchConfidence is recorded only for frames with bestCm < 0.3, so any
        // value that exists is > 0.7. At the previous 0.6 weight that implied
        // tonality >= 0.42 for every voiced record; at 0.2 the floor is 0.14 and
        // a low harmonicity still dominates.
        for (const n of ["pureTone440", "bellLike", "lowThump"]) {
          const f = analyzeCorpus(n, 44100);
          expect(f.pitchConfidence as number, n).toBeGreaterThan(0.7);
          expect(t(n), n).toBeCloseTo(0.8 * (f.harmonicity as number) + 0.2 * (f.pitchConfidence as number), 12);
        }
        // harmonicity, not the gated confidence, decides the ordering.
        expect(t("bellLike")).toBeGreaterThan(t("whiteNoise"));
      });

      it("tonality stays in [0,1] and the axis semantics Noisy <- Tonal are preserved", () => {
        for (const n of [
          "pureTone440", "lowSine110", "highSine2000", "whiteNoise", "pinkNoise",
          "impulse", "shortClick", "sustainedTone", "percussiveNoiseHit", "bellLike",
        ]) {
          const v = C(n).tonality;
          expect(Number.isFinite(v as number), n).toBe(true);
          expect(v as number, n).toBeGreaterThanOrEqual(0);
          expect(v as number, n).toBeLessThanOrEqual(1);
        }
        // every tone sits right of every noise-like source
        for (const tone of ["pureTone440", "lowSine110", "highSine2000", "sustainedTone"]) {
          for (const noise of ["whiteNoise", "pinkNoise", "percussiveNoiseHit", "impulse"]) {
            expect(t(tone), `${tone} vs ${noise}`).toBeGreaterThan(t(noise));
          }
        }
      });
    });
  });

  describe("transient / dynamics", () => {
    it("impulse is the most transient; a slow attack is the least", () => {
      const impulse = C("impulse").transient as number;
      expect(impulse).toBeGreaterThan(0.8);
      expect(impulse).toBeGreaterThan(C("shortClick").transient as number);
      expect(impulse).toBeGreaterThan(C("pureTone440").transient as number);
      expect(C("swellTone").transient as number).toBeLessThan(C("pureTone440").transient as number);
    });
    it("impulse is far more dynamic than a steady tone", () => {
      expect(C("impulse").dynamics as number).toBeGreaterThan(C("pureTone440").dynamics as number);
      expect(C("pureTone440").dynamics as number).toBeLessThan(0.1);
    });
  });

  describe("duration", () => {
    it("a sustained tone outlasts the 440 reference, which outlasts a decaying low tone", () => {
      expect(C("sustainedTone").duration as number).toBeGreaterThan(C("pureTone440").duration as number);
      expect(C("pureTone440").duration as number).toBeGreaterThan(C("decayingTone90").duration as number);
    });
    it("silence still has a determinable (short) duration", () => {
      expect(C("silence").duration).not.toBeNull();
      expect(C("silence").duration as number).toBeLessThan(1);
    });
  });

  describe("density / complexity", () => {
    it("noise is denser and more complex than a pure tone", () => {
      expect(C("whiteNoise").density as number).toBeGreaterThan(C("pureTone440").density as number);
      expect(C("whiteNoise").complexity as number).toBeGreaterThan(C("pureTone440").complexity as number);
    });
    it("silence density and complexity are dim (finite floor)", () => {
      expect(C("silence").density).toBe(0);
      expect(C("silence").complexity).toBe(0);
    });
  });

  describe("quality", () => {
    it("the pure tone is fully covered; silence loses the four indeterminable dims", () => {
      expect(computeSoundCharacterQuality(C("pureTone440")).featureCoverage).toBe(1);
      expect(computeSoundCharacterQuality(C("silence")).featureCoverage).toBe(0.5);
    });
  });
});