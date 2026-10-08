#!/usr/bin/env -S npx tsx --env-file=.env
/**
 * STEP98 — tagged DRUM corpus with real audio, measured against the USER TAG.
 *
 * Unlike `step98-drum-agreement.ts` (which joins against already-published
 * classifications), this builder downloads the real lossless audio of
 * drum-tagged samples and runs the CURRENT pipeline over it, so the resulting
 * numbers describe the classifier as it is NOW — including the STEP97 feature
 * fix — and can be attributed to features, not to stale published rows.
 *
 * Selection is deliberately biased to drums: only samples whose user tags
 * resolve to exactly ONE drum ClassId are candidates, and loops / one-shots are
 * interleaved so both are represented.
 *
 * Usage:
 *   AT_PAT=<pat> npx tsx scripts/step98-drum-corpus.ts \
 *       [--max-samples 20000] [--analyze 300] [--out <dir>]
 *
 * Emits: <out>/step98-drum-corpus.ndjson + <out>/step98-drum-corpus.json
 * No audio bytes are ever persisted; nothing is written into the repository.
 */
import type { SampleMeta } from "@audiotool/nexus/api";
import { createAudiotoolClient, createPATAuth } from "@audiotool/nexus";
import { createNodeTransport, createDiskWasmLoader } from "@audiotool/nexus/node";
import fs from "node:fs";
import "fake-indexeddb/auto";
import { openDatabase } from "../src/persistence/db";
import { AnalysisPipeline } from "../src/pipeline/analysisPipeline";
import { extractFeatures } from "../src/audio/featureExtractor";
import { HeuristicClassifier } from "../src/classify/heuristicClassifier";
import { HierClassifier } from "../src/classify/hierClassifier";
import type { DecodedAudio } from "../src/audio/decodedAudio";
import { selectLosslessSource } from "../src/pipeline/sourceSelection";
import type { SampleIndexRecord } from "../src/persistence/indexStore";
import { normalizeTag } from "../src/classify/normalizeTag";
import { isStrongTypeTerm, subtypeToType } from "../src/classify/hier/evidence";
import { tagToSubtype } from "../src/classify/drumOntology";
import type { ClassId } from "../src/classify/classifier";

const PAT = process.env.AT_PAT ?? "";
if (!PAT) {
  console.error("AT_PAT not set (see .env)");
  process.exit(1);
}

const readArg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const MAX_SAMPLES = Number(readArg("--max-samples") ?? "20000");
const ANALYZE = Number(readArg("--analyze") ?? "300");
const PAGE_SIZE = Number(readArg("--page-size") ?? "100");
const OUT_DIR =
  readArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step98";

const BUILD = "smap-step98-corpus-v1";
const DRUM_TYPES: readonly ClassId[] = [
  "kick", "snare", "clap", "hihat", "openhat", "tom", "cymbal", "percussion",
];

function drumLabelsFromTags(tags: readonly string[]): ClassId[] {
  const found = new Set<ClassId>();
  for (const raw of tags) {
    const norm = normalizeTag(raw);
    if (norm.length === 0) continue;
    const subtype = tagToSubtype(norm);
    if (subtype !== undefined) found.add(subtypeToType(subtype));
    for (const t of DRUM_TYPES) if (isStrongTypeTerm(norm, t)) found.add(t);
  }
  return [...found];
}

/** Node WAV decoder (16-bit PCM → mono Float32Array). Same as the STEP42 audit. */
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
      sum += dv.getInt16(dataStart + (i * fmt.channels + c) * 2, true) / 32768;
    }
    mono[i] = sum / fmt.channels;
  }
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    mono,
    durationSeconds: frames / fmt.sampleRate,
  };
}

type Candidate = { meta: SampleMeta; label: ClassId };

async function main() {
  const client = await createAudiotoolClient({
    auth: createPATAuth(PAT),
    transport: createNodeTransport(),
    wasm: createDiskWasmLoader(),
  });
  if (!client.samples) throw new Error("client.samples unavailable");

  const metas = new Map<string, SampleMeta>();
  const candidates: Candidate[] = [];
  let pageToken: string | undefined;
  let enumerated = 0;
  let ambiguous = 0;
  while (enumerated < MAX_SAMPLES) {
    const res = await client.samples.list({ pageSize: PAGE_SIZE, pageToken });
    if (res instanceof Error) throw new Error(`list failed: ${res.message}`);
    for (const s of res.samples) {
      if (enumerated >= MAX_SAMPLES) break;
      enumerated++;
      metas.set(s.name, s);
      const labels = drumLabelsFromTags(s.tags ?? []);
      if (labels.length === 0) continue;
      if (labels.length > 1) {
        ambiguous++;
        continue;
      }
      if (!s.wavUrl) continue; // the Node decoder only handles WAV
      candidates.push({ meta: s, label: labels[0] });
    }
    pageToken = res.nextPageToken || undefined;
    if (!pageToken) break;
    if (enumerated % 2000 === 0) process.stderr.write(`\r  enumerated ${enumerated}`);
  }
  process.stderr.write(`\nenumerated=${enumerated} drum-tagged(wav)=${candidates.length} ambiguous=${ambiguous}\n`);

  // Interleave loops and one-shots so both kinds are represented in the budget.
  const loops = candidates.filter((c) => c.meta.kind === "loop");
  const shots = candidates.filter((c) => c.meta.kind !== "loop");
  const selected: Candidate[] = [];
  for (let i = 0; selected.length < ANALYZE && (i < loops.length || i < shots.length); i++) {
    if (i < shots.length && selected.length < ANALYZE) selected.push(shots[i]);
    if (i < loops.length && selected.length < ANALYZE) selected.push(loops[i]);
  }
  process.stderr.write(`selected=${selected.length} (loops=${selected.filter((s) => s.meta.kind === "loop").length})\n`);

  const db = await openDatabase(`step98-corpus-${Date.now()}`);
  const classifier = new HeuristicClassifier();
  const hierClassifier = new HierClassifier();
  const pipeline = new AnalysisPipeline({
    fetchAudio: async (sample, source) => {
      const blob = await client.samples.download(sample, { format: source.format });
      if (blob instanceof Error) throw blob;
      return { bytes: await blob.arrayBuffer(), release: () => undefined };
    },
    decode: nodeWavDecode,
    extract: extractFeatures,
    classifier,
    classifyHier: async (input) => hierClassifier.classifyHier(input),
    resolveSample: async (id) => metas.get(id),
    index: db.index,
    analysisVersion: "features-v1",
  });

  const rows: Array<Record<string, unknown>> = [];
  const statusCounts: Record<string, number> = {};
  for (let i = 0; i < selected.length; i++) {
    const { meta, label } = selected[i];
    if (!selectLosslessSource(meta)) {
      statusCounts["no-lossless"] = (statusCounts["no-lossless"] ?? 0) + 1;
      continue;
    }
    try {
      const outcome = await pipeline.run(meta.name, BUILD);
      statusCounts[outcome.status] = (statusCounts[outcome.status] ?? 0) + 1;
      if (outcome.status !== "analyzed") continue;
      const rec: SampleIndexRecord | undefined = await db.index.get(meta.name);
      if (!rec) continue;
      rows.push({
        sampleId: meta.name,
        name: meta.displayName,
        kind: meta.kind,
        label,
        primaryClass: rec.primaryClass,
        confidence: rec.confidence,
        family: rec.hier?.family,
        hierType: rec.hier?.type,
        structure: rec.hier?.structure,
        classificationVersion: rec.classificationVersion,
        durationSec: rec.audioFeatures?.duration,
        flatness: rec.analysisV2?.features?.spectralFlatness ?? rec.audioFeatures?.spectralFlatness,
        centroidHz: rec.analysisV2?.features?.spectralCentroidHz ?? rec.audioFeatures?.spectralCentroid,
        harmonicity: rec.analysisV2?.features?.harmonicity,
        transientStrength: rec.analysisV2?.features?.transientStrength,
        zcr: rec.analysisV2?.features?.zeroCrossingRate ?? rec.audioFeatures?.zeroCrossingRate,
        crest: rec.analysisV2?.features?.crestFactor,
        tags: meta.tags ?? [],
        // STEP100 — the FULL feature sets are persisted so any later weight /
        // threshold candidate can be evaluated OFFLINE against the identical
        // corpus (no re-download, no re-analysis). Additive; consumers that only
        // read the summary fields above are unaffected.
        audioFeatures: rec.audioFeatures ?? null,
        v2Features: rec.analysisV2?.features ?? null,
      });
    } catch (e) {
      statusCounts["threw"] = (statusCounts["threw"] ?? 0) + 1;
    }
    if ((i + 1) % 25 === 0) process.stderr.write(`\r  analyzed ${rows.length}/${i + 1}`);
  }
  process.stderr.write("\n");

  const kindBucket = (k: unknown) => (k === "loop" ? "loop" : k === "one-shot" ? "one-shot" : "other");
  const summary: Record<string, unknown> = {
    at: new Date().toISOString(),
    enumerated,
    candidates: candidates.length,
    ambiguous,
    selected: selected.length,
    analyzed: rows.length,
    statusCounts,
  };
  console.log("=== STEP98 drum corpus (real audio, current pipeline) ===");
  console.log(JSON.stringify(summary, null, 2));

  for (const bucket of ["one-shot", "loop", "other"]) {
    const rs = rows.filter((r) => kindBucket(r.kind) === bucket);
    if (rs.length === 0) continue;
    const drum = rs.filter((r) => DRUM_TYPES.includes(r.primaryClass as ClassId)).length;
    const exact = rs.filter((r) => r.primaryClass === r.label).length;
    const drumFamily = rs.filter((r) => r.family === "drums").length;
    console.log(
      `\n${bucket}: n=${rs.length}  drums-family=${((drumFamily / rs.length) * 100).toFixed(0)}%  predicted-drum-type=${((drum / rs.length) * 100).toFixed(0)}%  exact=${((exact / rs.length) * 100).toFixed(0)}%`,
    );
  }

  const matrix = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const row = matrix.get(r.label as string) ?? new Map<string, number>();
    row.set(r.primaryClass as string, (row.get(r.primaryClass as string) ?? 0) + 1);
    matrix.set(r.label as string, row);
  }
  console.log("\nconfusion (tag label -> current classifier primaryClass):");
  for (const label of DRUM_TYPES) {
    const row = matrix.get(label);
    if (!row) continue;
    const total = [...row.values()].reduce((a, b) => a + b, 0);
    const cells = [...row.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ");
    console.log(`  ${label.padEnd(11)} n=${String(total).padStart(4)}  ${cells}`);
  }

  console.log("\nnon-drum predictions on drum-tagged LOOPS (family != drums):");
  for (const r of rows.filter((x) => kindBucket(x.kind) === "loop" && x.family !== "drums").slice(0, 20)) {
    console.log(
      `  ${String(r.label).padEnd(11)} -> ${String(r.primaryClass).padEnd(11)} fam=${String(r.family).padEnd(16)} dur=${Number(r.durationSec).toFixed(2)}s flat=${Number(r.flatness).toFixed(4)} cent=${Math.round(Number(r.centroidHz))} harm=${r.harmonicity === null || r.harmonicity === undefined ? "null" : Number(r.harmonicity).toFixed(2)} ts=${r.transientStrength === null || r.transientStrength === undefined ? "null" : Number(r.transientStrength).toFixed(1)}  "${r.name}"`,
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(`${OUT_DIR}/step98-drum-corpus.ndjson`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(
    `${OUT_DIR}/step98-drum-corpus.json`,
    JSON.stringify({ summary, rows, matrix: Object.fromEntries([...matrix].map(([k, v]) => [k, Object.fromEntries(v)])) }, null, 2),
  );
  console.log(`\nwrote ${OUT_DIR}/step98-drum-corpus.ndjson (${rows.length} rows)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
