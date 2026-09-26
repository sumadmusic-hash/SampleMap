/**
 * V2 (STEP 21) DETERMINISTIC CALIBRATION CORPUS (FIXTURE-class evidence).
 *
 * Rendered PCM signals for DSP tests and SoundCharacter calibration. Every
 * signal is synthesized ONLY from its name + sample rate (seeded PRNG for noise,
 * closed-form math otherwise) — identical bytes on every run and engine.
 *
 * IMPORTANT (STEP21 §15 evidence rule): these are FIXTURES / CONSTRUCTED signals,
 * NOT real-world recorded audio. Any measured value derived from them is
 * FIXTURE-class evidence and must never be described as "REAL audio evidence".
 *
 * Signal set (name, intent):
 *   silence             top-of-list safe-state: zero energy
 *   pureTone440         steady tonal reference (brightness/tonality anchor)
 *   lowSine110          low frequency tone (low brightness)
 *   highSine2000        high frequency tone (high brightness, still pitchable)
 *   whiteNoise          noise-flat reference (noisiness anchor)
 *   pinkNoise           1/f-ish noise (negative spectral slope reference)
 *   impulse             single full-scale sample at t=0 (max transient)
 *   shortClick          fast-decay 1 kHz pulse
 *   sustainedTone       long steady tone (sustained => decay null)
 *   swellTone           slow-attack tone (long attack reference)
 *   decayingTone90      kick-like decaying low tone
 *   percussiveNoiseHit  snare-like decaying noise burst
 *   lowThump            low-frequency slow transient
 *   highThump           high-frequency fast transient
 *   detunedHarmonic     220 Hz + 3.1x partial (small inharmonicity)
 *   bellLike            sparse inharmonic partials 440/1100/1650 (large inharmonicity)
 */
import type { AudioFeaturesV2 } from "../analysis/audioFeaturesV2";
import { analyzeAudio } from "./v2Dsp";

/** Deterministic 32-bit PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sine(durationSec: number, freq: number, amp: number, sampleRate: number): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return x;
}

function decayedSine(
  durationSec: number,
  freq: number,
  amp: number,
  tauSec: number,
  sampleRate: number,
): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate) * Math.exp(-t / tauSec);
  }
  return x;
}

/** Linear onset ramp of `rampSec` from t=0 to full amplitude. */
function applyRamp(x: Float32Array, sampleRate: number, rampSec: number): void {
  const rampLen = Math.max(1, Math.round(rampSec * sampleRate));
  for (let i = 0; i < x.length && i < rampLen; i++) x[i] *= i / rampLen;
}

function expDecay(x: Float32Array, sampleRate: number, tauSec: number): void {
  for (let i = 0; i < x.length; i++) x[i] *= Math.exp(-(i / sampleRate) / tauSec);
}

function whiteNoise(seed: number, durationSec: number, sampleRate: number): Float32Array {
  const rng = mulberry32(seed);
  const n = Math.round(durationSec * sampleRate);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (rng() * 2 - 1) * 0.5;
  return x;
}

/** Voss-McCartney pink noise (8 octaves, deterministic). */
function pinkNoise(seed: number, durationSec: number, sampleRate: number): Float32Array {
  const octaves = 8;
  const rows = new Float32Array(octaves);
  const rng = mulberry32(seed ^ 0x5bd1e995);
  for (let o = 0; o < octaves; o++) rows[o] = mulberry32(seed + o)() * 2 - 1;
  const n = Math.round(durationSec * sampleRate);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const white = rng() * 2 - 1;
    for (let o = 0; o < octaves; o++) {
      const bit = (i >> o) & 1;
      if (bit === 1 && ((i - 1) >> o) % 2 === 0) rows[o] = white;
    }
    let pink = 0;
    for (let o = 0; o < octaves; o++) pink += rows[o];
    x[i] = (pink / octaves) * 1.6;
  }
  return x;
}

function impulse(durationSec: number, sampleRate: number): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const x = new Float32Array(n);
  if (n > 0) {
    // Place the delta inside the buffer (Hann loses an impulse exactly at t=0).
    const at = Math.round(0.3 * n);
    if (at < n) x[at] = 1;
  }
  return x;
}

function multiPartial(
  partials: ReadonlyArray<{ freq: number; amp: number }>,
  durationSec: number,
  sampleRate: number,
): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (const p of partials) acc += p.amp * Math.sin((2 * Math.PI * p.freq * i) / sampleRate);
    x[i] = acc;
  }
  return x;
}

type CorpusGenerator = (sampleRate: number) => Float32Array;

export const V2_CORPUS_GENERATORS: Record<string, CorpusGenerator> = {
  silence: (sr) => new Float32Array(Math.round(0.2 * sr)),
  pureTone440: (sr) => {
    const x = sine(0.6, 440, 0.5, sr);
    applyRamp(x, sr, 0.005);
    return x;
  },
  lowSine110: (sr) => {
    const x = sine(0.6, 110, 0.5, sr);
    applyRamp(x, sr, 0.005);
    return x;
  },
  highSine2000: (sr) => {
    const x = sine(0.4, 2000, 0.5, sr);
    applyRamp(x, sr, 0.005);
    return x;
  },
  whiteNoise: (sr) => whiteNoise(0x21, 0.5, sr),
  pinkNoise: (sr) => pinkNoise(0x12, 0.5, sr),
  impulse: (sr) => impulse(0.05, sr),
  shortClick: (sr) => decayedSine(0.1, 1000, 0.8, 0.004, sr),
  sustainedTone: (sr) => {
    const x = sine(2.0, 330, 0.5, sr);
    applyRamp(x, sr, 0.005);
    return x;
  },
  swellTone: (sr) => {
    const x = sine(1.0, 440, 0.5, sr);
    applyRamp(x, sr, 0.2);
    return x;
  },
  decayingTone90: (sr) => decayedSine(0.25, 90, 0.8, 0.045, sr),
  percussiveNoiseHit: (sr) => {
    const x = whiteNoise(0x33, 0.15, sr);
    expDecay(x, sr, 0.02);
    return x;
  },
  lowThump: (sr) => decayedSine(0.4, 45, 0.9, 0.1, sr),
  highThump: (sr) => decayedSine(0.15, 3500, 0.7, 0.01, sr),
  detunedHarmonic: (sr) =>
    multiPartial(
      [
        { freq: 220, amp: 0.5 },
        { freq: 660, amp: 0.25 },
      ],
      0.6,
      sr,
    ),
  bellLike: (sr) =>
    multiPartial(
      [
        { freq: 440, amp: 0.5 },
        { freq: 1200, amp: 0.3 },
        { freq: 1900, amp: 0.2 },
      ],
      0.8,
      sr,
    ),
};

export function renderCorpus(name: string, sampleRate: number): Float32Array {
  const generator = V2_CORPUS_GENERATORS[name];
  if (!generator) throw new Error(`unknown corpus signal: ${name}`);
  return generator(sampleRate);
}

/** Convenience: analyze a corpus signal at a rate into a valid feature record. */
export function analyzeCorpus(name: string, sampleRate: number): AudioFeaturesV2 {
  return analyzeAudio({ sampleRate, channels: [renderCorpus(name, sampleRate)] });
}

/** Stable corpus order used by tests (matches the report's calibration table). */
export const V2_CORPUS_NAMES: readonly string[] = [
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
];

/** Sample rates used by the sample-rate-independence tests. */
export const V2_SAMPLE_RATES = [22050, 44100, 48000, 96000] as const;