/**
 * STEP85 — the map-dominant primary flow: structural guard.
 *
 * The STEP85 refactor is deliberately PRESENTATION only: no business logic,
 * no pipeline, no map algorithm, no service. That makes a source scan the
 * right tool — these tests lock the STRUCTURE of the new layout (what is
 * mounted in the primary row, what is folded into the advanced drawer, and
 * which pipeline stages the count line reports) so a later edit cannot
 * quietly push a technical surface back into the primary view or drop a
 * feature on the floor.
 *
 * They also assert the two negative invariants that matter most:
 *  - no map/analysis/publish ALGORITHM was touched (those files are unmodified
 *    in their substance), and
 *  - nothing was REMOVED — every previously available panel is still mounted
 *    somewhere.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(`${root}${rel}`, "utf8");

const renderSrc = read("src/ui/render.ts");
const appSrc = read("src/ui/app.ts");
const mapRenderSrc = read("src/ui/map/mapRender.ts");
const mapViewSrc = read("src/ui/map/mapView.ts");
const cssSrc = read("src/ui/samplemap.css");
const liveSessionSrc = read("src/ui/liveSession.ts");
const uiMainSrc = read("src/ui/main.ts");
const mainSrc = read("src/main.ts");

/**
 * Extract one top-level function by slicing from its signature to the next
 * top-level declaration (the next line that starts at column 0).
 *
 * Why not index arithmetic between two `indexOf` anchors: it silently yields an
 * empty string when the stop anchor appears BEFORE the start anchor in the
 * file, and a return-type brace (`): { … }`) defeats naive brace matching. The
 * search also starts AFTER the parameter list, so a multi-line signature whose
 * closing `): HTMLElement {` sits at column 0 is not mistaken for the end.
 */
function fn(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  // Skip the parameter list (balanced parens from the signature's own "(").
  let depth = 0;
  let body = -1;
  for (let i = src.indexOf("(", start); i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) {
        body = src.indexOf("{", i);
        break;
      }
    }
  }
  if (body === -1) throw new Error(`no body brace found: ${signature}`);
  // An inline object RETURN TYPE (`): { primary: … } {`) must be skipped, not
  // mistaken for the body. It is the only case where `{` is directly preceded
  // by `:`; a `Promise<T>` or `void` return type leaves the body brace after a
  // `>` or an identifier, so it is unambiguous.
  const beforeBrace = src.slice(src.lastIndexOf("\n", body) + 1, body).trimEnd();
  if (beforeBrace.endsWith(":")) {
    let d = 0;
    for (let i = body; i < src.length; i++) {
      if (src[i] === "{") d += 1;
      else if (src[i] === "}" && --d === 0) {
        body = src.indexOf("{", i);
        break;
      }
    }
    if (body === -1) throw new Error(`no body brace after return type: ${signature}`);
  }
  const rest = src.slice(body);
  const m = /\n(?=[^ \t\n])/.exec(rest);
  return m ? src.slice(start, body + m.index) : src.slice(start);
}

/**
 * The same for a CLASS MEMBER: slice to the next member boundary (a line
 * indented by exactly the class body indentation).
 */
function member(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  const rest = src.slice(start + 1);
  const m = /\n {2}(?=[^ \t\n])/.exec(rest);
  return m ? src.slice(start, start + 1 + m.index) : src.slice(start);
}

describe("STEP85 — primary view is the map plus a compact sample panel", () => {
  it("renderContent mounts the map region and the compact inspector region", () => {
    const body = fn(renderSrc, "function renderContent(");
    expect(body).toContain('el("main", "map-region")');
    expect(body).toContain('el("aside", "inspector-region")');
    // The technical left rail is NOT part of the primary row any more.
    expect(body).not.toContain('el("aside", "filter-panel")');
    expect(body).not.toContain("renderScanPanel(app)");
    expect(body).not.toContain("renderResultsPanel(app)");
  });

  it("the primary inspector carries name, class/owner, preview and batch selection", () => {
    const body = fn(renderSrc, "function renderInspectorParts(");
    // What a normal user needs.
    expect(body).toContain('data-testid", "inspector-name"');
    expect(body).toContain('data-testid", "inspector-class"');
    expect(body).toContain('data-testid", "inspector-owner"');
    expect(body).toContain('data-testid", "inspector-preview-toggle"');
    expect(body).toContain('data-testid", "inspector-select-toggle"');
    // What moved to Advanced (must still exist, just in the technical array).
    expect(body).toContain("inspector-classification");
    expect(body).toContain("inspector-publish-status");
    expect(body).toContain("inspector-find-similar");
    // The primary part is a small, purpose-built section — the split is real.
    expect(body).toContain("inspector-primary");
    expect(body).toContain("primary.appendChild(");
  });

  it("the count line reports held and shown samples, with no cluster vocabulary", () => {
    const body = fn(renderSrc, "function mapCountText(");
    // The two numbers that exist: how many samples the map holds, how many drawn.
    expect(body).toContain("m.total");
    expect(body).toContain("m.shown");
    // STEP86 removed clustering: none of its terms may come back.
    expect(body).not.toContain("cluster");
    expect(body).not.toContain("m.covered");
    expect(body).not.toContain("m.singles");
  });

  it("the count line is built from the CURRENT render, not the previous frame", () => {
    // The renderer reports its numbers synchronously via onRendered, and the
    // count line is appended after that call — so the values are already known.
    const body = fn(renderSrc, "function renderMapPanel(");
    const renderCall = body.indexOf("renderSampleMap(host");
    const onRendered = body.indexOf("onRendered: (info) => app.setMapRendered(info)");
    const countLine = body.indexOf("mapCountText(app)");
    expect(renderCall).toBeGreaterThan(-1);
    expect(onRendered).toBeGreaterThan(renderCall);
    expect(countLine).toBeGreaterThan(onRendered);
  });
});

describe("STEP85 — the advanced drawer folds away without removing anything", () => {
  it("is a closed <details> by default with a real summary", () => {
    const body = fn(renderSrc, "function renderAdvancedArea(");
    expect(body).toContain('document.createElement("details")');
    expect(body).toContain('data-testid", "advanced-area"');
    expect(body).toContain('data-testid", "advanced-summary"');
    // Closed unless explicitly requested.
    expect(body).toContain("if (advancedOpen) details.open = true;");
  });

  it("still mounts every previously available panel", () => {
    const body = fn(renderSrc, "function renderAdvancedArea(");
    for (const panel of [
      "renderScanPanel(app)",
      "renderAnalysisPanel(app)",
      "renderFiltersPanel(app)",
      "renderDiscoveryPanel(app)",
      "renderSoundSpacePanel(app)",
      "renderCollectionPanel(app)",
      "renderCollectionManagerPanel(app)",
      "renderResultsPanel(app)",
      "renderSimilarPanel(app)",
      "renderSimilarityV2Panel(app)",
      "renderSendPanel(app)",
    ]) {
      expect(body).toContain(panel);
    }
  });

  it("keeps the open state across a re-render, so a filter change cannot close it", () => {
    // The drawer holds live controls (scan, sort, send form), so losing its
    // state on every state change would make it unusable.
    expect(renderSrc).toContain('data-advanced-open');
    const body = fn(renderSrc, "export function renderApp(");
    expect(body).toContain('getAttribute("data-advanced-open")');
  });
});

describe("STEP85 — primary header carries project, visibility and the advanced door", () => {
  it("Global / My Samples live in the header, not in the technical filter rail", () => {
    const header = fn(renderSrc, "function renderHeaderVisibility(");
    expect(header).toContain('"filter-global"');
    expect(header).toContain('"filter-my-samples"');

    // The filter panel must no longer build them.
    const filters = fn(renderSrc, "function renderFiltersPanel(");
    expect(filters).not.toContain('"filter-global"');
    expect(filters).not.toContain('"filter-my-samples"');
  });

  it("the project picker never invents a choice when no project list exists", () => {
    const body = fn(renderSrc, "function renderProjectPicker(");
    expect(body).toContain('data-testid", "project-select"');
    // No list -> one fixed entry, disabled, never a fake dropdown.
    expect(body).toContain("if (options.length === 0)");
    expect(body).toContain("select.disabled = true;");
    expect(body).toContain("select.onchange = () => void app.selectProject(select.value);");
  });

  it("the header status is plain language, not a pipeline state machine", () => {
    const body = fn(renderSrc, "function indexStatusText(");
    expect(body).toContain("Indexing samples");
    // No invitation to press the technical analyse button.
    expect(body).not.toContain("analyze(");
    expect(body).not.toContain("Analyse N");
  });

  it("the header keeps the existing search and refresh controls", () => {
    const body = fn(renderSrc, "function renderHeader(");
    expect(body).toContain('data-testid", "search-text"');
    expect(body).toContain('data-testid", "header-refresh"');
    expect(body).toContain('data-testid", "header-advanced"');
  });
});

describe("STEP85 — the primary action is Add to Machiniste", () => {
  it("the action bar offers a Machiniste picker and sends to the chosen target", () => {
    const body = fn(renderSrc, "function renderActionBar(");
    expect(body).toContain('data-testid", "machiniste-select"');
    expect(body).toContain('data-testid", "machiniste-add"');
    // The chosen target is used for the send.
    expect(body).toContain("app.machinisteIdForSend");
    expect(body).toContain("app.sendToMachiniste(target");
  });

  it("the technical id input remains available as a fallback in Advanced", () => {
    // The send panel is untouched and still holds the raw id / slot inputs, so
    // an id that was never picked still works.
    expect(renderSrc).toContain('"machiniste-id"');
    expect(renderSrc).toContain('"machiniste-slot-start"');
    const send = fn(renderSrc, "function renderSendPanel(");
    expect(send).toContain("machiniste-id");
  });
});

describe("STEP85 — no business logic or algorithm was changed", () => {
  it("the map pipeline files keep their algorithms untouched", () => {
    // These files are the ones that decide how many points exist. STEP85 only
    // OBSERVES them (see mapRenderSrc below), so their substance must be the
    // same as before this step.
    expect(mapViewSrc).toContain("export function mapPoints(");
    expect(mapViewSrc).toContain("export function globalMapPoints(");
    expect(mapViewSrc).toContain("export function mergeMapPoints(");
    expect(mapViewSrc).toContain("export function pointAt(");
    // STEP86 removed the cluster stage wholesale — no remnants may remain.
    expect(mapViewSrc).not.toContain("clusterMapPoints");
    expect(mapViewSrc).not.toContain("entryCoverage");
    expect(mapViewSrc).not.toContain("MapCluster");
    expect(mapViewSrc).not.toContain("MapEntry");
  });

  it("mapRender only OBSERVES the pipeline; it does not change it", () => {
    expect(mapRenderSrc).toContain("export interface MapRenderInfo");
    expect(mapRenderSrc).toContain("onRendered?:");
    // The counts come from the existing point set, not from a new computation.
    expect(mapRenderSrc).toContain("total: points.length");
    // Selection is the new display limit, and it runs AFTER the merge.
    expect(mapRenderSrc).toContain("selectDisplayedPoints(");
    // The renderer draws individual points and hit-tests exactly those.
    expect(mapRenderSrc).toContain("pointAt(displayed");
    // No cluster structure or cluster interaction is left.
    expect(mapRenderSrc).not.toContain("cluster");
    // No filtering or record mutation was introduced into the renderer.
    expect(mapRenderSrc).not.toContain("records.filter(");
  });

  it("setMapRendered cannot recurse through the render pass", () => {
    const body = member(appSrc, "setMapRendered(info: MapRenderInfo)");
    expect(body).toContain("this.mapRendered = info;");
    // A notify() here would re-enter renderApp from inside a render pass.
    expect(body).not.toContain("this.notify()");
  });

  it("the project switch stops indexing and disposes before re-mounting", () => {
    expect(mainSrc).toContain("previous?.stopScan()");
    expect(mainSrc).toContain("previous?.dispose()");
    expect(mainSrc).toContain("openLiveProject(at, name)");
  });

  it("openFirstProject behaviour is preserved behind the new picker helpers", () => {
    expect(liveSessionSrc).toContain("export async function openFirstProject(");
    // It is now built on the list + named open, still picking the FIRST project.
    expect(liveSessionSrc).toContain("pickFirstProject(projects)");
    expect(uiMainSrc).toContain("deps.onSelectProject = opts.onSelectProject;");
  });
});

describe("STEP85 — the layout is expressed in CSS, not by hiding elements", () => {
  it("the primary grid is map + compact inspector, the technical grid is inside the drawer", () => {
    const primary = cssSrc.slice(
      cssSrc.indexOf(".app-content {"),
      cssSrc.indexOf(".map-panel-primary {"),
    );
    expect(primary).toContain("minmax(0, 1fr) 320px");

    const advanced = cssSrc.slice(
      cssSrc.indexOf(".advanced-grid {"),
      cssSrc.indexOf(".filter-panel,\n.map-region,"),
    );
    // The old three-column technical layout survives, scoped to Advanced only.
    expect(advanced).toContain("240px minmax(420px, 1fr) 320px");
  });

  it("the advanced area spans the full content width below the primary row", () => {
    expect(cssSrc).toContain(".advanced-area {\n  grid-column: 1 / -1;");
  });
});
