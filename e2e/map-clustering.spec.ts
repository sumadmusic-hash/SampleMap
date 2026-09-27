import { test, expect, type Page } from "@playwright/test";

/**
 * MAP CLUSTERING / LOD (PoC) — REAL browser, REAL app, REAL renderer.
 *
 * The automatic background indexing analyses up to 1000 samples, so a
 * zoomed-out map must aggregate instead of painting one `<circle>` per point.
 *
 * Asserted against the rendered DOM:
 *  - a 500-point global map is painted as clusters, i.e. as far fewer nodes
 *    than 500, while every point is still drawn OR counted,
 *  - a cluster shows its COUNT and carries NO `data-sample-id`: a cluster is
 *    not a sample and can never be selected like one,
 *  - zooming in (camera only, no data change) progressively resolves them,
 *  - clicking a cluster zooms the camera onto it and selects NOTHING,
 *  - below the threshold nothing changes: every point is still its own circle.
 *
 * The points arrive through the normal `queryMapViewport` -> `globalMapPoints()`
 * path (`__sm.global.serveMany`), so the clustering layer sees production data.
 *
 * NOTE on the click test: it runs at zoom 1. The existing `pointAt` hit test
 * compares the pointer in BASE pixel units against camera-transformed screen
 * positions; both coincide only at zoom 1 / pan 0. That convention is existing
 * behaviour and is deliberately left untouched here, so the click is verified
 * where it is exact.
 */

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const serve = async (p: Page, count: number) => {
  await p.evaluate((n) => (window as any).__sm.global.serveMany(n), count);
  await p.evaluate(() => (window as any).__sm.app.refreshSearch());
  await p.waitForTimeout(250);
};

const clusterCount = (p: Page) =>
  p.evaluate(() => document.querySelectorAll("[data-cluster-cell]").length);

const pointCount = (p: Page) =>
  p.evaluate(
    () => document.querySelectorAll("circle[data-testid^='map-point-']").length,
  );

/** Points represented by the DOM: drawn singles + cluster counts. */
const paintedCoverage = (p: Page) =>
  p.evaluate(() => {
    let n = document.querySelectorAll("circle[data-testid^='map-point-']").length;
    for (const el of document.querySelectorAll("[data-cluster-count]")) {
      n += Number(el.getAttribute("data-cluster-count"));
    }
    return n;
  });

const maxClusterCount = (p: Page) =>
  p.evaluate(() =>
    Math.max(
      0,
      ...[...document.querySelectorAll("[data-cluster-count]")].map((el) =>
        Number(el.getAttribute("data-cluster-count")),
      ),
    ),
  );

const camera = (p: Page) => p.evaluate(() => (window as any).__sm.app.mapCamera);

const selectionState = (p: Page) =>
  p.evaluate(() => {
    const app = (window as any).__sm.app;
    return {
      focused: app.focused?.sampleId ?? null,
      selectedIds: [...(app.selectedSampleIds ?? [])],
    };
  });

/** Viewport centre of the largest painted cluster. */
const largestClusterCentre = (p: Page) =>
  p.evaluate(() => {
    let best: Element | undefined;
    let bestCount = -1;
    for (const el of document.querySelectorAll("[data-cluster-count]")) {
      const n = Number(el.getAttribute("data-cluster-count"));
      if (n > bestCount) {
        bestCount = n;
        best = el;
      }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, count: bestCount };
  });

test.beforeEach(async ({ browser }) => {
  // A fresh page per test: the camera starts at its default, so no test can
  // inherit a zoom level from the previous one.
  page = await browser.newPage();
  await page.goto("/harness.html");
  await loadSm(page);
  await page.evaluate(() => (window as any).__sm.ep7.grant());
  // The first-use overlay sits ON TOP of the map until the library has been
  // indexed once (same dismissal every other map spec performs). The points
  // under test come from the global read path, not from indexing.
  await page.locator("[data-testid='first-use-index']").click();
  await page.waitForTimeout(200);
});

test.afterEach(async () => {
  await page.close();
});

test("clustering: 500 points collapse into far fewer nodes, losslessly", async () => {
  const served = await page.evaluate(() => (window as any).__sm.global.serveMany(500));
  expect(served).toHaveLength(500);
  await page.evaluate(() => (window as any).__sm.app.refreshSearch());
  await page.waitForTimeout(250);

  // The app really holds all 500 global points...
  expect(await page.evaluate(() => (window as any).__sm.app.globalPoints.length)).toBe(500);

  // ... but the DOM does not paint 500 circles.
  const clusters = await clusterCount(page);
  const points = await pointCount(page);
  expect(clusters).toBeGreaterThan(0);
  expect(points + clusters).toBeLessThan(500);
  // Lossless: every point is drawn as itself or counted inside a cluster.
  expect(await paintedCoverage(page)).toBe(500);

  // No painted circle lost its sample id.
  expect(
    await page.evaluate(
      () =>
        document.querySelectorAll("circle[data-testid^='map-point-']:not([data-sample-id])")
          .length,
    ),
  ).toBe(0);
});

test("clustering: a cluster shows its count and is NOT a sample", async () => {
  await serve(page, 500);

  const cluster = await page.evaluate(() => {
    const el = document.querySelector("[data-cluster-cell]")!;
    return {
      testid: el.getAttribute("data-testid"),
      cell: el.getAttribute("data-cluster-cell"),
      count: Number(el.getAttribute("data-cluster-count")),
      hasSampleId: el.hasAttribute("data-sample-id"),
      anySampleIdInside: el.querySelector("[data-sample-id]") !== null,
      label: el.querySelector("text")?.textContent ?? "",
      title: el.querySelector("title")?.textContent ?? "",
    };
  });

  // A cluster is not a sample: no sample identity anywhere on it.
  expect(cluster.hasSampleId).toBe(false);
  expect(cluster.anySampleIdInside).toBe(false);
  expect(cluster.testid).toContain("map-cluster-");
  // The count is VISIBLE text, not only an attribute.
  expect(cluster.label).toBe(String(cluster.count));
  expect(cluster.count).toBeGreaterThanOrEqual(2);
  expect(cluster.title).toContain(String(cluster.count));
});

test("clustering: zooming in resolves the clusters progressively", async () => {
  await serve(page, 500);

  const before = await camera(page);
  expect(before.zoom).toBe(1);
  const maxAtZoom1 = await maxClusterCount(page);
  expect(maxAtZoom1).toBeGreaterThan(1);

  // Wheel-zoom only. No data changes, no reload: the re-projection is driven
  // purely by the camera. The pointer goes to the map's own centre.
  const centre = await page.evaluate(() => {
    const r = document.querySelector("svg.sample-map-svg")!.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(150);
  }
  const after = await camera(page);
  expect(after.zoom).toBeGreaterThan(before.zoom);
  await page.waitForTimeout(200);

  // The largest cluster got smaller, and the map is still lossless.
  expect(await maxClusterCount(page)).toBeLessThan(maxAtZoom1);
  expect(await paintedCoverage(page)).toBe(500);
});

test("clustering: clicking a cluster zooms in and selects nothing", async () => {
  await serve(page, 500);

  const target = await largestClusterCentre(page);
  expect(target).not.toBeNull();
  expect(target!.count).toBeGreaterThanOrEqual(2);

  const before = await selectionState(page);
  const camBefore = await camera(page);
  expect(before.focused).toBeNull();
  expect(before.selectedIds).toHaveLength(0);

  await page.mouse.click(target!.x, target!.y);
  await page.waitForTimeout(300);

  // The camera zoomed IN ...
  const camAfter = await camera(page);
  expect(camAfter.zoom).toBeGreaterThan(camBefore.zoom);
  // ... and absolutely nothing was selected: a cluster is not a sample.
  const after = await selectionState(page);
  expect(after).toEqual(before);
  expect(after.focused).toBeNull();
  expect(after.selectedIds).toHaveLength(0);
  // The focus pane did not open either.
  expect(await page.locator("[data-testid='preview-pane']").count()).toBe(0);
});

test("clustering: below the threshold every point renders as before", async () => {
  await serve(page, 3);

  // Three points: no clustering at all, three circles with their identities.
  expect(await clusterCount(page)).toBe(0);
  expect(await pointCount(page)).toBe(3);
  expect(await paintedCoverage(page)).toBe(3);

  const painted = await page.evaluate(() =>
    [...document.querySelectorAll("circle[data-testid^='map-point-']")].map((el) =>
      el.getAttribute("data-sample-id"),
    ),
  );
  expect(painted).toHaveLength(3);
  expect(painted.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  expect(new Set(painted).size).toBe(3);
});
