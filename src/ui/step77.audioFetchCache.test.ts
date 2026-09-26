import { afterEach, describe, expect, it, vi } from "vitest";

import { browserFetchAudio } from "./bootstrap";
import type { SampleMeta } from "@audiotool/nexus/api";

/**
 * STEP77 regression: the analysis audio fetch must opt out of the browser HTTP
 * disk cache. The Audiotool CDN serves the lossless sample URLs with
 * `Cache-Control: public, max-age=86400`, so a plain `fetch(url)` persists every
 * sample's full audio in `Default/Cache/Cache_Data` (measured: 172 samples ->
 * +483 MB during analysis, 563 MB after browser close).
 *
 * The audio is only needed transiently in RAM; analysis results are persisted in
 * IndexedDB. So the fetch must carry `cache: "no-store"`.
 */

const WAV_URL = "https://cdn.audiotool.com/samples/0001a13b-074e-5245-a443-1e19971190bd/s.wav";

function makeSample(): SampleMeta {
  return { sampleId: "samples/0001a13b-074e-5245-a443-1e19971190bd", name: "test" } as unknown as
    SampleMeta;
}

/** Minimal stand-in for the subset of `Response` that browserFetchAudio uses. */
function okResponse(bytes: ArrayBuffer) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("STEP77 — analysis audio fetch must not populate the HTTP disk cache", () => {
  it("requests the lossless URL with cache: 'no-store'", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      okResponse(new ArrayBuffer(8)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await browserFetchAudio(makeSample(), { url: WAV_URL, format: "wav" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // exact call signature: the URL plus the no-store cache directive
    expect(fetchMock).toHaveBeenCalledWith(WAV_URL, { cache: "no-store" });
  });

  it("passes no other cache mode (guard against force-cache / no-cache / default)", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      okResponse(new ArrayBuffer(8)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await browserFetchAudio(makeSample(), { url: WAV_URL, format: "wav" });

    const opts = fetchMock.mock.calls[0]?.[1];
    expect(opts).toBeDefined();
    expect(opts?.cache).toBe("no-store");
    expect(opts?.cache).not.toBe("force-cache");
    expect(opts?.cache).not.toBe("no-cache");
    expect(opts?.cache).not.toBe("reload");
    // nothing else may smuggle in persistence
    expect(Object.keys(opts ?? {}).sort()).toEqual(["cache"]);
  });

  it("applies no-store to every format variant the analyser may select", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      okResponse(new ArrayBuffer(8)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sample = makeSample();
    for (const format of ["wav", "flac"] as const) {
      await browserFetchAudio(sample, { url: `${WAV_URL.replace(/\.wav$/, `.${format}`)}`, format });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.cache).toBe("no-store");
    }
  });

  it("keeps the bytes transient: returns them in RAM and release() is a no-op", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]).buffer;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => okResponse(payload)),
    );

    const fetched = await browserFetchAudio(makeSample(), { url: WAV_URL, format: "wav" });

    expect(fetched.bytes.byteLength).toBe(4);
    expect(new Uint8Array(fetched.bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
    // release must stay a no-op and idempotent — no Blob/URL persistence
    expect(() => {
      fetched.release();
      fetched.release();
    }).not.toThrow();
  });

  it("preserves the existing non-ok error behaviour", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );

    await expect(browserFetchAudio(makeSample(), { url: WAV_URL, format: "wav" })).rejects.toThrow(
      /fetch failed: 404/,
    );
  });
});
