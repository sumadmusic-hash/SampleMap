/**
 * STEP27 — collection perf benchmark. Constructed-only (never real audio):
 * pools of 10 / 50 / 100 / 500 / 1,000 records (the collection itself is
 * hard-capped at 50). Measures the pure boundary (add-until-cap, toggle,
 * remove) and the O(8N) summary across growing pools. Prints TSV (appended to
 * the STEP27 report §31) and bounds the worst case.
 */
import { describe, it, expect } from "vitest";
import { makeSample } from "../persistence/test-helpers";
import { ANALYSIS_VERSION } from "./sampleAnalysisV2";
import type { SampleAnalysisV2 } from "./sampleAnalysisV2";
import { computeSoundCharacter, computeSoundCharacterQuality } from "./soundCharacter";
import { analyzeCorpus } from "../audio/v2Fixtures";
import {
  emptyCollectionState,
  addToCollection,
  removeFromCollection,
  toggleCollectionSample,
  summarizeCollection,
  COLLECTION_MAX_SAMPLES,
} from "./collection";
import type { SampleIndexRecord } from "../persistence/indexStore";

const _analysis = new Map<string, SampleAnalysisV2>();
function corpus(): SampleAnalysisV2 {
  let a = _analysis.get("whiteNoise");
  if (!a) {
    const f = analyzeCorpus("whiteNoise", 44100);
    const soundCharacter = computeSoundCharacter(f);
    a = {
      analysisVersion: ANALYSIS_VERSION,
      features: f,
      soundCharacter,
      quality: computeSoundCharacterQuality(soundCharacter),
    };
    _analysis.set("whiteNoise", a);
  }
  return a;
}

function poolOf(size: number): SampleIndexRecord[] {
  const a = corpus();
  return Array.from({ length: size }, (_, i) =>
    makeSample(`pool/${size}/sample-${i.toString().padStart(5, "0")}`, {
      name: `Pool sample ${i}`,
      analysisV2: a,
    }),
  );
}

const SIZES = [10, 50, 100, 500, 1000] as const;

describe("STEP27 collection perf benchmark (constructed)", () => {
  it("benchmarks boundary + summary across pools and bounds the worst case", () => {
    const rows: string[] = [];
    let worst = 0;

    for (const size of SIZES) {
      const records = poolOf(size);

      // Boundary: add-to-cap (50), toggle a member, remove a member.
      const t0 = performance.now();
      let c = emptyCollectionState();
      for (let i = 0; i < size; i++) {
        c = addToCollection(c, records[i].sampleId);
      }
      const t1 = performance.now();
      for (let i = 0; i < size; i++) {
        c = toggleCollectionSample(c, records[i].sampleId);
      }
      // Re-toggle to get back to a stable state, then remove the rest fully.
      for (let i = 0; i < size; i++) {
        c = toggleCollectionSample(c, records[i].sampleId);
      }
      for (let i = 0; i < size; i++) {
        c = removeFromCollection(c, records[i].sampleId);
      }
      const t2 = performance.now();

      // Summary over a 50-member collection read from a pool of `size`.
      let c2 = emptyCollectionState();
      const n = Math.min(COLLECTION_MAX_SAMPLES, records.length);
      for (let i = 0; i < n; i++) c2 = addToCollection(c2, records[i].sampleId);
      const members = c2.sampleIds
        .map((id) => records.find((r) => r.sampleId === id))
        .filter((r): r is SampleIndexRecord => r !== undefined);
      const t3 = performance.now();
      const summary = summarizeCollection(members);
      const t4 = performance.now();

      const boundaryMs = Math.round((t2 - t0) * 100) / 100;
      const addCapMs = Math.round((t1 - t0) * 10) / 10;
      const summaryMs = Math.round((t4 - t3) * 1000) / 1000;
      rows.push([size, addCapMs, boundaryMs, summaryMs].join("\t"));
      worst = Math.max(worst, boundaryMs);
      expect(c2.sampleIds).toHaveLength(n);
      if (members.length > 0) expect(summary).not.toBeNull();
    }

    console.log("STEP27_BENCH_POOL\taddToCapMs\tfullBoundaryMs\tsummaryMs");
    for (const r of rows) console.log(r);
    expect(worst).toBeLessThan(2000);
  });
});