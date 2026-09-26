import { describe, it, expect } from "vitest";
import {
  validateAnalysisInput,
  assertValidAnalysisInput,
  downmixChannels,
  fromDecodedAudio,
} from "./v2Input";

function ok(): { sampleRate: number; channels: Float32Array[] } {
  return { sampleRate: 44100, channels: [new Float32Array([0.25, -0.5, 0.125])] };
}

describe("validateAnalysisInput", () => {
  it("accepts a valid single-channel input", () => {
    expect(validateAnalysisInput(ok()).valid).toBe(true);
  });

  it("accepts a zero-length channel (contributes silence, never throws)", () => {
    expect(validateAnalysisInput({ sampleRate: 44100, channels: [new Float32Array(0)] }).valid).toBe(true);
  });

  it("rejects non-objects and objects missing the contract", () => {
    for (const bad of [null, 42, "x", undefined]) {
      expect(validateAnalysisInput(bad).valid).toBe(false);
    }
    expect(validateAnalysisInput({}).valid).toBe(false);
    expect(validateAnalysisInput({ sampleRate: 44100 }).valid).toBe(false);
    expect(validateAnalysisInput({ channels: [new Float32Array(1)] }).valid).toBe(false);
  });

  it("rejects non-finite / non-positive sample rates", () => {
    for (const sr of [0, -44100, NaN, Infinity, -Infinity, "44100"]) {
      expect(validateAnalysisInput({ sampleRate: sr, channels: [new Float32Array(1)] }).valid).toBe(false);
    }
  });

  it("rejects empty channels lists and non-Float32Array channels", () => {
    expect(validateAnalysisInput({ sampleRate: 44100, channels: [] }).valid).toBe(false);
    const bad = validateAnalysisInput({ sampleRate: 44100, channels: [new Float64Array(2)] });
    expect(bad.valid).toBe(false);
    expect(bad.errors.join()).toContain("Float32Array");
  });

  it("rejects non-finite samples on any channel", () => {
    expect(validateAnalysisInput({ sampleRate: 44100, channels: [new Float32Array([1, NaN])] }).valid).toBe(false);
    expect(validateAnalysisInput({ sampleRate: 44100, channels: [new Float32Array([1, Infinity])] }).valid).toBe(false);
    const stereo = { sampleRate: 44100, channels: [new Float32Array([0, 0]), new Float32Array([0, -Infinity])] };
    expect(validateAnalysisInput(stereo).valid).toBe(false);
  });
});

describe("assertValidAnalysisInput", () => {
  it("passes through valid inputs", () => {
    expect(() => assertValidAnalysisInput(ok())).not.toThrow();
  });

  it("throws a TypeError describing every error for invalid inputs", () => {
    expect(() => assertValidAnalysisInput({ sampleRate: 0, channels: [] })).toThrow(TypeError);
    expect(() =>
      assertValidAnalysisInput({ sampleRate: NaN, channels: [] }),
    ).toThrow(/sampleRate/);
  });
});

describe("downmixChannels", () => {
  it("returns a copy for a single channel (no aliasing)", () => {
    const src = new Float32Array([1, 2, 3]);
    const mono = downmixChannels([src]);
    expect(mono).toEqual(src);
    src[0] = 99;
    expect(mono[0]).toBe(1);
  });

  it("equal channels average to the same value (energy preserved)", () => {
    const a = new Float32Array([0.5, -0.25, 0.75]);
    const mono = downmixChannels([a, a]);
    expect(mono).toEqual(a);
  });

  it("shorter channels are zero-padded to the longest channel", () => {
    const a = new Float32Array([1, 1, 1]);
    const b = new Float32Array([0, 0]);
    const mono = downmixChannels([a, b]);
    expect(Array.from(mono)).toEqual([0.5, 0.5, 0.5]);
  });

  it("three channels of unequal length combine as the mean over the timeline", () => {
    const mono = downmixChannels([new Float32Array([3, 3, 3]), new Float32Array([0]), new Float32Array([])]);
    expect(Array.from(mono)).toEqual([1, 1, 1]);
  });

  it("is deterministic and never mutates its inputs", () => {
    const a = new Float32Array([0.1, 0.2, -0.3]);
    const b = new Float32Array([-0.4, 0.5]);
    const beforeA = Array.from(a);
    const beforeB = Array.from(b);
    const first = downmixChannels([a, b]);
    const second = downmixChannels([a, b]);
    expect(first).toEqual(second);
    expect(Array.from(a)).toEqual(beforeA);
    expect(Array.from(b)).toEqual(beforeB);
  });
});

describe("fromDecodedAudio", () => {
  it("maps DecodedAudio mono PCM into the V2 input contract", () => {
    const audio = {
      sampleRate: 22050,
      channels: 1,
      mono: new Float32Array([0, 1, -1]),
      durationSeconds: 3 / 22050,
    };
    const input = fromDecodedAudio(audio);
    expect(input.sampleRate).toBe(22050);
    expect(input.channels).toHaveLength(1);
    expect(input.channels[0]).toBe(audio.mono);
  });
});