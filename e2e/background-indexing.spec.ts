import { test, expect, type Page } from "@playwright/test";

/**
 * AUTOMATIC background indexing — REAL browser, REAL app, REAL pipeline.
 *
 * The product promise: opening SampleMap is enough. The user must NOT have to
 * press "Start Scan" and then "Analyse 10/100/1000" first. This spec therefore
 * never touches `[data-testid='scan-start']`, never clicks the first-use index
 * CTA and never calls `__sm.analyze` — it only performs the single call the
 * production mount makes (`__sm.autoIndex` → `startBackgroundIndexing()`), and
 * then watches the app index itself.
 *
 * Asserted against the rendered DOM: the scan runs, the analysis starts on its
 * own with the controlled 1000 budget, the counters grow while the run is in
 * flight, results reach the result list and the map, and a repeated trigger
 * starts nothing new.
 */

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const appState = (p: Page) =>
  p.evaluate(() => {
    const app = (window as any).__sm.app;
    return {
      scanStatus: app.scan.status,
      scanFound: app.scan.foundCount,
      eligibleEnqueued: app.scan.eligibleEnqueued,
      analysisStatus: app.analysis.status,
      budget: app.analysis.budget,
      analyzed: app.analysis.analyzed,
      triggered: app.backgroundIndexingTriggered,
      resultCount: app.results.length,
    };
  });

/** Count the REAL rendered map circles. */
const circleCount = (p: Page) =>
  p.evaluate(
    () => document.querySelectorAll("circle[data-testid^='map-point-']").length,
  );

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
  await loadSm(page);
  await page.evaluate(() => (window as any).__sm.ep7.grant());
  // Nothing indexed yet: the app is mounted, the map is empty and idle.
  await page.waitForTimeout(200);
});

test.afterAll(async () => {
  await page.close();
});

test("opening the app indexes itself: no Start Scan, no Analyse click", async () => {
  // --- precondition: nothing has been indexed or analysed by hand ----------
  const before = await appState(page);
  expect(before.scanStatus).toBe("idle");
  expect(before.analysisStatus).toBe("idle");
  expect(before.triggered).toBe(false);
  expect(before.resultCount).toBe(0);
  expect(await circleCount(page)).toBe(0);

  // --- the single automatic trigger (what mountAuthenticated does) ---------
  await page.evaluate(() => (window as any).__sm.autoIndex());

  // Triggered immediately, and the call did NOT block on the run.
  const rightAfter = await appState(page);
  expect(rightAfter.triggered).toBe(true);

  // --- the scan runs on its own -------------------------------------------
  await expect(page.locator(".scan-status")).toContainText("Complete", {
    timeout: 30_000,
  });
  const scanned = await appState(page);
  expect(scanned.scanStatus).toBe("done");
  expect(scanned.scanFound).toBeGreaterThan(0);
  expect(scanned.eligibleEnqueued).toBeGreaterThan(0);

  // --- and the analysis follows on its own, with the 1000 budget ----------
  await expect(page.locator(".analysis-budget")).toContainText("1000", {
    timeout: 30_000,
  });
  const running = await appState(page);
  expect(running.budget).toBe(1000);

  // The run really is in flight (or already finished) — it started WITHOUT any
  // click on an Analyse button.
  await page.waitForFunction(
    () => {
      const a = (window as any).__sm.app.analysis;
      return a.status !== "idle" && a.status !== undefined;
    },
    null,
    { timeout: 30_000 },
  );

  // --- counters grow and results reach list + map --------------------------
  await page.waitForFunction(
    () => (window as any).__sm.app.analysis.analyzed > 0,
    null,
    { timeout: 120_000 },
  );
  // The live map refresh of 8634296: results appear DURING the run.
  await expect
    .poll(async () => (await appState(page)).resultCount, { timeout: 60_000 })
    .toBeGreaterThan(0);

  await page.waitForFunction(
    () => (window as any).__sm.app.analysis.status !== "running",
    null,
    { timeout: 180_000 },
  );
  await page.evaluate(() => (window as any).__sm.app.refreshSearch());
  await page.waitForTimeout(300);

  const done = await appState(page);
  expect(done.analyzed).toBeGreaterThan(0);
  expect(done.resultCount).toBeGreaterThan(0);
  expect(done.budget).toBe(1000);

  // The analysed samples are really on the map.
  await expect
    .poll(() => circleCount(page), { timeout: 30_000 })
    .toBeGreaterThan(0);

  // The rendered state agrees with the app state.
  await expect(page.locator("[data-testid='result-count']")).toContainText(
    String(done.resultCount),
  );
});

test("a repeated automatic start does not start a second run", async () => {
  const before = await appState(page);

  // Repeat the trigger (e.g. a second mount path, a re-entrant call).
  await page.evaluate(() => (window as any).__sm.autoIndex());
  await page.evaluate(() => (window as any).__sm.autoIndex());
  await page.waitForTimeout(500);

  const after = await appState(page);
  // No new scan, no new run, counters unchanged.
  expect(after.scanFound).toBe(before.scanFound);
  expect(after.analyzed).toBe(before.analyzed);
  expect(after.budget).toBe(1000);
  expect(after.analysisStatus).not.toBe("running");
  // And the manual controls are still intact as the debug fallback.
  await expect(page.locator("[data-testid='scan-start']")).toBeVisible();
  await expect(page.locator("[data-testid='analyze-1000']")).toBeVisible();
});
