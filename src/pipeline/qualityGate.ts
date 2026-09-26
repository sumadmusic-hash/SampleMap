import type { DecodedAudio } from "../audio/decodedAudio";
import type { AnalysisSourceFormat } from "../audio/sourceFormat";

/**
 * Technical Quality Gate (Step 15H §6–§9).
 *
 * This is a *technical admission gate*: it answers "may this audio technically
 * be analyzed by SampleMap?". It does NOT judge musical quality, taste, genre,
 * punch, loudness, noise, distortion or lo-fi character — an intentionally
 * distorted or very noisy sample can be perfectly valid technically.
 *
 * The gate is deliberately conservative for V1 (Step 15H §7):
 *  - NO_LOSSLESS_SOURCE   : sample has neither wavUrl nor flacUrl (no MP3
 *                           fallback — §4)
 *  - INVALID_WAV_CONTAINER: WAV structure is broken / missing fmt or data
 *  - NOT_PCM_WAV          : WAV exists but the payload is not PCM (e.g. ADPCM).
 *                           Decision is based on the actual file header, never
 *                           on the URL/name (§8)
 *  - INVALID_FLAC_CONTAINER: FLAC magic / STREAMINFO invalid (§9)
 *  - INVALID_PCM           : decoded audio invalid (zero frames, bad sample
 *                           rate / channel count, non-finite PCM, §7)
 *  - DECODE_FAILED         : the audio could not be decoded at all (e.g. FLAC
 *                           unsupported by the runtime) — a hard admission
 *                           rejection, never a fallback to MP3
 *
 * Bound values below are *technical sanity bounds* for the gate, not quality
 * thresholds and not "sounds good" claims (§25). They are exported and are
 * part of the gate rules (versioned via analysisBuild).
 */

export const MIN_VALID_SAMPLE_RATE = 8000;
export const MAX_VALID_SAMPLE_RATE = 192000;
export const MAX_VALID_CHANNELS = 32;
/**
 * Minimum decoded mono frame count accepted for analysis. A decoded buffer of
 * 0 frames is already rejected below; frame counts of 1 are rejected too,
 * because the spectral extractor's windowed FFT needs at least 2 frames to
 * produce a defined result (a 1-frame buffer previously crashed the pure
 * extractor instead of yielding a deterministic gate outcome).
 */
export const MIN_VALID_FRAMES = 2;
export const WAV_PCM_BITS: ReadonlySet<number> = new Set([8, 16, 24, 32]);

export const GATE_REJECT = {
  NO_LOSSLESS_SOURCE: "NO_LOSSLESS_SOURCE",
  INVALID_WAV_CONTAINER: "INVALID_WAV_CONTAINER",
  NOT_PCM_WAV: "NOT_PCM_WAV",
  INVALID_FLAC_CONTAINER: "INVALID_FLAC_CONTAINER",
  INVALID_PCM: "INVALID_PCM",
  DECODE_FAILED: "DECODE_FAILED",
} as const;
export type GateRejectReason = (typeof GATE_REJECT)[keyof typeof GATE_REJECT];

export type AcceptedGate = { accepted: true };
export type RejectedGate = { accepted: false; reason: GateRejectReason; detail: string };
export type QualityGateResult = AcceptedGate | RejectedGate;

export function accept(): AcceptedGate {
  return { accepted: true };
}

export function reject(reason: GateRejectReason, detail = ""): RejectedGate {
  return { accepted: false, reason, detail };
}

/** Validate the actual downloaded container bytes (WAV/FLAC) — Step 15H §8–§9. */
export function validateAudioContainer(
  format: AnalysisSourceFormat,
  bytes: ArrayBuffer,
): QualityGateResult {
  if (format === "wav") return validateWav(bytes);
  return validateFlac(bytes);
}

function validateWav(bytes: ArrayBuffer): QualityGateResult {
  const buf = new Uint8Array(bytes);
  if (buf.byteLength < 44) {
    return reject(GATE_REJECT.INVALID_WAV_CONTAINER, "file too small for RIFF header");
  }
  if (ascii(buf, 0, 4) !== "RIFF" || ascii(buf, 8, 4) !== "WAVE") {
    return reject(GATE_REJECT.INVALID_WAV_CONTAINER, "missing RIFF/WAVE magic");
  }

  const dv = new DataView(bytes);
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  let dataSize = 0;

  while (off + 8 <= buf.byteLength) {
    const id = ascii(buf, off, 4);
    const size = dv.getUint32(off + 4, true);
    if (id === "fmt ") {
      if (size < 16 || off + 8 + size > buf.byteLength) {
        return reject(GATE_REJECT.INVALID_WAV_CONTAINER, "truncated fmt chunk");
      }
      fmt = {
        format: dv.getUint16(off + 8, true),
        channels: dv.getUint16(off + 10, true),
        sampleRate: dv.getUint32(off + 12, true),
        bits: dv.getUint16(off + 22, true),
      };
      if (!validPcm(fmt.format, fmt.channels, fmt.sampleRate, fmt.bits)) {
        return invalidFmtResult(fmt);
      }
    } else if (id === "data") {
      dataSize = size;
    }
    off += 8 + size + (size % 2);
  }

  if (!fmt) {
    return reject(GATE_REJECT.INVALID_WAV_CONTAINER, "missing fmt chunk");
  }
  if (dataSize <= 0) {
    return reject(GATE_REJECT.INVALID_PCM, "zero-length WAV data chunk");
  }
  return accept();
}

function validPcm(format: number, channels: number, sampleRate: number, bits: number): boolean {
  if (format === 1 && !WAV_PCM_BITS.has(bits)) return false;
  if (format !== 1) return false;
  if (!validChannelsAndRate(channels, sampleRate)) return false;
  return true;
}

function invalidFmtResult(fmt: { format: number; channels: number; sampleRate: number; bits: number }): RejectedGate {
  if (fmt.format !== 1) {
    return reject(
      GATE_REJECT.NOT_PCM_WAV,
      `WAV audio format code ${fmt.format} is not PCM`,
    );
  }
  if (!WAV_PCM_BITS.has(fmt.bits)) {
    return reject(GATE_REJECT.NOT_PCM_WAV, `unsupported PCM bit depth ${fmt.bits}`);
  }
  return reject(
    GATE_REJECT.INVALID_PCM,
    `unsupported channels/sample rate ${fmt.channels}/${fmt.sampleRate}`,
  );
}

function validateFlac(bytes: ArrayBuffer): QualityGateResult {
  const buf = new Uint8Array(bytes);
  if (buf.byteLength < 12) {
    return reject(GATE_REJECT.INVALID_FLAC_CONTAINER, "file too small for FLAC magic");
  }
  if (ascii(buf, 0, 4) !== "fLaC") {
    return reject(GATE_REJECT.INVALID_FLAC_CONTAINER, "missing fLaC magic");
  }
  const dv = new DataView(bytes);
  const blockHeader = dv.getUint32(4, false); // big-endian
  const blockType = (blockHeader >>> 24) & 0x7f;
  const blockLen = blockHeader & 0xffffff;
  if (blockType !== 0) {
    return reject(GATE_REJECT.INVALID_FLAC_CONTAINER, "first metadata block is not STREAMINFO");
  }
  if (blockLen < 34) {
    return reject(GATE_REJECT.INVALID_FLAC_CONTAINER, "STREAMINFO too short");
  }
  const b0 = dv.getUint32(18, false);
  const b1 = dv.getUint32(22, false);
  const sampleRate = (b0 >>> 12) & 0xfffff;
  const channels = ((b0 >>> 9) & 0x7) + 1;
  const bps = ((b0 >>> 4) & 0x1f) + 1;
  const totalSamples = ((b0 & 0xf) * 0x100000000) + b1;
  if (!validChannelsAndRate(channels, sampleRate)) {
    return reject(GATE_REJECT.INVALID_FLAC_CONTAINER, `unsupported channels/rate ${channels}/${sampleRate}`);
  }
  if (bps < 8 || bps > 32) {
    return reject(GATE_REJECT.INVALID_FLAC_CONTAINER, `unsupported FLAC bit depth ${bps}`);
  }
  if (totalSamples <= 0) {
    return reject(GATE_REJECT.INVALID_PCM, "zero-frame FLAC stream");
  }
  return accept();
}

function validChannelsAndRate(channels: number, sampleRate: number): boolean {
  return (
    Number.isInteger(channels) &&
    channels >= 1 &&
    channels <= MAX_VALID_CHANNELS &&
    Number.isFinite(sampleRate) &&
    sampleRate >= MIN_VALID_SAMPLE_RATE &&
    sampleRate <= MAX_VALID_SAMPLE_RATE
  );
}

/** Validate decoded PCM — independent of the decoder (Step 15H §7). */
export function validateDecodedAudio(audio: DecodedAudio): QualityGateResult {
  if (!Number.isFinite(audio.sampleRate)) {
    return reject(GATE_REJECT.INVALID_PCM, `non-finite sample rate`);
  }
  if (
    audio.sampleRate < MIN_VALID_SAMPLE_RATE ||
    audio.sampleRate > MAX_VALID_SAMPLE_RATE
  ) {
    return reject(GATE_REJECT.INVALID_PCM, `sample rate ${audio.sampleRate} out of gate bounds`);
  }
  if (!Number.isInteger(audio.channels) || audio.channels < 1 || audio.channels > MAX_VALID_CHANNELS) {
    return reject(GATE_REJECT.INVALID_PCM, `channel count ${audio.channels} out of gate bounds`);
  }
  if (!audio.mono || audio.mono.length === 0) {
    return reject(GATE_REJECT.INVALID_PCM, "zero frames decoded");
  }
  if (audio.mono.length < MIN_VALID_FRAMES) {
    return reject(
      GATE_REJECT.INVALID_PCM,
      `too few frames to analyze (${audio.mono.length} < ${MIN_VALID_FRAMES})`,
    );
  }
  if (!Number.isFinite(audio.durationSeconds) || audio.durationSeconds <= 0) {
    return reject(GATE_REJECT.INVALID_PCM, `invalid duration ${audio.durationSeconds}`);
  }
  for (let i = 0; i < audio.mono.length; i++) {
    if (!Number.isFinite(audio.mono[i])) {
      return reject(GATE_REJECT.INVALID_PCM, `non-finite PCM sample at frame ${i}`);
    }
  }
  return accept();
}

function ascii(buf: Uint8Array, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(buf[offset + i]);
  return s;
}