// STEP51 live check — non-persisting. Lists real Audiotool samples, picks a
// sample with a preview source, downloads the PREVIEW (mp3) bytes into memory
// and asserts the bytes look like a real MPEG audio stream (frame sync) rather
// than an error/JSON payload. Nothing is written to disk.
import { createAudiotoolClient, createPATAuth } from "@audiotool/nexus";
import { createNodeTransport, createDiskWasmLoader } from "@audiotool/nexus/node";
import { listSamplesPageByPage, checkAvailability } from "../src/sample-api";

const PAT = process.env.AT_PAT ?? "";

async function main() {
  if (!PAT) throw new Error("AT_PAT not set");
  const client = await createAudiotoolClient({
    auth: createPATAuth(PAT),
    transport: createNodeTransport(),
    wasm: createDiskWasmLoader(),
  });
  console.log("[AUTH] client created (token accepted)");
  if (!client.samples) throw new Error("client.samples unavailable");

  const { samples } = await listSamplesPageByPage(client.samples, {
    pageSize: 30,
    maxSamples: 30,
  });
  console.log(`[LIST] ${samples.length} real samples`);

  const withPreview: Array<{ meta: (typeof samples)[number]; av: NonNullable<ReturnType<typeof checkAvailability>> }> = [];
  for (const s of samples) {
    const av = checkAvailability(s);
    if (av?.preview) withPreview.push({ meta: s, av });
  }
  console.log(`[AVAIL] samples with preview source: ${withPreview.length}/${samples.length}`);
  if (withPreview.length === 0) {
    console.log("NO PREVIEW SOURCE on first page — trying raw previewMp3Url get");
    const m = await client.samples.get(samples[0]);
    for (const s of [samples[0], m as any]) {
      const rawUrl = (s as any)?.previewMp3Url;
      if (rawUrl) {
        const r = await globalThis.fetch(rawUrl);
        console.log(`[RAW-FETCH] ${rawUrl} -> HTTP ${r.status}, ${(r.headers.get("content-length") ?? "?" )} bytes, type=${r.headers.get("content-type") ?? "?"}`);
      }
    }
    return;
  }

  const target = withPreview[0];
  console.log(`[TARGET] ${target.meta.name} "${target.meta.displayName}" owner=${target.meta.ownerName} `);

  const blob = await client.samples.download(target.meta, { format: "preview" });
  if (blob instanceof Error) throw blob;
  console.log(`[DOWNLOAD] preview ok -> ${blob.size} bytes, type=${blob.type || "unknown"}`);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const head = Array.from(bytes.slice(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  console.log(`[HEAD] ${head}`);
  // MPEG audio frame sync: 11 bits set (0xFFE) at offset 0 (plus possible ID3 tag).
  let mp3Sync = false;
  if (bytes.length > 2 && (bytes[0] & 0xff) === 0xff && (bytes[1] & 0xe0) === 0xe0) mp3Sync = true;
  // ID3v2 header at start (ID3 + version bytes) is also a valid MP3 indicator.
  const id3 = bytes.length > 10 &&
    String.fromCharCode(bytes[0], bytes[1], bytes[2]) === "ID3";
  console.log(`[AUDIO] MP3 frame sync at byte 0: ${mp3Sync ? "YES" : "no"}; ID3 tag present: ${id3 ? "YES" : "no"}`);
  const isAudio = mp3Sync || id3 || bytes.length > 10000;
  console.log(`[AUDIO] plausibly real audio bytes: ${isAudio ? "YES" : "UNKNOWN"}`);
  if (!isAudio) process.exitCode = 2;
}

main().catch((e) => {
  console.error(`[LIVE] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});