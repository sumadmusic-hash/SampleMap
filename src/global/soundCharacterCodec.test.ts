import { describe, it, expect } from "vitest";
import {
  SOUND_CHARACTER_CODEC_VERSION,
  PACKED_SOUND_CHARACTER_BYTES,
  encodeSoundCharacter,
  decodeSoundCharacterPacked,
  packedToBase64,
  base64ToPacked,
  encodeSoundCharacterToBase64,
  decodeSoundCharacterFromBase64,
} from "./soundCharacterCodec";
import { SOUND_CHARACTER_DIMENSIONS } from "../analysis/config";
import type { SoundCharacter } from "../analysis/soundCharacter";
import { emptySoundCharacter } from "../analysis/soundCharacter";

const CHAR: SoundCharacter = {
  brightness: 1,
  density: 0,
  transient: 0.5,
  duration: null,
  tonality: 0.25,
  noisiness: 0.75,
  dynamics: 0.99999,
  complexity: null,
};

/** Max error of a single 16-bit slot ≈ 1/65535 ≈ 1.526e-5. */
const TOL = 1 / 65535 + 1e-9;

function roundTripError(a: SoundCharacter, b: SoundCharacter): number {
  let worst = 0;
  for (const dim of SOUND_CHARACTER_DIMENSIONS) {
    const va = a[dim];
    const vb = b[dim];
    if (va === null || vb === null) continue;
    worst = Math.max(worst, Math.abs(va - vb));
  }
  return worst;
}

describe("soundCharacterCodec — layout", () => {
  it("pins the version + byte size contract", () => {
    expect(SOUND_CHARACTER_CODEC_VERSION).toBe("V2.SC-v1");
    expect(PACKED_SOUND_CHARACTER_BYTES).toBe(17);
  });

  it("always produces exactly 17 bytes", () => {
    const packed = encodeSoundCharacter(CHAR);
    expect(packed.byteLength).toBe(PACKED_SOUND_CHARACTER_BYTES);
  });

  it("mask bit i maps to SOUND_CHARACTER_DIMENSIONS[i] (canonical order)", () => {
    const packed = encodeSoundCharacter(CHAR);
    // brightness(0) present, density(1) present, transient(2) present,
    // duration(3) NULL, tonality(4) present, noisiness(5) present,
    // dynamics(6) present, complexity(7) NULL.
    const mask = packed[0];
    expect(mask & (1 << 0)).toBe(0);
    expect(mask & (1 << 1)).toBe(0);
    expect(mask & (1 << 2)).toBe(0);
    expect(mask & (1 << 3)).not.toBe(0);
    expect(mask & (1 << 4)).toBe(0);
    expect(mask & (1 << 5)).toBe(0);
    expect(mask & (1 << 6)).toBe(0);
    expect(mask & (1 << 7)).not.toBe(0);
  });

  it("stores 16-bit big-endian slots in canonical order", () => {
    const packed = encodeSoundCharacter(CHAR);
    // brightness = 1 → q = 65535 → 0xFF 0xFF.
    expect(packed[1]).toBe(0xff);
    expect(packed[2]).toBe(0xff);
    // density = 0 → q = 0 → 0x00 0x00 (mask bit clear: NOT a null).
    expect(packed[3]).toBe(0x00);
    expect(packed[4]).toBe(0x00);
  });

  it("null dims store slot 0 under a set mask bit (no imputation)", () => {
    const packed = encodeSoundCharacter(CHAR);
    const durationIndex = SOUND_CHARACTER_DIMENSIONS.indexOf("duration");
    const slot = 1 + durationIndex * 2;
    expect(packed[slot]).toBe(0);
    expect(packed[slot + 1]).toBe(0);
    expect(packed[0] & (1 << durationIndex)).not.toBe(0);
  });
});

describe("soundCharacterCodec — quantize / dequantize", () => {
  it("round-trips a present dim within 1 LSB", () => {
    const back = decodeSoundCharacterPacked(encodeSoundCharacter(CHAR))!;
    expect(back).not.toBeUndefined();
    for (const dim of SOUND_CHARACTER_DIMENSIONS) {
      if (CHAR[dim] === null) {
        expect(back![dim]).toBeNull();
      }
    }
    expect(roundTripError(CHAR, back!)).toBeLessThanOrEqual(TOL);
  });

  it("0 → 0 and 1 → exactly 1 (65535/65535)", () => {
    const back = decodeSoundCharacterPacked(
      encodeSoundCharacter({ ...emptySoundCharacter(), density: 0, brightness: 1 }),
    )!;
    expect(back.density).toBe(0);
    expect(back.brightness).toBe(1);
  });

  it("an all-null character round-trips fully null", () => {
    const back = decodeSoundCharacterPacked(encodeSoundCharacter(emptySoundCharacter()))!;
    expect(back).toEqual(emptySoundCharacter());
  });

  it("clamps out-of-range dims to [0, 1] on encode", () => {
    const char: SoundCharacter = {
      ...emptySoundCharacter(),
      brightness: 1.5,
      density: -0.2,
    };
    const back = decodeSoundCharacterPacked(encodeSoundCharacter(char))!;
    expect(back.brightness).toBe(1);
    expect(back.density).toBe(0);
  });

  it("midpoint 0.5 quantizes within 1 LSB (never fabricated as null)", () => {
    const back = decodeSoundCharacterPacked(
      encodeSoundCharacter({ ...emptySoundCharacter(), tonality: 0.5 }),
    )!;
    expect(back.tonality).not.toBeNull();
    expect(Math.abs(back.tonality! - 0.5)).toBeLessThanOrEqual(TOL);
  });
});

describe("soundCharacterCodec — base64 transport", () => {
  it("encodes 17 bytes to exactly 24 base64 chars and decodes back", () => {
    const packed = encodeSoundCharacter(CHAR);
    const b64 = packedToBase64(packed);
    expect(b64).toHaveLength(24);
    const back = base64ToPacked(b64)!;
    expect(back.byteLength).toBe(PACKED_SOUND_CHARACTER_BYTES);
    expect(Array.from(back)).toEqual(Array.from(packed));
  });

  it("encodeSoundCharacterToBase64 → decodeSoundCharacterFromBase64 round-trips", () => {
    const char = decodeSoundCharacterFromBase64(
      encodeSoundCharacterToBase64(CHAR),
    )!;
    expect(char).not.toBeUndefined();
    expect(roundTripError(CHAR, char)).toBeLessThanOrEqual(TOL);
    for (const dim of SOUND_CHARACTER_DIMENSIONS) {
      if (CHAR[dim] === null) expect(char![dim]).toBeNull();
    }
  });

  it("is deterministic: same character → same base64", () => {
    expect(encodeSoundCharacterToBase64(CHAR)).toBe(
      encodeSoundCharacterToBase64(CHAR),
    );
  });

  it("is JSON-safe: the packed string contains no byte containers", () => {
    const b64 = encodeSoundCharacterToBase64(CHAR);
    expect(JSON.parse(JSON.stringify(b64))).toBe(b64);
  });
});

describe("soundCharacterCodec — corruption handling", () => {
  it("rejects packed arrays that are not 17 bytes", () => {
    expect(decodeSoundCharacterPacked(new Uint8Array(16))).toBeUndefined();
    expect(decodeSoundCharacterPacked(new Uint8Array(18))).toBeUndefined();
    expect(decodeSoundCharacterPacked(new Uint8Array(0))).toBeUndefined();
  });

  it("rejects malformed base64", () => {
    expect(base64ToPacked("!!not-base64!!")).toBeUndefined();
    expect(base64ToPacked("AAAAA")).toBeUndefined(); // not a multiple of 4
    expect(decodeSoundCharacterFromBase64("not-base64")).toBeUndefined();
  });

  it("rejects base64 that decodes to the wrong length", () => {
    // 23 chars worth of bytes round down to 16 bytes — wrong for V2.SC-v1.
    expect(decodeSoundCharacterFromBase64("QUFBQUFBQUFBQUFBQUFBQQ==")).toBeUndefined();
  });
});