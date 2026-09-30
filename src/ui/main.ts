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
 * `mountAuthenticated` additionally starts the AUTOMATIC background indexing
 * (scan, then analyse the due jobs within the 1000 budget) without awaiting it,
 * so the app is usable immediately and fills itself in the background.
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
  // NORMAL PRODUCT PATH: opening the app starts indexing in the background, so
  // the user no longer has to press "Start Scan" and then "Analyse N" first.
  // Fire-and-forget on purpose — the mount must not wait for the scan, let
  // alone for the whole analysis run. The orchestrator sequences the existing
  // `startScan()` + `analyze()` and is a no-op when it was already started.
  void app.startBackgroundIndexing();
  return app;
}
