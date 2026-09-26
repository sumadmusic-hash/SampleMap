import { describe, it, expect, vi } from "vitest";
import type { GlobalPublishOutcome, GlobalPublishResult } from "./contract";
import { mapVersion } from "../map/mapPosition";
import {
  createGlobalProvider,
  offlineProvider,
  readProviderFor,
  workerUrlFromEnv,
} from "./liveProvider";

// ─────────────────────────────────────────────────────────────────────────────
// Step 16I — Live Global Publish Provider Wiring (unit)
//
// Deterministic, offline-safe tests of the provider factory: configuration
// resolution (env var) and the live/offline fallback behavior. Live network is
// exercised separately against the deployed Worker (STEP16I_IMPLEMENTATION).
// ─────────────────────────────────────────────────────────────────────────────

function makeValidPublish(sampleId: string): GlobalPublishResult {
  const features: GlobalPublishResult["features"] = {
    duration: 0.4,
    sampleRate: 44100,
    channels: 2,
    rms: 0.2,
    peak: 0.9,
    transientDensity: 12,
    spectralCentroid: 1200,
    spectralBandwidth: 300,
    spectralRolloff: 5000,
    zeroCrossingRate: 0.02,
    spectralFlatness: 0.05,
    attack: 0.001,
    tonalNoiseRatio: 0.9,
  };
  return {
    sampleId,
    contentIdentity: { contentHash: "f".repeat(64), contentHashVersion: "pcm-v1" },
    analysis: {
      contentIdentity: { contentHash: "f".repeat(64), contentHashVersion: "pcm-v1" },
      classificationVersion: "heuristic-v1",
      primaryClass: "kick",
      confidence: 0.9,
      secondaryClasses: [{ class: "toms", confidence: 0.08 }],
      analysisVersion: "features-v1",
      analysisBuild: "build-16i-test",
      map: { mapVersion, x: 0.5, y: 0.5 },
      similarity: { similarityVersion: "similarity-v1", values: [0.1, 0.2] },
      analysisSourceFormat: "wav",
      gatePassed: true,
      audioFeatures: features,
    },
    features,
  };
}

describe("workerUrlFromEnv", () => {
  it("returns undefined when the env var is absent or empty", () => {
    expect(workerUrlFromEnv({})).toBeUndefined();
    expect(workerUrlFromEnv({ VITE_GLOBAL_WORKER_URL: "" })).toBeUndefined();
    expect(workerUrlFromEnv({ VITE_GLOBAL_WORKER_URL: "   " })).toBeUndefined();
  });

  it("returns the trimmed URL with trailing slashes removed", () => {
    expect(
      workerUrlFromEnv({ VITE_GLOBAL_WORKER_URL: "https://x.workers.dev/" }),
    ).toBe("https://x.workers.dev");
    expect(
      workerUrlFromEnv({ VITE_GLOBAL_WORKER_URL: "  https://x.workers.dev  " }),
    ).toBe("https://x.workers.dev");
  });
});

describe("offlineProvider (16H fallback)", () => {
  it("publishes every item as temporary-unavailable (retryable, not lost)", async () => {
    const provider = offlineProvider();
    const outcome = await provider.publishAnalysisResults([makeValidPublish("samples/a")]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.items[0]).toEqual({
      status: "rejected",
      reason: "temporary-unavailable",
    });
  });

  it("lookups are empty (offline read path)", async () => {
    const provider = offlineProvider();
    expect(await provider.lookupSamples(["samples/a"])).toEqual([]);
    expect(
      await provider.lookupContentIdentities([
        { contentHash: "f".repeat(64), contentHashVersion: "pcm-v1" },
      ]),
    ).toEqual([]);
  });
});

describe("createGlobalProvider", () => {
  it("returns the offline provider when no Worker URL is configured", async () => {
    const provider = await createGlobalProvider({ baseUrl: undefined });
    const outcome = await provider.publishAnalysisResults([makeValidPublish("samples/a")]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.items[0].status).toBe("rejected");
  });

  it("builds a live adapter when a Worker URL is configured", async () => {
    // Inject a mocked fetch so this stays offline-deterministic.
    const calls: { url: string; body: string | undefined }[] = [];
    const fetchImpl = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: init?.body as string | undefined });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{ status: "stored" }],
              accepted: true,
            } satisfies GlobalPublishOutcome),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
    ) as unknown as typeof fetch;

    const provider = await createGlobalProvider({
      baseUrl: "https://samplemap-d1-worker.sumadmusic.workers.dev",
      fetchImpl,
    });

    const outcome = await provider.publishAnalysisResults([makeValidPublish("samples/a")]);
    expect(outcome).toEqual({ items: [{ status: "stored" }], accepted: true });
    expect(calls[0].url).toBe(
      "https://samplemap-d1-worker.sumadmusic.workers.dev/publish",
    );
    // The body is the candidate JSON (metadata only).
    const parsed = JSON.parse(calls[0].body!) as GlobalPublishResult[];
    expect(parsed.length).toBe(1);
    expect(parsed[0].contentIdentity.contentHash).toBe("f".repeat(64));
  });

  it("maps a non-2xx Worker response to a GlobalIndexError", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ kind: "conflict", detail: "x" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;
    const provider = await createGlobalProvider({
      baseUrl: "https://samplemap-d1-worker.sumadmusic.workers.dev",
      fetchImpl,
    });
    await expect(
      provider.publishAnalysisResults([makeValidPublish("samples/a")]),
    ).rejects.toMatchObject({ kind: "conflict" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP58 — Global D1 Browser Read Wiring
//
// The live authenticated entry shares ONE provider instance between the publish
// queue and the map read. These tests pin the wiring decision: with a live
// Worker URL the SAME provider is injected as `globalIndex` and must serve
// `queryMapViewport`; without one the read stays unwired (offline behavior
// unchanged and no fabricated points).
// ─────────────────────────────────────────────────────────────────────────────

describe("readProviderFor (STEP58 read-path wiring)", () => {
  const provider = offlineProvider();

  it("reuses the SAME shared provider as globalIndex when a live Worker URL is configured", () => {
    expect(readProviderFor(provider, true)).toBe(provider);
  });

  it("leaves the read unwired when no live Worker URL is configured (offline preserved)", () => {
    expect(readProviderFor(provider, false)).toBeUndefined();
  });

  it("is safe when the provider could not be resolved", () => {
    expect(readProviderFor(undefined, true)).toBeUndefined();
  });
});

describe("shared live provider serves the browser map read", () => {
  it("queryMapViewport returns global points through the single provider instance", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(
      (input: RequestInfo | URL) => {
        calls.push(String(input));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              mapVersion: "map-v2",
              points: [
                {
                  contentIdentity: {
                    contentHash: "f".repeat(64),
                    contentHashVersion: "pcm-v1",
                  },
                  x: 0.5,
                  y: 0.5,
                  representativeSampleId: "samples/a",
                  primaryClass: "kick",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
    ) as unknown as typeof fetch;

    const provider = await createGlobalProvider({
      baseUrl: "https://samplemap-d1-worker.sumadmusic.workers.dev",
      fetchImpl,
    });

    const viewport = await provider.queryMapViewport({
      mapVersion: "map-v2",
      xMin: 0,
      xMax: 1,
      yMin: 0,
      yMax: 1,
      limit: 500,
    });

    expect(calls[0]).toContain("/map");
    expect(viewport.mapVersion).toBe("map-v2");
    expect(viewport.points).toHaveLength(1);
    expect(viewport.points[0].representativeSampleId).toBe("samples/a");
    expect(readProviderFor(provider, true)).toBe(provider);
  });
});
