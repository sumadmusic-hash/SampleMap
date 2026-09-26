#!/usr/bin/env -S npx tsx
/**
 * Reproduce the user's original "Juul perc" failure: reference a sample using
 * the LEGACY hyphen-stripped name form (`samples/0001a43b8ac56a5690314a5b9e6d2f6c`)
 * against the real backend, to confirm the rejection is a canonical-name
 * resolution rule (not an ownership gate).
 *
 * Uses the REAL PAT client and a REAL live Machiniste commit.
 */
import { createAudiotoolClient, createPATAuth } from "@audiotool/nexus";
import { createNodeTransport, createDiskWasmLoader } from "@audiotool/nexus/node";
import { loadLibrarySampleIntoMachiniste } from "../src/machiniste";

const PAT = process.env.AT_PAT ?? "";
if (!PAT) {
  console.error("AT_PAT not set.");
  process.exit(1);
}

const LEGACY_NAME = "samples/0001a43b8ac56a5690314a5b9e6d2f6c"; // user-reported id (no hyphens)
const CANONICAL_NAME = "samples/0001a43b-ed6d-54c9-b8cd-3c9c15dcc694"; // same sample, hyphenated

async function refs(doc: any, name: string, label: string) {
  const fakeSample = {
    name,
    displayName: "Juul perc",
    description: "",
    ownerName: "users/tye_master_83",
    favoritedByUser: false,
    numFavorites: 0,
    numUsages: 0,
    bpm: 0,
    kind: "one-shot",
    visibility: "public",
    tags: ["perc"],
    createTime: undefined,
    updateTime: undefined,
    durationSeconds: 0.41,
  } as any;
  const r = await loadLibrarySampleIntoMachiniste(doc, fakeSample);
  console.log(`\n[${label}] name=${name}`);
  console.log(`  committed(created)=${r.created}, directReferenceApplied=${r.directReferenceApplied}, readBackMatches=${r.readBackMatches}`);
  if (r.errors.length > 0) {
    console.log(`  errors: ${JSON.stringify(r.errors)}`);
  } else {
    console.log("  errors: []");
  }
}

async function main() {
  const client = await createAudiotoolClient({
    auth: createPATAuth(PAT),
    transport: createNodeTransport(),
    wasm: createDiskWasmLoader(),
  });
  const projects = await client.projects.listProjects({ pageSize: 5 });
  if (projects instanceof Error) throw projects;
  const project = projects.projects[0];
  const doc = await client.open(project.name);
  await doc.start();

  await refs(doc, CANONICAL_NAME, "CANONICAL (hyphenated UUID)");
  await refs(doc, LEGACY_NAME, "LEGACY (hyphens stripped)");

  await doc.stop();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});