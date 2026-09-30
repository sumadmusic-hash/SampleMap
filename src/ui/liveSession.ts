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
 * List the user's projects for the STEP85 project picker.
 *
 * Reuses the exact same API and page size as `openFirstProject`; the only
 * difference is that the result is returned instead of immediately opened.
 * A non-Error, empty or malformed response yields an empty list so the UI can
 * fall back to showing the currently open project only.
 */
export async function listLiveProjects(
  client: AudiotoolClient,
  pageSize = 5,
): Promise<LiveProject[]> {
  const res = await client.projects.listProjects({ pageSize });
  if (res instanceof Error || !res.projects) return [];
  return res.projects.filter((p) => typeof p?.name === "string" && p.name.length > 0);
}

/**
 * Open one specific project by name and start its document.
 *
 * This is the STEP85 counterpart of `openFirstProject`: the picker needs to
 * open an explicitly chosen project, and both paths must behave identically
 * (throw on API error, `undefined` when no usable project exists).
 */
export async function openLiveProject(
  client: AudiotoolClient,
  name: string,
): Promise<SyncedDocument | undefined> {
  if (name.length === 0) return undefined;
  const doc = await client.open(name);
  await doc.start();
  return doc;
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
  const projects = await listLiveProjects(client, pageSize);
  const project = pickFirstProject(projects);
  if (!project) return undefined;
  return openLiveProject(client, project.name);
}
