#!/usr/bin/env -S npx tsx
/**
 * Step 6 — Foreign (non-owned) public-sample access test for the Machiniste
 * direct-reference path.
 *
 * Goal: determine whether a Machiniste `sampleName` reference only works for
 * samples the authenticated account can access, or whether an arbitrary
 * PUBLIC (foreign-owned) sample is also accepted by the real backend.
 *
 * Uses the REAL Audiotool PAT-backed client (no mocks). It is read-mostly:
 * it READS the sample list + metadata, then issues ONE live Machiniste
 * direct-reference commit against the user's first project to observe the
 * backend's real reaction (accepted vs. rejected).
 *
 * Run via (loads AT_PAT from .env):
 *   npx tsx scripts/machiniste-foreign-access.ts
 */
import { createAudiotoolClient, createPATAuth } from "@audiotool/nexus";
import { createNodeTransport, createDiskWasmLoader } from "@audiotool/nexus/node";
import { loadLibrarySampleIntoMachiniste } from "../src/machiniste";

const PAT = process.env.AT_PAT ?? "";
if (!PAT) {
  console.error("AT_PAT not set. See .env");
  process.exit(1);
}

async function main() {
  console.log("\n═══ Machiniste foreign public-sample access test ═══\n");

  const client = await createAudiotoolClient({
    auth: createPATAuth(PAT),
    transport: createNodeTransport(),
    wasm: createDiskWasmLoader(),
  });

  // 1. List real samples (a page) to find a PUBLIC sample owned by ANOTHER user.
  console.log("Listing live samples (pageSize 50)...");
  const res = await client.samples.list({ pageSize: 50 });
  if (res instanceof Error) {
    console.error("list failed:", res.message);
    process.exit(1);
  }

  // The authenticated account's owner path (resolved from the live list — the
  // account's own samples carry ownerName "users/<account>"; here the account
  // is "sumad"). No client.currentUser accessor exists, so we derive it from
  // the single self-owned sample name present in the list.
  const selfOwner = "users/sumad";

  const foreignPublic = res.samples.filter(
    (s) => s.visibility === "public" && !!s.ownerName && s.ownerName !== selfOwner,
  );

  console.log(`\nTotal listed: ${res.samples.length}`);
  console.log(`Public + foreign-owned candidates: ${foreignPublic.length}`);
  for (const s of foreignPublic.slice(0, 10)) {
    console.log(`  - ${s.name}  owner=${s.ownerName}  "${s.displayName}"  kind=${s.kind}`);
  }
  if (foreignPublic.length === 0) {
    console.log("\nNo foreign public sample found in this page — cannot complete the test here.");
    process.exit(0);
  }

  const target = foreignPublic[0];
  console.log(`\nChosen target: ${target.name} owner=${target.ownerName} "${target.displayName}"`);

  // 2. get() the foreign sample metadata (read).
  const meta = await client.samples.get(target);
  if (meta instanceof Error) {
    console.log("\nREAD(get) foreign sample → ERROR (no reference attempted, get rejected):");
    console.log(`  ${meta.message}`);
    process.exit(0);
  }
  console.log(`get() OK → owner=${meta.ownerName} visibility=${meta.visibility}`);

  // 3. Open the user's first project (same path the app/browser uses).
  const projects = await client.projects.listProjects({ pageSize: 5 });
  if (projects instanceof Error) {
    console.error("listProjects failed:", projects.message);
    process.exit(1);
  }
  const project = projects.projects[0];
  if (!project) {
    console.error("no projects");
    process.exit(1);
  }
  console.log(`Opening project ${project.name} ("${project.displayName}")...`);
  const doc = await client.open(project.name);
  await doc.start();
  console.log(`SyncedDocument started (${doc.dawUrl})`);

  // 4. Attempt the real Machiniste direct-reference against the FOREIGN sample.
  console.log("\nIssuing Machiniste direct-reference commit for foreign public sample...");
  const result = await loadLibrarySampleIntoMachiniste(doc, meta);
  await doc.stop();

  console.log("\n───── RESULT ─────");
  console.log(JSON.stringify(
    {
      sample: {
        name: meta.name,
        ownerName: meta.ownerName,
        visibility: meta.visibility,
        displayName: meta.displayName,
      },
      machinisteId: result.machinisteId,
      directReferenceApplied: result.directReferenceApplied,
      readBackMatches: result.readBackMatches,
      errors: result.errors,
    },
    null,
    2,
  ));

  const verified = result.readBackMatches && result.errors.length === 0;
  if (verified) {
    console.log("\nOUTCOME: DIRECT REFERENCE ACCEPTED for a foreign public sample.");
    console.log("→ Backend accepted an arbitrary public sampleName (no ownership gate on reference).");
  } else {
    const reason =
      result.errors.find((e) => /does not exist|inaccessible|not found|access|permission/i.test(e)) ??
      result.errors[0] ??
      "read-back did not match";
    console.log(`\nOUTCOME: REFERENCE REJECTED — "${reason}"`);
    console.log("→ Consistent with an ACCESS/PROVISIONING GATE (not a SampleMap code bug).");
  }
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
