/**
 * DecodedAudio — the analysis contract for one audio sample.
 *
 * It is PCM (Float32 mono-summed) with decoding metadata. This object exists
 * ONLY transiently in the analysis worker's memory; it is never persisted to
 * IndexedDB (SAMPLEMAP_V1_SPEC §1.1). PCM is a Float32Array of sample values,
 * which is explicitly allowed transient memory (not audio *bytes* stored).
 */
export interface DecodedAudio {
  sampleRate: number;
  channels: number;
  /** Channel-summed PCM, monotone. */
  mono: Float32Array;
  /** ceil(mono.length / sampleRate), seconds. */
  durationSeconds: number;
}

/**
 * Signature for decoding raw audio bytes into DecodedAudio.
 * The concrete implementation is environment-specific (e.g. Web Audio API
 * `AudioContext.decodeAudioData` in the browser); it is injected into the
 * pipeline so the extractor stays pure and testable.
 */
export type AudioDecoder = (bytes: ArrayBuffer) => Promise<DecodedAudio>;
