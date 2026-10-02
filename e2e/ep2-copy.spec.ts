import { test, expect, type Page } from "@playwright/test";
import { startIndexing } from "./support/startIndexing";

/**
 * STEP16R E-P2 — Copy + labels verification against the OFFLINE harness
 * (harness.html). Same composition contract as step16m.spec.ts: only
 * scan/analysis map the REAL pipeline once, then shell copy is asserted.
 *
 * Covered (spec E-P2 required checks):
 *   - canonical empty/search strings remain unchanged (first-use title,
 *     results-empty, map no-match)
 *   - Missing-V2 inspector renders exactly `Map position unavailable`
 *   - analysis status labels are final English product copy (no German/dev
 *     strings anywhere in the body)
 *   - corner labels (STEP37): Noisy · Dark / Tonal · Dark / Noisy · Bright /
 *     Tonal · Bright, Title Case, X-Pole · Y-Pole
 *   - data-testids unchanged (the suite asserts them implicitly)
 */

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("STEP16R E-P2 copy + labels (shared page)", () => {
  test("EP2-01 Canonical copy, English analysis labels, axes, Missing-V2", async () => {
    await loadSm(page);

    // First-use overlay: canonical title + CTA unchanged.
    const overlay = page.locator("[data-testid='first-use']");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator(".first-use-title")).toHaveText(
      "No analyzed samples yet.",
    );
    // STEP86/STEP93: the first-use overlay is information only — no scan CTA;
    // indexing is manual, so it points at Advanced -> Start Scan.
    await expect(overlay.locator("[data-testid='first-use-index']")).toHaveCount(0);
    await expect(overlay.locator(".first-use-sub")).toContainText(
      "Use Start Scan under Advanced",
    );

    // Index the fixture set once (real scan/decode/analysis).
    await startIndexing(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", {
      timeout: 20_000,
    });
    await page.evaluate((b) => (window as any).__sm.analyze(b), 10);
    await expect(page.locator(".analysis-status")).toContainText(/Stopped|Idle/, {
      timeout: 30_000,
    });
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());

    // Four-corner labels (STEP37): every corner carries X pole first, Y pole
// second, one terminology + capitalization ("Noisy"/"Tonal"/"Dark"/"Bright").
// Prefix regexes because each label element also carries its native `<title>`
// hint (textContent concatenates both).
const axis = page.locator(".sample-map-svg .map-axis");
await expect(axis).toHaveText([
  /^Noisy · Dark/,
  /^Tonal · Dark/,
  /^Noisy · Bright/,
  /^Tonal · Bright/,
]);
const axisHints = await axis.locator("title").allTextContents();
expect(axisHints).toEqual([
  "Noisy · Dark (left, bottom)",
  "Tonal · Dark (right, bottom)",
  "Noisy · Bright (left, top)",
  "Tonal · Bright (right, top)",
]);
await expect(page.locator("[data-testid='sample-map']")).toHaveAttribute(
  "aria-label",
  "Sample map: noisy to the left, tonal to the right; dark at the bottom, bright at the top",
);
await page.screenshot({
    path: "e2e/artifacts/ep2-01-pointcloud.png",
    fullPage: true,
  });

  // Layout: no horizontal overflow and no clipped audit-surface labels.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // No German/dev strings leaked into the product copy anywhere.
  const germanOnly = /(Analysiert|Fehler|Verbleibend)/;
  expect((await page.locator("body").innerText()).match(germanOnly)).toBeNull();

    // Analysis progress labels: final English product copy.
    await expect(page.locator(".analysis-analyzed")).toContainText("Analyzed:");
    await expect(page.locator(".analysis-failed")).toContainText("Failed:");
    await expect(page.locator(".analysis-remaining")).toContainText("Remaining:");
    await expect(page.locator("body")).not.toContainText("Analysiert");
    await expect(page.locator("body")).not.toContainText("Fehler");
    await expect(page.locator("body")).not.toContainText("Verbleibend");

    // Missing-V2 inspector renders the exact canonical position string
    // (record keeps status "analyzed" but loses its persisted position).
    await page.evaluate(async () => {
      const sm = window as any;
      const id = "samples/lead-ohm";
      const rec = await sm.__sm.index.get(id);
      const stripped = { ...rec, mapPosition: undefined };
      await sm.__sm.index.put(stripped);
      await sm.__sm.app.refreshSearch();
      sm.__sm.app.selectSample(stripped);
    });
    const posLine = page.locator(".inspector-position");
    await expect(posLine).toContainText("Map position unavailable");
    await expect(posLine).not.toContainText("X:");
    await page.screenshot({
      path: "e2e/artifacts/ep2-02-missing-v2-inspector.png",
      fullPage: true,
    });

    // Canonical no-match copy: results list + map in parallel.
    const search = page.locator("[data-testid='search-text']");
    await search.fill("zzz-no-such-sample");
    await expect(page.locator("[data-testid='results-empty']")).toHaveText(
      "No samples match your filters.",
    );
    await expect(page.locator("[data-testid='map-empty']")).toHaveText(
      "No samples match your search.",
    );
    await search.fill("");
  });
});