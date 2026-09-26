import { describe, it, expect } from "vitest";
import {
  mapVersion,
  SIMILARITY_VERSION,
  REPRESENTATIVE_VERSION,
  collectSampleIds,
  deriveRepresentative,
  detectSampleIdConflicts,
  type GlobalSampleRefRecord,
  type GlobalContentRecord,
  type GlobalAnalysisRecord,
  type GlobalVersionSet,
} from "./schema";
import {
  validateSampleRefRecord,
  validateContentRecord,
  isValidContentHash,
} from "./schemaValidation";
import { contentIdentityKey, makeContentIdentity } from "../identity/audioContentIdentity";
import { makeFeatures } from "../classify/test-helpers";
import { computeSimilarityFingerprint } from "../similarity/similarityFingerprint";
import {
  SOUND_CHARACTER_CODEC_VERSION,
  encodeSoundCharacterToBase64,
} from "./soundCharacterCodec";
import { SIMILARITY_ALGORITHM_VERSION } from "../analysis/similarityEngine";
import { SOUND_SPACE_ALGORITHM_VERSION } from "../analysis/soundSpaceProjector";
import { emptySoundCharacter, type SoundCharacter } from "../analysis/soundCharacter";
import type { GlobalSoundCharacterKnowledge } from "./contract";

// ─────────────────────────────────────────────────────────────────────────────
// Step 16B — Global Record Schema
// ─────────────────────────────────────────────────────────────────────────────

const HASH_XYZ = "f".repeat(64);
const HASH_ABC = "a".repeat(64);
const REF_A = "samples/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const REF_B = "samples/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

/** A valid analysis record derived from real (pure) authorities. */
function makeAnalysis(overrides: Partial<GlobalAnalysisRecord> = {}): GlobalAnalysisRecord {
  const features = makeFeatures();
  const fp = computeSimilarityFingerprint(features);
  return {
    classification: {
      classificationVersion: "heuristic-v1",
      primaryClass: "kick",
      confidence: 0.9,
      secondaryClasses: [{ class: "toms", confidence: 0.08 }],
    },
    // V2: map is a PERSISTED analysis result (computed once from decoded audio),
    // NOT reconstructed from features downstream.
    map: { mapVersion, position: { x: 0.4, y: 0.6 } },
    similarity: fp,
    analysisVersion: "features-v1",
    analysisBuild: "build-v1",
    analysisSourceFormat: "wav",
    gatePassed: true,
    ...overrides,
  };
}

function makeVersions(overrides: Partial<GlobalVersionSet> = {}): GlobalVersionSet {
  return {
    contentHashVersion: "pcm-v1",
    analysisVersion: "features-v1",
    analysisBuild: "build-v1",
    classificationVersion: "heuristic-v1",
    mapVersion,
    similarityVersion: SIMILARITY_VERSION,
    representativeVersion: REPRESENTATIVE_VERSION,
    ...overrides,
  };
}

function makeContent(hash = HASH_XYZ, overrides: Partial<GlobalContentRecord> = {}): GlobalContentRecord {
  return {
    kind: "content",
    contentIdentity: makeContentIdentity(hash, "pcm-v1"),
    analysis: makeAnalysis(),
    features: makeFeatures(),
    versions: makeVersions(),
    firstPublishedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRef(sampleId: string, hash = HASH_XYZ, publishedAt = "2026-01-01T00:00:00.000Z"): GlobalSampleRefRecord {
  return {
    kind: "sample_ref",
    sampleId,
    contentIdentity: makeContentIdentity(hash, "pcm-v1"),
    publishedAt,
  };
}

// ─── Identity ────────────────────────────────────────────────────────────────

describe("content identity (property/invariant)", () => {
  it("same contentHash + version ⇒ same identity key", () => {
    expect(contentIdentityKey(makeContentIdentity(HASH_XYZ, "pcm-v1"))).toBe(
      contentIdentityKey(makeContentIdentity(HASH_XYZ, "pcm-v1")),
    );
  });

  it("different contentHash ⇒ different identity key", () => {
    expect(contentIdentityKey(makeContentIdentity(HASH_XYZ, "pcm-v1"))).not.toBe(
      contentIdentityKey(makeContentIdentity(HASH_ABC, "pcm-v1")),
    );
  });

  it("different contentHashVersion ⇒ different identity namespace", () => {
    expect(contentIdentityKey(makeContentIdentity(HASH_XYZ, "pcm-v1"))).not.toBe(
      contentIdentityKey(makeContentIdentity(HASH_XYZ, "pcm-v2")),
    );
  });

  it("similarityVersion does NOT influence the content identity", () => {
    // Bump similarity only — identity key (from hash+version) is unchanged.
    const content1 = makeContent();
    const content2 = makeContent(undefined, {
      analysis: makeAnalysis({
        similarity: {
          similarityVersion: "similarity-v2" as typeof SIMILARITY_VERSION,
          values: content1.analysis.similarity.values,
        },
      }),
      versions: makeVersions({ similarityVersion: "similarity-v2" }),
    });
    expect(contentIdentityKey(content1.contentIdentity)).toBe(
      contentIdentityKey(content2.contentIdentity),
    );
  });
});

// ─── Multiple references → one content ───────────────────────────────────────

describe("sample_ref → content (multi-reference)", () => {
  it("AAA and BBB may reference the same content identity", () => {
    const refs = [makeRef(REF_A), makeRef(REF_B)];
    const byContent = collectSampleIds(refs);
    const key = contentIdentityKey(makeContentIdentity(HASH_XYZ, "pcm-v1"));
    expect(byContent.get(key)!.sort()).toEqual([REF_A, REF_B].sort());
  });

  it("different samples → different content stay separate", () => {
    const refs = [makeRef(REF_A, HASH_XYZ), makeRef(REF_B, HASH_ABC)];
    const byContent = collectSampleIds(refs);
    expect(byContent.size).toBe(2);
  });

  it("deriveRepresentative picks the lex-smallest sampleId (delegates, no reimpl)", () => {
    // REF_A ("aaaa...") is lexicographically smaller than REF_B ("bbbb...").
    expect(deriveRepresentative([makeRef(REF_A), makeRef(REF_B)])).toBe(REF_A);
    expect(deriveRepresentative([])).toBeUndefined();
  });
});

// ─── Analysis serialization ──────────────────────────────────────────────────

describe("analysis serialization", () => {
  it("a content record serializes cleanly through JSON (no runtime-only objects)", () => {
    const record = makeContent();
    const json = JSON.stringify(record);
    const parsed = JSON.parse(json) as GlobalContentRecord;
    expect(parsed).toEqual(record);
    expect(typeof parsed.firstPublishedAt).toBe("string");
  });

  it("content record has no audio/DOM/Map fields", () => {
    const record = makeContent();
    const keys = Object.keys(record);
    expect(keys.sort()).toEqual(
      ["kind", "contentIdentity", "analysis", "features", "versions", "firstPublishedAt"].sort(),
    );
    // No raw-audio field, no volatile metadata (name/tags/owner/visibility).
    expect(keys).not.toContain("audio");
    expect(keys).not.toContain("bytes");
    expect(keys).not.toContain("owner");
    expect(keys).not.toContain("name");
    expect(keys).not.toContain("originalTags");
  });
});

// ─── Map ─────────────────────────────────────────────────────────────────────

describe("map data", () => {
  it("transports mapVersion WITH coordinates (no bare x/y)", () => {
    const a = makeAnalysis();
    expect(a.map.mapVersion).toBe("map-v2");
    expect(Number.isFinite(a.map.position.x)).toBe(true);
    expect(Number.isFinite(a.map.position.y)).toBe(true);
  });
});

// ─── Similarity ──────────────────────────────────────────────────────────────

describe("similarity data", () => {
  it("transports similarityVersion WITH the fingerprint", () => {
    const a = makeAnalysis();
    expect(a.similarity.similarityVersion).toBe("similarity-v1");
    expect(a.similarity.values).toHaveLength(8);
  });
});

// ─── No audio ────────────────────────────────────────────────────────────────

describe("no audio invariant", () => {
  it("a valid content/sample_ref record passes no-audio + structural checks", () => {
    expect(validateContentRecord(makeContent())).toEqual([]);
    expect(validateSampleRefRecord(makeRef(REF_A))).toEqual([]);
  });

  it("content record rejects a byte container (ArrayBuffer)", () => {
    const record = makeContent();
    (record as unknown as { bytes: ArrayBuffer }).bytes = new ArrayBuffer(16);
    expect(() => validateContentRecord(record)).toThrow(/audio byte container/);
  });

  it("sample_ref record rejects raw PCM (Uint8Array)", () => {
    const ref = makeRef(REF_A);
    (ref as unknown as { pcm: Uint8Array }).pcm = new Uint8Array(4);
    expect(() => validateSampleRefRecord(ref)).toThrow(/typed array/);
  });
});

// ─── Invalid records ─────────────────────────────────────────────────────────

describe("invalid records", () => {
  it("rejects missing/invalid sampleId (not a samples/{uuid})", () => {
    const issues = validateSampleRefRecord(makeRef("not-a-sample-id") as GlobalSampleRefRecord);
    expect(issues.some((i) => i.path === "sampleId")).toBe(true);
  });

  it("rejects an invalid contentHash shape", () => {
    const issues = validateContentRecord(makeContent("short"));
    expect(issues.some((i) => i.path === "contentIdentity.contentHash")).toBe(true);
  });

  it("rejects a missing contentHashVersion", () => {
    const record = makeContent();
    record.contentIdentity = makeContentIdentity(HASH_XYZ, "");
    const issues = validateContentRecord(record);
    expect(issues.some((i) => i.path === "contentIdentity.contentHashVersion")).toBe(true);
  });

  it("rejects invalid map coordinates (out of [0,1] or NaN)", () => {
    const record = makeContent();
    record.analysis.map = { mapVersion, position: { x: 1.5, y: NaN } };
    const issues = validateContentRecord(record);
    expect(issues.some((i) => i.path === "analysis.map.position.x")).toBe(true);
    expect(issues.some((i) => i.path === "analysis.map.position.y")).toBe(true);
  });

  it("rejects an invalid fingerprint (bad version or out-of-range values)", () => {
    const badVersion = makeContent();
    badVersion.analysis.similarity = {
      similarityVersion: "similarity-v2" as typeof SIMILARITY_VERSION,
      values: [0, 0, 0, 0, 0, 0, 0, 0],
    };
    const issues = validateContentRecord(badVersion);
    expect(issues.some((i) => i.path === "analysis.similarity.similarityVersion")).toBe(true);

    const badValues = makeContent();
    badValues.analysis.similarity = {
      similarityVersion: SIMILARITY_VERSION,
      values: [0, 0, 1.7, 0, 0, 0, 0, 0],
    };
    const issues2 = validateContentRecord(badValues);
    expect(issues2.some((i) => i.path === "analysis.similarity.values")).toBe(true);
  });

  it("rejects a missing required version (versions inconsistent with analysis)", () => {
    const record = makeContent();
    record.versions.mapVersion = "map-v9"; // disagrees with analysis.map.mapVersion (map-v2)
    const issues = validateContentRecord(record);
    expect(issues.some((i) => i.path === "versions.mapVersion")).toBe(true);
  });

  it("rejects unknown primaryClass / bad confidence", () => {
    const record = makeContent();
    record.analysis.classification.primaryClass = "bogus" as "kick";
    record.analysis.classification.confidence = 2;
    const issues = validateContentRecord(record);
    expect(issues.some((i) => i.path === "analysis.classification.primaryClass")).toBe(true);
    expect(issues.some((i) => i.path === "analysis.classification.confidence")).toBe(true);
  });
});

// ─── Version independence (data-level) ───────────────────────────────────────

describe("version independence in the schema", () => {
  it("bumping similarity-v1 → similarity-v2 does not alter contentHash", () => {
    const v1 = makeContent();
    const v2 = makeContent(undefined, {
      versions: makeVersions({ similarityVersion: "similarity-v2" }),
      analysis: makeAnalysis({
        similarity: { similarityVersion: "similarity-v2" as typeof SIMILARITY_VERSION, values: v1.analysis.similarity.values },
      }),
    });
    expect(v1.contentIdentity.contentHash).toBe(v2.contentIdentity.contentHash);
    expect(v1.versions.similarityVersion).not.toBe(v2.versions.similarityVersion);
  });
});

// ─── Conflict detection ──────────────────────────────────────────────────────

describe("sampleId conflict detection (§24)", () => {
  it("detects the same sampleId mapped to two different content identities", () => {
    const conflict = detectSampleIdConflicts([makeRef(REF_A, HASH_XYZ), makeRef(REF_A, HASH_ABC)]);
    expect(conflict).toHaveLength(1);
    expect(conflict[0].sampleId).toBe(REF_A);
    expect(conflict[0].contentIdentities).toHaveLength(2);
  });

  it("reports no conflict when each sampleId maps to exactly one identity", () => {
    const conflicts = detectSampleIdConflicts([makeRef(REF_A, HASH_XYZ), makeRef(REF_B, HASH_XYZ)]);
    expect(conflicts).toEqual([]);
  });
});

// ─── Minimality ──────────────────────────────────────────────────────────────

describe("minimality", () => {
  it("content record omits volatile/UI/local state fields (no search state, no preview)", () => {
    const record = makeContent();
    const text = JSON.stringify(record);
    expect(text).not.toContain("selection");
    expect(text).not.toContain("preview");
    expect(text).not.toContain("camera");
    expect(text).not.toContain("queue");
  });
});

// ─── Hash format helpers ─────────────────────────────────────────────────────

describe("hash helpers", () => {
  it("isValidContentHash accepts 64 hex and rejects others", () => {
    expect(isValidContentHash("a".repeat(64))).toBe(true);
    expect(isValidContentHash("XYZ")).toBe(false);
    expect(isValidContentHash("g".repeat(64))).toBe(false);
  });
});

// ─── STEP41 — compact V2 knowledge block (schema-level validation) ───────────

function makeKnowledgeBlock(
  overrides: Partial<GlobalSoundCharacterKnowledge> = {},
): GlobalSoundCharacterKnowledge {
  const char: SoundCharacter = {
    ...emptySoundCharacter(),
    brightness: 0.4,
    density: 0.6,
    transient: 0.5,
    duration: null,
    tonality: 0.7,
    noisiness: 0.2,
    dynamics: 0.3,
    complexity: 0.8,
  };
  return {
    codecVersion: SOUND_CHARACTER_CODEC_VERSION,
    packed: encodeSoundCharacterToBase64(char),
    analysisVersion: "2.0.0",
    similarityVersion: SIMILARITY_ALGORITHM_VERSION,
    soundSpaceVersion: SOUND_SPACE_ALGORITHM_VERSION,
    classificationVersion: "heuristic-v1",
    confidence: 0.9,
    durationMs: 400,
    ...overrides,
  };
}

describe("STEP41 — stored content record with a V2 knowledge block", () => {
  it("accepts a structurally valid block and retains it (additive)", () => {
    const record = makeContent(undefined, {
      analysis: makeAnalysis({
        soundCharacterV2: makeKnowledgeBlock(),
      }),
    });
    const issues = validateContentRecord(record);
    expect(issues.filter((i) => i.path.startsWith("analysis.soundCharacterV2"))).toEqual([]);
    expect(JSON.stringify(record)).toContain("V2.SC-v1");
  });

  it("treats an absent block as a valid additive no-op", () => {
    // makeContent() has no soundCharacterV2 — a legacy V1-style record stays valid.
    const issues = validateContentRecord(makeContent());
    expect(issues.filter((i) => i.path.startsWith("analysis.soundCharacterV2"))).toEqual([]);
  });

  it("rejects a corrupt packed payload", () => {
    const record = makeContent(undefined, {
      analysis: makeAnalysis({ soundCharacterV2: makeKnowledgeBlock({ packed: "!!!not-base64!!!" }) }),
    });
    const issues = validateContentRecord(record);
    expect(issues.some((i) => i.path === "analysis.soundCharacterV2.packed")).toBe(true);
  });

  it("rejects base64 that decodes to the wrong packed length", () => {
    const record = makeContent(undefined, {
      analysis: makeAnalysis({ soundCharacterV2: makeKnowledgeBlock({ packed: "QUFBQUFBQUFBQUFBQUFBQQ==" }) }),
    });
    const issues = validateContentRecord(record);
    expect(issues.some((i) => i.path === "analysis.soundCharacterV2.packed")).toBe(true);
  });

  it("rejects an unsupported codec version", () => {
    const record = makeContent(undefined, {
      analysis: makeAnalysis({
        soundCharacterV2: makeKnowledgeBlock({
          codecVersion: "V1.LEGACY" as typeof SOUND_CHARACTER_CODEC_VERSION,
        }),
      }),
    });
    const issues = validateContentRecord(record);
    expect(issues.some((i) => i.path === "analysis.soundCharacterV2.codecVersion")).toBe(true);
  });

  it("rejects an unsupported V2 similarity/sound-space algorithm version", () => {
    const record = makeContent(undefined, {
      analysis: makeAnalysis({
        soundCharacterV2: makeKnowledgeBlock({
          similarityVersion: "3.0.0" as typeof SIMILARITY_ALGORITHM_VERSION,
          soundSpaceVersion: "2.0.0" as typeof SOUND_SPACE_ALGORITHM_VERSION,
        }),
      }),
    });
    const issues = validateContentRecord(record);
    expect(issues.some((i) => i.path === "analysis.soundCharacterV2.similarityVersion")).toBe(true);
    expect(issues.some((i) => i.path === "analysis.soundCharacterV2.soundSpaceVersion")).toBe(true);
  });

  it("rejects a block that disagrees with the stored classification/confidence", () => {
    const record = makeContent(undefined, {
      analysis: makeAnalysis({
        soundCharacterV2: makeKnowledgeBlock({ classificationVersion: "other-v2", confidence: 0.1 }),
      }),
    });
    const issues = validateContentRecord(record);
    expect(issues.some((i) => i.path === "analysis.soundCharacterV2.classificationVersion")).toBe(true);
    expect(issues.some((i) => i.path === "analysis.soundCharacterV2.confidence")).toBe(true);
  });
});
