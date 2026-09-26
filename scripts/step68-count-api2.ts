import { createAudiotoolClient, createPATAuth } from "@audiotool/nexus";
import { createNodeTransport, createDiskWasmLoader } from "@audiotool/nexus/node";

async function main() {
  const PAT = process.env.AT_PAT ?? "";
  const client = await createAudiotoolClient({
    auth: createPATAuth(PAT),
    transport: createNodeTransport(),
    wasm: createDiskWasmLoader(),
  });

  let collected: Array<Record<string, unknown>> = [];
  let token: string | undefined;
  let pages = 0;
  for (let i = 0; i < 60; i++) {
    const res = await client.samples.list({ pageSize: 20, pageToken: token });
    if (res instanceof Error) throw new Error(`list failed: ${res.message}`);
    collected.push(...res.samples);
    token = res.nextPageToken || undefined;
    pages++;
    if (!token || res.samples.length === 0) break;
  }

  const owners: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  let withFav = 0;
  let withUse = 0;
  let sumadOwn = 0;
  for (const s of collected as Array<{ ownerName?: string; kind?: string; numFavorites?: number; numUsages?: number }>) {
    const owner = s.ownerName ?? "?";
    owners[owner] = (owners[owner] ?? 0) + 1;
    if (owner === "sumad") sumadOwn++;
    kinds[s.kind ?? "?no-kind"] = (kinds[s.kind ?? "?no-kind"] ?? 0) + 1;
    if ((s.numFavorites ?? 0) > 0) withFav++;
    if ((s.numUsages ?? 0) > 0) withUse++;
  }

  process.stdout.write(JSON.stringify({
    auth: "PAT",
    total: collected.length,
    pages,
    sumadOwn,
    owners: Object.entries(owners).sort((a, b) => b[1] - a[1]).slice(0, 25),
    kinds,
    withFavorites: withFav,
    withUsages: withUse,
  }, null, 1));
}
main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });