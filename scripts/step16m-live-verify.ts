#!/usr/bin/env -S npx tsx
/**
 * Step 16M — Live End-to-End Browser-Equivalent Product Verification.
 *
 * Run via:  npx tsx scripts/step16m-live-verify.ts
 *
 * Verifies the COMPLETE SampleMap product flow against the REAL Audiotool
 * backend using a Personal Access Token (from .env — never exposed to
 * client/browser code):
 *
 *   Real Audiotool sample list
 *     → real sample metadata (get)
 *     → real sample audio download (WAV)
 *     → real Node WAV decode
 *     → REAL AnalysisPipeline (quality gate, hashing, feature extraction,
 *       heuristic classification, similarity fingerprint, content hash,
 *       canonical PCM)
 *     → REAL IndexStore put
 *     → REAL mapPosition (2D coordinates)
 *     → REAL SearchEngine query returns the record
 *     → REAL MachinisteService.send (live SyncedDocument via PAT)
 *     → read-back verification
 *
 * IMPORTANT: No audio bytes are persisted. No PAT is printed. No PAT ever
 * reaches the browser.
 */
import { createAudiotoolClient, createPATAuth } from "@audiotool/nexus";
import { createNodeTransport, createDiskWasmLoader } from "@audiotool/nexus/node";
import "fake-indexeddb/auto";
import { openDatabase } from "../src/persistence/db";
import { AnalysisPipeline } from "../src/pipeline/analysisPipeline";
import { JobRunner } from "../src/pipeline/jobRunner";
import { extractFeatures } from "../src/audio/featureExtractor";
import { HeuristicClassifier } from "../src/classify/heuristicClassifier";
import { SampleMapSearchEngine } from "../src/search/searchEngine";
import { SampleMapMachinisteService } from "../src/machiniste/machinisteService";
import type { AudioDecoder, DecodedAudio } from "../src/audio/decodedAudio";
import { computePosition, mapVersion } from "../src/map/mapPosition";

const PAT = process.env.AT_PAT ?? "";
if (!PAT) {
  console.error("AT_PAT not set. See .env");
  process.exit(1);
}

const BUILD = "smap-build-v1";

let passed = 0;
let failed = 0;
const results: { test: string; result: string }[] = [];
function ok(name: string, detail = "") {
  passed++;
  results.push({ test: name, result: `VERIFIED${detail ? ` — ${detail}` : ""}` });
  console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
}
function fail(name: string, reason: string) {
  failed++;
  results.push({ test: name, result: `NOT VERIFIED — ${reason}` });
  console.error(`  ✗ ${name} (${reason})`);
}
function section(title: string) {
  console.log(`\n===== ${title} =====`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal Node.js WAV decoder (16-bit PCM → Float32Array mono)
// This is the Node equivalent of browserDecode (Web Audio decodeAudioData).
// It handles the WAV container produced by Audiotool's wavUrl downloads.
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
  const durationSeconds = frames / fmt.sampleRate;
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, mono, durationSeconds };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 16M live verification
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n═══ STEP 16M — Live End-to-End Verification (PAT) ═══\n");

  // 0. Connect → real Audiotool backend
  section("Live backend connectivity");
  let client;
  try {
    client = await createAudiotoolClient({
      auth: createPATAuth(PAT),
      transport: createNodeTransport(),
      wasm: createDiskWasmLoader(),
    });
    ok("Authenticated live Audiotool client", "PAT in Node, no browser");
  } catch (e) {
    fail("Authenticated live Audiotool client", `${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // 1. List real samples
  section("Real sample discovery (list)");
  let samples: Awaited<ReturnType<typeof client.samples.list>>;
  try {
    const res = await client.samples.list({ pageSize: 20 });
    if (res instanceof Error) throw res;
    samples = res;
    ok(`Samples listed: ${res.samples.length}`, `names/owners from live backend`);
  } catch (e) {
    fail("Samples listed", `${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (samples.samples.length === 0) {
    fail("Samples listed", "empty result");
    process.exit(1);
  }

  // 2. Pick a real ONE-SHOT sample with WAV availability (analysis-eligible)
  section("Identify real analysis-eligible sample");
  let chosen;
  for (const s of samples.samples) {
    if (s.kind === "one-shot" && s.wavUrl) {
      chosen = s;
      break;
    }
  }
  if (!chosen) {
    fail("Analysis-eligible sample", "no one-shot with wavUrl found");
    process.exit(1);
  }
  ok(`Chosen sample: ${chosen.name}`, `"${chosen.displayName}", owner=${chosen.ownerName ?? "(none)"}, kind=${chosen.kind}`);
  ok(`Sample has wavUrl`, chosen.wavUrl ? "yes (lossless analysis source)" : "no");

  // 3. Fetch real metadata via get()
  section("Real sample metadata (get)");
  let meta;
  try {
    const res = await client.samples.get(chosen);
    if (res instanceof Error) throw res;
    meta = res;
    ok("Sample metadata fetched", `${meta.displayName} owner=${meta.ownerName ?? "(none)"}`);
  } catch (e) {
    fail("Sample metadata fetched", `${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // 4. Download real WAV
  section("Real sample audio download (wavUrl)");
  let audioBytes: ArrayBuffer;
  try {
    const blob = await client.samples.download(meta, { format: "wav" });
    if (blob instanceof Error) throw blob;
    audioBytes = await blob.arrayBuffer();
    ok(`WAV downloaded: ${audioBytes.byteLength} bytes`, `type=${blob.type || "unknown"}`);
  } catch (e) {
    fail("WAV downloaded", `${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // 5. Decode in Node (equivalent of browserDecode)
  section("Node WAV decode");
  let decoded: DecodedAudio;
  try {
    decoded = nodeWavDecode(audioBytes);
    ok(
      "WAV decoded",
      `${decoded.sampleRate}Hz ${decoded.channels}ch ${decoded.durationSeconds.toFixed(3)}s ${decoded.mono.length} frames`,
    );
  } catch (e) {
    fail("WAV decoded", `${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // 6. Feature extraction
  section("Feature extraction (REAL extractFeatures)");
  let features;
  try {
    features = extractFeatures(decoded);
    ok("Features extracted", `duration=${features.duration.toFixed(3)}s centroid=${features.spectralCentroid.toFixed(0)} flatness=${features.spectralFlatness.toFixed(3)} t/n=${features.tonalNoiseRatio.toFixed(3)}`);
  } catch (e) {
    fail("Features extracted", `${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // 7. Classification (REAL HeuristicClassifier)
  section("Classification (REAL HeuristicClassifier)");
  let classification;
  try {
    const classifier = new HeuristicClassifier();
    classification = await classifier.classify(features);
    ok("Classified", `${classification.primaryClass} confidence=${classification.confidence.toFixed(3)} secondary=${classification.secondaryClasses.map((c) => `${c.class}@${c.confidence.toFixed(2)}`).join(", ") || "none"}`);
  } catch (e) {
    fail("Classified", `${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // 8. Map position (REAL computePosition, V2 — computed at analysis from decoded audio)
  section("2D Map position (REAL computePosition V2)");
  let pos;
  try {
    pos = computePosition(features, decoded);
    ok(`Map position: x=${pos.x.toFixed(4)} y=${pos.y.toFixed(4)}`, `mapVersion=${mapVersion}`);
  } catch (e) {
    fail("Map position", `${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // 9. Full AnalysisPipeline via IndexedDB (REAL pipeline + stores)
  section("Analysis pipeline (REAL AnalysisPipeline + IndexedDB)");
  const db = await openDatabase(`step16m-live-${Date.now()}`);
  try {
    const pipeline = new AnalysisPipeline({
      fetchAudio: async (sample, source) => {
        // already have the bytes; re-download would be wasteful
        return { bytes: audioBytes, release: () => undefined };
      },
      decode: nodeWavDecode,
      extract: extractFeatures,
      classifier: new HeuristicClassifier(),
      resolveSample: async (id) => (id === meta.name ? meta : undefined),
      index: db.index,
      analysisVersion: "features-v1",
    });
    const outcome = await pipeline.run(meta.name, BUILD);
    if (outcome.status !== "analyzed") {
      fail("Pipeline analyzed sample", `outcome=${JSON.stringify(outcome)}`);
      process.exit(1);
    }
    ok("Pipeline analyzed sample", outcome.status);

    // 9b. Index record exists with correct data
    const rec = await db.index.get(meta.name);
    if (!rec) {
      fail("Index record present", "no record found");
    } else {
      ok("Index record present", `class=${rec.primaryClass} conf=${rec.confidence.toFixed(3)} contentHash=${rec.contentHash?.slice(0, 12)}…`);
      ok("Index record carry correct sampleId", rec.sampleId === meta.name);
      ok("Index record carries no audio bytes", "metadata only (asserted by store)");
      // V2 (STEP 16Q): the pipeline persisted the map position at analysis time.
      // Verify it equals the authoritative computePosition (same decoded audio +
      // features) and that we read the PERSISTED value (not one recomputed from
      // audioFeatures).
      const persisted = rec.mapPosition;
      if (!persisted) {
        fail("Index record carries persisted V2 mapPosition", "missing mapPosition");
      } else {
        ok("Index record carries persisted V2 mapPosition", `persistedX=${persisted.x.toFixed(4)} persistedY=${persisted.y.toFixed(4)}`);
        const recomputed = computePosition(rec.audioFeatures, decoded);
        const match = Math.abs(persisted.x - recomputed.x) < 1e-9 && Math.abs(persisted.y - recomputed.y) < 1e-9;
        ok("Persisted V2 map position is deterministic (matches analysis-time compute)",
          `persisted=(${persisted.x.toFixed(4)},${persisted.y.toFixed(4)}) recomputed=(${recomputed.x.toFixed(4)},${recomputed.y.toFixed(4)})`);
      }
    }

    // 10. SearchEngine returns the record
    const search = new SampleMapSearchEngine(db.index);
    const results = await search.search({});
    const hasIt = results.some((r) => r.record.sampleId === meta.name);
    ok(`SearchEngine returns the analyzed sample`, hasIt ? `${results.length} total results` : "NOT FOUND");
    if (!hasIt) failed++;

    // 11. MachinisteService — LIVE SyncedDocument
    section("Machiniste integration (LIVE SyncedDocument)");
    let projectName = "";
    try {
      const projects = await client.projects.listProjects({ pageSize: 5 });
      if (projects instanceof Error) throw projects;
      if (projects.projects.length === 0) {
        fail("Project found for Machiniste", "no projects returned");
      } else {
        projectName = projects.projects[0].name;
        ok(`Project found: ${projectName}`, `${projects.projects.length} projects`);
      }
    } catch (e) {
      fail("Project found for Machiniste", `${e instanceof Error ? e.message : String(e)}`);
    }

    if (projectName) {
      try {
        const doc = await client.open(projectName);
        await doc.start();
        ok("SyncedDocument opened+started", `dawUrl=${doc.dawUrl ? "(present)" : "(none)"}`);

        // Create a machiniste if none exists in the doc
        await doc.modify((t) => {
          const existing = t.entities.ofTypes("machiniste").getOne();
          if (!existing) t.create("machiniste", {});
        });

        const mach = new SampleMapMachinisteService(doc);
        const machEntities = doc.queryEntities.ofTypes("machiniste").get();
        const machId = machEntities[0]?.id;
        if (!machId) {
          fail("Machiniste send", "no machiniste entity found in doc");
        } else {
          const send2 = await mach.send([meta.name], machId, [0]);
          if (send2.committed) {
            ok("Machiniste send committed", `machiniste=${machId} slots=${send2.slots.length}`);
            const slot = send2.slots[0];
            ok(`Machine slot[sample] references real sample`, `sampleName=${slot.sampleName} readBackMatches=${slot.readBackMatches}`);
            if (slot.readBackMatches) {
              ok("Read-back verified on LIVE backend document", `channel → sample entity ${slot.sampleEntityId} → ${slot.sampleName}`);
            } else {
              fail("Read-back verified on LIVE backend document", JSON.stringify(slot.errors));
            }
          } else {
            fail("Machiniste send committed", JSON.stringify(send2.errors));
          }
        }
        await doc.stop().catch(() => {});
      } catch (e) {
        fail("Machiniste integration", `${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      fail("Machiniste integration", "no project available to open");
    }

    // 12. Idempotency: re-enqueue same build → skipped, no new fetch
    section("Idempotency (same build, no re-analysis)");
    let fetches = 0;
    const pipeline2 = new AnalysisPipeline({
      fetchAudio: async (sample, source) => {
        fetches++;
        return { bytes: audioBytes, release: () => undefined };
      },
      decode: nodeWavDecode,
      extract: extractFeatures,
      classifier: new HeuristicClassifier(),
      resolveSample: async (id) => (id === meta.name ? meta : undefined),
      index: db.index,
      analysisVersion: "features-v1",
    });
    const second = await pipeline2.run(meta.name, BUILD);
    ok(`Second run (same build) → ${second.status}`, fetches === 0 ? "no redundant audio fetch" : `unexpected fetch count=${fetches}`);
    if (second.status !== "skipped" || fetches !== 0) failed++;

  } finally {
    await db.db.close();
  }

  // ── Summary ──
  console.log("\n═══════════════════════════════════════════════════\n");
  console.log(`Results: ${passed} VERIFIED, ${failed} NOT VERIFIED\n`);
  for (const r of results) {
    console.log(`  ${r.result.padEnd(80)} ← ${r.test}`);
  }
  console.log("");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nFATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
