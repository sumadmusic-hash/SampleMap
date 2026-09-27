import { afterEach, describe, expect, it, vi } from "vitest";

import { browserFetchAudio, AUDIO_FETCH_TIMEOUT_MS } from "./bootstrap";
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
    // exact call signature: the URL plus the no-store cache directive and the
    // abort signal. The signal is a pure liveness guard — it carries no cache
    // semantics — so the STEP77 no-store policy is unchanged.
    expect(fetchMock).toHaveBeenCalledWith(WAV_URL, {
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
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
    // nothing beyond the no-store directive and the abort signal may smuggle
    // in persistence
    expect(Object.keys(opts ?? {}).sort()).toEqual(["cache", "signal"]);
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

/**
 * The analysis JobRunner is strictly serial, so a single hung CDN request
 * stalls every remaining sample. The fetch must therefore be bounded by
 * `AUDIO_FETCH_TIMEOUT_MS`, and the abort must surface as an ordinary fetch
 * error so the analysis pipeline maps the job to `failed` and the existing
 * retry/backoff logic takes over.
 *
 * Fully deterministic: vitest fake timers drive the 30 s deadline, no real wait.
 */
describe("analysis audio fetch timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A fetch that only settles when its signal aborts — i.e. a connection that
   * returns headers but never finishes the body.
   */
  function hangingFetch() {
    return vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("This operation was aborted.", "AbortError"));
          });
        }),
    );
  }

  it("pins the production deadline to exactly 30 s", () => {
    // Guards the contract itself: the tests above drive the exported constant,
    // so a silent change of the value would otherwise go unnoticed.
    expect(AUDIO_FETCH_TIMEOUT_MS).toBe(30_000);
  });

  it("hands fetch an AbortSignal that stays un-aborted on success", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      okResponse(new ArrayBuffer(8)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await browserFetchAudio(makeSample(), { url: WAV_URL, format: "wav" });

    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("aborts the request only once the 30 s deadline elapses", async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const pending = browserFetchAudio(makeSample(), { url: WAV_URL, format: "wav" });
    const assertion = expect(pending).rejects.toThrow(/abort/i);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    // one millisecond short of the deadline: still in flight
    await vi.advanceTimersByTimeAsync(AUDIO_FETCH_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await assertion;
  });

  it("rejects with a plain fetch error, not a bespoke timeout error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());

    // The analysis pipeline catches any throw and maps it to status "failed";
    // a regular rejection is all it needs — no new error type, no new branch.
    const pending = browserFetchAudio(makeSample(), { url: WAV_URL, format: "wav" });
    const assertion = expect(pending).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(AUDIO_FETCH_TIMEOUT_MS);
    await assertion;
  });

  it("clears the timer after a successful fetch", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        okResponse(new ArrayBuffer(8)),
      ),
    );

    await browserFetchAudio(makeSample(), { url: WAV_URL, format: "wav" });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer after a non-2xx response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );

    await expect(
      browserFetchAudio(makeSample(), { url: WAV_URL, format: "wav" }),
    ).rejects.toThrow(/fetch failed: 404/);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer after a transport error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
        throw new Error("network down");
      }),
    );

    await expect(
      browserFetchAudio(makeSample(), { url: WAV_URL, format: "wav" }),
    ).rejects.toThrow(/network down/);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer after the request was aborted by the deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());

    const pending = browserFetchAudio(makeSample(), { url: WAV_URL, format: "wav" });
    const assertion = expect(pending).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(AUDIO_FETCH_TIMEOUT_MS);
    await assertion;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the STEP77 no-store policy on the timeout path too", async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const pending = browserFetchAudio(makeSample(), { url: WAV_URL, format: "wav" });
    const assertion = expect(pending).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(AUDIO_FETCH_TIMEOUT_MS);
    await assertion;

    const opts = fetchMock.mock.calls[0]?.[1];
    expect(opts?.cache).toBe("no-store");
    expect(Object.keys(opts ?? {}).sort()).toEqual(["cache", "signal"]);
  });
});
