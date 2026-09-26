import { describe, it, expect, vi } from "vitest";
import type { SampleMeta, SampleFormat, SampleListResult } from "@audiotool/nexus/api";
import {
  formatDuration,
  formatTags,
  checkAvailability,
  summarizeSample,
  listSamplesPageByPage,
  SampleApiError,
  assertValidSampleList,
  formatLabel,
} from "./sample-api";

function makeMeta(overrides: Partial<SampleMeta> = {}): SampleMeta {
  return {
    name: "samples/00000000-0000-0000-0000-000000000000",
    displayName: "Test Kick",
    description: "",
    ownerName: "users/owner",
    favoritedByUser: false,
    numFavorites: 0,
    numUsages: 0,
    bpm: 120,
    kind: "one-shot",
    visibility: "public",
    tags: ["kick", "drum"],
    createTime: undefined,
    updateTime: undefined,
    durationSeconds: 1.5,
    mp3Url: "https://cdn/mp3",
    wavUrl: "https://cdn/wav",
    flacUrl: "https://cdn/flac",
    previewMp3Url: "https://cdn/preview",
    getWaveformUrl: () => "https://cdn/wave",
    ...overrides,
  };
}

function makeListResult(samples: SampleMeta[], nextPageToken = ""): SampleListResult {
  return { samples, nextPageToken };
}

describe("formatDuration", () => {
  it("formats minutes:seconds", () => {
    expect(formatDuration(65)).toBe("1:05");
  });
  it("pads seconds", () => {
    expect(formatDuration(9)).toBe("0:09");
  });
  it("handles zero", () => {
    expect(formatDuration(0)).toBe("0:00");
  });
  it("handles NaN and negatives", () => {
    expect(formatDuration(NaN)).toBe("n/a");
    expect(formatDuration(-3)).toBe("n/a");
  });
});

describe("formatTags", () => {
  it("joins tags with comma", () => {
    expect(formatTags(["a", "b"])).toBe("a, b");
  });
  it("empty array -> dash", () => {
    expect(formatTags([])).toBe("-");
  });
  it("undefined -> dash", () => {
    expect(formatTags(undefined)).toBe("-");
  });
});

describe("checkAvailability", () => {
  it("reports all formats when URLs are present", () => {
    expect(checkAvailability(makeMeta())).toEqual({
      wav: true,
      flac: true,
      mp3: true,
      preview: true,
    });
  });
  it("reports missing URLs as false", () => {
    expect(
      checkAvailability(makeMeta({ wavUrl: "", flacUrl: "", mp3Url: "x", previewMp3Url: "" })),
    ).toEqual({ wav: false, flac: false, mp3: true, preview: false });
  });
  it("returns null for null sample", () => {
    expect(checkAvailability(null)).toBeNull();
  });
});

describe("summarizeSample", () => {
  it("includes all required fields", () => {
    const s = summarizeSample(makeMeta());
    expect(s).toContain("ID: samples/");
    expect(s).toContain("Name: Test Kick");
    expect(s).toContain("Kind: one-shot");
    expect(s).toContain("Tags: kick, drum");
    expect(s).toContain("BPM: 120");
    expect(s).toContain("Owner: users/owner");
    expect(s).toContain("Visibility: public");
    expect(s).toContain("Duration:");
    expect(s).toContain("WAV: yes");
    expect(s).toContain("FLAC: yes");
    expect(s).toContain("MP3: yes");
    expect(s).toContain("Preview: yes");
  });
});

describe("assertValidSampleList", () => {
  it("accepts a valid result", () => {
    expect(() => assertValidSampleList(makeListResult([makeMeta()]))).not.toThrow();
  });
  it("rejects a non-object", () => {
    expect(() => assertValidSampleList(null)).toThrow(SampleApiError);
    expect(() => assertValidSampleList("x")).toThrow(SampleApiError);
  });
  it("rejects a missing samples array", () => {
    expect(() => assertValidSampleList({ samples: "nope", nextPageToken: "" })).toThrow(
      SampleApiError,
    );
  });
  it("rejects a missing nextPageToken", () => {
    expect(() => assertValidSampleList({ samples: [], nextPageToken: 5 })).toThrow(
      SampleApiError,
    );
  });
});

describe("formatLabel", () => {
  it.each<[SampleFormat, string]>([
    ["wav", "WAV"],
    ["flac", "FLAC"],
    ["mp3", "MP3"],
    ["preview", "Preview (MP3)"],
  ])("maps %s -> %s", (f, expected) => {
    expect(formatLabel(f)).toBe(expected);
  });
});

describe("listSamplesPageByPage", () => {
  it("returns all samples on a single page", async () => {
    const list = vi.fn().mockResolvedValue(makeListResult([makeMeta(), makeMeta()], ""));
    const result = await listSamplesPageByPage({ list }, { pageSize: 20, maxSamples: 20 });
    expect(result.samples).toHaveLength(2);
    expect(result.pageCount).toBe(1);
    expect(result.stopped).toBe(false);
  });

  it("follows pagination tokens", async () => {
    const m1 = makeMeta();
    const m2 = makeMeta();
    const m3 = makeMeta();
    const list = vi
      .fn()
      .mockResolvedValueOnce(makeListResult([m1], "TOKEN_A"))
      .mockResolvedValueOnce(makeListResult([m2], "TOKEN_B"))
      .mockResolvedValueOnce(makeListResult([m3], ""));

    const result = await listSamplesPageByPage({ list }, { pageSize: 1, maxSamples: 20 });
    expect(result.samples.map((s) => s.name)).toEqual([m1.name, m2.name, m3.name]);
    expect(result.pageCount).toBe(3);
    expect(result.stopped).toBe(false);
    expect(list.mock.calls.map((c) => c[0])).toEqual([
      { pageSize: 1, pageToken: undefined },
      { pageSize: 1, pageToken: "TOKEN_A" },
      { pageSize: 1, pageToken: "TOKEN_B" },
    ]);
  });

  it("stops early at maxSamples", async () => {
    const list = vi.fn().mockResolvedValue(makeListResult([makeMeta(), makeMeta()], "TOKEN"));
    const result = await listSamplesPageByPage({ list }, { pageSize: 2, maxSamples: 2 });
    expect(result.samples).toHaveLength(2);
    expect(result.stopped).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not over-collect token pages beyond maxSamples", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(makeListResult([makeMeta(), makeMeta(), makeMeta()], "T1"))
      .mockResolvedValueOnce(makeListResult([makeMeta()], ""));

    const result = await listSamplesPageByPage({ list }, { pageSize: 20, maxSamples: 3 });
    expect(result.samples).toHaveLength(3);
    expect(result.stopped).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("stops when there is no next page token", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(makeListResult([], "TOKEN"))
      .mockResolvedValueOnce(makeListResult([], ""));
    const result = await listSamplesPageByPage({ list }, { pageSize: 20 });
    expect(result.samples).toHaveLength(0);
    expect(result.pageCount).toBe(2);
  });

  it("propagates an Error from list()", async () => {
    const boom = new Error("boom");
    const list = vi.fn().mockResolvedValue(boom);
    await expect(listSamplesPageByPage({ list }, {})).rejects.toThrow(SampleApiError);
  });

  it("propagates a thrown error", async () => {
    const list = vi.fn().mockRejectedValue(new Error("network"));
    await expect(listSamplesPageByPage({ list }, {})).rejects.toThrow("network");
  });
});
