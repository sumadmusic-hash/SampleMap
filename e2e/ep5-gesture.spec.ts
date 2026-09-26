import { test, expect, type Page } from "@playwright/test";

/**
 * STEP16R E-P5A T6 (optional) — Gesture e2e: drag-pan + wheel-zoom move ONLY
 * the runtime camera. They must NOT mutate persisted map positions (<circle>
 * cx/cy), the persisted `mapPosition` records, layout, focus, or selection.
 */

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const ALL = [
  "samples/kick-909",
  "samples/hat-airy",
  "samples/bass-sub",
  "samples/lead-ohm",
];

const positionsOf = (p: Page, ids: string[]) =>
  p.evaluate((sampleIds) => {
    const out: Record<string, [string, string]> = {};
    for (const id of sampleIds) {
      const el = document.querySelector(`[data-testid='map-point-${id}']`);
      out[id] = el
        ? [el.getAttribute("cx")!, el.getAttribute("cy")!]
        : ["gone", "gone"];
    }
    return out;
  }, ids);

const persistedPositions = (p: Page, ids: string[]) =>
  p.evaluate(async (sampleIds) => {
    const out: Record<string, { x: number; y: number }> = {};
    for (const id of sampleIds) {
      const rec = await (window as any).__sm.index.get(id);
      out[id] = rec && rec.mapPosition ? rec.mapPosition : { x: -1, y: -1 };
    }
    return out;
  }, ids);

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("STEP16R E-P5A T6 gesture safety (shared page)", () => {
  test("EP5A-09 Drag-pan and wheel-zoom move only the camera", async () => {
    await loadSm(page);

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

    // Focus + selection fixed up front; must survive every gesture. Focus is
    // set via the harness because some fixture points (kick/bass) map to the
    // exact SVG corner pixel and are not clickable at default zoom.
    await page.evaluate(
      async (ids) => {
        for (const id of ids) {
          const rec = await (window as any).__sm.index.get(id);
          (window as any).__sm.app.toggleMultiSelect(rec);
        }
      },
      [ALL[0], ALL[1]],
    );
    await page.evaluate((id) => (window as any).__sm.selectSample(id), ALL[2]);
    expect(
      await page.evaluate(() => (window as any).__sm.app.focusedSampleId),
    ).toBe(ALL[2]);

    const before = {
      positions: await positionsOf(page, ALL),
      persisted: await persistedPositions(page, ALL),
      selected: await page.evaluate(
        () => (window as any).__sm.app.selectedSampleIds,
      ),
      focused: await page.evaluate(
        () => (window as any).__sm.app.focusedSampleId,
      ),
      camera: await page.evaluate(() => (window as any).__sm.app.mapCamera),
      count: await page.locator("[data-testid^='map-point-']").count(),
    };

    // A safe EMPTY drag start: inside the SVG's PAINTED area (accounting for
    // the viewBox letterbox), on a pixel that hits the svg element itself, and
    // farther than any point's hit radius.
    const dragStart = await page.evaluate((ids) => {
      const svg = document.querySelector("[data-testid='sample-map']")!;
      const r = svg.getBoundingClientRect();
      const vw = 800, vh = 520;
      const scale = Math.min(r.width / vw, r.height / vh);
      const ox = (r.width - vw * scale) / 2;
      const oy = (r.height - vh * scale) / 2;
      const pts: Array<{ x: number; y: number }> = [];
      for (const id of ids) {
        const el = document.querySelector(`[data-testid='map-point-${id}']`);
        const b = el!.getBoundingClientRect();
        pts.push({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      }
      let best: { x: number; y: number } = { x: r.x + ox, y: r.y + oy };
      let bestD = -1;
      const grid = 24;
      for (let gx = 0; gx * grid <= vw * scale; gx++) {
        for (let gy = 0; gy * grid <= vh * scale; gy++) {
          const c = { x: r.x + ox + gx * grid, y: r.y + oy + gy * grid };
          const top = document.elementFromPoint(c.x, c.y);
          const onSvg = !!top && (top.closest?.("[data-testid='sample-map']") != null);
          if (!onSvg) continue;
          const d = Math.min(...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y)));
          if (d > bestD) {
            bestD = d;
            best = c;
          }
        }
      }
      return best;
    }, ALL);

    // Wheel-zoom in first: at zoom 1 the map exactly fills the viewport, so
    // `clampPan` (§11) pins pan to (0,0) — dragging is only observable once
    // the map is zoomed in.
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.wheel(0, -240);
    const afterZoom = {
      camera: await page.evaluate(() => (window as any).__sm.app.mapCamera),
    };
    expect(afterZoom.camera.zoom).toBeGreaterThan(before.camera.zoom);

    // Drag-pan the (now zoomed-in) empty surface. Dragging up-left yields
    // negative pan clicks, which the clamp allows at zoom > 1.
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragStart.x - 90, dragStart.y - 45, { steps: 8 });
    await page.mouse.up();

    const afterPan = {
      camera: await page.evaluate(() => (window as any).__sm.app.mapCamera),
    };
    expect(afterPan.camera).not.toEqual(afterZoom.camera);
    expect(afterPan.camera.zoom).toBe(afterZoom.camera.zoom);
    expect(afterPan.camera.panX).toBeLessThan(0);

    // Nothing but the camera changed.
    expect(await positionsOf(page, ALL)).toEqual(before.positions);
    expect(await persistedPositions(page, ALL)).toEqual(before.persisted);
    expect(
      await page.evaluate(() => (window as any).__sm.app.selectedSampleIds),
    ).toEqual(before.selected);
    expect(
      await page.evaluate(() => (window as any).__sm.app.focusedSampleId),
    ).toBe(before.focused);
    expect(
      await page.locator("[data-testid^='map-point-']").count(),
    ).toBe(before.count);
  });
});