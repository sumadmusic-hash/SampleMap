import { SampleMapApp } from "./app";
import {
  AnalysisState,
  ScanState,
  MachinisteState,
  SearchState,
} from "./app";
import type { SimilarityState } from "./app";
import {
  detailView,
  detailMapPosition,
  mapPositionLabel,
  scanStatusLabel,
  scanEligibilityLabels,
  analysisProgressLabels,
  resultView,
  classFilterOptions,
  SORT_OPTIONS,
  ANALYSIS_BUDGETS,
  hasActiveSearch,
  activeFilterCount,
  activeFilterSummary,
  sortLabel,
  emptyStateMessage,
  resultCountLabel,
  selectionCountLabel,
  selectionPillLabel,
  SEND_PANEL_HINT,
  shouldShowFirstUse,
  publishStatusFor,
  publishStatusLabel,
  publishDeliveryLabel,
  newestPublishItem,
  similarityV2Header,
  similarityV2ScoreLabel,
  similarityV2LimitedLabel,
  similarityV2StatusText,
  soundSpaceCountLabel,
  soundSpaceToggleLabel,
  SOUND_SPACE_EMPTY_TEXT,
  soundSpaceAxisLabel,
  soundSpaceFilterSummary,
  soundSpaceVisibleLabel,
  visibleSoundSpacePoints,
  characterValueLabel,
  compareEntryLabel,
  discoveryStatusText,
  discoveryScoreLabel,
  discoveryReasonSummary,
  COLLECTION_EMPTY_TEXT,
  COLLECTION_FULL_TEXT,
  COLLECTION_AVG_LABEL,
  COLLECTION_UNAVAILABLE_LABEL,
  collectionCounterLabel,
  collectionAddLabel,
  collectionSelectAllLabel,
  COLLECTION_MANAGER_TITLE,
  COLLECTION_PERSISTENCE_UNAVAILABLE,
  collectionManagerStatusLabel,
  collectionListEmptyText,
  collectionListErrorText,
  collectionListLoadingText,
  collectionRowLabel,
  collectionDeleteConfirmBody,
  collectionSwitchConfirmBody,
} from "./view";
import {
  SOUND_SPACE_X_LOW,
  SOUND_SPACE_X_HIGH,
  SOUND_SPACE_Y_LOW,
  SOUND_SPACE_Y_HIGH,
  soundSpaceCornerLabels,
} from "../analysis/soundSpaceProjector";
import { isCollectionFull } from "../analysis/collection";
import { MAX_BATCH_SLOTS } from "../machiniste/machinisteService";
import type { SampleIndexRecord } from "../persistence/indexStore";
import { renderSampleMap } from "./map/mapRender";
import { MAP_VERSION, ZOOM_STEP } from "./map/mapView";
import { mapEmptyMessage, visibleGlobalPoints } from "./map/visibility";
import "./samplemap.css";

/**
 * SampleMap browser renderer (SAMPLEMAP_V1_SPEC §13).
 *
 * This is THIN display glue exclusively: it projects `SampleMapApp` state (via
 * the pure view-models in `./view.ts`) into DOM and forwards user actions to the
 * controller. It contains no business logic and makes no service calls of its
 * own — the controller is the single orchestration entry point. All handlers
 * are re-attached on each render (simple, leak-free for a POC UI).
 */

/** Compute the status label for the analysis panel. */
function runStatusLabel(app: SampleMapApp): string {
  const a = app.analysis;
  if (a.status === "running") return "Running";
  if (a.status === "paused") return "Paused";
  if (a.status === "stopped") {
    if (a.stoppedReason === "budget") return "Stopped (budget reached)";
    if (a.stoppedReason === "pause") return "Paused";
    if (a.stoppedReason === "empty") return "Stopped (queue empty)";
    return "Stopped";
  }
  return "Idle";
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string): HTMLButtonElement {
  return el("button", className, text) as HTMLButtonElement;
}

function section(title: string): HTMLElement {
  const h = el("h3", "ui-section-title", title);
  const wrap = el("div", "ui-section");
  wrap.appendChild(h);
  return wrap;
}

/**
 * STEP19A E-P7 — the one-time consent dialog (FINAL_UI_UX_DESIGN_SPEC §19.5).
 * Canonical copy: "This adds references to audiotool samples in your Machiniste
 * document. No audio is uploaded or copied from SampleMap." Primary = Continue,
 * Secondary = Cancel. Accessible: role=dialog, labelled/described, Tab is
 * trapped between the two actions, Escape cancels, focus is managed by
 * renderApp (open state sets inert + focus; close state restores).
 */
const EP7_DIALOG_BODY =
  "This adds references to audiotool samples in your Machiniste document. No audio is uploaded or copied from SampleMap.";

function renderEp7ConsentDialog(app: SampleMapApp): HTMLElement {
  const backdrop = el("div", "ep7-dialog-backdrop");
  const dialog = el("div", "ep7-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "ep7-consent-title");
  dialog.setAttribute("aria-describedby", "ep7-consent-body");
  dialog.setAttribute("data-testid", "ep7-consent-dialog");

  const title = el("h2", "ep7-dialog-title", "Add to Machiniste");
  title.id = "ep7-consent-title";
  dialog.appendChild(title);

  const body = el("p", "ep7-dialog-body", EP7_DIALOG_BODY);
  body.id = "ep7-consent-body";
  const detail = el(
    "p",
    "ep7-dialog-detail",
    "This one-time acceptance is stored as a preference and can be changed later.",
  );
  dialog.append(body, detail);

  if (app.ep7ConsentError) {
    const err = el("p", "ep7-dialog-error", app.ep7ConsentError);
    err.setAttribute("role", "alert");
    dialog.appendChild(err);
  }

  const actions = el("div", "ep7-dialog-actions");
  const cancel = button("ep7-cancel-btn", "Cancel");
  cancel.setAttribute("data-testid", "ep7-consent-cancel");
  cancel.onclick = () => app.denyEp7Consent();
  const accept = button("ep7-accept-btn", "Continue");
  accept.setAttribute("data-testid", "ep7-consent-accept");
  accept.onclick = () => app.grantEp7Consent();
  actions.append(cancel, accept);
  dialog.appendChild(actions);

  // Tab trap within the dialog (the shell is inert, but keep the two actions
  // reachable and wrapped in case the focus escapes via another path).
  dialog.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const focusables = dialog.querySelectorAll<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    const list: HTMLElement[] = [];
    focusables.forEach((el) => list.push(el));
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || active === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  backdrop.appendChild(dialog);
  return backdrop;
}

/** Per-app consent-dialog focus bookkeeping (WeakMap, no global leakage). */
const ep7ConsentState = new WeakMap<
  SampleMapApp,
  {
    restoreTestId: string | null;
    restoreEl: HTMLElement | null;
    wasOpen: boolean;
  }
>();

/**
 * Build the complete UI for the given app (FINAL UI/UX v1.1 Phase 1 shell).
 *
 * Layout (spec §6):
 *   app-shell
 *     header        brand + connection/index status + global search + actions
 *     app-content   filter rail | map (dominant) + result list | inspector rail
 *     action-bar    contextual status + selection pill (N / 8) + Add to Machiniste
 *     mobile-notice desktop-only notice below 768px (§27)
 *
 * Callers re-render on change. Every pre-existing data-testid / class used by
 * the STEP16M e2e suite and the harness is preserved.
 */
export function renderApp(root: HTMLElement, app: SampleMapApp): void {
  // Text controls (notably the global search) are re-created on every state
  // change; preserve focus + caret so live typing survives the rebuild.
  const activeEl = document.activeElement;
  const activeTestId =
    activeEl instanceof HTMLInputElement || activeEl instanceof HTMLSelectElement
      ? activeEl.getAttribute("data-testid")
      : null;
  // STEP19A E-P7: capture the restore trigger BEFORE the shell is wiped — the
  // focused Add button is removed by the wipe, and once it is gone the browser
  // reports activeElement as <body>. Captured here, the dialog close can return
  // focus to the exact control that opened it.
  const consentPrior = ep7ConsentState.get(app);
  if (app.ep7ConsentRequired && !consentPrior?.wasOpen) {
    ep7ConsentState.set(app, {
      restoreTestId:
        activeEl instanceof HTMLElement
          ? activeEl.getAttribute("data-testid")
          : null,
      restoreEl: activeEl instanceof HTMLElement ? activeEl : null,
      wasOpen: true,
    });
  }
  // E-P5A T4: keep keyboard focus on the map application region across
  // re-renders so consecutive arrow-key navigation stays continuous.
  const activeInMap =
    activeEl instanceof Element && activeEl.closest(".sample-map-svg") != null;
  // E-P5A T5: the 768–1023 overlay drawers are shell classes. A state change
  // re-renders the whole shell, so carry the open drawers across the rebuild —
  // otherwise a filter/sort change inside the drawer would silently close it.
  const prevShell = root.querySelector<HTMLElement>(".app-shell");
  const prevDrawerFlags = prevShell
    ? {
        filter: prevShell.classList.contains("filter-open"),
        inspector: prevShell.classList.contains("inspector-open"),
      }
    : { filter: false, inspector: false };

  root.textContent = "";

  const shell = el("div", "app-shell");
  if (prevDrawerFlags.filter) shell.classList.add("filter-open");
  if (prevDrawerFlags.inspector) shell.classList.add("inspector-open");
  shell.appendChild(renderHeader(app, root));
  shell.appendChild(renderContent(app));
  shell.appendChild(renderActionBar(app, root));
  shell.appendChild(
    el("div", "mobile-notice", "SampleMap requires a desktop browser."),
  );
  root.appendChild(shell);

  // STEP19A E-P7 — one-time consent dialog (FINAL_UI_UX_DESIGN_SPEC §19.5).
  // While the dialog is up the shell is made inert (background unfocusable),
  // focus moves into the dialog, and it is restored on close.
  const consentWasOpen = ep7ConsentState.get(app)?.wasOpen ?? false;
  if (app.ep7ConsentRequired) {
    shell.inert = true;
    root.appendChild(renderEp7ConsentDialog(app));
    const cancel = root.querySelector<HTMLElement>(
      "[data-testid='ep7-consent-cancel']",
    );
    cancel?.focus();
  } else {
    const prior = ep7ConsentState.get(app);
    const restoreId = prior?.restoreTestId ?? null;
    const active = document.activeElement;
    if (restoreId) {
      if (
        consentWasOpen ||
        active === document.body ||
        active === null ||
        !(active instanceof Element)
      ) {
        // STEP19A E-P7: restore (and re-pin across follow-up async re-renders)
        // focus to the trigger that opened the dialog, so an async send that
        // completes after close cannot drop focus to <body>.
        root
          .querySelector<HTMLElement>(`[data-testid='${restoreId}']`)
          ?.focus();
      } else if (active instanceof HTMLElement) {
        // The user has since focused a real control elsewhere: the restore
        // contract is fulfilled, stop pinning focus.
        ep7ConsentState.set(app, {
          restoreTestId: null,
          restoreEl: null,
          wasOpen: false,
        });
        shell.inert = false;
        return;
      }
    }
    ep7ConsentState.set(app, {
      restoreTestId: restoreId,
      restoreEl: null,
      wasOpen: false,
    });
    shell.inert = false;
  }

  if (activeInMap) {
    root.querySelector<HTMLElement>("[data-testid='sample-map']")?.focus();
  } else if (activeTestId) {
    const next = root.querySelector(
      `[data-testid="${activeTestId}"]`,
    ) as HTMLElement | null;
    if (
      next &&
      (next instanceof HTMLInputElement || next instanceof HTMLSelectElement)
    ) {
      next.focus();
      // Caret restore is only meaningful for text-ish inputs; number/checkbox
      // inputs (e.g. the STEP25 Sound Space filter ranges) throw on
      // setSelectionRange. Just focus them (STEP25: typing never re-renders).
      if (next instanceof HTMLInputElement && isCaretInputType(next.type)) {
        const end = next.value.length;
        next.setSelectionRange(end, end);
      }
    }
  }
}

/**
 * Empty-map copy for the Global / My Samples visibility layer.
 *
 * The visibility layer owns every case where the emptiness is caused by the
 * toggles. When the active sets are non-empty it returns nothing, and the
 * existing search/analysis empty state is reused unchanged.
 */
function visibilityEmptyMessage(app: SampleMapApp, visibleCount: number): string {
  return (
    mapEmptyMessage({
      toggles: app.visibility,
      visibleCount,
      globalPointCount: app.globalPoints.length,
      mySampleCount: app.mySamples.size,
      hasIdentity: app.hasAuthenticatedIdentity,
      hasActiveSearch: hasActiveSearch(app.searchState),
      resultCount: app.results.length,
    }) ?? emptyStateMessage(hasActiveSearch(app.searchState))
  );
}

/** Input types that support caret selection (number/range inputs do not). */
function isCaretInputType(type: string): boolean {
  return ["text", "search", "url", "tel", "email", "password"].includes(type);
}

/** The three layout regions of the shell (§6). */
function renderContent(app: SampleMapApp): HTMLElement {
  const content = el("div", "app-content");

  // Left rail: indexing controls + filters.
  const filter = el("aside", "filter-panel");
  filter.setAttribute("aria-label", "Filters");
  filter.appendChild(renderScanPanel(app));
  filter.appendChild(renderAnalysisPanel(app));
  filter.appendChild(renderFiltersPanel(app));
  content.appendChild(filter);

  // Center: the map is the dominant surface; the result list is the
  // integrated secondary surface (spec §6 — never a fourth column).
  const mapRegion = el("main", "map-region");
  mapRegion.appendChild(renderMapPanel(app));
  mapRegion.appendChild(renderDiscoveryPanel(app));
  mapRegion.appendChild(renderSoundSpacePanel(app));
  // Progressive disclosure: collection panel revealed after collection manager used
  if (app.progressiveDisclosure.collectionManagerUsed) {
    mapRegion.appendChild(renderCollectionPanel(app));
    mapRegion.appendChild(renderCollectionManagerPanel(app));
  }
  mapRegion.appendChild(renderResultsPanel(app));
  content.appendChild(mapRegion);

  // Right rail: inspector (focused sample) + find-similar + send.
  // Progressive disclosure: reveal after surfaces used
  const inspectorRegion = el("aside", "inspector-region");
  inspectorRegion.setAttribute("aria-label", "Inspector");
  inspectorRegion.appendChild(renderDetailPanel(app));
  // Progressive disclosure: similar panel after discovery or similarity used
  if (app.progressiveDisclosure.discoveryUsed || app.progressiveDisclosure.similarityV2Used) {
    inspectorRegion.appendChild(renderSimilarPanel(app));
    inspectorRegion.appendChild(renderSimilarityV2Panel(app));
  }
  inspectorRegion.appendChild(renderSendPanel(app));
  content.appendChild(inspectorRegion);

  return content;
}

/**
 * Persistent top-level header (§6 / §12): brand + index status, the GLOBAL
 * search bar (the query applies across the whole sample set), and reserved
 * right-side actions (Refresh index, drawer toggles for the responsive shell).
 */
function renderHeader(app: SampleMapApp, root: HTMLElement): HTMLElement {
  const header = el("header", "app-header");

  const brand = el("div", "header-brand");
  const title = el("h1", "ui-title", "SAMPLEMAP");
  const dot = el("span", "header-dot");
  dot.setAttribute("aria-hidden", "true");
  const indexStatus = el(
    "div",
    "header-index-status",
    `Local index · ${app.analysis.analyzed} analyzed`,
  );
  brand.append(title, dot, indexStatus);

  // Global search (spec §12): header, ~320px flexible, no autofocus on load.
  const searchWrap = el("div", "header-search");
  const search = el("input") as HTMLInputElement;
  search.type = "text";
  search.placeholder = "Search name, owner, or tag…";
  search.value = app.searchState.text;
  search.setAttribute("data-testid", "search-text");
  search.setAttribute("aria-label", "Search samples");
  search.oninput = () => void app.setSearch(search.value);

  const clear = button("header-search-clear", "×");
  clear.setAttribute("data-testid", "search-clear-value");
  clear.setAttribute("aria-label", "Clear search");
  clear.style.display = app.searchState.text ? "" : "none";
  clear.onclick = () => void app.setSearch("");
  searchWrap.append(search, clear);

  const actions = el("div", "header-actions");
  const refresh = button("action-btn", "Refresh index");
  refresh.setAttribute("data-testid", "header-refresh");
  refresh.onclick = () => {
    void app.refreshSearch();
    app.refreshGlobalPointsImmediate();
  };

  // Responsive drawer toggles (§27) — only visible below 1024px (CSS).
  const menu = button("header-menu", "☰");
  menu.setAttribute("data-testid", "header-menu");
  menu.setAttribute("aria-label", "Toggle filters");
  menu.onclick = () => toggleShellClass(root, "filter-open");

  const inspToggle = button("header-inspector-toggle", "Inspector");
  inspToggle.setAttribute("data-testid", "header-inspector-toggle");
  inspToggle.setAttribute("aria-label", "Toggle inspector");
  inspToggle.onclick = () => toggleShellClass(root, "inspector-open");

  actions.append(refresh, menu, inspToggle);
  header.append(brand, searchWrap, actions);
  return header;
}

/** Toggle a responsive-drawer state class on the current app shell. */
function toggleShellClass(
  root: HTMLElement,
  className: string,
  force?: boolean,
): void {
  const shell = root.querySelector(".app-shell");
  if (shell) shell.classList.toggle(className, force);
}

/**
 * Bottom action bar (§18): persistent selection state + the single primary
 * action. Keys off the BATCH SELECTION, never off focus.
 */
function renderActionBar(app: SampleMapApp, root: HTMLElement): HTMLElement {
  const bar = el("footer", "action-bar");

  const status = el("div", "action-status", actionBarStatusText(app));
  status.setAttribute("data-testid", "action-status");
  // E-P5A T3 — live status region for the action-bar state line.
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const sel = el("div", "action-selection");
  const n = app.selectedSampleIds.length;
  const pillClass = ["selection-pill"];
  if (n > 0) pillClass.push("is-selected");
  if (n >= MAX_BATCH_SLOTS) pillClass.push("is-maxed");
  const pill = el("span", pillClass.join(" "), selectionPillLabel(n));
  pill.setAttribute("data-testid", "selection-pill");
  pill.title = selectionCountLabel(n);
  pill.setAttribute("aria-label", selectionCountLabel(n));

  const add = button("action-add-btn", "Add to Machiniste");
  add.setAttribute("data-testid", "machiniste-add");
  add.disabled = n === 0;
  if (n === 0) {
    add.title = "Select at least one sample to add to Machiniste";
  }
  add.onclick = () => {
    const idInput = root.querySelector<HTMLInputElement>(
      "[data-testid='machiniste-id']",
    );
    const slotInput = root.querySelector<HTMLInputElement>(
      "[data-testid='machiniste-slot-start']",
    );
    void app.sendToMachiniste(
      idInput?.value.trim() ?? "",
      Number(slotInput?.value) || 0,
    );
  };

  sel.append(pill, add);
  bar.append(status, sel);
  return bar;
}

/** Contextual bottom-left status line (§6 Status / §18). */
function actionBarStatusText(app: SampleMapApp): string {
  const m = app.machiniste;
  if (m.error) return m.error;
  const a = app.analysis;
  if (a.status === "running" || a.status === "paused") {
    return `${runStatusLabel(app)} · ${a.analyzed} analyzed`;
  }
  if (app.scan.status === "scanning") return "Scanning library…";
  // Live search/filter state is the most current signal and wins over the
  // (persisted) last Machiniste-action confirmation.
  if (hasActiveSearch(app.searchState)) {
    return `Filtered: ${resultCountLabel(app.results.length)}`;
  }
  if (m.lastResult) return machinisteResultLabel(app);
  return resultCountLabel(app.results.length);
}

/** Compact last Machiniste-send summary (shared by send panel + action bar). */
function machinisteResultLabel(app: SampleMapApp): string {
  const r = app.machiniste.lastResult!;
  const applied = r.slots.filter((s) => s.applied).length;
  const matched = r.slots.filter((s) => s.readBackMatches).length;
  const errs = [...r.errors, ...r.slots.flatMap((s) => s.errors)];
  return (
    `Applied: ${applied}  Read-back: ${matched}  Slots: ${r.slots.length}` +
    (errs.length ? `  Errors: ${errs.join("; ")}` : "")
  );
}

function renderScanPanel(app: SampleMapApp): HTMLElement {
  const s: ScanState = app.scan;
  const wrap = section("Library Scan");
  const status = el(
    "div",
    "scan-status",
    `Status: ${scanStatusLabel(s.status)}`,
  );
  // E-P5A T3 — polite live/status region for scan progress.
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const count = el("div", "scan-count", `Samples found: ${s.foundCount}`);
  const pages = el("div", "scan-pages", `Pages: ${s.pageCount}`);
  const eligibility = el(
    "div",
    "scan-eligibility",
    scanEligibilityLabels(s),
  );
  const err =
    s.status === "error"
      ? el("div", "scan-error", `Error: ${s.error ?? "unknown"}`)
      : el("div", "scan-error");

  const start = button("scan-start", "Start Scan");
  start.setAttribute("data-testid", "scan-start");
  start.disabled = s.status === "scanning";
  start.onclick = () => void app.startScan();

  const stop = button("scan-stop", "Stop Scan");
  stop.setAttribute("data-testid", "scan-stop");
  stop.disabled = s.status !== "scanning";
  stop.onclick = () => app.stopScan();

  wrap.append(status, count, pages, eligibility, err, start, stop);
  return wrap;
}

function renderAnalysisPanel(app: SampleMapApp): HTMLElement {
  const a: AnalysisState = app.analysis;
  const wrap = section("Analysis");
  const status = el("div", "analysis-status", `Status: ${runStatusLabel(app)}`);
  // E-P5A T3 — polite live/status region for analysis progress.
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const budget = el(
    "div",
    "analysis-budget",
    `Budget: ${a.budget === undefined ? "—" : String(a.budget)}`,
  );
  const progress = analysisProgressLabels(
    { analyzed: a.analyzed, failed: a.failed },
    app.remainingBudget,
  );
  const analyzed = el("div", "analysis-analyzed", progress.analyzed);
  const failed = el("div", "analysis-failed", progress.failed);
  const remaining = el("div", "analysis-remaining", progress.remaining);
  const err =
    a.error !== undefined ? el("div", "analysis-error", `Error: ${a.error}`) : el("div");

  // Controlled budget buttons (INV-3: only 10/100/1000).
  const budgetRow = el("div", "analysis-buttons");
  for (const b of ANALYSIS_BUDGETS) {
    const btn = button("analysis-budget-btn", `Analyse ${b}`);
    btn.setAttribute("data-testid", `analyze-${b}`);
    btn.onclick = () => void app.analyze(b);
    budgetRow.appendChild(btn);
  }

  const pause = button("analysis-pause", "Pause");
  pause.setAttribute("data-testid", "analyze-pause");
  pause.disabled = a.status !== "running";
  pause.onclick = () => app.pause();

  const resume = button("analysis-resume", "Resume");
  resume.setAttribute("data-testid", "analyze-resume");
  resume.disabled = a.status !== "paused";
  resume.onclick = () => void app.resume();

  const ctrl = el("div", "analysis-ctrl");
  ctrl.append(pause, resume);

  wrap.append(status, budget, analyzed, failed, remaining, err, budgetRow, ctrl);
  return wrap;
}

/**
 * Filter rail content (spec §13 / E-P4): grouped class controls, minimum
 * confidence and sort, with an active-filter indicator + Clear. The GLOBAL
 * search input lives in the header (§12); this panel keeps only the structured
 * filters. Pure projections from `./view.ts` drive all labels (E-P4.8).
 */
function renderFiltersPanel(app: SampleMapApp): HTMLElement {
  const st: SearchState = app.searchState;
  const wrap = section("Filters");

  // Active-filter indicator on the section heading (§13.5 / E-P4.2).
  const title = wrap.querySelector<HTMLElement>(".ui-section-title");
  const active = activeFilterCount(st);
  if (active > 0 && title) {
    const badge = el(
      "span",
      "filter-active-badge",
      ` ·${active} active`,
    ) as HTMLElement;
    title.appendChild(badge);
  }

  const filters = el("div", "filter-row");

  // Class filter — grouped native selector (E-P4.1): "All classes", the three
  // taxonomy groups as whole-group tokens, then the 22 classes under native
  // optgroups. Group/class tokens drive `setClasses` exactly as before (the
  // SearchEngine expands group names; filtering semantics unchanged).
  const classField = el("div", "filter-field");
  const classLabel = el("label", "filter-label", "Class");
  classLabel.setAttribute("for", "class-filter");
  classField.appendChild(classLabel);
  const classSel = el("select") as HTMLSelectElement;
  classSel.id = "class-filter";
  const options = classFilterOptions();
  const allOpt = el("option", undefined, options.all.label) as HTMLOptionElement;
  allOpt.value = "__all__";
  classSel.appendChild(allOpt);
  for (const g of options.groups) {
    const opt = el("option", undefined, `${g.label} (all)`) as HTMLOptionElement;
    opt.value = g.id;
    classSel.appendChild(opt);
  }
  for (const g of options.groups) {
    const group = document.createElement("optgroup");
    group.label = g.label;
    for (const c of g.classes) {
      const opt = el("option", undefined, c) as HTMLOptionElement;
      opt.value = c;
      group.appendChild(opt);
    }
    classSel.appendChild(group);
  }
  classSel.value = st.classes.length ? st.classes[st.classes.length - 1] : "__all__";
  classSel.setAttribute("data-testid", "filter-class");
  classSel.onchange = () => {
    const v = classSel.value;
    void app.setClasses(v === "__all__" ? [] : [v]);
  };
  classField.appendChild(classSel);
  filters.appendChild(classField);

  // Confidence filter (E-P4.4): same 0–1 step 0.05 range, empty = unset; the
  // displayed value is the actual filter value (no rescaling or clamping).
  const confField = el("div", "filter-field");
  const confLabel = el("label", "filter-label", "Min confidence");
  confLabel.setAttribute("for", "confidence-filter");
  confField.appendChild(confLabel);
  const conf = el("input") as HTMLInputElement;
  conf.id = "confidence-filter";
  conf.type = "number";
  conf.min = "0";
  conf.max = "1";
  conf.step = "0.05";
  conf.placeholder = "unset";
  conf.value = st.minConfidence === undefined ? "" : String(st.minConfidence);
  conf.setAttribute("data-testid", "filter-confidence");
  conf.oninput = () => {
    const v = conf.value === "" ? undefined : Number(conf.value);
    void app.setMinConfidence(v);
  };
  confField.appendChild(conf);
  filters.appendChild(confField);

  // Sort (E-P4.5): exactly the existing four modes; ordering only.
  const sortField = el("div", "filter-field");
  const sortLabelEl = el("label", "filter-label", "Sort");
  sortLabelEl.setAttribute("for", "sort-filter");
  sortField.appendChild(sortLabelEl);
  const sortSel = el("select") as HTMLSelectElement;
  sortSel.id = "sort-filter";
  sortSel.title = `Current sort: ${sortLabel(st.sortBy)}`;
  for (const o of SORT_OPTIONS) {
    const opt = el("option", undefined, o.label) as HTMLOptionElement;
    opt.value = o.id;
    sortSel.appendChild(opt);
  }
  sortSel.value = st.sortBy;
  sortSel.setAttribute("data-testid", "filter-sort");
  sortSel.onchange = () => void app.setSort(sortSel.value as SearchState["sortBy"]);
  sortField.appendChild(sortSel);
  filters.appendChild(sortField);

  // ── Global / My Samples: two INDEPENDENT visibility toggles ────────────────
  // One shared 2D sound space; the visible set is the UNION of the enabled
  // modes. Toggling either never touches the other, and never changes the
  // searchable result set (a sample stays findable while off the map).
  const visRow = el("div", "filter-row visibility-row");
  const makeToggle = (
    testid: string,
    labelText: string,
    isOn: boolean,
    count: number,
    title: string,
    onToggle: () => void,
  ): HTMLElement => {
    const field = el("div", "filter-field");
    const btn = button(testid, `${labelText} (${count})`);
    btn.setAttribute("data-testid", testid);
    btn.setAttribute("aria-pressed", isOn ? "true" : "false");
    btn.setAttribute("data-active", isOn ? "true" : "false");
    btn.title = title;
    if (isOn) btn.classList.add("is-active");
    btn.onclick = onToggle;
    field.appendChild(btn);
    return field;
  };

  const vis = app.visibility;
  const visField = el("div", "filter-field");
  const visLabel = el("label", "filter-label", "Visibility");
  visField.appendChild(visLabel);
  visField.appendChild(
    makeToggle(
      "filter-global",
      "Global",
      vis.global,
      app.globalPoints.length,
      "Show the existing global sample set on the map",
      () => void app.setVisibility({ global: !app.visibility.global }),
    ),
  );
  // The count is the COMPLETE known sample set of the authenticated user (any
  // analysis status) — not only what is currently analyzed or on the map.
  const mineField = makeToggle(
    "filter-my-samples",
    "My Samples",
    vis.mine,
    app.mySamples.size,
    app.hasAuthenticatedIdentity
      ? "Show the samples owned by the authenticated user"
      : "Authenticated user unknown — ownership cannot be determined",
    () => void app.setVisibility({ mine: !app.visibility.mine }),
  );
  if (!app.hasAuthenticatedIdentity) {
    mineField.querySelector("button")?.setAttribute("data-identity-unavailable", "true");
  }
  visField.appendChild(mineField);
  visRow.appendChild(visField);
  filters.appendChild(visRow);

  // Active-filter summary line (E-P4.2) — hidden when nothing is filtered.
  const summary = activeFilterSummary(st);
  if (summary) {
    const line = el("div", "active-filter-summary", summary);
    filters.appendChild(line);
  }

  // Result count derived from the current SearchEngine results (Steps 15D §9).
  const count = el("div", "result-count", resultCountLabel(app.results.length));
  count.setAttribute("data-testid", "result-count");

  // The single Clear action (E-P4.3): resets every criterion and reloads via
  // the SearchEngine (§10). Disabled when nothing is filtered.
  const clear = button("clear-btn", "Clear filters");
  clear.setAttribute("data-testid", "search-clear");
  clear.disabled = !hasActiveSearch(st);
  clear.onclick = () => void app.clearSearch();

  const row = el("div", "search-actions");
  row.append(count, clear);

  wrap.append(filters, row);
  return wrap;
}

/** The 2D SampleMap panel: one point per analyzed record + camera (Step 15F). */
function renderMapPanel(app: SampleMapApp): HTMLElement {
  const wrap = section(`Sample Map (${MAP_VERSION})`);

  // Zoom controls (Step 15F §20): [−] [label] [+] [Reset].
  const controls = el("div", "map-zoom-controls");
  const minus = button("map-zoom-btn", "−");
  minus.setAttribute("data-testid", "map-zoom-out");
  minus.setAttribute("aria-label", "Zoom out");
  minus.onclick = () => app.zoomMapBy(1 / ZOOM_STEP);
  const label = el("span", "map-zoom-label", `${Math.round(app.mapCamera.zoom * 100)}%`);
  label.setAttribute("data-testid", "map-zoom-label");
  const plus = button("map-zoom-btn", "+");
  plus.setAttribute("data-testid", "map-zoom-in");
  plus.setAttribute("aria-label", "Zoom in");
  plus.onclick = () => app.zoomMapBy(ZOOM_STEP);
  const reset = button("map-reset-btn", "Reset View");
  reset.setAttribute("data-testid", "map-zoom-reset");
  reset.onclick = () => app.resetMapView();
  controls.append(minus, label, plus, reset);

  const host = el("div", "sample-map-host");
  host.setAttribute("data-testid", "sample-map-host");
  // Visibility projection: the searched records filtered by the two INDEPENDENT
  // toggles (union, deduplicated by sampleId). The searchable `results` list
  // itself is untouched, so every sample stays findable even while off the map.
  const visibleRecords = app.visibleMapRecords;
  renderSampleMap(host, {
    records: visibleRecords,
    selectedSampleId: app.focusedSampleId ?? undefined,
    // FINAL UI/UX v1.1 Phase 1: batch-selected points render with the
    // selection treatment (§17.2) independently of the focused point.
    selectedSampleIds: app.selectedSampleIds,
    onSelect: (record) => app.selectSample(record),
    // The existing global pool only contributes points while Global is on.
    // mergeMapPoints() still collapses a global point onto the identical local
    // content identity, so an overlap renders exactly once.
    globalPoints: visibleGlobalPoints(app.globalPoints, app.visibility),
    onSelectGlobal: (point) => void app.selectGlobalPoint(point),
    camera: app.mapCamera,
    onCamera: (camera) => {
      app.setMapCamera(camera);
    },
    emptyMessage: visibilityEmptyMessage(app, visibleRecords.length),
  });

  // Step 16L: global-map state line (idle/loading/ok/empty/error). It never
  // implies the whole map is empty — local points are rendered regardless.
  const globalState = el("div", `map-global-state map-global-state-${app.globalMapState}`);
  globalState.setAttribute("data-testid", "map-global-state");
  globalState.textContent = globalMapStateLabel(app.globalMapState);
  wrap.append(controls, globalState, host);

  // First-use empty-state overlay (spec §25): indexed nothing yet, no active
  // filter, scan never started. One primary action: start indexing.
  if (
    shouldShowFirstUse(
      app.results.length,
      app.scan.status,
      hasActiveSearch(app.searchState),
    )
  ) {
    wrap.appendChild(renderFirstUseOverlay(app));
    const empty = wrap.querySelector(".map-empty");
    if (empty) (empty as HTMLElement).style.display = "none";
  }
  return wrap;
}

/**
 * The canonical FIRST-USE overlay (§25.1): what SampleMap does, why the map is
 * empty, and the single indexing CTA. Purely informative — no new logic.
 */
function renderFirstUseOverlay(app: SampleMapApp): HTMLElement {
  const overlay = el("div", "first-use-overlay");
  overlay.setAttribute("data-testid", "first-use");
  overlay.appendChild(
    el("div", "first-use-title", emptyStateMessage(false)),
  );
  overlay.appendChild(
    el(
      "div",
      "first-use-sub",
      "Your public Audiotool samples, arranged as an explorable soundscape. Nothing has been indexed yet.",
    ),
  );
  const cta = button("first-use-cta", "Connect Audiotool & start indexing");
  cta.setAttribute("data-testid", "first-use-index");
  cta.onclick = () => void app.startScan();
  overlay.appendChild(cta);
  return overlay;
}

/** Step 16L: human label for the global-map state (never "whole map empty"). */
export function globalMapStateLabel(state: "idle" | "loading" | "ok" | "empty" | "error"): string {
  switch (state) {
    case "loading":
      return "Global: loading…";
    case "ok":
      return "Global: available";
    case "empty":
      return "Global: no points in viewport";
    case "error":
      return "Global: unavailable (local map still works)";
    case "idle":
    default:
      return "Global: idle";
  }
}

function renderResultsPanel(app: SampleMapApp): HTMLElement {
  const wrap = section(`Results (${app.results.length})`);

  if (app.results.length === 0) {
    const empty = el("div", "results-empty", "No samples match your filters.");
    empty.setAttribute("data-testid", "results-empty");
    wrap.appendChild(empty);
    return wrap;
  }

  const list = el("ul", "results-list");
  list.setAttribute("data-testid", "results-list");
  for (const { record } of app.results) {
    const view = resultView(record);

    const li = el("li", "result-row");
    li.setAttribute("data-testid", `result-${record.sampleId}`);

    const cb = el("input") as HTMLInputElement;
    cb.type = "checkbox";
    cb.checked = app.selectedSampleIds.includes(record.sampleId);
    cb.setAttribute("data-testid", `multiselect-${record.sampleId}`);
    cb.setAttribute("aria-label", `Select ${view.name} for batch`);
    cb.onclick = () => app.toggleMultiSelect(record);

    // STEP27 — Search → Collection (same pure boundary as Discovery / Sound
    // Space; ONLY the collection changes — never focus/selection/preview).
    const addToCollection = collectionActionButton(
      app,
      record,
      `collection-add-search-${record.sampleId}`,
    );

    const play = button("preview-btn", "▶");
    play.setAttribute("data-testid", `preview-${record.sampleId}`);
    play.onclick = () => void app.togglePreview(record);

    const name = el("span", "result-name", view.name);
    name.onclick = () => app.selectSample(record);
    name.style.cursor = "pointer";

    // Classification block — from primaryClass/confidence/secondary ONLY.
    const cls = el(
      "span",
      "result-class",
      `${view.primaryClass} (${(view.confidence * 100).toFixed(0)}%)`,
    );
    if (view.secondaryLabel) cls.title = `Secondary: ${view.secondaryLabel}`;

    // Original tags are displayed separately from the class label (INV-2).
    const tags = el(
      "span",
      "result-tags",
      view.originalTags.length ? `tags: ${view.originalTags.join(", ")}` : "",
    );

    const dur = el("span", "result-duration", view.durationLabel);

    li.append(cb, play, addToCollection, name, cls, tags, dur);
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

/**
 * STEP26 — "Find a sound": the smart-discovery surface. It joins the frozen
 * V1/V2 systems READ-ONLY (SearchEngine text + shared Sound Space character
 * filter + rankSimilar reference) through the pure `discoverSamples` core.
 * The panel renders the DISCOVERY snapshot only — draft/filter edits never
 * re-run it (run is explicit). Result rows reuse the canonical preview/focus
 * paths and are highlighted in the Sound Space WITHOUT moving coordinates.
 */
function renderDiscoveryPanel(app: SampleMapApp): HTMLElement {
  const wrap = section("Find a sound");
  // Progressive disclosure: only render discovery panel after first use,
  // or when explicitly open (for UX flow).
  const state = app.discovery;
  const headRow = el("div", "sound-space-header");
  const toggle = button("similar-btn", state.open ? "Close" : "Open");
  toggle.setAttribute("data-testid", "discovery-toggle");
  toggle.setAttribute("aria-label", state.open ? "Close discovery panel" : "Open discovery panel");
  toggle.onclick = () => (state.open ? app.closeDiscovery() : void app.openDiscovery());
  headRow.appendChild(toggle);
  wrap.appendChild(headRow);

  if (!state.open) return wrap;

  const queryRow = el("div", "discovery-query-row");
  const input = el("input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = "Describe the sound, e.g. dark kick…";
  input.value = app.discoveryTextDraft;
  input.setAttribute("data-testid", "discovery-text");
  input.setAttribute("aria-label", "Discovery search terms");
  input.oninput = () => app.setDiscoveryTextDraft(input.value);
  input.onkeydown = (e) => {
    if (e.key === "Enter") void app.runDiscovery();
  };
  const run = button("discovery-run-btn", "Find sounds");
  run.setAttribute("data-testid", "discovery-run");
  run.onclick = () => void app.runDiscovery();
  queryRow.append(input, run);
  wrap.appendChild(queryRow);

  const refRow = el("div", "discovery-reference-row");
  refRow.setAttribute("data-testid", "discovery-reference");
  const refLabel = el(
    "span",
    "discovery-reference-label",
    state.referenceSampleId !== undefined
      ? `Reference: ${app.sampleNameFor(state.referenceSampleId)}`
      : "No reference set",
  );
  refLabel.setAttribute("data-testid", "discovery-reference-label");
  const useFocused = button("similar-btn", "Use focused sample");
  useFocused.setAttribute("data-testid", "discovery-use-reference");
  useFocused.disabled = app.focusedSampleId === null;
  if (useFocused.disabled) useFocused.title = "Select a sample to use as a reference";
  useFocused.onclick = () => app.useFocusedSampleAsReference();
  refRow.append(refLabel, useFocused);
  if (state.referenceSampleId !== undefined) {
    const clear = button("sound-space-clear-filters", "Clear reference");
    clear.setAttribute("data-testid", "discovery-clear-reference");
    clear.onclick = () => app.clearDiscoveryReference();
    refRow.appendChild(clear);
  }
  wrap.appendChild(refRow);

  const statusText = discoveryStatusText(state);
  if (statusText) {
    const status = el("div", "discovery-status", statusText);
    status.setAttribute("data-testid", "discovery-status");
    status.setAttribute("role", state.status === "error" ? "alert" : "status");
    status.setAttribute("aria-live", "polite");
    wrap.appendChild(status);
  }

  if (state.status === "ready" && state.results.length > 0) {
    const list = el("ul", "discovery-results");
    list.setAttribute("data-testid", "discovery-list");
    for (const row of state.results) {
      const li = el("li", "discovery-row");
      li.setAttribute("data-testid", `discovery-result-${row.sampleId}`);

      const play = button("preview-btn", "▶");
      play.setAttribute("data-testid", `discovery-preview-${row.sampleId}`);
      play.setAttribute("aria-label", `Preview ${row.record.name}`);
      play.onclick = () => void app.togglePreviewById(row.sampleId);

      // STEP27 — Discovery → Collection (same pure boundary as Search / Sound
      // Space; ONLY the collection changes — never Discovery/focus/selection).
      const addToCollection = collectionActionButton(
        app,
        row.record,
        `collection-add-${row.sampleId}`,
      );

      const name = button("similarity-v2-name", row.record.name);
      name.setAttribute("data-testid", `discovery-name-${row.sampleId}`);
      name.onclick = () => app.selectSample(row.record);

      const score = el("span", "discovery-score", discoveryScoreLabel(row.score));
      score.setAttribute("data-testid", `discovery-score-${row.sampleId}`);
      if (row.sharedDimensionCount !== undefined) {
        score.title = `Shared dimensions: ${row.sharedDimensionCount}/8`;
      }

      const reasons = el(
        "span",
        "discovery-reasons",
        discoveryReasonSummary(row.reasons),
      );
      reasons.setAttribute("data-testid", `discovery-reasons-${row.sampleId}`);

      li.append(play, addToCollection, name, score, reasons);
      list.appendChild(li);
    }
    wrap.appendChild(list);
  }

  return wrap;
}

/**
 * STEP24 — the V2 Sound Space: a deterministic 2-D acoustic scatter of the
 * analyzed library, rendered on top of a static SVG (no library dependency).
 * The projector is PURE and corpus-independent (§7/§8) — the same sample
 * always occupies the same place, across runs and per added sample. Points are
 * rerendered from the open-time snapshot; focus changes mark the focused point
 * without recomputing positions (§46).
 */
function renderSoundSpacePanel(app: SampleMapApp): HTMLElement {
  const wrap = section("Sound Space");
  // STEP32 — Sound Space is an always-available (collapsed) advanced surface,
  // discovered by its own explicit "Open" control — no disclosure flag/opaque
  // reveal switch required (STEP31C H-1 / STEP32 §10).
  const state = app.soundSpace;

  const headRow = el("div", "sound-space-header");
  const searchIds = hasActiveSearch(app.searchState)
    ? new Set(app.results.map((r) => r.record.sampleId))
    : undefined;
  const visible = app.soundSpace.open
    ? app.soundSpace.status === "ready"
      ? visibleSoundSpacePoints(
          { points: state.points, recordsById: state.recordsById },
          app.soundSpaceFilter,
          searchIds,
        )
      : state.points
    : state.points;
  const visibleCount = visible.length;

  const counts = el(
    "div",
    "sound-space-meta",
    state.open
      ? state.status === "ready"
        ? `${soundSpaceCountLabel(state.points.length)} · ${soundSpaceVisibleLabel(
            visibleCount,
            state.points.length,
          )}`
        : ""
      : "",
  );
  counts.setAttribute("data-testid", "sound-space-meta");
  counts.setAttribute("role", "status");
  headRow.appendChild(counts);

  const toggle = button("similar-btn", soundSpaceToggleLabel(state.open));
  toggle.setAttribute("data-testid", "sound-space-toggle");
  toggle.setAttribute(
    "aria-label",
    state.open ? "Close Sound Space panel" : "Open Sound Space panel",
  );
  toggle.onclick = () => (state.open ? app.closeSoundSpace() : void app.openSoundSpace());
  headRow.appendChild(toggle);
  wrap.appendChild(headRow);

  if (!state.open) return wrap;

  if (state.status === "error") {
    const err = el("div", "sound-space-status sound-space-status-error");
    err.setAttribute("data-testid", "sound-space-status");
    err.setAttribute("role", "alert");
    err.textContent = state.error ?? "Sound Space failed to load.";
    wrap.appendChild(err);
    return wrap;
  }

  if (state.status === "empty") {
    const empty = el("div", "sound-space-status sound-space-status-empty", SOUND_SPACE_EMPTY_TEXT);
    empty.setAttribute("data-testid", "sound-space-status");
    empty.setAttribute("role", "status");
    wrap.appendChild(empty);
    return wrap;
  }

  if (state.points.length === 0) {
    // Ready but nothing rendered (defensive; openSoundSpace sets `empty`
    // instead of this branch when zero points remain after filtering).
    return wrap;
  }

  // --- axes ---------------------------------------------------------------
  const axes = el(
    "div",
    "sound-space-axes",
    soundSpaceAxisLabel(
      SOUND_SPACE_X_LOW,
      SOUND_SPACE_X_HIGH,
      SOUND_SPACE_Y_LOW,
      SOUND_SPACE_Y_HIGH,
    ),
  );
  axes.setAttribute("data-testid", "sound-space-axes");
  wrap.appendChild(axes);

  // --- filters ---------------------------------------------------------------
  const filterBox = el("div", "sound-space-filters");
  filterBox.setAttribute("data-testid", "sound-space-filters");
  const activeSummary = soundSpaceFilterSummary(app.soundSpaceFilter);
  const summaryEl = el("div", "sound-space-filter-summary", activeSummary);
  summaryEl.setAttribute("data-testid", "sound-space-filter-summary");
  const countLine = el(
    "div",
    "sound-space-visible-line",
    `${visibleCount} of ${state.points.length}`,
  );
  countLine.setAttribute("data-testid", "sound-space-visible-count");
  countLine.setAttribute("aria-live", "polite");

  const grid = el("div", "sound-space-filter-grid");
  const dims: Array<["brightness" | "density" | "transient" | "duration" | "tonality" | "noisiness" | "dynamics" | "complexity", string]> = [
    ["brightness", "Brightness"],
    ["density", "Density"],
    ["transient", "Transient"],
    ["duration", "Duration"],
    ["tonality", "Tonality"],
    ["noisiness", "Noisiness"],
    ["dynamics", "Dynamics"],
    ["complexity", "Complexity"],
  ];
  for (const [dim, label] of dims) {
    const current = app.soundSpaceFilter[dim];
    const row = el("div", "sound-space-filter-row");
    row.setAttribute("data-testid", `sound-space-filter-row-${dim}`);
    const lbl = el("label", "sound-space-filter-label", label);
    lbl.setAttribute("for", `sound-space-filter-min-${dim}`);
    const min = document.createElement("input");
    min.type = "number";
    min.min = "0";
    min.max = "1";
    min.step = "0.01";
    min.placeholder = "0.00";
    min.value = current?.min !== undefined ? String(current.min) : "";
    min.setAttribute("data-testid", `sound-space-filter-min-${dim}`);
    min.setAttribute("aria-label", `${label} min`);
    const max = document.createElement("input");
    max.type = "number";
    max.min = "0";
    max.max = "1";
    max.step = "0.01";
    max.placeholder = "1.00";
    max.value = current?.max !== undefined ? String(current.max) : "";
    max.setAttribute("data-testid", `sound-space-filter-max-${dim}`);
    max.setAttribute("aria-label", `${label} max`);

    // Reapply on Confirm/Blur — typing does not rebuild on every keystroke.
    const apply = () => {
      const next = { ...app.soundSpaceFilter };
      const vmin = min.value === "" ? NaN : Number(min.value);
      const vmax = max.value === "" ? NaN : Number(max.value);
      const hasMin = Number.isFinite(vmin);
      const hasMax = Number.isFinite(vmax);
      if (!hasMin && !hasMax) {
        delete next[dim];
      } else {
        const lo = hasMin && vmin >= 0 ? Math.min(1, vmin) : 0;
        const hi = hasMax && vmax <= 1 ? Math.max(0, vmax) : 1;
        next[dim] = { min: Math.min(lo, hi), max: Math.max(lo, hi) };
      }
      app.setSoundSpaceFilter(next);
    };
    min.onchange = apply;
    max.onchange = apply;

    row.append(lbl, min, max);
    grid.appendChild(row);
  }
  const clearBtn = button("sound-space-clear-filters", "Clear filters");
  clearBtn.setAttribute("data-testid", "sound-space-clear-filters");
  clearBtn.onclick = () => app.clearSoundSpaceFilter();
  filterBox.append(summaryEl, countLine, grid, clearBtn);
  wrap.appendChild(filterBox);

  // --- scatter ------------------------------------------------------------
  const scatter = el("div", "sound-space-canvas");
  scatter.setAttribute("data-testid", "sound-space-canvas");
  scatter.setAttribute("role", "img");
  scatter.setAttribute(
    "aria-label",
    `${SOUND_SPACE_X_LOW}–${SOUND_SPACE_X_HIGH} × ${SOUND_SPACE_Y_LOW}–${SOUND_SPACE_Y_HIGH} — V2 Sound Space`,
  );
  const W = 400;
  const H = 260;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("aria-hidden", "false");
  svg.classList.add("sound-space-svg");

  // Axes frame.
  const frame = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  frame.setAttribute("x", "1");
  frame.setAttribute("y", "1");
  frame.setAttribute("width", String(W - 2));
  frame.setAttribute("height", String(H - 2));
  frame.setAttribute("fill", "none");
  frame.setAttribute("class", "sound-space-frame");
  svg.appendChild(frame);

  // Axis-label text nodes in the frame corners (STEP37 canonical four-corner
  // model: X pole first, Y pole second, uniform Title Case, from the projector
  // constants — replaces the old four single-pole labels that omitted the
  // top-right corner and overlapped at the lower-left).
  const mkLabel = (x: number, y: number, text: string, anchor: "start" | "middle" | "end"): SVGTextElement => {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", String(x));
    t.setAttribute("y", String(y));
    t.setAttribute("text-anchor", anchor);
    t.setAttribute("class", "sound-space-axistick");
    t.textContent = text;
    return t;
  };
  const ssCorners = soundSpaceCornerLabels();
  svg.appendChild(mkLabel(W - 2, 10, ssCorners.topRight, "end")); // Tonal · Bright (right, top)
  svg.appendChild(mkLabel(2, 10, ssCorners.topLeft, "start")); // Noisy · Bright (left, top)
  svg.appendChild(mkLabel(W - 2, H - 4, ssCorners.bottomRight, "end")); // Tonal · Dark (right, bottom)
  svg.appendChild(mkLabel(2, H - 4, ssCorners.bottomLeft, "start")); // Noisy · Dark (left, bottom)

  for (const p of visible as unknown as Array<{ sampleId: string; x: number; y: number }>) {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const cx = 4 + p.x * (W - 8);
    const cy = 4 + (1 - p.y) * (H - 8);
    c.setAttribute("cx", cx.toFixed(2));
    c.setAttribute("cy", cy.toFixed(2));
    c.setAttribute("r", "4");
    c.setAttribute("data-testid", `sound-space-point-${p.sampleId}`);
    c.setAttribute(
      "title",
      `${app.sampleNameFor(p.sampleId)} — x=${p.x.toFixed(2)}, y=${p.y.toFixed(2)}`,
    );
    c.setAttribute("tabindex", "0");
    c.setAttribute("aria-label", app.sampleNameFor(p.sampleId));
    const classes = ["sound-space-point"];
    if (app.focusedSampleId === p.sampleId) classes.push("sound-space-point-focused");
    if (app.selectedSampleIds.includes(p.sampleId)) {
      classes.push("sound-space-point-selected");
    }
    // STEP26 — discovery results are HIGHLIGHTED without moving the coordinate
    // (the frozen projector position is untouched; a highlight is a blot only).
    if (app.discoveryHighlightedSampleIds.has(p.sampleId)) {
      classes.push("sound-space-point-discovery");
    }
    // STEP27 — collection membership mark: VISUAL ONLY, coordinates frozen.
    if (app.isCollectionMember(p.sampleId)) {
      classes.push("sound-space-point-collection");
    }
    c.classList.add(...classes);

    const recAt = () => state.recordsById.get(p.sampleId);
    // SELECTION (Cmd/Ctrl + click): on macOS Chrome a ctrl+left-click only
    // fires mousedown/mouseup (click is suppressed as a candidate context-menu
    // gesture), so the toggle must run on mousedown; the click handler then
    // only skips focus for modifier-clicks (avoids toggling twice).
    c.onmousedown = (e) => {
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const rec = recAt();
        if (rec) app.toggleMultiSelect(rec);
      }
    };
    c.onclick = (e) => {
      if (e.metaKey || e.ctrlKey) return; // handled on mousedown
      app.focusSampleById(p.sampleId);
    };
    // Suppress the ctrl+click context menu on macOS (left-button modifier).
    c.oncontextmenu = (e) => {
      if (e.ctrlKey) e.preventDefault();
    };
    // Hover / keyboard focus only visual emphasis: hover does NOT mutate.
    c.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        app.focusSampleById(p.sampleId);
      }
    };
    svg.appendChild(c);
  }
  scatter.appendChild(svg);
  wrap.appendChild(scatter);

  // --- compare toggle -------------------------------------------------------
  const compareRow = el("div", "sound-space-compare-row");
  const selectionCount = app.selectedSampleIds.length;
  const compareBtn = button(
    "similar-btn",
    `Compare (${selectionCount})`,
  );
  compareBtn.setAttribute("data-testid", "sound-space-compare-toggle");
  compareBtn.setAttribute(
    "aria-label",
    selectionCount < 2 ? "Compare — select at least 2 samples" : "Compare selected samples",
  );
  compareBtn.disabled = selectionCount < 2;
  compareBtn.onclick = () => {
    if (app.soundSpaceCompare.open) app.closeSoundSpaceCompare();
    else app.openSoundSpaceCompare();
  };
  compareRow.appendChild(compareBtn);
  if (selectionCount > 0) {
    const clearSel = button("sound-space-clear-selection", "Clear selection");
    clearSel.setAttribute("data-testid", "sound-space-clear-selection");
    clearSel.onclick = () => app.clearSelection();
    compareRow.appendChild(clearSel);
  }
  wrap.appendChild(compareRow);

  // STEP27 — add the FOCUSED sample to the Collection from the Sound Space
  // (the sample is already visible; ONLY the collection changes — focus,
  // selection, filters and the frozen coordinates are untouched).
  const focusedRec =
    app.focusedSampleId !== null
      ? (state.recordsById.get(app.focusedSampleId) ?? app.recordForSample(app.focusedSampleId))
      : undefined;
  if (focusedRec) {
    const collBtn = button(
      "collection-add-focused",
      app.isCollectionMember(focusedRec.sampleId) ? "In Collection" : "Add to Collection",
    );
    collBtn.setAttribute("data-testid", `collection-add-focused-${focusedRec.sampleId}`);
    collBtn.setAttribute("aria-label", `Add ${focusedRec.name} to Collection`);
    collBtn.onclick = () => void app.addToCollection(focusedRec.sampleId, focusedRec);
    compareRow.appendChild(collBtn);
  }
  if (app.soundSpaceCompare.open) {
    wrap.appendChild(renderSoundSpaceComparePanel(app));
  }

  return wrap;
}

/** STEP25 — Compare table of the selected samples' V2 SoundCharacter. */
function renderSoundSpaceComparePanel(app: SampleMapApp): HTMLElement {
  const wrap = el("section", "sound-space-compare");
  wrap.setAttribute("data-testid", "sound-space-compare-panel");
  const head = el("h3", "sound-space-compare-title", "Compare");
  head.setAttribute("data-testid", "sound-space-compare-title");
  wrap.appendChild(head);

  const entries = app.soundSpaceCompareCharacters;
  if (entries.length === 0) {
    wrap.appendChild(
      el("div", "sound-space-compare-empty", "No samples selected for comparison."),
    );
    return wrap;
  }

  const dimKeys: Array<[string, string]> = [
    ["brightness", "Brightness"],
    ["density", "Density"],
    ["transient", "Transient"],
    ["duration", "Duration"],
    ["tonality", "Tonality"],
    ["noisiness", "Noisiness"],
    ["dynamics", "Dynamics"],
    ["complexity", "Complexity"],
  ];

  // Simple table: row per dimension + one column per sample.
  const table = el("table", "sound-space-compare-table");
  const thead = el("thead", "");
  const headerRow = el("tr", "sound-space-compare-row");
  headerRow.appendChild(el("th", "sound-space-compare-cell", "Dimension"));
  for (const sample of entries) {
    const th = el(
      "th",
      "sound-space-compare-cell sound-space-compare-head",
      compareEntryLabel(sample.name),
    );
    th.setAttribute("data-testid", `sound-space-compare-head-${sample.id}`);
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el("tbody", "");
  for (const [dimKey, dimLabel] of dimKeys) {
    const tr = el("tr", "sound-space-compare-row");
    tr.setAttribute("data-testid", `sound-space-compare-row-${dimKey}`);
    tr.appendChild(el("td", "sound-space-compare-cell sound-space-compare-dim", dimLabel));
    for (const sample of entries) {
      const v = sample.character
        ? (sample.character as unknown as Record<string, number | null>)[dimKey]
        : null;
      const cell = el(
        "td",
        "sound-space-compare-cell",
        characterValueLabel(v),
      );
      cell.setAttribute(
        "data-testid",
        `sound-space-compare-${dimKey}-${sample.id}`,
      );
      tr.appendChild(cell);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  // Actions: Preview + Focus + Find Similar (STEP23 surface, no new router).
  const actions = el("div", "sound-space-compare-actions");
  for (const sample of entries) {
    const box = el("div", "sound-space-compare-actions-entry");
    box.setAttribute(
      "data-testid",
      `sound-space-compare-actions-${sample.id}`,
    );
    const focusBtn = button("similar-btn", `Focus: ${sample.name}`);
    focusBtn.setAttribute("data-testid", `sound-space-compare-focus-${sample.id}`);
    focusBtn.setAttribute("aria-label", `Focus ${sample.name}`);
    focusBtn.onclick = () => app.focusSampleById(sample.id);

    const previewBtn = button("similar-btn", `Preview: ${sample.name}`);
    previewBtn.setAttribute("data-testid", `sound-space-compare-preview-${sample.id}`);
    previewBtn.setAttribute("aria-label", `Preview ${sample.name}`);
    previewBtn.onclick = () => void app.togglePreviewById(sample.id);

    const similarBtn = button("similar-btn", `Find Similar: ${sample.name}`);
    similarBtn.setAttribute("data-testid", `sound-space-compare-similar-${sample.id}`);
    similarBtn.setAttribute("aria-label", `Find similar to ${sample.name}`);
    similarBtn.onclick = () => app.findSimilarForId(sample.id);

    box.append(focusBtn, previewBtn, similarBtn);
    actions.appendChild(box);
  }
  wrap.appendChild(actions);

  return wrap;
}

// ---------------------------------------------------------------------------
// STEP27 — Sound Collection panel
// ---------------------------------------------------------------------------

/**
 * STEP27 — shared "Add / Added" control mounted on EVERY source row
 * (Discovery, Search Results, Sound-Space-focused). Clicking it mutates ONLY
 * the collection; the source list, focus, selection, preview and filters stay
 * untouched. A member's "Added" label is itself the state signal — filtered
 * OUT of the panel list by the member row itself, never a hard filter change.
 */
function collectionActionButton(
  app: SampleMapApp,
  record: SampleIndexRecord,
  testid: string,
): HTMLButtonElement {
  const btn = button("collection-add", collectionAddLabel(app.isCollectionMember(record.sampleId)));
  btn.setAttribute("data-testid", testid);
  btn.setAttribute("aria-label", `Add ${record.name} to Collection`);
  btn.onclick = () => void app.addToCollection(record.sampleId, record);
  return btn;
}

/** STEP27 — the Collection panel (session-local, capped, insertion-ordered). */
function renderCollectionPanel(app: SampleMapApp): HTMLElement {
  const wrap = section("My Sounds");
  const state = app.collection;
  const members = app.collectionMembers;

  // --- head: counter + toggle ------------------------------------------------
  const headRow = el("div", "collection-header");
  const counter = el(
    "div",
    "collection-counter",
    collectionCounterLabel(members.length),
  );
  counter.setAttribute("data-testid", "collection-counter");
  counter.setAttribute("role", "status");
  headRow.appendChild(counter);

  const toggle = button("similar-btn", state.open ? "Close Collection" : "Open Collection");
  toggle.setAttribute("data-testid", "collection-toggle");
  toggle.setAttribute(
    "aria-label",
    state.open ? "Close Collection panel" : "Open Collection panel",
  );
  toggle.onclick = () =>
    state.open ? app.closeCollection() : void app.openCollection();
  headRow.appendChild(toggle);
  wrap.appendChild(headRow);

  if (!state.open) return wrap;

  // --- actions ----------------------------------------------------------------
  const actions = el("div", "collection-actions");
  const full = isCollectionFull(state);
  const selectAll = button(
    "similar-btn",
    collectionSelectAllLabel(members.length),
  );
  selectAll.setAttribute("data-testid", "collection-select-all");
  selectAll.disabled = members.length === 0;
  selectAll.onclick = () => app.selectCollection();

  const compare = button("similar-btn", "Compare Collection");
  compare.setAttribute("data-testid", "collection-compare-toggle");
  compare.disabled = members.length < 2;
  compare.onclick = () =>
    app.collectionCompare.open ? app.closeCollectionCompare() : app.openCollectionCompare();

  const clear = button("similar-btn sound-space-clear-selection", "Clear Collection");
  clear.setAttribute("data-testid", "collection-clear");
  clear.disabled = members.length === 0;
  clear.onclick = () => void app.clearCollection();

  actions.append(selectAll, compare, clear);
  wrap.appendChild(actions);

  // --- status (full / empty) ---------------------------------------------------
  if (full) {
    const status = el("div", "collection-status collection-status-full", COLLECTION_FULL_TEXT);
    status.setAttribute("data-testid", "collection-status");
    status.setAttribute("role", "status");
    wrap.appendChild(status);
  }

  if (members.length === 0) {
    const empty = el("div", "collection-status collection-status-empty", COLLECTION_EMPTY_TEXT);
    empty.setAttribute("data-testid", "collection-status");
    empty.setAttribute("role", "status");
    wrap.appendChild(empty);
    return wrap;
  }

  // --- members (explicit insertion order) ---------------------------------------
  const list = el("ul", "collection-list");
  list.setAttribute("data-testid", "collection-list");
  for (const member of members) {
    const li = el("li", "collection-row");
    li.setAttribute("data-testid", `collection-result-${member.sampleId}`);

    const name = button("similarity-v2-name", member.record?.name ?? COLLECTION_UNAVAILABLE_LABEL);
    name.setAttribute("data-testid", `collection-name-${member.sampleId}`);
    if (member.available) {
      name.onclick = () => app.focusSampleById(member.sampleId);
    }

    // STEP27 — a stale member is previewable ONLY while its record is still
    // resolvable; the unavailable badge carries the honest label when missing.
    const play = button("preview-btn", "▶");
    play.setAttribute("data-testid", `collection-preview-${member.sampleId}`);
    play.disabled = !member.available;
    play.setAttribute("aria-label", `Preview ${member.record?.name ?? "sample"}`);
    if (member.available) {
      play.onclick = () => void app.togglePreviewById(member.sampleId);
    }

    const remove = button("collection-remove", "Remove");
    remove.setAttribute("data-testid", `collection-remove-${member.sampleId}`);
    remove.setAttribute("aria-label", `Remove ${member.record?.name ?? "sample"} from Collection`);
    remove.onclick = () => void app.removeFromCollection(member.sampleId);

    li.append(play, name, remove);
    list.appendChild(li);
  }
  wrap.appendChild(list);

  // --- character summary (Collection average, per present values) -----------------
  const summary = app.collectionSummary;
  const summaryBox = el("div", "collection-summary");
  summaryBox.setAttribute("data-testid", "collection-summary");
  const summaryHead = el(
    "h4",
    "collection-summary-title",
    `${COLLECTION_AVG_LABEL} · ${members.length}`,
  );
  summaryHead.setAttribute("data-testid", "collection-summary-title");
  summaryBox.appendChild(summaryHead);

  const grid = el("dl", "collection-summary-grid");
  for (const [dimKey, dimLabel] of [
    ["brightness", "Brightness"],
    ["density", "Density"],
    ["transient", "Transient"],
    ["duration", "Duration"],
    ["tonality", "Tonality"],
    ["noisiness", "Noisiness"],
    ["dynamics", "Dynamics"],
    ["complexity", "Complexity"],
  ] as Array<[string, string]>) {
    const row = el("div", "collection-summary-row");
    row.setAttribute("data-testid", `collection-summary-${dimKey}`);
    const dt = el("dt", "collection-summary-dim", dimLabel);
    const value =
      summary !== null ? (summary as unknown as Record<string, number | null>)[dimKey] : null;
    const dd = el("dd", "collection-summary-value", characterValueLabel(value));
    dd.setAttribute("data-testid", `collection-summary-value-${dimKey}`);
    row.append(dt, dd);
    grid.appendChild(row);
  }
  summaryBox.appendChild(grid);
  wrap.appendChild(summaryBox);

  // --- Compare surface (derived, never mutating) ------------------------------
  if (app.collectionCompare.open) {
    wrap.appendChild(renderCollectionComparePanel(app));
  }

  return wrap;
}

/** STEP27 — Compare table over the first ≤4 collection members (collection order). */
function renderCollectionComparePanel(app: SampleMapApp): HTMLElement {
  const wrap = el("section", "sound-space-compare");
  wrap.setAttribute("data-testid", "collection-compare-panel");
  const head = el("h3", "sound-space-compare-title", "Compare Collection");
  head.setAttribute("data-testid", "collection-compare-title");
  wrap.appendChild(head);

  const entries = app.collectionCompareCharacters;
  if (entries.length < 2) return wrap;

  const table = el("table", "sound-space-compare-table");
  const thead = el("thead", "");
  const headerRow = el("tr", "sound-space-compare-row");
  headerRow.appendChild(el("th", "sound-space-compare-cell", "Dimension"));
  for (const sample of entries) {
    const th = el(
      "th",
      "sound-space-compare-cell sound-space-compare-head",
      compareEntryLabel(sample.name),
    );
    th.setAttribute("data-testid", `collection-compare-head-${sample.id}`);
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el("tbody", "");
  for (const [dimKey, dimLabel] of [
    ["brightness", "Brightness"],
    ["density", "Density"],
    ["transient", "Transient"],
    ["duration", "Duration"],
    ["tonality", "Tonality"],
    ["noisiness", "Noisiness"],
    ["dynamics", "Dynamics"],
    ["complexity", "Complexity"],
  ] as Array<[string, string]>) {
    const tr = el("tr", "sound-space-compare-row");
    tr.setAttribute("data-testid", `collection-compare-row-${dimKey}`);
    tr.appendChild(el("td", "sound-space-compare-cell sound-space-compare-dim", dimLabel));
    for (const sample of entries) {
      const v = sample.character
        ? (sample.character as unknown as Record<string, number | null>)[dimKey]
        : null;
      const cell = el("td", "sound-space-compare-cell", characterValueLabel(v));
      cell.setAttribute("data-testid", `collection-compare-${dimKey}-${sample.id}`);
      tr.appendChild(cell);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  return wrap;
}

/**
 * STEP28 — the persistent collection manager panel (§40–§42). Lists the saved
 * collections and orchestrates the lifecycle (New / Save / Save As / Load /
 * Switch / Delete) with honest loading, error, corrupt and unsupported-version
 * states. Every control is a real button/input with keyboard accessibility.
 */
function renderCollectionManagerPanel(app: SampleMapApp): HTMLElement {
  const wrap = section(COLLECTION_MANAGER_TITLE);
  wrap.setAttribute("data-testid", "collection-manager");

  const status = el(
    "div",
    "collection-manager-status",
    collectionManagerStatusLabel(app.collectionDirty, app.collectionName),
  );
  status.setAttribute("data-testid", "collection-active");
  status.setAttribute("role", "status");
  wrap.appendChild(status);

  // --- name input + dirty marker ---------------------------------------------
  const nameRow = el("div", "collection-manager-name");
  const nameLabel = el("label", "collection-manager-name-label", "Active collection:");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = app.collectionManager.nameDraft;
  nameInput.setAttribute("data-testid", "collection-name-input");
  nameInput.setAttribute("aria-label", "Active collection name");
  nameInput.setAttribute("aria-invalid", app.collectionName === "" ? "true" : "false");
  nameInput.dataset.dirty = app.collectionDirty ? "true" : "false";
  nameInput.oninput = () => app.setCollectionNameDraft(nameInput.value);
  nameInput.onchange = () => {
    app.renameCollection(nameInput.value);
    app.onCollectionNameCommitted();
  };
  (nameLabel as HTMLLabelElement).htmlFor = nameInput.id = "collection-name-input-field";
  nameRow.append(nameLabel, nameInput);
  wrap.appendChild(nameRow);

  const saveError = app.collectionSaveError;
  if (saveError) {
    const err = el("div", "collection-manager-error", saveError);
    err.setAttribute("data-testid", "collection-save-error");
    err.setAttribute("role", "alert");
    wrap.appendChild(err);
  }

  const actions = el("div", "collection-actions");
  const newBtn = button("similar-btn", "New Collection");
  newBtn.setAttribute("data-testid", "collection-new");
  newBtn.onclick = () => app.createNewCollection();

  const saveBtn = button("similar-btn", app.activeCollectionId === null ? "Save As" : "Save");
  saveBtn.setAttribute("data-testid", "collection-save");
  saveBtn.onclick = () =>
    app.activeCollectionId === null || app.collectionDirty
      ? void app.saveCollection()
      : void app.saveCollection();
  saveBtn.disabled = app.collectionSaving || !app.collectionPersistenceAvailable;

  const saveAsBtn = button("similar-btn", "Save As");
  saveAsBtn.setAttribute("data-testid", "collection-save-as");
  saveAsBtn.disabled = app.collectionSaving || !app.collectionPersistenceAvailable;
  saveAsBtn.onclick = () => void app.saveCollectionAs();

  const manageBtn = button(
    "similar-btn",
    app.collectionManager.open ? "Hide List" : "Show Saved",
  );
  manageBtn.setAttribute("data-testid", "collection-manager-toggle");
  manageBtn.onclick = () =>
    app.collectionManager.open ? app.closeCollectionManager() : void app.openCollectionManager();

  actions.append(newBtn, saveBtn, saveAsBtn, manageBtn);
  wrap.appendChild(actions);

  if (!app.collectionPersistenceAvailable) {
    const unavail = el("div", "collection-manager-warn", COLLECTION_PERSISTENCE_UNAVAILABLE);
    unavail.setAttribute("data-testid", "collection-persistence-unavailable");
    wrap.appendChild(unavail);
  }

  // --- list (surfaced, never faked-empty) -------------------------------------
  if (!app.collectionManager.open) return wrap;

  if (app.collectionManager.listStatus === "loading") {
    wrap.appendChild(el("div", "collection-manager-hint", collectionListLoadingText()));
  } else if (app.collectionManager.listError) {
    const err = el(
      "div",
      "collection-manager-error",
      collectionListErrorText(app.collectionManager.listError),
    );
    err.setAttribute("data-testid", "collection-list-error");
    err.setAttribute("role", "alert");
    wrap.appendChild(err);
    wrap.appendChild(renderCollectionList(app));
  } else {
    wrap.appendChild(renderCollectionList(app));
  }

  // --- confirmation dialogs (explicit Save/Discard/Cancel or Delete) ----------
  const confirm = app.collectionManager.confirm;
  if (confirm?.kind === "switch") {
    wrap.appendChild(renderCollectionSwitchConfirm(app, confirm.targetName));
  } else if (confirm?.kind === "delete") {
    wrap.appendChild(renderCollectionDeleteConfirm(app, confirm.name));
  }

  return wrap;
}

/** STEP28 — the saved-collections list (valid + honestly-invalid rows). */
function renderCollectionList(app: SampleMapApp): HTMLElement {
  const entries = app.collectionManager.entries;
  const list = el("ul", "collection-manager-list");
  list.setAttribute("data-testid", "collection-list");

  if (entries.length === 0 && app.collectionManager.listStatus === "loaded") {
    const empty = el("li", "collection-manager-hint", collectionListEmptyText());
    empty.setAttribute("data-testid", "collection-empty");
    list.appendChild(empty);
    return list;
  }

  for (const entry of entries) {
    const li = el("li", "collection-manager-row");
    li.setAttribute("data-testid", `collection-row-${entry.id}`);

    const name = el(
      "div",
      "collection-manager-row-name",
      collectionRowLabel(entry.name, entry.active),
    );
    li.appendChild(name);

    if (entry.invalid) {
      const badge = el(
        "div",
        entry.invalid.kind === "unsupported-version"
          ? "collection-manager-badge collection-manager-warn"
          : "collection-manager-badge collection-manager-error",
        entry.invalid.kind === "unsupported-version"
          ? `Unsupported version (${entry.invalid.unknownVersion}) — kept, not deleted`
          : "Corrupt — kept, not deleted",
      );
      badge.setAttribute("data-testid", `collection-invalid-${entry.id}`);
      li.appendChild(badge);
    }

    if (!entry.invalid) {
      const loadBtn = button("similar-btn", entry.active ? "Active" : "Load");
      loadBtn.setAttribute("data-testid", `collection-load-${entry.id}`);
      loadBtn.disabled = entry.active;
      loadBtn.onclick = () => app.requestSwitchCollection(entry.id, entry.name);
      li.appendChild(loadBtn);
    }

    const delBtn = button("collection-remove", "Delete");
    delBtn.setAttribute("data-testid", `collection-delete-${entry.id}`);
    delBtn.disabled = entry.invalid?.kind === "unsupported-version";
    delBtn.onclick = () => app.requestDeleteCollection(entry.id, entry.name);
    li.appendChild(delBtn);

    list.appendChild(li);
  }

  if (app.collectionManager.loadError) {
    const err = el("div", "collection-manager-error", app.collectionManager.loadError);
    err.setAttribute("data-testid", "collection-load-error");
    err.setAttribute("role", "alert");
    list.appendChild(err);
  }
  if (app.collectionManager.deleteError) {
    const err = el("div", "collection-manager-error", app.collectionManager.deleteError);
    err.setAttribute("data-testid", "collection-delete-error");
    err.setAttribute("role", "alert");
    list.appendChild(err);
  }

  return list;
}

/** STEP28 — the unsaved-switch confirmation (Save / Discard / Cancel — §30). */
function renderCollectionSwitchConfirm(app: SampleMapApp, targetName: string): HTMLElement {
  const box = el("div", "ep7-dialog");
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("data-testid", "collection-switch-confirm");
  const title = el("h3", "ep7-dialog-title", "Unsaved changes");
  box.appendChild(title);
  box.appendChild(el("p", "ep7-dialog-body", collectionSwitchConfirmBody(targetName)));

  const actions = el("div", "ep7-dialog-actions");
  const saveDiscard = button("similar-btn", "Save & Switch");
  saveDiscard.setAttribute("data-testid", "collection-switch-save");
  saveDiscard.onclick = () => void app.confirmSaveThenSwitch();
  const discard = button("similar-btn", "Discard & Switch");
  discard.setAttribute("data-testid", "collection-switch-discard");
  discard.onclick = () => void app.confirmDiscardThenSwitch();
  const cancel = button("similar-btn", "Cancel");
  cancel.setAttribute("data-testid", "collection-switch-cancel");
  cancel.onclick = () => app.cancelSwitch();
  actions.append(saveDiscard, discard, cancel);
  box.appendChild(actions);
  return box;
}

/** STEP28 — the explicit delete confirmation (§31) with "samples NOT deleted". */
function renderCollectionDeleteConfirm(app: SampleMapApp, name: string): HTMLElement {
  const box = el("div", "ep7-dialog");
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("data-testid", "collection-delete-confirm");
  const title = el("h3", "ep7-dialog-title", "Delete collection?");
  box.appendChild(title);
  box.appendChild(el("p", "ep7-dialog-body", collectionDeleteConfirmBody(name)));

  const actions = el("div", "ep7-dialog-actions");
  const confirmBtn = button("similar-btn", "Delete");
  confirmBtn.setAttribute("data-testid", "collection-delete-confirm-btn");
  confirmBtn.onclick = () => void app.confirmDeleteCollection();
  const cancel = button("similar-btn", "Cancel");
  cancel.setAttribute("data-testid", "collection-delete-cancel");
  cancel.onclick = () => app.cancelDeleteCollection();
  actions.append(confirmBtn, cancel);
  box.appendChild(actions);
  return box;
}

function renderSimilarPanel(app: SampleMapApp): HTMLElement {
  const wrap = section("Find Similar");

  if (app.similarError) {
    wrap.appendChild(el("div", "results-empty", app.similarError));
    return wrap;
  }
  if (app.similarRecords.length === 0) {
    wrap.appendChild(
      el("div", "results-empty", "No similar samples found yet. Select a sample and press Find Similar."),
    );
    return wrap;
  }

  const list = el("ul", "results-list");
  list.setAttribute("data-testid", "similar-list");
  for (const rec of app.similarRecords) {
    const view = resultView(rec);
    const li = el("li", "result-row");
    li.setAttribute("data-testid", `similar-${rec.sampleId}`);

    const play = button("preview-btn", "▶");
    play.setAttribute("data-testid", `similar-preview-${rec.sampleId}`);
    play.onclick = () => void app.togglePreview(rec);

    const name = el("span", "result-name", view.name);
    name.style.cursor = "pointer";
    name.onclick = () => app.selectSample(rec);

    const cls = el(
      "span",
      "result-class",
      `${view.primaryClass} (${(view.confidence * 100).toFixed(0)}%)`,
    );

    const origin = el("span", "result-origin", "global");
    li.append(play, name, cls, origin);
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

/**
 * STEP23 — the V2 similarity product surface (snapshot panel).
 *
 * Always present in the inspector region: a "Find Similar" action on top
 * (disabled until a sample is focused) and, after invocation, the SNAPSHOT of
 * `app.similarityV2` — query header, ranked rows, status/limited notes and a
 * Close action. Rows reuse the existing preview path (`togglePreview`) and the
 * V1 selection path (`selectSample`, which drives the inspector + map focus),
 * but the panel renders ONLY the snapshot, so a later focus change can never
 * re-rank the open surface (stale-query policy §29/§30).
 */
function renderSimilarityV2Panel(app: SampleMapApp): HTMLElement {
  const wrap = section("Similar Sounds");
  const state: SimilarityState = app.similarityV2;

  const row = el("div", "inspector-similarity-v2-row");
  const sbtn = button("similar-btn", "Find Similar");
  sbtn.setAttribute("data-testid", "inspector-find-similar-v2");
  sbtn.disabled = app.focusedSampleId === null;
  if (sbtn.disabled) {
    sbtn.title = "Select a sample to find similar sounds";
  }
  sbtn.onclick = () => void app.openFindSimilarV2();
  row.appendChild(sbtn);
  wrap.appendChild(row);

  if (!state.open) return wrap;

  const query = el(
    "div",
    "similarity-v2-query",
    similarityV2Header(state.queryName),
  );
  query.setAttribute("data-testid", "similarity-v2-query");
  wrap.appendChild(query);

  const limited = similarityV2LimitedLabel(state);
  if (limited) {
    const note = el("div", "similarity-v2-limited", limited);
    note.setAttribute("data-testid", "similarity-v2-limited");
    note.title =
      "The query sample's V2 features are only partially determined; scores cover shared dimensions.";
    wrap.appendChild(note);
  }

  const statusText = similarityV2StatusText(state);
  if (statusText) {
    const status = el("div", "similarity-v2-status", statusText);
    status.setAttribute("data-testid", "similarity-v2-status");
    wrap.appendChild(status);
  }

  if (state.status === "ready" && state.results.length > 0) {
    const list = el("ul", "similarity-v2-list");
    list.setAttribute("data-testid", "similarity-v2-list");
    for (const r of state.results) {
      const li = el("li", "similarity-v2-row");
      li.setAttribute("data-testid", `similarity-v2-result-${r.sampleId}`);

      const play = button("preview-btn", "▶");
      play.setAttribute("data-testid", `similarity-v2-preview-${r.sampleId}`);
      play.setAttribute("aria-label", `Preview ${r.record.name}`);
      play.onclick = () => void app.togglePreview(r.record);

      const name = button("similarity-v2-name", r.record.name);
      name.setAttribute("data-testid", `similarity-v2-name-${r.sampleId}`);
      name.onclick = () => app.selectSample(r.record);

      const score = el(
        "span",
        "similarity-v2-score",
        similarityV2ScoreLabel(r.similarity),
      );
      score.setAttribute("data-testid", `similarity-v2-score-${r.sampleId}`);
      score.title = `Shared dimensions: ${r.sharedDimensionCount}/8`;

      li.append(play, name, score);
      list.appendChild(li);
    }
    wrap.appendChild(list);
  }

const close = button("similarity-v2-close", "Close");
  close.setAttribute("data-testid", "similarity-v2-close");
  close.onclick = () => app.closeFindSimilarV2();
  wrap.appendChild(close);

  return wrap;
}

function renderDetailPanel(app: SampleMapApp): HTMLElement {
  const wrap = section("Inspector");

  // Step 16L Phase 2: Global Inspection — a global-only point selected for
  // inspection (no local record yet). Renders the canonical global analysis
  // directly, WITHOUT running the analysis pipeline.
  if (!app.focusedSampleId && app.globalInspection) {
    renderGlobalInspection(wrap, app);
    return wrap;
  }

  // Step 15E: no stale info when nothing is focused.
  if (!app.focusedSampleId) {
    wrap.appendChild(el("div", "inspector-empty", "No sample selected."));
    return wrap;
  }

  const selected = app.focusedRecord;
  if (!selected) {
    wrap.appendChild(el("div", "inspector-empty", "No sample selected."));
    return wrap;
  }
  const d = detailView(selected);

  // Sample name (prominent).
  const name = el("div", "inspector-name", d.name);
  name.setAttribute("data-testid", "inspector-name");

  const meta = el("pre", "inspector-meta");
  meta.textContent = [
    `Owner: ${d.owner}`,
    `Duration: ${d.durationSeconds.toFixed(2)}s`,
  ].join("\n");

  // Classification block — strictly separate from tags (INV-2).
  const cls = el("div", "inspector-classification");
  cls.appendChild(el("h4", undefined, "Classification"));
  cls.appendChild(
    el("div", "inspector-class-primary", d.classification.primaryClass),
  );
  cls.appendChild(
    el(
      "div",
      undefined,
      `Confidence: ${d.classification.confidence.toFixed(3)}`,
    ),
  );
  const sec = d.classification.secondaryClasses
    .map((c) => `${c.class} (${c.confidence.toFixed(2)})`)
    .join(", ");
  cls.appendChild(el("div", undefined, `Secondary: ${sec || "none"}`));
  // §20.3/§20.5 — the inspector always carries the estimate disclaimer.
  cls.appendChild(
    el(
      "div",
      "inspector-classification-note",
      "Classification is an estimate, not a ground truth.",
    ),
  );

  // Original tags — separate section (INV-2).
  const tags = el("div", "inspector-tags");
  tags.appendChild(el("h4", undefined, "Original Tags"));
  tags.appendChild(
    el(
      "div",
      undefined,
      d.originalTags.length ? d.originalTags.join(", ") : "(none)",
    ),
  );

  // Map position (optional, Step 15E §6) — exclusively from mapPosition().
  const posEl = el("div", "inspector-position");
  const pos = detailMapPosition(selected);
  posEl.appendChild(el("h4", undefined, "Map Position"));
  posEl.appendChild(
    el(
      "div",
      undefined,
      mapPositionLabel(pos),
    ),
  );

  // Musical metadata block (METADATA SLICE). `bpm===0` is a preserved source
  // value but displayed as "—"; null (legacy/absent) renders the same way. This
  // is informational tempo metadata only, never a rating or score.
  const musical = el("div", "inspector-musical");
  musical.appendChild(el("h4", undefined, "Musical"));
  musical.appendChild(
    el(
      "div",
      "inspector-musical-bpm",
      `BPM: ${d.musical.bpm === null || d.musical.bpm === 0 ? "—" : d.musical.bpm}`,
    ),
  );

  // Community metadata block (METADATA SLICE). Raw Audiotool counters shown
  // verbatim — explicitly NOT a rating, NOT a popularity score, and never
  // folded into confidence/relevance. No stars, no derived quality score.
  const community = el("div", "inspector-community");
  community.appendChild(el("h4", undefined, "Community"));
  community.appendChild(
    el(
      "div",
      "inspector-community-favorites",
      d.community.numFavorites == null
        ? "Favorites: —"
        : `Favorites: ${d.community.numFavorites}`,
    ),
  );
  community.appendChild(
    el(
      "div",
      "inspector-community-usages",
      d.community.numUsages == null
        ? "Usages: —"
        : `Usages: ${d.community.numUsages}`,
    ),
  );

  // STEP16R E-P6 — GLOBAL PUBLISH status block (additive, read-only). Shown
  // only when the publish surface is wired (an in-memory queue snapshot is
  // available). Status precedence (view.ts publishStatusFor / STEP16T §4):
  // current queue outcome → persisted delivery marker → none. Conflict /
  // rejected / temporary-unavailable require a concrete queue outcome and are
  // never inferred from the persisted marker alone. No mutation of the queue.
  let publish: HTMLElement | undefined;
  const queue = app.globalPublishQueue;
  if (queue) {
    publish = el("div", "inspector-publish");
    publish.appendChild(el("h4", undefined, "Global Publish"));
    // BUG #1 (STEP16V): a stale terminal queue item must never mask a newer
    // publish state. The snapshot is append-ordered, so the NEWEST item for the
    // sampleId wins (e.g. conflict → re-accept → success shows Stored, never the
    // older Conflict). The queue's own state machine stays untouched.
    const item = newestPublishItem(queue.snapshot(), selected.sampleId);
    const pStatus = publishStatusFor(selected.globalPublish, item);
    const pStatusEl = el(
      "div",
      "inspector-publish-status",
      `Status: ${publishStatusLabel(pStatus)}`,
    );
    pStatusEl.setAttribute("data-testid", "inspector-publish-status");
    publish.appendChild(pStatusEl);
    const pDeliveryEl = el(
      "div",
      "inspector-publish-delivery",
      `Delivery: ${publishDeliveryLabel(app.globalPublishDeliveryMode)}`,
    );
    pDeliveryEl.setAttribute("data-testid", "inspector-publish-delivery");
    publish.appendChild(pDeliveryEl);
  }

  // Preview button — start/stop via the existing PreviewService (Steps 15E §9).
  const previewRow = el("div", "inspector-preview-row");
  const previewing = app.previewSampleId === selected.sampleId;
  const pbtn = button(
    previewing ? "preview-btn-pause" : "preview-btn",
    previewing ? "■ Stop" : "▶ Preview",
  );
  pbtn.setAttribute("data-testid", "inspector-preview-toggle");
  pbtn.onclick = () => void app.togglePreview(selected);
  previewRow.appendChild(pbtn);
  if (app.previewError) {
    previewRow.appendChild(el("div", "preview-error", app.previewError));
  }

  // Step 16L Phase 5: Find Similar — reuse the existing similarity-v1 engine.
  const similarRow = el("div", "inspector-similar-row");
  const sbtn = button("similar-btn", "Find Similar");
  sbtn.setAttribute("data-testid", "inspector-find-similar");
  sbtn.onclick = () => void app.findSimilarForSelected();
  similarRow.appendChild(sbtn);

  const appendList: HTMLElement[] = [
    name,
    meta,
    cls,
    tags,
    musical,
    community,
    posEl,
  ];
  if (publish) appendList.push(publish);
  appendList.push(previewRow, similarRow);
  wrap.append(...appendList);
  return wrap;
}

/**
 * Step 16L Phase 2: render the canonical GLOBAL inspection for a global-only
 * point. Shows content identity, classification, confidence, origin, and audio
 * features WITHOUT running the local analysis pipeline. A "Hydrate" action
 * persists it into the local index (bounded, idempotent).
 */
function renderGlobalInspection(wrap: HTMLElement, app: SampleMapApp): void {
  const insp = app.globalInspection!;
  const g = insp.analysis as unknown as
    | import("../global/contract").GlobalAnalysisResult
    | undefined;

  const name = el("div", "inspector-name", insp.sampleId);
  name.setAttribute("data-testid", "inspector-name");

  const originEl = el("div", "inspector-origin", "Origin: global (canonical analysis)");

  if (insp.error === "unknown") {
    wrap.append(name, originEl, el("div", "inspector-empty", "Global: unknown content (no analysis found)."));
    return;
  }
  if (insp.error === "unavailable") {
    wrap.append(name, originEl, el("div", "inspector-empty", "Global: unavailable (could not load analysis)."));
    return;
  }
  if (insp.error === "incompatible") {
    wrap.append(name, originEl, el("div", "inspector-position", "Global: analysis exists but has an incompatible version (shown read-only)."));
  }
  if (!g) {
    wrap.append(name, originEl);
    return;
  }

  const cls = el("div", "inspector-classification");
  cls.appendChild(el("h4", undefined, "Classification"));
  cls.appendChild(el("div", "inspector-class-primary", g.primaryClass));
  cls.appendChild(
    el("div", undefined, `Confidence: ${g.confidence.toFixed(3)}`),
  );
  const sec = g.secondaryClasses
    .map((c) => `${c.class} (${c.confidence.toFixed(2)})`)
    .join(", ");
  cls.appendChild(el("div", undefined, `Secondary: ${sec || "none"}`));
  // §20.3/§20.5 — the estimate disclaimer applies to every classification
  // rendered in the inspector, including the canonical global inspection.
  cls.appendChild(
    el(
      "div",
      "inspector-classification-note",
      "Classification is an estimate, not a ground truth.",
    ),
  );

  const identityEl = el("div", "inspector-position");
  identityEl.appendChild(el("h4", undefined, "Content Identity"));
  identityEl.appendChild(
    el(
      "div",
      undefined,
      `version:${g.contentIdentity.contentHashVersion} / ${g.contentIdentity.contentHash.slice(0, 12)}…`,
    ),
  );
  identityEl.appendChild(
    el("div", undefined, `Analysis version: ${g.analysisVersion}`),
  );
  identityEl.appendChild(
    el("div", undefined, `Map position: X ${g.map.x.toFixed(3)}  Y ${g.map.y.toFixed(3)}`),
  );

  const similarRow = el("div", "inspector-similar-row");
  const hydrateBtn = button("hydrate-btn", "Hydrate Locally");
  hydrateBtn.setAttribute("data-testid", "inspector-hydrate");
  hydrateBtn.onclick = () => {
    void app.hydrateGlobalSample(insp.point, g);
  };
  similarRow.appendChild(hydrateBtn);

  wrap.append(name, originEl, cls, identityEl, similarRow);
}

function renderSendPanel(app: SampleMapApp): HTMLElement {
  const st: MachinisteState = app.machiniste;
  const wrap = section("Send to Machiniste");

  const idInput = el("input") as HTMLInputElement;
  idInput.type = "text";
  idInput.placeholder = "Machiniste id";
  idInput.setAttribute("aria-label", "Machiniste id");
  idInput.setAttribute("data-testid", "machiniste-id");

  const slotStart = el("input") as HTMLInputElement;
  slotStart.type = "number";
  slotStart.min = "0";
  slotStart.value = "0";
  slotStart.setAttribute("aria-label", "Starting slot");
  slotStart.title = "Slots are numbered upward from this value";
  slotStart.setAttribute("data-testid", "machiniste-slot-start");

  const send = button("send-btn", `Send (max ${MAX_BATCH_SLOTS})`);
  send.setAttribute("data-testid", "machiniste-send");
  send.onclick = () =>
    void app.sendToMachiniste(idInput.value.trim(), Number(slotStart.value) || 0);

  const hint = el("div", "send-hint", SEND_PANEL_HINT);

  const status = el("div", "send-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  if (st.error) {
    status.className = "send-error";
    status.textContent = st.error;
  } else if (st.lastResult) {
    status.className = "send-ok";
    status.textContent = machinisteResultLabel(app);
  } else {
    status.textContent =
      st.pendingSamples.length > 0
        ? `Selected: ${st.pendingSamples.join(", ")}`
        : "Select samples above to send.";
  }

  const row = el("div", "send-row");
  row.append(idInput, slotStart, send);
  wrap.append(row, hint, status);
  return wrap;
}

/**
 * Build a `SampleMapApp` wired to re-render `root` on every state change and
 * mount it. Returns the controller (for the browser bootstrap).
 */
export function mountSampleMap(
  root: HTMLElement,
  deps: Omit<import("./app").SampleMapAppDeps, "onChange">,
): SampleMapApp {
  const app = new SampleMapApp({
    ...deps,
    onChange: () => renderApp(root, app),
  });

  // Global shell shortcuts (spec §17.1 / §18):
  //  - Esc           clear the batch selection (never search/filters) + close drawers
  //  - Cmd/Ctrl+F    focus the global search
  //  - Cmd/Ctrl+0    reset the map camera
  //  - Arrows        E-P5A T4: move the single FOCUS (focusedSampleId) between
  //                  map points, ONLY while the map application region itself
  //                  has keyboard focus (the SVG carries tabindex="0" /
  //                  role="application"). Inputs/selects/textareas are never
  //                  touched; focus never becomes selection; page scrolling
  //                  elsewhere is unaffected (a11y §A15).
  const onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;

    if (e.key === "Escape") {
      // STEP19A E-P7: while the one-time consent dialog is up, Escape performs
      // Cancel (drop the guarded send) and must NOT clear the selection.
      if (app.ep7ConsentRequired) {
        app.denyEp7Consent();
        return;
      }
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        (target as HTMLInputElement).blur();
      }
      toggleShellClass(root, "filter-open", false);
      toggleShellClass(root, "inspector-open", false);
      app.clearSelection();
      return;
    }

    // Global shortcuts (Cmd+F / Cmd+0) work even while typing; arrow-key point
    // navigation never runs from within INPUT/SELECT/TEXTAREA (E-P5A T4).
    if (e.metaKey || e.ctrlKey) {
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        const search = root.querySelector<HTMLInputElement>(
          "[data-testid='search-text']",
        );
        search?.focus();
        search?.select();
      } else if (e.key === "0") {
        e.preventDefault();
        app.resetMapView();
      }
      return;
    }

    if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
      return;
    }
    if (target && target.closest(".sample-map-svg")) {
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        app.focusAdjacent(-1);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        app.focusAdjacent(1);
        return;
      }
    }
  };
  document.addEventListener("keydown", onKeyDown);
  mountedKeydownDisposers.set(app, () => {
    document.removeEventListener("keydown", onKeyDown);
  });

  renderApp(root, app);
  return app;
}

/**
 * Per-instance keydown cleanup registry (BUG #4 / STEP16V). Kept in a WeakMap
 * so a disposed app can always remove exactly ITS document-level handler —
 * re-mounting / re-booting must never leave old global keyboard handlers alive
 * (a stale app could otherwise re-render its own root on arrow/Escape).
 */
const mountedKeydownDisposers = new WeakMap<SampleMapApp, () => void>();

/**
 * Tear down a mounted SampleMap app: removes its global keyboard handler and
 * releases its runtime resources (global refresh timer + preview). After this,
 * the app can no longer react to shell shortcuts or re-render its root.
 */
export function disposeSampleMap(app: SampleMapApp): void {
  mountedKeydownDisposers.get(app)?.();
  mountedKeydownDisposers.delete(app);
  app.dispose();
}
