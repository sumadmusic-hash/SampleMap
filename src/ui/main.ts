import { mountSampleMap } from "./render";
import { buildBrowserDeps } from "./bootstrap";
import type { ProjectOption } from "./app";
import type { AudiotoolClient, SyncedDocument } from "@audiotool/nexus";
import type { GlobalSampleIndex } from "../global/contract";
import type { GlobalPublishQueue } from "../global/publishQueue";
import type { PublishDeliveryMode } from "./view";

/**
 * SampleMap V1 UI entry point.
 *
 * Step-11 scope delivers the UI controller, view-models, renderer and browser
 * bootstrap (all above). A live, authenticated run additionally requires the
 * OAuth login + project-open flow (Step 12 / real backend) — that flow is NOT
 * verified by the automated tests. This module wires the pieces once the
 * caller has an authenticated client + an opened project document.
 *
 * Step 16J: pass the same live `GlobalSampleIndex` (e.g. from
 * `createGlobalProvider`) as `globalIndex` so the analysis pipeline reuses
 * globally-known, compatible analyses instead of re-analyzing audio locally.
 *
 * Usage (after authentication):
 *   const provider = await createGlobalProvider({ baseUrl: VITE_GLOBAL_WORKER_URL });
 *   const deps = await buildBrowserDeps({ client, doc, globalIndex: provider });
 *   const app = mountSampleMap(document.getElementById("app")!, deps);
 *   await app.refreshSearch();
 *
 * `mountAuthenticated` does NOT start any scan or indexing on its own: opening
 * the app leaves it on the empty state until the user triggers a scan manually
 * (Advanced -> Start Scan). `startBackgroundIndexing` still exists for explicit
 * callers but is no longer invoked here.
 */
export async function mountAuthenticated(
  root: HTMLElement,
  opts: {
    client: AudiotoolClient;
    doc: SyncedDocument;
    /** STEP38 — authenticated user display name (resolves → stable account id). */
    authenticatedUserName?: string;
    globalIndex?: GlobalSampleIndex;
    /**
     * STEP16R E-P6 — the read-only publish queue whose snapshot feeds the
     * publish-status surface. Defaults to `undefined` (no publish surface).
     */
    globalPublishQueue?: GlobalPublishQueue;
    /** STEP16R E-P6 — delivery mode of the wired provider. Default "offline". */
    globalPublishDelivery?: PublishDeliveryMode;
    /**
     * STEP85 — the projects offered in the header picker. When empty the picker
     * degrades to a read-only display of the open project (no fake choices).
     */
    projects?: readonly ProjectOption[];
    /**
     * STEP85 — name of the project this mount has open. Required for the picker
     * to mark the current selection; the document itself only exposes a DAW URL.
     */
    projectName?: string;
    /**
     * STEP85 — switch the whole session to another project.
     *
     * The caller owns the remount: it must stop indexing, dispose the current
     * app, open the requested project and mount again. The app only reports
     * the intent — it never opens a document itself.
     */
    onSelectProject?: (name: string) => Promise<void>;
  },
) {
  const deps = await buildBrowserDeps(opts);
  deps.projects = opts.projects ?? [];
  deps.projectName = opts.projectName;
  deps.onSelectProject = opts.onSelectProject;
  const app = mountSampleMap(root, deps);
  await app.refreshSearch();
  // Step 16K: load global map points when a global index is configured.
  if (opts.globalIndex) void app.refreshGlobalPoints();
  // STEP93: NO automatic scan / background indexing on mount. Opening the app
  // only wires the UI and loads what already exists; the library is indexed
  // exclusively through the manual `Advanced -> Start Scan` control.
  return app;
}
