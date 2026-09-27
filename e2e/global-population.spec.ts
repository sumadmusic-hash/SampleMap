import { test, expect, type Page } from "@playwright/test";

/**
 * Step 70 E2E — Automatic Global Population & Map Verification
 *
 * Verifies end-to-end in real browser:
 *  1. Local analysis completion automatically populates publish queue
 *  2. Candidates carry ONLY metadata, NO audio bytes
 *  3. Dedup: re-population is sampleId-level idempotent
 *  4. Offline: delivery remains pending until a live flush
 *  5. Live flush delivers candidates and marks local records as "published"
 *  6. Global visibility projection (Global ON/OFF, My Samples ON/OFF, Overlap union)
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

test.describe.serial("Step 70 — Automatic Global Population E2E", () => {
  test("1. Analysis completion automatically enqueues all eligible analyzed records", async () => {
    await loadSm(page);

    // Initial state: queue is empty
    const initialPending = await page.evaluate(
      () => (window as any).__sm.publish.queue.pendingCount,
    );
    expect(initialPending).toBe(0);

    // Scan + analyze fixture library (4 samples)
    await page.locator("[data-testid='first-use-index']").click();
    await expect(page.locator(".scan-status")).toContainText("Complete", {
      timeout: 20_000,
    });
    await page.evaluate((b) => (window as any).__sm.analyze(b), 10);
    await expect(page.locator(".analysis-status")).toContainText(/Stopped|Idle/, {
      timeout: 30_000,
    });

    // Wait for the automatic population to settle
    await page.waitForFunction(
      () => (window as any).__sm.publish.queue.pendingCount === 4,
      null,
      { timeout: 5_000 },
    );

    const snapshot = await page.evaluate(() =>
      (window as any).__sm.publish.queue.snapshot(),
    );
    expect(snapshot).toHaveLength(4);

    const sampleIds = snapshot.map((i: any) => i.sampleId).sort();
    expect(sampleIds).toEqual([
      "samples/bass-sub",
      "samples/hat-airy",
      "samples/kick-909",
      "samples/lead-ohm",
    ]);

    // Check all candidates are pending
    for (const item of snapshot) {
      expect(item.status).toBe("pending");
      expect(item.attempts).toBe(0);
    }

    // Check all records have pending marker
    const records = await page.evaluate(() => (window as any).__sm.index.getAll());
    expect(records).toHaveLength(4);
    for (const rec of records) {
      expect(rec.globalPublish).toBeDefined();
      expect(rec.globalPublish.delivery).toBe("pending");
      expect(typeof rec.globalPublish.usageAcceptedAt).toBe("string");
    }
  });

  test("2. No-audio invariant: publish candidate payloads are strictly audio-free", async () => {
    const candidates = await page.evaluate(() =>
      (window as any).__sm.publish.queue.snapshot().map((i: any) => i.candidate),
    );
    expect(candidates).toHaveLength(4);

    for (const cand of candidates) {
      // Must have sampleId, contentIdentity, analysis, features
      expect(cand.sampleId).toBeDefined();
      expect(cand.contentIdentity.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(cand.contentIdentity.contentHashVersion).toBe("pcm-v1");
      expect(cand.analysis.map.x).toBeGreaterThanOrEqual(0);
      expect(cand.analysis.map.x).toBeLessThanOrEqual(1);
      expect(cand.analysis.map.y).toBeGreaterThanOrEqual(0);
      expect(cand.analysis.map.y).toBeLessThanOrEqual(1);

      // JSON serialized string MUST NOT contain any audio buffers or raw byte fields
      const json = JSON.stringify(cand);
      expect(json).not.toMatch(/"audioBuffer"|"pcm"|"audioData"|"rawAudio"|"wavBytes"/i);
    }
  });

  test("3. Idempotency: re-running analysis when nothing due does not duplicate queue entries", async () => {
    // Re-run analyze with no new samples due
    await page.evaluate((b) => (window as any).__sm.analyze(b), 10);
    await page.waitForTimeout(300);

    const count = await page.evaluate(
      () => (window as any).__sm.publish.queue.pendingCount,
    );
    expect(count).toBe(4); // still 4, no duplicates
  });

  test("4. Live flush delivers candidates to provider and updates local delivery markers", async () => {
    // Switch delivery to live and flush with success outcomes
    await page.evaluate(() => (window as any).__sm.publish.remount("live"));
    const flushRes = await page.evaluate(() =>
      (window as any).__sm.publish.flush({
        "samples/kick-909": { status: "stored" },
        "samples/hat-airy": { status: "stored" },
        "samples/bass-sub": { status: "already-known" },
        "samples/lead-ohm": { status: "stored" },
      }),
    );

    expect(flushRes.submitted).toBe(4);
    expect(flushRes.succeeded).toBe(4);
    expect(flushRes.markedPublished).toBe(4);

    // Verify local markers are now published
    const records = await page.evaluate(() => (window as any).__sm.index.getAll());
    for (const rec of records) {
      expect(rec.globalPublish?.delivery).toBe("published");
    }
  });

  test("5. Global map visibility & overlap: Global ON / My OFF / Union semantics", async () => {
    // Inject the published candidates as GlobalMapPoints into the provider
    const candidates = await page.evaluate(() =>
      (window as any).__sm.publish.queue.snapshot().map((i: any) => i.candidate),
    );

    await page.evaluate((cands: any[]) => {
      const pts = cands.map((c: any) => ({
        contentIdentity: c.contentIdentity,
        x: c.analysis.map.x,
        y: c.analysis.map.y,
        representativeSampleId: c.sampleId,
        primaryClass: c.analysis.primaryClass,
      }));
      (window as any).__sm.publish.provider.setMapPoints(pts);
    }, candidates);

    // Refresh global points
    await page.evaluate(() => (window as any).__sm.app.refreshGlobalPoints());
    await page.waitForTimeout(200);

    // Case 1: Global ON + My ON (default) -> Union (all 4 points, no duplicates)
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: true, mine: true }),
    );
    await page.waitForTimeout(100);
    const visibleUnion = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(visibleUnion).toBe(4);

    // Case 2: Global OFF + My ON -> My Samples only (4 local records)
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: false, mine: true }),
    );
    await page.waitForTimeout(100);
    const visibleMineOnly = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(visibleMineOnly).toBe(4);

    // Case 3: Global ON + My OFF -> Global only (4 global records)
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: true, mine: false }),
    );
    await page.waitForTimeout(100);
    const visibleGlobalOnly = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(visibleGlobalOnly).toBe(4);

    // Case 4: Global OFF + My OFF -> Empty map
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: false, mine: false }),
    );
    await page.waitForTimeout(100);
    const visibleNone = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(visibleNone).toBe(0);

    // Restore default
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: true, mine: true }),
    );
  });
});
