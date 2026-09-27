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

  test("6. Real live Cloudflare/D1 Worker: publish, query /map, verify returned points and DOM deduplication", async () => {
    const workerUrl = "https://samplemap-d1-worker.sumadmusic.workers.dev";

    // Check real worker connectivity from browser
    const workerLive = await page.evaluate(async (url) => {
      try {
        const res = await fetch(`${url}/health`);
        return res.ok;
      } catch {
        return false;
      }
    }, workerUrl);

    expect(workerLive).toBe(true);

    // 1. Connect harness to real Cloudflare/D1 worker
    await page.evaluate(async (url) => {
      await (window as any).__sm.publish.connectLiveWorker(url);
    }, workerUrl);

    // 2. Clear any lingering in-memory queue state and run real populate
    await page.evaluate(async () => {
      (window as any).__sm.publish.clear();
      // Ensure all 4 analyzed fixture records are in pending state for this live publish test
      const records = await (window as any).__sm.index.getAll();
      for (const rec of records) {
        await (window as any).__sm.index.put({
          ...rec,
          globalPublish: undefined,
        });
      }
      await (window as any).__sm.publish.populate();
    });

    const pendingCount = await page.evaluate(
      () => (window as any).__sm.publish.queue.pendingCount,
    );
    expect(pendingCount).toBe(4);

    // 3. Trigger Publish to real Worker
    const liveFlush = await page.evaluate(async () => {
      return await (window as any).__sm.publish.flush();
    });

    expect(liveFlush.submitted).toBe(4);
    expect(liveFlush.succeeded).toBe(4);
    expect(liveFlush.rejected).toBe(0);

    // Verify all 4 local records are marked 'published'
    const records = await page.evaluate(() => (window as any).__sm.index.getAll());
    for (const rec of records) {
      expect(rec.globalPublish?.delivery).toBe("published");
    }

    // 4. Query global points from real Worker
    await page.evaluate(async () => {
      await (window as any).__sm.app.refreshGlobalPoints();
    });

    // Wait for the global map state to be "ok"
    await page.waitForFunction(
      () => (window as any).__sm.app.globalMapState === "ok",
      null,
      { timeout: 15_000 },
    );

    // Check that points returned from real D1 include our 4 samples
    const globalPoints = await page.evaluate(
      () => (window as any).__sm.app.globalPoints,
    );
    expect(globalPoints.length).toBeGreaterThanOrEqual(4);

    const fixtureHashes = new Set(records.map((r: any) => r.contentHash));
    const matchedPoints = globalPoints.filter((pt: any) =>
      fixtureHashes.has(pt.contentIdentity.contentHash),
    );
    expect(matchedPoints).toHaveLength(4);

    // 5. Test Global ON + My OFF -> Local records that are also global
    //    visibleMapRecords only contains LOCAL records whose content identity
    //    is in the global set — global-only points (from prior D1 runs) don't
    //    appear here. So we expect exactly 4 (our fixture records).
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: true, mine: false }),
    );
    await page.waitForTimeout(200);

    const globalOnlyCount = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(globalOnlyCount).toBe(4);

    // 6. Test Global ON + My ON -> Union of Global and My Samples
    //    All 4 local records are both "mine" and "global" → union = 4.
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: true, mine: true }),
    );
    await page.waitForTimeout(200);

    const unionCount = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(unionCount).toBe(4);

    // 7. Verify DOM rendered circles: no duplicates
    const domInfo = await page.evaluate(() => {
      const circles = Array.from(
        document.querySelectorAll("circle[data-sample-id]"),
      );
      const ids = circles.map((c) => c.getAttribute("data-sample-id")!);
      const duplicates = ids.filter((v, i, a) => a.indexOf(v) !== i);
      return { total: ids.length, duplicates };
    });
    expect(domInfo.duplicates).toEqual([]);

    // 8. Test Global OFF + My ON -> Exactly 4 local samples
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: false, mine: true }),
    );
    await page.waitForTimeout(200);
    const mineOnlyCount = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(mineOnlyCount).toBe(4);

    // 9. Test Global OFF + My OFF -> 0 points
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: false, mine: false }),
    );
    await page.waitForTimeout(200);
    const noneCount = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(noneCount).toBe(0);

    // Restore default
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: true, mine: true }),
    );
  });
});

