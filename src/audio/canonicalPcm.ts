import type { DecodedAudio } from "./decodedAudio";

/**
 * Canonical PCM (Step 15H §12–§14).
 *
 * The content hash must be computable from the DECODED PCM and be identical for
 * the same audio regardless of container, environment, or browser resampling.
 * Browser `decodeAudioData` resamples to the AudioContext rate (verified live:
 * a 44100 Hz FLAC decoded at 96000 Hz in Chrome), so the *decoded* rate is NOT
 * a stable quantity. Canonical PCM therefore re-encodes the decoded audio into
 * one versioned, fully-specified representation:
 *
 *   sampleRate  : 48000 Hz
 *   layout      : mono (channel-summed — matches DecodedAudio.mono contract)
 *   format      : signed 16-bit integer samples (interleaved frame order)
 *   endianness  : little-endian (when serialized for hashing)
 *   resampler   : deterministic linear interpolation (IEEE-754 double math —
 *                 identical on every JS engine; NO AudioContext involved)
 *   NaN/Infinity: rejected by the technical quality gate BEFORE this step
 *
 * 48000 Hz is a *deliberate, explicit choice*. It is not an artifact of any
 * web/browser default and not an implicit "44.1k assumption" — the decoded
 * rate is read from `DecodedAudio.sampleRate` and any rate in the gate bounds
 * (8–192 kHz) is resampled against the SAME canonical target. The choice is
 * versioned via CANONICAL_PCM_VERSION; any future change to the target rate,
 * layout, format, endianness or resampler MUST bump that version (Step 15H §15).
 */

export const CANONICAL_PCM_VERSION = "pcm-v1";

export const CANONICAL_PCM = {
  /** Canonical sample rate in Hz. */
  sampleRate: 48000,
  /** Mono (single channel, channel-summed). */
  channels: 1,
  /** Signed 16-bit integer PCM. */
  bitsPerSample: 16,
  /** Little-endian byte order when serialized. */
  endianness: "little",
  /** Interleaved frame order. */
  frameOrder: "interleaved",
  /** NaN/Infinity PCM is rejected by the gate, never canonicalized. */
  nanHandling: "reject-in-gate",
  /** Deterministic linear-interpolation resampler (pure IEEE-754 double). */
  resampler: "deterministic-linear",
} as const;

export interface CanonicalPcm {
  version: typeof CANONICAL_PCM_VERSION;
  sampleRate: number;
  frames: number;
  /** Interleaved signed 16-bit samples (little-endian when serialized). */
  samples: Int16Array;
  /** Rate the audio was decoded at (before canonical resampling). */
  sourceRate: number;
  /** True when the source rate differed from the canonical rate. */
  resampled: boolean;
}

/**
 * Deterministically canonicalize decoded PCM.
 * Pure IEEE-754 double arithmetic + Math.round — identical output on every
 * JS engine, i.e. the content hash is portable across node/browser/Chrome/etc.
 */
export function canonicalizePcm(audio: DecodedAudio): CanonicalPcm {
  const source = audio.mono;
  const sourceRate = audio.sampleRate;
  const targetRate = CANONICAL_PCM.sampleRate;
  const frames = Math.round((source.length * targetRate) / sourceRate);
  const out = new Int16Array(frames);
  if (frames > 0) {
    if (sourceRate === targetRate) {
      for (let i = 0; i < frames; i++) out[i] = toS16(source[i]);
    } else {
      const ratio = targetRate / sourceRate;
      for (let i = 0; i < frames; i++) {
        const pos = i / ratio;
        const idx = Math.floor(pos);
        const a = source[idx];
        const b = source[idx + 1] ?? a;
        out[i] = toS16(a + (b - a) * (pos - idx));
      }
    }
  }
  return {
    version: CANONICAL_PCM_VERSION,
    sampleRate: targetRate,
    frames,
    samples: out,
    sourceRate,
    resampled: sourceRate !== targetRate,
  };
}

function toS16(v: number): number {
  const c = Math.min(1, Math.max(-1, v));
  return Math.round(c * 32767);
}