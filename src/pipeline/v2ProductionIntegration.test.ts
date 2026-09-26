import { describe, it, expect, vi } from "vitest";
import { AnalysisPipeline, canonicalV2Analysis } from "./analysisPipeline";
import type { AnalysisPipelineDeps } from "./analysisPipeline";
import type { DecodedAudio } from "../audio/decodedAudio";
import { makeFeatures } from "../classify/test-helpers";
import { makeSampleMeta } from "../library/test-helpers";
import { openTestDatabase } from "../persistence/test-helpers";
import { assertNoAudioBytes } from "../persistence/indexStore";
import { buildWavWithSeed } from "../audio/fixtures";
import {
  ANALYSIS_VERSION,
  validateSampleAnalysisV2,
  type SampleAnalysisV2,
} from "../analysis/sampleAnalysisV2";
import { SOUND_CHARACTER_DIMENSIONS } from "../analysis/config";
import { analyzeAudio } from "../audio/v2Dsp";
import { fromDecodedAudio } from "../audio/v2Input";
import type { SoundCharacter } from "../analysis/soundCharacter";
import { createSoundSpaceProjector, projectAll } from "../analysis/soundSpaceProjector";
import { rankSimilar } from "../analysis/similarityRanking";
import { makeSample } from "../persistence/test-helpers";

const VALID_WAV = buildWavWithSeed({ frames: 10, seed: 0 });

/** A 1s pure tone at a given frequency — real audio with projectable V2. */
function makeTone(freq: number): DecodedAudio {
  const sr = 44100;
  const mono = new Float32Array(sr);
  for (let i = 0; i < mono.length; i++) mono[i] = Math.sin((2 * Math.PI * freq * i) / sr) * 0.8;
  return { sampleRate: sr, channels: 1, mono, durationSeconds: 1 };
}

interface Rig {
  pipeline: AnalysisPipeline;
  index: import("../persistence/indexStore").IndexStore;
  release: ReturnType<typeof vi.fn>;
}

async function mk(overrides: Partial<AnalysisPipelineDeps> = {}): Promise<Rig> {
  const handle = await openTestDatabase();
  const release = vi.fn();
  const base: AnalysisPipelineDeps = {
    fetchAudio: async () => ({ bytes: VALID_WAV, release }),
    decode: async () => makeTone(440),
    extract: () => makeFeatures(),
    classifier: {
      id: "heuristic",
      version: "heuristic-v1",
      classify: async () => ({
        primaryClass: "kick",
        confidence: 0.9,
        secondaryClasses: [{ class: "tom", confidence: 0.07 }],
      }),
    },
    resolveSample: async (id) => makeSampleMeta(id),
    index: handle.index,
    analysisVersion: "features-v1",
    now: () => new Date("2026-06-01T00:00:00.000Z"),
  };
  const pipeline = new AnalysisPipeline({ ...base, ...overrides });
  return { pipeline, index: handle.index, release };
}

/** A valid full V2 analysis whose features come from the real tone DSP chain. */
function craftedV2(character: SoundCharacter): SampleAnalysisV2 {
  const features = analyzeAudio(fromDecodedAudio(makeTone(440)));
  return {
    analysisVersion: ANALYSIS_VERSION,
    features,
    soundCharacter: character,
    quality: { overall: 0.42, featureCoverage: 0.6 },
  };
}

describe("STEP36 — production V2 integration (analysisPipeline)", () => {
  it("invokes the canonical V2 analysis on every genuinely analyzed record", async () => {
    const r = await mk();
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("analyzed");
    const rec = await r.index.get("samples/a");
    expect(rec).toBeDefined();
    expect(rec!.analysisV2).toBeDefined();
  });

  it("persists a validated V2 result at analysisVersion 2.0.0", async () => {
    const r = await mk();
    await r.pipeline.run("samples/a", "build-v1");
    const rec = await r.index.get("samples/a");
    const check = validateSampleAnalysisV2(rec!.analysisV2);
    expect(check).toEqual({ valid: true, errors: [] });
    expect(rec!.analysisV2!.analysisVersion).toBe(ANALYSIS_VERSION);
  });

  it("persists the same values as the canonical reference chain (deterministic)", async () => {
    const r = await mk();
    await r.pipeline.run("samples/a", "build-v1");
    const rec = await r.index.get("samples/a");
    expect(rec!.analysisV2).toEqual(canonicalV2Analysis(makeTone(440)));
  });

  it("all eight canonical dimensions exist as number/null in [0,1]", async () => {
    const r = await mk();
    await r.pipeline.run("samples/a", "build-v1");
    const rec = await r.index.get("samples/a");
    const c = rec!.analysisV2!.soundCharacter;
    for (const d of SOUND_CHARACTER_DIMENSIONS) {
      const v = c[d];
      expect(v === null || (typeof v === "number" && v >= 0 && v <= 1)).toBe(true);
    }
  });

  it("preserves null semantics (null is never substituted with 0)", async () => {
    const character: SoundCharacter = {
      brightness: null,
      density: 0.4,
      transient: null,
      duration: 0.8,
      tonality: 0.9,
      noisiness: 0.1,
      dynamics: null,
      complexity: 0.7,
    };
    const r = await mk({ analyzeV2: () => craftedV2(character) });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("analyzed");
    const rec = await r.index.get("samples/a");
    expect(rec!.analysisV2!.soundCharacter.brightness).toBeNull();
    expect(rec!.analysisV2!.soundCharacter.dynamics).toBeNull();
    expect(rec!.analysisV2!.soundCharacter.density).toBe(0.4);
    expect(validateSampleAnalysisV2(rec!.analysisV2).valid).toBe(true);
  });

  it("rejects an invalid V2 result and persists nothing", async () => {
    const invalid: SampleAnalysisV2 = craftedV2({
      brightness: 2, // out of [0,1] — must fail validation
      density: 0.4,
      transient: 0.3,
      duration: 0.8,
      tonality: 0.9,
      noisiness: 0.1,
      dynamics: 0.5,
      complexity: 0.7,
    });
    const r = await mk({ analyzeV2: () => invalid });
    const out = await r.pipeline.run("samples/a", "build-v1");
    expect(out.status).toBe("failed");
    expect((out as { error: string }).error).toMatch(/V2_ANALYSIS_INVALID/);
    expect(await r.index.get("samples/a")).toBeUndefined();
    expect(r.release).toHaveBeenCalledTimes(1);
  });

  it("never writes audio byte containers into a record carrying V2", async () => {
    const r = await mk();
    await r.pipeline.run("samples/a", "build-v1");
    const rec = await r.index.get("samples/a");
    expect(() => assertNoAudioBytes(rec)).not.toThrow();
  });

  it("keeps an already-analyzed V1-only record valid without fabricating V2", async () => {
    const r = await mk();
    const legacy = makeSample("samples/legacy");
    expect(legacy.analysisV2).toBeUndefined();
    await r.index.put(legacy);
    const out = await r.pipeline.run("samples/legacy", legacy.analysisBuild);
    // Already analyzed for this build → skipped; no forced re-analysis.
    expect(out.status).toBe("skipped");
    const read = await r.index.get("samples/legacy");
    expect(read!.analysisV2).toBeUndefined();
    expect(() => assertNoAudioBytes(read)).not.toThrow();
  });

  it("lets Sound Space consume a pipeline-produced persisted V2 record", async () => {
    const r = await mk();
    expect((await r.pipeline.run("samples/a", "build-v1")).status).toBe("analyzed");
    expect((await r.pipeline.run("samples/b", "build-v1")).status).toBe("analyzed");
    const records = await r.index.getAll();
    expect(await r.index.count()).toBe(2);
    const points = projectAll(createSoundSpaceProjector(), records);
    expect(points.length).toBeGreaterThan(0);
    const point = points.find((p) => p.sampleId === "samples/a");
    expect(point).toBeDefined();
    expect(point!.analysisVersion).toBe(ANALYSIS_VERSION);
    expect(point!.x).toBeGreaterThanOrEqual(0);
    expect(point!.x).toBeLessThanOrEqual(1);
    expect(point!.y).toBeGreaterThanOrEqual(0);
    expect(point!.y).toBeLessThanOrEqual(1);
  });

  it("lets Find Similar V2 rank persisted V2 records (bounded, self-excluded)", async () => {
    const r = await mk();
    await r.pipeline.run("samples/query", "build-v1");
    await r.pipeline.run("samples/tone-880", "build-v1");
    const records = await r.index.getAll();
    const query = records.find((rec) => rec.sampleId === "samples/query")!;
    const ranked = rankSimilar(query, records, { limit: 10, includeSelf: false });
    expect(ranked.length).toBe(1);
    expect(ranked[0].sampleId).toBe("samples/tone-880");
    expect(ranked[0].similarity).toBeGreaterThanOrEqual(0);
    expect(ranked[0].similarity).toBeLessThanOrEqual(1);
    expect(ranked[0].sharedDimensionCount).toBeGreaterThan(0);
  });
});