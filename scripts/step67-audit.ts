#!/usr/bin/env -S npx tsx --env-file=.env
/**
 * STEP67 — 500-Sample Drum Corpus Analysis (REAL production pipeline).
 *
 * Runs the REAL `AnalysisPipeline` (hier-v1 wired) over the step67 corpus.
 * This is the SAME code path the production browser app uses (analysis →
 * SoundCharacter V2 → computePosition map-v2 → hier classification →
 * contentHash → persisted SampleIndexRecord). Nothing in `src/` is changed.
 *
 * For every analysed sample it emits:
 *   <out>/step67-analysis.ndjson     slim analysis row (soundCharacter,
 *                                   mapPosition, hier full+audioOnly, legacy)
 *   <out>/step67-records.ndjson      the FULL persisted SampleIndexRecord
 *                                   (metadata + analysis, never audio bytes) —
 *                                   this is what the real browser IDB hydration
 *                                   writes verbatim.
 *   <out>/step67-skipped.ndjson      failures (+ reasons), so §7 counts every
 *                                   dropout. Deterministic replacements are
 *                                   drawn from step67-backup.ndjson (same
 *                                   bucket, next by deterministic sort) to keep
 *                                   the analysed corpus at 500 when possible.
 *   <out>/step67-audit.log
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/step67-audit.ts [--out <dir>]
 *     [--max-samples N] [--resume] [--use-backup]
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

const OUT_DIR = parseArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step67";
const CORPUS_PATH = parseArg("--corpus") ?? path.join(OUT_DIR, "step67-corpus.ndjson");
const BACKUP_PATH = parseArg("--backup") ?? path.join(OUT_DIR, "step67-backup.ndjson");
const RESUME = process.argv.includes("--resume");
const MAX_SAMPLES = Number(parseArg("--max-samples") ?? "0");
const USE_BACKUP = process.argv.includes("--use-backup");

const PAT = process.env.AT_PAT ?? "";
if (!PAT) {
  console.error("AT_PAT not set (see .env)");
  process.exit(1);
}

const BUILD = "smap-step67-audit-v1";

interface CorpusRow {
  kind: string;
  step?: string;
  sampleId: string;
  name: string;
  owner: string;
  visibility: string;
  bpm: number;
  durationSeconds: number;
  numFavorites: number;
  numUsages: number;
  originalTags: string[];
  bucket?: string;
  tier?: string;
  namingFamily?: string;
  sampleKind?: string;
  selectionEvidence?: { types: string[]; generic: string[]; subtypes: string[] };
}

// ── Node WAV decoder (16-bit PCM → mono) — same as the STEP42/44/44.1 audits.
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

function loadCorpus(p: string): CorpusRow[] {
  const out: CorpusRow[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.sampleId !== "string") continue;
      out.push({
        kind: r.kind ?? "reference",
        sampleId: r.sampleId,
        name: r.name ?? "",
        owner: r.owner ?? "",
        visibility: r.visibility ?? "",
        bpm: r.bpm ?? 0,
        durationSeconds: r.durationSeconds ?? 0,
        numFavorites: r.numFavorites ?? 0,
        numUsages: r.numUsages ?? 0,
        originalTags: Array.isArray(r.originalTags) ? r.originalTags.map(String) : [],
        bucket: r.bucket,
        tier: r.tier,
        namingFamily: r.namingFamily,
        sampleKind: r.sampleKind,
        selectionEvidence: r.selectionEvidence,
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
    kind: "one-shot" as SampleMeta["kind"],
    bpm: row.bpm,
    durationSeconds: row.durationSeconds,
    numFavorites: row.numFavorites,
    numUsages: row.numUsages,
    tags: [...row.originalTags],
    wavUrl: undefined,
    flacUrl: undefined,
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

function analysisRow(row: CorpusRow, rec: SampleIndexRecord): Record<string, unknown> {
  const h = rec.hier!;
  return {
    kind: "analysis",
    step: "step67",
    sampleId: rec.sampleId,
    name: rec.name,
    owner: rec.owner,
    bucket: row.bucket ?? null,
    tier: row.tier ?? null,
    originalTags: rec.originalTags,
    audioFeatures: rec.audioFeatures ? featuresSlice(rec.audioFeatures) : undefined,
    soundCharacter: rec.analysisV2?.soundCharacter ?? undefined,
    mapPosition: rec.mapPosition,
    contentHash: rec.contentHash?.slice(0, 16),
    contentHashVersion: rec.contentHashVersion ?? undefined,
    fileHash: rec.fileHash?.slice(0, 16),
    analysisVersion: rec.analysisVersion,
    analysisBuild: rec.analysisBuild,
    analyzedAt: rec.analyzedAt,
    status: rec.status,
    analysisSourceFormat: rec.analysisSourceFormat,
    full: h
      ? {
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
        }
      : null,
  };
}

function mainstep(out: string): Promise<void> {
  return new Promise((resolve) => {
    const s = fs.createWriteStream(out, { flags: "a" });
    s.end(resolve);
  });
}

async function main() {
  const client = await createAudiotoolClient({
    auth: createPATAuth(PAT),
    transport: createNodeTransport(),
    wasm: createDiskWasmLoader(),
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const analysisPath = path.join(OUT_DIR, "step67-analysis.ndjson");
  const recordsPath = path.join(OUT_DIR, "step67-records.ndjson");
  const skippedPath = path.join(OUT_DIR, "step67-skipped.ndjson");
  const logPath = path.join(OUT_DIR, "step67-audit.log");
  const log = (msg: string) => fs.appendFileSync(logPath, msg + "\n");
  log(`STEP67 audit — ${new Date().toISOString()} build=${BUILD} resume=${RESUME} useBackup=${USE_BACKUP}`);

  const corpus = loadCorpus(CORPUS_PATH);
  const backup = loadCorpus(BACKUP_PATH);
  console.error(`corpus rows: ${corpus.length}; backup pool available: ${backup.length}`);
  const metas = new Map<string, SampleMeta>();
  for (const r of [...corpus, ...backup]) metas.set(r.sampleId, toSampleMeta(r));

  // ── pipeline (hier-v1 wired) — THE production code path ──────────────────
  const db = await openDatabase(`step67-${Date.now()}`);
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

  let rows = corpus;
  if (MAX_SAMPLES > 0) rows = rows.slice(0, MAX_SAMPLES);

  const done = new Set<string>();
  for (const line of fs.existsSync(recordsPath) ? fs.readFileSync(recordsPath, "utf8").split("\n") : []) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.sampleId === "string") done.add(r.sampleId);
    } catch {
      // torn tail
    }
  }
  const analysisStream = fs.createWriteStream(analysisPath, { flags: "a" });
  const recordsStream = fs.createWriteStream(recordsPath, { flags: "a" });
  const skippedStream = fs.createWriteStream(skippedPath, { flags: "a" });
  const skipped: Array<Record<string, string>> = [];
  const statusCounts: Record<string, number> = {};
  let analyzed = 0;
  let attempted = 0;
  const replacements: Array<Record<string, string>> = [];
  const haveInMemory: Record<string, number> = {};

  const processRow = async (row: CorpusRow): Promise<boolean> => {
    attempted++;
    const outcome = await pipeline.run(row.sampleId, BUILD);
    statusCounts[outcome.status] = (statusCounts[outcome.status] ?? 0) + 1;
    if (outcome.status !== "analyzed") {
      skipped.push({ sampleId: row.sampleId, reason: outcome.error ?? "UNKNOWN" });
      skippedStream.write(JSON.stringify({ kind: "skipped", step: "step67", sampleId: row.sampleId, reason: outcome.error ?? "UNKNOWN" }) + "\n");
      return false;
    }
    const rec = await db.index.get(row.sampleId);
    if (!rec || !rec.audioFeatures || !rec.hier || !rec.mapPosition) {
      skipped.push({ sampleId: row.sampleId, reason: "INDEX_MISS_AFTER_ANALYZED" });
      statusCounts["index-miss"] = (statusCounts["index-miss"] ?? 0) + 1;
      skippedStream.write(JSON.stringify({ kind: "skipped", step: "step67", sampleId: row.sampleId, reason: "INDEX_MISS_AFTER_ANALYZED" }) + "\n");
      return false;
    }
    analysisStream.write(JSON.stringify(analysisRow(row, rec)) + "\n");
    // FULL persisted record — verbatim hydration input (no audio bytes).
    const { embedding: _embedding, ...recordJson } = { ...(rec as SampleIndexRecord) };
    recordsStream.write(JSON.stringify(recordJson) + "\n");
    if (row.bucket) haveInMemory[row.bucket] = (haveInMemory[row.bucket] ?? 0) + 1;
    done.add(row.sampleId);
    analyzed++;
    if (analyzed % 25 === 0) {
      console.error(`  ... ${analyzed} analysed / ${attempted} attempted`);
      log(`  ... ${analyzed} analysed / ${attempted} attempted`);
    }
    return true;
  };

  try {
    for (const row of rows) {
      if (done.has(row.sampleId)) continue;
      await processRow(row);
    }
    // ── deterministic backup replacements until the corpus is full ─────────
    if (USE_BACKUP) {
      // Desired total per bucket (from the corpus definition).
      const perBucket: Record<string, number> = {};
      for (const r of corpus) {
        if (!r.bucket) continue;
        perBucket[r.bucket] = (perBucket[r.bucket] ?? 0) + 1;
      }
      // What we already have per bucket (in-memory for this run, on-disk on resume).
      for (const line of fs.existsSync(recordsPath) ? fs.readFileSync(recordsPath, "utf8").split("\n") : []) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          const meta = corpus.find((c) => c.sampleId === r.sampleId);
          const b = meta?.bucket ?? "unknown";
          haveInMemory[b] = (haveInMemory[b] ?? 0) + 1;
        } catch {
          // torn tail
        }
      }
      // Backup file is pre-sorted (same deterministic order as selection).
      const byBucket: Record<string, CorpusRow[]> = {};
      for (const b of backup) (byBucket[b.bucket ?? "unknown"] ??= []).push(b);
      for (const b of Object.keys(perBucket)) {
        const target = perBucket[b];
        let need = target - (haveInMemory[b] ?? 0);
        if (need <= 0) {
          console.error(`bucket ${b}: have ${haveInMemory[b] ?? 0} >= target ${target}, no replacements`);
          continue;
        }
        console.error(`bucket ${b}: have ${haveInMemory[b] ?? 0}, target ${target}, need ${need} replacements`);
        for (const cand of byBucket[b] ?? []) {
          if (need <= 0) break;
          if (done.has(cand.sampleId)) continue;
          const ok = await processRow(cand);
          done.add(cand.sampleId);
          if (ok) {
            replacements.push({ sampleId: cand.sampleId, bucket: b, replaces: "failed/absent in base corpus" });
            need -= 1;
          }
        }
        if (need > 0) {
          skipped.push({ sampleId: `bucket:${b}`, reason: `BACKUP_EXHAUSTED need=${need}` });
        }
      }
    }
  } finally {
    analysisStream.end();
    recordsStream.end();
    skippedStream.end();
  }
  await mainstep(analysisPath);

  log(`STEP67 done — analyzed=${analyzed} attempted=${attempted} status=${JSON.stringify(statusCounts)} replacements=${replacements.length}`);
  const summary = {
    audit: "STEP67 500-sample drum corpus analysis",
    build: BUILD,
    generatedAt: new Date().toISOString(),
    corpusPath: CORPUS_PATH,
    rowsSelected: rows.length,
    attempted,
    analyzed,
    replacementCount: replacements.length,
    replacements,
    statusCounts,
    skippedReasons: skipped.reduce<Record<string, number>>(
      (m, r) => ((m[r.reason] = (m[r.reason] ?? 0) + 1), m),
      {},
    ),
    outputs: { analysis: analysisPath, records: recordsPath, skipped: skippedPath, log: logPath },
  };
  fs.writeFileSync(path.join(OUT_DIR, "step67-audit-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  await db.db.close();
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});