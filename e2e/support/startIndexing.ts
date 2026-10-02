import { expect, type Page } from "@playwright/test";

/**
 * STEP86 — start indexing from Advanced.
 *
 * The first-use overlay on the primary map is INFORMATION only. STEP93: the app
 * no longer indexes automatically on open, so specs trigger the manual
 * `Start Scan` control under Advanced for a deterministic run.
 */
export async function startIndexing(page: Page): Promise<void> {
  const details = page.locator("[data-testid='advanced-area']");
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.locator("[data-testid='advanced-summary']").click();
  }
  await page.locator("[data-testid='scan-start']").click();
  await expect(page.locator(".scan-status")).toContainText("Complete", {
    timeout: 20_000,
  });
}
