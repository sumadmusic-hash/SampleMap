import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import type { SampleIndexRecord } from "../persistence/indexStore";
import { assertNoAudioBytes } from "../persistence/indexStore";
import { openDatabase } from "../persistence/db";
import type {
  GlobalSampleIndex,
  GlobalPublishResult,
  GlobalPublishOutcome,
  GlobalPublishItemOutcome,
  GlobalMapPoint,
  MapViewportQuery,
} from "./contract";
import { mapVersion } from "../map/mapPosition";
import { computeSimilarityFingerprint } from "../similarity/similarityFingerprint";
import { makeFeatures } from "../classify/test-helpers";
import { GlobalPublishQueue } from "./publishQueue";
import { populatePublishQueue } from "./population";
import { flushPendingPublications } from "./usageAcceptance";

const SAMPLE_AAA = "samples/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SAMPLE_BBB = "samples/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const HASH_XYZ = "f".repeat(64);
const NOW_ISO = "2026-03-01T00:00:00.000Z";

let dbCounter = 0;
async function newDbHandle() {
  dbCounter += 1;
  return openDatabase(`population-test-${process.pid}-${dbCounter}-${Date.now()}`);
}

function makeLocalRecord(
  overrides: Partial<SampleIndexRecord> = {},
): SampleIndexRecord {
  const features = makeFeatures();
  return {
    sampleId: SAMPLE_AAA,
    owner: "test-owner",
    visibility: "public",
    name: "Test Sample",
    kind: "sample",
    originalTags: ["test"],
    primaryClass: "kick",
    confidence: 0.9,
    secondaryClasses: [{ class: "toms", confidence: 0.08 }],
    classificationVersion: "heuristic-v1",
    audioFeatures: features,
    analysisVersion: "features-v1",
    analyzedAt: NOW_ISO,
    analysisBuild: "build-population-test",
    status: "analyzed",
    analysisSourceFormat: "wav",
    fileHash: "a".repeat(64),
    contentHash: HASH_XYZ,
    contentHashVersion: "pcm-v1",
    similarityFingerprint: computeSimilarityFingerprint(features),
    mapPosition: { x: 0.4, y: 0.6 },
    ...overrides,
  };
}

class MemoryGlobalSampleIndex implements GlobalSampleIndex {
  public storedIdentities = new Set<string>();
  public points: GlobalMapPoint[] = [];

  async lookupSamples() { return []; }
  async lookupContentIdentities() { return []; }

  async queryMapViewport(query: MapViewportQuery) {
    const matched = this.points.filter((p) => {
      if (p.x < query.xMin || p.x > query.xMax) return false;
      if (p.y < query.yMin || p.y > query.yMax) return false;
      if (query.primaryClass && p.primaryClass !== query.primaryClass) return false;
      return true;
    });
    return { mapVersion, points: matched };
  }

  async publishAnalysisResults(batch: GlobalPublishResult[]): Promise<GlobalPublishOutcome> {
    const items: GlobalPublishItemOutcome[] = [];
    for (const item of batch) {
      assertNoAudioBytes(item);
      const key = `${item.contentIdentity.contentHashVersion}:${item.contentIdentity.contentHash}`;
      if (this.storedIdentities.has(key)) {
        items.push({ status: "already-known" });
      } else {
        this.storedIdentities.add(key);
        this.points.push({
          contentIdentity: item.contentIdentity,
          x: item.analysis.map.x,
          y: item.analysis.map.y,
          representativeSampleId: item.sampleId,
          primaryClass: item.analysis.primaryClass,
        });
        items.push({ status: "stored" });
      }
    }
    const accepted = items.every((i) => i.status === "stored" || i.status === "already-known");
    return { items, accepted };
  }
}

describe("Step 70 — Automatic Global Population (population.ts)", () => {
  describe("1. Local analyzed → publish queue", () => {
    it("analysiertes gültiges Record → Queue-Eintrag + Marker pending", async () => {
      const handle = await newDbHandle();
      const record = makeLocalRecord();
      await handle.index.put(record);

      const provider = new MemoryGlobalSampleIndex();
      const queue = new GlobalPublishQueue(provider);

      const result = await populatePublishQueue({
        index: handle.index,
        queue,
        now: () => NOW_ISO,
      });

      expect(result.scanned).toBe(1);
      expect(result.enqueued).toBe(1);
      expect(result.skippedNotAnalyzed).toBe(0);
      expect(result.skippedIneligible).toBe(0);
      expect(result.markedPending).toBe(1);

      // Queue state
      expect(queue.pendingCount).toBe(1);
      const items = queue.snapshot();
      expect(items).toHaveLength(1);
      expect(items[0].sampleId).toBe(SAMPLE_AAA);
      expect(items[0].status).toBe("pending");

      // Local marker updated
      const updated = await handle.index.get(SAMPLE_AAA);
      expect(updated?.globalPublish).toEqual({
        usageAcceptedAt: NOW_ISO,
        delivery: "pending",
      });

      await handle.db.close();
    });

    it("nicht analysiertes Record → kein Publish", async () => {
      const handle = await newDbHandle();
      await handle.index.put(makeLocalRecord({ sampleId: "samples/s1", status: "pending" }));
      await handle.index.put(makeLocalRecord({ sampleId: "samples/s2", status: "failed" }));
      await handle.index.put(makeLocalRecord({ sampleId: "samples/s3", status: "gone" }));

      const provider = new MemoryGlobalSampleIndex();
      const queue = new GlobalPublishQueue(provider);

      const result = await populatePublishQueue({
        index: handle.index,
        queue,
      });

      expect(result.scanned).toBe(3);
      expect(result.enqueued).toBe(0);
      expect(result.skippedNotAnalyzed).toBe(3);
      expect(queue.pendingCount).toBe(0);

      // No markers set
      const s1 = await handle.index.get("samples/s1");
      expect(s1?.globalPublish).toBeUndefined();

      await handle.db.close();
    });

    it("Missing-V2 → kein Publish", async () => {
      const handle = await newDbHandle();
      const record = makeLocalRecord({ mapPosition: undefined });
      await handle.index.put(record);

      const provider = new MemoryGlobalSampleIndex();
      const queue = new GlobalPublishQueue(provider);

      const result = await populatePublishQueue({
        index: handle.index,
        queue,
      });

      expect(result.scanned).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(result.skippedIneligible).toBe(1);
      expect(queue.pendingCount).toBe(0);

      const updated = await handle.index.get(SAMPLE_AAA);
      expect(updated?.globalPublish).toBeUndefined();

      await handle.db.close();
    });

    it("fehlende Content Identity → kein Publish", async () => {
      const handle = await newDbHandle();
      const record = makeLocalRecord({ contentHash: undefined, contentHashVersion: undefined });
      await handle.index.put(record);

      const provider = new MemoryGlobalSampleIndex();
      const queue = new GlobalPublishQueue(provider);

      const result = await populatePublishQueue({
        index: handle.index,
        queue,
      });

      expect(result.scanned).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(result.skippedIneligible).toBe(1);
      expect(queue.pendingCount).toBe(0);

      await handle.db.close();
    });

    it("ungültiges Record (missing similarityFingerprint) → kein Publish", async () => {
      const handle = await newDbHandle();
      const record = makeLocalRecord({ similarityFingerprint: undefined });
      await handle.index.put(record);

      const provider = new MemoryGlobalSampleIndex();
      const queue = new GlobalPublishQueue(provider);

      const result = await populatePublishQueue({
        index: handle.index,
        queue,
      });

      expect(result.scanned).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(result.skippedIneligible).toBe(1);
      expect(queue.pendingCount).toBe(0);

      await handle.db.close();
    });
  });

  describe("2. Dedup & Idempotency", () => {
    it("sampleId-level idempotency: repeating populatePublishQueue does not duplicate queue item", async () => {
      const handle = await newDbHandle();
      await handle.index.put(makeLocalRecord());

      const provider = new MemoryGlobalSampleIndex();
      const queue = new GlobalPublishQueue(provider);

      const r1 = await populatePublishQueue({ index: handle.index, queue, now: () => NOW_ISO });
      expect(r1.enqueued).toBe(1);
      expect(r1.duplicates).toBe(0);

      const r2 = await populatePublishQueue({ index: handle.index, queue, now: () => "2026-03-02T00:00:00.000Z" });
      expect(r2.enqueued).toBe(0);
      expect(r2.duplicates).toBe(1);

      // Marker timestamp was preserved (not overwritten by r2)
      const rec = await handle.index.get(SAMPLE_AAA);
      expect(rec?.globalPublish?.usageAcceptedAt).toBe(NOW_ISO);
      expect(rec?.globalPublish?.delivery).toBe("pending");

      await handle.db.close();
    });

    it("bereits lokal als 'published' markiertes Record wird nicht erneut enqueued", async () => {
      const handle = await newDbHandle();
      await handle.index.put(makeLocalRecord({
        globalPublish: { usageAcceptedAt: NOW_ISO, delivery: "published" },
      }));

      const provider = new MemoryGlobalSampleIndex();
      const queue = new GlobalPublishQueue(provider);

      const result = await populatePublishQueue({ index: handle.index, queue });
      expect(result.alreadyPublished).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(queue.pendingCount).toBe(0);

      await handle.db.close();
    });

    it("unterschiedliche sampleIds mit gleicher Content Identity: beide enqueued, Server deduped via already-known, Representative-Regel bleibt erhalten", async () => {
      const handle = await newDbHandle();
      const recA = makeLocalRecord({ sampleId: SAMPLE_AAA, contentHash: HASH_XYZ });
      const recB = makeLocalRecord({ sampleId: SAMPLE_BBB, contentHash: HASH_XYZ });
      await handle.index.put(recA);
      await handle.index.put(recB);

      const provider = new MemoryGlobalSampleIndex();
      const queue = new GlobalPublishQueue(provider);

      const result = await populatePublishQueue({ index: handle.index, queue });
      expect(result.enqueued).toBe(2);

      // Flush to provider
      const flushResult = await flushPendingPublications({ index: handle.index, queue });
      expect(flushResult.flush.submitted).toBe(2);
      expect(flushResult.flush.succeeded).toBe(2);

      // Server-side outcomes: first stored, second already-known
      expect(flushResult.flush.outcome?.items).toEqual([
        { status: "stored" },
        { status: "already-known" },
      ]);

      // Global index has only ONE point (representative = first registered sampleId)
      expect(provider.points).toHaveLength(1);
      expect(provider.points[0].representativeSampleId).toBe(SAMPLE_AAA);
      expect(provider.points[0].contentIdentity.contentHash).toBe(HASH_XYZ);

      // Both local records are marked "published"
      const updatedA = await handle.index.get(SAMPLE_AAA);
      const updatedB = await handle.index.get(SAMPLE_BBB);
      expect(updatedA?.globalPublish?.delivery).toBe("published");
      expect(updatedB?.globalPublish?.delivery).toBe("published");

      await handle.db.close();
    });
  });

  describe("3. Offline & Error Isolation", () => {
    it("Worker nicht verfügbar (offline provider) → kein Absturz, Candidate bleibt retryable/pending", async () => {
      const handle = await newDbHandle();
      await handle.index.put(makeLocalRecord());

      // Offline provider returning temporary-unavailable
      const offlineProvider: GlobalSampleIndex = {
        async lookupSamples() { return []; },
        async lookupContentIdentities() { return []; },
        async queryMapViewport() { return { mapVersion, points: [] }; },
        async publishAnalysisResults(batch) {
          return {
            items: batch.map(() => ({ status: "rejected" as const, reason: "temporary-unavailable" })),
            accepted: false,
          };
        },
      };

      const queue = new GlobalPublishQueue(offlineProvider);
      await populatePublishQueue({ index: handle.index, queue, now: () => NOW_ISO });
      expect(queue.pendingCount).toBe(1);

      // Attempt flush against offline provider
      const flushRes = await flushPendingPublications({ index: handle.index, queue });
      expect(flushRes.flush.submitted).toBe(1);
      expect(flushRes.flush.retryable).toBe(1);
      expect(flushRes.flush.succeeded).toBe(0);
      expect(flushRes.markedPublished).toBe(0);

      // Marker remains pending
      const rec = await handle.index.get(SAMPLE_AAA);
      expect(rec?.globalPublish?.delivery).toBe("pending");

      await handle.db.close();
    });

    it("Network transport error during flush → item becomes retryable, marker stays pending", async () => {
      const handle = await newDbHandle();
      await handle.index.put(makeLocalRecord());

      const networkErrorProvider: GlobalSampleIndex = {
        async lookupSamples() { return []; },
        async lookupContentIdentities() { return []; },
        async queryMapViewport() { return { mapVersion, points: [] }; },
        async publishAnalysisResults() {
          throw new Error("Failed to fetch: Connection refused");
        },
      };

      const queue = new GlobalPublishQueue(networkErrorProvider);
      await populatePublishQueue({ index: handle.index, queue });

      const flushRes = await flushPendingPublications({ index: handle.index, queue });
      expect(flushRes.flush.retryable).toBe(1);
      expect(flushRes.flush.succeeded).toBe(0);

      const rec = await handle.index.get(SAMPLE_AAA);
      expect(rec?.globalPublish?.delivery).toBe("pending");

      await handle.db.close();
    });
  });

  describe("4. Global map query integration", () => {
    it("erfolgreich publiziertes Record ist anschließend über queryMapViewport als GlobalMapPoint auffindbar", async () => {
      const handle = await newDbHandle();
      await handle.index.put(makeLocalRecord({
        sampleId: SAMPLE_AAA,
        mapPosition: { x: 0.25, y: 0.75 },
        primaryClass: "kick",
      }));

      const provider = new MemoryGlobalSampleIndex();
      const queue = new GlobalPublishQueue(provider);

      await populatePublishQueue({ index: handle.index, queue });
      await flushPendingPublications({ index: handle.index, queue });

      // Viewport enclosing the point
      const res = await provider.queryMapViewport({
        mapVersion,
        xMin: 0.2,
        xMax: 0.3,
        yMin: 0.7,
        yMax: 0.8,
        primaryClass: "kick",
      });

      expect(res.points).toHaveLength(1);
      expect(res.points[0]).toEqual({
        contentIdentity: { contentHash: HASH_XYZ, contentHashVersion: "pcm-v1" },
        x: 0.25,
        y: 0.75,
        representativeSampleId: SAMPLE_AAA,
        primaryClass: "kick",
      });

      // Query outside viewport returns nothing
      const outside = await provider.queryMapViewport({
        mapVersion,
        xMin: 0.8,
        xMax: 1.0,
        yMin: 0.0,
        yMax: 0.5,
      });
      expect(outside.points).toHaveLength(0);

      await handle.db.close();
    });
  });

  describe("5. No-audio invariant", () => {
    it("der gesamte Publish-Payload enthält keinerlei Audio-Daten", async () => {
      const handle = await newDbHandle();
      await handle.index.put(makeLocalRecord());

      const provider = new MemoryGlobalSampleIndex();
      const queue = new GlobalPublishQueue(provider);

      await populatePublishQueue({ index: handle.index, queue });

      const items = queue.snapshot();
      expect(items).toHaveLength(1);

      // 1. Authoritative assertNoAudioBytes on candidate
      assertNoAudioBytes(items[0].candidate);

      // 2. Strict JSON inspection: ensure no audio-like binary types or buffer indicators
      const serialized = JSON.stringify(items[0].candidate);
      expect(serialized).not.toMatch(/"audioBuffer"|"pcm"|"audioData"|"rawAudio"|"wavBytes"/i);

      // 3. Candidate features check: contains only numeric/string metadata
      const candidate = items[0].candidate;
      expect(candidate.features).toBeDefined();
      expect(typeof candidate.features.duration).toBe("number");
      expect(typeof candidate.features.rms).toBe("number");
      expect(Array.isArray(candidate.features.spectralCentroid)).toBe(false); // numeric scalar

      await handle.db.close();
    });
  });
});
