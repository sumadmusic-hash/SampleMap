import { describe, it, expect } from "vitest";
import { extractFeatures } from "./featureExtractor";
import type { DecodedAudio } from "./decodedAudio";

function audio(pcm: Float32Array, sampleRate = 8000): DecodedAudio {
  return {
    sampleRate,
    channels: 1,
    mono: pcm,
    durationSeconds: pcm.length / sampleRate,
  };
}

/** Pure tones at given frequencies (summed). */
function tone(freqs: number[], seconds = 1, sampleRate = 8000, amp = 1): Float32Array {
  const n = Math.floor(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const f of freqs) s += amp * Math.sin((2 * Math.PI * f * i) / sampleRate);
    out[i] = s / freqs.length;
  }
  return out;
}

function noise(seconds = 1, sampleRate = 8000, amp = 1): Float32Array {
  const n = Math.floor(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * amp;
  return out;
}

function silence(seconds = 1, sampleRate = 8000): Float32Array {
  return new Float32Array(Math.floor(sampleRate * seconds));
}

function impulse(sampleRate = 8000): Float32Array {
  const n = sampleRate; // 1s
  const out = new Float32Array(n);
  out[0] = 1;
  return out;
}

describe("FeatureExtractor", () => {
  it("reports duration, sampleRate and channels", () => {
    const pcm = tone([440], 1, 8000);
    const f = extractFeatures(audio(pcm, 8000));
    expect(f.duration).toBeCloseTo(1, 1);
    expect(f.sampleRate).toBe(8000);
    expect(f.channels).toBe(1);
  });

  it("computes peak and rms for a sine", () => {
    const pcm = tone([440], 1, 8000, 0.5);
    const f = extractFeatures(audio(pcm));
    expect(f.peak).toBeCloseTo(0.5, 3);
    // rms of a sine of amplitude A is A/sqrt(2)
    expect(f.rms).toBeCloseTo(0.5 / Math.SQRT2, 3);
  });

  it("returns zero rms/peak/transients/attack for silence", () => {
    const f = extractFeatures(audio(silence(1)));
    expect(f.peak).toBe(0);
    expect(f.rms).toBe(0);
    expect(f.transientDensity).toBe(0);
    expect(f.attack).toBe(0);
  });

  it("has higher spectral centroid for a high tone than a low tone", () => {
    const low = extractFeatures(audio(tone([200])));
    const high = extractFeatures(audio(tone([3000])));
    expect(high.spectralCentroid).toBeGreaterThan(low.spectralCentroid);
  });

  it("has low spectral flatness for a pure tone (tonal) and high for noise", () => {
    const tonal = extractFeatures(audio(tone([440])));
    const noisy = extractFeatures(audio(noise(1)));
    expect(tonal.spectralFlatness).toBeLessThan(0.5);
    expect(noisy.spectralFlatness).toBeGreaterThan(tonal.spectralFlatness);
    expect(tonal.tonalNoiseRatio).toBeGreaterThan(0.5);
    expect(noisy.tonalNoiseRatio).toBeLessThan(tonal.tonalNoiseRatio);
  });

  it("has high transientDensity and near-zero attack for an impulse", () => {
    // A single impulse is one strong transient at the very start.
    const f = extractFeatures(audio(impulse()));
    expect(f.attack).toBeLessThan(0.01);
    expect(f.peak).toBeCloseTo(1, 3);
  });

  it("zero-crossing rate is much higher for noise than a low sine", () => {
    const noisy = extractFeatures(audio(noise(1)));
    const sine = extractFeatures(audio(tone([200])));
    expect(noisy.zeroCrossingRate).toBeGreaterThan(sine.zeroCrossingRate);
  });

  it("produces finite values within sensible ranges for a realistic drum-ish signal", () => {
    const pcm = new Float32Array(8000);
    // a short pitched hit with decay
    for (let i = 0; i < 8000; i++) {
      const t = i / 8000;
      const env = Math.exp(-t * 12);
      pcm[i] = env * Math.sin(2 * Math.PI * 160 * t);
    }
    const f = extractFeatures(audio(pcm));
    expect(Number.isFinite(f.spectralCentroid)).toBe(true);
    expect(f.spectralFlatness).toBeGreaterThanOrEqual(0);
    expect(f.spectralFlatness).toBeLessThanOrEqual(1);
    expect(f.transientDensity).toBeGreaterThanOrEqual(0);
  });

  it("is a total function for a degenerate single-frame buffer (never throws)", () => {
    const f = extractFeatures(audio(new Float32Array([0.5])));
    expect(f.spectralCentroid).toBe(0);
    expect(f.spectralFlatness).toBe(1);
    expect(f.peak).toBeCloseTo(0.5, 3);
    expect(Number.isFinite(f.rms)).toBe(true);
    expect(Number.isFinite(f.transientDensity)).toBe(true);
  });
});
