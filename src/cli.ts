import { createAudiotoolClient, createPATAuth } from "@audiotool/nexus";
import { createNodeTransport, createDiskWasmLoader } from "@audiotool/nexus/node";
import type { SampleFormat, SampleMeta } from "@audiotool/nexus/api";
import {
  listSamplesPageByPage,
  summarizeSample,
  formatLabel,
  checkAvailability,
} from "./sample-api";
import { loadLibrarySampleIntoMachiniste } from "./machiniste";

/**
 * Node.js CLI alternative to the browser POC.
 *
 * Uses a Personal Access Token (https://developer.audiotool.com/personal-access-tokens)
 * to verify that a Nexus client can list, fetch and download samples without a browser.
 *
 * Usage:
 *   AT_PAT=<your-pat> npm run sample              # list up to 20 samples
 *   AT_PAT=<your-pat> npm run sample -- --id <id> # fetch a specific sample's metadata
 *   AT_PAT=<your-pat> npm run sample -- --dl <id> <format>  # download a sample to ./downloads
 *   AT_PAT=<your-pat> npm run sample -- --machiniste <project>  # load a library sample into a Machiniste by direct reference
 *
 * Formats: wav | flac | mp3 | preview
 */

const PAT = process.env.AT_PAT ?? "";

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function ok(msg: string) {
  console.log(`[NEXUS-POC] [OK] ${msg}`);
}
function info(msg: string) {
  console.log(`[NEXUS-POC] [INFO] ${msg}`);
}
function err(msg: string) {
  console.error(`[NEXUS-POC] [ERR] ${msg}`);
}
function section(title: string) {
  console.log(`\n===== ${title} =====`);
}

async function main() {
  if (!PAT) {
    err("AT_PAT environment variable is not set.");
    err("Create one at https://developer.audiotool.com/personal-access-tokens");
    process.exit(1);
  }

  section("Authentication");
  info(`Using Personal Access Token (${PAT.length} chars, not shown)`);

  let client;
  try {
    client = await createAudiotoolClient({
      auth: createPATAuth(PAT),
      transport: createNodeTransport(),
      wasm: createDiskWasmLoader(),
    });
    ok("client created (auth accepted at construction)");
  } catch (e) {
    err(`Failed to create client: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  section("Sample API");
  if (!client.samples) {
    err("client.samples is NOT available on this build");
    process.exit(1);
  }
  ok("client.samples: AVAILABLE");

  const idOnly = readArg("--id");
  const dl = readArg("--dl");
  const machinisteProject = readArg("--machiniste");
  const format = (dl ? process.argv[process.argv.indexOf("--dl") + 2] : undefined) as
    | SampleFormat
    | undefined;

  if (machinisteProject) {
    section(`Machiniste direct-reference test in project ${machinisteProject}`);
    // Pick a public sample (prefer one from a different owner).
    let target: SampleMeta;
    try {
      const { samples } = await listSamplesPageByPage(client.samples, {
        pageSize: 20,
        maxSamples: 20,
      });
      target =
        samples.find((s) => s.visibility === "public" && s.ownerName !== samples[0]?.ownerName) ??
        samples[0];
      ok(`Using sample ${target.name} ("${target.displayName}", owner=${target.ownerName}, visibility=${target.visibility})`);
    } catch (e) {
      err(`Could not pick a sample: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }

    let doc;
    try {
      doc = await client.open(machinisteProject);
      await doc.start();
      ok(`SyncedDocument started (${doc.dawUrl})`);
    } catch (e) {
      err(`open()/start(): FAILED — ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }

    try {
      const result = await loadLibrarySampleIntoMachiniste(doc, target);
      console.log(JSON.stringify(result, null, 2));
      if (result.readBackMatches && result.errors.length === 0) {
        ok(`DIRECT REFERENCE APPLIED + READ BACK VERIFIED into Machiniste ${result.machinisteId}`);
      } else {
        err(`Machiniste test not fully verified: readBackMatches=${result.readBackMatches}, errors=${JSON.stringify(result.errors)}`);
        process.exit(1);
      }
    } finally {
      await doc.stop().catch(() => {});
    }
    return;
  }

  if (idOnly) {
    section(`Fetch single sample ${idOnly}`);
    const name = idOnly.startsWith("samples/") ? idOnly : `samples/${idOnly}`;
    const meta = await client.samples.get(name);
    if (meta instanceof Error) {
      err(`get(): FAILED — ${meta.message}`);
      process.exit(1);
    }
    ok("get(): SUCCESS");
    console.log(summarizeSample(meta));
    return;
  }

  if (dl) {
    const name = dl.startsWith("samples/") ? dl : `samples/${dl}`;
    const f: SampleFormat = format ?? "wav";
    section(`Download ${formatLabel(f)} for ${name}`);
    const blob = await client.samples.download(name, { format: f });
    if (blob instanceof Error) {
      err(`download(): FAILED — ${blob.message}`);
      process.exit(1);
    }
    ok(`download(): SUCCESS — ${blob.size} bytes, type=${blob.type || "unknown"}`);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "downloads");
    mkdirSync(dir, { recursive: true });
    const ext = f === "preview" ? "mp3" : f;
    const out = join(dir, `${blob.size}.${ext}`);
    writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
    ok(`Wrote ${out}`);
    return;
  }

  section("List samples");
  let samples: SampleMeta[] = [];
  try {
    const result = await listSamplesPageByPage(client.samples, {
      pageSize: 20,
      maxSamples: 20,
    });
    samples = result.samples;
    ok(`list(): SUCCESS — ${samples.length} samples across ${result.pageCount} page(s)`);
  } catch (e) {
    err(`list(): FAILED — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (samples.length === 0) {
    err("No samples returned.");
    process.exit(1);
  }

  console.log("\n-- Listing (first page) --");
  for (const [i, s] of samples.entries()) {
    console.log(
      `${String(i + 1).padEnd(3)} ${s.name}  ${s.displayName}  [${s.kind}]  ${s.visibility}  ${s.ownerName}`,
    );
  }

  // Fetch full metadata of the first sample to demonstrate get() and availability.
  const first = samples[0];
  section(`Fetch metadata for ${first.name}`);
  const meta = await client.samples.get(first);
  if (meta instanceof Error) {
    err(`get(): FAILED — ${meta.message}`);
    process.exit(1);
  }
  ok("get(): SUCCESS");
  console.log(summarizeSample(meta));
  const av = checkAvailability(meta);
  info(`WAV=${av?.wav ? "available" : "n/a"} FLAC=${av?.flac ? "available" : "n/a"} MP3=${av?.mp3 ? "available" : "n/a"} Preview=${av?.preview ? "available" : "n/a"}`);

  // Attempt a WAV download as the crucial access check.
  section(`Download WAV for ${meta.name}`);
  const blob = await client.samples.download(meta, { format: "wav" });
  if (blob instanceof Error) {
    err(`download(): FAILED — ${blob.message}`);
    process.exit(1);
  }
  ok(`download(): SUCCESS — ${blob.size} bytes, type=${blob.type || "unknown"}`);
}

main().catch((e) => {
  err(`Fatal error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
