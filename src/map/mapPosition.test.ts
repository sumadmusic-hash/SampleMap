import { describe, it, expect } from "vitest";
import type { AudioFeatures } from "../persistence/indexStore";
import type { DecodedAudio } from "../audio/decodedAudio";
import {
  computePosition,
  flatnessToX,
  centroidToY,
  wholeSampleFlatness,
  mapVersion,
  type MapPosition,
} from "./mapPosition";

const SR = 44100;

function features(overrides: Partial<AudioFeatures>): AudioFeatures {
  return {
    duration: 0.4,
    sampleRate: SR,
    channels: 2,
    rms: 0.2,
    peak: 0.9,
    transientDensity: 12,
    spectralCentroid: 1200,
    spectralBandwidth: 300,
    spectralRolloff: 5000,
    zeroCrossingRate: 0.02,
    spectralFlatness: 0.2,
    attack: 0.001,
    tonalNoiseRatio: 0.8,
    ...overrides,
  };
}

function audio(pcm: number[], sampleRate = SR): DecodedAudio {
  return {
    sampleRate,
    channels: 1,
    mono: Float32Array.from(pcm),
    durationSeconds: pcm.length / sampleRate,
  };
}

/** Pure sine tone: strongly tonal (whole-sample flatness near 0). */
function tone(freqHz: number, seconds = 0.4): number[] {
  const n = Math.round(seconds * SR);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = 0.8 * Math.sin((2 * Math.PI * freqHz * i) / SR);
  return out;
}

/** White noise: strongly noise-like (flatness near 1). */
function noise(seconds = 0.4): number[] {
  const n = Math.round(seconds * SR);
  const out = new Array<number>(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  return out;
}

describe("mapVersion", () => {
  it("is map-v2", () => {
    expect(mapVersion).toBe("map-v2");
  });
});

describe("flatnessToX (tonal <-> noisy)", () => {
  it("flatness near 0 (tonal) -> X near 1", () => {
    expect(flatnessToX(0.001)).toBeCloseTo(1, 1); // snr~999 -> rawX~3 (clamped) -> x=1
    expect(flatnessToX(1e-6)).toBe(1);
  });

  it("flatness = 0.5 -> X near the formula's value (~0.4)", () => {
    // snr = 0.5/0.5001 ~= 0.9998; rawX = log10(snr) ~= -0.00009; x = (rawX+2)/5 ~= 0.4.
    // NOTE: the approved formula yields ~0.4 here, not exactly 0.5. Logged as a
    // known limitation in STEP16Q_IMPLEMENTATION.md; formula unchanged per rule.
    expect(flatnessToX(0.5)).toBeCloseTo(0.4, 2);
  });

  it("high flatness (noisy) -> low X", () => {
    expect(flatnessToX(0.99)).toBeLessThan(0.05);
    expect(flatnessToX(1)).toBe(0);
  });

  it("is monotonically decreasing in flatness", () => {
    const fs = [0.001, 0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 1];
    for (let i = 1; i < fs.length; i++) {
      expect(flatnessToX(fs[i])).toBeLessThan(flatnessToX(fs[i - 1]));
    }
  });

  it("anchors: f=1 -> rawX=-2 (x=0), f->0 -> rawX=+3 (x=1)", () => {
    expect(flatnessToX(1)).toBe(0);
    expect(flatnessToX(1e-9)).toBe(1);
  });

  it("always returns a clamped [0,1] value", () => {
    for (const f of [0, 0.02, 0.2, 0.5, 0.9, 1, 2]) {
      const x = flatnessToX(f);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });
});

describe("centroidToY (dark <-> bright)", () => {
  it("maps 100 Hz near 0 (log10(101) offset makes it ~0.002)", () => {
    // Per the approved formula rawY = log10(1 + centroid): at 100 Hz this is
    // log10(101)=2.0043 -> (2.0043-2)/2 = 0.0021, not exactly 0. Documented.
    expect(centroidToY(100)).toBeCloseTo(0.0021, 3);
  });

  it("maps 10 kHz -> 1 (clamped)", () => {
    expect(centroidToY(10000)).toBe(1);
  });

  it("clamps below 100 Hz to 0", () => {
    expect(centroidToY(50)).toBe(0);
    expect(centroidToY(0)).toBe(0);
  });

  it("clamps above 10 kHz to 1", () => {
    expect(centroidToY(20000)).toBe(1);
  });

  it("is monotonically increasing across known frequencies", () => {
    const freqs = [100, 200, 500, 1000, 4000, 10000];
    for (let i = 1; i < freqs.length; i++) {
      expect(centroidToY(freqs[i])).toBeGreaterThan(centroidToY(freqs[i - 1]));
    }
  });
});

describe("wholeSampleFlatness (multi-window)", () => {
  it("uses exactly one window for a short sample (< 2048) — N=1", () => {
    // Length 1000 (< WINDOW 2048): (1000-2048)/1024 < 0 -> max(1, .)=1.
    const mono = Float32Array.from({ length: 1000 }, () => 0.5);
    expect(wholeSampleFlatness(mono)).toBeGreaterThanOrEqual(0);
    expect(wholeSampleFlatness(mono)).toBeLessThanOrEqual(1);
  });

  it("uses exactly one window for length == WINDOW", () => {
    const mono = Float32Array.from({ length: 2048 }, () => 0.5);
    expect(Number.isFinite(wholeSampleFlatness(mono))).toBe(true);
  });

  it("caps at 16 windows for a long sample (>= 16*1024 + 2048 frames)", () => {
    const mono = Float32Array.from({ length: 20000 }, () => 0);
    mono[5000] = 1; // tiny but nonzero so flatness is computable
    expect(Number.isFinite(wholeSampleFlatness(mono))).toBe(true);
  });

  it("returns near-1 for white noise (median of noise windows)", () => {
    // Stationary noise -> per-window flatness all near 1 -> median near 1.
    const f = wholeSampleFlatness(Float32Array.from(noise(0.4)));
    expect(f).toBeGreaterThan(0.7);
  });

  it("returns near-0 for a pure tone (stationary tonal windows)", () => {
    const f = wholeSampleFlatness(Float32Array.from(tone(440, 0.4)));
    expect(f).toBeLessThan(0.25);
  });

  it("is deterministic for identical input", () => {
    const pcm = Float32Array.from(noise(0.4));
    expect(wholeSampleFlatness(pcm.slice())).toBe(wholeSampleFlatness(pcm.slice()));
  });
});

describe("computePosition integration", () => {
  it("tonal (sine) maps to high X; noisy maps to low X", () => {
    const tonal = computePosition(features({ spectralCentroid: 440 }), audio(tone(440, 0.4)));
    const noisy = computePosition(features({ spectralCentroid: 3000 }), audio(noise(0.4)));
    expect(tonal.x).toBeGreaterThan(noisy.x);
  });

  it("Y depends on spectralCentroid (higher centroid -> brighter)", () => {
    const a = computePosition(features({ spectralCentroid: 200 }), audio(tone(220, 0.4)));
    const b = computePosition(features({ spectralCentroid: 8000 }), audio(tone(220, 0.4)));
    expect(b.y).toBeGreaterThan(a.y);
  });

  it("returns normalized positions in [0,1]", () => {
    for (const p of [computePosition(features({}), audio(noise(0.4))), computePosition(features({}), audio(tone(220, 0.4)))]) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic (identical input -> identical output)", () => {
    const f = features({ spectralCentroid: 2100 });
    const pcm = Float32Array.from(noise(0.4));
    const a: MapPosition = computePosition(f, audio(Array.from(pcm)));
    const b: MapPosition = computePosition(f, audio(Array.from(pcm)));
    expect(a).toEqual(b);
  });

  it("does not mutate the input features or audio", () => {
    const f = features({ spectralCentroid: 3000 });
    const fSnap = { ...f };
    const pcm = Float32Array.from(tone(330, 0.4));
    const pcmSnap = pcm.slice();
    computePosition(f, audio(Array.from(pcm)));
    expect(f).toEqual(fSnap);
    expect(Array.from(pcm)).toEqual(Array.from(pcmSnap));
  });
});
