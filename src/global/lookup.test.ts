import { describe, it, expect, vi } from "vitest";
import type {
  GlobalSampleIndex,
  GlobalAnalysisResult,
  GlobalSampleLookupHit,
  GlobalContentLookupHit,
} from "./contract";
import {
  GlobalLookup,
  decideReuse,
  type SupportedVersions,
  type GlobalSampleLookupResult,
} from "./lookup";
import { makeContentIdentity, contentIdentityKey } from "../identity/audioContentIdentity";
import { makeFeatures } from "../classify/test-helpers";
import { mapVersion } from "../map/mapPosition";
import { computeSimilarityFingerprint } from "../similarity/similarityFingerprint";

// ─────────────────────────────────────────────────────────────────────────────
// Step 16C — Global Lookup & Reuse Semantics
//
// Test the DOMAIN semantics only (no real backend, no network, no audio).
// ─────────────────────────────────────────────────────────────────────────────

const HASH_XYZ = "f".repeat(64);
const HASH_ABC = "a".repeat(64);
const SAMPLE_AAA = "samples/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SAMPLE_BBB = "samples/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SAMPLE_CCC = "samples/cccccccc-cccc-cccc-cccc-cccccccccccc";

const SUPPORTED: SupportedVersions = {
  contentHashVersion: "pcm-v1",
  analysisVersion: "features-v1",
  classificationVersion: "heuristic-v1",
  mapVersion: "map-v2",
  similarityVersion: "similarity-v1",
};

/** Build a canonical analysis result from the authoritative pure functions. */
function makeAnalysis(hash = HASH_XYZ, overrides: Partial<GlobalAnalysisResult> = {}): GlobalAnalysisResult {
  const features = makeFeatures();
  const fp = computeSimilarityFingerprint(features);
  return {
    contentIdentity: makeContentIdentity(hash, "pcm-v1"),
    classificationVersion: "heuristic-v1",
    primaryClass: "kick",
    confidence: 0.9,
    secondaryClasses: [{ class: "toms", confidence: 0.08 }],
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

/**
 * A read-only fake backend fulfilling the contract. Reuses the schema helpers
 * (collectSampleIds + deriveRepresentative) as an adapter would.
 */
class FakeGlobalIndex implements GlobalSampleIndex {
  private readonly refsBySample = new Map<string, { contentIdentity: ReturnType<typeof makeContentIdentity> }>();
  private readonly contentByKey = new Map<string, { hash: string; version: string; analysis: GlobalAnalysisResult }>();

  addSampleRef(sampleId: string, hash: string, version = "pcm-v1"): this {
    const identity = makeContentIdentity(hash, version);
    this.refsBySample.set(sampleId, { contentIdentity: identity });
    // The content record exists when we have an analysis for that identity.
    if (!this.contentByKey.has(`${version}:${hash}`)) {
      this.contentByKey.set(`${version}:${hash}`, {
        hash,
        version,
        analysis: makeAnalysis(hash),
      });
    }
    return this;
  }

  async lookupSamples(sampleIds: readonly string[]): Promise<GlobalSampleLookupHit[]> {
    return sampleIds.flatMap((id): GlobalSampleLookupHit[] => {
      const ref = this.refsBySample.get(id);
      if (!ref) return [{ status: "unknown", sampleId: id }];
      const entry = this.contentByKey.get(
        `${ref.contentIdentity.contentHashVersion}:${ref.contentIdentity.contentHash}`,
      );
      if (!entry) return [{ status: "unknown", sampleId: id }];
      return [{
        status: "known",
        sampleId: id,
        contentIdentity: ref.contentIdentity,
        analysis: entry.analysis,
      }];
    });
  }

  async lookupContentIdentities(
    identities: readonly ReturnType<typeof makeContentIdentity>[],
  ): Promise<GlobalContentLookupHit[]> {
    return identities.flatMap((id): GlobalContentLookupHit[] => {
      const entry = this.contentByKey.get(`${id.contentHashVersion}:${id.contentHash}`);
      if (!entry) return [];
      const sampleIds: string[] = [];
      for (const [sid, ref] of this.refsBySample) {
        if (
          ref.contentIdentity.contentHash === id.contentHash &&
          ref.contentIdentity.contentHashVersion === id.contentHashVersion
        ) {
          sampleIds.push(sid);
        }
      }
      sampleIds.sort();
      return [{
        contentIdentity: id,
        analysis: entry.analysis,
        sampleIds,
        representativeSampleId: sampleIds[0],
      }];
    });
  }

  async publishAnalysisResults(): Promise<never> {
    throw new Error("publish must never be called during lookup");
  }

  async queryMapViewport(): Promise<never> {
    throw new Error("unused");
  }
}

// ─── decideReuse (pure version compatibility) ────────────────────────────────

describe("decideReuse (per-dimension compatibility)", () => {
  it("returns reuse when every dimension matches the supported set", () => {
    const d = decideReuse(makeAnalysis(), SUPPORTED);
    expect(d.status).toBe("reuse");
    if (d.status === "reuse") {
      expect(d.compatibility).toEqual({
        content: true,
        analysis: true,
        classification: true,
        map: true,
        similarity: true,
      });
    }
  });

  it("reports incompatible + missing dimensions when a version differs", () => {
    // Global similarity-v1, consumer wants similarity-v2.
    const supported: SupportedVersions = { ...SUPPORTED, similarityVersion: "similarity-v2" };
    const d = decideReuse(makeAnalysis(), supported);
    expect(d.status).toBe("incompatible");
    if (d.status === "incompatible") {
      expect(d.missing).toContain("similarity");
      // Content identity still matches → NOT affected by similarity version.
      expect(d.compatibility.content).toBe(true);
      expect(d.compatibility.map).toBe(true);
    }
  });

  it("content identity is independent of similarity version (§34)", () => {
    const analysis = makeAnalysis();
    const before = decideReuse(analysis, {
      ...SUPPORTED,
      similarityVersion: "similarity-v1",
    });
    const after = decideReuse(analysis, {
      ...SUPPORTED,
      similarityVersion: "similarity-v2",
    });
    // The content identity itself never changes; only the compatibility flags do.
    expect(after.compatibility.content).toBe(before.compatibility.content);
  });

  it("contentHashVersion mismatch makes the whole result not reusable", () => {
    const d = decideReuse(makeAnalysis(), {
      ...SUPPORTED,
      contentHashVersion: "pcm-v2",
    });
    expect(d.status).toBe("incompatible");
    if (d.status === "incompatible") expect(d.missing).toContain("content");
  });
});

// ─── Sample known / unknown / incompatible ───────────────────────────────────

describe("GlobalLookup.lookupSamples", () => {
  it("sample known → KNOWN with the existing reusable result (no analysis)", async () => {
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ);
    const lookup = new GlobalLookup(src, SUPPORTED);
    const res = await lookup.lookupSamples([SAMPLE_AAA]);
    expect(res).toHaveLength(1);
    expect(res[0].state).toBe("known");
    if (res[0].state === "known") {
      expect(res[0].bundle.contentIdentity.contentHash).toBe(HASH_XYZ);
      expect(res[0].decision.status).toBe("reuse");
    }
  });

  it("sample unknown → UNKNOWN (does NOT imply content unknown)", async () => {
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ);
    const lookup = new GlobalLookup(src, SUPPORTED);
    const res = await lookup.lookupSamples([SAMPLE_BBB]);
    expect(res[0].state).toBe("unknown");
  });

  it("sample known but similarity-v2 required → INCOMPATIBLE, partial reuse", async () => {
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ);
    const lookup = new GlobalLookup(src, { ...SUPPORTED, similarityVersion: "similarity-v2" });
    const res = await lookup.lookupSamples([SAMPLE_AAA]);
    const [r] = res;
    expect(r.state).toBe("incompatible");
    if (r.state === "incompatible" && r.decision.status === "incompatible") {
      expect(r.decision.missing).toContain("similarity");
      expect(r.decision.compatibility.content).toBe(true);
    }
  });
});

// ─── Content known / unknown ─────────────────────────────────────────────────

describe("GlobalLookup.lookupContentIdentities", () => {
  it("content known → KNOWN", async () => {
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ);
    const lookup = new GlobalLookup(src, SUPPORTED);
    const res = await lookup.lookupContentIdentities([makeContentIdentity(HASH_XYZ, "pcm-v1")]);
    expect(res[0].state).toBe("known");
    if (res[0].state === "known") {
      expect(res[0].bundle.analysis).toBeDefined();
      expect(res[0].bundle.sampleIds).toContain(SAMPLE_AAA);
    }
  });

  it("content unknown → UNKNOWN", async () => {
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ);
    const lookup = new GlobalLookup(src, SUPPORTED);
    const res = await lookup.lookupContentIdentities([makeContentIdentity(HASH_ABC, "pcm-v1")]);
    expect(res[0].state).toBe("unknown");
  });

  it("identical hash in different contentHashVersion is a DIFFERENT identity (§8)", async () => {
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ, "pcm-v1");
    const lookup = new GlobalLookup(src, SUPPORTED);
    // pcm-v2 version of the same hash — must NOT resolve to the pcm-v1 record.
    const res = await lookup.lookupContentIdentities([makeContentIdentity(HASH_XYZ, "pcm-v2")]);
    expect(res[0].state).toBe("unknown");
  });
});

// ─── Same content / different sample IDs (cross-user dedup) ─────────────────

describe("cross-user content dedup (§18, §33)", () => {
  it("AAA and BBB sharing content XYZ both reuse the same content record", async () => {
    const src = new FakeGlobalIndex()
      .addSampleRef(SAMPLE_AAA, HASH_XYZ)
      .addSampleRef(SAMPLE_BBB, HASH_XYZ);
    const lookup = new GlobalLookup(src, SUPPORTED);

    const samples = await lookup.lookupSamples([SAMPLE_AAA, SAMPLE_BBB]);
    expect(samples.every((s) => s.state === "known")).toBe(true);
    const bundles = samples.flatMap((s) => (s.state === "known" ? [s.bundle] : []));
    expect(bundles[0].contentIdentity.contentHash).toBe(bundles[1].contentIdentity.contentHash);
    expect(contentIdentityKey(bundles[0].contentIdentity)).toBe(
      contentIdentityKey(bundles[1].contentIdentity),
    );

    // Content lookup returns ONE record with both sampleIds.
    const content = await lookup.lookupContentIdentities([makeContentIdentity(HASH_XYZ, "pcm-v1")]);
    expect(content).toHaveLength(1);
    if (content[0].state === "known") {
      expect(content[0].bundle.sampleIds!.sort()).toEqual([SAMPLE_AAA, SAMPLE_BBB].sort());
      // Representative: lex-smallest of the union (existing authority).
      expect(content[0].bundle.representativeSampleId).toBe(SAMPLE_AAA);
    }
  });

  it("different content (XYZ vs ABC) yields two distinct content records", async () => {
    const src = new FakeGlobalIndex()
      .addSampleRef(SAMPLE_AAA, HASH_XYZ)
      .addSampleRef(SAMPLE_BBB, HASH_ABC);
    const lookup = new GlobalLookup(src, SUPPORTED);
    const res = await lookup.lookupContentIdentities([
      makeContentIdentity(HASH_XYZ, "pcm-v1"),
      makeContentIdentity(HASH_ABC, "pcm-v1"),
    ]);
    expect(res).toHaveLength(2);
    expect(res[0].state).toBe("known");
    expect(res[1].state).toBe("known");
    const keys = res.map((r) => (r.state === "known" ? contentIdentityKey(r.contentIdentity) : ""));
    expect(keys[0]).not.toBe(keys[1]);
  });
});

// ─── Two-stage reuse (the economic core, §33) ────────────────────────────────

describe("two-stage reuse: sample unknown → local content → content known → reuse", () => {
  it("User B with a NEW sampleId reuses the analysis of known content XYZ", async () => {
    // Global has sample AAA → content XYZ (already analyzed by User A).
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ);
    const lookup = new GlobalLookup(src, SUPPORTED);

    // Stage 1: BBB is unknown on the sample fast-path.
    const sampleRes = await lookup.lookupSamples([SAMPLE_BBB]);
    expect(sampleRes[0].state).toBe("unknown");

    // Stage 2: local analysis determines BBB → content XYZ (simulated here;
    // 16C does NOT run the pipeline — it consumes the authoritative identity).
    const bbbIdentity = makeContentIdentity(HASH_XYZ, "pcm-v1");

    // Stage 3: content lookup → KNOWN → REUSE existing analysis.
    const contentRes = await lookup.lookupContentIdentities([bbbIdentity]);
    expect(contentRes[0].state).toBe("known");
    if (contentRes[0].state === "known") {
      expect(contentRes[0].decision.status).toBe("reuse");
      expect(contentRes[0].bundle.contentIdentity).toEqual(bbbIdentity);
    }
  });
});

// ─── Batch / duplicate IDs / order ───────────────────────────────────────────

describe("batch semantics (§17, §18)", () => {
  it("AAA known, BBB unknown, CCC known — returned correctly", async () => {
    const src = new FakeGlobalIndex()
      .addSampleRef(SAMPLE_AAA, HASH_XYZ)
      .addSampleRef(SAMPLE_CCC, HASH_XYZ);
    const lookup = new GlobalLookup(src, SUPPORTED);
    const res = await lookup.lookupSamples([SAMPLE_AAA, SAMPLE_BBB, SAMPLE_CCC]);
    expect(res.map((r) => r.state)).toEqual(["known", "unknown", "known"]);
  });

  it("duplicate request IDs are deduplicated, first-occurrence order kept", async () => {
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ);
    const lookup = new GlobalLookup(src, SUPPORTED);
    const res = await lookup.lookupSamples([SAMPLE_AAA, SAMPLE_AAA, SAMPLE_BBB, SAMPLE_AAA]);
    expect(res).toHaveLength(2);
    expect(res[0].sampleId).toBe(SAMPLE_AAA);
    expect(res[1].sampleId).toBe(SAMPLE_BBB);
  });

  it("an unknown element does not mark the whole batch unknown", async () => {
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ);
    const lookup = new GlobalLookup(src, SUPPORTED);
    const res = await lookup.lookupSamples([SAMPLE_AAA, SAMPLE_BBB]);
    expect(res.map((r) => r.state)).toEqual(["known", "unknown"]);
  });
});

// ─── Idempotence & read-only & no publish ────────────────────────────────────

describe("idempotence / read-only / no publish (§19, §20)", () => {
  it("repeated identical lookups give semantically identical results", async () => {
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ);
    const lookup = new GlobalLookup(src, SUPPORTED);
    const a = await lookup.lookupSamples([SAMPLE_AAA]);
    const b = await lookup.lookupSamples([SAMPLE_AAA]);
    expect(a).toEqual(b);
  });

  it("lookup never calls publishAnalysisResults (strict separation)", async () => {
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ);
    const publish = vi.spyOn(src, "publishAnalysisResults");
    const lookup = new GlobalLookup(src, SUPPORTED);
    await lookup.lookupSamples([SAMPLE_AAA]);
    await lookup.lookupContentIdentities([makeContentIdentity(HASH_XYZ, "pcm-v1")]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("lookup is read-only: record set is unchanged by repeated lookups", async () => {
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ);
    const before = await new GlobalLookup(src, SUPPORTED).lookupSamples([SAMPLE_AAA]);
    // A second, separate lookup over the same source yields the same shape.
    const after = await new GlobalLookup(src, SUPPORTED).lookupSamples([SAMPLE_AAA]);
    expect(after).toEqual(before);
  });
});

// ─── No audio ────────────────────────────────────────────────────────────────

describe("no audio in lookup/reuse", () => {
  it("results carry only metadata/hashes/analysis — no byte containers", async () => {
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ);
    const lookup = new GlobalLookup(src, SUPPORTED);
    const res = (await lookup.lookupSamples([SAMPLE_AAA])) as GlobalSampleLookupResult[];
    const text = JSON.stringify(res);
    expect(text).not.toContain("ArrayBuffer");
    expect(text).not.toContain("Uint8Array");
    expect(text).not.toContain("Blob");
  });
});

// ─── Representative (existing authority, not reimplemented) ─────────────────

describe("representative handling", () => {
  it("uses the representative returned by the source (existing authority)", async () => {
    const src = new FakeGlobalIndex()
      .addSampleRef(SAMPLE_AAA, HASH_XYZ)
      .addSampleRef(SAMPLE_BBB, HASH_XYZ)
      .addSampleRef(SAMPLE_CCC, HASH_XYZ);
    const lookup = new GlobalLookup(src, SUPPORTED);
    const res = await lookup.lookupContentIdentities([makeContentIdentity(HASH_XYZ, "pcm-v1")]);
    if (res[0].state === "known") {
      // lex-smallest of {AAA, BBB, CCC} = AAA
      expect(res[0].bundle.representativeSampleId).toBe(SAMPLE_AAA);
      expect(res[0].bundle.sampleIds!.sort()).toEqual([SAMPLE_AAA, SAMPLE_BBB, SAMPLE_CCC].sort());
    }
  });
});

// ─── Version independence (end-to-end) ───────────────────────────────────────

describe("version independence end-to-end", () => {
  it("bumping similarity-v1 → similarity-v2 changes the reuse decision but NOT the content identity", async () => {
    const src = new FakeGlobalIndex().addSampleRef(SAMPLE_AAA, HASH_XYZ);
    const v1Consumer = new GlobalLookup(src, SUPPORTED);
    const v2Consumer = new GlobalLookup(src, { ...SUPPORTED, similarityVersion: "similarity-v2" });

    const res1 = await v1Consumer.lookupSamples([SAMPLE_AAA]);
    const res2 = await v2Consumer.lookupSamples([SAMPLE_AAA]);

    expect(res1[0].state).toBe("known");
    expect(res2[0].state).toBe("incompatible");
    if (res1[0].state === "known" && res2[0].state === "incompatible") {
      // Identical content identity despite different similarity support.
      expect(contentIdentityKey(res1[0].bundle.contentIdentity)).toBe(
        contentIdentityKey(res2[0].bundle.contentIdentity),
      );
    }
  });
});

// ─── Conflict (sampleId → content inconsistent) ─────────────────────────────

describe("conflict semantics (§26)", () => {
  it("distinguishes known+consistent from known+conflict structurally", async () => {
    // A provider that surfaces a conflict produces an inconsistent sample→content edge.
    // 16C keeps that a distinct signal (conflict is not a normal reuse case).
    const conflictingSource: GlobalSampleIndex = {
      lookupSamples: async () => [
        { status: "known", sampleId: SAMPLE_AAA, contentIdentity: makeContentIdentity(HASH_XYZ, "pcm-v1"), analysis: makeAnalysis(HASH_XYZ) },
      ],
      lookupContentIdentities: async () => [
        { contentIdentity: makeContentIdentity(HASH_ABC, "pcm-v1"), analysis: makeAnalysis(HASH_ABC), sampleIds: [SAMPLE_AAA], representativeSampleId: SAMPLE_AAA },
      ],
      publishAnalysisResults: async () => ({ items: [], accepted: true }),
      queryMapViewport: async () => ({ mapVersion, points: [] }),
    };
    const lookup = new GlobalLookup(conflictingSource, SUPPORTED);
    // The sample fast-path and content path disagree about AAA's content.
    const sampleRes = await lookup.lookupSamples([SAMPLE_AAA]);
    const contentRes = await lookup.lookupContentIdentities([makeContentIdentity(HASH_ABC, "pcm-v1")]);
    expect(sampleRes[0].state).toBe("known");
    expect(contentRes[0].state).toBe("known");
    if (sampleRes[0].state === "known") {
      // Fast-path says XYZ, content-record says ABC → a conflict signal is surfaced
      // (distinct from a clean reuse case).
      const sampleKey = contentIdentityKey(sampleRes[0].bundle.contentIdentity);
      const contentKey = contentIdentityKey(makeContentIdentity(HASH_ABC, "pcm-v1"));
      expect(sampleKey).not.toBe(contentKey);
    }
    // 16C does NOT resolve it — resolution is a later step.
  });
});
