import type { DecodedAudio } from "./decodedAudio";
import type { AudioFeatures } from "../persistence/indexStore";

/**
 * Pure audio feature extraction (SAMPLEMAP_V1_SPEC §6). Operates on decoded PCM
 * (mono-summed Float32Array) and returns the V1 feature set. This module has no
 * I/O and no persistence — it is free of the audio-bytes invariant and lives
 * purely in the analysis worker's transient memory.
 */

const FFT_SIZE = 1024;

export type { AudioFeatures } from "../persistence/indexStore";

export function extractFeatures(audio: DecodedAudio): AudioFeatures {
  const { mono, sampleRate, channels, durationSeconds } = audio;
  const n = mono.length;

  const peak = computePeak(mono);
  const rms = computeRms(mono);
  const zeroCrossingRate = computeZeroCrossingRate(mono, n);
  const { transientDensity, attack } = computeTransientsAttack(
    mono,
    sampleRate,
    n,
    durationSeconds,
  );
  const spectral = computeSpectral(mono, sampleRate, n);
  const spectralFlatness = spectral.flatness;
  const tonalNoiseRatio = clamp01(1 - spectralFlatness);

  return {
    duration: durationSeconds,
    sampleRate,
    channels,
    rms,
    peak,
    transientDensity,
    spectralCentroid: spectral.centroid,
    spectralBandwidth: spectral.bandwidth,
    spectralRolloff: spectral.rolloff,
    zeroCrossingRate,
    spectralFlatness,
    attack,
    tonalNoiseRatio,
  };
}

function computePeak(mono: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const a = Math.abs(mono[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

function computeRms(mono: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < mono.length; i++) sum += mono[i] * mono[i];
  return Math.sqrt(sum / Math.max(1, mono.length));
}

function computeZeroCrossingRate(mono: Float32Array, n: number): number {
  if (n < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < n; i++) {
    if ((mono[i - 1] < 0 && mono[i] >= 0) || (mono[i - 1] >= 0 && mono[i] < 0)) {
      crossings++;
    }
  }
  return crossings / (n - 1);
}

function computeTransientsAttack(
  mono: Float32Array,
  sampleRate: number,
  n: number,
  durationSeconds: number,
): { transientDensity: number; attack: number } {
  const window = 512;
  const hop = 256;
  const numWindows = Math.max(1, Math.floor((n - window) / hop) + 1);
  const env = new Float32Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    const start = w * hop;
    let sum = 0;
    for (let i = 0; i < window && start + i < n; i++) {
      sum += mono[start + i] * mono[start + i];
    }
    env[w] = Math.sqrt(sum / window);
  }

  let mean = 0;
  for (let w = 0; w < numWindows; w++) mean += env[w];
  mean /= Math.max(1, numWindows);
  let variance = 0;
  for (let w = 0; w < numWindows; w++) variance += (env[w] - mean) ** 2;
  const std = Math.sqrt(variance / Math.max(1, numWindows));
  const threshold = mean + std;

  let transients = 0;
  for (let w = 1; w < numWindows; w++) {
    if (env[w] > threshold && env[w] > env[w - 1] * 1.3) transients++;
  }
  const transientDensity = durationSeconds > 0 ? transients / durationSeconds : 0;

  let maxEnv = 0;
  for (let w = 0; w < numWindows; w++) maxEnv = Math.max(maxEnv, env[w]);
  if (maxEnv <= 0) {
    // No signal energy -> no meaningful attack time.
    return { transientDensity: 0, attack: 0 };
  }
  const target = maxEnv * 0.9;
  let attack = durationSeconds;
  for (let w = 0; w < numWindows; w++) {
    if (env[w] >= target) {
      attack = (w * hop) / sampleRate;
      break;
    }
  }
  return { transientDensity, attack };
}

interface SpectralStats {
  centroid: number;
  bandwidth: number;
  rolloff: number;
  flatness: number;
}

function computeSpectral(
  mono: Float32Array,
  sampleRate: number,
  n: number,
): SpectralStats {
  if (n === 0) return { centroid: 0, bandwidth: 0, rolloff: 0, flatness: 1 };
  // Totality guard: the windowed FFT below is undefined for n === 1
  // (fftN === 1 -> Float32Array(1.5) RangeError). The extractor must be a
  // total function; the quality gate already rejects such inputs at the
  // pipeline boundary, but direct callers stay safe too.
  if (n < 2) return { centroid: 0, bandwidth: 0, rolloff: 0, flatness: 1 };
  const fftN = nextPow2(Math.min(n, FFT_SIZE));
  const mag = fftMag(mono.subarray(0, Math.min(n, fftN)), fftN);
  // Positive-frequency bins: k = 0..fftN/2
  const bins = mag.length;
  const freq = (k: number) => (k * sampleRate) / fftN;

  let totalMag = 0;
  for (let k = 0; k < bins; k++) totalMag += mag[k];
  if (totalMag <= 0) return { centroid: 0, bandwidth: 0, rolloff: 0, flatness: 1 };

  let centroid = 0;
  for (let k = 0; k < bins; k++) centroid += freq(k) * mag[k];
  centroid /= totalMag;

  let bandwidth = 0;
  for (let k = 0; k < bins; k++) bandwidth += mag[k] * (freq(k) - centroid) ** 2;
  bandwidth = Math.sqrt(bandwidth / totalMag);

  const rolloffEnergy = totalMag * 0.85;
  let acc = 0;
  let rolloff = freq(bins - 1);
  for (let k = 0; k < bins; k++) {
    acc += mag[k];
    if (acc >= rolloffEnergy) {
      rolloff = freq(k);
      break;
    }
  }

  // Geometric vs arithmetic mean over positive DC-excluded bins.
  let logSum = 0;
  let magSum = 0;
  let count = 0;
  for (let k = 1; k < bins; k++) {
    const m = Math.max(mag[k], 1e-12);
    logSum += Math.log(m);
    magSum += m;
    count++;
  }
  let flatness = 1;
  if (count > 0 && magSum > 0) {
    const geoMean = Math.exp(logSum / count);
    const arithMean = magSum / count;
    flatness = geoMean / arithMean;
  }
  flatness = clamp01(flatness);

  return { centroid, bandwidth, rolloff, flatness };
}

function fftMag(samples: Float32Array, n: number): Float32Array {
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  // Apply a Hann window to the input.
  for (let i = 0; i < samples.length; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (samples.length - 1 || 1)));
    re[i] = samples[i] * w;
  }
  fftInPlace(re, im);
  const half = n / 2 + 1;
  const mag = new Float32Array(half);
  for (let k = 0; k < half; k++) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
  return mag;
}

/** Iterative radix-2 Cooley-Tukey FFT in place. `n` must be a power of two. */
function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wR = Math.cos(ang);
    const wI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k++) {
        const uR = re[i + k];
        const uI = im[i + k];
        const vR = re[i + k + len / 2] * curR - im[i + k + len / 2] * curI;
        const vI = re[i + k + len / 2] * curI + im[i + k + len / 2] * curR;
        re[i + k] = uR + vR;
        im[i + k] = uI + vI;
        re[i + k + len / 2] = uR - vR;
        im[i + k + len / 2] = uI - vI;
        const nextR = curR * wR - curI * wI;
        curI = curR * wI + curI * wR;
        curR = nextR;
      }
    }
  }
}

function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
