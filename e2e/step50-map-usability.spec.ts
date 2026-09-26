import { test, expect, type Page } from "@playwright/test";

/**
 * STEP50 — Map spatial-distribution usability checks against the OFFLINE
 * harness (harness.html, V1-frozen heuristic pipeline + 4 synthetic fixtures).
 *
 * These are INTERACTION / RENDERING invariants, not real-population evidence
 * (real-population distribution is measured statically over the real 1439-sample
 * analyzed corpus in scripts/step50-map-distribution.ts). They pin in the real
 * browser the previously unit-only guarantees:
 *
 *   - zoom never rewrites stored point coordinates (cx/cy attrs stay identical);
 *   - point on-screen radius is a SCREEN-space constant (zoom-independent);
 *   - class filtering never moves surviving points and never leaves stale points;
 *   - clicking a point at zoom>1 still focuses correctly;
 *   - search + class filter compose; Clear restores the identical full set;
 *   - no unhandled application errors across the session.
 *
 * Fixtures (heuristic-v1 classifications, see STEP49 §6): kick-909→kick,
 * hat-airy→kick, bass-sub→bass, lead-ohm→guitar; class predicates match
 * primary OR secondary classes.
 */

let page: Page;

const KICK = "samples/kick-909";
const LEAD = "samples/lead-ohm";
const HAT = "samples/hat-airy";
const BASS = "samples/bass-sub";
const ALL = [LEAD, KICK, HAT, BASS];

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

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

const resultIds = (p: Page) =>
  p.evaluate(() =>
    (window as any).__sm.app.results.map((r: any) => r.record.sampleId),
  );

/**
 * Screen-space FILL diameter (px) of a map point at the current zoom,
 * computed from the circle's `r` attribute and the effective CTM scale —
 * decoupled from the CSS stroke (a scaled hairline that is presentation-only
 * and intentionally excluded from the zoom-invariant size contract).
 */
const circleScreenFillWidthPx = (p: Page, id: string): Promise<number | null> =>
  p.evaluate((sampleId) => {
    const el = document.querySelector<SVGCircleElement>(
      `[data-testid='map-point-${sampleId}']`,
    );
    if (!el) return null;
    const r = parseFloat(el.getAttribute("r") ?? "0");
    const scale = el.getCTM()?.a ?? 1;
    return 2 * r * scale;
  }, id);

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("STEP50 map usability (offline harness fixtures)", () => {
  test("50M-01 load + index + analyze → 4 map points, base positions recorded", async () => {
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
    const base = await positionsOf(page, ALL);
    expect(Object.values(base).every((p) => p[0] !== "gone")).toBe(true);
    // on-screen point fill diameter at zoom×1 ≈ 5px (r=2.5px screen-space constant,
    // STEP76: reduced from r=5px so 800+ point clouds stay separable). The SVG is
    // laid out at a container scale of ~0.775, so the window is the same relative
    // 0.7x–1.3x band the former r=5px check used (7–13px around a 10px diameter).
    const w = await circleScreenFillWidthPx(page, KICK);
    expect(w).not.toBeNull();
    expect(w!).toBeGreaterThan(3.5);
    expect(w!).toBeLessThan(6.5);
  });

  test("50M-02 zoom 1→2→4→1: stored coords untouched, screen radius constant", async () => {
    const base = await positionsOf(page, ALL);
    const baseWidth = await circleScreenFillWidthPx(page, KICK);
    const zoomAt = async () =>
      page.evaluate(() => (window as any).__sm.app.mapCamera.zoom);

    // Controller-driven zoom steps (deterministic; the [-]/[+] buttons are the
    // same controller path and are covered by FP-08/E-P5A).
    await page.evaluate(() => (window as any).__sm.app.zoomMapBy(2));
    await expect(page.locator("[data-testid='map-zoom-label']")).toHaveText("200%");
    expect(await zoomAt()).toBe(2);
    await page.evaluate(() => (window as any).__sm.app.zoomMapBy(2));
    await expect(page.locator("[data-testid='map-zoom-label']")).toHaveText("400%");
    expect(await zoomAt()).toBe(4);

    const zoomed = await positionsOf(page, ALL);
    // cx/cy attributes are the stored map-sourced base pixels — unchanged.
    expect(zoomed).toEqual(base);

    // Screen-space radius must NOT grow with zoom (screen constant).
    const w4 = await circleScreenFillWidthPx(page, KICK);
    expect(w4).not.toBeNull();
    expect(Math.abs(w4! - baseWidth!)).toBeLessThan(1.0);

    // The map + points stay interactable after a zoom: a wheel-zoom AT the point
// (anchor-under-pointer) keeps it on-screen, and a click on the (still same)
// screen position focuses the sample — the §30 "zoom into dense region" path.
    const clientPosAt = (id: string) =>
      page.evaluate((pid) => {
        const el = document.querySelector(
          `[data-testid='map-point-${pid}']`,
        ) as SVGCircleElement;
        const svg = el.ownerSVGElement as SVGSVGElement;
        const pt = svg.createSVGPoint();
        pt.x = Number(el.getAttribute("cx"));
        pt.y = Number(el.getAttribute("cy"));
        const p = pt.matrixTransform(svg.getScreenCTM()!);
        return { x: p.x, y: p.y };
      }, id);

    await page.evaluate(() => (window as any).__sm.app.resetMapView());
    await expect(page.locator("[data-testid='map-zoom-label']")).toHaveText("100%");
    const startPos = await clientPosAt(KICK);
    await page.mouse.move(startPos.x, startPos.y);
    await page.waitForTimeout(60);
    // one wheel gesture factor 4 ≈ deltaY -924 (renderer: exp(-deltaY*0.0015)).
    await page.mouse.wheel(0, -924);
    await expect(page.locator("[data-testid='map-zoom-label']")).toHaveText("400%");
    const endPos = await clientPosAt(KICK);
    // anchor-under-pointer: the point barely moved on screen.
    expect(Math.abs(endPos.x - startPos.x)).toBeLessThan(2);
    expect(Math.abs(endPos.y - startPos.y)).toBeLessThan(2);
    // click the exact same screen position → focuses (pointer already hovering).
    await page.mouse.click(startPos.x + (endPos.x - startPos.x) / 2, startPos.y + (endPos.y - startPos.y) / 2);
    await expect
      .poll(() =>
        page.evaluate(
          (id) => (window as any).__sm.app.focusedSampleId === id,
          KICK,
        ),
      )
      .toBe(true);

    // Zoom back out to the full map: coords still identical, label reset path.
    await page.evaluate(() => (window as any).__sm.app.zoomMapBy(0.25)); // 4 → 1
    await expect(page.locator("[data-testid='map-zoom-label']")).toHaveText("100%");
    expect(await zoomAt()).toBe(1);
    expect(await positionsOf(page, ALL)).toEqual(base);
  });

  test("50M-03 filter kick: survivors keep exact coordinates, others removed, no stale points", async () => {
    const base = await positionsOf(page, ALL);
    await page.evaluate(() => (window as any).__sm.app.setClasses(new Set(["kick"])));
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    const ids = await resultIds(page);
    expect(ids.length).toBe(3);
    expect(ids).toContain(KICK);
    expect(ids).not.toContain(LEAD);

    const filtered = await positionsOf(page, ALL);
    expect(filtered[KICK]).toEqual(base[KICK]);
    expect(filtered[HAT]).toEqual(base[HAT]); // hat-airy primary kick (fixture)
    expect(filtered[BASS]).toEqual(base[BASS]); // bass via secondary kick
    expect(filtered[LEAD]).toEqual(["gone", "gone"]);
    // no stale/duplicate rendered circles
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(3);
    await expect(page.locator(`[data-testid='map-point-${LEAD}']`)).toHaveCount(0);
  });

  test("50M-04 search + class filter compose; Clear restores the exact full set", async () => {
    // On entry the kick class filter from 50M-03 is still active (serial state).
    const pre = await positionsOf(page, ALL);
    expect(pre[LEAD]).toEqual(["gone", "gone"]);

    // kick class filter (active) + text search "kick" still compose (AND):
    // text search matches name/owner/tag only, so it narrows 3 → 1 (kick-909).
    await page.evaluate(() => (window as any).__sm.app.setSearch("kick"));
    const ids = await resultIds(page);
    expect(ids).toEqual([KICK]);
    await page.evaluate(() => (window as any).__sm.app.setSearch(""));

    // Clear resets BOTH the search box and the class filter → exact full set back,
    // surviving points keep their stored coordinates byte-for-byte.
    await page.locator("[data-testid='search-clear']").click();
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
    const post = await positionsOf(page, ALL);
    expect(post[KICK]).toEqual(pre[KICK]); // survivors unchanged
    expect(post[HAT]).toEqual(pre[HAT]);
    expect(post[BASS]).toEqual(pre[BASS]);
    expect(post[LEAD]).not.toEqual(["gone", "gone"]); // restored, not ghosted
    expect(await page.locator("[data-testid='search-clear']").isDisabled()).toBe(true);
  });

  test("50M-05 console audit: no unhandled application errors across the session", async () => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await page.screenshot({ path: "e2e/artifacts/step50-map-usability.png", fullPage: true });
    expect(errors).toEqual([]);
  });
});