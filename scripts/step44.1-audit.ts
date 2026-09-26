#!/usr/bin/env -S npx tsx --env-file=.env
/**
 * STEP44.1 — Targeted One-Shot Reference Corpus Analysis.
 *
 * Runs the REAL `AnalysisPipeline` (hier-v1 wired) over every row of the
 * step44.1 reference corpus, then produces TWO evaluations per sample against
 * the SAME audio:
 *
 *   evaluation A (acoustic-only):  hier-v1 with meta { name: "", tags: [] } —
 *                                  features + kind + duration + V2 only.
 *   evaluation B (full reconciliation): the pipeline's persisted `hier` tree —
 *                                  features + kind + duration + V2 + name + tags.
 *
 * Both evaluations are derived from the CURRENT code over REAL audio; nothing
 * is ever persisted as truth and tags stay proxies (they only ever feed
 * reconciliation, and are exported verbatim).
 *
 * Content-hash dedupe: samples whose decoded audio has the same contentHash as
 * an already-analysed corpus row are logged as DUPLICATE and NOT counted into
 * the metrics (first occurrence wins).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/step44.1-audit.ts \
 *      [--out <dir>] [--corpus <ndjson>] [--resume] [--max-samples N] [--smoke N]
 *
 * Emits (append, idempotent):
 *   <dir>/step44.1-analysis.ndjson    one analysis row per analysed corpus sample
 *   <dir>/step44.1-skipped.ndjson     samples that failed to analyse (+ duplicates)
 *   <dir>/step44.1-audit.log          progress + provenance
 */
import type { SampleMeta } from "@audiotool/nexus/api";
import { createAudiotoolClient, createPATAuth } from "@audiotool/nexus";
import { createNodeTransport, createDiskWasmLoader } from "@audiotool/nexus/node";
import fs from "node:fs";
import path from "node:path";
import "fake-indexeddb/auto";
import { openDatabase } from "../src/persistence/db";
import { AnalysisPipeline } from "../src/pipeline/analysisPipeline";
import { extractFeatures } from "../src/audio/featureExtractor";
import { HeuristicClassifier } from "../src/classify/heuristicClassifier";
import { HierClassifier } from "../src/classify/hierClassifier";
import type { AudioDecoder, DecodedAudio } from "../src/audio/decodedAudio";
import type { AudioFeatures, IndexStore, SampleIndexRecord } from "../src/persistence/indexStore";

const OUT_DIR = parseArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step44.1";
const CORPUS_PATH =
  parseArg("--corpus") ??
  path.join(OUT_DIR, "step44.1-reference-corpus.ndjson");
const RESUME = process.argv.includes("--resume");
const MAX_SAMPLES = Number(parseArg("--max-samples") ?? "0");
const SMOKE = Number(parseArg("--smoke") ?? "0");

const PAT = process.env.AT_PAT ?? "";
if (!PAT) {
  console.error("AT_PAT not set (see .env)");
  process.exit(1);
}

const BUILD = "smap-step44.1-audit-v1";

interface CorpusRow {
  kind: "reference" | "loop-validation";
  sampleId: string;
  name: string;
  owner: string;
  visibility: string;
  bpm: number;
  durationSeconds: number;
  numFavorites: number;
  numUsages: number;
  originalTags: string[];
  referenceClass?: string;
  referenceTier?: string;
  namingFamily?: string;
  loopBand?: string;
}

// ── Node WAV decoder (16-bit PCM → mono) — same as the STEP42/STEP44 audit.
function nodeWavDecode(bytes: ArrayBuffer): DecodedAudio {
  const buf = new Uint8Array(bytes);
  if (buf.byteLength < 44 || String.fromCharCode(...buf.subarray(0, 4)) !== "RIFF") {
    throw new Error("not a RIFF WAV");
  }
  const dv = new DataView(bytes);
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | undefined;
  let dataStart = -1;
  let dataSize = 0;
  while (off + 8 <= buf.byteLength) {
    const id = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
    const size = dv.getUint32(off + 4, true);
    if (id === "fmt ") {
      const format = dv.getUint16(off + 8, true);
      if (format !== 1) throw new Error(`unsupported WAV format ${format}`);
      fmt = {
        channels: dv.getUint16(off + 10, true),
        sampleRate: dv.getUint32(off + 12, true),
        bits: dv.getUint16(off + 22, true),
      };
    } else if (id === "data") {
      dataStart = off + 8;
      dataSize = size;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataStart < 0) throw new Error("WAV missing fmt/data");
  if (fmt.bits !== 16) throw new Error(`unsupported bits ${fmt.bits} (only 16-bit PCM)`);
  const frames = Math.floor(dataSize / (fmt.channels * 2));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const v = dv.getInt16(dataStart + (i * fmt.channels + c) * 2, true);
      sum += v / 32768;
    }
    mono[i] = sum / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, mono, durationSeconds: frames / fmt.sampleRate };
}

function parseArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function loadCorpus(): CorpusRow[] {
  const out: CorpusRow[] = [];
  for (const line of fs.readFileSync(CORPUS_PATH, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.sampleId !== "string") continue;
      out.push({
        kind: r.kind === "loop-validation" ? "loop-validation" : "reference",
        sampleId: r.sampleId,
        name: r.name ?? "",
        owner: r.owner ?? "",
        visibility: r.visibility ?? "",
        bpm: r.bpm ?? 0,
        durationSeconds: r.durationSeconds ?? 0,
        numFavorites: r.numFavorites ?? 0,
        numUsages: r.numUsages ?? 0,
        originalTags: Array.isArray(r.originalTags) ? r.originalTags.map(String) : [],
        referenceClass: r.referenceClass,
        referenceTier: r.referenceTier,
        namingFamily: r.namingFamily,
        loopBand: r.loopBand,
      });
    } catch {
      // tolerate torn tail
    }
  }
  return out;
}

function toSampleMeta(row: CorpusRow): SampleMeta {
  return {
    name: row.sampleId,
    displayName: row.name,
    ownerName: row.owner,
    visibility: (row.visibility || "public") as SampleMeta["visibility"],
    kind: (row.kind === "loop-validation" ? "loop" : "one-shot") as SampleMeta["kind"],
    bpm: row.bpm,
    durationSeconds: row.durationSeconds,
    numFavorites: row.numFavorites,
    numUsages: row.numUsages,
    tags: [...row.originalTags],
    wavUrl: undefined,
    flacUrl: undefined,
  };
}

async function heuristicSurface(
  classifier: HeuristicClassifier,
  features: AudioFeatures,
): Promise<Record<string, unknown>> {
  const out = await classifier.classify(features);
  return {
    primaryClass: out.primaryClass,
    confidence: out.confidence,
    secondaryClasses: out.secondaryClasses,
    classificationVersion: classifier.version,
  };
}

function featuresSlice(f: AudioFeatures): Record<string, unknown> {
  return {
    duration: f.duration,
    rms: f.rms,
    peak: f.peak,
    transientDensity: f.transientDensity,
    spectralCentroid: f.spectralCentroid,
    spectralBandwidth: f.spectralBandwidth,
    spectralRolloff: f.spectralRolloff,
    spectralFlatness: f.spectralFlatness,
    zeroCrossingRate: f.zeroCrossingRate,
    attack: f.attack,
    tonalNoiseRatio: f.tonalNoiseRatio,
    sampleRate: f.sampleRate,
    channels: f.channels,
  };
}

function analysisRow(
  row: CorpusRow,
  rec: SampleIndexRecord,
  audioOnly: Record<string, unknown>,
  legacy: Record<string, unknown>,
): Record<string, unknown> {
  const h = rec.hier!;
  return {
    kind: "analysis",
    corpusRole: row.kind,
    sampleId: rec.sampleId,
    name: rec.name,
    owner: rec.owner,
    visibility: rec.visibility,
    bpm: rec.bpm,
    numFavorites: rec.numFavorites,
    numUsages: rec.numUsages,
    originalTags: rec.originalTags,
    referenceClass: row.referenceClass ?? null,
    referenceTier: row.referenceTier ?? null,
    namingFamily: row.namingFamily ?? null,
    loopBand: row.loopBand ?? null,
    metadataDurationSeconds: row.durationSeconds,
    audioFeatures: rec.audioFeatures ? featuresSlice(rec.audioFeatures) : undefined,
    soundCharacter: rec.analysisV2?.soundCharacter ?? undefined,
    mapPosition: rec.mapPosition,
    contentHash: rec.contentHash?.slice(0, 16),
    fileHash: rec.fileHash?.slice(0, 16),
    analysisVersion: rec.analysisVersion,
    analysisBuild: rec.analysisBuild,
    analyzedAt: rec.analyzedAt,
    status: rec.status,
    analysisSourceFormat: rec.analysisSourceFormat,
    // evaluation A — acoustic only (kind + duration + features + V2, NO name/tags)
    audioOnly: {
      structure: audioOnly.structure,
      family: audioOnly.family,
      type: audioOnly.type,
      subtype: audioOnly.subtype ?? null,
      confidence: audioOnly.confidence,
      ambiguous: audioOnly.ambiguous,
      familyScores: audioOnly.familyScores ?? undefined,
      classificationVersion: audioOnly.classificationVersion,
    },
    // evaluation B — full reconciliation (pipeline `hier` used the RAW name+tags)
    full: {
      structure: h.structure,
      family: h.family,
      type: h.type,
      subtype: h.subtype ?? null,
      confidence: h.confidence,
      ambiguous: h.ambiguous,
      classificationVersion: h.classificationVersion,
      reconciliationStatus: h.reconciliation.status,
      reconciliationWinningSource: h.reconciliation.winningSource,
      reconciliationAgreement: h.reconciliation.agreement,
      reconciliationConflict: h.reconciliation.conflict,
      audioType: h.reconciliation.audioType ?? null,
      tagType: h.reconciliation.tagType ?? null,
      nameType: h.reconciliation.nameType ?? null,
    },
    legacy,
  };
}

async function main() {
  const client = await createAudiotoolClient({
    auth: createPATAuth(PAT),
    transport: createNodeTransport(),
    wasm: createDiskWasmLoader(),
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const analysisPath = path.join(OUT_DIR, "step44.1-analysis.ndjson");
  const skippedPath = path.join(OUT_DIR, "step44.1-skipped.ndjson");
  const logPath = path.join(OUT_DIR, "step44.1-audit.log");

  const log = (msg: string) => {
    fs.appendFileSync(logPath, msg + "\n");
  };
  log(`STEP44.1 audit — ${new Date().toISOString()} build=${BUILD} resume=${RESUME}`);

  const corpus = loadCorpus();
  const metas = new Map<string, SampleMeta>();
  for (const r of corpus) metas.set(r.sampleId, toSampleMeta(r));
  console.error(`corpus rows: ${corpus.length} (ref=${corpus.filter((r) => r.kind === "reference").length}, loop=${corpus.filter((r) => r.kind === "loop-validation").length})`);

  // ── pipeline (hier-v1 wired) ───────────────────────────────────────────────
  const db = await openDatabase(`step44.1-${Date.now()}`);
  const classifier = new HeuristicClassifier();
  const hierClassifier = new HierClassifier();
  const pipeline = new AnalysisPipeline({
    fetchAudio: async (sample, source) => {
      const blob = await client.samples.download(sample, { format: source.format });
      if (blob instanceof Error) throw blob;
      const bytes = await blob.arrayBuffer();
      return { bytes, release: () => undefined };
    },
    decode: nodeWavDecode,
    extract: extractFeatures,
    classifier,
    classifyHier: async (input) => hierClassifier.classifyHier(input),
    resolveSample: async (id) => {
      const m = metas.get(id);
      if (!m) return undefined;
      if (!m.wavUrl && !m.flacUrl) {
        try {
          const full = await client.samples.get(m);
          if (full instanceof Error) throw full;
          metas.set(id, full);
          return full;
        } catch {
          return undefined;
        }
      }
      return m;
    },
    index: db.index,
    analysisVersion: "features-v1",
  });

  // ── deterministic subset selection (smoke): even stride across the corpus ──
  let rows = corpus;
  if (SMOKE > 0 && SMOKE < corpus.length) {
    const stride = Math.floor(corpus.length / SMOKE);
    rows = corpus.filter((_, i) => i % stride === 0).slice(0, SMOKE);
    console.error(`smoke mode: ${rows.length} rows via stride ${stride}`);
  }
  if (MAX_SAMPLES > 0) {
    rows = rows.slice(0, MAX_SAMPLES);
    console.error(`max-samples mode: ${rows.length} rows`);
  }

  // ── resume: skip ids already present in the analysis file ─────────────────
  const alreadyAnalyzed = new Set<string>();
  for (const line of fs.existsSync(analysisPath) ? fs.readFileSync(analysisPath, "utf8").split("\n") : []) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.sampleId === "string") alreadyAnalyzed.add(r.sampleId);
    } catch {
      // torn tail
    }
  }
  const seenContentHash = new Set<string>();
  for (const line of fs.existsSync(analysisPath) ? fs.readFileSync(analysisPath, "utf8").split("\n") : []) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.contentHash === "string" && r.contentHash.length > 0) seenContentHash.add(r.contentHash);
    } catch {
      // torn tail
    }
  }
  console.error(`resume: ${alreadyAnalyzed.size} already-analysed rows, ${seenContentHash.size} content hashes`);

  const analysisStream = fs.createWriteStream(analysisPath, { flags: "a" });
  const skippedStream = fs.createWriteStream(skippedPath, { flags: "a" });
  const skipped: Array<Record<string, string>> = [];
  const statusCounts: Record<string, number> = {};
  let analyzed = 0;
  let attempted = 0;
  let dupSkipped = 0;

  try {
    for (const row of rows) {
      if (alreadyAnalyzed.has(row.sampleId)) continue;
      attempted++;
      const outcome = await pipeline.run(row.sampleId, BUILD);
      statusCounts[outcome.status] = (statusCounts[outcome.status] ?? 0) + 1;
      if (outcome.status !== "analyzed") {
        skipped.push({ sampleId: row.sampleId, reason: outcome.error ?? "UNKNOWN" });
        skippedStream.write(JSON.stringify({ kind: "skipped", sampleId: row.sampleId, reason: outcome.error ?? "UNKNOWN" }) + "\n");
        if (skipped.length % 20 === 0) console.error(`  ... ${skipped.length} skipped so far`);
        continue;
      }
      const rec = await db.index.get(row.sampleId);
      if (!rec || !rec.audioFeatures || !rec.hier) {
        skipped.push({ sampleId: row.sampleId, reason: "INDEX_MISS_AFTER_ANALYZED" });
        statusCounts["index-miss"] = (statusCounts["index-miss"] ?? 0) + 1;
        skippedStream.write(JSON.stringify({ kind: "skipped", sampleId: row.sampleId, reason: "INDEX_MISS_AFTER_ANALYZED" }) + "\n");
        continue;
      }
      const ch = rec.contentHash?.slice(0, 16) ?? "";
      if (ch && seenContentHash.has(ch)) {
        dupSkipped++;
        statusCounts["content-hash-duplicate"] = (statusCounts["content-hash-duplicate"] ?? 0) + 1;
        skipped.push({ sampleId: row.sampleId, reason: "CONTENT_HASH_DUPLICATE" });
        skippedStream.write(JSON.stringify({ kind: "skipped", sampleId: row.sampleId, reason: "CONTENT_HASH_DUPLICATE" }) + "\n");
        continue;
      }
      if (ch) seenContentHash.add(ch);

      // evaluation A: strip name + tags. Same kind + duration + features + V2.
      const audioOnly = hierClassifier.classifyHier({
        features: rec.audioFeatures,
        meta: {
          kind: rec.kind,
          durationSeconds: rec.audioFeatures.duration,
          name: "",
          tags: [],
        },
        v2: rec.analysisV2?.features ?? null,
      });
      const legacy = await heuristicSurface(classifier, rec.audioFeatures);
      const rowOut = analysisRow(row, rec, audioOnly.hier, legacy);
      analysisStream.write(JSON.stringify(rowOut) + "\n");
      alreadyAnalyzed.add(row.sampleId);
      analyzed++;
      if (analyzed % 20 === 0) {
        console.error(`  ... ${analyzed} analysed / ${attempted} attempted (dup-skipped=${dupSkipped})`);
        log(`  ... ${analyzed} analysed / ${attempted} attempted (dup-skipped=${dupSkipped})`);
      }
    }
  } finally {
    analysisStream.end();
    skippedStream.end();
  }

  log(`STEP44.1 audit done — analyzed=${analyzed} attempted=${attempted} dupSkipped=${dupSkipped} status=${JSON.stringify(statusCounts)}`);
  const summary = {
    audit: "STEP44.1 targeted one-shot reference corpus analysis",
    build: BUILD,
    generatedAt: new Date().toISOString(),
    corpusPath: CORPUS_PATH,
    rowsSelected: rows.length,
    attempted,
    analyzed,
    duplicateContentSkipped: dupSkipped,
    statusCounts,
    skippedReasons: skipped.reduce<Record<string, number>>(
      (m, r) => ((m[r.reason] = (m[r.reason] ?? 0) + 1), m),
      {},
    ),
    outputs: { analysis: analysisPath, skipped: skippedPath, log: logPath },
  };
  fs.writeFileSync(path.join(OUT_DIR, "step44.1-audit-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  await db.db.close();
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});