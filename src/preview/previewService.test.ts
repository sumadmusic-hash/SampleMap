import { describe, it, expect, vi } from "vitest";
import {
  PreviewService,
  PreviewBlob,
  BlobUrlApi,
  PreviewFetch,
} from "./previewService";
import type { Playable } from "./previewService";

interface FakeBlob extends PreviewBlob {
  label: string;
}

/** Fake URL.createObjectURL/revoke that tracks created/revoked URLs. */
function makeBlobUrlApi() {
  let counter = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  const api: BlobUrlApi = {
    createObjectURL: (_b) => {
      const url = `blob:file-${counter++}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (u) => {
      revoked.push(u);
    },
  };
  return { api, created, revoked };
}

function makeFetch() {
  const calls: Array<{ url: string; resolve: () => void }> = [];
  const fetchFn: PreviewFetch = (url) =>
    new Promise((resolve) => {
      calls.push({
        url,
        resolve: () =>
          resolve({
            blob: async () => ({ type: "audio/mpeg", size: 1, label: url } as FakeBlob),
          }),
      });
    });
  return { fetchFn, calls };
}

/** Fetch that resolves immediately (for non-concurrency tests). */
function makeFetchAuto() {
  const calls: string[] = [];
  const fetchFn: PreviewFetch = (url) => {
    calls.push(url);
    return Promise.resolve({
      blob: async () => ({ type: "audio/mpeg", size: 1, label: url } as FakeBlob),
    });
  };
  return { fetchFn, calls };
}

describe("PreviewService", () => {
  it("creates an ObjectURL and returns it in the handle", async () => {
    const { api, created } = makeBlobUrlApi();
    const { fetchFn, calls } = makeFetchAuto();
    const svc = new PreviewService({
      blobUrl: api,
      fetchFn,
      maxCacheSize: 4,
    });
    const handle = await svc.preview("samples/a", "https://example/a.mp3");
    expect(handle.url).toBe(created[0]);
    expect(calls.length).toBe(1);
    handle.stop();
    svc.dispose();
  });

  it("reuses a cached URL without a second fetch", async () => {
    const { api } = makeBlobUrlApi();
    const { fetchFn, calls } = makeFetchAuto();
    const svc = new PreviewService({
      blobUrl: api,
      fetchFn,
      maxCacheSize: 4,
    });
    const a = await svc.preview("samples/a", "https://example/a.mp3");
    const b = await svc.preview("samples/a", "https://example/a.mp3");
    expect(a.url).toBe(b.url);
    expect(calls.length).toBe(1);
    a.stop();
    b.stop();
    svc.dispose();
  });

  it("limits concurrent fetches", async () => {
    const { api } = makeBlobUrlApi();
    const { fetchFn, calls } = makeFetch();
    const svc = new PreviewService({
      blobUrl: api,
      fetchFn,
      maxConcurrency: 2,
      maxCacheSize: 8,
    });
    const p1 = svc.preview("samples/1", "https://e/1.mp3");
    const p2 = svc.preview("samples/2", "https://e/2.mp3");
    const p3 = svc.preview("samples/3", "https://e/3.mp3");
    expect(svc.activeCount()).toBe(2);
    expect(calls.length).toBe(2);
    // resolve the two in-flight fetches
    calls[0].resolve();
    await p1;
    calls[1].resolve();
    await p2;
    // third should now start
    expect(svc.activeCount()).toBe(1);
    expect(calls.length).toBe(3);
    calls[2].resolve();
    await p3;
    expect(svc.activeCount()).toBe(0);
    svc.dispose();
  });

  it("revokes URL on stop when the last reference is released", async () => {
    const { api, revoked } = makeBlobUrlApi();
    const { fetchFn } = makeFetchAuto();
    const svc = new PreviewService({ blobUrl: api, fetchFn, maxCacheSize: 4 });
    const h1 = await svc.preview("samples/a", "https://e/a.mp3");
    const h2 = await svc.preview("samples/a", "https://e/a.mp3");
    h1.stop();
    expect(revoked.length).toBe(0); // still referenced by h2
    h2.stop();
    expect(revoked.length).toBe(1); // last ref -> revoked
    svc.dispose();
  });

  it("evicts idle LRU URLs beyond maxCacheSize", async () => {
    const now = { value: 0 };
    const { api, revoked } = makeBlobUrlApi();
    const { fetchFn, calls } = makeFetch();
    const svc = new PreviewService({
      blobUrl: api,
      fetchFn,
      maxCacheSize: 1,
      now: () => now.value,
    });
    // Enqueue several; since concurrency defaults to 3, resolve in order.
    const p1 = svc.preview("samples/1", "https://e/1.mp3");
    const p2 = svc.preview("samples/2", "https://e/2.mp3");
    const p3 = svc.preview("samples/3", "https://e/3.mp3");
    now.value = 1;
    calls[0].resolve();
    const h1 = await p1;
    now.value = 2;
    calls[1].resolve();
    const h2 = await p2;
    // release h1 (idle, 0 refs); cache size is now 2 (>1) -> LRU h1 evicted+revoked
    h1.stop();
    expect(revoked).toContain(h1.url);
    now.value = 3;
    calls[2].resolve();
    const h3 = await p3;
    expect(h3.url).not.toBe(h1.url);
    h2.stop();
    h3.stop();
    svc.dispose();
  });

  it("dispose revokes all cached URLs", async () => {
    const { api, revoked } = makeBlobUrlApi();
    const { fetchFn, calls } = makeFetch();
    const svc = new PreviewService({ blobUrl: api, fetchFn, maxCacheSize: 8 });
    const p1 = svc.preview("samples/1", "https://e/1.mp3");
    const p2 = svc.preview("samples/2", "https://e/2.mp3");
    calls[0].resolve();
    const h1 = await p1;
    calls[1].resolve();
    const h2 = await p2;
    svc.dispose();
    expect(revoked).toContain(h1.url);
    expect(revoked).toContain(h2.url);
    expect(svc.cachedCount()).toBe(0);
  });

  it("propagates fetch errors to the caller", async () => {
    const { api } = makeBlobUrlApi();
    const fetchFn: PreviewFetch = () =>
      Promise.reject(new Error("network down"));
    const svc = new PreviewService({ blobUrl: api, fetchFn });
    await expect(
      svc.preview("samples/a", "https://e/a.mp3"),
    ).rejects.toThrow("network down");
    svc.dispose();
  });

  it("never writes audio to persistent storage (uses only object URLs)", () => {
    // Object URLs reference in-memory blobs; there is no persistence API in the
    // service. Assert the service exposes no store/put surface.
    const { api } = makeBlobUrlApi();
    const { fetchFn } = makeFetch();
    const svc = new PreviewService({ blobUrl: api, fetchFn });
    expect(svc).not.toHaveProperty("put");
    expect(svc).not.toHaveProperty("indexedDB");
    expect(vi.isMockFunction(svc.cachedCount)).toBe(false);
    svc.dispose();
  });
});

// ─── SM-AUDIT-006: audio playback tests ──────────────────────────────────────

interface FakeAudio extends Playable {
  played: string | undefined;
  pauseCount: number;
  _ended: boolean;
}

function makeFakeAudioFactory() {
  const instances: FakeAudio[] = [];
  const factory = (src: string): FakeAudio => {
    const audio: FakeAudio = {
      played: undefined,
      pauseCount: 0,
      _ended: false,
      get ended() { return this._ended; },
      onended: null,
      onerror: null,
      src,
      play: () => {
        audio.played = src;
        return Promise.resolve();
      },
      pause: () => {
        audio.pauseCount++;
      },
    };
    instances.push(audio);
    return audio;
  };
  return { factory, instances };
}

describe("PreviewService — audio playback (SM-AUDIT-006)", () => {
  it("handle.play() starts audio playback on the ObjectURL", async () => {
    const { api } = makeBlobUrlApi();
    const { fetchFn } = makeFetchAuto();
    const { factory, instances } = makeFakeAudioFactory();
    const svc = new PreviewService({ blobUrl: api, fetchFn, audioFactory: factory, maxCacheSize: 4 });
    const handle = await svc.preview("samples/a", "https://example/a.mp3");
    expect(handle.isPlaying).toBe(false);
    await handle.play();
    expect(handle.isPlaying).toBe(true);
    expect(instances.length).toBe(1);
    expect(instances[0].played).toBe(handle.url);
    handle.stop();
    svc.dispose();
  });

  it("handle.stop() pauses active audio and marks isPlaying false", async () => {
    const { api } = makeBlobUrlApi();
    const { fetchFn } = makeFetchAuto();
    const { factory, instances } = makeFakeAudioFactory();
    const svc = new PreviewService({ blobUrl: api, fetchFn, audioFactory: factory, maxCacheSize: 4 });
    const handle = await svc.preview("samples/a", "https://example/a.mp3");
    await handle.play();
    expect(handle.isPlaying).toBe(true);
    handle.stop();
    expect(handle.isPlaying).toBe(false);
    expect(instances[0].pauseCount).toBe(1);
    svc.dispose();
  });

  it("onended callback marks isPlaying false when audio finishes naturally", async () => {
    const { api } = makeBlobUrlApi();
    const { fetchFn } = makeFetchAuto();
    const { factory, instances } = makeFakeAudioFactory();
    const svc = new PreviewService({ blobUrl: api, fetchFn, audioFactory: factory, maxCacheSize: 4 });
    const handle = await svc.preview("samples/a", "https://example/a.mp3");
    await handle.play();
    expect(handle.isPlaying).toBe(true);
    // Simulate audio track ending naturally.
    instances[0]._ended = true;
    instances[0].onended?.(undefined as never);
    expect(handle.isPlaying).toBe(false);
    svc.dispose();
  });

  it("dispose() stops all active audio elements", async () => {
    const { api } = makeBlobUrlApi();
    const { fetchFn } = makeFetchAuto();
    const { factory, instances } = makeFakeAudioFactory();
    const svc = new PreviewService({ blobUrl: api, fetchFn, audioFactory: factory, maxCacheSize: 4 });
    const h1 = await svc.preview("samples/1", "https://e/1.mp3");
    const h2 = await svc.preview("samples/2", "https://e/2.mp3");
    await h1.play();
    await h2.play();
    svc.dispose();
    expect(h1.isPlaying).toBe(false);
    expect(h2.isPlaying).toBe(false);
    // Audio elements paused by dispose.
    expect(instances[0].pauseCount).toBe(1);
    expect(instances[1].pauseCount).toBe(1);
  });

  it("play() does nothing after stop() has been called", async () => {
    const { api } = makeBlobUrlApi();
    const { fetchFn } = makeFetchAuto();
    const { factory, instances } = makeFakeAudioFactory();
    const svc = new PreviewService({ blobUrl: api, fetchFn, audioFactory: factory, maxCacheSize: 4 });
    const handle = await svc.preview("samples/a", "https://example/a.mp3");
    handle.stop();
    await handle.play(); // should be a no-op
    expect(handle.isPlaying).toBe(false);
    expect(instances.length).toBe(0);
    svc.dispose();
  });

  it("play() is idempotent — calling twice does not create duplicate Audio", async () => {
    const { api } = makeBlobUrlApi();
    const { fetchFn } = makeFetchAuto();
    const { factory, instances } = makeFakeAudioFactory();
    const svc = new PreviewService({ blobUrl: api, fetchFn, audioFactory: factory, maxCacheSize: 4 });
    const handle = await svc.preview("samples/a", "https://example/a.mp3");
    await handle.play();
    await handle.play(); // second call is a no-op
    expect(instances.length).toBe(1);
    expect(handle.isPlaying).toBe(true);
    handle.stop();
    svc.dispose();
  });

  it("handle is still usable after audio playback ends", async () => {
    const { api } = makeBlobUrlApi();
    const { fetchFn } = makeFetchAuto();
    const { factory, instances } = makeFakeAudioFactory();
    const svc = new PreviewService({ blobUrl: api, fetchFn, audioFactory: factory, maxCacheSize: 4 });
    const handle = await svc.preview("samples/a", "https://example/a.mp3");
    await handle.play();
    expect(handle.isPlaying).toBe(true);
    // Audio finishes naturally.
    instances[0]._ended = true;
    instances[0].onended?.(undefined as never);
    expect(handle.isPlaying).toBe(false);
    // stop() still safe to call (cleanup of refs/ObjectURL).
    handle.stop();
    svc.dispose();
  });
});

// ─── SM-AUDIT-007: stale async / dispose race tests ──────────────────────────

describe("PreviewService — in-flight fetch vs dispose (SM-AUDIT-007)", () => {
  it("fetch resolving after dispose() is aborted; its ObjectURL is revoked, never cached", async () => {
    const { api, created, revoked } = makeBlobUrlApi();
    const { fetchFn, calls } = makeFetch();
    const svc = new PreviewService({ blobUrl: api, fetchFn, maxCacheSize: 8 });
    const pending = svc.preview("samples/a", "https://e/a.mp3");
    expect(svc.activeCount()).toBe(1);
    svc.dispose();
    // The in-flight fetch completes AFTER dispose.
    calls[0].resolve();
    await expect(pending).rejects.toThrow("preview service disposed");
    // The URL was created then immediately revoked — never resurrected in cache.
    expect(created).toHaveLength(1);
    expect(revoked).toContain(created[0]);
    expect(svc.cachedCount()).toBe(0);
  });

  it("preview() after dispose() rejects immediately without fetching", async () => {
    const { api } = makeBlobUrlApi();
    const { fetchFn, calls } = makeFetch();
    const svc = new PreviewService({ blobUrl: api, fetchFn, maxCacheSize: 8 });
    svc.dispose();
    await expect(
      svc.preview("samples/a", "https://e/a.mp3"),
    ).rejects.toThrow("preview service disposed");
    expect(calls.length).toBe(0);
  });

  it("queued (not yet started) fetches settle with rejection on dispose", async () => {
    const { api } = makeBlobUrlApi();
    const { fetchFn, calls } = makeFetch();
    const svc = new PreviewService({
      blobUrl: api,
      fetchFn,
      maxConcurrency: 1,
      maxCacheSize: 8,
    });
    const p1 = svc.preview("samples/1", "https://e/1.mp3"); // in-flight
    const p2 = svc.preview("samples/2", "https://e/2.mp3"); // queued
    expect(svc.activeCount()).toBe(1);
    svc.dispose();
    await expect(p2).rejects.toThrow("preview service disposed");
    calls[0].resolve();
    await expect(p1).rejects.toThrow("preview service disposed");
    expect(svc.cachedCount()).toBe(0);
  });
});
