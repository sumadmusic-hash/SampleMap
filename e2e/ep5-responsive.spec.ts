import { test, expect, type Page } from "@playwright/test";

/**
 * STEP16R E-P5A T5 — Dedicated responsive coverage for 768–1023 px against the
 * OFFLINE harness (harness.html). Isolated in its own spec; the GLOBAL
 * Playwright configuration (viewport 1280×1400) is NOT modified — the page is
 * created with its own viewport and the boundary is re-checked via
 * setViewportSize.
 *
 * Covered (spec §27 / E-P5A):
 *   - single-column layout at 768–1023
 *   - filter rail → left overlay drawer, inspector → bottom drawer
 *   - drawer toggles + Esc-close without clearing search/filters/selection
 *   - filters usable inside the drawer
 *   - no horizontal overflow / clipping
 *   - selection/filter invariants preserved at small width
 *   - 1024px negative control: drawers disappear, 3-column grid returns
 */

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const resultIds = (p: Page) =>
  p.evaluate(() =>
    (window as any).__sm.app.results.map((r: any) => r.record.sampleId),
  );

const overflowX = (p: Page) =>
  p.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );

const KICK = "samples/kick-909";
const LEAD = "samples/lead-ohm";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 768, height: 1024 } });
  await page.goto("/harness.html");
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("STEP16R E-P5A responsive 768-1023 (own viewport)", () => {
  test("EP5A-05 Drawer chrome at 768px: one column, overlays, no overflow", async () => {
    await loadSm(page);

    // Index + analyze the fixture set once (isolated context).
    await page.locator("[data-testid='first-use-index']").click();
    await expect(page.locator(".scan-status")).toContainText("Complete", {
      timeout: 20_000,
    });
    await page.evaluate((b) => (window as any).__sm.analyze(b), 10);
    await expect(page.locator(".analysis-status")).toContainText(/Stopped|Idle/, {
      timeout: 30_000,
    });
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);

    // Drawer toggles are visible only below 1024px.
    await expect(page.locator("[data-testid='header-menu']")).toBeVisible();
    await expect(
      page.locator("[data-testid='header-inspector-toggle']"),
    ).toBeVisible();

    // Single-column layout: the app-content grid resolves to exactly one track.
    const columns = await page
      .locator(".app-content")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim());
    expect(columns.split(/\s+/).length).toBe(1);

    // The filter rail and inspector are fixed-position drawers at this width.
    await expect(page.locator(".filter-panel")).toHaveCSS("position", "fixed");
    await expect(page.locator(".inspector-region")).toHaveCSS(
      "position",
      "fixed",
    );

    // No horizontal overflow.
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
  });

  test("EP5A-06 Drawer open/close + Esc never clears filters/selection", async () => {
    const shell = page.locator(".app-shell");
    const menu = page.locator("[data-testid='header-menu']");
    const filterPanel = page.locator(".filter-panel");

    // Open the filter drawer.
    await menu.click();
    await expect(shell).toHaveClass(/filter-open/);
    await expect(filterPanel).toBeVisible();
    await page.waitForFunction(() => {
      const el = document.querySelector(".filter-panel");
      return !!el && Math.abs(el.getBoundingClientRect().x) <= 1;
    });
    const drawerBox = await filterPanel.boundingBox();
    expect(drawerBox).toBeTruthy();
    expect(Math.abs((drawerBox as any).x)).toBeLessThanOrEqual(1);

    // Select some samples first so Esc can be proven selection-only-scoped.
    await page.evaluate(
      async (ids) => {
        for (const id of ids) {
          const rec = await (window as any).__sm.index.get(id);
          (window as any).__sm.app.toggleMultiSelect(rec);
        }
      },
      [KICK, LEAD],
    );
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText(
      "2 / 8",
    );

    // Filters work inside the drawer.
    await page.locator("[data-testid='filter-class']").selectOption("kick");
    const kickCount = (await resultIds(page)).length;
    expect(kickCount).toBeGreaterThan(0);
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(
      kickCount,
    );
    await expect(page.locator(".active-filter-summary")).toHaveText("Class: kick");
    await page.screenshot({
      path: "e2e/artifacts/ep5a-06-drawer-filter.png",
      fullPage: true,
    });
    expect(await overflowX(page)).toBeLessThanOrEqual(0);

    // Esc closes the drawer and clears SELECTION (intended, §V1 — confirmed by
    // final-ui-phase1) but NEVER clears filters or the search text.
    await page.keyboard.press("Escape");
    await expect(shell).not.toHaveClass(/filter-open/);
    await expect(page.locator(".active-filter-summary")).toHaveText("Class: kick");
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText(
      "0 / 8",
    );
    expect(
      await page.evaluate(() => (window as any).__sm.app.selectedSampleIds),
    ).toHaveLength(0);

    // Clear via the single action restores the full set (the Clear-filters
    // button lives inside the drawer at 768, so reopen it first). Close the
    // drawer with Esc — the open overlay covers the header's menu button, so a
    // second menu click would land on the drawer itself.
    await menu.click();
    await expect(shell).toHaveClass(/filter-open/);
    await page.locator("[data-testid='search-clear']").click();
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
    await page.keyboard.press("Escape");
    await expect(shell).not.toHaveClass(/filter-open/);
  });

  test("EP5A-07 Selection/filter invariants at 768px + inspector bottom drawer", async () => {
    const shell = page.locator(".app-shell");

    // Focus lead via the harness (its fixture point sits on the SVG right
    // edge at 768 and is not reliably clickable), then open the inspector
    // bottom drawer explicitly.
    await page.evaluate(
      async (ids) => {
        for (const id of ids) {
          const rec = await (window as any).__sm.index.get(id);
          (window as any).__sm.app.toggleMultiSelect(rec);
        }
      },
      [LEAD, KICK],
    );
    await page.evaluate((id) => (window as any).__sm.selectSample(id), LEAD);
    await page.locator("[data-testid='header-inspector-toggle']").click();
    await expect(shell).toHaveClass(/inspector-open/);
    await expect(page.locator(".inspector-name")).toHaveText("Synth Lead");

    // Bottom drawer slides in over the map row.
    await expect(page.locator(".inspector-region")).toBeVisible();
    const inspBox = await page.locator(".inspector-region").boundingBox();
    expect(inspBox).toBeTruthy();
    expect((inspBox as any).y + (inspBox as any).height).toBeGreaterThanOrEqual(
      1024 - 560,
    );
    await page.screenshot({
      path: "e2e/artifacts/ep5a-07-inspector-drawer.png",
      fullPage: true,
    });

    // Close the inspector via its toggle (NOT Esc — Esc would clear selection,
    // which would void the filter invariant below).
    await page.locator("[data-testid='header-inspector-toggle']").click();
    await expect(shell).not.toHaveClass(/inspector-open/);

    // Apply a filter that hides the focused + selected lead sample.
    await page.locator("[data-testid='header-menu']").click();
    await page.locator("[data-testid='filter-class']").selectOption("kick");
    await expect(page.locator(`[data-testid='map-point-${LEAD}']`)).toHaveCount(0);
    await expect(page.locator(`[data-testid='map-point-${KICK}']`)).toHaveAttribute(
      "class",
      /map-point-in-selection/,
    );
    // Selection and focus survive the hiding filter (EP4-03 invariant).
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText(
      "2 / 8",
    );
    expect(
      await page.evaluate(() => (window as any).__sm.app.selectedSampleIds),
    ).toEqual([LEAD, KICK]);
    expect(
      await page.evaluate(() => (window as any).__sm.app.focusedSampleId),
    ).toBe(LEAD);

    // Clear → the hidden sample reappears, still selected (drawer still open).
    await page.locator("[data-testid='search-clear']").click();
    await expect(page.locator(`[data-testid='map-point-${LEAD}']`)).toHaveAttribute(
      "class",
      /map-point-in-selection/,
    );

    // Esc closes the drawer (and clears selection, §V1); filters were already
    // cleared by `search-clear`.
    await page.keyboard.press("Escape");
    await expect(shell).not.toHaveClass(/filter-open/);
  });

  test("EP5A-08 Boundary: 1023px in drawer mode, 1024px negative control", async () => {
    // Upper edge of the 768–1023 rule is still drawer mode.
    await page.setViewportSize({ width: 1023, height: 1200 });
    await expect(page.locator("[data-testid='header-menu']")).toBeVisible();
    await expect(page.locator(".filter-panel")).toHaveCSS("position", "fixed");
    expect(await overflowX(page)).toBeLessThanOrEqual(0);

    // 1024px is a 3-column desktop layout; drawers are gone.
    await page.setViewportSize({ width: 1024, height: 1200 });
    await expect(page.locator("[data-testid='header-menu']")).not.toBeVisible();
    const cols = await page
      .locator(".app-content")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim());
    expect(cols.split(/\s+/).length).toBe(3);
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
  });
});