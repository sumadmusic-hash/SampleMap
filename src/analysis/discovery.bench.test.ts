/**
 * STEP26 — discovery perf benchmark. Constructed-only (never real audio):
 * pool sizes 100 / 500 / 1,000 / 5,000 / 10,000 × modes text-only /
 * filter-only / reference-only / text+filter+reference, over a seeded corpus.
 * Prints TSV (appended to the STEP26 report §19) and bounds the worst case.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeSample } from "../persistence/test-helpers";
import { ANALYSIS_VERSION } from "./sampleAnalysisV2";
import type { SampleAnalysisV2 } from "./sampleAnalysisV2";
import { computeSoundCharacter, computeSoundCharacterQuality } from "./soundCharacter";
import { analyzeCorpus } from "../audio/v2Fixtures";
import { discoverSamples } from "./discovery";
import type { SampleIndexRecord } from "../persistence/indexStore";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _analysis = new Map<string, SampleAnalysisV2>();
function corpus(name: string): SampleAnalysisV2 {
  let a = _analysis.get(name);
  if (!a) {
    const f = analyzeCorpus(name, 44100);
    const soundCharacter = computeSoundCharacter(f);
    a = {
      analysisVersion: ANALYSIS_VERSION,
      features: f,
      soundCharacter,
      quality: computeSoundCharacterQuality(soundCharacter),
    };
    _analysis.set(name, a);
  }
  return a;
}

const CORPUS_SIGNALS = ["decayingTone90", "lowThump", "highThump", "highSine2000", "whiteNoise"] as const;
const NAME_WORDS = ["kick", "hat", "pad", "sub", "bright"] as const;
const SIZES = [100, 500, 1000, 5000, 10000] as const;

function poolOf(size: number): SampleIndexRecord[] {
  const rand = mulberry32(size * 7919 + 7);
  const out: SampleIndexRecord[] = [];
  for (let i = 0; i < size; i++) {
    const idx = Math.floor(rand() * NAME_WORDS.length);
    const signal = CORPUS_SIGNALS[idx % CORPUS_SIGNALS.length];
    out.push(
      makeSample(`bench/s${size}/sample-${i.toString().padStart(5, "0")}`, {
        name: `${NAME_WORDS[idx].toUpperCase()} ${NAME_WORDS[idx]} sample ${i}`,
        analysisV2: corpus(signal),
      }),
    );
  }
  return out;
}

class MemorySearch {
  constructor(private readonly records: readonly SampleIndexRecord[]) {}
  async search(q: { text?: string }) {
    const text = (q.text ?? "").toLowerCase();
    const hits = this.records.filter((r) => r.name.toLowerCase().includes(text));
    return hits.map((r) => ({ record: r, score: 1 }));
  }
}

const FILTER_ALL = { brightness: { min: 0, max: 1 } };

describe("STEP26 discovery perf benchmark (constructed)", () => {
  const rows: string[] = [];
  beforeEach(() => rows.length = 0);

  it("benchmarks and bounds 10k reference-only under 5s", async () => {
    let worst = 0;
    for (const size of SIZES) {
      const records = poolOf(size);
      const search = new MemorySearch(records);
      const run = async () => {
        const t0 = performance.now();
        await discoverSamples(
          { text: "kick", limit: 100 },
          records,
          { search },
        );
        const t1 = performance.now();
        await discoverSamples(
          { characterFilter: FILTER_ALL, limit: 100 },
          records,
          { search },
        );
        const t2 = performance.now();
        await discoverSamples(
          { referenceSampleId: records[0].sampleId, limit: 100 },
          records,
          { search },
        );
        const t3 = performance.now();
        await discoverSamples(
          { text: "kick", characterFilter: FILTER_ALL, referenceSampleId: records[0].sampleId, limit: 100 },
          records,
          { search },
        );
        const t4 = performance.now();
        const textOnly = Math.round((t1 - t0) * 10) / 10;
        const filterOnly = Math.round((t2 - t1) * 10) / 10;
        const referenceOnly = Math.round((t3 - t2) * 10) / 10;
        const combined = Math.round((t4 - t3) * 10) / 10;
        rows.push([size, textOnly, filterOnly, referenceOnly, combined].join("\t"));
        return { referenceOnly, combined };
      };
      const time = await run();
      worst = Math.max(worst, time.referenceOnly, time.combined);
    }
    // Emit a clean TSV for the report §19.
    console.log("STEP26_BENCH_SIZE\ttextOnlyMs\tfilterOnlyMs\treferenceOnlyMs\tcombinedMs");
    for (const r of rows) console.log(r);
    expect(worst).toBeLessThan(5000);
  });
});