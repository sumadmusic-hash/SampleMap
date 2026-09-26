import { describe, it, expect, vi, afterEach } from "vitest";
import type { SampleMeta } from "@audiotool/nexus/api";
import { SampleMapApp } from "./app";
import type { SampleMapAppDeps } from "./app";
import { createMemoryEp7ConsentStore } from "./ep7Consent";
import type { SampleIndexRecord } from "../persistence/indexStore";
import { assertNoAudioBytes } from "../persistence/indexStore";
import { openTestDatabase, makeSample } from "../persistence/test-helpers";
import type { DatabaseHandle } from "../persistence/db";
import { SampleMapSearchEngine } from "../search/searchEngine";
import type { SearchResult } from "../search/searchEngine";
import { PreviewService } from "../preview/previewService";
import type { BlobUrlApi } from "../preview/previewService";
import { SampleMapMachinisteService } from "../machiniste/machinisteService";
import type { JobRunner, AnalysisBudget } from "../pipeline/jobRunner";

const BUILD = "build-v1";
const META: SampleMeta = {
  name: "samples/a",
  displayName: "Kick A",
  description: "",
  ownerName: "users/alice",
  favoritedByUser: false,
  numFavorites: 0,
  numUsages: 0,
  bpm: 0,
  kind: "one-shot",
  visibility: "public",
  tags: ["kick"],
  createTime: undefined,
  updateTime: undefined,
  durationSeconds: 1,
  mp3Url: "https://cdn/a.mp3",
  wavUrl: "https://cdn/a.wav",
  flacUrl: "https://cdn/a.flac",
  previewMp3Url: "https://cdn/a-preview.mp3",
  getWaveformUrl: () => "https://cdn/a.wave",
};

const META_B: SampleMeta = { ...META, name: "samples/b", previewMp3Url: "https://cdn/b-preview.mp3" };

const openHandles: DatabaseHandle[] = [];
function openDb(): Promise<DatabaseHandle> {
  return openTestDatabase().then((h) => {
    openHandles.push(h);
    return h;
  });
}
afterEach(async () => {
  const handles = openHandles.splice(0);
  await Promise.all(handles.map((h) => h.db.close().catch(() => {})));
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

interface PreviewFake {
  service: PreviewService;
  calls: string[];
}

function makeFakePreview(): PreviewFake {
  const calls: string[] = [];
  const api: BlobUrlApi = {
    createObjectURL: () => `blob:fake-p${calls.length}`,
    revokeObjectURL: () => {},
  };
  const service = new PreviewService({
    blobUrl: api,
    fetchFn: async (url) => {
      calls.push(url);
      return { blob: async () => ({ type: "audio/mpeg", size: 1 } as Blob) };
    },
    audioFactory: () => ({
      play: () => Promise.resolve(),
      pause: () => {},
      ended: false,
      onended: null,
      onerror: null,
      src: "",
    }),
  });
  return { service, calls };
}

interface ResolveOptions {
  resolveSampleImpl?: (
    id: string,
    cache: Map<string, SampleMeta>,
  ) => Promise<SampleMeta | undefined>;
}

interface Rig {
  app: SampleMapApp;
  preview: PreviewFake;
  metaCache: Map<string, SampleMeta>;
  resolveSample: ReturnType<typeof vi.fn>;
  index: import("../persistence/indexStore").IndexStore;
}

/** Bootstrap-like wiring: resolveSample caches the resolved meta; previewUrlFor reads that cache. */
async function mk(over: Partial<SampleMapAppDeps> = {}, opts: ResolveOptions = {}): Promise<Rig> {
  const handle = await openDb();
  const metaCache = new Map<string, SampleMeta>();
  const resolveSample = vi.fn(async (id: string): Promise<SampleMeta | undefined> => {
    if (opts.resolveSampleImpl) return opts.resolveSampleImpl(id, metaCache);
    await flush();
    const store: Record<string, SampleMeta> = { "samples/a": META, "samples/b": META_B };
    const meta = store[id];
    if (meta) metaCache.set(id, meta);
    return meta;
  });
  const preview = makeFakePreview();
  const previewUrlFor = (r: SampleIndexRecord): string | undefined =>
    metaCache.get(r.sampleId)?.previewMp3Url;
  const searchEngine = { search: vi.fn(async (): Promise<SearchResult[]> => []) } as unknown as SampleMapSearchEngine;
  const machiniste = { send: vi.fn() } as unknown as SampleMapMachinisteService;
  const ep7Consent = createMemoryEp7ConsentStore();
  ep7Consent.grant();
  const deps: SampleMapAppDeps = {
    queue: handle.queue as never,
    index: handle.index as never,
    search: searchEngine,
    preview: preview.service,
    machiniste,
    createRunner: ((_b: AnalysisBudget) => ({}) as unknown as JobRunner),
    fetchPage: async () => ({ samples: [META], nextPageToken: "" }),
    known: { getUpdatedAt: async () => undefined },
    previewUrlFor,
    resolveSample,
    analysisBuild: BUILD,
    ep7Consent,
    ...over,
  };
  const app = new SampleMapApp(deps);
  return { app, preview, metaCache, resolveSample, index: handle.index };
}

describe("STEP36 — lazy preview metadata resolution", () => {
  it("uses the runtime cache directly when metadata already exists (no re-resolution)", async () => {
    const r = await mk();
    const rec = makeSample("samples/a");
    r.metaCache.set("samples/a", META);
    await r.app.togglePreview(rec);
    expect(r.preview.calls).toContain(META.previewMp3Url);
    expect(r.app.previewSampleId).toBe("samples/a");
    expect(r.resolveSample).not.toHaveBeenCalled();
  });

  it("resolves metadata on demand via client.samples.get when the cache is empty", async () => {
    const r = await mk();
    const rec = makeSample("samples/a");
    await r.app.togglePreview(rec);
    expect(r.resolveSample).toHaveBeenCalledWith("samples/a");
    expect(r.metaCache.has("samples/a")).toBe(true);
    expect(r.preview.calls).toContain(META.previewMp3Url);
    expect(r.app.previewSampleId).toBe("samples/a");
    expect(r.app.previewError).toBeUndefined();
  });

  it("resolves after a reload-equivalent empty runtime state (Case B)", async () => {
    const r1 = await mk();
    await r1.app.togglePreview(makeSample("samples/a"));
    await r1.app.revokeCurrentPreview();
    const r2 = await mk();
    await r2.app.togglePreview(makeSample("samples/b"));
    expect(r2.resolveSample).toHaveBeenCalledWith("samples/b");
    expect(r2.preview.calls).toContain(META_B.previewMp3Url);
  });

  it("shows an honest unavailable state when the sample has no preview URL (Case D)", async () => {
    const noUrl: SampleMeta = { ...META, previewMp3Url: "" };
    const r = await mk({}, {
      resolveSampleImpl: async (id, cache) => {
        cache.set(id, noUrl);
        return noUrl;
      },
    });
    await r.app.togglePreview(makeSample("samples/a"));
    expect(r.app.previewError).toBe("no preview url available");
    expect(r.app.previewSampleId).toBeUndefined();
    expect(r.preview.calls).toEqual([]);
  });

  it("produces a controlled error state when the metadata request fails (Case E)", async () => {
    const r = await mk({}, {
      resolveSampleImpl: async () => {
        throw new Error("network down");
      },
    });
    await r.app.togglePreview(makeSample("samples/a"));
    expect(r.app.previewError).toBe("preview metadata unavailable");
    expect(r.app.previewSampleId).toBeUndefined();
    expect(r.preview.calls).toEqual([]);
  });

  it("never persists the preview URL source or any audio payload into IndexedDB", async () => {
    const r = await mk();
    const rec = makeSample("samples/a");
    await r.index.put(rec);
    await r.app.togglePreview(rec);
    expect(r.preview.calls).toContain(META.previewMp3Url);
    const stored = await r.index.getAll();
    expect(stored.length).toBe(1);
    expect(stored[0].sampleId).toBe("samples/a");
    expect(() => assertNoAudioBytes(stored)).not.toThrow();
  });

  it("avoids uncontrolled duplicate metadata requests on repeated previews", async () => {
    const r = await mk();
    const rec = makeSample("samples/a");
    await r.app.togglePreview(rec);
    r.app.revokeCurrentPreview();
    await r.app.togglePreview(rec);
    // First resolves metadata into the runtime cache; the second reuses it.
    expect(r.resolveSample).toHaveBeenCalledTimes(1);
    expect(r.preview.calls.filter((u) => u === META.previewMp3Url).length).toBe(2);
  });

  it("discards a stale async resolution so it cannot preview the wrong sample", async () => {
    const resolvers = new Map<string, (m: SampleMeta | undefined) => void>();
    const r = await mk({}, {
      resolveSampleImpl: (id, cache) =>
        new Promise<SampleMeta | undefined>((res) => {
          resolvers.set(id, (m) => {
            if (m) cache.set(id, m);
            res(m);
          });
        }),
    });
    const recA = makeSample("samples/a");
    const recB = makeSample("samples/b");
    const pA = r.app.togglePreview(recA); // metadata pending for A
    const pB = r.app.togglePreview(recB); // user moved on → A's epoch is stale
    resolvers.get("samples/a")!(META); // A resolves AFTER the user moved on
    await flush();
    resolvers.get("samples/b")!(META_B); // B resolves normally
    await Promise.all([pA, pB]);
    // Only B was fetched; A's stale resolution was discarded.
    expect(r.preview.calls).toEqual([META_B.previewMp3Url]);
    expect(r.app.previewSampleId).toBe("samples/b");
    expect(r.app.previewError).toBeUndefined();
  });
});