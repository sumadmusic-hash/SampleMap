import { test, expect, type Page } from "@playwright/test";

/**
 * STEP16W — post-bug-hunt regression fixes (STEP16V BUG #1–#5).
 *
 * SW-01 (BUG #4)   After `publish.remount`, the DISPOSED app's global keydown
 *                  handler must be gone: Escape/arrow strokes act ONLY on the
 *                  live app and never mutate an app that was torn down (no
 *                  zombie re-render of a stale root).
 * SW-02 (BUG #2)   The checkbox DOM always agrees with `selectedSampleIds`
 *                  (the "checkbox never lies" contract; the 8→9 cap itself is
 *                  enforced at controller level — see app.test.ts — because the
 *                  harness fixture only has 4 real map samples, and injecting
 *                  more would break the other specs' shared-page assertions).
 *
 * BUG #1/#3 are covered in ep6-publish-status.spec.ts (EP6-09/EP6-10) and at
 * unit level; BUG #5 at unit level (step16L.test.ts C6 epoch guard).
 */

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const KICK = "samples/kick-909";
const HAT = "samples/hat-airy";
const BASS = "samples/bass-sub";
const LEAD = "samples/lead-ohm";
const ALL = [KICK, HAT, BASS, LEAD];

const selectAll = (p: Page, ids: string[]) =>
  p.evaluate(
    async (sampleIds) => {
      for (const id of sampleIds) {
        const rec = await (window as any).__sm.index.get(id);
        (window as any).__sm.app.toggleMultiSelect(rec);
      }
    },
    ids,
  );

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
  await loadSm(page);

  // Index + analyze the fixture set once (real pipeline once).
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
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("STEP16W regression fixes (shared page)", () => {
  test("SW-01 BUG #4: after remount, a disposed app no longer reacts to keydown", async () => {
    // Give the pre-remount app real state a keydown handler cares about.
    await selectAll(page, [KICK]);
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText("1 / 8");

    // Remount → the old app is pushed into __sm.disposedApps and torn down.
    await page.evaluate(() => (window as any).__sm.publish.remount("live"));
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);

    const disposed = await page.evaluate(
      () => (window as any).__sm.disposedApps[0],
    );
    const selectionBefore = await page.evaluate(
      () => (window as any).__sm.disposedApps[0].selectedSampleIds,
    );
    expect(selectionBefore).toEqual([KICK]);
    // The live (new) app starts with an empty selection.
    expect(
      await page.evaluate(() => (window as any).__sm.app.selectedSampleIds),
    ).toEqual([]);

    // Escape must clear the LIVE selection only — the disposed app's handler is
    // gone (BUG #4: without the fix its document keydown would still fire and
    // clear this stale app's selection / re-render the root).
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(
        () => (window as any).__sm.disposedApps[0].selectedSampleIds,
      ),
    ).toEqual([KICK]); // untouched → its listener was removed
    expect(
      await page.evaluate(() => (window as any).__sm.app.selectedSampleIds),
    ).toEqual([]);

    // Arrow keys only move the LIVE app's focus, never the disposed app's.
    const disposedFocusBefore = await page.evaluate(
      () => (window as any).__sm.disposedApps[0].focusedSampleId,
    );
    await page.locator("[data-testid='sample-map']").focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => page.evaluate(() => (window as any).__sm.app.focusedSampleId))
      .not.toBeUndefined();
    expect(
      await page.evaluate(
        () => (window as any).__sm.disposedApps[0].focusedSampleId,
      ),
    ).toBe(disposedFocusBefore);
  });

  test("SW-02 BUG #2: checkbox DOM never disagrees with selectedSampleIds", async () => {
    await page.evaluate(() => (window as any).__sm.app.clearSelection());
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText("0 / 8");

    // Real checkbox clicks keep DOM checked-state == selection state.
    await page.locator(`[data-testid='multiselect-${KICK}']`).click();
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText(
      "1 / 8",
    );
    expect(
      await page.locator(`[data-testid='multiselect-${KICK}']`).isChecked(),
    ).toBe(true);

    // Toggle off → unchecked + pill back to 0.
    await page.locator(`[data-testid='multiselect-${KICK}']`).click();
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText("0 / 8");
    expect(
      await page.locator(`[data-testid='multiselect-${KICK}']`).isChecked(),
    ).toBe(false);

    // Select all four via checkboxes; every box must agree with the state.
    for (const id of ALL) {
      await page.locator(`[data-testid='multiselect-${id}']`).click();
    }
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText("4 / 8");
    for (const id of ALL) {
      expect(
        await page.locator(`[data-testid='multiselect-${id}']`).isChecked(),
      ).toBe(true);
    }
    expect(
      await page.evaluate(() => (window as any).__sm.app.selectedSampleIds),
    ).toEqual(ALL);

    // Deselect one via the DOM → checkboxes + pill + state all agree again.
    await page.locator(`[data-testid='multiselect-${HAT}']`).click();
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText("3 / 8");
    expect(
      await page.locator(`[data-testid='multiselect-${HAT}']`).isChecked(),
    ).toBe(false);
    expect(
      await page.evaluate(() => (window as any).__sm.app.selectedSampleIds),
    ).toEqual([KICK, BASS, LEAD]);
  });
});