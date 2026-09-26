/**
 * V2 (STEP 21) analysis input contract.
 *
 * The V2 DSP extractor operates on DECODED PCM only (transient memory, never
 * persisted — the STEP 20 §40 no-audio-persistence invariant applies). The
 * input is per-channel Float32Array PCM so multi-track analysis is explicit;
 * `fromDecodedAudio` adapts the V1 `DecodedAudio` (channel-summed mono) into
 * this contract.
 *
 * Input validation policy (total function):
 *   - `sampleRate` must be a finite number > 0, else the input is malformed
 *     (a TypeError is thrown — the caller contract imposes it).
 *   - Every sample must be finite (NaN/Infinity are rejected with a TypeError;
 *     the upstream quality gate rejects them before this step).
 *   - `channels` must be a non-empty array of Float32Array. An empty channel is
 *     allowed and contributes silence (zero-padded to the longest channel).
 *   - Degenerate-but-determinable signals (e.g. a zero-length channel) are
 *     NOT thrown: they analyze to a safe all-null silence record.
 *
 * Downmix rule (energy-preserving): mono[w] = (1/C) * sum_c channels[c][w],
 * channels shorter than the longest are zero-padded. Equal channels average to
 * the same value (energy preserved); a silent channel contributes a plain 0.
 * The result is identical for identical inputs — determinism is exact.
 */
import type { DecodedAudio } from "./decodedAudio";

export interface AudioAnalysisInput {
  /** Sample rate in Hz (finite, > 0). */
  sampleRate: number;
  /**
   * One read-only Float32Array per channel. The extractor NEVER mutates them.
   * All channels share the same frame timeline; shorter channels are treated as
   * silent (zero-padded) up to the longest channel's length.
   */
  channels: readonly Float32Array[];
}

export interface AnalysisInputValidation {
  valid: boolean;
  errors: string[];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Structural validation of an analysis input. Returns errors instead of
 * throwing so tests can assert the exact contract; `analyzeAudio` throws a
 * TypeError with the joined errors for invalid inputs.
 */
export function validateAnalysisInput(input: unknown): AnalysisInputValidation {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null) {
    return { valid: false, errors: ["AudioAnalysisInput: not an object"] };
  }
  const i = input as Record<string, unknown>;
  if (!isFiniteNumber(i.sampleRate) || i.sampleRate <= 0) {
    errors.push("AudioAnalysisInput.sampleRate: finite number > 0");
  }
  if (
    !Array.isArray(i.channels) ||
    i.channels.length === 0 ||
    i.channels.some((c) => !(c instanceof Float32Array))
  ) {
    errors.push("AudioAnalysisInput.channels: non-empty array of Float32Array");
  } else {
    for (let ch = 0; ch < i.channels.length; ch++) {
      const c = i.channels[ch] as Float32Array;
      for (let s = 0; s < c.length; s++) {
        if (!Number.isFinite(c[s])) {
          errors.push(`AudioAnalysisInput.channels[${ch}]: non-finite sample`);
          break;
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Throw a TypeError describing every validation error (caller-contract fail). */
export function assertValidAnalysisInput(input: unknown): asserts input is AudioAnalysisInput {
  const validation = validateAnalysisInput(input);
  if (!validation.valid) throw new TypeError(validation.errors.join("; "));
}

/** Adapt the V1 `DecodedAudio` (mono channel-summed PCM) into the V2 contract. */
export function fromDecodedAudio(audio: DecodedAudio): AudioAnalysisInput {
  return { sampleRate: audio.sampleRate, channels: [audio.mono] };
}

/**
 * Energy-preserving downmix of the input channels into one Float32Array.
 * mono[w] = (1/C) * sum_c(channels[c][w]); shorter channels are zero-padded.
 * The input channels are never mutated.
 */
export function downmixChannels(
  channels: readonly Float32Array[],
): Float32Array {
  let longest = 0;
  for (const c of channels) longest = Math.max(longest, c.length);
  const mono = new Float32Array(longest);
  const count = channels.length;
  for (let w = 0; w < longest; w++) {
    let acc = 0;
    for (const c of channels) acc += w < c.length ? c[w] : 0;
    mono[w] = acc / count;
  }
  return mono;
}