import { describe, it, expect, vi } from "vitest";
import type { SampleMeta } from "@audiotool/nexus/api";
import { AnalysisPipeline, FetchedAudio, type AnalysisPipelineDeps } from "./analysisPipeline";
import type { Classifier, ClassOutput } from "../classify/classifier";
import type { AudioFeatures } from "../persistence/indexStore";
import { makeFeatures } from "../classify/test-helpers";
import { makeSampleMeta } from "../library/test-helpers";
import { openTestDatabase } from "../persistence/test-helpers";
import { assertNoAudioBytes, IndexStore } from "../persistence/indexStore";
import type { DecodedAudio } from "../audio/decodedAudio";
import type { LosslessSource } from "./sourceSelection";
import { buildWavWithSeed } from "../audio/fixtures";
import { HierClassifier } from "../classify/hierClassifier";
import { HIER_CLASSIFICATION_VERSION, isWellFormedHierClassification } from "../classify/hier/types";
import { ALL_CLASSES } from "../classify/taxonomy";

const VALID_WAV = buildWavWithSeed({ frames: 10, seed: 0 });

type FetchAudio = (s: SampleMeta, source: LosslessSource) => Promise<FetchedAudio>;

function makeDecoded(overrides: Partial<DecodedAudio> = {}): DecodedAudio {
  return {
    sampleRate: 44100,
    channels: 1,
    mono: new Float32Array(44100),
    durationSeconds: 1,
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
  classifier: Classifier;
  classification: ClassOutput;
}

const KNOWN = ["samples/a", "samples/b", "samples/c"];

async function mk(
  overrides: Partial<{
    fetchAudio: FetchAudio;
    decode: (b: ArrayBuffer) => Promise<DecodedAudio>;
    extract: (a: DecodedAudio) => AudioFeatures;
    classify: (f: AudioFeatures) => Promise<ClassOutput>;
    resolveSample: (id: string) => Promise<SampleMeta | undefined>;
    classifyHier: (i: Parameters<NonNullable<AnalysisPipelineDeps["classifyHier"]>>[0]) => ReturnType<NonNullable<AnalysisPipelineDeps["classifyHier"]>>;
  }> = {},
): Promise<Rig> {
  const handle = await openTestDatabase();
  const release = vi.fn();
  const decode = vi.fn(overrides.decode ?? (async () => makeDecoded()));
  const extract = vi.fn(overrides.extract ?? (() => makeFeatures()));
  const classification: ClassOutput = {
    primaryClass: "kick",
    confidence: 0.9,
    secondaryClasses: [{ class: "tom", confidence: 0.07 }],
  };
  const classify = vi.fn(
    overrides.classify ?? (async () => classification),
  );
  const classifier: Classifier = {
    id: "heuristic",
    version: "heuristic-v1",
    classify,
  };
  const fetchAudio = vi.fn(
    overrides.fetchAudio ?? (async () => ({ bytes: VALID_WAV, release })),
  );
  const resolveSample = vi.fn(
    overrides.resolveSample ??
      (async (id: string) => (KNOWN.includes(id) ? makeSampleMeta(id) : undefined)),
  );
  const pipeline = new AnalysisPipeline({
    fetchAudio,
    decode,
    extract,
    classifier,
    classifyHier: overrides.classifyHier,
    resolveSample,
    index: handle.index,
    analysisVersion: "features-v1",
    now: () => new Date("2026-06-01T00:00:00.000Z"),
  });
  return {
    pipeline,
    index: handle.index,
    release,
    extract,
    decode,
    fetchAudio,
    resolveSample,
    classifier,
    classification,
  };
}

describe("AnalysisPipeline", () => {
  it("runs a full successful job and persists an analyzed record", async () => {
    const r = await mk();
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("analyzed");
    expect(r.decode).toHaveBeenCalledTimes(1);
    expect(r.extract).toHaveBeenCalledTimes(1);
    expect(r.classifier.classify).toHaveBeenCalledTimes(1);

    const rec = await r.index.get("samples/a");
    expect(rec).toBeDefined();
    expect(rec!.status).toBe("analyzed");
    expect(rec!.analysisBuild).toBe("build-v1");
    expect(rec!.primaryClass).toBe("kick");
    expect(rec!.confidence).toBe(0.9);
    expect(rec!.classificationVersion).toBe("heuristic-v1");
    expect(rec!.analysisVersion).toBe("features-v1");
    // Step 15H: record carries the new identity fields.
    expect(rec!.analysisSourceFormat).toBe("wav");
    expect(typeof rec!.fileHash).toBe("string");
    expect(typeof rec!.contentHash).toBe("string");
    expect(rec!.contentHashVersion).toBe("pcm-v1");
  });

  it("STEP44 (SC11/SC12): wired classifyHier persists a hier-v1 record, additive to heuristic-v1", async () => {
    const hierClassifier = new HierClassifier();
    const call = vi.fn(async (i) => hierClassifier.classifyHier(i));
    const r = await mk({ classifyHier: call });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("analyzed");
    // The surface is the hier tree's, so the legacy feature-only classifier is
    // not invoked, yet its heuristic-v1 records stay untouched (SC12 additive).
    expect(r.classifier.classify).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);

    const rec = await r.index.get("samples/a");
    expect(rec!.classificationVersion).toBe(HIER_CLASSIFICATION_VERSION);
    expect(rec!.hier).toBeDefined();
    expect(isWellFormedHierClassification(rec!.hier!)).toBe(true);
    // Raw annotations never carry audio bytes (SC12).
    expect(() => assertNoAudioBytes(rec!.hier!)).not.toThrow();
    // SC11: the surface vocabulary is exactly the existing taxonomy.
    const ids = [rec!.primaryClass, ...rec!.secondaryClasses.map((s) => s.class)];
    expect(ids.every((c) => ALL_CLASSES.includes(c))).toBe(true);
  });

  it("STEP44 (SC12): without classifyHier the record stays a pure heuristic-v1 record (no hier field)", async () => {
    const r = await mk();
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("analyzed");
    const rec = await r.index.get("samples/a");
    expect(rec!.classificationVersion).toBe("heuristic-v1");
    expect(rec!.hier).toBeUndefined();
    expect(r.classifier.classify).toHaveBeenCalledTimes(1);
  });

  it("buildRecord copies bpm/numFavorites/numUsages verbatim from the SampleMeta", async () => {
    const r = await mk({
      resolveSample: async () =>
        makeSampleMeta("samples/a", {
          bpm: 128,
          numFavorites: 42,
          numUsages: 187,
        }),
    });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("analyzed");
    const rec = await r.index.get("samples/a");
    expect(rec!.bpm).toBe(128);
    expect(rec!.numFavorites).toBe(42);
    expect(rec!.numUsages).toBe(187);
    // Analysis fields stay untouched by the metadata slice.
    expect(rec!.primaryClass).toBe("kick");
    expect(rec!.confidence).toBe(0.9);
    expect(rec!.audioFeatures).toBeDefined();
    expect(rec!.mapPosition).toBeDefined();
  });

  it("bpm 0 is preserved as a source value (not dropped, not normalized)", async () => {
    // Default makeSampleMeta carries bpm:0 — the record must keep the 0.
    const r = await mk();
    await r.pipeline.run("samples/a", "build-v1");
    const rec = await r.index.get("samples/a");
    expect(rec!.bpm).toBe(0);
    expect(rec!.numFavorites).toBe(0);
    expect(rec!.numUsages).toBe(0);
  });

  it("feeds the decoded audio to the extractor and the features to the classifier", async () => {
    const decodedArg = makeDecoded({ durationSeconds: 2 });
    const r = await mk({ decode: async () => decodedArg });
    await r.pipeline.run("samples/b", "build-v1");
    expect(r.extract).toHaveBeenCalledWith(decodedArg);
    const features = r.extract.mock.results[0].value as AudioFeatures;
    expect(r.classifier.classify).toHaveBeenCalledWith(features);
  });

  it("releases audio after a successful job", async () => {
    const r = await mk();
    await r.pipeline.run("samples/a", "build-v1");
    expect(r.release).toHaveBeenCalledTimes(1);
  });

  it("releases audio even when classification fails", async () => {
    const r = await mk({
      classify: async () => {
        throw new Error("model error");
      },
    });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("failed");
    expect((out as { error: string }).error).toContain("model error");
    expect(r.release).toHaveBeenCalledTimes(1);
  });

  it("marks a fetch failure as failed (nothing to release)", async () => {
    const r = await mk({
      fetchAudio: async () => {
        throw new Error("network down");
      },
    });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("failed");
    expect((out as { error: string }).error).toContain("network down");
    expect(r.release).not.toHaveBeenCalled();
  });

  it("marks a decode failure as skipped (gate) and still releases bytes", async () => {
    const r = await mk({
      decode: async () => {
        throw new Error("corrupt data");
      },
    });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("skipped");
    expect((out as { error: string }).error).toBe("DECODE_FAILED");
    expect(r.release).toHaveBeenCalledTimes(1);
  });

  it("marks an extractor failure as failed and still releases bytes", async () => {
    const r = await mk({
      extract: () => {
        throw new Error("extractor error");
      },
    });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("failed");
    expect((out as { error: string }).error).toContain("extractor error");
    expect(r.release).toHaveBeenCalledTimes(1);
  });

  it("marks a classifier failure as failed and still releases bytes", async () => {
    const r = await mk({
      classify: async () => {
        throw new Error("classifier blew up");
      },
    });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("failed");
    expect((out as { error: string }).error).toContain("classifier blew up");
    expect(r.release).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: same (sampleId, analysisBuild) does not re-run", async () => {
    const r = await mk();
    expect((await r.pipeline.run("samples/a", "build-v1")).status).toBe("analyzed");
    const second = await r.pipeline.run("samples/a", "build-v1");
    expect(second.status).toBe("skipped");
    expect(r.extract).toHaveBeenCalledTimes(1);
    expect(r.classifier.classify).toHaveBeenCalledTimes(1);
    expect(r.fetchAudio).toHaveBeenCalledTimes(1);
  });

  it("re-analyzes when the analysis build changes", async () => {
    const r = await mk();
    expect((await r.pipeline.run("samples/a", "build-v1")).status).toBe("analyzed");
    const out = await r.pipeline.run("samples/a", "build-v2");
    expect(out.status).toBe("analyzed");
    expect(r.extract).toHaveBeenCalledTimes(2);
  });

  it("marks a missing sample as gone without fetching audio", async () => {
    const r = await mk();
    const out = await r.pipeline.run("samples/ghost", "build-v1");
    expect(out.status).toBe("gone");
    expect(r.fetchAudio).not.toHaveBeenCalled();
  });

  it("never writes audio byte containers into the index record", async () => {
    const r = await mk();
    expect((await r.pipeline.run("samples/a", "build-v1")).status).toBe("analyzed");
    const rec = await r.index.get("samples/a");
    expect(rec).toBeDefined();
    expect(() => assertNoAudioBytes(rec)).not.toThrow();
  });

  it("skips when no lossless source is available", async () => {
    const noLossless = makeSampleMeta("samples/a", {
      name: "samples/a",
      mp3Url: "http://example.com/a.mp3",
      previewMp3Url: "http://example.com/a-preview.mp3",
    });
    delete (noLossless as Record<string, unknown>)["wavUrl"];
    delete (noLossless as Record<string, unknown>)["flacUrl"];
    const r = await mk({
      resolveSample: async () => noLossless,
    });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("skipped");
    expect((out as { error: string }).error).toBe("NO_LOSSLESS_SOURCE");
    expect(r.fetchAudio).not.toHaveBeenCalled();
    expect(r.decode).not.toHaveBeenCalled();
  });

  it("skips when the container gate rejects the fetched bytes", async () => {
    const tooSmall = new ArrayBuffer(2);
    const release = vi.fn();
    const r = await mk({
      fetchAudio: async () => ({ bytes: tooSmall, release }),
    });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("skipped");
    expect((out as { error: string }).error).toBe("INVALID_WAV_CONTAINER");
    expect(r.decode).not.toHaveBeenCalled();
    // Transient bytes are released even on a gate rejection.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("skips when the decoded PCM gate rejects non-finite samples", async () => {
    const nanMono = new Float32Array([NaN]);
    const r = await mk({
      decode: async () => ({
        sampleRate: 48000,
        channels: 1,
        mono: nanMono,
        durationSeconds: 0.001,
      }),
    });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("skipped");
    expect((out as { error: string }).error).toBe("INVALID_PCM");
    expect(r.release).toHaveBeenCalledTimes(1);
  });

  it("skips a single-frame decoded buffer deterministically (gate, no extractor crash)", async () => {
    const r = await mk({
      decode: async () => ({
        sampleRate: 44100,
        channels: 1,
        mono: new Float32Array([0.5]),
        durationSeconds: 1 / 44100,
      }),
    });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("skipped");
    expect((out as { error: string }).error).toBe("INVALID_PCM");
    expect(r.extract).not.toHaveBeenCalled();
    expect(r.classifier.classify).not.toHaveBeenCalled();
    expect(r.release).toHaveBeenCalledTimes(1);
    // Nothing is persisted for a rejected analysis.
    expect(await r.index.get("samples/a")).toBeUndefined();
  });

  it("skips a decoded buffer shorter than the minimum frames pool (2 frames)", async () => {
    const r = await mk({
      decode: async () => ({
        sampleRate: 8000,
        channels: 1,
        mono: new Float32Array(1),
        durationSeconds: 1 / 8000,
      }),
    });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("skipped");
    expect((out as { error: string }).error).toBe("INVALID_PCM");
  });
});