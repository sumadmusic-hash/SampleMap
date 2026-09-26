import { createAudiotoolClient, createPATAuth } from "@audiotool/nexus";
import { createNodeTransport, createDiskWasmLoader } from "@audiotool/nexus/node";

async function main() {
  const PAT = process.env.AT_PAT ?? "";
  const client = await createAudiotoolClient({
    auth: createPATAuth(PAT),
    transport: createNodeTransport(),
    wasm: createDiskWasmLoader(),
  });
  
  const res = await client.samples.list({ pageSize: 5 });
  if (res instanceof Error) throw res;
  for (const s of res.samples) {
    if (s.wavUrl) {
      console.log(`Sample: ${s.name} "${s.displayName}"`);
      console.log(`  wavUrl: ${s.wavUrl}`);
      console.log(`  flacUrl: ${s.flacUrl || "(none)"}`);
      if (s.flacUrl) {
        const r = await fetch(s.flacUrl, { method: "HEAD" });
        console.log(`  FLAC direct HEAD: HTTP ${r.status}`);
      }
      break;
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
