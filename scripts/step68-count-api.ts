import { readFileSync } from "fs";

const env: Record<string, string> = {};
for (const line of readFileSync(".env", "utf8").split("\n")) {
  if (!line.includes("=")) continue;
  const i = line.indexOf("=");
  env[line.slice(0, i)] = line.slice(i + 1).trim();
}
const PAT = env.AT_PAT ?? "";

const base = "https://api.audiotool.com";
const headers = { Authorization: `Bearer ${PAT}` };

type Sample = {
  name?: string;
  ownerName?: string;
  owner?: string;
  kind?: string;
  numFavorites?: number;
  numUsages?: number;
  visibility?: string;
};

async function listPage(pageSize: number, pageToken?: string) {
  const url = `${base}/samples?pageSize=${pageSize}${pageToken ? `&pageToken=${pageToken}` : ""}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { samples?: Sample[]; nextPageToken?: string };
  return { samples: json.samples ?? [], nextPageToken: json.nextPageToken };
}

let collected: Sample[] = [];
let token: string | undefined;
let pageCount = 0;
for (;;) {
  const { samples, nextPageToken } = await listPage(100, token);
  pageCount++;
  collected.push(...samples);
  token = nextPageToken;
  if (!token) break;
  if (pageCount > 60) break; // safety
}

const owners = new Map<string, number>();
const kinds = new Map<string, number>();
let favorites = 0;
let withFav = 0;
let withUse = 0;
let own = 0;
for (const s of collected) {
  owners.set(s.ownerName ?? s.owner ?? "?", (owners.get(s.ownerName ?? s.owner ?? "?") ?? 0) + 1);
  kinds.set(s.kind ?? "?", (kinds.get(s.kind ?? "?") ?? 0) + 1);
  if ((s.numFavorites ?? 0) > 0) withFav++;
  if ((s.numUsages ?? 0) > 0) withUse++;
  if (s.owner === "users/sumad" || s.ownerName === "sumad") own++;
}

console.log(JSON.stringify({
  totalViaPAT: collected.length,
  pageCount,
  owners: [...owners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
  kinds: [...kinds.entries()],
  withFavorites: withFav,
  withUsages: withUse,
}, null, 1));

// Sample listing to cross-check
const sampleOf = collected.slice(0, 5).map((s) => ({ name: s.name, owner: s.ownerName ?? s.owner }));
console.log(JSON.stringify({ first5: sampleOf }, null, 1));