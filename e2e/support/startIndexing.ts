import { expect, type Page } from "@playwright/test";

/**
 * STEP86 — start indexing from Advanced.
 *
 * The first-use overlay on the primary map is INFORMATION only: indexing runs
 * automatically, so it no longer offers a "start scanning" button. The manual
 * `Start Scan` control still exists under Advanced, and e2e specs that need a
 * deterministic trigger open it from there.
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
