import {
  test,
  expect,
  type Page,
  type ConsoleMessage,
} from "@playwright/test";

/**
 * Step 17 — Corrupt persisted data hardening, verified end-to-end in the real
 * browser against the OFFLINE harness (harness.html -> src/e2e/harness/main.ts).
 *
 * Threat model (F1): `IndexStore.put` enforces only the no-audio-bytes
 * invariant, not the full record shape. A future/third-party writer, manual
 * IndexedDB edit or partial version migration can persist a structurally
 * malformed `SampleIndexRecord`. This spec proves the app stays alive and the
 * malformed rows are excluded from every read path (search, map, browse) —
 * including across a full page reload (corrupt data present at boot).
 */

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const scan = (p: Page) => p.evaluate(() => (window as any).__sm.scan());
const analyze = (p: Page, budget = 10) =>
  p.evaluate((b) => (window as any).__sm.analyze(b), budget);
const getAll = (p: Page) =>
  p.evaluate(() => (window as any).__sm.index.getAll());
const getOne = (p: Page, id: string) =>
  p.evaluate((s) => (window as any).__sm.index.get(s), id);
const refresh = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.refreshSearch());
const searchText = (p: Page, q: string) =>
  p.evaluate((query) => (window as any).__sm.search.search({ text: query }), q);

/** Inject a structurally-invalid row through the typed store (passes the
 *  no-audio-bytes guard but violates the record shape). */
const injectViaStore = (p: Page, row: unknown) =>
  p.evaluate((r) => (window as any).__sm.index.put(r), row);

/** Inject a structurally-invalid row directly into the underlying IndexedDB,
 *  simulating external/undiagnosed corruption. */
const injectViaRawIdb = (p: Page, row: unknown) =>
  p.evaluate(
    (r) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("samplemap");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("samples", "readwrite");
          tx.objectStore("samples").put(r);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
        req.onerror = () => reject(req.error);
      }),
    row,
  );

const benignConsole = (m: ConsoleMessage) =>
  /favicon|Failed to load resource:.*net::ERR|404 \(Not Found\)/.test(m.text());

const capturedConsoleErrors: ConsoleMessage[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && capturedConsoleErrors.push(m));
  await page.goto("/harness.html");
  await loadSm(page);
  await scan(page);
  await analyze(page);
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("Step 17 : corrupt persisted records never crash the app", () => {
  test("17C-01 valid records present (baseline ingestion analyzed)", async () => {
    const records = (await getAll(page)) as Array<{ status: string }>;
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.status === "analyzed")).toBe(true);
  });

  test("17C-02 a structurally-invalid row is excluded by get (undefined, no crash)", async () => {
    await injectViaStore(page, {
      sampleId: "corrupt/missing-fields",
      name: 123,
    });
    await injectViaStore(page, {
      sampleId: "corrupt/nan-confidence",
      name: "NaN Kick",
      primaryClass: "kick",
      confidence: NaN,
    });
    await injectViaStore(page, {
      sampleId: "corrupt/no-features",
      name: "No Features",
      primaryClass: "kick",
      confidence: 0.9,
      status: "analyzed",
    });
    expect(await getOne(page, "corrupt/missing-fields")).toBeUndefined();
    expect(await getOne(page, "corrupt/nan-confidence")).toBeUndefined();
    expect(await getOne(page, "corrupt/no-features")).toBeUndefined();
  });

  test("17C-03 malformed rows are excluded from getAll and the real search engine", async () => {
    const ids = ((await getAll(page)) as Array<{ sampleId: string }>).map(
      (r) => r.sampleId,
    );
    expect(ids).not.toContain("corrupt/missing-fields");
    expect(ids).not.toContain("corrupt/nan-confidence");
    expect(ids).not.toContain("corrupt/no-features");
    const hits = (await searchText(page, "NaN")) as Array<{
      record: { sampleId: string };
    }>;
    expect(hits.map((h) => h.record.sampleId)).not.toContain(
      "corrupt/nan-confidence",
    );
  });

  test("17C-04 UI refreshSearch + re-render stays alive with corrupt data present", async () => {
    await refresh(page);
    await expect(page.locator(".ui-title")).toHaveText("SAMPLEMAP");
    const pointCount = await page.locator("[data-testid^='map-point-']").count();
    expect(pointCount).toBeGreaterThan(0);
  });

  test("17C-05 raw-IndexedDB corruption (external) is also quarantined on read", async () => {
    await injectViaRawIdb(page, {
      sampleId: "raw/external-corrupt",
      name: { not: "a string" },
    });
    await refresh(page);
    expect(await getOne(page, "raw/external-corrupt")).toBeUndefined();
    const ids = ((await getAll(page)) as Array<{ sampleId: string }>).map(
      (r) => r.sampleId,
    );
    expect(ids).not.toContain("raw/external-corrupt");
    await expect(page.locator(".ui-title")).toHaveText("SAMPLEMAP");
  });

  test("17C-06 full page reload with corrupt data in the database still boots cleanly", async () => {
    await page.reload();
    await loadSm(page);
    await refresh(page);
    await expect(page.locator(".ui-title")).toHaveText("SAMPLEMAP");
    const ids = ((await getAll(page)) as Array<{ sampleId: string }>).map(
      (r) => r.sampleId,
    );
    expect(ids).not.toContain("corrupt/missing-fields");
    expect(ids).not.toContain("raw/external-corrupt");
    const pointCount = await page.locator("[data-testid^='map-point-']").count();
    expect(pointCount).toBeGreaterThan(0);
  });

  test("17C-07 no uncaught page errors surfaced during the corruption scenarios", async () => {
    const real = capturedConsoleErrors.filter((m) => !benignConsole(m));
    const texts = real.map((m) => m.text());
    expect(texts.filter((t) => /TypeError|InternalError|RangeError/u.test(t))).toEqual([]);
  });
});