import { describe, it, expect } from "vitest";
import type { DecodedAudio } from "../audio/decodedAudio";
import {
  GATE_REJECT,
  MIN_VALID_FRAMES,
  validateDecodedAudio,
} from "./qualityGate";

function decoded(overrides: Partial<DecodedAudio> = {}): DecodedAudio {
  return {
    sampleRate: 44100,
    channels: 1,
    mono: new Float32Array(44100),
    durationSeconds: 1,
    ...overrides,
  };
}

describe("validateDecodedAudio (decoded-PCM gate)", () => {
  it("accepts a nominal decoded buffer", () => {
    const res = validateDecodedAudio(decoded());
    expect(res.accepted).toBe(true);
  });

  it("rejects a zero-frame buffer as INVALID_PCM", () => {
    const res = validateDecodedAudio(decoded({ mono: new Float32Array(0) }));
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe(GATE_REJECT.INVALID_PCM);
  });

  it("rejects a single-frame buffer as INVALID_PCM (deterministic skip, no extractor crash)", () => {
    const res = validateDecodedAudio(
      decoded({ mono: new Float32Array([0.5]), durationSeconds: 1 / 44100 }),
    );
    expect(res.accepted).toBe(false);
    if (!res.accepted) {
      expect(res.reason).toBe(GATE_REJECT.INVALID_PCM);
      expect(res.detail).toContain("too few frames");
    }
  });

  it("accepts a buffer of exactly MIN_VALID_FRAMES", () => {
    const res = validateDecodedAudio(
      decoded({ mono: new Float32Array(MIN_VALID_FRAMES), durationSeconds: 2 / 44100 }),
    );
    expect(res.accepted).toBe(true);
  });

  it("rejects a non-finite sample", () => {
    const mono = new Float32Array(64);
    mono[3] = NaN;
    const res = validateDecodedAudio(decoded({ mono }));
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe(GATE_REJECT.INVALID_PCM);
  });

  it("rejects an out-of-gate sample rate", () => {
    const res = validateDecodedAudio(decoded({ sampleRate: 1000 }));
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe(GATE_REJECT.INVALID_PCM);
  });
});