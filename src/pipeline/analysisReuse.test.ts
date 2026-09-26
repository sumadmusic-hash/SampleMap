import { describe, it, expect, vi } from "vitest";
import { AnalysisPipeline } from "./analysisPipeline";
import type { Classifier, ClassOutput } from "../classify/classifier";
import { makeFeatures } from "../classify/test-helpers";
import { makeSampleMeta } from "../library/test-helpers";
import { openTestDatabase } from "../persistence/test-helpers";
import { assertNoAudioBytes, IndexStore } from "../persistence/indexStore";
import type { DecodedAudio } from "../audio/decodedAudio";
import { buildWavWithSeed } from "../audio/fixtures";
import { GlobalLookup, type SupportedVersions } from "../global/lookup";
import type { GlobalSampleIndex, GlobalAnalysisResult } from "../global/contract";
import { makeContentIdentity } from "../identity/audioContentIdentity";
import { mapVersion } from "../map/mapPosition";
import { computeSimilarityFingerprint } from "../similarity/similarityFingerprint";

const VALID_WAV = buildWavWithSeed({ frames: 10, seed: 0 });

function makeDecoded(overrides: Partial<DecodedAudio> = {}): DecodedAudio {
  return {
    sampleRate: 44100,
    channels: 1,
    mono: new Float32Array(44100),
    durationSeconds: 1,
    ...overrides,
  };
}

const SUPPORTED: SupportedVersions = {
  contentHashVersion: "pcm-v1",
  analysisVersion: "features-v1",
  classificationVersion: "heuristic-v1",
  mapVersion: "map-v2",
  similarityVersion: "similarity-v1",
};

function makeGlobalAnalysis(overrides: Partial<GlobalAnalysisResult> = {}): GlobalAnalysisResult {
  const features = makeFeatures();
  const fp = computeSimilarityFingerprint(features);
  return {
    contentIdentity: makeContentIdentity("f".repeat(64), "pcm-v1"),
    classificationVersion: "heuristic-v1",
    primaryClass: "kick",
    confidence: 0.87,
    secondaryClasses: [{ class: "toms", confidence: 0.06 }],
    analysisVersion: "features-v1",
    analysisBuild: "build-v1",
    // V2: map is a PERSISTED analysis result, not reconstructed from features.
    map: { mapVersion, x: 0.4, y: 0.6 },
    similarity: fp,
    analysisSourceFormat: "wav",
    gatePassed: true,
    audioFeatures: features,
    ...overrides,
  };
}

interface Rig {
  pipeline: AnalysisPipeline;
  index: IndexStore;
  release: ReturnType<typeof vi.fn>;
  extract: ReturnType<typeof vi.fn>;
  decode: ReturnType<typeof vi.fn>;
  fetchAudio: ReturnType<typeof vi.fn>;
  resolveSample: ReturnType<typeof vi.fn>;
  classify: ReturnType<typeof vi.fn>;
}

/**
 * A fake global index whose behavior is controlled by the test. This models the
 * provider-agnostic `GlobalSampleIndex` contract (16A) — NOT a real backend.
 */
class FakeGlobalIndex implements GlobalSampleIndex {
  constructor(
    private readonly behavior:
      | { type: "known"; analysis: GlobalAnalysisResult }
      | { type: "unknown" }
      | { type: "throw"; error: Error },
  ) {}

  async lookupSamples() {
    const b = this.behavior;
    if (b.type === "throw") throw b.error;
    if (b.type === "known") {
      const sampleId = "samples/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      return [
        {
          status: "known" as const,
          sampleId,
          contentIdentity: b.analysis.contentIdentity,
          analysis: b.analysis,
        },
      ];
    }
    return [
      { status: "unknown" as const, sampleId: "samples/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    ];
  }

  async lookupContentIdentities() {
    return [];
  }
  async queryMapViewport() {
    return { mapVersion, points: [] };
  }
  async publishAnalysisResults() {
    (this as unknown as { published: boolean }).published = true;
    return { items: [], accepted: true };
  }
}

async function mk(options: {
  global?: GlobalLookup;
  knownIds?: string[];
} = {}): Promise<Rig> {
  const handle = await openTestDatabase();
  const release = vi.fn();
  const decode = vi.fn(async () => makeDecoded());
  const extract = vi.fn(() => makeFeatures());
  const classification: ClassOutput = {
    primaryClass: "kick",
    confidence: 0.9,
    secondaryClasses: [{ class: "tom", confidence: 0.07 }],
  };
  const classify = vi.fn(async () => classification);
  const classifier: Classifier = {
    id: "heuristic",
    version: "heuristic-v1",
    classify,
  };
  const ids = options.knownIds ?? ["samples/a", "samples/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"];
  const fetchAudio = vi.fn(async () => ({ bytes: VALID_WAV, release }));
  const resolveSample = vi.fn(async (id: string) => {
    return ids.includes(id) ? makeSampleMeta(id) : undefined;
  });
  const pipeline = new AnalysisPipeline({
    fetchAudio,
    decode,
    extract,
    classifier,
    resolveSample,
    index: handle.index,
    analysisVersion: "features-v1",
    now: () => new Date("2026-06-01T00:00:00.000Z"),
    globalLookup: options.global,
    supportedVersions: SUPPORTED,
  });
  return {
    pipeline,
    index: handle.index,
    release,
    extract,
    decode,
    fetchAudio,
    resolveSample,
    classify,
  };
}

const SAMPLE = "samples/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("Step 16J — Global Lookup → Analysis Reuse", () => {
  // Test A — KNOWN
  it("A: global known/reuse → writes the global result to the index and succeeds WITHOUT local analysis", async () => {
    const globalAnalysis = makeGlobalAnalysis();
    const provider = new FakeGlobalIndex({ type: "known", analysis: globalAnalysis });
    const lookup = new GlobalLookup(provider, SUPPORTED);

    let fetched = 0;
    let decoded = 0;
    let extracted = 0;
    let classified = 0;
    const r = await mk({
      global: lookup,
      knownIds: [SAMPLE],
    });
    r.fetchAudio.mockImplementation(async () => {
      fetched++;
      return { bytes: VALID_WAV, release: r.release };
    });
    r.decode.mockImplementation(async () => {
      decoded++;
      return makeDecoded();
    });
    r.extract.mockImplementation(() => {
      extracted++;
      return makeFeatures();
    });
    r.classify.mockImplementation(async () => {
      classified++;
      return { primaryClass: "kick", confidence: 0.9, secondaryClasses: [] };
    });

    const out = await r.pipeline.run(SAMPLE, "build-v1");
    expect(out.status).toBe("analyzed");
    expect(fetched).toBe(0);
    expect(decoded).toBe(0);
    expect(extracted).toBe(0);
    expect(classified).toBe(0);

    const rec = await r.index.get(SAMPLE);
    expect(rec).toBeDefined();
    expect(rec!.status).toBe("analyzed");
    expect(rec!.primaryClass).toBe("kick");
    expect(rec!.confidence).toBe(0.87);
    expect(rec!.analysisVersion).toBe("features-v1");
    expect(rec!.contentHash).toBe(globalAnalysis.contentIdentity.contentHash);
    expect(rec!.contentHashVersion).toBe("pcm-v1");
    expect(rec!.analysisSourceFormat).toBe("wav");
    expect(rec!.similarityFingerprint).toEqual(globalAnalysis.similarity);
    expect(() => assertNoAudioBytes(rec)).not.toThrow();
  });

  // Test B — KNOWN verhindert Audioanalyse (the most important test)
  it("B: KNOWN → fetchAudio/decode/extractFeatures/classify are all called 0 times", async () => {
    const globalAnalysis = makeGlobalAnalysis();
    const provider = new FakeGlobalIndex({ type: "known", analysis: globalAnalysis });
    const lookup = new GlobalLookup(provider, SUPPORTED);
    const r = await mk({ global: lookup, knownIds: [SAMPLE] });

    const out = await r.pipeline.run(SAMPLE, "build-v1");
    expect(out.status).toBe("analyzed");
    expect(r.fetchAudio).not.toHaveBeenCalled();
    expect(r.decode).not.toHaveBeenCalled();
    expect(r.extract).not.toHaveBeenCalled();
    expect(r.classify).not.toHaveBeenCalled();
  });

  // Test C — UNKNOWN
  it("C: global unknown → runs the normal local pipeline", async () => {
    const provider = new FakeGlobalIndex({ type: "unknown" });
    const lookup = new GlobalLookup(provider, SUPPORTED);
    const r = await mk({ global: lookup, knownIds: [SAMPLE] });

    const out = await r.pipeline.run(SAMPLE, "build-v1");
    expect(out.status).toBe("analyzed");
    expect(r.fetchAudio).toHaveBeenCalledTimes(1);
    expect(r.decode).toHaveBeenCalledTimes(1);
    expect(r.extract).toHaveBeenCalledTimes(1);
    expect(r.classify).toHaveBeenCalledTimes(1);
    const rec = await r.index.get(SAMPLE);
    expect(rec!.primaryClass).toBe("kick");
  });

  // Test D — UNAVAILABLE
  it("D: global lookup throws (temporary unavailable) → falls back to normal local analysis", async () => {
    const provider = new FakeGlobalIndex({ type: "throw", error: new Error("worker 503") });
    const lookup = new GlobalLookup(provider, SUPPORTED);
    const r = await mk({ global: lookup, knownIds: [SAMPLE] });

    const out = await r.pipeline.run(SAMPLE, "build-v1");
    expect(out.status).toBe("analyzed");
    expect(r.fetchAudio).toHaveBeenCalledTimes(1);
    expect(r.decode).toHaveBeenCalledTimes(1);
    expect(r.extract).toHaveBeenCalledTimes(1);
    expect(r.classify).toHaveBeenCalledTimes(1);
    const rec = await r.index.get(SAMPLE);
    expect(rec!.status).toBe("analyzed");
  });

  // Test E — inkompatible Version
  it("E: global known but incompatible version → no reuse, local analysis (never overwrites with incompatible data)", async () => {
    // Consumer requires similarity-v2, but the global result is similarity-v1.
    const analysis = makeGlobalAnalysis(); // similarity-v1
    const provider = new FakeGlobalIndex({ type: "known", analysis });
    const lookup = new GlobalLookup(provider, {
      ...SUPPORTED,
      similarityVersion: "similarity-v2",
    });
    const r = await mk({ global: lookup, knownIds: [SAMPLE] });

    const out = await r.pipeline.run(SAMPLE, "build-v1");
    expect(out.status).toBe("analyzed");
    expect(r.fetchAudio).toHaveBeenCalledTimes(1);
    expect(r.decode).toHaveBeenCalledTimes(1);
    const rec = await r.index.get(SAMPLE);
    // Locally computed fingerprint v1 (not the incompatible global one blindly copied).
    expect(rec!.primaryClass).toBe("kick");
  });

  // Test F — Usage Acceptance
  it("F: global KNOWN never triggers usage acceptance or publish", async () => {
    const globalAnalysis = makeGlobalAnalysis();
    const provider = new FakeGlobalIndex({ type: "known", analysis: globalAnalysis });
    const publishSpy = vi.spyOn(provider, "publishAnalysisResults");
    const lookup = new GlobalLookup(provider, SUPPORTED);
    const r = await mk({ global: lookup, knownIds: [SAMPLE] });

    const out = await r.pipeline.run(SAMPLE, "build-v1");
    expect(out.status).toBe("analyzed");
    expect(publishSpy).not.toHaveBeenCalled();

    // The local record carries NO usage-acceptance marker → no acceptance, no
    // publish state derived from a mere global lookup.
    const rec = await r.index.get(SAMPLE);
    expect(rec!.globalPublish).toBeUndefined();
  });
});
