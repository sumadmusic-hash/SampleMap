import { test, expect, type Page } from "@playwright/test";
import { startIndexing } from "./support/startIndexing";

/**
 * STEP16R E-P4 — Structured filters against the OFFLINE harness
 * (harness.html). Same composition contract as step16m.spec.ts: only
 * scan/analysis map the REAL pipeline once, then the structured-filter surface
 * is asserted.
 *
 * Covered (spec E-P4 required checks):
 *   - grouped native class selector (All + groups + 22 classes under optgroups)
 *   - active-filter indicator + summary (E-P4.2 / §13.5)
 *   - the single Clear-filters action (E-P4.3)
 *   - confidence control: accessible name, displayed value == actual value
 *   - sort: exactly Relevance/Confidence/Name/Analyzed At, order only
 *   - filtering never repositions map points
 *   - selection survives filtering that hides it; focus is never turned into
 *     selection
 *   - canonical empty states stay distinguishable
 *   - accessible names; no German/dev strings; no overflow/clipping
 */

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

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

const clickMapPoint = async (p: Page, id: string) => {
  const loc = p.locator(`[data-testid='map-point-${id}']`);
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`point not rendered: ${id}`);
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

const positionsOf = (p: Page, ids: string[]) =>
  p.evaluate((sampleIds) => {
    const out: Record<string, [string, string]> = {};
    for (const id of sampleIds) {
      const el = document.querySelector(`[data-testid='map-point-${id}']`);
      out[id] = el
        ? [el.getAttribute("cx")!, el.getAttribute("cy")!]
        : ["gone", "gone"];
    }
    return out;
  }, ids);

const resultIds = (p: Page) =>
  p.evaluate(() =>
    (window as any).__sm.app.results.map((r: any) => r.record.sampleId),
  );

const KICK = "samples/kick-909";
const LEAD = "samples/lead-ohm";
const HAT = "samples/hat-airy";
const BASS = "samples/bass-sub";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("STEP16R E-P4 structured filters (shared page)", () => {
  test("EP4-01 Grouped class selector + active state + stable map positions", async () => {
    await loadSm(page);

    // Index + analyze the fixture set once.
    await startIndexing(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", {
      timeout: 20_000,
    });
    await page.evaluate((b) => (window as any).__sm.analyze(b), 10);
    await expect(page.locator(".analysis-status")).toContainText(/Stopped|Idle/, {
      timeout: 30_000,
    });
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);

    const classSel = page.locator("[data-testid='filter-class']");
    const allIds = [LEAD, KICK, HAT, BASS];
    const allPosBefore = await positionsOf(page, allIds);
    expect(Object.values(allPosBefore).every((p) => p[0] !== "gone")).toBe(true);

    // Native grouped selector: a <select> with three optgroups covering the
    // exact 22 classes (8/8/6) + All + group-token options.
    expect(await classSel.evaluate((el) => el.tagName)).toBe("SELECT");
    await expect(classSel.locator("optgroup")).toHaveCount(3);
    const groupLabels = await classSel
      .locator("optgroup")
      .evaluateAll((els) => els.map((e) => (e as HTMLOptGroupElement).label));
    expect(groupLabels).toEqual(["Drums", "Musical", "Other"]);
    const sizes = await classSel
      .locator("optgroup")
      .evaluateAll((els) => els.map((e) => e.querySelectorAll("option").length));
    expect(sizes).toEqual([8, 8, 6]);
    const classOptions = await classSel.locator("optgroup option").allTextContents();
    expect(classOptions).toHaveLength(22);
    await expect(classSel.locator("option")).toHaveText([
      "All",
      "Drums (all)",
      "Musical (all)",
      "Other (all)",
      ...classOptions,
    ]);

    // Selecting a class filters the result set + map, positions stay stable.
    await classSel.selectOption("kick");
    await expect(page.locator(`[data-testid='result-${KICK}']`)).toBeVisible();
    const kickCount = (await resultIds(page)).length;
    expect(kickCount).toBeGreaterThan(0);
    await expect(page.locator("[data-testid='result-count']")).toContainText(
      `${kickCount} ${kickCount === 1 ? "sample" : "samples"}`,
    );
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(kickCount);
    await expect(page.locator("[data-testid='action-status']")).toContainText("Filtered:");
    expect(await positionsOf(page, [KICK])).toEqual({
      [KICK]: allPosBefore[KICK],
    });
    await expect(classSel).toHaveValue("kick");

    // Active state is obvious: heading badge + summary line + enabled Clear.
    await expect(page.locator(".filter-active-badge")).toContainText("1 active");
    await expect(page.locator(".active-filter-summary")).toHaveText("Class: kick");
    const clear = page.locator("[data-testid='search-clear']");
    await expect(clear).toBeEnabled();
    await expect(clear).toHaveText("Clear filters");

    // Group token filters through the existing SearchEngine group expansion.
    await classSel.selectOption("drums");
    await expect(page.locator(".active-filter-summary")).toHaveText("Group: Drums");
    expect(await page.locator("[data-testid^='map-point-']").count()).toBeGreaterThanOrEqual(1);
    await page.screenshot({
      path: "e2e/artifacts/ep4-01-grouped-class-filter.png",
      fullPage: true,
    });

    // Clear restores the full set; badge + summary disappear; Clear disables.
    await clear.click();
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
    await expect(page.locator(".filter-active-badge")).toHaveCount(0);
    await expect(page.locator(".active-filter-summary")).toHaveCount(0);
    await expect(clear).toBeDisabled();
  });

  test("EP4-02 Confidence control + sort order-only + empty states", async () => {
    // Confidence: accessible label; displayed value equals the actual value.
    const conf = page.locator("[data-testid='filter-confidence']");
    await expect(page.locator("label[for='confidence-filter']")).toHaveText("Min confidence");
    const fixtureConfidences = await page.evaluate(
      async ({ ids }) =>
        Promise.all(
          ids.map(async (id) => {
            const rec = await (window as any).__sm.index.get(id);
            return rec ? rec.confidence : -1;
          }),
        ),
      { ids: [LEAD, KICK, HAT, BASS] },
    );
    const maxC = Math.max(...fixtureConfidences);
    const minC = Math.min(...fixtureConfidences);
    expect(minC).toBeGreaterThanOrEqual(0);
    expect(maxC).toBeLessThanOrEqual(1);

    // A threshold above the fixture max must empty the map (inclusive filter).
    const spread = 0.05;
    const hiLim = Math.min(1, Math.ceil(maxC * 20) / 20 + spread);
    await conf.fill(String(hiLim));
    await expect(conf).toHaveValue(String(hiLim));
    await expect
      .poll(() => page.evaluate(() => (window as any).__sm.app.searchState.minConfidence))
      .toBe(hiLim);
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(0);
    await expect(page.locator(".active-filter-summary")).toContainText(
      `Confidence ≥ ${hiLim}`,
    );

    // A threshold below the fixture min keeps every sample on the map.
    const loLim = Math.max(0.05, Math.floor(minC * 20) / 20 - spread);
    await conf.fill(String(loLim));
    await expect
      .poll(() => page.evaluate(() => (window as any).__sm.app.searchState.minConfidence))
      .toBe(loLim);
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
    await expect(page.locator(".active-filter-summary")).toContainText(
      `Confidence ≥ ${loLim}`,
    );

    // Release the confidence criterion before sorting (clean 4-result set).
    await conf.fill("");
    await expect
      .poll(() => page.evaluate(() => (window as any).__sm.app.searchState.minConfidence))
      .toBe(undefined);
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
    await expect(page.locator("[data-testid='result-count']")).toHaveText("4 samples");

    // Sort: exactly the four modes; changes order only, positions stay put.
    const allIds = [LEAD, KICK, HAT, BASS];
    const positionsBase = await positionsOf(page, allIds);
    const sortSel = page.locator("[data-testid='filter-sort']");
    await expect(page.locator("label[for='sort-filter']")).toHaveText("Sort");
    await expect(sortSel.locator("option")).toHaveText([
      "Relevance",
      "Confidence",
      "Name",
      "Analyzed At",
    ]);
    const orderings = new Set<string>();
    for (const mode of ["relevance", "confidence", "name", "analyzedAt"]) {
      await sortSel.selectOption(mode);
      await expect
        .poll(() => page.evaluate((m) => (window as any).__sm.app.searchState.sortBy, mode))
        .toBe(mode);
      await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
      const ids = await resultIds(page);
      expect(ids).toHaveLength(4);
      orderings.add(String(ids));
      expect(await positionsOf(page, allIds)).toEqual(positionsBase);
    }
    expect(orderings.size).toBeGreaterThanOrEqual(2);

    // Search-empty vs filter-empty stay distinguishable (canonical copy).
    await page.locator("[data-testid='search-text']").fill("zzz-no-such-sample");
    await expect(page.locator("[data-testid='map-empty']")).toHaveText(
      "No samples match your search.",
    );
    await expect(page.locator("[data-testid='results-empty']")).toHaveText(
      "No samples match your filters.",
    );
    await page.locator("[data-testid='search-clear-value']").click();

    // A structured class filter with no match keeps the same distinguishable pair.
    await page.locator("[data-testid='filter-class']").selectOption("fx");
    await expect(page.locator("[data-testid='results-empty']")).toHaveText(
      "No samples match your filters.",
    );
    await expect(page.locator("[data-testid='map-empty']")).toHaveText(
      "No samples match your search.",
    );
    await page.screenshot({
      path: "e2e/artifacts/ep4-02-filter-empty.png",
      fullPage: true,
    });
    // The single clear action restores the unfiltered set.
    await page.locator("[data-testid='search-clear']").click();
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
  });

  test("EP4-03 Selection/focus survive filtering + a11y + layout", async () => {
    const clear = page.locator("[data-testid='search-clear']");

    // Select kick + lead (2/8) and focus lead (focus ≠ selection).
    await toggleSelect(page, [LEAD, KICK]);
    await clickMapPoint(page, LEAD);
    await expect(page.locator(".inspector-name")).toHaveText("Synth Lead");
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText("2 / 8");
    expect(
      await page.evaluate(() => (window as any).__sm.app.focusedSampleId),
    ).toBe(LEAD);

    // Apply a filter that hides the focused AND selected lead sample.
    await page.locator("[data-testid='filter-class']").selectOption("kick");
    await expect(page.locator(`[data-testid='map-point-${LEAD}']`)).toHaveCount(0);
    await expect(page.locator(`[data-testid='map-point-${KICK}']`)).toHaveAttribute(
      "class",
      /map-point-in-selection/,
    );
    // Selection remains active (count + ids) even though the sample is hidden.
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText("2 / 8");
    expect(
      await page.evaluate(() => (window as any).__sm.app.selectedSampleIds),
    ).toEqual([LEAD, KICK]);
    // Focus survives and is NOT converted into selection or cleared.
    expect(
      await page.evaluate(() => (window as any).__sm.app.focusedSampleId),
    ).toBe(LEAD);
    expect(
      await page.evaluate(() => (window as any).__sm.app.selectedSampleIds),
    ).toEqual([LEAD, KICK]);
    await page.screenshot({
      path: "e2e/artifacts/ep4-03-selection-filtered.png",
      fullPage: true,
    });

    // Clear → the hidden sample reappears, still selected.
    await clear.click();
    await expect(page.locator(`[data-testid='map-point-${LEAD}']`)).toHaveAttribute(
      "class",
      /map-point-in-selection/,
    );
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText("2 / 8");

    // Accessible names for the structured filter controls.
    await expect(page.locator("label[for='class-filter']")).toHaveText("Class");

    // No German/dev strings anywhere.
    const body = await page.locator("body").innerText();
    expect(body.match(/(Analysiert|Fehler|Verbleibend|DEBUG|TODO)/)).toBeNull();

    // Layout: structured filters fit the rail — no horizontal overflow/clipping.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const railBox = await page.locator(".filter-panel").boundingBox();
    expect(railBox).toBeTruthy();
    const boxes = await page.locator(".filter-field").evaluateAll((els) =>
      els.map((e) => e.getBoundingClientRect()),
    );
    expect(boxes.length).toBeGreaterThanOrEqual(3);
    const railLeft = railBox!.x;
    const railRight = railBox!.x + railBox!.width;
    for (const b of boxes) {
      expect(b.left).toBeGreaterThanOrEqual(railLeft - 1);
      expect(b.right).toBeLessThanOrEqual(railRight + 1);
    }
  });
});