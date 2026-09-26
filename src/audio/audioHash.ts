import type { CanonicalPcm } from "./canonicalPcm";

/**
 * Audio hashing (Step 15H §13–§14).
 *
 * Two independent hashes:
 *
 *  fileHash   : SHA-256 over the exact analysis-source container bytes
 *               (the downloaded WAV/FLAC file). Identifies the source file.
 *  contentHash: SHA-256 over the versioned canonical PCM (see canonicalPcm.ts).
 *               Identifies the canonicalized decoded AUDIO CONTENT, NOT the
 *               file, NOT any metadata. It is deliberately derived from the
 *               PCM only (never sampleId / name / tags / features / URLs).
 *
 * Uses the platform WebCrypto (`crypto.subtle`), which exists in both Node 22
 * and browsers, so these functions are environment-agnostic (Step 15H §21).
 */
export const CONTENT_HASH_MAGIC = "SMPCM";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // .slice() returns Uint8Array<ArrayBuffer>, satisfying BufferSource.
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  const arr = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, "0");
  return hex;
}

/** SHA-256 over the exact source container bytes. */
export function fileHashOf(bytes: ArrayBuffer): Promise<string> {
  return sha256Hex(new Uint8Array(bytes));
}

/**
 * SHA-256 over a versioned serialization of canonical PCM.
 * Serialization: "SMPCM" + version (ascii, fixed-length string) + u32LE
 * sampleRate + u32LE frames + s16LE interleaved samples.
 */
export function contentHashOf(pcm: CanonicalPcm): Promise<string> {
  const versionBytes = pcm.version.length;
  const headerLen = CONTENT_HASH_MAGIC.length + versionBytes + 4 + 4;
  const serialized = new Uint8Array(headerLen + pcm.samples.byteLength);
  const dv = new DataView(serialized.buffer);
  let o = 0;
  for (let i = 0; i < CONTENT_HASH_MAGIC.length; i++) {
    serialized[o++] = CONTENT_HASH_MAGIC.charCodeAt(i);
  }
  for (let i = 0; i < versionBytes; i++) {
    serialized[o++] = pcm.version.charCodeAt(i);
  }
  dv.setUint32(o, pcm.sampleRate, true);
  o += 4;
  dv.setUint32(o, pcm.frames, true);
  o += 4;
  for (let i = 0; i < pcm.samples.length; i++) {
    dv.setInt16(o + i * 2, pcm.samples[i], true);
  }
  return sha256Hex(serialized);
}