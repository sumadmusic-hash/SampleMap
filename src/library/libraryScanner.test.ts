import { describe, it, expect } from "vitest";
import { scanLibrary, PageFetcher, KnownProvider } from "./libraryScanner";
import { makeSampleMeta } from "./test-helpers";

function page(
  samples: ReturnType<typeof makeSampleMeta>[],
  nextPageToken?: string,
) {
  return { samples, nextPageToken };
}

/** In-memory known provider keyed by sampleId -> updateTime (ISO). */
function memoryKnown(
  map: Record<string, string | undefined>,
): KnownProvider {
  return { getUpdatedAt: async (id) => map[id] };
}

describe("LibraryScanner", () => {
  it("marks all samples as added when nothing is known yet", async () => {
    let calls = 0;
    const fetchPage: PageFetcher = async () => {
      calls++;
      expect(calls).toBe(1);
      return page([makeSampleMeta("samples/a"), makeSampleMeta("samples/b")]);
    };
    const result = await scanLibrary(fetchPage, memoryKnown({}), {
      dateNow: () => new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(result.added.map((s) => s.name)).toEqual(["samples/a", "samples/b"]);
    expect(result.changed).toEqual([]);
    expect(result.unchangedCount).toBe(0);
    expect(result.fullScan).toBe(true);
    expect(result.latestKnown).toBe("2026-02-01T00:00:00.000Z");
  });

  it("paginates across pages using nextPageToken", async () => {
    const fetchPage: PageFetcher = async ({ pageToken }) => {
      if (pageToken === undefined) {
        return page([makeSampleMeta("samples/a")], "p2");
      }
      return page([makeSampleMeta("samples/b")]);
    };
    const result = await scanLibrary(fetchPage, memoryKnown({}));
    expect(result.pageCount).toBe(2);
    expect(result.added.map((s) => s.name)).toEqual(["samples/a", "samples/b"]);
  });

  it("detects changed (newer updateTime) vs unchanged samples", async () => {
    const a = makeSampleMeta("samples/a", {
      updateTime: new Date("2026-03-01T00:00:00.000Z"),
    });
    const b = makeSampleMeta("samples/b", {
      updateTime: new Date("2026-01-01T00:00:00.000Z"),
    });
    const known = memoryKnown({
      "samples/a": "2026-02-01T00:00:00.000Z", // older than sample -> changed
      "samples/b": "2026-01-01T00:00:00.000Z", // same as sample -> unchanged
    });
    const result = await scanLibrary(async () => page([a, b]), known);
    expect(result.changed.map((s) => s.name)).toEqual(["samples/a"]);
    expect(result.unchangedCount).toBe(1);
    expect(result.added).toEqual([]);
  });

  it("stops early on maxSamples and reports fullScan=false", async () => {
    const fetchPage: PageFetcher = async () =>
      page([makeSampleMeta("samples/a"), makeSampleMeta("samples/b")]);
    const result = await scanLibrary(fetchPage, memoryKnown({}), {
      maxSamples: 2,
    });
    expect(result.seenSampleIds.length).toBe(2);
    expect(result.fullScan).toBe(false);
    expect(result.stoppedReason).toBe("maxSamples");
  });

  it("stops early on maxPages and reports fullScan=false", async () => {
    const fetchPage: PageFetcher = async () => page([makeSampleMeta("samples/a")], "more");
    const result = await scanLibrary(fetchPage, memoryKnown({}), {
      pageSize: 1,
      maxPages: 1,
    });
    expect(result.pageCount).toBe(1);
    expect(result.fullScan).toBe(false);
    expect(result.stoppedReason).toBe("maxPages");
  });

  it("treats samples with undefined updateTime as unchanged when known", async () => {
    const s = makeSampleMeta("samples/a", { updateTime: undefined });
    const known = memoryKnown({ "samples/a": "2026-01-01T00:00:00.000Z" });
    const result = await scanLibrary(async () => page([s]), known);
    expect(result.unchangedCount).toBe(1);
    expect(result.changed).toEqual([]);
  });
});
