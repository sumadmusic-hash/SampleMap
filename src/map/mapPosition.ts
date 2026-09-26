import type { AudioFeatures } from "../persistence/indexStore";
import type { DecodedAudio } from "../audio/decodedAudio";

/**
 * Semantic 2D SampleMap v2 position (STEP 16P / 16Q).
 *
 * V2 makes `mapPosition` a PERSISTED ANALYSIS RESULT, not a derived value
 * recomputed from `AudioFeatures`. Its authoritative computation requires
 * decoded audio (whole-sample multi-window flatness), which is only available
 * at analysis time. See STEP16Q_SPEC_BLOCKER_REPORT.md "ADOPTED ARCHITECTURE
 * DECISION" and STEP16Q_IMPLEMENTATION.md.
 *
 * `computePosition(features, decodedAudio)` is the single authoritative V2
 * computation. There is deliberately NO `mapPosition(features)` fallback: a
 * missing persisted V2 position is a Missing-V2 state reported by consumers,
 * never a silently recomputed V1 position (anti-fallback rule).
 *
 * The function is pure and fully deterministic: identical (decoded audio,
 * features) always yields identical output, independent of any other samples
 * (fixed anchors, no corpus normalization, no re-ranking).
 *
 * X axis (tonal <-> noisy): from the WHOLE-SAMPLE flatness (multi-window
 * median, not the persisted single-window one) via a log signal-to-noise ratio.
 *   snr  = (1 - flatOverall) / (flatOverall + 1e-4)
 *   rawX = log10(snr), clipped to [-2, +3]
 *   x    = (rawX + 2) / 5, clamped to [0,1]
 *
 * Y axis (dark <-> bright): log scale of spectralCentroid.
 *   rawY = log10(1 + centroidHz), musical bounds log10(100)..log10(10000)
 *   y    = (rawY - log10(100)) / (log10(10000) - log10(100)), clamped to [0,1]
 */

/** Identifies the mapping version for the 2D SampleMap position function. */
export const mapVersion = "map-v2";

/** Multi-window flatness configuration (STEP16P §4). */
const WINDOW = 2048;
const HOP = 1024;
const MAX_WINDOWS = 16;
/** Small epsilon so the log SNR is finite for perfectly tonal content. */
const FLAT_EPS = 1e-4;
/** Avoid log(0 magnitude) inside flatness per-window. */
const MAG_FLOOR = 1e-12;

/** Fixed X-axis anchors (STEP16P §7 / STEP16Q §2). */
const RAW_X_MIN = -2.0;
const RAW_X_MAX = 3.0;

/** Fixed Y-axis musical bounds (STEP16Q §3). */
const CENTROID_MIN_HZ = 100;
const CENTROID_MAX_HZ = 10000;

/** Clamp a value into the inclusive [0, 1] range. */
function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

/** Clamp a value into the inclusive [lo, hi] range (handles ±Infinity). */
function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  if (v <= lo) return lo;
  if (v >= hi) return hi;
  return v;
}

/** Safe log10 for non-negative inputs; floor at 0 so log10(0) = -Infinity-safe clamp. */
function log10Safe(v: number): number {
  return Math.log10(Math.max(v, 0));
}

/** A deterministic 2D position in map space, with both coordinates in [0, 1]. */
export interface MapPosition {
  x: number;
  y: number;
}

/**
 * The SOLE authoritative V2 position computation. Called once at analysis time
 * with `decodedAudio` present. Downstream consumers read the persisted result
 * via `SampleIndexRecord.mapPosition` and never call this with audio-free data.
 */
export function computePosition(
  features: AudioFeatures,
  audio: DecodedAudio,
): MapPosition {
  const flatOverall = wholeSampleFlatness(audio.mono);
  return {
    x: flatnessToX(flatOverall),
    y: centroidToY(features.spectralCentroid),
  };
}

/**
 * Pure flatness -> X mapping (tonal <-> noisy). Exported for precise unit
 * testing of the formula, anchors, clamping and determinism (STEP16Q §6).
 *
 *   snr  = (1 - f) / (f + 1e-4)
 *   rawX = log10(snr), clipped to [RAW_X_MIN, RAW_X_MAX]
 *   x    = (rawX - RAW_X_MIN) / (RAW_X_MAX - RAW_X_MIN), clamped to [0,1]
 */
export function flatnessToX(f: number): number {
  const snr = (1 - f) / (f + FLAT_EPS);
  const rawX = clamp(log10Safe(snr), RAW_X_MIN, RAW_X_MAX);
  const x = (rawX - RAW_X_MIN) / (RAW_X_MAX - RAW_X_MIN);
  return clamp01(x);
}

/**
 * Pure centroid -> Y mapping (dark <-> bright). Exported for precise unit
 * testing (STEP16Q §6).
 */
export function centroidToY(centroidHz: number): number {
  const rawY = log10Safe(1 + centroidHz);
  const lower = Math.log10(CENTROID_MIN_HZ);
  const upper = Math.log10(CENTROID_MAX_HZ);
  const y = (rawY - lower) / (upper - lower);
  return clamp01(y);
}

/**
 * Whole-sample flatness: median of per-window spectral flatness over up to
 * `MAX_WINDOWS` uniformly distributed Hann windows (window=2048, hop=1024).
 * Short samples (< one window) fall back to N=1. Deterministic; O(1) windows.
 */
export function wholeSampleFlatness(mono: Float32Array): number {
  const n = mono.length;
  const N = Math.min(MAX_WINDOWS, Math.max(1, Math.floor((n - WINDOW) / HOP)));
  const flats: number[] = [];
  for (let i = 0; i < N; i++) {
    const start = i * HOP;
    const len = Math.min(WINDOW, n - start);
    flats.push(windowFlatness(mono.subarray(start, start + len)));
  }
  return median(flats);
}

/** Spectral flatness of one Hann-windowed FFT over the given frames. */
function windowFlatness(samples: Float32Array): number {
  if (samples.length < 2) return 1;
  const fftN = nextPow2(samples.length);
  const mag = fftMag(samples, fftN);
  const bins = mag.length;
  // Geometric vs arithmetic mean over positive, DC-excluded bins (k = 1..bins-1).
  let logSum = 0;
  let magSum = 0;
  let count = 0;
  for (let k = 1; k < bins; k++) {
    const m = Math.max(mag[k], MAG_FLOOR);
    logSum += Math.log(m);
    magSum += m;
    count++;
  }
  if (count === 0 || magSum <= 0) return 1;
  const geoMean = Math.exp(logSum / count);
  const arithMean = magSum / count;
  return clamp01(geoMean / arithMean);
}

/** Magnitude spectrum of `samples` zero-padded to `n` (Hann window over real length). */
function fftMag(samples: Float32Array, n: number): Float32Array {
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const m = samples.length;
  for (let i = 0; i < m; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (m - 1 || 1)));
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

function median(sorted: number[]): number {
  if (sorted.length === 0) return 1;
  const s = [...sorted].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
