import { test, expect, type Page } from "@playwright/test";
import { startIndexing } from "./support/startIndexing";

/**
 * FINAL_UI_UX_DESIGN_SPEC v1.1 — Phase 1 (shell / action bar / first-use) e2e
 * against the OFFLINE harness (harness.html). Same composition contract as
 * step16m.spec.ts: only scan/analysis map the REAL pipeline once, then the
 * shell behaviors are driven through `window.__sm`.
 *
 * Covered here:
 *   §25 first-use overlay + indexing CTA
 *   §6/§18 persistent action bar (status left, selection pill + Add right)
 *   §17 focus-vs-selection: a plain click must NOT touch the selection pill
 *   §17.2 `map-point-in-selection` rendering independent of the focused point
 *   §18 action-bar Add -> app.sendToMachiniste (batch)
 *   §28.1 Esc clears selection only (search retained); ⌘/Ctrl+0 resets camera
 */
interface MachResult {
  committed: boolean;
  errors: string[];
  slots: Array<{ sampleId: string; applied: boolean; readBackMatches: boolean }>;
}

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const analyze = (p: Page, budget = 10) =>
  p.evaluate((b) => (window as any).__sm.analyze(b), budget);
const refreshResults = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.refreshSearch());
const toggleSelect = (p: Page, ids: string[]) =>
  p.evaluate(
    async (sampleIds) => {
      for (const id of sampleIds) {
        const rec = await (window as any).__sm.index.get(id);
        (window as any).__sm.app.toggleMultiSelect(rec);
      }
    },
    ids,
  );
const getMach = (p: Page): Promise<MachResult> =>
  p.evaluate(async () => {
    const m = (window as any).__sm.app.machiniste;
    const r = m.lastResult;
    return {
      committed: r?.committed ?? false,
      errors: [...(r?.errors ?? [])],
      slots: (r?.slots ?? []).map((s: Record<string, unknown>) => ({
        sampleId: String(s.sampleId ?? ""),
        applied: Boolean(s.applied),
        readBackMatches: Boolean(s.readBackMatches),
      })),
    };
  });

async function clickMapPoint(p: Page, id: string) {
  const loc = p.locator(`[data-testid='map-point-${id}']`);
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`point not rendered: ${id}`);
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("FINAL UI v1.1 Phase 1 shell (shared page)", () => {
  test("FP-01 First-use overlay + idle shell on a fresh index", async () => {
    await loadSm(page);

    // §25 overlay: canonical first-use copy + single indexing CTA.
    const overlay = page.locator("[data-testid='first-use']");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator(".first-use-title")).toHaveText(
      "No analyzed samples yet.",
    );
    await expect(overlay.locator(".first-use-sub")).toContainText(
      "explorable soundscape",
    );
    // STEP86: the first-use overlay is information only — no scan CTA.
    await expect(overlay.locator("[data-testid='first-use-index']")).toHaveCount(0);
    await expect(overlay.locator(".first-use-sub")).toContainText(
      "Indexing your library in the background",
    );

    // Action bar idle state: empty pill + disabled Add.
    const pill = page.locator("[data-testid='selection-pill']");
    await expect(pill).toHaveText("0 / 8");
    await expect(pill).toHaveAttribute("aria-label", "No samples selected");
    const add = page.locator("[data-testid='machiniste-add']");
    await expect(add).toBeDisabled();
    await expect(add).toHaveAttribute(
      "title",
      "Select at least one sample to add to Machiniste",
    );
    await expect(page.locator("[data-testid='action-status']")).toHaveText(
      "0 samples",
    );
  });

  test("FP-02 CTA runs the index; overlay gives way to the point cloud", async () => {
    // The first-use CTA triggers the real bounded library scan.
    await startIndexing(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", {
      timeout: 20_000,
    });
    await analyze(page, 10);
    await expect(page.locator(".analysis-status")).toContainText(/Stopped|Idle/, {
      timeout: 30_000,
    });
    await refreshResults(page);

    await expect(page.locator("[data-testid='first-use']")).toBeHidden();
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
    await expect(page.locator("[data-testid='action-status']")).toContainText(
      "4 samples",
    );
  });

  test("FP-03 A plain map click focuses but never touches the selection", async () => {
    await clickMapPoint(page, "samples/lead-ohm");

    // Inspector populated, batch selection still EMPTY (§17).
    await expect(page.locator(".inspector-name")).toHaveText("Synth Lead");
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText(
      "0 / 8",
    );
    await expect(page.locator("[data-testid='machiniste-add']")).toBeDisabled();
    // No point carries the batch-selection treatment (§17.2).
    await expect(
      page.locator("[data-testid^='map-point-'][class*='map-point-in-selection']"),
    ).toHaveCount(0);
  });

  test("FP-04 Selection surfaces in the pill + points; Add enables", async () => {
    await toggleSelect(page, ["samples/lead-ohm", "samples/kick-909"]);

    const pill = page.locator("[data-testid='selection-pill']");
    await expect(pill).toHaveText("2 / 8");
    await expect(pill).toHaveAttribute("title", "2 of 8 selected");
    await expect(pill).toHaveAttribute("aria-label", "2 of 8 selected");
    await expect(page.locator("[data-testid='machiniste-add']")).toBeEnabled();
    await expect(
      page.locator("[data-testid^='map-point-'][class*='map-point-in-selection']"),
    ).toHaveCount(2);
  });

  test("FP-05 Full selection (4/4) counts up; counting never invents a cap text", async () => {
    await toggleSelect(page, ["samples/hat-airy", "samples/bass-sub"]);

    const pill = page.locator("[data-testid='selection-pill']");
    await expect(pill).toHaveText("4 / 8");
    await expect(pill).toHaveAttribute("title", "4 of 8 selected");
    await expect(
      page.locator("[data-testid^='map-point-'][class*='map-point-in-selection']"),
    ).toHaveCount(4);
    await expect(page.locator("[data-testid='machiniste-add']")).toBeEnabled();
    await page.screenshot({
      path: "e2e/artifacts/fp-action-bar-selected.png",
      fullPage: true,
    });
  });

  test("FP-06 Action-bar Add sends the batch to Machiniste", async () => {
    const machId = await page.evaluate(() => (window as any).__sm.machinisteId);
    // The inspector send panel provides the Machiniste id the action bar reuses.
    await page.locator("[data-testid='machiniste-id']").fill(machId);

    await page.locator("[data-testid='machiniste-add']").click();
    await expect(page.locator("[data-testid='action-status']")).toContainText(
      "Applied: 4",
      { timeout: 20_000 },
    );

    const res = await getMach(page);
    expect(res.errors).toEqual([]);
    expect(res.slots).toHaveLength(4);
    expect(res.slots.every((s) => s.applied && s.readBackMatches)).toBe(true);
    // Selection persists after a send (it is not silently cleared).
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText(
      "4 / 8",
    );
  });

  test("FP-07 Esc clears the selection but NEVER the search (spec §28.1)", async () => {
    // Type a search that narrows the set.
    const search = page.locator("[data-testid='search-text']");
    await search.click();
    await search.fill("kick");
    await expect(page.locator("[data-testid='action-status']")).toContainText(
      "Filtered: 1 sample",
      { timeout: 20_000 },
    );

    // Selection present BEFORE Esc.
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText(
      "4 / 8",
    );

    await page.keyboard.press("Escape");

    // Selection cleared; search text/side-effects retained.
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText(
      "0 / 8",
    );
    await expect(page.locator("[data-testid='machiniste-add']")).toBeDisabled();
    await expect(search).toHaveValue("kick");
    await expect(page.locator("[data-testid='action-status']")).toContainText(
      "Filtered: 1 sample",
    );
    await expect(
      page.locator("[data-testid^='map-point-'][class*='map-point-in-selection']"),
    ).toHaveCount(0);

    // The header clear (×) resets the search entirely: full point cloud back.
    await page.locator("[data-testid='search-clear-value']").click();
    await expect(page.locator("[data-testid='search-text']")).toHaveValue("");
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
  });

  test("FP-08 Cmd/Ctrl+0 resets the map camera", async () => {
    await page.evaluate(() =>
      (window as any).__sm.app.zoomMapBy(2, { x: 400, y: 300 }),
    );
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__sm.app.mapCamera.zoom),
      )
      .toBeGreaterThan(1.5);
    await page.keyboard.press("Meta+0");
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__sm.app.mapCamera.zoom),
      )
      .toBe(1);
  });
});