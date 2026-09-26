import { test, type Page } from "@playwright/test";

/**
 * STEP63R — Runtime Startup Timing Audit.
 *
 * Loads the REAL SampleMap harness (harness.html -> src/e2e/harness/main.ts)
 * three times and records:
 *   - navigation start -> first visible UI (`.app-shell` in DOM)
 *   - navigation start -> `window.__sm` ready (all services composed)
 *   - every `[sm-timing]` marker logged during startup
 *
 * This measures the OFFLINE harness startup path. The real app additionally
 * awaits OAuth, openFirstProject() and identity resolution (network); those are
 * separately instrumented in src/main.ts, src/ui/liveSession.ts, and
 * src/identity/authenticatedUser.ts for live sessions.
 */

interface TimingPoint {
  phase: string;
  sinceNavMs: number;
}

let page: Page;

async function navigateToHarness(p: Page) {
  const navT0 = Date.now();
  await p.goto("/harness.html", { waitUntil: "domcontentloaded" });
  return navT0;
}

test.describe.serial("STEP63R startup timing", () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test("T1 fresh load", async () => {
    const markers: TimingPoint[] = [];
    page.on("console", (msg) => {
      const t = msg.text();
      if (t.startsWith("[sm-timing]")) {
        markers.push({
          phase: t.slice("[sm-timing] ".length),
          sinceNavMs: 0,
        });
      }
    });

    const navT0 = await navigateToHarness(page);
    const firstRenderMs = Date.now();
    await page.waitForSelector(".app-shell", { timeout: 60_000 });
    const tRender = Date.now() - navT0;
    await page.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });
    const tReady = Date.now() - navT0;

    // STEP62 verification: at startup, no scan, no own-pass, no queue entries.
    const startupState = await page.evaluate(async () => {
      const sm = (window as any).__sm;
      const scan = { ...sm.app.scan };
      const analysis = { ...sm.app.analysis };
      const queueCounts: Record<string, number> = {};
      for (const s of ["queued", "processing", "analyzed", "failed", "skipped", "gone"]) {
        queueCounts[s] = await sm.queue.countByStatus(s);
      }
      return { scan, analysis, queueCounts, fetchCount: sm.fetchCount };
    });

    // eslint-disable-next-line no-console
    console.log(`[step63r] STEP62 startup state: ${JSON.stringify({ scanStatus: startupState.scan.status, ownDiscovered: startupState.scan.ownDiscovered, ownEnqueued: startupState.scan.ownEnqueued, foundCount: startupState.scan.foundCount, analysisStatus: startupState.analysis.status, queueCounts: startupState.queueCounts, fetchCount: startupState.fetchCount })}`);

    // eslint-disable-next-line no-console
    console.log(`[step63r] T1 fresh load | navigation->first-render: ${tRender.toFixed(0)}ms | navigation->__sm-ready: ${tReady.toFixed(0)}ms`);
    // eslint-disable-next-line no-console
    console.log(`[step63r] T1 markers (${markers.length}):`);
    for (const m of markers) {
      // eslint-disable-next-line no-console
      console.log(`[step63r]   ${m.phase}`);
    }
  });

  test("T2 reload with existing IndexedDB", async () => {
    const navT0 = Date.now();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".app-shell", { timeout: 60_000 });
    const tRender = Date.now() - navT0;
    await page.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });
    const tReady = Date.now() - navT0;
    // eslint-disable-next-line no-console
    console.log(`[step63r] T2 reload | navigation->first-render: ${tRender.toFixed(0)}ms | navigation->__sm-ready: ${tReady.toFixed(0)}ms`);
  });

  test("T3 second reload", async () => {
    const navT0 = Date.now();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".app-shell", { timeout: 60_000 });
    const tRender = Date.now() - navT0;
    await page.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });
    const tReady = Date.now() - navT0;
    // eslint-disable-next-line no-console
    console.log(`[step63r] T3 second reload | navigation->first-render: ${tRender.toFixed(0)}ms | navigation->__sm-ready: ${tReady.toFixed(0)}ms`);
  });
});