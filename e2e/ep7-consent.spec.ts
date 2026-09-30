import { test, expect, type Page } from "@playwright/test";
import { startIndexing } from "./support/startIndexing";

/**
 * STEP19A E-P7 — one-time consent gate (FINAL_UI_UX_DESIGN_SPEC §19.5)
 * e2e against the OFFLINE harness (harness.html).
 *
 * Scenarios:
 *   E-P7-01 First-use: a fresh (reset) consent state + a selection + Add
 *            shows ONLY the canonical §19.5 dialog; no send is performed.
 *   E-P7-02 Cancel: closes without sending, grants nothing, selection kept,
 *            and the NEXT Add shows the dialog again (retry → dialog again).
 *   E-P7-03 Continue: the guarded send performs EXACTLY once; the granted
 *            preference is written to REAL localStorage.
 *   E-P7-04 Reload: after acceptance the preference survives a full page
 *            reload — Add sends again without any dialog.
 *   E-P7-05 Escape = Cancel: dialog closes, no send, selection retained.
 *   E-P7-06 A11y: role/name/description, Tab trap, keyboard Continue, focus
 *            returns to the Add control after close.
 */
const EP7_KEY = "samplemap:e-p7:consent:v1";

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

async function indexFixture(p: Page) {
  await startIndexing(p);
  await expect(p.locator(".scan-status")).toContainText("Complete", {
    timeout: 20_000,
  });
  await analyze(p, 10);
  await expect(p.locator(".analysis-status")).toContainText(/Stopped|Idle/, {
    timeout: 30_000,
  });
  await p.evaluate(() => (window as any).__sm.app.refreshSearch());
}

/** Select 4 fixture samples + reset consent, then fill the panel Machiniste id
 *  LAST. The selection is first reset (a previous send keeps its selection), so
 *  this helper is idempotent regardless of prior state. The id input is
 *  re-created by every render (selection renders included) and the action-bar
 *  send captures its value at CLICK time, so the id must be filled with no
 *  render in between and immediately before the Add click. */
async function prepareAdd(p: Page) {
  await p.evaluate(() => (window as any).__sm.app.clearSelection());
  await toggleSelect(p, ["samples/lead-ohm", "samples/kick-909", "samples/hat-airy", "samples/bass-sub"]);
  await expect(p.locator("[data-testid='selection-pill']")).toHaveText("4 / 8");
  // Force a first-use consent state for THIS scenario.
  await p.evaluate(() => (window as any).__sm.ep7.reset());
  await fillMachinisteId(p);
}

async function fillMachinisteId(p: Page) {
  const machId = await p.evaluate(() => (window as any).__sm.machinisteId);
  await p.locator("[data-testid='machiniste-id']").fill(machId);
}

const dialog = (p: Page) => p.locator("[data-testid='ep7-consent-dialog']");

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("STEP19A E-P7 one-time consent (shared page)", () => {
  test("E-P7-01 First-use Add shows ONLY the canonical §19.5 dialog", async () => {
    await loadSm(page);
    await indexFixture(page);
    await prepareAdd(page);

    await page.locator("[data-testid='machiniste-add']").click();

    // One modal dialog, rendered with the exact canonical copy.
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveCount(1);
    await expect(dialog(page)).toHaveAttribute("role", "dialog");
    await expect(dialog(page)).toHaveAttribute("aria-modal", "true");
    await expect(dialog(page).locator("#ep7-consent-title")).toHaveText(
      "Add to Machiniste",
    );
    await expect(dialog(page).locator("#ep7-consent-body")).toHaveText(
      "This adds references to audiotool samples in your Machiniste document. No audio is uploaded or copied from SampleMap.",
    );
    await expect(
      page.locator("[data-testid='ep7-consent-accept']"),
    ).toHaveText("Continue");
    await expect(
      page.locator("[data-testid='ep7-consent-cancel']"),
    ).toHaveText("Cancel");

    // The guarded operation did NOT run: no Machiniste result yet.
    const res = await getMach(page);
    expect(res.slots).toHaveLength(0);
    expect(res.errors).toEqual([]);
    // The shell is inert behind the modal.
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText(
      "4 / 8",
    );
  });

  test("E-P7-02 Cancel drops the send, grants nothing, dialog returns on retry", async () => {
    // Dialog is still up from E-P7-01 → cancel it.
    await page.locator("[data-testid='ep7-consent-cancel']").click();
    await expect(dialog(page)).toHaveCount(0);

    // No consent granted, no local persisted key, selection retained.
    expect(await page.evaluate(() => (window as any).__sm.ep7.isGranted())).toBe(
      false,
    );
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), EP7_KEY),
    ).toBeNull();
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText(
      "4 / 8",
    );
    const res = await getMach(page);
    expect(res.slots).toHaveLength(0);

    // Retry shows the dialog again (the gate is re-armed after Cancel). The id
    // is re-filled because re-renders wiped the previous input value, and the
    // send captures the id at click time.
    await fillMachinisteId(page);
    await page.locator("[data-testid='machiniste-add']").click();
    await expect(dialog(page)).toBeVisible();
  });

  test("E-P7-03 Continue sends exactly once and persists the real key", async () => {
    await page.locator("[data-testid='ep7-consent-accept']").click();
    await expect(dialog(page)).toHaveCount(0);

    // The guarded send performed: Applied: 4, committed, verified read-back.
    await expect(page.locator("[data-testid='action-status']")).toContainText(
      "Applied: 4",
      { timeout: 20_000 },
    );
    const res = await getMach(page);
    expect(res.committed).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.slots).toHaveLength(4);
    expect(res.slots.every((s) => s.applied && s.readBackMatches)).toBe(true);

    // Preference persisted into REAL localStorage (the reload test in E-P7-04
    // relies on this exact key surviving).
    expect(await page.evaluate(() => (window as any).__sm.ep7.isGranted())).toBe(
      true,
    );
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), EP7_KEY),
    ).toBe("granted");
  });

  test("E-P7-04 Acceptance survives a full reload: Add sends with no dialog", async () => {
    await page.reload();
    await loadSm(page);

    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), EP7_KEY),
    ).toBe("granted");

    // Add again with a selection (no consent reset): the granted preference
    // skips the dialog entirely and sends immediately. The IndexedDB index
    // survives the reload, so a refresh is enough (no re-scan/analysis).
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await prepareAddNoReset(page);
    await page.locator("[data-testid='machiniste-add']").click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator("[data-testid='action-status']")).toContainText(
      "Applied: 4",
      { timeout: 20_000 },
    );
  });

  test("E-P7-05 Escape cancels the dialog, sends nothing, keeps the selection", async () => {
    await prepareAdd(page);
    await page.locator("[data-testid='machiniste-add']").click();
    await expect(dialog(page)).toBeVisible();

    // lastResult persists from E-P7-04's send; the assertion is "no NEW send".
    const before = (await getMach(page)).slots.length;

    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);

    expect(await page.evaluate(() => (window as any).__sm.ep7.isGranted())).toBe(
      false,
    );
    expect((await getMach(page)).slots.length).toBe(before);
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText(
      "4 / 8",
    );
  });

  test("E-P7-06 A11y: Tab trap, keyboard Continue, focus returns to Add", async () => {
    await prepareAdd(page);
    await page.locator("[data-testid='machiniste-add']").click();
    await expect(dialog(page)).toBeVisible();

    // Labelled + described by the title/body texts.
    await expect(dialog(page)).toHaveAttribute(
      "aria-labelledby",
      "ep7-consent-title",
    );
    await expect(dialog(page)).toHaveAttribute(
      "aria-describedby",
      "ep7-consent-body",
    );

    // Initial focus is inside the dialog (on Cancel, the safe default).
    const focusedId = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a?.getAttribute("data-testid") ?? "";
    });
    expect(focusedId).toBe("ep7-consent-cancel");

    // Tab wraps only between the two actions (trap stays inside).
    await page.keyboard.press("Tab");
    const f1 = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ?? "",
    );
    expect(f1).toBe("ep7-consent-accept");
    await page.keyboard.press("Tab");
    const f2 = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ?? "",
    );
    expect(f2).toBe("ep7-consent-cancel");

    // Keyboard Continue runs the guarded send and closes.
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator("[data-testid='action-status']")).toContainText(
      "Applied: 4",
      { timeout: 20_000 },
    );

    // Focus was restored to the Add control that opened the dialog.
    const restored = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ?? "",
    );
    expect(restored).toBe("machiniste-add");
  });
});

/** Like prepareAdd but without the consent reset (used after reload). */
async function prepareAddNoReset(p: Page) {
  await p.evaluate(() => (window as any).__sm.app.clearSelection());
  await toggleSelect(p, ["samples/lead-ohm", "samples/kick-909", "samples/hat-airy", "samples/bass-sub"]);
  await expect(p.locator("[data-testid='selection-pill']")).toHaveText("4 / 8");
  await fillMachinisteId(p);
}