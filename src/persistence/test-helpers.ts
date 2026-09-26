import "fake-indexeddb/auto";
import { openDatabase, DatabaseHandle } from "./db";
import { SampleIndexRecord } from "./indexStore";

let counter = 0;

/**
 * Open an isolated SampleMap database for a single test. Each call gets a unique
 * IndexedDB name so tests never share state. Callers should `close()` it.
 */
export async function openTestDatabase(): Promise<DatabaseHandle> {
  counter += 1;
  const name = `samplemap-test-${process.pid}-${counter}-${Date.now()}`;
  return openDatabase(name);
}

/** Build a deterministic sample record with sensible defaults overridable per test. */
export function makeSample(
  sampleId: string,
  overrides: Partial<SampleIndexRecord> = {},
): SampleIndexRecord {
  return {
    sampleId,
    owner: "alice",
    visibility: "public",
    name: "Hard Kick 01",
    kind: "kick",
    originalTags: ["pierre"],
    primaryClass: "kick",
    confidence: 0.9,
    secondaryClasses: [{ class: "toms", confidence: 0.08 }],
    classificationVersion: "classifier-v1",
    audioFeatures: {
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
    },
    // V2 (STEP 16Q): persisted map position (analysis result). A deterministic
    // default so records built via the helper are valid V2 records.
    mapPosition: { x: 0.62, y: 0.42 },
    analysisVersion: "features-v1",
    analyzedAt: "2026-01-01T00:00:00.000Z",
    analysisBuild: "build-v1",
    status: "analyzed",
    ...overrides,
  };
}
