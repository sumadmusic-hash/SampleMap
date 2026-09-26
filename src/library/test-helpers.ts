import type { SampleMeta } from "@audiotool/nexus/api";
import { toSampleName } from "./sampleRef";

let seq = 0;

/** Build a synthetic SampleMeta with normalized name/computeTime for tests. */
export function makeSampleMeta(
  name: string,
  overrides: Partial<SampleMeta> = {},
): SampleMeta {
  seq += 1;
  const id = toSampleName(name);
  return {
    name: id,
    displayName: overrides.displayName ?? `Sample ${seq}`,
    description: "",
    ownerName: "users/alice",
    favoritedByUser: false,
    numFavorites: 0,
    numUsages: 0,
    bpm: 0,
    kind: "one-shot",
    visibility: "public",
    tags: [],
    createTime: new Date("2026-01-01T00:00:00.000Z"),
    updateTime: new Date("2026-01-01T00:00:00.000Z"),
    durationSeconds: 0.5,
    mp3Url: `https://example.mp3/${id}`,
    wavUrl: `https://example.wav/${id}`,
    flacUrl: `https://example.flac/${id}`,
    previewMp3Url: `https://example.preview/${id}`,
    getWaveformUrl: () => `https://example.waveform/${id}`,
    ...overrides,
  };
}
