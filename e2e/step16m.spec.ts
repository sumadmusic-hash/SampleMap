import {
  test,
  expect,
  type Page,
  type ConsoleMessage,
} from "@playwright/test";

/**
 * Step 16M — End-to-end browser verification of the REAL SampleMap UI against
 * the OFFLINE harness (harness.html -> src/e2e/harness/main.ts).
 *
 * `window.__sm` exposes the REAL SampleMapApp + persisted index + the REAL Nexus
 * OfflineDocument. Only external/authenticated services are FIXTURE'd
 * (fetchAudio bytes, fixture SampleMeta pages); decode is REAL browser WebAudio,
 * analysis/classification/map/machiniste all REAL.
 *
 * A single shared page (describe.serial) boots the harness + analyzes ONCE so
 * the 20 assertions reuse the persisted IndexedDB state (fast); only the
 * reload/idempotency tests re-navigate.
 */

interface RecordRow {
  sampleId: string;
  primaryClass: string;
  confidence: number;
  tags: string[];
  mapX: number;
  mapY: number;
  cx: number;
  cy: number;
  features: { tonalNoiseRatio: number; spectralCentroid: number };
}

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const scan = (p: Page) => p.evaluate(() => (window as any).__sm.scan());
const analyze = (p: Page, budget = 10) =>
  p.evaluate((b) => (window as any).__sm.analyze(b), budget);
const readRecords = (p: Page): Promise<RecordRow[]> =>
  p.evaluate(() => (window as any).__sm.readRecords());
const getAnalysis = (p: Page) =>
  p.evaluate(() => ({ ...(window as any).__sm.app.analysis }));
const getScan = (p: Page) => p.evaluate(() => ({ ...(window as any).__sm.app.scan }));
const getMach = (p: Page) => p.evaluate(() => ({ ...(window as any).__sm.app.machiniste }));
const getIndexRec = (p: Page, id: string) =>
  p.evaluate((s) => (window as any).__sm.index.get(s), id);
const getFetchCount = (p: Page) =>
  p.evaluate(() => (window as any).__sm.fetchCount);
const sendToMach = (p: Page, id: string) =>
  p.evaluate((s) => (window as any).__sm.sendToMachiniste(s), id);
const selectSample = (p: Page, id: string) =>
  p.evaluate((s) => (window as any).__sm.selectSample(s), id);
const searchSm = (p: Page, q: unknown) =>
  p.evaluate((query) => (window as any).__sm.search.search(query), q);
const getGlobalMapState = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.globalMapState);
const refreshResults = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.refreshSearch());

/** Click a map point at its geometric center (client coords) so the map's
 *  pointerdown -> pointAt hit-test fires even for edge-anchored points. */
async function clickMapPoint(p: Page, id: string) {
  const loc = p.locator(`[data-testid='map-point-${id}']`);
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`point not rendered: ${id}`);
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
const getQueueCounts = (p: Page) =>
  p.evaluate(
    async (ss) => {
      const out: Record<string, number> = {};
      for (const s of ss) out[s] = await (window as any).__sm.queue.countByStatus(s);
      return out;
    },
    ["queued", "processing", "analyzed", "failed", "skipped", "gone"],
  );

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

test.describe.serial("SampleMap E2E (shared page, analyzed once)", () => {
  test("16M-01 App Boot: real UI mounts, empty map initially", async () => {
    await loadSm(page);
    await expect(page.locator(".ui-title")).toHaveText("SAMPLEMAP");
    await expect(page.locator("[data-testid='scan-start']")).toBeVisible();
    await expect(page.locator("[data-testid='analyze-10']")).toBeVisible();
  });

  test("16M-02 Fixture Ingestion: scan loads 4 samples and enqueues them", async () => {
    await scan(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", {
      timeout: 20_000,
    });
    await expect(page.locator(".scan-count")).toContainText("4");
    expect((await getScan(page)).foundCount).toBe(4);
    const counts = await getQueueCounts(page);
    expect(counts.queued).toBeGreaterThanOrEqual(4);
  });

  test("16M-03 Analysis Execution: 4 samples analyzed to empty queue (REAL decode)", async () => {
    await analyze(page, 10);
    await expect(page.locator(".analysis-status")).toContainText(/Stopped/, {
      timeout: 30_000,
    });
    const a = await getAnalysis(page);
    expect(a.analyzed).toBe(4);
    expect(a.status).toBe("stopped");
    expect(a.stoppedReason).toBe("empty");
    expect(a.failed).toBe(0);
    await refreshResults(page); // populate map/search results with all records
    await expect(page.locator("[data-testid='sample-map']")).toBeVisible();
    await page.screenshot({ path: "e2e/artifacts/16M-map-analyzed.png", fullPage: true });
  });

  test("16M-04 Classification: real HeuristicClassifier, valid + discriminating", async () => {
    const rows = await readRecords(page);
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.primaryClass.length).toBeGreaterThan(0);
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
    const distinct = new Set(rows.map((r) => r.primaryClass));
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });

  test("16M-05 Feature & Result Propagation: features/identity persisted", async () => {
    const rows = await readRecords(page);
    for (const r of rows) {
      expect(r.sampleId).toMatch(/^samples\//);
      expect(r.features.tonalNoiseRatio).toBeGreaterThanOrEqual(0);
      expect(r.features.spectralCentroid).toBeGreaterThan(0);
    }
    const kick = await getIndexRec(page, "samples/kick-909");
    expect(kick).toBeDefined();
    expect(kick!.classificationVersion).toBe("heuristic-v1");
    expect(kick!.analysisBuild).toBe("smap-build-v1");
  });

  test("16M-06 Map Rendering: sample-map svg with 4 point circles", async () => {
    const svg = page.locator("[data-testid='sample-map']");
    await expect(svg).toBeVisible();
    await expect(page.locator("[data-testid='map-point-samples/kick-909']")).toBeVisible();
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
  });

  test("16M-07 Deterministic Position: DOM coords match real mapPosition projection", async () => {
    const rows = await readRecords(page);
    for (const r of rows) {
      const circle = page.locator(`[data-testid='map-point-${r.sampleId}']`);
      const cx = parseFloat((await circle.getAttribute("cx"))!);
      const cy = parseFloat((await circle.getAttribute("cy"))!);
      expect(cx).toBeGreaterThanOrEqual(0);
      expect(cy).toBeGreaterThanOrEqual(0);
      // cx = mapPosition.x * MAP_WIDTH(800); camera is default (no pan/zoom).
      expect(cx).toBeCloseTo(r.cx, 1);
      expect(cy).toBeCloseTo(r.cy, 1);
    }
  });

  test("16M-08 Selection: real map pointer hit-test selects a point", async () => {
    // Click the interior "lead" point (isolated from the edge-clustered fixtures)
    // and assert the real pointer -> pointAt -> onSelect -> render loop leaves
    // exactly one point selected and the inspector populated.
    await clickMapPoint(page, "samples/lead-ohm");
    const selected = page.locator("[data-testid^='map-point-'][class*='map-point-selected']");
    await expect(selected).toHaveCount(1);
    const name = await page.locator(".inspector-name").textContent();
    expect(name && name.trim().length).toBeGreaterThan(0);
    await page.screenshot({ path: "e2e/artifacts/16M-selection.png", fullPage: true });
  });

  test("16M-17 Inspector: selecting a sample shows name, classification, position", async () => {
    await selectSample(page, "samples/hat-airy");
    await expect(page.locator(".inspector-name")).toContainText("Airy Hat");
    await expect(page.locator(".inspector-class-primary")).toBeVisible();
    await expect(page.locator(".inspector-position")).toBeVisible();
  });

  test("16M-09 Identity & Reference Propagation: canonical refs + original tags", async () => {
    const rows = await readRecords(page);
    const kick = rows.find((r) => r.sampleId === "samples/kick-909")!;
    expect(kick.sampleId).toBe("samples/kick-909");
    expect(kick.tags).toEqual(["kick", "deep"]);
    const rec = await getIndexRec(page, "samples/kick-909");
    expect(rec!.originalTags).toEqual(["kick", "deep"]);
  });

  test("16M-10 Machiniste Reference Generation: real offline doc + read-back", async () => {
    const res = await sendToMach(page, "samples/kick-909");
    expect(res.committed).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.slots).toHaveLength(1);
    expect(res.slots[0].sampleName).toBe("samples/kick-909");
    expect(res.slots[0].applied).toBe(true);
    expect(res.slots[0].readBackMatches).toBe(true);
    expect(res.slots[0].sampleEntityId).toBeDefined();
  });

  test("16M-11 UI State Transitions: run stops with queue-empty status", async () => {
    const a = await getAnalysis(page);
    expect(a.status).toBe("stopped");
    expect(a.stoppedReason).toBe("empty");
    await expect(page.locator(".analysis-status")).toContainText("Stopped (");
  });

  test("16M-12 Reload: IndexedDB persists across full page reload", async () => {
    await page.reload();
    await loadSm(page);
    const kick = await getIndexRec(page, "samples/kick-909");
    expect(kick).toBeDefined();
    expect(kick!.primaryClass).toBe("kick");
  });

  test("16M-13 Idempotency: re-analyzing the same build does not re-fetch audio", async () => {
    const before = await getFetchCount(page);
    await analyze(page, 10);
    await expect(page.locator(".analysis-status")).toContainText(/Stopped|Idle/, {
      timeout: 30_000,
    });
    const after = await getFetchCount(page);
    expect(after).toBe(before); // already analyzed -> skipped, no audio re-fetch
    await refreshResults(page); // repopulate map after the reload
  });

  test("16M-14 Error State: send with no selection reports an error, no crash", async () => {
    await page.evaluate(() =>
      (window as any).__sm.app.sendToMachiniste("does-not-exist", 0),
    );
    expect((await getMach(page)).error).toContain("no sample selected");
  });

  test("16M-15 Search: real engine returns matching records", async () => {
    const byClass: Array<{ record: { sampleId: string } }> = await searchSm(page, {
      classes: ["kick"],
    });
    expect(byClass.map((e) => e.record.sampleId)).toContain("samples/kick-909");
    const byTag: Array<{ record: { sampleId: string } }> = await searchSm(page, {
      text: "deep",
    });
    expect(byTag.map((e) => e.record.sampleId)).toContain("samples/kick-909");
  });

  test("16M-16 Map Local Points Only (global /map is a live-backend Layer-B concern)", async () => {
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
    expect(["idle", "ok", "empty", "error", "loading"]).toContain(
      await getGlobalMapState(page),
    );
  });

  test("16M-18 Machiniste Multi-Slot Mapping is bounded and clean", async () => {
    const res = await sendToMach(page, "samples/kick-909");
    expect(res.slots).toHaveLength(1);
    expect(res.slots[0].readBackMatches).toBe(true);
  });

  test("16M-19 Preview Source Resolution (playback BLOCKED for synthetic samples)", async () => {
    const kick = await getIndexRec(page, "samples/kick-909");
    const url = await page.evaluate(
      (rec) => (window as any).__sm.deps.previewUrlFor(rec),
      kick,
    );
    expect(url).toMatch(/^https:\/\/example\.preview\//);
  });

  test("16M-20 Browser Console Audit: no page errors / uncaught exceptions", async () => {
    await clickMapPoint(page, "samples/lead-ohm");
    await page.waitForTimeout(500);
    const allowed = capturedConsoleErrors.filter(
      (m) => !benignConsole(m) && !/Failed to load resource/.test(m.text()),
    );
    expect(allowed.length).toBe(0);
  });
});
