/**
 * Minimal audio container builders + parsers for tests.
 *
 * These produce REAL RIFF/WAVE containers (valid enough for real decoders and
 * for the quality gate) so the pipeline can exercise the technical gate against
 * genuine container bytes instead of opaque fake buffers. They are NOT
 * production code — they exist so tests keep the "gate validates actual bytes"
 * property true while staying hermetic.
 *
 * FLAC is only ever checked at the container/header level by the gate, so the
 * FLAC builder creates a header-plausible fLaC+STREAMINFO (NOT frame-decodable).
 * Real FLAC decode is covered separately (Step 15G live verification) and by
 * the integration fixture for real decode when available.
 */

export interface PcmWavSpec {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Must be 1 (PCM). Pass another value to test gate rejection. */
  audioFormat?: number;
  /** Signed 16-bit source samples (bitsPerSample === 16). */
  samples?: Int16Array;
  /** Number of frames (used when samples is absent; then data is zero-filled). */
  frames?: number;
}

/** Serialize a minimal RIFF/WAVE (fixed 16-byte fmt chunk + data chunk). */
export function buildPcmWavBytes(spec: PcmWavSpec): ArrayBuffer {
  const channels = spec.channels;
  const bits = spec.bitsPerSample;
  const bytesPerSample = bits / 8;
  const input = spec.audioFormat ?? 1;

  let dataSize: number;
  if (spec.samples) {
    if (bits !== 16) throw new Error("fixtures: samples only supported for 16-bit PCM");
    if (spec.samples.length % channels !== 0) {
      throw new Error("fixtures: sample count must be channels * frames");
    }
    dataSize = spec.samples.length * 2;
  } else {
    const frames = spec.frames ?? 0;
    dataSize = frames * channels * bytesPerSample;
  }

  const total = 44 + dataSize;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  writeAscii(dv, 0, "RIFF");
  dv.setUint32(4, total - 8, true);
  writeAscii(dv, 8, "WAVE");
  writeAscii(dv, 12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, input, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, spec.sampleRate, true);
  dv.setUint32(28, spec.sampleRate * channels * bytesPerSample, true);
  dv.setUint16(32, channels * bytesPerSample, true);
  dv.setUint16(34, bits, true);
  writeAscii(dv, 36, "data");
  dv.setUint32(40, dataSize, true);
  if (spec.samples) {
    for (let i = 0; i < spec.samples.length; i++) {
      dv.setInt16(44 + i * 2, spec.samples[i], true);
    }
  }
  return buf;
}

export interface ParsedPcmWav {
  audioFormat: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  data: Uint8Array;
}

/** Read fmt + data back out of a WAV container (gate sanity subset). */
export function parsePcmWav(bytes: ArrayBuffer): ParsedPcmWav {
  const buf = new Uint8Array(bytes);
  const dv = new DataView(bytes);
  let off = 12;
  let fmt: ParsedPcmWav | undefined;
  while (off + 8 <= buf.byteLength) {
    const id = asciiAt(buf, off, 4);
    const size = dv.getUint32(off + 4, true);
    if (id === "fmt " && off + 8 + size <= buf.byteLength) {
      fmt = {
        audioFormat: dv.getUint16(off + 8, true),
        sampleRate: dv.getUint32(off + 12, true),
        channels: dv.getUint16(off + 10, true),
        bitsPerSample: dv.getUint16(off + 22, true),
        data: new Uint8Array(0),
      };
    } else if (id === "data" && fmt) {
      const start = off + 8;
      fmt.data = buf.slice(start, Math.min(start + size, buf.byteLength));
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt) throw new Error("fixtures: not a parseable WAV");
  return fmt;
}

/** Deterministic pseudo-random s16 samples (repeatable across runs). */
export function detSamples(frames: number, channels: number, seed: number): Int16Array {
  const out = new Int16Array(frames * channels);
  let s = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = ((s % 65536) >>> 0) - 32768;
  }
  return out;
}

/** Convenience: build a WAV container with deterministic samples (16-bit CNC). */
export function buildWavWithSeed(opts: {
  sampleRate?: number;
  channels?: number;
  frames: number;
  seed: number;
}): ArrayBuffer {
  const sampleRate = opts.sampleRate ?? 48000;
  const channels = opts.channels ?? 1;
  return buildPcmWavBytes({
    sampleRate,
    channels,
    bitsPerSample: 16,
    samples: detSamples(opts.frames, channels, opts.seed),
  });
}

/**
 * Build a WAV where the data chunk contains the raw bytes of `name`.
 * The fake decode in tests can parse this back out of the data chunk via
 * `parsePcmWav(bytes).data`, letting it identify the sample without needing
 * opaque "marker bytes" that fail the container gate.
 */
export function buildWavWithMarker(name: string, sampleRate = 48000): ArrayBuffer {
  const raw = new TextEncoder().encode(name);
  const aligned = raw.length % 2 === 0 ? raw.length : raw.length + 1;
  const samples = new Int16Array(aligned / 2);
  for (let i = 0; i < aligned; i += 2) {
    samples[i / 2] = raw[i] | ((i + 1 < raw.length ? raw[i + 1] : 0) << 8);
  }
  return buildPcmWavBytes({ sampleRate, channels: 1, bitsPerSample: 16, samples });
}

export interface FlacGateSpec {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples?: number;
}

/**
 * Header-plausible FLAC (fLaC magic + STREAMINFO only, no frames).
 * Valid enough for the container gate; NOT frame-decodable. For gate tests only.
 */
export function buildFlacGateBytes(spec: FlacGateSpec): ArrayBuffer {
  const buf = new ArrayBuffer(42);
  const dv = new DataView(buf);
  writeAscii(dv, 0, "fLaC");
  dv.setUint32(4, 0x80000000 | 34, false); // last-metadata, STREAMINFO, 34 bytes
  dv.setUint16(8, 4096, false); // minBlockSize
  dv.setUint16(10, 4096, false); // maxBlockSize
  setUint24(dv, 12, 0); // minFrameSize
  setUint24(dv, 15, 0); // maxFrameSize
  const total = spec.totalSamples ?? 44100;
  const b0 =
    ((spec.sampleRate & 0xfffff) << 12) |
    (((spec.channels - 1) & 0x7) << 9) |
    (((spec.bitsPerSample - 1) & 0x1f) << 4) |
    ((total / 0x100000000) & 0xf);
  const b1 = (total & 0xffffffff) >>> 0;
  dv.setUint32(18, b0, false);
  dv.setUint32(22, b1, false);
  return buf;
}

function writeAscii(dv: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i));
}

function asciiAt(buf: Uint8Array, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(buf[offset + i]);
  return s;
}

function setUint24(dv: DataView, offset: number, value: number): void {
  dv.setUint8(offset, (value >>> 16) & 0xff);
  dv.setUint8(offset + 1, (value >>> 8) & 0xff);
  dv.setUint8(offset + 2, value & 0xff);
}

/**
 * Build a WAV container with an extra arbitrary chunk inserted BEFORE the data
 * chunk. The fmt+data are identical to a plain `buildPcmWavBytes` call with
 * the same spec, so decoding produces the same DecodedAudio — but the container
 * bytes are different (different fileHash). This proves that contentHash is
 * derived from decoded audio, not from container bytes (Step 15I §11).
 */
export function buildPcmWavBytesWithExtraChunk(
  spec: PcmWavSpec,
  extraChunkId: string,
  extraChunkData: Uint8Array,
): ArrayBuffer {
  const channels = spec.channels;
  const bits = spec.bitsPerSample;
  const bytesPerSample = bits / 8;
  const input = spec.audioFormat ?? 1;

  let dataSize: number;
  if (spec.samples) {
    if (bits !== 16) throw new Error("fixtures: samples only supported for 16-bit PCM");
    if (spec.samples.length % channels !== 0) {
      throw new Error("fixtures: sample count must be channels * frames");
    }
    dataSize = spec.samples.length * 2;
  } else {
    const frames = spec.frames ?? 0;
    dataSize = frames * channels * bytesPerSample;
  }

  const extraSize = extraChunkData.length;
  const extraPadded = extraSize + (extraSize % 2); // RIFF chunks are word-aligned
  // RIFF header (12) + fmt (8+16) + extra chunk (8+extraPadded) + data (8+dataSize)
  const total = 12 + 24 + 8 + extraPadded + 8 + dataSize;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  let o = 0;
  writeAscii(dv, o, "RIFF"); o += 4;
  dv.setUint32(o, total - 8, true); o += 4;
  writeAscii(dv, o, "WAVE"); o += 4;
  // fmt chunk
  writeAscii(dv, o, "fmt "); o += 4;
  dv.setUint32(o, 16, true); o += 4;
  dv.setUint16(o, input, true); o += 2;
  dv.setUint16(o, channels, true); o += 2;
  dv.setUint32(o, spec.sampleRate, true); o += 4;
  dv.setUint32(o, spec.sampleRate * channels * bytesPerSample, true); o += 4;
  dv.setUint16(o, channels * bytesPerSample, true); o += 2;
  dv.setUint16(o, bits, true); o += 2;
  // extra chunk
  writeAscii(dv, o, extraChunkId); o += 4;
  dv.setUint32(o, extraSize, true); o += 4;
  for (let i = 0; i < extraChunkData.length; i++) dv.setUint8(o + i, extraChunkData[i]);
  o += extraPadded;
  // data chunk
  writeAscii(dv, o, "data"); o += 4;
  dv.setUint32(o, dataSize, true); o += 4;
  if (spec.samples) {
    for (let i = 0; i < spec.samples.length; i++) {
      dv.setInt16(o + i * 2, spec.samples[i], true);
    }
  }
  return buf;
}