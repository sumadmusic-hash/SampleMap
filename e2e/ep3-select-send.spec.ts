import { test, expect, type Page } from "@playwright/test";
import { startIndexing } from "./support/startIndexing";

/**
 * STEP16R E-P3 — Selection / Send polish against the OFFLINE harness
 * (harness.html). Same composition contract as step16m.spec.ts: only
 * scan/analysis map the REAL pipeline once, then the polished surfaces are
 * asserted.
 *
 * Covered (spec E-P3 required checks):
 *   - single count surface 0/8 … N/8 on the action-bar pill, derived from state
 *   - cap communication on the pill title/aria (`N of 8 selected`,
 *     `8 of 8 selected (limit reached)`)
 *   - `Add to Machiniste` disabled affordance with a native `title`
 *   - send-panel validation guidance (SEND_PANEL_HINT) exposes only enforced
 *     constraints; send controls get accessible names
 *   - accessible names for checkboxes / count / Add / send / slot / status
 *   - layout: no horizontal overflow, no clipping
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

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("STEP16R E-P3 selection / send polish (shared page)", () => {
  test("EP3-01 Action-bar count + Add disabled affordance", async () => {
    await loadSm(page);

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

    const pill = page.locator("[data-testid='selection-pill']");
    const add = page.locator("[data-testid='machiniste-add']");

    // Idle: the single count surface reads the empty state; the Add action is
    // disabled and explains itself via a native title.
    await expect(pill).toHaveText("0 / 8");
    await expect(pill).toHaveAttribute("aria-label", "No samples selected");
    await expect(add).toBeDisabled();
    await expect(add).toHaveAttribute(
      "title",
      "Select at least one sample to add to Machiniste",
    );

    // Selecting counts up on the same surface and enables Add (no competing
    // counter, count derived from the actual selection state).
    await toggleSelect(page, ["samples/lead-ohm", "samples/kick-909"]);
    await expect(pill).toHaveText("2 / 8");
    await expect(pill).toHaveAttribute("title", "2 of 8 selected");
    await expect(pill).toHaveAttribute("aria-label", "2 of 8 selected");
    await expect(add).toBeEnabled();
    await expect(add).not.toHaveAttribute("title", /./);
    await page.screenshot({
      path: "e2e/artifacts/ep3-01-action-bar-selected.png",
      fullPage: true,
    });

    // Two more selections: 4 / 8 (the 8/8 boundary is covered by the pure
    // projections + the app cap test; the harness point cloud has 4 points).
    await toggleSelect(page, ["samples/hat-airy", "samples/bass-sub"]);
    await expect(pill).toHaveText("4 / 8");
    await expect(pill).toHaveAttribute("title", "4 of 8 selected");

    // Clearing the selection restores the disabled affordance.
    await toggleSelect(page, [
      "samples/lead-ohm",
      "samples/kick-909",
      "samples/hat-airy",
      "samples/bass-sub",
    ]);
    await expect(pill).toHaveText("0 / 8");
    await expect(add).toBeDisabled();
    await expect(add).toHaveAttribute(
      "title",
      "Select at least one sample to add to Machiniste",
    );
    await page.screenshot({
      path: "e2e/artifacts/ep3-01-add-disabled.png",
      fullPage: true,
    });
  });

  test("EP3-02 Send-panel guidance + accessible names + layout", async () => {
    // A selection makes the send panel's guidance context real.
    await toggleSelect(page, ["samples/lead-ohm", "samples/kick-909"]);
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText(
      "2 / 8",
    );

    // Validation guidance states only the constraints the pipeline enforces.
    const hint = page.locator(".send-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText(
      "The id must match an existing Machiniste; slots are numbered from the starting slot upward.",
    );

    // Send controls carry meaningful accessible names (testids unchanged).
    const idInput = page.locator("[data-testid='machiniste-id']");
    await expect(idInput).toHaveAttribute("aria-label", "Machiniste id");
    const slotStart = page.locator("[data-testid='machiniste-slot-start']");
    await expect(slotStart).toHaveAttribute("aria-label", "Starting slot");
    await expect(slotStart).toHaveAttribute("min", "0");
    await expect(slotStart).toHaveAttribute(
      "title",
      "Slots are numbered upward from this value",
    );
    const send = page.locator("[data-testid='machiniste-send']");
    await expect(send).toHaveText("Send (max 8)");
    await expect(page.locator(".send-status")).toHaveAttribute(
      "role",
      "status",
    );
    await expect(page.locator(".send-status")).toHaveAttribute(
      "aria-live",
      "polite",
    );

    // Every result-row checkbox announces the sample it selects.
    const cbs = page.locator("[data-testid^='multiselect-']");
    expect(await cbs.count()).toBeGreaterThanOrEqual(4);
    const labels = await cbs.evaluateAll((els) =>
      els.map((e) => e.getAttribute("aria-label") ?? ""),
    );
    expect(labels.every((l) => /^Select .+ for batch$/.test(l))).toBe(true);

    // No German/dev strings; the E-P2 English copy is intact.
    const body = await page.locator("body").innerText();
    expect(body.match(/(Analysiert|Fehler|Verbleibend|DEBUG|TODO)/)).toBeNull();

    // Layout: hints and count must not overflow or clip.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    // The validation hint and the status line stack with no vertical overlap.
    const hintBox = await hint.boundingBox();
    const statusEl = page.locator(".send-status");
    await statusEl.scrollIntoViewIfNeeded();
    await expect(statusEl).toBeVisible();
    const statusBox = await statusEl.boundingBox();
    expect(hintBox).toBeTruthy();
    expect(statusBox).toBeTruthy();
    expect(hintBox!.y + hintBox!.height).toBeLessThanOrEqual(statusBox!.y + 0.5);
    await page.screenshot({
      path: "e2e/artifacts/ep3-02-send-panel.png",
      fullPage: true,
    });
  });
});