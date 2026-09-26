import type { AudiotoolClient, SyncedDocument } from "@audiotool/nexus";

/**
 * Step 16N — Minimal live browser glue between successful OAuth and
 * `mountAuthenticated`.
 *
 * This is deliberately tiny: it only reuses the existing "open my first project"
 * pattern (already used by `src/main.ts`' runMachinisteTest and
 * `scripts/step16m-live-verify.ts`) and hands the opened document to the
 * existing `mountAuthenticated`. It adds NO SampleMap business logic and NO new
 * auth/scopes — it composes existing pieces only.
 */

/** A project entry as returned by `client.projects.listProjects(...)`. */
export interface LiveProject {
  name: string;
  displayName?: string;
}

/**
 * Pick the first usable project (one with a `name`) from a project list,
 * mirroring the established "open the user's first project" behaviour. Pure —
 * no I/O — so it is structurally testable.
 */
export function pickFirstProject(
  projects: readonly LiveProject[],
): LiveProject | undefined {
  return projects.find((p) => typeof p?.name === "string" && p.name.length > 0);
}

/**
 * List the user's projects (reusing the existing project API), pick the first
 * usable one, open it and start its document. Returns `undefined` when there is
 * no usable project.
 */
export async function openFirstProject(
  client: AudiotoolClient,
  pageSize = 5,
): Promise<SyncedDocument | undefined> {
  const res = await client.projects.listProjects({ pageSize });
  if (res instanceof Error) throw res;
  if (!res.projects || res.projects.length === 0) return undefined;

  const project = pickFirstProject(res.projects);
  if (!project) return undefined;

  const doc = await client.open(project.name);
  await doc.start();
  return doc;
}
