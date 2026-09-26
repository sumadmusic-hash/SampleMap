/**
 * Step 16F — CloudflareGlobalSampleIndex provider integration tests.
 *
 * These run the REAL provider logic against the in-memory `FakeD1` harness.
 * FakeD1 is a LOCAL TEST DOUBLE, NOT a real Cloudflare D1 database (the live
 * verification, 16F-12, is blocked on a real Cloudflare account/credentials).
 * What is genuinely exercised here: batching/atomic grouping, the 100-bound-
 * param chunking, idempotency, conflict rejection (no last-write-wins), content
 * identity dedup, representative selection (lex-min), map viewport ordering /
 * limit / cursor, and the no-audio invariant on payloads.
 */
import { describe, it, expect } from "vitest";
import { FakeD1 } from "./fakeD1";
import { CloudflareGlobalSampleIndex } from "../src/provider";
import { makeValidPublish, makeV2Block } from "./fixtures";
import { decodeSoundCharacterFromBase64 } from "../../../src/global/soundCharacterCodec";
import { SOUND_CHARACTER_CODEC_VERSION } from "../../../src/global/soundCharacterCodec";
import { emptySoundCharacter } from "../../../src/analysis/soundCharacter";

function makeIndex() {
  const fake = new FakeD1();
  const db = fake as unknown as D1Database;
  const index = new CloudflareGlobalSampleIndex(db, {
    maxBatchSize: 100,
    defaultMapLimit: 200,
    maxMapLimit: 1000,
  });
  return { fake, index };
}

const OPTS = {
  maxBatchSize: 100,
  defaultMapLimit: 200,
  maxMapLimit: 1000,
};

describe("CloudflareGlobalSampleIndex — publish", () => {
  it("stores a brand-new publish (sample_ref + content)", async () => {
    const { index } = makeIndex();
    const item = makeValidPublish({
      sampleId: "samples/aaa",
      contentHash: "a".repeat(64),
    });
    const outcome = await index.publishAnalysisResults([item]);
    expect(outcome.items).toEqual([{ status: "stored" }]);
    expect(outcome.accepted).toBe(true);

    const hits = await index.lookupSamples(["samples/aaa"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ status: "known", sampleId: "samples/aaa" });
  });

  it("is idempotent: re-publishing the same sample+content is already-known", async () => {
    const { index } = makeIndex();
    const item = makeValidPublish({ sampleId: "samples/aaa" });
    await index.publishAnalysisResults([item]);
    const second = await index.publishAnalysisResults([item]);
    expect(second.items).toEqual([{ status: "already-known" }]);
    expect(second.accepted).toBe(true);
  });

  it("stores two samples sharing one content identity (content dedup)", async () => {
    const { index } = makeIndex();
    const c = "b".repeat(64);
    const a = makeValidPublish({ sampleId: "samples/zzz", contentHash: c });
    const b = makeValidPublish({ sampleId: "samples/aaa", contentHash: c });
    const outcome = await index.publishAnalysisResults([a, b]);
    expect(outcome.items).toEqual([{ status: "stored" }, { status: "stored" }]);

    const contentHits = await index.lookupContentIdentities([
      { contentHash: c, contentHashVersion: "pcm-v1" },
    ]);
    expect(contentHits).toHaveLength(1);
    // lex-min representative: samples/aaa < samples/zzz
    expect(contentHits[0].representativeSampleId).toBe("samples/aaa");
    expect(contentHits[0].sampleIds.sort()).toEqual([
      "samples/aaa",
      "samples/zzz",
    ]);
  });

  it("rejects a conflict re-point to a DIFFERENT content (no last-write-wins)", async () => {
    const { index } = makeIndex();
    const first = makeValidPublish({
      sampleId: "samples/aaa",
      contentHash: "c".repeat(64),
    });
    await index.publishAnalysisResults([first]);

    const second = makeValidPublish({
      sampleId: "samples/aaa",
      contentHash: "d".repeat(64),
    });
    const outcome = await index.publishAnalysisResults([second]);
    expect(outcome.items[0]).toMatchObject({ status: "rejected" });
    expect(outcome.items[0].status === "rejected").toBe(true);
    if (outcome.items[0].status === "rejected") {
      expect(outcome.items[0].reason).toContain("conflict");
    }
    expect(outcome.accepted).toBe(false);

    // The sample still points at its ORIGINAL content (never overwritten).
    const hits = await index.lookupSamples(["samples/aaa"]);
    expect(hits[0]).toMatchObject({ status: "known" });
    if (hits[0].status === "known") {
      expect(hits[0].contentIdentity.contentHash).toBe("c".repeat(64));
    }
  });

  it("rejects structurally invalid items with validation-rejected", async () => {
    const { index } = makeIndex();
    const good = makeValidPublish({ sampleId: "samples/aaa" });
    const bad = {
      ...good,
      analysis: {
        ...good.analysis,
        map: { mapVersion: "map-v2", x: 9999, y: 9999 }, // coords out of [0,1]
      },
    };
    const outcome = await index.publishAnalysisResults([good, bad]);
    expect(outcome.items[0]).toEqual({ status: "stored" });
    expect(outcome.items[1]).toMatchObject({ status: "rejected" });
    if (outcome.items[1].status === "rejected") {
      expect(outcome.items[1].reason).toContain("validation-rejected");
    }
  });

  it("rejects a batch that exceeds maxBatchSize", async () => {
    const small = new CloudflareGlobalSampleIndex(
      (new FakeD1() as unknown) as D1Database,
      { ...OPTS, maxBatchSize: 2 },
    );
    const batch = Array.from({ length: 3 }, (_, i) =>
      makeValidPublish({ sampleId: `samples/${i}` }),
    );
    await expect(small.publishAnalysisResults(batch)).rejects.toMatchObject({
      kind: "validation-rejected",
    });
  });

  it("throws validation-rejected on audio bytes in the batch", async () => {
    const { index } = makeIndex();
    const item = makeValidPublish({ sampleId: "samples/aaa" });
    const poisoned = { ...item, features: { ...item.features, _blob: new Blob() } };
    await expect(
      index.publishAnalysisResults([poisoned]),
    ).rejects.toThrow(/audio byte container prohibited/i);
  });
});

describe("CloudflareGlobalSampleIndex — lookup", () => {
  it("returns known/unknown hits, one per unique sampleId, in first-seen order", async () => {
    const { index } = makeIndex();
    await index.publishAnalysisResults([
      makeValidPublish({ sampleId: "samples/bbb" }),
    ]);
    const hits = await index.lookupSamples([
      "samples/aaa",
      "samples/bbb",
      "samples/ccc",
      "samples/aaa",
    ]);
    // Duplicate inputs are deduplicated: one hit per unique sampleId.
    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({ status: "unknown", sampleId: "samples/aaa" });
    expect(hits[1]).toMatchObject({ status: "known", sampleId: "samples/bbb" });
    expect(hits[2]).toEqual({ status: "unknown", sampleId: "samples/ccc" });
  });

  it("chunks a >100-id lookup and still returns correct hits", async () => {
    // Use a large publish cap so we can seed 150 rows, then verify the LOOKUP
    // itself chunks by the 100-bound-param limit.
    const db = new FakeD1() as unknown as D1Database;
    const index = new CloudflareGlobalSampleIndex(db, {
      ...OPTS,
      maxBatchSize: 200,
    });
    const ids = Array.from({ length: 150 }, (_, i) => `samples/s${i}`);
    const batch = ids.map((id, i) =>
      makeValidPublish({ sampleId: id, contentHash: `f${i}`.padStart(64, "a") }),
    );
    const outcome = await index.publishAnalysisResults(batch);
    expect(outcome.accepted).toBe(true);

    const hits = await index.lookupSamples(ids);
    expect(hits).toHaveLength(150);
    expect(hits.every((h) => h.status === "known")).toBe(true);
  });

  it("returns no hit for absent content identity", async () => {
    const { index } = makeIndex();
    const hits = await index.lookupContentIdentities([
      { contentHash: "f".repeat(64), contentHashVersion: "pcm-v1" },
    ]);
    expect(hits).toHaveLength(0);
  });
});

describe("CloudflareGlobalSampleIndex — map viewport", () => {
  it("returns bounded, deterministically-ordered points across the bbox", async () => {
    const { index } = makeIndex();
    // Two content identities with distinct map positions (from distinct feature sets).
    const p1 = makeValidPublish({
      sampleId: "samples/a1",
      contentHash: "1".repeat(64),
    });
    const p2 = makeValidPublish({
      sampleId: "samples/b2",
      contentHash: "2".repeat(64),
    });
    await index.publishAnalysisResults([p1, p2]);

    const result = await index.queryMapViewport({
      mapVersion: "map-v2",
      xMin: -10,
      xMax: 10,
      yMin: -10,
      yMax: 10,
      limit: 10,
    });
    expect(result.points).toHaveLength(2);
    expect(result.nextCursor).toBeUndefined();
    // Deterministic ordering by (map_y, map_x).
    const ys = result.points.map((p) => p.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it("paginates via cursor when more points exist than the limit", async () => {
    const { index } = makeIndex();
    // Publish 5 distinct contents.
    const batch = Array.from({ length: 5 }, (_, i) =>
      makeValidPublish({
        sampleId: `samples/m${i}`,
        contentHash: `ab${i}`.padEnd(64, "a"),
      }),
    );
    await index.publishAnalysisResults(batch);

    const page1 = await index.queryMapViewport({
      mapVersion: "map-v2",
      xMin: -10,
      xMax: 10,
      yMin: -10,
      yMax: 10,
      limit: 2,
    });
    expect(page1.points).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await index.queryMapViewport({
      mapVersion: "map-v2",
      xMin: -10,
      xMax: 10,
      yMin: -10,
      yMax: 10,
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.points).toHaveLength(2);

    const page3 = await index.queryMapViewport({
      mapVersion: "map-v2",
      xMin: -10,
      xMax: 10,
      yMin: -10,
      yMax: 10,
      limit: 2,
      cursor: page2.nextCursor,
    });
    expect(page3.points).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();
  });

  it("respects the hard cap and never returns more than maxMapLimit", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const writer = new CloudflareGlobalSampleIndex(db, { ...OPTS, maxBatchSize: 200 });
    const batch = Array.from({ length: 5 }, (_, i) =>
      makeValidPublish({
        sampleId: `samples/c${i}`,
        contentHash: `caf${i}`.padEnd(64, "a"),
      }),
    );
    await writer.publishAnalysisResults(batch);
    // Same database, but a reader capped at 3 per page.
    const capped = new CloudflareGlobalSampleIndex(db, {
      ...OPTS,
      maxMapLimit: 3,
    });
    const result = await capped.queryMapViewport({
      mapVersion: "map-v2",
      xMin: -10,
      xMax: 10,
      yMin: -10,
      yMax: 10,
      limit: 100,
    });
    expect(result.points.length).toBeLessThanOrEqual(3);
  });
});

// ─── STEP41 — compact V2 knowledge block round-trips through D1 ──────────────

describe("CloudflareGlobalSampleIndex — sound_character_v2", () => {
  it("stores the JSON block verbatim and returns it on both lookup paths", async () => {
    const { index } = makeIndex();
    const block = makeV2Block();
    const item = makeValidPublish({
      sampleId: "samples/v2",
      contentHash: "c".repeat(64),
      soundCharacterV2: block,
    });
    await index.publishAnalysisResults([item]);

    const sampleHit = await index.lookupSamples(["samples/v2"]);
    expect(sampleHit).toHaveLength(1);
    expect(sampleHit[0].status).toBe("known");
    if (sampleHit[0].status === "known") {
      expect(sampleHit[0].analysis.soundCharacterV2).toEqual(block);
      // The stored block butchers nothing: decode round-trips to the char.
      const char = decodeSoundCharacterFromBase64(sampleHit[0].analysis.soundCharacterV2!.packed)!;
      expect(char.brightness).toBeCloseTo(0.4, 4);
    }

    const contentHit = await index.lookupContentIdentities([
      { contentHash: "c".repeat(64), contentHashVersion: "pcm-v1" },
    ]);
    expect(contentHit).toHaveLength(1);
    expect(contentHit[0].analysis.soundCharacterV2).toEqual(block);
    expect(contentHit[0].analysis.soundCharacterV2!.codecVersion).toBe(SOUND_CHARACTER_CODEC_VERSION);
  });

  it("COALESCE backfill: re-publish with a DIFFERENT block keeps the stored block", async () => {
    const { index } = makeIndex();
    const first = makeV2Block();
    await index.publishAnalysisResults([
      makeValidPublish({
        sampleId: "samples/v2bf",
        contentHash: "d".repeat(64),
        soundCharacterV2: first,
      }),
    ]);

    // Same content re-published by a different sample with a DIFFERENT block.
    const differentBlock = makeV2Block({
      ...emptySoundCharacter(),
      brightness: 0.95,
    });
    const outcome = await index.publishAnalysisResults([
      makeValidPublish({
        sampleId: "samples/v2bf-2",
        contentHash: "d".repeat(64),
        soundCharacterV2: differentBlock,
      }),
    ]);
    expect(outcome.items.some((o) => o.status === "stored")).toBe(true);

    const [hit] = await index.lookupSamples(["samples/v2bf-2"]);
    expect(hit.status).toBe("known");
    if (hit.status === "known") {
      // Backfill-only: the block is NOT clobbered by the newer publish.
      expect(hit.analysis.soundCharacterV2).toEqual(first);
    }
  });

  it("re-publish WITHOUT a block preserves the stored block", async () => {
    const { index } = makeIndex();
    const block = makeV2Block();
    await index.publishAnalysisResults([
      makeValidPublish({ sampleId: "samples/v2keep", contentHash: "e".repeat(64), soundCharacterV2: block }),
    ]);
    await index.publishAnalysisResults([
      makeValidPublish({ sampleId: "samples/v2keep2", contentHash: "e".repeat(64) }),
    ]);
    const [hit] = await index.lookupSamples(["samples/v2keep"]);
    expect(hit.status).toBe("known");
    if (hit.status === "known") {
      expect(hit.analysis.soundCharacterV2!.codecVersion).toBe(block.codecVersion);
    }
  });

  it("a corrupt stored JSON block is omitted at read (no crash)", async () => {
    const { fake, index } = makeIndex();
    await index.publishAnalysisResults([
      makeValidPublish({ sampleId: "samples/v2corrupt", contentHash: "f".repeat(64), soundCharacterV2: makeV2Block() }),
    ]);
    // Corrupt the stored JSON directly in the fake DB.
    fake.corruptSoundCharacterV2("f".repeat(64));

    const [hit] = await index.lookupSamples(["samples/v2corrupt"]);
    expect(hit.status).toBe("known");
    if (hit.status === "known") {
      expect(hit.analysis.soundCharacterV2).toBeUndefined();
    }
  });
});
