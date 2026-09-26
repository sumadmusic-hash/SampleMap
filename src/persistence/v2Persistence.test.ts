import { describe, it, expect } from "vitest";
import {
  assertNoAudioBytes,
  isWellFormedIndexRecord,
  type SampleIndexRecord,
} from "./indexStore";
import { openTestDatabase, makeSample } from "./test-helpers";
import { ANALYSIS_VERSION, type SampleAnalysisV2 } from "../analysis/sampleAnalysisV2";
import { computeSoundCharacter, computeSoundCharacterQuality } from "../analysis/soundCharacter";
import { PURE_TONE } from "../analysis/fixtures";

function makeAnalysisV2(): SampleAnalysisV2 {
  const soundCharacter = computeSoundCharacter(PURE_TONE);
  return {
    analysisVersion: ANALYSIS_VERSION,
    features: PURE_TONE,
    soundCharacter,
    quality: computeSoundCharacterQuality(soundCharacter),
  };
}

describe("persistence compatibility: V1 record + additive analysisV2", () => {
  it("stores and re-reads a V2 analysis WITHOUT touching V1 fields (round-trip)", async () => {
    const { index, db } = await openTestDatabase();
    try {
      const v1 = makeSample("samples/a");
      await index.put(v1);

      const before = await index.get("samples/a");
      expect(before).toEqual(v1);
      expect(before).not.toHaveProperty("analysisV2");

      const v2 = makeAnalysisV2();
      const v1plus = { ...v1, analysisV2: v2 };

      // The no-audio-bytes invariant must hold for a record carrying V2 analysis.
      expect(() => assertNoAudioBytes(v1plus)).not.toThrow();
      expect(isWellFormedIndexRecord(v1plus)).toBe(true);

      await index.put(v1plus);
      const read = await index.get("samples/a");
      expect(read).toBeDefined();

      // V2 analysis survived and is byte-identical (numbers/nulls preserved).
      expect(read!.analysisV2).toEqual(v2);

      // V1 fields are unchanged by the additive V2 analysis.
      const { analysisV2: _strip, ...v1Only } = { ...read! };
      expect(v1Only).toEqual(v1);
    } finally {
      await db.close();
    }
  });

  it("survives a full JSON + IndexedDB round-trip (metadata only, no audio bytes)", async () => {
    const { index, db } = await openTestDatabase();
    try {
      const rec: SampleIndexRecord = {
        ...makeSample("samples/json"),
        analysisV2: makeAnalysisV2(),
      };
      const json = JSON.parse(JSON.stringify(rec)) as SampleIndexRecord;
      await index.put(json);
      const read = await index.get("samples/json");
      expect(read!.analysisV2).toEqual(makeAnalysisV2());
      const { analysisV2: _strip, ...v1Only } = { ...read! };
      expect(v1Only).toEqual(makeSample("samples/json"));
    } finally {
      await db.close();
    }
  });

  it("V1-only records remain fully readable (no re-analysis, no auto-migration)", async () => {
    const { index, db } = await openTestDatabase();
    try {
      const v1 = makeSample("samples/legacy");
      await index.put(v1);
      const read = await index.get("samples/legacy");
      expect(read).toEqual(v1);
      expect(read!.analysisV2).toBeUndefined();
    } finally {
      await db.close();
    }
  });
});