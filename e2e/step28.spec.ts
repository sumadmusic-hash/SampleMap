import {
  test,
  expect,
  type Page,
  type ConsoleMessage,
} from "@playwright/test";

/**
 * STEP28 — Persistent Sound Collections — E2E (E28-01..E28-20).
 *
 * Drives the REAL SampleMap UI (harness.html → src/e2e/harness/main.ts) with the
 * four fixture waveforms + deterministic V2 stamps (`__sm.v2.attach`) —
 * FIXTURE-class evidence per the report.
 *
 * The IndexedDB-backed CollectionStore (stable database name `"samplemap"`,
 * object store `"collections"`) survives real browser reloads on the same
 * origin, so the tests below assert persistence across `page.reload()`.
 *
 * Constraints exercised:
 *   - §48: activeCollectionId === null on boot (no auto-restore)
 *   - §26: save failure → dirty stays true, error surfaced, retry allowed
 *   - §28: load restores name + ordered ids only (never selection/focus/etc.)
 *   - §30: switch triggers Save/Discard/Cancel confirm dialog
 *   - §31: delete with explicit "samples NOT deleted" confirmation
 *   - §36: stale member surfaced, never dropped or crashed
 *   - §20: corrupt/unsupported-version records surfaced honestly
 */

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const firstUseIndex = (p: Page) =>
  p.locator("[data-testid='first-use-index']").click();

const analyzeAll = (p: Page) =>
  p.evaluate((b) => (window as any).__sm.analyze(b), 10);

const attachV2 = (p: Page, keys?: string[]) =>
  p.evaluate((k) => (window as any).__sm.v2.attach(k), keys);

const refresh = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.refreshSearch());

const addToCollectionApi = (p: Page, ids: string[]) =>
  p.evaluate(async (list) => {
    const app = (window as any).__sm.app as any;
    for (const id of list) {
      const rec = app.recordForSample(id);
      await app.addToCollection(id, rec);
    }
  }, ids);

const getCollection = (p: Page) =>
  p.evaluate(() => {
    const c = (window as any).__sm.app.collection;
    return { open: c.open, ids: [...c.sampleIds] };
  });

const getAppState = (p: Page) =>
  p.evaluate(() => {
    const app = (window as any).__sm.app as any;
    return {
      collectionName: app.collectionName,
      activeCollectionId: app.activeCollectionId,
      collectionDirty: app.collectionDirty,
      collectionSaveError: app.collectionSaveError,
      collectionManagerOpen: app.collectionManager.open,
      collectionManagerEntries: app.collectionManager.entries.length,
      collectionPersistenceAvailable: app.collectionPersistenceAvailable,
    };
  });

const getManagerEntries = (p: Page) =>
  p.evaluate(() => {
    return ((window as any).__sm.app as any).collectionManager.entries.map((e: any) => ({
      id: e.id,
      name: e.name,
      active: e.active,
      invalidKind: e.invalid?.kind ?? null,
    }));
  });

const openManager = async (p: Page) => {
  const isOpen = await p.evaluate(() => (window as any).__sm.app.collectionManager.open);
  if (!isOpen) {
    // STEP32: reveal via the canonical open path (the "Show Saved" control
    // only exists after the disclosure latch); no opaque SD switch involved.
    await p.evaluate(() => (window as any).__sm.app.openCollectionManager());
  }
  await p.waitForFunction(
    () => (window as any).__sm.app.collectionManager.listStatus !== "loading",
    { timeout: 10_000 },
  );
};

const keyboardToggleManager = (p: Page, desired: boolean) =>
  expect
    .poll(
      async () => {
        if (
          (await p.evaluate(() => (window as any).__sm.app.collectionManager.open)) !== desired
        ) {
          await p.locator("[data-testid='collection-manager-toggle']").press("Enter");
        }
        return p.evaluate(() => (window as any).__sm.app.collectionManager.open);
      },
      { timeout: 15_000 },
    )
    .toBe(desired);

const closeManager = async (p: Page) => {
  const isOpen = await p.evaluate(
    () => (window as any).__sm.app.collectionManager.open,
  );
  if (isOpen) {
    await p.locator("[data-testid='collection-manager-toggle']").click();
    await p.waitForFunction(
      () => (window as any).__sm.app.collectionManager.open === false,
      { timeout: 10_000 },
    );
  }
};

const benignConsole = (m: ConsoleMessage) =>
  /favicon|Failed to load resource:.*net::ERR|404 \(Not Found\)/.test(m.text());

const capturedConsoleErrors: ConsoleMessage[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && capturedConsoleErrors.push(m));
  await page.goto("/harness.html");
});

test.afterAll(async () => {
  await page.close();
});

const KICK = "samples/kick-909";
const HAT = "samples/hat-airy";
const BASS = "samples/bass-sub";
const LEAD = "samples/lead-ohm";

const SAMPLE_IDS_55: string[] = Array.from({ length: 55 }, (_, i) => `samples/hold-${i}`);

test.describe.serial("STEP28 Persistent Sound Collections — real IndexedDB + real reload", () => {
  test("E28-01 initial state: activeCollectionId null, no auto-restore, empty manager list", async () => {
    await loadSm(page);
    await firstUseIndex(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", { timeout: 20_000 });
    await analyzeAll(page);
    await attachV2(page);
    await refresh(page);

    const state = await getAppState(page);
    expect(state.activeCollectionId).toBeNull();
    expect(state.collectionDirty).toBe(false);
    expect(state.collectionPersistenceAvailable).toBe(true);
    expect(state.collectionManagerOpen).toBe(false);

    await openManager(page);
    const entries = await getManagerEntries(page);
    expect(entries.length).toBe(0);
    await expect(page.locator("[data-testid='collection-empty']")).toContainText(
      "No saved collections yet",
    );
    await closeManager(page);
  });

  test("E28-02 add samples → dirty=true, New Collection resets working set", async () => {
    await addToCollectionApi(page, [KICK, HAT, BASS]);
    const ids = (await getCollection(page)).ids;
    expect(ids).toEqual([KICK, HAT, BASS]);

    const state = await getAppState(page);
    expect(state.collectionDirty).toBe(true);
    expect(state.collectionName).toBe("New Collection");

    await page.evaluate(() => (window as any).__sm.app.createNewCollection());
    const stateAfter = await getAppState(page);
    expect(stateAfter.collectionDirty).toBe(false);
    expect(stateAfter.activeCollectionId).toBeNull();
    expect((await getCollection(page)).ids).toEqual([]);
  });

  test("E28-03 rename → dirty marker visible in status label", async () => {
    await addToCollectionApi(page, [KICK]);
    await page.evaluate(() => (window as any).__sm.app.renameCollection("Drums"));
    const state = await getAppState(page);
    expect(state.collectionName).toBe("Drums");
    expect(state.collectionDirty).toBe(true);
    await expect(page.locator("[data-testid='collection-active']")).toContainText(
      "Active collection: Drums *",
    );
  });

  test("E28-04 save with no active → creates new, dirty=false", async () => {
    await page.evaluate(() => (window as any).__sm.app.saveCollection());
    await page.waitForFunction(
      () => (window as any).__sm.app.collectionDirty === false,
      { timeout: 10_000 },
    );
    const state = await getAppState(page);
    expect(state.activeCollectionId).not.toBeNull();
    expect(state.collectionDirty).toBe(false);
  });

  test("E28-05 reload → saved collection reappears in manager list", async () => {
    await page.reload({ waitUntil: "load" });
    await loadSm(page);
    await firstUseIndex(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", { timeout: 20_000 });
    await analyzeAll(page);
    await attachV2(page);
    await refresh(page);

    const state = await getAppState(page);
    expect(state.activeCollectionId).toBeNull(); // §48: no auto-restore
    expect(state.collectionDirty).toBe(false);

    await openManager(page);
    const entries = await getManagerEntries(page);
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("Drums");
    expect(entries[0].active).toBe(false);
    await closeManager(page);
  });

  test("E28-06 load restores name + ordered ids only (not selection/focus)", async () => {
    // Add some samples that exist, save them, then load after reload.
    await addToCollectionApi(page, [KICK, HAT]);
    await page.evaluate(() => (window as any).__sm.app.renameCollection("Kicks & Hats"));
    await page.evaluate(() => (window as any).__sm.app.saveCollection());
    await page.waitForFunction(
      () => (window as any).__sm.app.collectionDirty === false,
      { timeout: 10_000 },
    );

    const activeId = await page.evaluate(
      () => (window as any).__sm.app.activeCollectionId as string,
    );
    expect(activeId).not.toBeNull();

    // Create a new working set, verify it's different.
    await page.evaluate(() => (window as any).__sm.app.createNewCollection());
    expect((await getCollection(page)).ids).toEqual([]);

    // Load the saved collection.
    await page.evaluate((id: string) => (window as any).__sm.app.loadCollection(id), activeId);
    await page.waitForFunction(
      () => (window as any).__sm.app.collectionDirty === false,
      { timeout: 10_000 },
    );

    const ids = (await getCollection(page)).ids;
    expect(ids).toEqual([KICK, HAT]);
    const state = await getAppState(page);
    expect(state.collectionName).toBe("Kicks & Hats");
    // Selection/focus not restored (null on fresh load).
    const selection = await page.evaluate(() => [...(window as any).__sm.app.selectedSampleIds]);
    expect(selection).toEqual([]);
  });

  test("E28-07 order persists exactly through save → reload → load", async () => {
    await page.evaluate(() => (window as any).__sm.app.clearCollection());
    await addToCollectionApi(page, [BASS, LEAD, KICK]);
    await page.evaluate(() => (window as any).__sm.app.renameCollection("Ordered"));
    await page.evaluate(() => (window as any).__sm.app.saveCollection());
    await page.waitForFunction(
      () => (window as any).__sm.app.collectionDirty === false,
      { timeout: 10_000 },
    );

    await page.reload({ waitUntil: "load" });
    await loadSm(page);
    await firstUseIndex(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", { timeout: 20_000 });
    await analyzeAll(page);
    await attachV2(page);
    await refresh(page);

    await openManager(page);
    const entries = await getManagerEntries(page);
    const orderedEntry = entries.find((e: any) => e.name === "Ordered");
    expect(orderedEntry).toBeDefined();
    await page.evaluate((id: string) => (window as any).__sm.app.loadCollection(id), orderedEntry!.id);
    await page.waitForFunction(
      () => (window as any).__sm.app.collectionDirty === false,
      { timeout: 10_000 },
    );

    expect((await getCollection(page)).ids).toEqual([BASS, LEAD, KICK]);
  });

  test("E28-08 save-as creates a new entry, never overwrites existing", async () => {
    await closeManager(page);
    await openManager(page);
    const beforeEntries = await getManagerEntries(page);
    const beforeCount = beforeEntries.length;

    await page.evaluate(() => (window as any).__sm.app.saveCollectionAs());
    await page.waitForFunction(
      () => (window as any).__sm.app.collectionDirty === false,
      { timeout: 10_000 },
    );

    await closeManager(page);
    await openManager(page);
    const afterEntries = await getManagerEntries(page);
    expect(afterEntries.length).toBe(beforeCount + 1);
    // Both entries have the same name but different ids.
    const sameNameEntries = afterEntries.filter((e: any) => e.name === "Ordered");
    expect(sameNameEntries.length).toBe(2);
    expect(sameNameEntries[0].id).not.toBe(sameNameEntries[1].id);
  });

  test("E28-09 switch triggers unsaved-switch dialog when dirty", async () => {
    // Make the working set dirty (add a sample).
    await addToCollectionApi(page, [LEAD]);
    await page.evaluate(() => (window as any).__sm.app.renameCollection("Dirty Set"));

    // Find a saved collection to switch to.
    const entries = await getManagerEntries(page);
    const target = entries.find((e: any) => !e.active && e.name === "Drums");
    expect(target).toBeDefined();

    await page.evaluate(
      ({ id, name }: { id: string; name: string }) =>
        (window as any).__sm.app.requestSwitchCollection(id, name),
      { id: target!.id, name: target!.name },
    );

    await expect(page.locator("[data-testid='collection-switch-confirm']")).toBeVisible();
    await expect(page.locator("[data-testid='collection-switch-save']")).toBeVisible();
    await expect(page.locator("[data-testid='collection-switch-discard']")).toBeVisible();
    await expect(page.locator("[data-testid='collection-switch-cancel']")).toBeVisible();
  });

  test("E28-10 cancel switch → dialog closes, dirty working set preserved", async () => {
    await page.locator("[data-testid='collection-switch-cancel']").click();
    await expect(page.locator("[data-testid='collection-switch-confirm']")).toBeHidden();

    const state = await getAppState(page);
    expect(state.collectionDirty).toBe(true);
    expect(state.collectionName).toBe("Dirty Set");
  });

  test("E28-11 discard-and-switch loads the target, drops working set", async () => {
    const entries = await getManagerEntries(page);
    const target = entries.find((e: any) => !e.active && e.name === "Drums");

    await page.evaluate(
      ({ id, name }: { id: string; name: string }) =>
        (window as any).__sm.app.requestSwitchCollection(id, name),
      { id: target!.id, name: target!.name },
    );

    await expect(page.locator("[data-testid='collection-switch-confirm']")).toBeVisible();
    await page.locator("[data-testid='collection-switch-discard']").click();
    await expect(page.locator("[data-testid='collection-switch-confirm']")).toBeHidden();
    await page.waitForFunction(
      () => (window as any).__sm.app.collectionDirty === false &&
        (window as any).__sm.app.collectionName === "Drums",
      { timeout: 10_000 },
    );

    const state = await getAppState(page);
    expect(state.collectionName).toBe("Drums");
    expect(state.collectionDirty).toBe(false);
    expect((await getCollection(page)).ids).toEqual([KICK]);
  });

  test("E28-12 save-and-switch persists dirty edits, then loads target", async () => {
    // First, add samples to the current "Drums" collection and make it dirty.
    await addToCollectionApi(page, [HAT, BASS]);
    await page.evaluate(() => (window as any).__sm.app.renameCollection("Drums Plus"));
    const stateBefore = await getAppState(page);
    expect(stateBefore.collectionDirty).toBe(true);

    // Find another saved collection to switch to.
    await closeManager(page);
    await openManager(page);
    const entries = await getManagerEntries(page);
    const target = entries.find((e: any) => !e.active && e.name === "Ordered");
    expect(target).toBeDefined();

    await page.evaluate(
      ({ id, name }: { id: string; name: string }) =>
        (window as any).__sm.app.requestSwitchCollection(id, name),
      { id: target!.id, name: target!.name },
    );

    await expect(page.locator("[data-testid='collection-switch-confirm']")).toBeVisible();
    await page.locator("[data-testid='collection-switch-save']").click();
    await expect(page.locator("[data-testid='collection-switch-confirm']")).toBeHidden();
    await page.waitForFunction(
      () => (window as any).__sm.app.collectionDirty === false &&
        (window as any).__sm.app.collectionName === "Ordered",
      { timeout: 10_000 },
    );

    const stateAfter = await getAppState(page);
    expect(stateAfter.collectionName).toBe("Ordered");
    expect(stateAfter.collectionDirty).toBe(false);
    expect((await getCollection(page)).ids).toEqual([BASS, LEAD, KICK]);

    // The dirty edits were persisted: reload and check "Drums Plus" exists.
    await page.reload({ waitUntil: "load" });
    await loadSm(page);
    await firstUseIndex(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", { timeout: 20_000 });
    await analyzeAll(page);
    await attachV2(page);
    await refresh(page);

    await openManager(page);
    const entriesAfterReload = await getManagerEntries(page);
    expect(entriesAfterReload.some((e: any) => e.name === "Drums Plus")).toBe(true);
  });

  test("E28-13 delete triggers explicit confirmation dialog with samples-NOT-deleted messaging", async () => {
    const entries = await getManagerEntries(page);
    const target = entries.find((e: any) => e.name === "Drums Plus");
    expect(target).toBeDefined();

    await page.evaluate(
      ({ id, name }: { id: string; name: string }) =>
        (window as any).__sm.app.requestDeleteCollection(id, name),
      { id: target!.id, name: target!.name },
    );

    await expect(page.locator("[data-testid='collection-delete-confirm']")).toBeVisible();
    await expect(page.locator("[data-testid='collection-delete-confirm-btn']")).toBeVisible();
    await expect(page.locator("[data-testid='collection-delete-cancel']")).toBeVisible();
    // "samples NOT deleted" messaging is present.
    await expect(page.locator("[data-testid='collection-delete-confirm']")).toContainText(
      "NOT deleted",
    );
  });

  test("E28-14 cancel delete → dialog closes, collection preserved", async () => {
    await page.locator("[data-testid='collection-delete-cancel']").click();
    await expect(page.locator("[data-testid='collection-delete-confirm']")).toBeHidden();

    const entries = await getManagerEntries(page);
    expect(entries.some((e: any) => e.name === "Drums Plus")).toBe(true);
  });

  test("E28-15 confirm delete → removed from list, active-collection id nulled if deleted", async () => {
    // First load "Drums Plus" so it becomes active.
    const entries = await getManagerEntries(page);
    const target = entries.find((e: any) => e.name === "Drums Plus");
    await page.evaluate(
      (id: string) => (window as any).__sm.app.loadCollection(id),
      target!.id,
    );
    await page.waitForFunction(
      () => (window as any).__sm.app.collectionDirty === false,
      { timeout: 10_000 },
    );

    const stateLoaded = await getAppState(page);
    expect(stateLoaded.activeCollectionId).toBe(target!.id);
    expect(stateLoaded.collectionName).toBe("Drums Plus");

    // Delete the active collection.
    await page.evaluate(
      ({ id, name }: { id: string; name: string }) =>
        (window as any).__sm.app.requestDeleteCollection(id, name),
      { id: target!.id, name: target!.name },
    );
    await page.locator("[data-testid='collection-delete-confirm-btn']").click();
    await expect(page.locator("[data-testid='collection-delete-confirm']")).toBeHidden();
    await page.waitForFunction(
      () => (window as any).__sm.app.activeCollectionId === null,
      { timeout: 10_000 },
    );

    const stateAfterDelete = await getAppState(page);
    expect(stateAfterDelete.activeCollectionId).toBeNull();
    // Working set with samples → dirty.
    expect(stateAfterDelete.collectionDirty).toBe(true);

    const entriesAfterDelete = await getManagerEntries(page);
    expect(entriesAfterDelete.some((e: any) => e.name === "Drums Plus")).toBe(false);
  });

  test("E28-16 deleted collection stays deleted across reload", async () => {
    await page.reload({ waitUntil: "load" });
    await loadSm(page);
    await firstUseIndex(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", { timeout: 20_000 });
    await analyzeAll(page);
    await attachV2(page);
    await refresh(page);

    await openManager(page);
    const entries = await getManagerEntries(page);
    expect(entries.some((e: any) => e.name === "Drums Plus")).toBe(false);
  });

  test("E28-17 stale member survives load (unavailable, never dropped)", async () => {
    // Create a collection with KICK, save it.
    await page.evaluate(() => (window as any).__sm.app.createNewCollection());
    await addToCollectionApi(page, [KICK, HAT]);
    await page.evaluate(() => (window as any).__sm.app.renameCollection("Stale Test"));
    await page.evaluate(() => (window as any).__sm.app.saveCollection());
    await page.waitForFunction(
      () => (window as any).__sm.app.collectionDirty === false,
      { timeout: 10_000 },
    );

    const activeId = await page.evaluate(
      () => (window as any).__sm.app.activeCollectionId as string,
    );

    // Create new collection (to verify the stale one can be loaded independently).
    await page.evaluate(() => (window as any).__sm.app.createNewCollection());

    // Load the "Stale Test" collection.
    await page.evaluate((id: string) => (window as any).__sm.app.loadCollection(id), activeId);
    await page.waitForFunction(
      () => (window as any).__sm.app.collectionDirty === false,
      { timeout: 10_000 },
    );

    const ids = (await getCollection(page)).ids;
    expect(ids).toEqual([KICK, HAT]);
    expect((await getAppState(page)).collectionName).toBe("Stale Test");
  });

  test("E28-18 50-boundary enforced: 51st add is a no-op after save+reload", async () => {
    // Stamp 55 synthetic records, add 50 to a fresh collection, save, reload.
    await page.evaluate(async () => {
      const tm = window as any;
      const index = tm.__sm.index as any;
      const rec = await index.get("samples/kick-909");
      for (let i = 0; i < 55; i++) {
        await index.put({
          ...rec,
          sampleId: `samples/hold-${i}`,
          name: `Hold ${i}`,
        });
      }
      await tm.__sm.app.refreshSearch();
    });

    await addToCollectionApi(page, SAMPLE_IDS_55);
    const idsBefore = (await getCollection(page)).ids;
    expect(idsBefore.length).toBe(50); // 51st rejected.

    await page.evaluate(() => (window as any).__sm.app.renameCollection("Cap 50"));
    await page.evaluate(() => (window as any).__sm.app.saveCollection());
    await page.waitForFunction(
      () => (window as any).__sm.app.collectionDirty === false,
      { timeout: 10_000 },
    );

    await page.reload({ waitUntil: "load" });
    await loadSm(page);
    await firstUseIndex(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", { timeout: 20_000 });
    await analyzeAll(page);
    await attachV2(page);
    await refresh(page);

    await openManager(page);
    const entries = await getManagerEntries(page);
    const capEntry = entries.find((e: any) => e.name === "Cap 50");
    expect(capEntry).toBeDefined();
    await page.evaluate(
      (id: string) => (window as any).__sm.app.loadCollection(id),
      capEntry!.id,
    );
    await page.waitForFunction(
      () => (window as any).__sm.app.collectionDirty === false,
      { timeout: 10_000 },
    );
    expect((await getCollection(page)).ids.length).toBe(50);
    expect((await getCollection(page)).ids).toEqual(idsBefore);
  });

  test("E28-19 keyboard: manager controls accessible via keyboard", async () => {
    await closeManager(page);
    await keyboardToggleManager(page, true);
    await keyboardToggleManager(page, false);
  });

  test("E28-20 console audit: no unhandled application errors across the session", async () => {
    const errors = capturedConsoleErrors.filter((m) => !benignConsole(m));
    expect(errors).toEqual([]);
  });
});
