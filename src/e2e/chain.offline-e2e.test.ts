import { describe, it, expect } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { scanLibrary } from "../library/libraryScanner";
import { toSampleName } from "../library/sampleRef";
import { openTestDatabase } from "../persistence/test-helpers";
import { assertNoAudioBytes } from "../persistence/indexStore";
import { AnalysisPipeline } from "../pipeline/analysisPipeline";
import { JobRunner } from "../pipeline/jobRunner";
import { extractFeatures } from "../audio/featureExtractor";
import { HeuristicClassifier } from "../classify/heuristicClassifier";
import { SampleMapSearchEngine } from "../search/searchEngine";
import { SampleMapMachinisteService } from "../machiniste/machinisteService";
import { makeSampleMeta } from "../library/test-helpers";
import { buildWavWithMarker, parsePcmWav } from "../audio/fixtures";
import type { DecodedAudio } from "../audio/decodedAudio";

// ============================================================================
// OFFLINE E2E chain — SAMPLEMAP_V1_SPEC §20 Step 12, updated Step 15H.
//
// This file stitches the REAL modules together and runs the full chain END-TO-
// END using SYNTHETIC data (synthetic SampleMeta + synthetic PCM audio). It is
// explicitly an OFFLINE test, NOT a real-backend test:
//
//   LibraryScanner (fake page source)
//     -> sampleRef            (canonical samples/{uuid})
//     -> QueueStore + JobRunner
//     -> AnalysisPipeline     (REAL extractFeatures + REAL HeuristicClassifier,
//                              synthetic decode; fetchAudio is faked, bytes
//                              released in finally; Step 15H container gate
//                              now validates the REAL WAV fixture header)
//     -> IndexStore           (REAL, in-memory IndexedDB; no audio bytes)
//     -> SearchEngine         (REAL, read-only)
//     -> MachinisteService    (REAL offline Nexus document + WASM validator)
//     -> Read-back
//
// The NEXUS/SERVE-live backend is NOT contacted and NOT claimed. The only
// Nexus asset used is the LOCAL `createOfflineDocument` WASM validator. Whether
// the real backend accepts an arbitrary library sample NAME without uploading
// the audio must be confirmed with an authenticated real run (NOT VERIFIED).
//
// Audio bytes exist ONLY transiently in the faked fetchAudio result and are
// released; they are never written to IndexedDB (asserted below).
// ============================================================================

const KICK_ID = "samples/11111111-1111-4111-8111-111111111111";
const NOISE_ID = "samples/22222222-2222-4222-8222-222222222222";

const BUILD = "smap-build-v1";

/** Deterministic synthetic kick (dark, short, tonal) -> HeuristicClassifier yields "kick". */
function kickDecoded(): DecodedAudio {
  const sampleRate = 44100;
  const durationSeconds = 0.4;
  const n = Math.floor(sampleRate * durationSeconds);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    mono[i] = Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t * 30);
  }
  return { sampleRate, channels: 1, mono, durationSeconds };
}

/** Deterministic synthetic brash noise -> HeuristicClassifier yields "noise". */
function noiseDecoded(): DecodedAudio {
  const sampleRate = 44100;
  const durationSeconds = 0.15;
  const n = Math.floor(sampleRate * durationSeconds);
  const mono = new Float32Array(n);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const r = rnd() * 2 - 1;
    const hp = r - prev; // cheap high-pass -> bright centroid
    prev = r;
    mono[i] = hp * 0.5 * Math.exp((-i / n) * 3);
  }
  return { sampleRate, channels: 1, mono, durationSeconds };
}

const KICK_META = makeSampleMeta(KICK_ID, {
  name: KICK_ID,
  displayName: "Deep Kick 909",
  ownerName: "users/alice",
  tags: ["kick", "deep"],
  visibility: "public",
});
const NOISE_META = makeSampleMeta(NOISE_ID, {
  name: NOISE_ID,
  displayName: "Airy Noise",
  ownerName: "users/bob",
  tags: ["white", "fx"],
  visibility: "public",
});
const ALL_META = [KICK_META, NOISE_META];

/**
 * Fake fetchAudio that returns a REAL (gate-valid) WAV container whose data
 * chunk encodes the sample name as raw text. The fake decode below parses the
 * data chunk back out to identify the sample and return the appropriate
 * synthetic DecodedAudio. This keeps the Step 15H container gate active for
 * the e2e chain without breaking the fake-decode marker idiom.
 */
function fakeFetch(sampleName: string) {
  return { bytes: buildWavWithMarker(sampleName), release: () => {} };
}

/** Fake decode: parse the marker out of the WAV data chunk to identify the sample. */
async function fakeDecode(bytes: ArrayBuffer): Promise<DecodedAudio> {
  const { data } = parsePcmWav(bytes);
  const marker = new TextDecoder().decode(data);
  return marker === KICK_ID ? kickDecoded() : noiseDecoded();
}

describe("OFFLINE E2E : full SampleMap chain (synthetic audio, no real backend)", () => {
  it("scans -> analyzes (real extract/classify) -> indexes -> searches -> machiniste direct-ref + read-back", async () => {
    const handle = await openTestDatabase();
    try {
      // --- 1. LibraryScanner over a fake paged source ----------------------
      const scanned = await scanLibrary(
        async (opts) => {
          const token = Number(opts.pageToken ?? "0");
          const page = ALL_META.slice(token, token + 1);
          return { samples: page, nextPageToken: token + 1 < ALL_META.length ? String(token + 1) : undefined };
        },
        { getUpdatedAt: async () => undefined },
        { pageSize: 1, maxPages: 5 },
      );
      expect(scanned.added.length).toBe(2);
      expect(scanned.added.map((s) => s.name).sort()).toEqual(
        [KICK_ID, NOISE_ID].sort(),
      );

      // --- 2. sampleRef -> canonical names --------------------------------
      expect(scanned.added.map(toSampleName)).toEqual(scanned.added.map((s) => s.name));

      // --- 3. enqueue ---------------------------------------------
      for (const s of scanned.added) await handle.queue.enqueue(s.name, BUILD);

      // --- 4. JobRunner + AnalysisPipeline (REAL extract + classify) ------
      let fetches = 0;
      const pipeline = new AnalysisPipeline({
        fetchAudio: async (sample) => {
          fetches++;
          return fakeFetch(sample.name);
        },
        decode: async (bytes) => fakeDecode(bytes),
        extract: extractFeatures,               // REAL
        classifier: new HeuristicClassifier(),  // REAL heuristic classifier
        resolveSample: async (id) => ALL_META.find((s) => s.name === id),
        index: handle.index,
        analysisVersion: "features-v1",
        now: () => new Date("2026-06-01T00:00:00.000Z"),
      });
      const runner = new JobRunner({
        pipeline,
        queue: handle.queue,
        analysisBuild: BUILD,
        budget: 10,
      });
      const progress = await runner.start();
      expect(progress.analyzed).toBe(2);
      expect(progress.stoppedReason).toBe("empty");

      // --- 5. IndexStore: only metadata; no audio bytes -------------------
      const kickRec = await handle.index.get(KICK_ID);
      const noiseRec = await handle.index.get(NOISE_ID);
      expect(kickRec).toBeDefined();
      expect(noiseRec).toBeDefined();
      expect(kickRec!.primaryClass).toBe("kick");
      expect(noiseRec!.primaryClass).toBe("noise");
      for (const c of [kickRec!.confidence, noiseRec!.confidence]) {
        expect(c).toBeGreaterThan(0);
        expect(c).toBeLessThanOrEqual(1);
      }
      // originalTags come straight from the library metadata, unchanged.
      expect(kickRec!.originalTags).toEqual(["kick", "deep"]);
      expect(noiseRec!.originalTags).toEqual(["white", "fx"]);
      expect(kickRec!.classificationVersion).toBe("heuristic-v1");
      expect(kickRec!.analysisBuild).toBe(BUILD);
      // Runtime invariant: the persisted records carry no audio bytes.
      for (const r of [kickRec, noiseRec]) {
        expect(() => assertNoAudioBytes(r)).not.toThrow();
      }
      // Step 15H: identity fields present and correct.
      expect(kickRec!.analysisSourceFormat).toBe("wav");
      expect(typeof kickRec!.contentHash).toBe("string");
      expect(kickRec!.contentHashVersion).toBe("pcm-v1");

      // --- 6. SearchEngine (real, read-only) over the real index ----------
      const search = new SampleMapSearchEngine(handle.index);
      // Class filter matches primary OR secondary. The noise record lists "kick"
      // among its secondary classes, so "kick" matches both; "noise" matches only
      // the noise record (kick's secondaries never include "noise").
      const byKick = await search.search({ classes: ["kick"] });
      expect(byKick.map((r) => r.record.sampleId)).toContain(KICK_ID);
      expect(byKick.length).toBeGreaterThanOrEqual(1);
      const byNoise = await search.search({ classes: ["noise"] });
      expect(byNoise.map((r) => r.record.sampleId)).toEqual([NOISE_ID]);
      const byTag = await search.search({ text: "deep" });
      expect(byTag.map((r) => r.record.sampleId)).toEqual([KICK_ID]);
      const byOwner = await search.search({ text: "bob" });
      expect(byOwner.map((r) => r.record.sampleId)).toEqual([NOISE_ID]);
      // Confidence filter narrows "kick" to the kick record only (0.484 > 0.4;
      // the noise record's kick-secondary still ranks by its own 0.306 confidence).
      const minConf = await search.search({ classes: ["kick"], minConfidence: 0.4 });
      expect(minConf.map((r) => r.record.sampleId)).toEqual([KICK_ID]);
      const tooHigh = await search.search({ classes: ["kick"], minConfidence: 0.99 });
      expect(tooHigh).toEqual([]);

      // --- 7. MachinisteService: direct-reference, one transaction, read-back ---
      const doc = await createOfflineDocument(); // real offline Nexus WASM model
      let machinisteId = "";
      await doc.modify((t) => {
        machinisteId = t.create("machiniste", {}).id;
      });
      const mach = new SampleMapMachinisteService(doc);
      const res = await mach.send([toSampleName(KICK_META), toSampleName(NOISE_META)], machinisteId, [0, 1]);

      expect(res.committed).toBe(true);
      expect(res.errors).toEqual([]);
      expect(res.machinisteId).toBe(machinisteId);
      expect(res.slots).toHaveLength(2);
      expect(res.slots[0].sampleName).toBe(KICK_ID);
      expect(res.slots[1].sampleName).toBe(NOISE_ID);
      for (const s of res.slots) {
        expect(s.applied).toBe(true);
        expect(s.readBackMatches).toBe(true);
        expect(s.sampleEntityId).toBeDefined();
      }

      // Read-back: committed document state matches what we wrote.
      const committedMach = doc.queryEntities.ofTypes("machiniste").getEntity(machinisteId)!;
      const channel0 = committedMach.fields.channels.array[0].fields.sample.value.entityId;
      const channel1 = committedMach.fields.channels.array[1].fields.sample.value.entityId;
      const sample0 = doc.queryEntities.ofTypes("sample").getEntity(channel0)!;
      const sample1 = doc.queryEntities.ofTypes("sample").getEntity(channel1)!;
      expect(sample0.fields.sampleName.value).toBe(KICK_ID);
      expect(sample1.fields.sampleName.value).toBe(NOISE_ID);
    } finally {
      await handle.db.close();
    }
  });

  it("is idempotent: re-running the same build does not re-fetch audio", async () => {
    const handle = await openTestDatabase();
    try {
      await handle.queue.enqueue(KICK_ID, BUILD);
      let fetches = 0;
      const pipeline = new AnalysisPipeline({
        fetchAudio: async (sample) => {
          fetches++;
          return fakeFetch(sample.name);
        },
        decode: async (bytes) => fakeDecode(bytes),
        extract: extractFeatures,
        classifier: new HeuristicClassifier(),
        resolveSample: async (id) => ALL_META.find((s) => s.name === id),
        index: handle.index,
        analysisVersion: "features-v1",
        now: () => new Date("2026-06-01T00:00:00.000Z"),
      });

      const first = await pipeline.run(KICK_ID, BUILD);
      expect(first.status).toBe("analyzed");
      expect(fetches).toBe(1);

      const second = await pipeline.run(KICK_ID, BUILD);
      expect(second.status).toBe("skipped");
      expect(fetches).toBe(1); // no redundant audio fetch for the same build

      const third = await pipeline.run(KICK_ID, `${BUILD}-v2`);
      expect(third.status).toBe("analyzed"); // a new build legitimately re-analyzes
      expect(fetches).toBe(2);
    } finally {
      await handle.db.close();
    }
  });
});