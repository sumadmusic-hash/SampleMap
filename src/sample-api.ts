import type {
  SampleMeta,
  SampleListResult,
  SamplesAPI,
  SampleFormat,
} from "@audiotool/nexus/api";

export type { SampleMeta, SampleListResult, SampleFormat };

/**
 * Formats a sample's formatted playback time from seconds.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "n/a";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Normalize tags into a displayable string. Handles undefined/empty gracefully.
 */
export function formatTags(tags: readonly string[] | undefined): string {
  if (!tags || tags.length === 0) return "-";
  return tags.join(", ");
}

/**
 * Determine which formats are available for a sample based on the presence
 * of download URLs + the sample kind/status.
 */
export type Availability = {
  wav: boolean;
  flac: boolean;
  mp3: boolean;
  preview: boolean;
};

export function checkAvailability(sample: SampleMeta | null): Availability | null {
  if (!sample) return null;
  return {
    wav: Boolean(sample.wavUrl),
    flac: Boolean(sample.flacUrl),
    mp3: Boolean(sample.mp3Url),
    preview: Boolean(sample.previewMp3Url),
  };
}

/**
 * Build a human-readable summary line for a single sample. This is the
 * canonical fields we must surface in the POC UI.
 */
export function summarizeSample(sample: SampleMeta): string {
  const av = checkAvailability(sample);
  return [
    `ID: ${sample.name}`,
    `Name: ${sample.displayName}`,
    `Kind: ${sample.kind}`,
    `Tags: ${formatTags(sample.tags)}`,
    `BPM: ${sample.bpm || "-"}`,
    `Duration: ${formatDuration(sample.durationSeconds)}`,
    `Owner: ${sample.ownerName}`,
    `Visibility: ${sample.visibility}`,
    `WAV: ${av?.wav ? "yes" : "no"} FLAC: ${av?.flac ? "yes" : "no"} MP3: ${av?.mp3 ? "yes" : "no"} Preview: ${av?.preview ? "yes" : "no"}`,
  ].join("\n");
}

/**
 * Iterate pagination pages of `samples.list` up to `maxSamples` total.
 *
 * This demonstrates correct pagination handling independently of the browser:
 * it follows `nextPageToken` until either the result is empty, the token runs
 * out, or we have collected `maxSamples`.
 */
export async function listSamplesPageByPage(
  samplesApi: Pick<SamplesAPI, "list">,
  opts: { pageSize?: number; maxSamples?: number } = {},
): Promise<{ samples: SampleMeta[]; pageCount: number; stopped: boolean }> {
  const { pageSize = 20, maxSamples = 20 } = opts;
  const collected: SampleMeta[] = [];
  let pageCount = 0;
  let pageToken: string | undefined;
  let stopped = false;

  do {
    const result = await samplesApi.list({ pageSize, pageToken });
    if (result instanceof Error) {
      throw new SampleApiError(`list() failed: ${result.message}`, result);
    }
    pageCount++;
    const remaining = maxSamples - collected.length;
    const take = Math.min(result.samples.length, remaining);
    collected.push(...result.samples.slice(0, take));
    pageToken = result.nextPageToken || undefined;
    if (collected.length >= maxSamples) {
      stopped = true;
      break;
    }
  } while (pageToken && pageToken.length > 0);

  return { samples: collected, pageCount, stopped };
}

/**
 * Wraps an error with API context. Keeps the original error available.
 */
export class SampleApiError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "SampleApiError";
    this.cause = cause;
  }
}

/**
 * Validate a list result shape (defensive parsing used by both the UI and tests).
 */
export function assertValidSampleList(result: unknown): asserts result is SampleListResult {
  if (result === null || typeof result !== "object") {
    throw new SampleApiError("list() returned a non-object", result);
  }
  const r = result as Partial<SampleListResult>;
  if (!Array.isArray(r.samples)) {
    throw new SampleApiError("list() result missing `samples` array", result);
  }
  if (typeof r.nextPageToken !== "string") {
    throw new SampleApiError("list() result missing `nextPageToken` string", result);
  }
}

/**
 * Determine a short human-readable format label.
 */
export function formatLabel(format: SampleFormat): string {
  switch (format) {
    case "wav":
      return "WAV";
    case "flac":
      return "FLAC";
    case "mp3":
      return "MP3";
    case "preview":
      return "Preview (MP3)";
    default:
      return format;
  }
}
