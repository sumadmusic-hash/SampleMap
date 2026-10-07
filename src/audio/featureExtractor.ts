import type { DecodedAudio } from "./decodedAudio";
import type { AudioFeatures } from "../persistence/indexStore";

/**
 * Pure audio feature extraction (SAMPLEMAP_V1_SPEC §6). Operates on decoded PCM
 * (mono-summed Float32Array) and returns the V1 feature set. This module has no
 * I/O and no persistence — it is free of the audio-bytes invariant and lives
 * purely in the analysis worker's transient memory.
 */

const FFT_SIZE = 1024;
/** Frame hop (50 % overlap) for the whole-signal spectral aggregation. */
const SPECTRAL_HOP = FFT_SIZE / 2;

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

/**
 * Whole-signal spectral statistics.
 *
 * Stats are aggregated across ENERGY-BEARING frames over the entire buffer,
 * mirroring the V2 DSP chain: every frame is Hann-windowed, and a frame whose
 * magnitude sum is zero (digital silence) is SKIPPED, never measured.
 *
 * Why this matters: this function used to analyse only the FIRST
 * `min(n, FFT_SIZE)` samples. Real samples very often begin with digital
 * silence (encoder priming delay, a leading rest), and a silent frame has a
 * zero magnitude sum — so the extractor returned its degenerate fallback
 * (`centroid 0, bandwidth 0, rolloff 0, flatness 1`) for the whole sample.
 * Measured against the live global index, 47.6 % of real records carried exactly
 * that fabricated pair (`flatness === 1`, `centroid === 0`) with real audio
 * behind it (rms 0.12, peak 0.71, duration 11.7 s) — not silence. Every
 * downstream consumer of these fields (the similarity fingerprint, the global
 * publish/hydrate round trip, and the spectral classifier thresholds) was
 * therefore reading a constant instead of a measurement.
 *
 * The fallback is still returned for a buffer that is silent throughout, which
 * is the one case where it is literally true.
 */
function computeSpectral(
  mono: Float32Array,
  sampleRate: number,
  n: number,
): SpectralStats {
  if (n === 0) return { centroid: 0, bandwidth: 0, rolloff: 0, flatness: 1 };
  // Totality guard: a zero/one-sample buffer carries no spectrum at all.
  if (n < 2) return { centroid: 0, bandwidth: 0, rolloff: 0, flatness: 1 };

  const fftN = FFT_SIZE;
  // Positive-frequency bins: k = 0..fftN/2
  const bins = fftN / 2 + 1;
  const freq = (k: number) => (k * sampleRate) / fftN;
  const window = hannWindow(fftN);
  const re = new Float32Array(fftN);
  const im = new Float32Array(fftN);

  let totalMagSum = 0;
  let centroidNum = 0;
  let bandwidthNum = 0;
  let rolloffNum = 0;
  let flatnessNum = 0;

  for (let off = 0; off < n; off += SPECTRAL_HOP) {
    for (let i = 0; i < fftN; i++) {
      const s = off + i;
      re[i] = s < n ? mono[s] * window[i] : 0;
      im[i] = 0;
    }
    fftInPlace(re, im);

    let total = 0;
    for (let k = 0; k < bins; k++) {
      total += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
    // Digital silence in THIS frame: skip it. A silent lead-in must never decide
    // the features of a sample that has real audio behind it.
    if (total <= 0) continue;

    let centroid = 0;
    for (let k = 0; k < bins; k++) {
      centroid += freq(k) * Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
    centroid /= total;

    let bandwidth = 0;
    for (let k = 0; k < bins; k++) {
      bandwidth += Math.sqrt(re[k] * re[k] + im[k] * im[k]) * (freq(k) - centroid) ** 2;
    }
    bandwidth = Math.sqrt(bandwidth / total);

    const rolloffEnergy = total * 0.85;
    let acc = 0;
    let rolloff = freq(bins - 1);
    for (let k = 0; k < bins; k++) {
      acc += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      if (acc >= rolloffEnergy) {
        rolloff = freq(k);
        break;
      }
    }

    // Geometric vs arithmetic mean over positive DC-excluded bins.
    let logSum = 0;
    let magSum = 0;
    for (let k = 1; k < bins; k++) {
      const m = Math.max(Math.sqrt(re[k] * re[k] + im[k] * im[k]), 1e-12);
      logSum += Math.log(m);
      magSum += m;
    }
    const count = bins - 1;
    const flatness =
      count > 0 && magSum > 0
        ? clamp01(Math.exp(logSum / count) / (magSum / count))
        : 1;

    // Magnitude-weighted aggregation across frames (same weighting as V2).
    totalMagSum += total;
    centroidNum += total * centroid;
    bandwidthNum += total * bandwidth;
    rolloffNum += total * rolloff;
    flatnessNum += total * flatness;
  }

  // No energy-bearing frame at all: the buffer is genuinely silent.
  if (totalMagSum <= 0) return { centroid: 0, bandwidth: 0, rolloff: 0, flatness: 1 };

  return {
    centroid: centroidNum / totalMagSum,
    bandwidth: bandwidthNum / totalMagSum,
    rolloff: rolloffNum / totalMagSum,
    flatness: flatnessNum / totalMagSum,
  };
}

/** Hann window coefficients of length `n` (deterministic, double precision). */
function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1 || 1)));
  }
  return w;
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

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
