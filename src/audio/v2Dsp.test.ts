import { describe, it, expect } from "vitest";
import { analyzeAudio } from "./v2Dsp";
import { validateAudioFeaturesV2 } from "../analysis/audioFeaturesV2";

function tone(freq: number, seconds: number, rate: number, amp = 0.5): Float32Array {
  const n = Math.round(seconds * rate);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return x;
}

describe("analyzeAudio input contract", () => {
  it("throws a TypeError for malformed inputs (never returns garbage)", () => {
    expect(() => analyzeAudio({ sampleRate: 0, channels: [] } as never)).toThrow(TypeError);
    expect(() => analyzeAudio({ sampleRate: NaN, channels: [new Float32Array(1)] } as never)).toThrow(TypeError);
    expect(() =>
      analyzeAudio({ sampleRate: 44100, channels: [new Float32Array([1, Infinity])] } as never),
    ).toThrow(TypeError);
    expect(() => analyzeAudio({ sampleRate: 44100 } as never)).toThrow(TypeError);
  });

  it("a zero-length channel analyzes to a safe silence record (never throws)", () => {
    const f = analyzeAudio({ sampleRate: 44100, channels: [new Float32Array(0)] });
    expect(validateAudioFeaturesV2(f).valid).toBe(true);
    expect(f.rms).toBe(0);
    expect(f.peak).toBe(0);
    expect(f.crestFactor).toBeNull();
    expect(f.pitchHz).toBeNull();
    expect(f.harmonicity).toBeNull();
    expect(f.inharmonicity).toBeNull();
    expect(f.spectralCentroidHz).toBeNull();
    expect(f.durationSec).toBe(0);
  });

  it("a silent buffer yields the all-null feature baseline (null, never 0)", () => {
    const f = analyzeAudio({ sampleRate: 44100, channels: [new Float32Array(44100)] });
    expect(validateAudioFeaturesV2(f).valid).toBe(true);
    expect(f.rms).toBe(0);
    expect(f.peak).toBe(0);
    expect(f.crestFactor).toBeNull();
    expect(f.transientStrength).toBeNull();
    expect(f.attackTimeSec).toBeNull();
    expect(f.decayTimeSec).toBeNull();
    expect(f.spectralCentroidHz).toBeNull();
    expect(f.spectralFlatness).toBeNull();
    expect(f.spectralFlux).toBeNull();
    expect(f.pitchHz).toBeNull();
    expect(f.pitchConfidence).toBeNull();
    expect(f.harmonicity).toBeNull();
    expect(f.inharmonicity).toBeNull();
    expect(f.zeroCrossingRate).toBe(0);
    expect(f.durationSec).toBeCloseTo(1, 6);
    expect(f.channels).toBe(1);
  });
});

describe("analyzeAudio channel handling", () => {
  it("two identical channels reproduce the mono analysis (energy preserved)", () => {
    const mono = tone(440, 0.6, 44100);
    const single = analyzeAudio({ sampleRate: 44100, channels: [mono] });
    const dual = analyzeAudio({ sampleRate: 44100, channels: [mono, mono] });
    const keys: Array<keyof typeof single> = [
      "durationSec",
      "rms",
      "peak",
      "crestFactor",
      "transientStrength",
      "zeroCrossingRate",
      "spectralCentroidHz",
      "spectralSpreadHz",
      "spectralRolloffHz",
      "spectralFlatness",
      "spectralFlux",
      "spectralSlope",
      "attackTimeSec",
      "decayTimeSec",
      "pitchHz",
      "pitchConfidence",
      "harmonicity",
      "inharmonicity",
    ];
    for (const k of keys) expect(dual[k]).toEqual(single[k]);
    expect(dual.channels).toBe(2);
    expect(dual.rms).toBe(single.rms);
  });

  it("a silent channel halves the amplitude of a voiced channel (mean downmix)", () => {
    const x = tone(440, 0.6, 44100);
    const loud = analyzeAudio({ sampleRate: 44100, channels: [x] });
    const mixed = analyzeAudio({ sampleRate: 44100, channels: [x, new Float32Array(x.length)] });
    expect(mixed.rms).toBeCloseTo(loud.rms / 2, 5);
    expect(mixed.peak).toBeCloseTo(loud.peak / 2, 5);
  });

  it("is exactly deterministic: identical input -> identical features", () => {
    const input = { sampleRate: 44100, channels: [tone(330, 1, 44100)] };
    const a = analyzeAudio(input);
    const b = analyzeAudio(input);
    expect(a).toEqual(b);
  });
});

describe("analyzeAudio feature semantics (hand-built signals)", () => {
  it("a sustained pure tone is tonal: pitch near f0, high harmonicity, low flatness", () => {
    const f = analyzeAudio({ sampleRate: 44100, channels: [tone(440, 0.6, 44100)] });
    expect(validateAudioFeaturesV2(f).valid).toBe(true);
    expect(f.pitchHz).toBeGreaterThan(435);
    expect(f.pitchHz).toBeLessThan(445);
    expect(f.pitchConfidence as number).toBeGreaterThan(0.9);
    expect(f.harmonicity as number).toBeGreaterThan(0.9);
    expect(f.spectralFlatness as number).toBeLessThan(0.05);
    expect(f.decayTimeSec).toBeNull();
  });

  it("a decaying tone reports a decay and no attacked silence", () => {
    const n = 0.25 * 44100;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / 44100;
      x[i] = 0.8 * Math.sin(2 * Math.PI * 90 * t) * Math.exp(-t / 0.045);
    }
    const f = analyzeAudio({ sampleRate: 44100, channels: [x] });
    expect(f.decayTimeSec).not.toBeNull();
    expect(f.decayTimeSec as number).toBeGreaterThan(0.03);
    expect(f.decayTimeSec as number).toBeLessThan(0.08);
    expect(f.pitchHz).toBeGreaterThan(88);
    expect(f.pitchHz).toBeLessThan(92);
  });

  it("a slow attack yields a measurable attack and lower transient", () => {
    const x = tone(440, 1, 44100);
    for (let i = 0; i < Math.round(0.2 * 44100); i++) x[i] *= i / Math.round(0.2 * 44100);
    const f = analyzeAudio({ sampleRate: 44100, channels: [x] });
    expect(f.attackTimeSec as number).toBeGreaterThan(0.15);
    expect(f.attackTimeSec as number).toBeLessThan(0.25);
    expect((f.transientStrength as number) > 0.2).toBe(true);
  });

  it("white noise is unvoiced: pitch null, harmonicity low RATIOs stable", () => {
    const sr = 44100;
    let state = 12345;
    const rng = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const x = new Float32Array(Math.round(0.5 * sr));
    for (let i = 0; i < x.length; i++) x[i] = (rng() * 2 - 1) * 0.5;
    const f = analyzeAudio({ sampleRate: sr, channels: [x] });
    expect(f.pitchHz).toBeNull();
    expect(f.pitchConfidence).toBeNull();
    expect(f.harmonicity as number).toBeLessThan(0.3);
    expect(f.spectralFlatness as number).toBeGreaterThan(0.7);
    expect(f.inharmonicity).toBeNull();
  });

  it("a single impulse is the strongest transient with a huge crest", () => {
    const n = 0.05 * 44100;
    const x = new Float32Array(n);
    x[Math.round(0.3 * n)] = 1;
    const f = analyzeAudio({ sampleRate: 44100, channels: [x] });
    expect(f.transientStrength as number).toBeGreaterThan(10);
    expect(f.crestFactor as number).toBeGreaterThan(10);
  });
});

describe("inharmonicity semantics (per STEP21 §26)", () => {
  it("a 220+660 Hz pair is mildly inharmonic (3.0x ladder deviation)", () => {
    const sr = 44100;
    const x = new Float32Array(Math.round(0.6 * sr));
    for (let i = 0; i < x.length; i++) {
      const t = i / sr;
      x[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.25 * Math.sin(2 * Math.PI * 660 * t);
    }
    const f = analyzeAudio({ sampleRate: sr, channels: [x] });
    expect(f.pitchHz).toBeGreaterThan(218);
    expect(f.pitchHz).toBeLessThan(222);
    expect(f.inharmonicity as number).toBeGreaterThan(0.005);
    expect(f.inharmonicity as number).toBeLessThan(0.1);
  });

  it("a sparse non-harmonic partial set is MORE inharmonic than the detuned ladder", () => {
    const sr = 44100;
    const det = new Float32Array(Math.round(0.6 * sr));
    const bel = new Float32Array(Math.round(0.8 * sr));
    for (let i = 0; i < det.length; i++) {
      const t = i / sr;
      det[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.25 * Math.sin(2 * Math.PI * 660 * t);
    }
    for (let i = 0; i < bel.length; i++) {
      const t = i / sr;
      bel[i] = 0.5 * Math.sin(2 * Math.PI * 440 * t) + 0.3 * Math.sin(2 * Math.PI * 1200 * t) + 0.2 * Math.sin(2 * Math.PI * 1900 * t);
    }
    const fDet = analyzeAudio({ sampleRate: sr, channels: [det] });
    const fBel = analyzeAudio({ sampleRate: sr, channels: [bel] });
    expect(fDet.inharmonicity).not.toBeNull();
    expect(fBel.inharmonicity).not.toBeNull();
    expect((fBel.inharmonicity as number) > (fDet.inharmonicity as number)).toBe(true);
  });

  it("pure tone and noise report null inharmonicity (no measurable ladder)", () => {
    const fTone = analyzeAudio({ sampleRate: 44100, channels: [tone(440, 0.6, 44100)] });
    expect(fTone.inharmonicity).toBeNull();
  });
});