/**
 * STEP41 — V2 Global Knowledge codec: compact 16-bit packed SoundCharacter.
 *
 * The SoundCharacter is the single canonical 8-dimensional perceptual view the
 * V2 pipeline derives from decoded audio (`analysisV2.soundCharacter`). The
 * global index stores ONLY this compact canonical V2 knowledge (never features,
 * never audio), so a hydrating client can rebuild a local `analysisV2` and rank
 * Find Similar WITHOUT re-analyzing audio.
 *
 * LAYOUT (V2.SC-v1) — exactly 17 bytes:
 *
 *   byte 0   — null mask, bit i set ⇔ dimension i is null ("not determinable").
 *              bit0 = brightness, bit1 = density, bit2 = transient,
 *              bit3 = duration, bit4 = tonality, bit5 = noisiness,
 *              bit6 = dynamics, bit7 = complexity.
 *              Order is the canonical `SOUND_CHARACTER_DIMENSIONS` order — it
 *              CANNOT drift from `toSimilarityVector`/the similarity weights.
 *   bytes 1..16 — 8 × uint16 BIG-ENDIAN slots, one per dimension.
 *
 * ENCODE:   q = round(clamp01(v) * 65535)      (16-bit quantization, 1LSB ≈ 1.526e-5)
 * DECODE:   v = q / 65535  (a stored 65535 quantizes exactly to 1.0)
 * NULL:     a null dimension → mask bit = 1, slot = 0 (no imputation; the null
 *           mask is authoritative — slot 0 with the mask clear is the valid
 *           quantization of v = 0, never confused with a null).
 *
 * The packed 17-byte array is the canonical binary form. JSON transport
 * (GlobalAnalysisResult → publish → D1 → lookup → hydrate) carries it as a
 * BASE64 string so it survives `assertNoAudioBytes` and structured clone with
 * zero metadata loss. This module is PURE and environment-agnostic (no Buffer,
 * no btoa) so the same authority runs in the browser, the Worker and tests.
 */
import { SOUND_CHARACTER_DIMENSIONS } from "../analysis/config";
import type { SoundCharacter } from "../analysis/soundCharacter";

/** The codec version token pinned in every V2 knowledge block. */
export const SOUND_CHARACTER_CODEC_VERSION = "V2.SC-v1" as const;

/** Packed layout size: 1 null-mask byte + 8 × uint16. */
export const PACKED_SOUND_CHARACTER_BYTES = 17;

/** 16-bit quantization scale (65535 = 1.0). */
const QUANT = 0xffff;

/** Base64 alphabet (standard, RFC 4648). */
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_VALID = /^[A-Za-z0-9+/]*={0,2}$/;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function encodeChar(c: string): number {
  const idx = BASE64_ALPHABET.indexOf(c);
  return idx === -1 ? 0 : idx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Packed (17-byte) encoding / decoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode a SoundCharacter into the 17-byte packed layout (V2.SC-v1).
 * Null dims set their mask bit and store slot 0 (no imputation).
 */
export function encodeSoundCharacter(char: SoundCharacter): Uint8Array {
  const packed = new Uint8Array(PACKED_SOUND_CHARACTER_BYTES);
  let mask = 0;
  for (let i = 0; i < SOUND_CHARACTER_DIMENSIONS.length; i++) {
    const dim = SOUND_CHARACTER_DIMENSIONS[i];
    const v = char[dim];
    if (v === null || v === undefined) {
      mask |= 1 << i;
      continue;
    }
    const q = Math.round(clamp01(v) * QUANT);
    packed[1 + i * 2] = (q >> 8) & 0xff;
    packed[2 + i * 2] = q & 0xff;
  }
  packed[0] = mask;
  return packed;
}

/**
 * Decode the 17-byte packed layout into a SoundCharacter.
 * Returns `undefined` when the byte length is not exactly 17 (corrupt — the
 * caller treats the block as absent rather than fabricating a character).
 * The null mask is authoritative: slot 0 with the mask clear is v = 0.
 */
export function decodeSoundCharacterPacked(
  packed: Uint8Array,
): SoundCharacter | undefined {
  if (packed.byteLength !== PACKED_SOUND_CHARACTER_BYTES) return undefined;
  const mask = packed[0];
  const out: SoundCharacter = {
    brightness: null,
    density: null,
    transient: null,
    duration: null,
    tonality: null,
    noisiness: null,
    dynamics: null,
    complexity: null,
  };
  for (let i = 0; i < SOUND_CHARACTER_DIMENSIONS.length; i++) {
    if (mask & (1 << i)) continue; // null dimension (authoritative mask)
    const q = (packed[1 + i * 2] << 8) | packed[2 + i * 2];
    out[SOUND_CHARACTER_DIMENSIONS[i]] = q / QUANT;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Base64 transport encoding (JSON-safe, environment-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

/** 17 bytes → standard base64 (24 chars, 2 padding chars). */
export function packedToBase64(packed: Uint8Array): string {
  let out = "";
  for (let i = 0; i < packed.byteLength; i += 3) {
    const b0 = packed[i];
    const b1 = i + 1 < packed.byteLength ? packed[i + 1] : 0;
    const b2 = i + 2 < packed.byteLength ? packed[i + 2] : 0;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < packed.byteLength ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < packed.byteLength ? BASE64_ALPHABET[b2 & 0x3f] : "=";
  }
  return out;
}

/** Standard base64 → bytes. Returns `undefined` on malformed input. */
export function base64ToPacked(b64: string): Uint8Array | undefined {
  if (typeof b64 !== "string" || !BASE64_VALID.test(b64) || b64.length % 4 !== 0) {
    return undefined;
  }
  const bytes: number[] = [];
  for (let i = 0; i < b64.length; i += 4) {
    const c0 = encodeChar(b64[i]);
    const c1 = encodeChar(b64[i + 1]);
    const has2 = b64[i + 2] !== "=";
    const has3 = b64[i + 3] !== "=";
    const c2 = has2 ? encodeChar(b64[i + 2]) : 0;
    const c3 = has3 ? encodeChar(b64[i + 3]) : 0;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (has2) bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (has3) bytes.push(((c2 & 0x03) << 6) | c3);
  }
  return new Uint8Array(bytes);
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience round-trips
// ─────────────────────────────────────────────────────────────────────────────

/** Encode a SoundCharacter directly to its base64 transport string. */
export function encodeSoundCharacterToBase64(char: SoundCharacter): string {
  return packedToBase64(encodeSoundCharacter(char));
}

/**
 * Decode a base64 transport string into a SoundCharacter. Returns `undefined`
 * when the string is malformed or does not decode to exactly 17 bytes (the
 * caller treats the block as absent — the null mask never fabricates data).
 */
export function decodeSoundCharacterFromBase64(
  b64: string,
): SoundCharacter | undefined {
  const packed = base64ToPacked(b64);
  if (!packed) return undefined;
  return decodeSoundCharacterPacked(packed);
}