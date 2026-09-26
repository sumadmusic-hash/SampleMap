#!/usr/bin/env -S npx tsx
/**
 * STEP63R — temporary startup-timing DIAGNOSTIC (AUDIT ONLY).
 *
 * Measures the REAL network phases of the SampleMap startup path that the
 * OFFLINE harness bypasses, using the same Personal Access Token flow as the
 * existing live-verify scripts:
 *
 *   1. client creation (SDK boot)
 *   2. identity resolution  (src/identity/authenticatedUser.ts)
 *      - projects.listProjects (full token chain)
 *      - users.listUsers (display-name fallback)
 *   3. openFirstProject      (src/ui/liveSession.ts)
 *      - projects.listProjects
 *      - client.open + doc.start (Nexus document sync)
 *
 * Prints high-resolution timings. Does NOT modify any sample/project state.
 * No PAT is printed. Read-only project/document queries only.
 */
import { createAudiotoolClient, createPATAuth } from "@audiotool/nexus";
import { createNodeTransport, createDiskWasmLoader } from "@audiotool/nexus/node";
import {
  resolveAuthenticatedUserId,
  resolveAuthenticatedUserIdFromProjects,
} from "../src/identity/authenticatedUser";
import { quoteDisplayName } from "../src/identity/authenticatedUser";
import { openFirstProject, pickFirstProject } from "../src/ui/liveSession";

const PAT = process.env.AT_PAT ?? "";
if (!PAT) {
  console.error("AT_PAT not set. See .env");
  process.exit(1);
}

const wasm = createDiskWasmLoader();

async function main() {
  const tClient0 = performance.now();
  const client = await createAudiotoolClient({
    auth: createPATAuth(PAT),
    transport: createNodeTransport(),
    wasm,
  });
  console.log(`[step63r] client-create: ${(performance.now() - tClient0).toFixed(1)}ms`);

  // --- Identity resolution (projects route) ---
  const tProjects0 = performance.now();
  const viaProjects = await resolveAuthenticatedUserIdFromProjects(client);
  console.log(`[step63r] identity:projects.listProjects: ${(performance.now() - tProjects0).toFixed(1)}ms viaProjects=${viaProjects}`);

  // --- Identity resolution (display-name route) ---
  const userName = (client as unknown as { userName?: string }).userName as string | undefined;
  const tListUsers0 = performance.now();
  let viaDisplayName: string | undefined;
  if (userName && userName.trim().length > 0) {
    try {
      const res = await client.users.listUsers({
        filter: `user.display_name == ${quoteDisplayName(userName)}`,
        pageSize: 2,
      });
      viaDisplayName =
        res instanceof Error
          ? undefined
          : res.users && res.users.length === 1 && res.users[0].name
            ? res.users[0].name
            : undefined;
    } catch {
      viaDisplayName = undefined;
    }
  }
  console.log(`[step63r] identity:users.listUsers: ${(performance.now() - tListUsers0).toFixed(1)}ms viaDisplayName=${viaDisplayName}`);

  // --- Combined identity resolution ---
  const tId0 = performance.now();
  const combined = await resolveAuthenticatedUserId(client, userName);
  console.log(`[step63r] identity:resolveAuthenticatedUserId: ${(performance.now() - tId0).toFixed(1)}ms combined=${combined}`);

  // --- openFirstProject ---
  const tFirst0 = performance.now();
  const tList0 = performance.now();
  const res = await client.projects.listProjects({ pageSize: 5 });
  console.log(`[step63r] openFirstProject:listProjects: ${(performance.now() - tList0).toFixed(1)}ms`);
  const project = !(res instanceof Error) ? pickFirstProject(res.projects ?? []) : undefined;
  if (project) {
    const tDoc0 = performance.now();
    const doc = await client.open(project.name);
    await doc.start();
    console.log(`[step63r] openFirstProject:openAndStart: ${(performance.now() - tDoc0).toFixed(1)}ms`);
    console.log(`[step63r] openFirstProject:total: ${(performance.now() - tFirst0).toFixed(1)}ms`);
  } else {
    console.log(`[step63r] openFirstProject: NO usable project (could not complete)`);
  }
}

main().catch((e) => {
  console.error(`[step63r] fatal: ${e instanceof Error ? e.message : String(e)}`);
  console.error(e);
});