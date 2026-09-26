import { test, expect, type Page } from "@playwright/test";

/**
 * STEP16R E-P5A — Presentation + a11y coverage against the OFFLINE harness
 * (harness.html). Same composition contract as step16m.spec.ts: scan/analysis
 * map the REAL pipeline once, then the presentation/a11y surface is asserted.
 *
 * Covered (spec E-P5A T2/T3/T4 required checks):
 *   T2  §20.3 classification disclaimer in the inspector + §7.4 position help
 *       note in the map tooltip
 *   T3  polite live/status semantics on scan-status, analysis-status and
 *       action-status; the existing send-status region is preserved
 *   T4  arrow-key point navigation: moves focusedSampleId only, never touches
 *       selection, never interferes with INPUT/SELECT/TEXTAREA, and preserves
 *       Esc / Cmd+F / Cmd+0
 */

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const resultIds = (p: Page) =>
  p.evaluate(() =>
    (window as any).__sm.app.results.map((r: any) => r.record.sampleId),
  );

const KICK = "samples/kick-909";
const LEAD = "samples/lead-ohm";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("STEP16R E-P5A presentation + a11y (shared page)", () => {
  test("EP5A-01 Disclaimer copy: inspector classification note + map tooltip note", async () => {
    await loadSm(page);

    // Index + analyze the fixture set once.
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

    // T2 inspector: §20.3 classification disclaimer after the classification
    // block, never merged into the tags section (INV-2). Focus is set through
    // the harness (the fixture kick point maps to the exact bottom-right
    // corner pixel of the SVG and is not clickable at default zoom).
    await page.evaluate((id) => (window as any).__sm.selectSample(id), LEAD);
    await expect(page.locator(".inspector-name")).toHaveText("Synth Lead");
    const note = page.locator(".inspector-classification-note");
    await expect(note).toBeVisible();
    await expect(note).toHaveText(
      "Classification is an estimate, not a ground truth.",
    );
    await expect(page.locator(".inspector-class-primary")).toHaveText("guitar");
    await expect(page.locator(".inspector-classification-note").locator(".."))
      .toContainText("Classification");
    await expect(page.locator(".inspector-tags")).toContainText("synth");
    expect(
      await page
        .locator(".inspector-tags")
        .textContent(),
    ).not.toContain("estimate");

    // T2 tooltip: §7.4 position help note (lead is interior enough to hover).
    const loc = page.locator(`[data-testid='map-point-${LEAD}']`);
    const box = await loc.boundingBox();
    if (!box) throw new Error("point not rendered");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const tip = page.locator("[data-testid='map-tooltip']");
    await expect(tip).toBeVisible();
    await expect(tip.locator(".map-tooltip-note")).toHaveText(
      "Position is an impression of timbre, not a precise acoustic measurement.",
    );
    await expect(tip.locator(".map-tooltip-class")).toContainText("guitar");
    await page.screenshot({
      path: "e2e/artifacts/ep5a-01-disclaimer-copy.png",
      fullPage: true,
    });
  });

  test("EP5A-02 Live/status regions get polite semantics; send-status preserved", async () => {
    for (const sel of [".scan-status", ".analysis-status", ".action-status"]) {
      const el = page.locator(sel).first();
      await expect(el).toHaveAttribute("role", "status");
      await expect(el).toHaveAttribute("aria-live", "polite");
    }
    // The pre-existing Send-status live region is preserved (role+aria-live).
    const sendStatus = page.locator(".send-status");
    await expect(sendStatus).toHaveAttribute("role", "status");
    await expect(sendStatus).toHaveAttribute("aria-live", "polite");

    // The map is a focusable application region with its accessibility label.
    const map = page.locator("[data-testid='sample-map']");
    await expect(map).toHaveAttribute("role", "application");
    await expect(map).toHaveAttribute("tabindex", "0");
    expect(await map.getAttribute("aria-label")).toContain("noisy");
  });

  test("EP5A-03 Arrow keys move focus only, never selection; inputs are untouched", async () => {
    // Clear any lingering focus state deterministically.
    await page.evaluate(() => (window as any).__sm.app.clearSelection());
    await page.evaluate(() => (window as any).__sm.app.selectSample(undefined));

    const order = await resultIds(page);
    expect(order).toHaveLength(4);
    const start = order[0];
    const second = order[1];
    const last = order[order.length - 1];

    // A Cmd/Ctrl-click selection is set FIRST so we can prove arrows never
    // modify it.
    await page.evaluate(
      async (ids) => {
        for (const id of ids) {
          const rec = await (window as any).__sm.index.get(id);
          (window as any).__sm.app.toggleMultiSelect(rec);
        }
      },
      [KICK, LEAD],
    );
    const selectionBefore = await page.evaluate(
      () => (window as any).__sm.app.selectedSampleIds,
    );
    expect(selectionBefore).toEqual([KICK, LEAD]);

    // Focus the map application region; ArrowRight enters at the first result.
    const map = page.locator("[data-testid='sample-map']");
    await map.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => page.evaluate(() => (window as any).__sm.app.focusedSampleId))
      .toBe(start);
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => page.evaluate(() => (window as any).__sm.app.focusedSampleId))
      .toBe(second);
    // ArrowLeft returns to the previous point, never wrapping oddly at a
    // single step from the entry.
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() => page.evaluate(() => (window as any).__sm.app.focusedSampleId))
      .toBe(start);
    // A backward arrow with no focus starts at the last result.
    await page.evaluate(() => (window as any).__sm.app.selectSample(undefined));
    await map.focus();
    await page.keyboard.press("ArrowUp");
    await expect
      .poll(() => page.evaluate(() => (window as any).__sm.app.focusedSampleId))
      .toBe(last);

    // Focus is reflected in the inspector but selection is untouched.
    expect(
      await page.evaluate(() => (window as any).__sm.app.selectedSampleIds),
    ).toEqual(selectionBefore);
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText(
      "2 / 8",
    );

    // INPUT guard: arrows typed in the global search never move map focus.
    await page.evaluate(() => (window as any).__sm.app.selectSample(undefined));
    await page.locator("[data-testid='search-text']").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    expect(
      await page.locator("[data-testid='search-text']").evaluate((el) => el === document.activeElement),
    ).toBe(true);
    expect(
      await page.evaluate(() => (window as any).__sm.app.focusedSampleId),
    ).toBeNull();
    await page.locator("[data-testid='search-text']").fill("");
  });

  test("EP5A-04 Frozen keys preserved: Esc, Cmd+F, Cmd+0", async () => {
    await page.evaluate(() => (window as any).__sm.app.selectSample(undefined));
    await page.evaluate(() => (window as any).__sm.app.clearSelection());

    // Cmd+F focuses the global search.
    await page.keyboard.press("Meta+f");
    expect(
      await page.locator("[data-testid='search-text']").evaluate((el) => el === document.activeElement),
    ).toBe(true);

    // Cmd+0 resets the map camera.
    await page.evaluate(() => (window as any).__sm.app.zoomMapBy(2));
    expect(
      await page.evaluate(() => (window as any).__sm.app.mapCamera.zoom),
    ).toBeGreaterThan(1);
    await page.keyboard.press("Meta+0");
    expect(
      await page.evaluate(() => (window as any).__sm.app.mapCamera),
    ).toEqual({ zoom: 1, panX: 0, panY: 0 });

    // Esc clears selection but never search/filters.
    await page.locator("[data-testid='search-text']").fill("zzz");
    await page.evaluate(
      async (id) => {
        const rec = await (window as any).__sm.index.get(id);
        (window as any).__sm.app.toggleMultiSelect(rec);
      },
      KICK,
    );
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText("1 / 8");
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(() => (window as any).__sm.app.selectedSampleIds),
    ).toEqual([]);
    expect(
      await page.evaluate(() => (window as any).__sm.app.searchState.text),
    ).toBe("zzz");
    // Cleanup: nothing masked by the leftover search term.
    await page.locator("[data-testid='search-clear-value']").click();
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);

    // Arrows anywhere OUTSIDE the map region are inert for point navigation.
    await page.evaluate(() => (window as any).__sm.app.selectSample(undefined));
    await page.locator("[data-testid='map-zoom-reset']").focus();
    await page.keyboard.press("ArrowRight");
    expect(
      await page.evaluate(() => (window as any).__sm.app.focusedSampleId),
    ).toBeNull();
  });
});