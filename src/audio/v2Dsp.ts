/**
 * V2 (STEP 21) deterministic DSP feature extractor.
 *
 * Pure DSP over decoded PCM (Float32, in transient memory — never persisted).
 * `analyzeAudio(input)` returns the canonical `AudioFeaturesV2` record; the
 * result always passes `validateAudioFeaturesV2` (NaN/Infinity are impossible,
 * absent quantities are `null`, never `0`).
 *
 * DSP architecture (all formulas documented; frequencies physical in Hz, times
 * in seconds — nothing is hardcoded to 44.1k):
 *
 *   framing      FFT window 2048, hop 512 (Hann). Frames cover the whole
 *                signal; the final frame is zero-padded.
 *   spectral     per energy-bearing frame: centroid, spread, rolloff (0.85),
 *                flatness (geometric/arithmetic mean over bins k>=1), slope
 *                (OLS of log10(magnitude) vs log10(frequency)); aggregated with
 *                magnitude-weighted means. Flux is the mean per-pair L1
 *                distance between consecutive energy frames' UNIT-normalized
 *                magnitude spectra (scale-invariant, bounded [0, 2]).
 *   temporal     global rms/peak, crestFactor = peak/rms (null when rms <= 0),
 *                zero-crossing rate crossings/(n-1), RMS envelope (512-sample
 *                hop) -> transientStrength, attackTimeSec, decayTimeSec.
 *   pitch        YIN/CMNDF per up-to-96 evenly sampled frames: the difference
 *                is pair-count normalized (else it collapses toward 0 near the
 *                frame edge, fabricating fake dips) and lags are confined so at
 *                least floor(fftSize/4) sample pairs overlap (prediction of a
 *                low-frequency period needs enough overlap); first dip below
 *                `pitchCmnfThreshold`, refined to its local minimum + parabolic
 *                interpolation; median of accepted frames; confidence = 1 -
 *                cmndf(best).
 *   harmonicity  mean best-lag normalized autocorrelation over the same frames
 *                (demeaned): pure tone ~1, white noise ~0.
 *   inharmonicity measured on the strongest frame's magnitude spectrum: RMS
 *                fractional deviation of the top partials from the nearest
 *                integer multiple of the estimated pitch; `null` when no pitch
 *                or fewer than two partials are measurable.
 */
import {
  V2_DSP_CONFIG,
  makeHannWindow,
} from "./v2Config";
import {
  assertValidAnalysisInput,
  downmixChannels,
  type AudioAnalysisInput,
} from "./v2Input";
import type { AudioFeaturesV2 } from "../analysis/audioFeaturesV2";
import { validateAudioFeaturesV2 } from "../analysis/audioFeaturesV2";

/** Start offsets of hop-aligned frames covering `n` samples. */
function frameOffsets(n: number, hop: number): number[] {
  const offsets: number[] = [];
  for (let off = 0; off < n; off += hop) offsets.push(off);
  return offsets;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Iterative radix-2 Cooley-Tukey FFT in place (adapted from the V1 extractor). */
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

interface SpectralStats {
  centroidHz: number | null;
  spreadHz: number | null;
  rolloffHz: number | null;
  flatness: number | null;
  flux: number | null;
  slope: number | null;
  /** Magnitude spectrum of the highest-energy frame (for inharmonicity). */
  strongestMag: Float32Array | null;
}

/**
 * Aggregated spectral features across all energy-bearing frames.
 * Per-frame quantities are combined with magnitude-weighted means; flux is the
 * unweighted mean over consecutive energy-vs-energy frame pairs.
 */
function computeSpectralAgg(
  mono: Float32Array,
  sampleRate: number,
  fftSize: number,
  offsets: number[],
): SpectralStats {
  const window = makeHannWindow(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const bins = fftSize / 2 + 1;
  const freq = (k: number) => (k * sampleRate) / fftSize;
  const eps = V2_DSP_CONFIG.spectralEpsilon;

  let totalMagSum = 0;
  let centroidNum = 0;
  let spreadNum = 0;
  let rolloffNum = 0;
  let flatnessNum = 0;
  let slopeNum = 0;
  let fluxAcc = 0;
  let fluxPairs = 0;
  let strongestMag: Float32Array | null = null;
  let strongestTotal = 0;

  const prevNorm = new Float64Array(bins);
  const curNorm = new Float64Array(bins);
  let havePrev = false;

  for (const off of offsets) {
    for (let i = 0; i < fftSize; i++) {
      const s = off + i;
      re[i] = s < mono.length ? mono[s] * window[i] : 0;
      im[i] = 0;
    }
    fftInPlace(re, im);
    let total = 0;
    for (let k = 0; k < bins; k++) total += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    if (total <= 0) continue;

    // Centroid / spread.
    let centroid = 0;
    for (let k = 0; k < bins; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      centroid += freq(k) * mag;
    }
    centroid /= total;
    let spread = 0;
    for (let k = 0; k < bins; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      spread += mag * (freq(k) - centroid) ** 2;
    }
    spread = Math.sqrt(spread / total);

    // Rolloff frequency.
    const rolloffEnergy = total * V2_DSP_CONFIG.rolloffFraction;
    let acc = 0;
    let rolloff = freq(bins - 1);
    for (let k = 0; k < bins; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      acc += mag;
      if (acc >= rolloffEnergy) {
        rolloff = freq(k);
        break;
      }
    }

    // Flatness (geometric / arithmetic mean over bins k >= 1).
    let logSum = 0;
    let magSum = 0;
    for (let k = 1; k < bins; k++) {
      const mag = Math.max(Math.sqrt(re[k] * re[k] + im[k] * im[k]), eps);
      logSum += Math.log(mag);
      magSum += mag;
    }
    const flatness = magSum > 0 ? clamp01(Math.exp(logSum / (bins - 1)) / (magSum / (bins - 1))) : 0;

    // Slope: OLS of log10(mag) vs log10(freq) over bins k >= 1.
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    const count = bins - 1;
    for (let k = 1; k < bins; k++) {
      const x = Math.log10(freq(k));
      const y = Math.log10(Math.max(Math.sqrt(re[k] * re[k] + im[k] * im[k]), eps));
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
    const denom = count * sxx - sx * sx;
    const slope = denom > 0 ? (count * sxy - sx * sy) / denom : 0;

    // Aggregate (magnitude-weighted).
    totalMagSum += total;
    centroidNum += total * centroid;
    spreadNum += total * spread;
    rolloffNum += total * rolloff;
    flatnessNum += total * flatness;
    slopeNum += total * slope;

    // Track the highest-energy frame's spectrum for inharmonicity peaks.
    if (total > strongestTotal) {
      const magBuf = new Float32Array(bins);
      for (let k = 0; k < bins; k++) magBuf[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      strongestMag = magBuf;
      strongestTotal = total;
    }

    // Spectral flux: L1 between unit-normalized spectra of consecutive energy frames.
    for (let k = 0; k < bins; k++) curNorm[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / total;
    if (havePrev) {
      let d = 0;
      for (let k = 0; k < bins; k++) d += Math.abs(curNorm[k] - prevNorm[k]);
      fluxAcc += d;
      fluxPairs++;
    }
    const tmp = prevNorm;
    prevNorm.set(curNorm);
    havePrev = true;
    curNorm.set(tmp);
  }

  return {
    centroidHz: totalMagSum > 0 ? centroidNum / totalMagSum : null,
    spreadHz: totalMagSum > 0 ? spreadNum / totalMagSum : null,
    rolloffHz: totalMagSum > 0 ? rolloffNum / totalMagSum : null,
    flatness: totalMagSum > 0 ? flatnessNum / totalMagSum : null,
    flux: fluxPairs > 0 ? fluxAcc / fluxPairs : null,
    slope: totalMagSum > 0 ? slopeNum / totalMagSum : null,
    strongestMag,
  };
}

interface TemporalStats {
  rms: number;
  peak: number;
  crestFactor: number | null;
  zeroCrossingRate: number;
  transientStrength: number | null;
  attackTimeSec: number | null;
  decayTimeSec: number | null;
}

/**
 * Temporal / dynamics features. The envelope is the RMS of 512-sample,
 * hop-512 (contiguous) windows.
 */
function computeTemporal(
  mono: Float32Array,
  sampleRate: number,
  n: number,
  hop: number,
  offsets: number[],
): TemporalStats {
  const window = hop;
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(mono[i]);
    if (a > peak) peak = a;
    sumSq += mono[i] * mono[i];
  }
  const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
  const rawCrest = rms > 0 && peak > 0 ? peak / rms : null;
  const crestFactor = rawCrest === null ? null : rawCrest >= 1 ? rawCrest : 1;

  let zeroCrossingRate = 0;
  if (n >= 2) {
    let crossings = 0;
    for (let i = 1; i < n; i++) {
      if ((mono[i - 1] < 0 && mono[i] >= 0) || (mono[i - 1] >= 0 && mono[i] < 0)) crossings++;
    }
    zeroCrossingRate = crossings / (n - 1);
  }

  // RMS envelope.
  const numWindows = offsets.length;
  const env = new Float64Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    const off = offsets[w];
    let acc = 0;
    let cnt = 0;
    for (let i = off; i < Math.min(off + window, n); i++) {
      acc += mono[i] * mono[i];
      cnt++;
    }
    env[w] = cnt > 0 ? Math.sqrt(acc / cnt) : 0;
  }

  // transientStrength: normalized positive envelope slew (dimensionless).
  // The sequence is treated as starting from a silent 0-level, so an onset in
  // the first window counts as a positive rise (impulsive hits are captured).
  let transientStrength: number | null = null;
  if (numWindows > 1) {
    let envAvg = 0;
    for (let w = 0; w < numWindows; w++) envAvg += env[w];
    envAvg /= numWindows;
    let posDelta = 0;
    let prev = 0;
    for (let w = 0; w < numWindows; w++) {
      const d = env[w] - prev;
      if (d > 0) posDelta += d;
      prev = env[w];
    }
    if (envAvg > V2_DSP_CONFIG.energyFloor) {
      transientStrength = (V2_DSP_CONFIG.transientScale * posDelta) / (envAvg * numWindows);
    }
  }

  // Attack / decay from the envelope peak.
  let peakIdx = -1;
  let peakEnv = 0;
  for (let w = 0; w < numWindows; w++) {
    if (env[w] > peakEnv) {
      peakEnv = env[w];
      peakIdx = w;
    }
  }

  let attackTimeSec: number | null = null;
  let decayTimeSec: number | null = null;
  if (peakEnv > V2_DSP_CONFIG.energyFloor && peakIdx >= 0) {
    const attackTarget = V2_DSP_CONFIG.attackFraction * peakEnv;
    for (let w = 0; w <= peakIdx; w++) {
      if (env[w] >= attackTarget) {
        attackTimeSec = Math.max(0, (w * hop) / sampleRate);
        break;
      }
    }
    const decayTarget = V2_DSP_CONFIG.decayFraction * peakEnv;
    for (let w = peakIdx + 1; w < numWindows; w++) {
      if (env[w] < decayTarget) {
        decayTimeSec = Math.max(0, ((w - peakIdx) * hop) / sampleRate);
        break;
      }
    }
  }

  return {
    rms,
    peak,
    crestFactor,
    zeroCrossingRate,
    transientStrength,
    attackTimeSec,
    decayTimeSec,
  };
}

interface PitchHarmonicity {
  pitchHz: number | null;
  pitchConfidence: number | null;
  harmonicity: number | null;
}

/**
 * YIN/CMNDF pitch + normalized-autocorrelation harmonicity, computed on an
 * evenly sampled subset (<= pitchMaxFrames) of the hop-512 frames. Each frame
 * is demeaned (DC removed) before both analyses.
 */
function computePitchHarmonicity(
  mono: Float32Array,
  sampleRate: number,
  offsets: number[],
): PitchHarmonicity {
  const N = V2_DSP_CONFIG.fftSize;
  const cap = V2_DSP_CONFIG.pitchMaxFrames;

  const selected: number[] = [];
  if (offsets.length <= cap) {
    for (let i = 0; i < offsets.length; i++) selected.push(i);
  } else {
    for (let i = 0; i < cap; i++) {
      selected.push(Math.round((i * (offsets.length - 1)) / (cap - 1)));
    }
  }

  // Pitch lags are confined to at least floor(fftSize/4) overlapping pairs:
  // for lags close to the frame length only a handful of pairs remain, so the
  // CMNDF is dominated by sampling noise and fabricates deep fake dips (seen
  // as a spurious ~47 Hz pitch on 96 kHz white noise at the 2048-sample edge).
  const pairsFloor = Math.floor(N / 4);
  const tauMaxGlobal = Math.min(N - 1 - pairsFloor, Math.floor(sampleRate / V2_DSP_CONFIG.pitchMinHz));
  const tauMinGlobal = Math.max(1, Math.floor(sampleRate / V2_DSP_CONFIG.pitchMaxHz));

  const x = new Float64Array(N);
  const c = new Float64Array(N);
  const preSq = new Float64Array(N + 1);
  const d = new Float64Array(N);
  const cm = new Float64Array(N);

  const acceptedPitch: number[] = [];
  const acceptedConf: number[] = [];
  let acorrAcc = 0;
  let acorrN = 0;

  for (const idx of selected) {
    const off = offsets[idx];

    let sum = 0;
    let sq = 0;
    let m = 0;
    for (let i = 0; i < N; i++) {
      const v = off + i < mono.length ? mono[off + i] : 0;
      x[i] = v;
      if (off + i < mono.length) {
        sum += v;
        sq += v * v;
        m++;
      }
    }
    if (sq <= V2_DSP_CONFIG.energyFloor * N) continue;
    const mean = m > 0 ? sum / m : 0;
    for (let i = 0; i < m; i++) x[i] -= mean;

    preSq[0] = 0;
    for (let i = 0; i < N; i++) preSq[i + 1] = preSq[i] + x[i] * x[i];

    const tauMin = Math.max(tauMinGlobal, 1);
    const tauMax = Math.min(tauMaxGlobal, N - 1);
    if (tauMin > tauMax) continue;

    for (let tau = 1; tau <= tauMax; tau++) c[tau] = 0;
    for (let n0 = 0; n0 < N; n0++) {
      const tMax = Math.min(tauMax, N - 1 - n0);
      const xn = x[n0];
      for (let tau = 1; tau <= tMax; tau++) {
        c[tau] += xn * x[n0 + tau];
      }
    }

    let cum = 0;
    cm[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      const pairs = N - tau;
      const p0 = preSq[N - tau];
      const p1 = preSq[N] - preSq[tau];
      // Normalize by the number of summed pairs: without this, d(tau) shrinks
      // as (N - tau), so the CMNDF artificially collapses toward 0 as tau -> N,
      // fabricating spurious deep dips (seen as fake ~47 Hz pitch on 96 kHz
      // white noise at tau near the 2048-sample frame edge).
      d[tau] = (p0 + p1 - 2 * c[tau]) / pairs;
      cum += d[tau];
      cm[tau] = cum > 0 ? (tau * d[tau]) / cum : 0;
    }

    // YIN standard candidate selection: the FIRST lag whose normalized
    // difference dips below the threshold (this avoids the CMNDF's deeper
    // harmonic-multiple minima, which would pull a pure tone onto a
    // sub-octave), refined to the local minimum around it.
    let cand = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cm[tau] < V2_DSP_CONFIG.pitchCmnfThreshold) {
        cand = tau;
        break;
      }
    }
    let best = -1;
    let bestCm = Infinity;
    if (cand >= 0) {
      const radius = Math.max(1, Math.round(0.2 * cand));
      const lo = Math.max(tauMin, cand - radius);
      const hi = Math.min(tauMax, cand + radius);
      for (let tau = lo; tau <= hi; tau++) {
        if (cm[tau] < bestCm) {
          bestCm = cm[tau];
          best = tau;
        }
      }
    } else {
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (cm[tau] < bestCm) {
          bestCm = cm[tau];
          best = tau;
        }
      }
    }
    const accepted = best > 0 && bestCm < V2_DSP_CONFIG.pitchCmnfThreshold;
    if (accepted) {
      // Parabolic interpolation for sub-sample period precision.
      const lo = best - 1 >= 1 ? cm[best - 1] : cm[best];
      const hi = best + 1 <= tauMax ? cm[best + 1] : cm[best];
      const deltaDenom = lo - 2 * bestCm + hi;
      const delta = Math.abs(deltaDenom) > 1e-12 ? (0.5 * (lo - hi)) / deltaDenom : 0;
      const tauF = best + Math.max(-1, Math.min(1, delta));
      acceptedPitch.push(sampleRate / tauF);
      acceptedConf.push(clamp01(1 - bestCm));
    }

    // Harmonicity: best-lag normalized autocorrelation. Confine the search to
    // half the frame: near tau = N-1 only a single sample pair contributes, so
    // |c|/sqrt(p0*p1) is trivially 1 for any signal.
    const acfMax = Math.min(tauMax, Math.floor(N / 2));
    let bestLag = 0;
    for (let tau = tauMin; tau <= acfMax; tau++) {
      const p0 = preSq[N - tau];
      const p1 = preSq[N] - preSq[tau];
      const denom = Math.sqrt(p0 * p1);
      if (denom > 0) {
        const rr = Math.abs(c[tau]) / denom;
        if (rr > bestLag) bestLag = Math.min(1, rr);
      }
    }
    acorrAcc += bestLag;
    acorrN++;
  }

  return {
    pitchHz: acceptedPitch.length > 0 ? median(acceptedPitch) : null,
    pitchConfidence: acceptedConf.length > 0 ? median(acceptedConf) : null,
    harmonicity: acorrN > 0 ? clamp01(acorrAcc / acorrN) : null,
  };
}

/**
 * Inharmonicity: RMS fractional deviation of the significant spectral partials
 * from the nearest integer multiple of the estimated pitch. `null` when the
 * pitch is not determinable or fewer than two partials are measurable (a lone
 * partial cannot express a harmonic-ladder deviation).
 */
function computeInharmonicity(
  pitchHz: number | null,
  strongestMag: Float32Array | null,
  sampleRate: number,
  fftSize: number,
): number | null {
  if (pitchHz === null || strongestMag === null) return null;
  const bins = strongestMag.length;
  let maxMag = 0;
  for (let k = 0; k < bins; k++) {
    if (strongestMag[k] > maxMag) maxMag = strongestMag[k];
  }
  if (maxMag <= 0) return null;

  const floor = V2_DSP_CONFIG.partialMinRelativeMagnitude * maxMag;
  const peaks: Array<{ f: number; w: number }> = [];
  for (let k = 2; k < bins - 2; k++) {
    const m = strongestMag[k];
    if (m >= strongestMag[k - 1] && m >= strongestMag[k + 1] && m >= floor) {
      const fp = (k * sampleRate) / fftSize;
      if (fp >= pitchHz * 0.5) peaks.push({ f: fp, w: m });
    }
  }
  peaks.sort((a, b) => b.w - a.w);
  const top = peaks.slice(0, 8);
  if (top.length < 2) return null;

  let devAcc = 0;
  let wSum = 0;
  for (const p of top) {
    const hMax = Math.min(32, Math.max(1, Math.floor((p.f * 2) / pitchHz)));
    let bestDev = Infinity;
    for (let h = 1; h <= hMax; h++) {
      const grid = h * pitchHz;
      bestDev = Math.min(bestDev, Math.abs(p.f - grid) / grid);
    }
    devAcc += p.w * bestDev * bestDev;
    wSum += p.w;
  }
  return clamp01(Math.sqrt(devAcc / wSum));
}

/**
 * The V2 deterministic DSP extractor. Analyses decoded PCM and returns the
 * canonical `AudioFeaturesV2` record (always structurally valid).
 */
export function analyzeAudio(input: AudioAnalysisInput): AudioFeaturesV2 {
  assertValidAnalysisInput(input);
  const sampleRate = input.sampleRate;
  const channels = input.channels.length;
  const mono = downmixChannels(input.channels);
  const n = mono.length;
  const durationSec = n / sampleRate;

  const { fftSize, hopSize } = V2_DSP_CONFIG;
  const offsets = frameOffsets(n, hopSize);

  const spectral = computeSpectralAgg(mono, sampleRate, fftSize, offsets);
  const temporal = computeTemporal(mono, sampleRate, n, hopSize, offsets);
  const pitch = computePitchHarmonicity(mono, sampleRate, offsets);
  const inharmonicity = computeInharmonicity(pitch.pitchHz, spectral.strongestMag, sampleRate, fftSize);

  const features: AudioFeaturesV2 = {
    durationSec,
    sampleRate,
    channels,
    rms: temporal.rms,
    peak: temporal.peak,
    crestFactor: temporal.crestFactor,
    transientStrength: temporal.transientStrength,
    zeroCrossingRate: temporal.zeroCrossingRate,
    spectralCentroidHz: spectral.centroidHz,
    spectralSpreadHz: spectral.spreadHz,
    spectralRolloffHz: spectral.rolloffHz,
    spectralFlatness: spectral.flatness,
    spectralFlux: spectral.flux,
    spectralSlope: spectral.slope,
    attackTimeSec: temporal.attackTimeSec,
    decayTimeSec: temporal.decayTimeSec,
    pitchHz: pitch.pitchHz,
    pitchConfidence: pitch.pitchConfidence,
    harmonicity: pitch.harmonicity,
    inharmonicity,
  };

  const validation = validateAudioFeaturesV2(features);
  if (!validation.valid) {
    throw new Error(`analyzeAudio produced invalid features: ${validation.errors.join("; ")}`);
  }
  return features;
}