#!/usr/bin/env -S npx tsx --env-file=.env
/**
 * STEP42 — Reproducible Classification Audit.
 *
 * Read-only audit of the CURRENT classification implementation against the
 * REAL current SampleMap/sample-library dataset:
 *
 *   Phase A  enumerate the full real sample set via the live Audiotool API
 *            (PAT from .env) — metadata + RAW USER TAGS only, no audio.
 *   Phase B  run the CURRENT `AnalysisPipeline` (real HeuristicClassifier,
 *            real semantic reconciliation, real V2 SoundCharacter) over the
 *            real lossless audio of a bounded audit subset (>=100 analyzed),
 *            persisted transiently into in-memory IndexedDB, and export the
 *            resulting fields.
 *
 * AVAILABILITY / PROVENANCE rules (per STEP42):
 *   - metadata rows  = LIVE Audiotool metadata (real)
 *   - analysis rows  = DERIVED by the current code over real audio
 *                      (reproducible; NOT from a persisted SampleMap index —
 *                      none exists on this machine as of the audit date)
 *   - no audio bytes are ever written; the dataset is metadata + numbers only.
 *   - user tags exported VERBATIM (raw), never normalized/rewritten in output.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/step42-classification-audit.ts \
 *       [--out <dir>] [--audit-samples 120] [--page-size 100] \
 *       [--max-samples 0] [--resume] [--resume-skip N]
 *
 *   --resume        skip Phase A; rebuild metas from the existing metadata
 *                   NDJSON in --out (records must carry wavUrl/flacUrl).
 *   --resume-skip N  in non-resume mode, skip the first N enumeration entries
 *                    when starting Phase B (lets a partial Phase B continue).
 *
 * Emits:
 *   <out>/step42-audit-summary.json         counts + provenance
 *   <out>/step42-metadata.ndjson            one metadata row per real sample
 *   <out>/step42-analysis.ndjson            one analysis row per analyzed audit sample
 *   <out>/step42-skipped.ndjson             samples that could not be analyzed + reason
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
import { selectLosslessSource } from "../src/pipeline/sourceSelection";
import type { AudioFeatures, IndexStore, SampleIndexRecord } from "../src/persistence/indexStore";

const OUT_DIR = parseArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step42";
const AUDIT_SAMPLES = Number(parseArg("--audit-samples") ?? "120");
const PAGE_SIZE = Number(parseArg("--page-size") ?? "100");
const MAX_SAMPLES = Number(parseArg("--max-samples") ?? "0");
const RESUME = process.argv.includes("--resume");
const RESUME_SKIP = Number(parseArg("--resume-skip") ?? "0");
// STEP44 (hier-v1): when enabled the pipeline ALSO runs the hierarchical
// classifier; every analysis row exports BOTH the heuristic-v1 surface and the
// hier-v1 tree for baseline comparison. `--stratified N` appends N samples
// chosen deterministically from the short one-shots (<=0.5s) and loops (>=4s)
// that are NOT part of the base scan, to stress the STEP42 error cases.
const STEP44_HIER = process.env.STEP44_HIER === "1";
const STRATIFIED = Number(parseArg("--stratified") ?? "0");

const PAT = process.env.AT_PAT ?? "";
if (!PAT) {
  console.error("AT_PAT not set (see .env)");
  process.exit(1);
}

const BUILD = "smap-step42-audit-v1";

// ─────────────────────────────────────────────────────────────────────────────
// Node WAV decoder (16-bit PCM → mono Float32Array) — Node equivalent of the
// browser `decodeAudioData` hook used by the app (same as STEP16M).
// ─────────────────────────────────────────────────────────────────────────────
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

function metaToRow(s: SampleMeta): string {
  return JSON.stringify({
    kind: "metadata",
    sampleId: s.name,
    name: s.displayName,
    owner: s.ownerName,
    visibility: s.visibility,
    sampleKind: s.kind,
    bpm: s.bpm,
    durationSeconds: s.durationSeconds,
    numFavorites: s.numFavorites,
    numUsages: s.numUsages,
    tags: s.tags ?? [],
    wavUrl: s.wavUrl,
    flacUrl: s.flacUrl,
  });
}

function metaFromRow(r: Record<string, unknown>): SampleMeta {
  return {
    name: String(r.sampleId),
    displayName: r.name as string,
    ownerName: r.owner as string,
    visibility: r.visibility as SampleMeta["visibility"],
    kind: (r.sampleKind ?? r.kind) as SampleMeta["kind"],
    bpm: r.bpm as number,
    durationSeconds: r.durationSeconds as number,
    numFavorites: r.numFavorites as number,
    numUsages: r.numUsages as number,
    tags: (r.tags ?? []) as string[],
    wavUrl: r.wavUrl as string | undefined,
    flacUrl: r.flacUrl as string | undefined,
  } as SampleMeta;
}

function countBy<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
}

/** Heuristic-v1 baseline surface over the SAME features, for STEP44 pairs. */
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

function analysisRow(rec: SampleIndexRecord, legacy?: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {
    kind: "analysis",
    sampleId: rec.sampleId,
    name: rec.name,
    owner: rec.owner,
    visibility: rec.visibility,
    kind: rec.kind,
    bpm: rec.bpm,
    numFavorites: rec.numFavorites,
    numUsages: rec.numUsages,
    originalTags: rec.originalTags,
    primaryClass: rec.primaryClass,
    confidence: rec.confidence,
    secondaryClasses: rec.secondaryClasses,
    secondaryCount: rec.secondaryClasses.length,
    classificationVersion: rec.classificationVersion,
    semanticClassification: rec.semanticClassification,
    analysisVersion: rec.analysisVersion,
    analysisBuild: rec.analysisBuild,
    analyzedAt: rec.analyzedAt,
    status: rec.status,
    analysisSourceFormat: rec.analysisSourceFormat,
    fileHash: rec.fileHash?.slice(0, 16),
    contentHash: rec.contentHash?.slice(0, 16),
    durationSeconds: rec.audioFeatures?.duration,
    classifierFeatures: rec.audioFeatures
      ? {
          sampleRate: rec.audioFeatures.sampleRate,
          channels: rec.audioFeatures.channels,
          rms: rec.audioFeatures.rms,
          peak: rec.audioFeatures.peak,
          transientDensity: rec.audioFeatures.transientDensity,
          spectralCentroid: rec.audioFeatures.spectralCentroid,
          spectralBandwidth: rec.audioFeatures.spectralBandwidth,
          spectralRolloff: rec.audioFeatures.spectralRolloff,
          spectralFlatness: rec.audioFeatures.spectralFlatness,
          zeroCrossingRate: rec.audioFeatures.zeroCrossingRate,
          attack: rec.audioFeatures.attack,
          tonalNoiseRatio: rec.audioFeatures.tonalNoiseRatio,
        }
      : undefined,
    soundCharacter: rec.analysisV2?.soundCharacter ?? undefined,
    soundCharacterQuality: rec.analysisV2?.quality ?? undefined,
    analysisV2Version: rec.analysisV2?.analysisVersion ?? undefined,
    mapPosition: rec.mapPosition,
    similarityFingerprint: rec.similarityFingerprint?.values ?? undefined,
  };
  if (STEP44_HIER) {
    // STEP44 pair: the same real sample classifies TWO ways. `row.primaryClass`
    // above is the HIER-v1 surface (the pipeline replaced the heuristic one);
    // `legacy` keeps the heuristic-v1 surface captured from the same features.
    row.legacy = legacy ?? undefined;
    row.hier = rec.hier ?? undefined;
    row.hierTree = rec.hier
      ? {
          structure: rec.hier.structure,
          family: rec.hier.family,
          type: rec.hier.type,
          subtype: rec.hier.subtype,
          confidence: rec.hier.confidence,
          ambiguous: rec.hier.ambiguous,
          reconciliationStatus: rec.hier.reconciliation.status,
          reconciliationWinningSource: rec.hier.reconciliation.winningSource,
        }
      : undefined;
  }
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const client = await createAudiotoolClient({
    auth: createPATAuth(PAT),
    transport: createNodeTransport(),
    wasm: createDiskWasmLoader(),
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const metaPath = path.join(OUT_DIR, "step42-metadata.ndjson");
  // STEP44 hier runs write to their own analysis/summary files so the STEP42
  // heuristic audit dataset stays byte-identical and reproducible.
  const analysisPath = path.join(OUT_DIR, STEP44_HIER ? "step44-analysis.ndjson" : "step42-analysis.ndjson");
  const skippedPath = path.join(OUT_DIR, "step42-skipped.ndjson");
  const summaryPath = path.join(OUT_DIR, STEP44_HIER ? "step44-audit-summary.json" : "step42-audit-summary.json");

  const enumeratedAt = new Date().toISOString();
  const all: SampleMeta[] = [];
  const metas: Record<string, SampleMeta> = {};
  let pages = 0;
  let stopped = false;

  if (RESUME) {
    console.error(`STEP42 audit — RESUMING from ${metaPath}`);
    for (const line of fs.readFileSync(metaPath, "utf8").split("\n")) {
      if (!line) continue;
      const row: Record<string, unknown> = JSON.parse(line);
      if (typeof row.sampleId !== "string" || !String(row.sampleId).startsWith("samples/")) continue;
      const m = metaFromRow(row);
      all.push(m);
      metas[m.name] = m;
    }
    console.error(`  loaded ${all.length} metadata rows`);
  } else {
    console.error(`STEP42 audit — enumerating real sample set (pageSize=${PAGE_SIZE}, max=${MAX_SAMPLES || "all"})`);
    const metaStream = fs.createWriteStream(metaPath, { flags: "a" });
    let metaWritten = 0;
    let pageToken: string | undefined;
    do {
      const res = await client.samples.list({ pageSize: PAGE_SIZE, pageToken });
      if (res instanceof Error) throw res;
      for (const s of res.samples) {
        all.push(s);
        metas[s.name] = s;
        metaStream.write(metaToRow(s) + "\n");
        metaWritten++;
      }
      pages++;
      pageToken = res.nextPageToken || undefined;
      if (MAX_SAMPLES > 0 && all.length >= MAX_SAMPLES) {
        stopped = true;
        break;
      }
      if (pages % 20 === 0) console.error(`  ... ${all.length} metadata rows, ${pages} pages`);
    } while (pageToken);
    metaStream.end();
    await new Promise((resolve, reject) => metaStream.on("finish", resolve).on("error", reject));
    console.error(`enumerated ${all.length} samples across ${pages} pages (stopped=${stopped}), ${metaWritten} metadata rows`);
  }

  const kindCounts: Record<string, number> = {};
  const tagFreq: Record<string, number> = {};
  for (const s of all) {
    kindCounts[s.kind] = (kindCounts[s.kind] ?? 0) + 1;
    for (const t of s.tags ?? []) tagFreq[t] = (tagFreq[t] ?? 0) + 1;
  }
  const tagKeys = Object.keys(tagFreq).sort((a, b) => tagFreq[b] - tagFreq[a]);

  // ── Phase B: analyze a bounded, deterministic subset through the CURRENT pipeline ──
  const db = await openDatabase(`step42-audit-${Date.now()}`);
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
    classifyHier: STEP44_HIER
      ? async (input) => hierClassifier.classifyHier(input)
      : undefined,
    resolveSample: async (id) => {
      const m = metas[id];
      if (!m) return undefined;
      if (!m.wavUrl && !m.flacUrl) {
        try {
          const full = await client.samples.get(m);
          if (full instanceof Error) throw full;
          metas[id] = full;
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

  const analyzed: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, string>> = [];
  let attempted = 0;
  const statusCounts: Record<string, number> = {};
  const analysisStream = fs.createWriteStream(analysisPath, { flags: "a" });
  const skippedStream = fs.createWriteStream(skippedPath, { flags: "a" });
  // Already-completed ids make re-runs incremental (idempotent append/resume).
  const alreadyAnalyzed = new Set<string>();
  for (const line of fs.existsSync(analysisPath) ? fs.readFileSync(analysisPath, "utf8").split("\n") : []) {
    if (!line) continue;
    try {
      const row: Record<string, unknown> = JSON.parse(line);
      if (typeof row.sampleId === "string") alreadyAnalyzed.add(row.sampleId);
    } catch {
      // tolerate a torn last line from a previous interrupted run
    }
  }

  const TARGET = AUDIT_SAMPLES + (STEP44_HIER ? STRATIFIED : 0);
  console.error(`  target=${TARGET} analyzed (base=${AUDIT_SAMPLES}${STEP44_HIER ? `, stratified=${STRATIFIED})` : ")"}`);

  const analyzeOne = async (s: SampleMeta, reason: string): Promise<boolean> => {
    if (analyzed.length >= TARGET) return false;
    if (alreadyAnalyzed.has(s.name)) return true; // skip, keep cursor advancing
    const knownMissingLossless = (s.wavUrl || s.flacUrl) && !selectLosslessSource(s);
    if (knownMissingLossless) {
      skipped.push({ sampleId: s.name, reason: "NO_LOSSLESS_SOURCE" });
      statusCounts["no-lossless"] = (statusCounts["no-lossless"] ?? 0) + 1;
      skippedStream.write(JSON.stringify({ kind: "skipped", sampleId: s.name, reason: "NO_LOSSLESS_SOURCE" }) + "\n");
      return true;
    }
    attempted++;
    const outcome = await pipeline.run(s.name, BUILD);
    const key = outcome.status;
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    if (outcome.status === "analyzed") {
      const rec = await db.index.get(s.name);
      if (!rec) {
        skipped.push({ sampleId: s.name, reason: "INDEX_MISS_AFTER_ANALYZED" });
        skippedStream.write(JSON.stringify({ kind: "skipped", sampleId: s.name, reason: "INDEX_MISS_AFTER_ANALYZED" }) + "\n");
        return true;
      }
      const rowBase = STEP44_HIER
        ? analysisRow(rec, rec.audioFeatures ? await heuristicSurface(classifier, rec.audioFeatures) : undefined)
        : analysisRow(rec);
      analyzed.push(rowBase);
      analysisStream.write(JSON.stringify(rowBase) + "\n");
      alreadyAnalyzed.add(s.name);
      if (analyzed.length % 20 === 0) console.error(`  ... [${reason}] ${analyzed.length} analyzed / ${attempted} attempted`);
    } else {
      skipped.push({ sampleId: s.name, reason: outcome.error });
      skippedStream.write(JSON.stringify({ kind: "skipped", sampleId: s.name, reason: outcome.error }) + "\n");
      if (skipped.length % 100 === 0) console.error(`  ... ${skipped.length} skipped so far`);
    }
    return analyzed.length < TARGET;
  };

  let cursor = RESUME_SKIP;
  try {
    // Phase B1 — deterministic base scan (same first-N order as STEP42).
    for (; cursor < all.length; cursor++) {
      if (analyzed.length >= TARGET) break;
      const s = all[cursor];
      const keepGoing = await analyzeOne(s, "base");
      if (!keepGoing) break;
    }
    // Phase B2 — STEP44 stratified stress set: short one-shots (<=0.5s) then
    // loops (>=4s), deterministically ordered by sampleId, skipped if the base
    // scan already covered them.
    if (STEP44_HIER && STRATIFIED > 0 && analyzed.length < TARGET) {
      const shortOneShots = all
        .filter((s) => (s.durationSeconds ?? 1e9) <= 0.5 && (s.kind === "one-shot" || s.kind === "unknown" || !s.kind))
        .sort((a, b) => a.name.localeCompare(b.name));
      const loops = all
        .filter((s) => (s.durationSeconds ?? 0) >= 4 && s.kind === "loop")
        .sort((a, b) => a.name.localeCompare(b.name));
      const pool = [...shortOneShots, ...loops];
      console.error(`  stratified pool: shortOneShots=${shortOneShots.length}, loops=${loops.length}`);
      for (const s of pool) {
        if (analyzed.length >= TARGET) break;
        const keepGoing = await analyzeOne(s, "stratified");
        if (!keepGoing) break;
      }
    }
  } finally {
    analysisStream.end();
    skippedStream.end();
  }

  const analyzedCount = analyzed.length;

  const summary = {
    audit: STEP44_HIER ? "STEP44 hierarchical classification audit" : "STEP42 classification audit",
    build: BUILD,
    enumeratedAt,
    resumed: RESUME,
    resumeSkip: RESUME_SKIP,
    step44: STEP44_HIER
      ? {
          hierVersion: "hier-v1",
          heuristicVersion: "heuristic-v1",
          baseSamples: AUDIT_SAMPLES,
          stratifiedSamples: STRATIFIED,
          note: "each analysis row carries BOTH the heuristic-v1 surface (row.legacy) and the hier-v1 tree (row.hier); corpus = ordered base scan + short-one-shot(<=0.5s)/loop(>=4s) stress set, all DERIVED by current code over real audio",
        }
      : undefined,
    source: {
      type: "live Audiotool metadata (metadata rows) + current code derived over real audio (analysis rows)",
      note: "no persisted local SampleMap index/export existed on this machine at enumeratedAt (verified by search); metadata is REAL, analysis fields are DERIVED by the CURRENT implementation, tags are RAW user tags verbatim",
      patScope: "personal access token from .env (AT_PAT)",
    },
    metadata: {
      totalSamples: all.length,
      pages,
      stoppedEarly: stopped,
      kindCounts,
      withTags: all.filter((s) => (s.tags ?? []).length > 0).length,
      distinctTags: tagKeys.length,
      tagFrequencies: Object.fromEntries(tagKeys.slice(0, 50).map((k) => [k, tagFreq[k]])),
      avgTagsPerSample: all.length ? all.reduce((a, s) => a + (s.tags ?? []).length, 0) / all.length : 0,
    },
    analysis: {
      targetSamples: TARGET,
      attempted,
      analyzedCount,
      statusCounts,
      skippedReasons: countBy(skipped, (r) => r.reason),
    },
    outputs: {
      metadata: metaPath,
      analysis: analysisPath,
      skipped: skippedPath,
    },
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  await db.db.close();
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});