import { describe, it, expect } from "vitest";
import {
  renderCorpus,
  analyzeCorpus,
  V2_CORPUS_NAMES,
  V2_SAMPLE_RATES,
} from "./v2Fixtures";
import { validateAudioFeaturesV2 } from "../analysis/audioFeaturesV2";

const _cache = new Map<string, ReturnType<typeof analyzeCorpus>>();
function F(name: string, sr: number): ReturnType<typeof analyzeCorpus> {
  const key = `${name}@${sr}`;
  let f = _cache.get(key);
  if (!f) {
    f = analyzeCorpus(name, sr);
    _cache.set(key, f);
  }
  return f;
}

describe("V2 calibration corpus (FIXTURE-class evidence)", () => {
  it("every corpus signal renders a finite, non-empty mono buffer", () => {
    for (const name of V2_CORPUS_NAMES) {
      const x = renderCorpus(name, 44100);
      expect(x.length).toBeGreaterThan(0);
      for (let i = 0; i < x.length; i++) expect(Number.isFinite(x[i])).toBe(true);
    }
  });

  it("rendering is exactly deterministic (seeded PRNG / closed-form only)", () => {
    for (const name of V2_CORPUS_NAMES) {
      expect(renderCorpus(name, 44100)).toEqual(renderCorpus(name, 44100));
    }
  });

  it("analysis of every corpus member at every sample rate is structurally valid", () => {
    for (const name of V2_CORPUS_NAMES) {
      for (const sr of V2_SAMPLE_RATES) {
        expect(validateAudioFeaturesV2(F(name, sr)).valid).toBe(true);
      }
    }
  });

  it("renders sample-rate-proportional buffer lengths (physical durations)", () => {
    const x22 = renderCorpus("pureTone440", 22050);
    const x96 = renderCorpus("pureTone440", 96000);
    expect(x96.length / x22.length).toBeCloseTo(96000 / 22050, 4);
  });
});

describe("sample-rate independence (22050 / 44100 / 48000 / 96000)", () => {
  const RATES = V2_SAMPLE_RATES;
  const REF = 44100;

  const TONES: Array<{ name: string; f0: number; durSec: number }> = [
    { name: "pureTone440", f0: 440, durSec: 0.6 },
    { name: "sustainedTone", f0: 330, durSec: 2 },
    { name: "swellTone", f0: 440, durSec: 1 },
    { name: "decayingTone90", f0: 90, durSec: 0.25 },
  ];

  for (const { name, f0 } of TONES) {
    describe(name, () => {
      const ref = F(name, REF);

      it("pitch tracks the nominal frequency at every rate", () => {
        for (const sr of RATES) {
          const f = F(name, sr);
          expect(f.pitchHz as number).toBeGreaterThan(f0 * 0.99);
          expect(f.pitchHz as number).toBeLessThan(f0 * 1.01);
          expect(f.pitchConfidence as number).toBeGreaterThan(0.9);
        }
      });

      it("energy (rms), crest and centroid are rate-independent", () => {
        for (const sr of RATES) {
          const f = F(name, sr);
          expect(Math.abs((f.rms - ref.rms) / ref.rms)).toBeLessThan(0.02);
          expect(Math.abs(((f.crestFactor as number) - (ref.crestFactor as number)) / (ref.crestFactor as number))).toBeLessThan(0.05);
          if (ref.spectralCentroidHz !== null) {
            expect(Math.abs((f.spectralCentroidHz as number - ref.spectralCentroidHz) / ref.spectralCentroidHz)).toBeLessThan(0.05);
          }
        }
      });

      it("tonal quality is preserved: harmonicity high, flatness low", () => {
        for (const sr of RATES) {
          const f = F(name, sr);
          expect(f.harmonicity as number).toBeGreaterThan(0.9);
          expect(f.spectralFlatness as number).toBeLessThan(0.05);
        }
      });
    });
  }

  it("swellTone keeps its long attack at every rate", () => {
    for (const sr of RATES) {
      expect(F("swellTone", sr).attackTimeSec).toBeGreaterThan(0.15);
      expect(F("swellTone", sr).attackTimeSec).toBeLessThan(0.35);
    }
  });

  it("decayingTone90 keeps its decay and null attack at every rate", () => {
    for (const sr of RATES) {
      expect(F("decayingTone90", sr).decayTimeSec).toBeGreaterThan(0.03);
      expect(F("decayingTone90", sr).decayTimeSec).toBeLessThan(0.1);
      expect(F("decayingTone90", sr).attackTimeSec).toBeLessThan(0.05);
    }
  });

  describe("noise is unvoiced and rate-independently noisy", () => {
    it("white noise: no pitch, flat spectrum, low harmonicity at every rate", () => {
      for (const sr of RATES) {
        const f = F("whiteNoise", sr);
        expect(f.pitchHz).toBeNull();
        expect(f.pitchConfidence).toBeNull();
        expect(f.spectralFlatness as number).toBeGreaterThan(0.7);
        expect(f.harmonicity as number).toBeLessThan(0.35);
      }
    });

    it("pink noise: mid flatness, strong negative slope, no pitch at every rate", () => {
      for (const sr of RATES) {
        const f = F("pinkNoise", sr);
        expect(f.pitchHz).toBeNull();
        expect(f.spectralFlatness as number).toBeGreaterThan(0.4);
        expect(f.spectralFlatness as number).toBeLessThan(0.8);
        expect(f.spectralSlope as number).toBeLessThan(-0.3);
        expect(f.spectralSlope as number).toBeGreaterThan(-1.5);
      }
    });
  });
});

describe("feature semantics at 44100 Hz (corpus baseline)", () => {
  it("impulse is the strongest transient with the largest crest", () => {
    const f = F("impulse", 44100);
    expect(f.transientStrength as number).toBeGreaterThan(10);
    expect(f.crestFactor as number).toBeGreaterThan(10);
    expect(f.attackTimeSec).not.toBeNull();
  });

  it("the pure tone is the canonical clean tone: pitch 440, no decay", () => {
    const f = F("pureTone440", 44100);
    expect(f.pitchHz as number).toBeGreaterThan(435);
    expect(f.pitchHz as number).toBeLessThan(445);
    expect(f.harmonicity as number).toBeGreaterThan(0.95);
    expect(f.decayTimeSec).toBeNull();
    expect(f.spectralCentroidHz as number).toBeGreaterThan(400);
  });

  it("low vs high sine: spectral centroid orders brightness correctly", () => {
    expect(F("highSine2000", 44100).spectralCentroidHz as number).toBeGreaterThan(
      F("pureTone440", 44100).spectralCentroidHz as number,
    );
    expect(F("lowSine110", 44100).spectralCentroidHz as number).toBeLessThan(
      F("pureTone440", 44100).spectralCentroidHz as number,
    );
  });

  it("sustained tone decays to null while percussive sources decay measurably", () => {
    expect(F("sustainedTone", 44100).decayTimeSec).toBeNull();
    expect(F("decayingTone90", 44100).decayTimeSec).not.toBeNull();
    expect(F("percussiveNoiseHit", 44100).decayTimeSec).not.toBeNull();
    expect(F("swellTone", 44100).attackTimeSec as number).toBeGreaterThan(
      F("pureTone440", 44100).attackTimeSec as number,
    );
  });

  it("click-and-thump pitches land at their nominal frequencies", () => {
    const click = F("shortClick", 44100);
    expect(click.pitchHz as number).toBeGreaterThan(980);
    expect(click.pitchHz as number).toBeLessThan(1020);
    expect(F("lowThump", 44100).pitchHz as number).toBeGreaterThan(43);
    expect(F("lowThump", 44100).pitchHz as number).toBeLessThan(47);
    expect(F("highThump", 44100).pitchHz as number).toBeGreaterThan(3400);
    expect(F("highThump", 44100).pitchHz as number).toBeLessThan(3600);
  });

  it("inharmonicity: bell-like partials are more inharmonic than the detuned octave pair", () => {
    const detuned = F("detunedHarmonic", 44100);
    const bell = F("bellLike", 44100);
    expect(detuned.inharmonicity).not.toBeNull();
    expect(bell.inharmonicity).not.toBeNull();
    expect(bell.inharmonicity as number).toBeGreaterThan(detuned.inharmonicity as number);
    expect(F("pureTone440", 44100).inharmonicity).toBeNull();
    expect(F("whiteNoise", 44100).inharmonicity).toBeNull();
  });
});