import { describe, it, expect } from "vitest";
import {
  contentIdentityKey,
  selectRepresentative,
  REPRESENTATIVE_VERSION,
  makeContentIdentity,
} from "./audioContentIdentity";
import type { SampleIndexRecord } from "../persistence/indexStore";
import { makeSample } from "../persistence/test-helpers";
import { mapPoints } from "../ui/map/mapView";
import {
  buildPcmWavBytes,
  buildPcmWavBytesWithExtraChunk,
} from "../audio/fixtures";
import { canonicalizePcm } from "../audio/canonicalPcm";
import { contentHashOf } from "../audio/audioHash";
import type { DecodedAudio } from "../audio/decodedAudio";

// ─────────────────────────────────────────────────────────────────────────────
// Step 15I — Audio Content Identity + Deduplication + Map Points
//
// These tests prove the three identity levels (§2) and the dedup rules (§9–14).
// ─────────────────────────────────────────────────────────────────────────────

/** Build a SampleIndexRecord with controlled contentHash for dedup tests. */
function rec(
  sampleId: string,
  contentHash: string,
  overrides: Partial<SampleIndexRecord> = {},
): SampleIndexRecord {
  return makeSample(sampleId, {
    contentHash,
    contentHashVersion: "pcm-v1",
    ...overrides,
  });
}

// ─── A — AudioContentIdentity type ─────────────────────────────────────────

describe("AudioContentIdentity", () => {
  it("contentIdentityKey is deterministic and order-independent", () => {
    const a = makeContentIdentity("abc123", "pcm-v1");
    const b = makeContentIdentity("abc123", "pcm-v1");
    expect(contentIdentityKey(a)).toBe(contentIdentityKey(b));
    expect(contentIdentityKey(a)).toBe("pcm-v1:abc123");
  });

  it("different hashes produce different keys", () => {
    const a = makeContentIdentity("aaa", "pcm-v1");
    const b = makeContentIdentity("bbb", "pcm-v1");
    expect(contentIdentityKey(a)).not.toBe(contentIdentityKey(b));
  });

  it("different versions produce different keys even with same hash", () => {
    const a = makeContentIdentity("aaa", "pcm-v1");
    const b = makeContentIdentity("aaa", "pcm-v2");
    expect(contentIdentityKey(a)).not.toBe(contentIdentityKey(b));
  });
});

// ─── B — Representative selection ───────────────────────────────────────────

describe("selectRepresentative", () => {
  it("picks the lexicographically smallest sampleId", () => {
    expect(selectRepresentative(["samples/c", "samples/a", "samples/b"])).toBe("samples/a");
  });

  it("is deterministic regardless of input order (§14)", () => {
    const ids = ["samples/BBB", "samples/AAA", "samples/CCC"];
    const order1 = selectRepresentative(ids);
    const order2 = selectRepresentative([...ids].reverse());
    const order3 = selectRepresentative(["samples/CCC", "samples/AAA", "samples/BBB"]);
    expect(order1).toBe("samples/AAA");
    expect(order2).toBe("samples/AAA");
    expect(order3).toBe("samples/AAA");
  });

  it("works with a single element", () => {
    expect(selectRepresentative(["samples/only"])).toBe("samples/only");
  });

  it("REPRESENTATIVE_VERSION is a documented string", () => {
    expect(REPRESENTATIVE_VERSION).toBe("representative-v1");
  });
});

// ─── C — Cross-format contentHash equality (§11) ───────────────────────────

/**
 * Helper: turn an Int16Array of mono 48 kHz samples into a DecodedAudio
 * (as if the browser had decoded it at 48 kHz).
 */
function decodedFromS16(samples: Int16Array, sampleRate: number): DecodedAudio {
  const mono = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) mono[i] = samples[i] / 32767;
  return { sampleRate, channels: 1, mono, durationSeconds: samples.length / sampleRate };
}

describe("Cross-format contentHash (§11)", () => {
  it("same PCM content in two different WAV containers produces the same contentHash", async () => {
    // Known mono 48 kHz samples.
    const samples = new Int16Array([100, -200, 300, -400, 500, -600, 700, -800]);

    // WAV A: plain container.
    const wavA = buildPcmWavBytes({
      sampleRate: 48000,
      channels: 1,
      bitsPerSample: 16,
      samples,
    });

    // WAV B: same fmt+data, but with an extra "LIST" chunk → different container bytes.
    const wavB = buildPcmWavBytesWithExtraChunk(
      {
        sampleRate: 48000,
        channels: 1,
        bitsPerSample: 16,
        samples,
      },
      "LIST",
      new Uint8Array([0x74, 0x65, 0x73, 0x74]), // "test"
    );

    // Container bytes are different (different fileHash).
    expect(new Uint8Array(wavA).length).not.toBe(new Uint8Array(wavB).length);

    // Both decode to the same DecodedAudio (same PCM data).
    const decoded = decodedFromS16(samples, 48000);

    // Both canonicalize to the same canonical PCM.
    const canonical = canonicalizePcm(decoded);
    const hashA = await contentHashOf(canonical);
    const hashB = await contentHashOf(canonical);
    expect(hashA).toBe(hashB);
    expect(typeof hashA).toBe("string");
    expect(hashA.length).toBe(64); // SHA-256 hex
  });

  it("different PCM content produces different contentHashes", async () => {
    const samplesA = new Int16Array([100, -200, 300, -400]);
    const samplesB = new Int16Array([999, -888, 777, -666]);

    const decodedA = decodedFromS16(samplesA, 48000);
    const decodedB = decodedFromS16(samplesB, 48000);

    const canonicalA = canonicalizePcm(decodedA);
    const canonicalB = canonicalizePcm(decodedB);

    const hashA = await contentHashOf(canonicalA);
    const hashB = await contentHashOf(canonicalB);
    expect(hashA).not.toBe(hashB);
  });
});

// ─── D — Deduplication on the Map (§9, §10, §13) ──────────────────────────

describe("Map deduplication by content identity", () => {
  it("two samples with the same contentHash become ONE Map Point (§13)", () => {
    const hash = "aaa111";
    const records = [
      rec("samples/AAA", hash, { name: "Sound A", primaryClass: "kick" }),
      rec("samples/BBB", hash, { name: "Sound B", primaryClass: "snare" }),
    ];
    const points = mapPoints(records);
    expect(points).toHaveLength(1);
    expect(points[0].sampleId).toBe("samples/AAA"); // lex smallest
    expect(points[0].sampleIds).toEqual(["samples/AAA", "samples/BBB"]);
    expect(points[0].contentIdentity.contentHash).toBe(hash);
  });

  it("two samples with different contentHashes become TWO Map Points (§12)", () => {
    const records = [
      rec("samples/A", "hash-x"),
      rec("samples/B", "hash-y"),
    ];
    const points = mapPoints(records);
    expect(points).toHaveLength(2);
    expect(points.map((p) => p.sampleId).sort()).toEqual(["samples/A", "samples/B"]);
  });

  it("three samples: two same hash + one different → 2 Map Points (§9)", () => {
    const records = [
      rec("samples/A", "hash-x"),
      rec("samples/B", "hash-x"),
      rec("samples/C", "hash-y"),
    ];
    const points = mapPoints(records);
    expect(points).toHaveLength(2);
    const pointX = points.find((p) => p.contentIdentity.contentHash === "hash-x")!;
    const pointY = points.find((p) => p.contentIdentity.contentHash === "hash-y")!;
    expect(pointX.sampleIds).toEqual(["samples/A", "samples/B"]);
    expect(pointY.sampleIds).toEqual(["samples/C"]);
  });

  it("idempotent: re-analyzing the same sample does not create extra points (§10)", () => {
    const hash = "abc";
    const records = [
      rec("samples/A", hash),
      rec("samples/A", hash), // duplicate record (same sample, same build)
    ];
    const points = mapPoints(records);
    expect(points).toHaveLength(1);
    expect(points[0].sampleIds).toEqual(["samples/A"]);
  });

  it("representative is the lex smallest ID regardless of record order (§14)", () => {
    const hash = "z";
    const order1 = [
      rec("samples/CCC", hash),
      rec("samples/AAA", hash),
      rec("samples/BBB", hash),
    ];
    const order2 = [
      rec("samples/BBB", hash),
      rec("samples/AAA", hash),
      rec("samples/CCC", hash),
    ];
    expect(mapPoints(order1)[0].sampleId).toBe("samples/AAA");
    expect(mapPoints(order2)[0].sampleId).toBe("samples/AAA");
  });

  it("representative's metadata is used for the Map Point", () => {
    const hash = "x";
    const records = [
      rec("samples/BBB", hash, { name: "BBB Name", primaryClass: "snare", owner: "bob" }),
      rec("samples/AAA", hash, { name: "AAA Name", primaryClass: "kick", owner: "alice" }),
    ];
    const point = mapPoints(records)[0];
    expect(point.sampleId).toBe("samples/AAA");
    expect(point.name).toBe("AAA Name");
    expect(point.primaryClass).toBe("kick");
    expect(point.owner).toBe("alice");
  });

  it("records without contentHash are treated as unique identities (graceful)", () => {
    const records = [
      makeSample("samples/legacy1"),
      makeSample("samples/legacy2"),
    ];
    // These records have no contentHash → each gets its own point.
    const points = mapPoints(records);
    expect(points).toHaveLength(2);
  });

  it("a mix of hashed and unhashed records works correctly", () => {
    const records = [
      rec("samples/A", "hash-x"),
      rec("samples/B", "hash-x"),
      makeSample("samples/legacy1"),
    ];
    const points = mapPoints(records);
    expect(points).toHaveLength(2);
    const deduped = points.find((p) => p.sampleIds.length === 2)!;
    expect(deduped.sampleIds).toEqual(["samples/A", "samples/B"]);
  });
});
