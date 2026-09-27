import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";

/**
 * MAP CLUSTERING / LOD — STRESS + VERIFICATION RUN (read-only measurement).
 *
 * This spec changes NO product code and asserts NO target values. It measures
 * what the implementation actually does with 500 and 1000 realistic map points
 * at zoom 1/2/4/8, checks the invariants, and dumps a raw JSON report.
 *
 * Every number in the report is read from the REAL rendered Chrome DOM (plus
 * the app's own input count) — never from a unit-test value.
 *
 * Camera control uses the app's own public `setMapCamera`, which calls
 * `notify()` -> a full synchronous `renderApp`. That is what makes the render
 * time measurable with `performance.now()` around the call.
 */

const ZOOMS = [1, 2, 4, 8];
const DATASETS = [500, 1000];
const SEED = 20260927;

let page: Page;

interface DomMeasurement {
  input: number;
  appGlobalPoints: number;
  appResults: number;
  zoom: number;
  camera: { zoom: number; panX: number; panY: number };
  points: number;
  clusters: number;
  renderEntries: number;
  coverage: number;
  maxCluster: number;
  clusterCountSum: number;
  totalSvgElements: number;
  circles: number;
  texts: number;
  svgTotalNodes: number;
  duplicateClusterCells: number;
  clustersWithSampleId: number;
  clustersWithSampleIdInside: number;
  pointsWithoutSampleId: number;
  nanCoords: number;
  clustersOutsideMap: number;
  pointsOutsideMap: number;
  renderMs: number;
}

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

/** Set the camera and measure everything the DOM shows afterwards. */
async function measureAtZoom(p: Page, zoom: number): Promise<DomMeasurement> {
  return p.evaluate((z) => {
    const app = (window as any).__sm.app;
    // Synchronous: setMapCamera -> notify() -> renderApp(root, app).
    const t0 = performance.now();
    app.setMapCamera({ zoom: z, panX: 0, panY: 0 });
    const renderMs = performance.now() - t0;

    const svg = document.querySelector("svg.sample-map-svg") as SVGSVGElement;
    const vb = (svg.getAttribute("viewBox") ?? "0 0 800 520").split(/\s+/).map(Number);
    const vbW = vb[2];
    const vbH = vb[3];

    const all = [...svg.querySelectorAll("*")];
    const clusters = [...svg.querySelectorAll("[data-cluster-cell]")];
    const points = [...svg.querySelectorAll("circle[data-testid^='map-point-']")];

    const counts = clusters.map((c) => Number(c.getAttribute("data-cluster-count")));
    const cells = clusters.map((c) => c.getAttribute("data-cluster-cell") ?? "");

    // Cluster positions live in the BASE coordinate space of the content group.
    const parseTranslate = (el: Element): { x: number; y: number } => {
      const t = el.getAttribute("transform") ?? "";
      const m = /translate\(\s*(-?[\d.eE+]+)[ ,]+(-?[\d.eE+]+)\s*\)/.exec(t);
      return { x: m ? Number(m[1]) : Number.NaN, y: m ? Number(m[2]) : Number.NaN };
    };
    const nanCoords =
      all.filter((el) => {
        const t = el.getAttribute("transform");
        const cx = el.getAttribute("cx");
        const cy = el.getAttribute("cy");
        return (
          (t !== null && t.includes("NaN")) ||
          (cx !== null && Number.isNaN(Number(cx))) ||
          (cy !== null && Number.isNaN(Number(cy)))
        );
      }).length;
    const clustersOutsideMap = clusters.filter((el) => {
      const { x, y } = parseTranslate(el);
      return !(x >= 0 && x <= vbW && y >= 0 && y <= vbH);
    }).length;
    const pointsOutsideMap = points.filter((el) => {
      const x = Number(el.getAttribute("cx"));
      const y = Number(el.getAttribute("cy"));
      return !(x >= 0 && x <= vbW && y >= 0 && y <= vbH);
    }).length;

    const clusterCountSum = counts.reduce((a, b) => a + b, 0);
    const cellsSet = new Set(cells);

    return {
      input: app.globalPoints.length + app.results.length,
      appGlobalPoints: app.globalPoints.length,
      appResults: app.results.length,
      zoom: app.mapCamera.zoom,
      camera: { ...app.mapCamera },
      points: points.length,
      clusters: clusters.length,
      renderEntries: points.length + clusters.length,
      coverage: points.length + clusterCountSum,
      maxCluster: counts.length ? Math.max(...counts) : 0,
      clusterCountSum,
      totalSvgElements: all.length,
      circles: svg.querySelectorAll("circle").length,
      texts: svg.querySelectorAll("text").length,
      svgTotalNodes: svg.querySelectorAll("*").length,
      duplicateClusterCells: cells.length - cellsSet.size,
      clustersWithSampleId: clusters.filter((c) => c.hasAttribute("data-sample-id")).length,
      clustersWithSampleIdInside: clusters.filter(
        (c) => c.querySelector("[data-sample-id]") !== null,
      ).length,
      pointsWithoutSampleId: points.filter((c) => !c.hasAttribute("data-sample-id")).length,
      nanCoords,
      clustersOutsideMap,
      pointsOutsideMap,
      renderMs,
    };
  }, zoom);
}

const serve = async (p: Page, n: number, order?: "natural" | "reversed" | "shuffled") =>
  p.evaluate(
    ([count, ord, seed]) => (window as any).__sm.global.serveRealistic(count as number, { seed: seed as number, order: ord as any }),
    [n, order ?? "natural", SEED] as [number, string, number],
  );

/** Full DOM fingerprint of every cluster, for the determinism comparison. */
const clusterFingerprint = (p: Page) =>
  p.evaluate(() => {
    const svg = document.querySelector("svg.sample-map-svg")!;
    const rows: string[] = [];
    for (const c of [...svg.querySelectorAll("[data-cluster-cell]")]) {
      const t = c.getAttribute("transform") ?? "";
      const m = /translate\(\s*(-?[\d.eE+]+)[ ,]+(-?[\d.eE+]+)\s*\)/.exec(t);
      // Round to 9 decimals: float noise below that is not a behaviour
      // difference, but any real centroid change shows up.
      const x = m ? Number(Number(m[1]).toFixed(9)) : "NaN";
      const y = m ? Number(Number(m[2]).toFixed(9)) : "NaN";
      rows.push(
        [
          c.getAttribute("data-cluster-cell"),
          c.getAttribute("data-cluster-count"),
          x,
          y,
          c.getAttribute("data-member-samples") ?? "",
        ].join("|"),
      );
    }
    return rows.sort().join("\n");
  });

const entryFingerprint = (p: Page) =>
  p.evaluate(() => {
    const svg = document.querySelector("svg.sample-map-svg")!;
    const ids: string[] = [];
    for (const el of svg.querySelectorAll("[data-cluster-cell]")) ids.push("C:" + el.getAttribute("data-cluster-cell"));
    for (const el of svg.querySelectorAll("circle[data-testid^='map-point-']")) ids.push("P:" + el.getAttribute("data-sample-id"));
    return ids.sort().join("\n");
  });

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
  await loadSm(page);
  await page.evaluate(() => (window as any).__sm.ep7.grant());
  await page.locator("[data-testid='first-use-index']").click();
  await page.waitForTimeout(150);
});

test.afterEach(async () => {
  await page.close();
});

test("A. measurement matrix: 500/1000 realistic points at zoom 1/2/4/8", async () => {
  const report: Record<string, DomMeasurement[]> = {};

  for (const n of DATASETS) {
    report[String(n)] = [];
    const served = await serve(page, n);
    expect(served).toHaveLength(n);
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await page.waitForTimeout(300);

    for (const z of ZOOMS) {
      const m = await measureAtZoom(page, z);
      // Let the browser settle so a later sample is not affected.
      await page.waitForTimeout(120);
      report[String(n)].push(m);
    }
  }

  mkdirSync("e2e/artifacts", { recursive: true });
  writeFileSync("e2e/artifacts/stress-report.json", JSON.stringify(report, null, 2));

  // Console matrix (the JSON file above is the raw source).
  const rows: string[] = [];
  for (const n of DATASETS) {
    for (const m of report[String(n)]) {
      rows.push(
        [
          String(n).padEnd(6),
          String(m.zoom).padEnd(5),
          String(m.input).padEnd(6),
          String(m.points).padEnd(7),
          String(m.clusters).padEnd(8),
          String(m.renderEntries).padEnd(14),
          String(m.coverage).padEnd(8),
          m.maxCluster.toString().padEnd(5),
          m.renderMs.toFixed(1).padStart(7) + "ms",
          m.totalSvgElements.toString().padEnd(6),
        ].join(""),
      );
    }
  }
  console.log(
    "\ndataset zoom  input  points  clusters  renderEntries  coverage  maxCl  renderMs  svgEls\n" +
      rows.join("\n"),
  );

  // Every row was measured; the invariants are asserted in test B.
  expect(report["500"]).toHaveLength(4);
  expect(report["1000"]).toHaveLength(4);
});

test("A2. DOM matches the product clustering result exactly", async () => {
  // The DOM is the deliverable, but the source of truth is the product
  // function. Rendered entries must equal the product's entries 1:1, and the
  // product's entryCoverage() must equal the DOM-derived coverage.
  const problems: string[] = [];
  const rows: string[] = [];

  for (const n of DATASETS) {
    await serve(page, n);
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await page.waitForTimeout(250);

    for (const z of ZOOMS) {
      const m = await measureAtZoom(page, z);
      const prod = (await page.evaluate(
        (zz) => (window as any).__sm.cluster.inspect(zz as number),
        z,
      )) as {
        merged: number;
        entries: Array<{ kind: string; cell: string | null; count: number; x: number; y: number }>;
        coverage: number;
      };

      const prodPoints = prod.entries.filter((e) => e.kind === "point").length;
      const prodClusters = prod.entries.filter((e) => e.kind === "cluster").length;
      const prodMax = prod.entries.reduce((m2, e) => Math.max(m2, e.count), 0);

      const tag = `${n}@${m.zoom}`;
      if (prod.merged !== m.input) problems.push(`${tag}: product merged ${prod.merged} != DOM input ${m.input}`);
      if (prodPoints !== m.points) problems.push(`${tag}: product points ${prodPoints} != DOM ${m.points}`);
      if (prodClusters !== m.clusters) problems.push(`${tag}: product clusters ${prodClusters} != DOM ${m.clusters}`);
      if (prod.coverage !== m.coverage) problems.push(`${tag}: entryCoverage ${prod.coverage} != DOM coverage ${m.coverage}`);
      if (prodMax !== m.maxCluster) problems.push(`${tag}: maxCluster product ${prodMax} != DOM ${m.maxCluster}`);

      rows.push(
        [
          tag.padEnd(9),
          "product:".padEnd(8),
          `points=${prodPoints}`.padEnd(14),
          `clusters=${prodClusters}`.padEnd(15),
          `entryCoverage=${prod.coverage}`.padEnd(21),
          `maxCluster=${prodMax}`,
        ].join(" "),
      );
    }
  }

  console.log("\n" + rows.join("\n"));
  if (problems.length) console.log("DOM/PRODUCT MISMATCH:\n" + problems.join("\n"));
  expect(problems, `DOM vs product mismatches:\n${problems.join("\n")}`).toEqual([]);
});

test("B. invariants across the whole matrix", async () => {
  const findings: string[] = [];

  for (const n of DATASETS) {
    await serve(page, n);
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await page.waitForTimeout(250);

    for (const z of ZOOMS) {
      const m = await measureAtZoom(page, z);
      const tag = `${n}@${m.zoom}`;

      // 1. nothing is lost
      if (m.coverage !== m.input) findings.push(`${tag}: coverage ${m.coverage} != input ${m.input}`);
      if (m.points + m.clusterCountSum !== m.input)
        findings.push(`${tag}: points+sum(count) ${m.points}+${m.clusterCountSum} != ${m.input}`);
      // 2. no duplicate cells
      if (m.duplicateClusterCells !== 0)
        findings.push(`${tag}: ${m.duplicateClusterCells} duplicate cluster cells`);
      // 3. no cluster carries a sample identity
      if (m.clustersWithSampleId !== 0) findings.push(`${tag}: cluster has data-sample-id`);
      if (m.clustersWithSampleIdInside !== 0)
        findings.push(`${tag}: cluster contains data-sample-id`);
      // 4. every plain point keeps its sample id
      if (m.pointsWithoutSampleId !== 0)
        findings.push(`${tag}: ${m.pointsWithoutSampleId} points without data-sample-id`);
      // 5. no NaN coordinates anywhere
      if (m.nanCoords !== 0) findings.push(`${tag}: ${m.nanCoords} elements with NaN coords`);
      // 6. nothing painted outside the map
      if (m.clustersOutsideMap !== 0)
        findings.push(`${tag}: ${m.clustersOutsideMap} clusters outside the map`);
      if (m.pointsOutsideMap !== 0)
        findings.push(`${tag}: ${m.pointsOutsideMap} points outside the map`);
      // 7. the camera really is at the requested zoom
      if (m.zoom !== z) findings.push(`${tag}: camera zoom is ${m.zoom}`);
    }
  }

  if (findings.length) console.log("FINDINGS:\n" + findings.join("\n"));
  expect(findings, `invariant violations:\n${findings.join("\n")}`).toEqual([]);
});

test("C. cluster click: camera zooms, nothing is selected", async () => {
  await serve(page, 1000);
  await page.evaluate(() => (window as any).__sm.app.refreshSearch());
  await page.waitForTimeout(300);

  const before = await page.evaluate(() => {
    const a = (window as any).__sm.app;
    return {
      camera: { ...a.mapCamera },
      focused: a.focused?.sampleId ?? null,
      selected: [...(a.selectedSampleIds ?? [])],
      preview: document.querySelectorAll("[data-testid='preview-pane']").length,
    };
  });

  // A real, currently painted cluster with at least 2 members.
  const target = await page.evaluate(() => {
    const svg = document.querySelector("svg.sample-map-svg")!;
    let best: Element | undefined;
    let bestCount = -1;
    for (const el of svg.querySelectorAll("[data-cluster-count]")) {
      const c = Number(el.getAttribute("data-cluster-count"));
      if (c > bestCount) {
        bestCount = c;
        best = el;
      }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return {
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      count: bestCount,
      cell: best!.getAttribute("data-cluster-cell"),
    };
  });
  expect(target).not.toBeNull();
  expect(target!.count).toBeGreaterThanOrEqual(2);

  await page.mouse.move(target!.x, target!.y);
  await page.waitForTimeout(250);
  const hover = await page.evaluate(() => {
    const tip = [...document.querySelectorAll("*")].find(
      (el) =>
        el.className &&
        typeof el.className === "string" &&
        el.className.includes("map-tooltip") &&
        (el as HTMLElement).style.display === "block",
    ) as HTMLElement | undefined;
    return {
      text: tip?.textContent ?? null,
      hoveredClusters: document.querySelectorAll(".map-cluster-hovered").length,
      hoveredPoints: document.querySelectorAll(".map-point-hovered").length,
      // A cluster hover must not name a sample.
      hasSampleIdInTooltip: tip ? tip.querySelector("[data-sample-id]") !== null : false,
    };
  });
  console.log("HOVER", JSON.stringify(hover));

  await page.mouse.click(target!.x, target!.y);
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => {
    const a = (window as any).__sm.app;
    return {
      camera: { ...a.mapCamera },
      focused: a.focused?.sampleId ?? null,
      selected: [...(a.selectedSampleIds ?? [])],
      preview: document.querySelectorAll("[data-testid='preview-pane']").length,
      selectedDots: document.querySelectorAll(".map-point-selected, .map-point-in-selection").length,
    };
  });
  console.log("CLICK", JSON.stringify({ before, after, target }, null, 2));

  // The camera zoomed ...
  expect(after.camera.zoom).toBeGreaterThan(before.camera.zoom);
  // ... and NOTHING was selected.
  expect(after.focused).toBeNull();
  expect(after.selected).toEqual([]);
  expect(after.preview).toBe(0);
  expect(after.selectedDots).toBe(0);
  expect(hover.hoveredClusters).toBe(1);
  expect(hover.hoveredPoints).toBe(0);
  expect(hover.text).toContain("samples");
  expect(hover.text).not.toContain("samples/");

  // Does that cluster resolve now? Compare its members against the new cells.
  const resolution = await page.evaluate((cell) => {
    const svg = document.querySelector("svg.sample-map-svg")!;
    const stillThere = svg.querySelector(`[data-cluster-cell="${cell}"]`);
    return {
      zoom: (window as any).__sm.app.mapCamera.zoom,
      sameCellStillACluster: stillThere !== null,
      sameCellCount: stillThere ? Number(stillThere.getAttribute("data-cluster-count")) : null,
      totalClusters: svg.querySelectorAll("[data-cluster-cell]").length,
      totalPoints: svg.querySelectorAll("circle[data-testid^='map-point-']").length,
      coverage:
        svg.querySelectorAll("circle[data-testid^='map-point-']").length +
        [...svg.querySelectorAll("[data-cluster-count]")].reduce(
          (a, e) => a + Number(e.getAttribute("data-cluster-count")),
          0,
        ),
    };
  }, target!.cell);
  console.log("RESOLUTION AFTER CLICK", JSON.stringify(resolution));
  expect(resolution.coverage).toBe(1000);
});

test("D. existing map interaction still works", async () => {
  await serve(page, 1000);
  await page.evaluate(() => (window as any).__sm.app.refreshSearch());
  await page.waitForTimeout(300);

  // --- wheel zoom up and down -------------------------------------------
  const centre = await page.evaluate(() => {
    const r = document.querySelector("svg.sample-map-svg")!.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const zoomSeq: number[] = [];
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(120);
    zoomSeq.push(await page.evaluate(() => (window as any).__sm.app.mapCamera.zoom));
  }
  expect(zoomSeq[2]).toBeGreaterThan(zoomSeq[0]);
  expect(zoomSeq[1]).toBeGreaterThan(zoomSeq[0]);

  for (let i = 0; i < 3; i++) {
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(120);
  }
  const backDown = await page.evaluate(() => (window as any).__sm.app.mapCamera.zoom);
  expect(backDown).toBeLessThan(zoomSeq[2]);

  // --- pan ---------------------------------------------------------------
  // Pan only exists ABOVE zoom 1: at zoom 1 the map exactly fills the
  // viewport and the §11 clamp pins pan to 0. Zoom in first, then drag
  // up-left, which is the direction the clamp allows.
  await page.evaluate(() => (window as any).__sm.app.setMapCamera({ zoom: 2, panX: 0, panY: 0 }));
  await page.waitForTimeout(150);
  // A press ON an entry never pans (that is §9/§24: drag must not swallow
  // selection), so the drag has to start on empty map surface. Find such a
  // spot instead of assuming the centre is empty.
  const empty = await page.evaluate(() => {
    const svg = document.querySelector("svg.sample-map-svg")!;
    const r = svg.getBoundingClientRect();
    // Every ENTRY centre (points AND clusters) is a no-pan zone.
    const centres: Array<{ x: number; y: number }> = [];
    for (const el of [
      ...svg.querySelectorAll("circle[data-testid^='map-point-']"),
      ...svg.querySelectorAll("[data-cluster-cell]"),
    ]) {
      const b = el.getBoundingClientRect();
      centres.push({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    }
    let best: { x: number; y: number; d: number } | null = null;
    for (let gy = 0; gy <= 40; gy++) {
      for (let gx = 0; gx <= 40; gx++) {
        const x = r.x + (r.width * gx) / 40;
        const y = r.y + (r.height * gy) / 40;
        const d = Math.min(...centres.map((c) => Math.hypot(c.x - x, c.y - y)));
        if (best === null || d > best.d) best = { x, y, d };
      }
    }
    return best;
  });
  console.log("LARGEST GAP TO ANY ENTRY", JSON.stringify(empty));
  // The gap must exceed the cluster hit radius, otherwise a press there would
  // hit an entry and (by design) never start a pan.
  expect(empty!.d, "no empty map surface to start a pan drag").toBeGreaterThan(18);
  const panBefore = await page.evaluate(() => ({ ...(window as any).__sm.app.mapCamera }));
  await page.mouse.move(empty!.x, empty!.y);
  // Let the hover (tooltip + hit test) settle before pressing; dispatching
  // move+down back to back can land the press before the pointermove.
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.mouse.move(empty!.x - 120, empty!.y - 80, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const panAfter = await page.evaluate(() => ({ ...(window as any).__sm.app.mapCamera }));
  const densePan = await page.evaluate(() => ({
    camera: { ...(window as any).__sm.app.mapCamera },
    selected: [...((window as any).__sm.app.selectedSampleIds ?? [])],
  }));
  console.log("PAN ON DENSE MAP @zoom2", JSON.stringify({ panBefore, ...densePan }));

  // --- pan on a SPARSE map: this is the "does the feature still work" check
  // The dense attempt above is affected by the pre-existing camera/hit-test
  // coordinate space (see the report), which is deliberately NOT changed
  // here. On a sparse map the hit test cannot capture the press, so a drag
  // must pan.
  await serve(page, 3);
  await page.evaluate(() => (window as any).__sm.app.refreshSearch());
  await page.waitForTimeout(250);
  await page.evaluate(() => (window as any).__sm.app.setMapCamera({ zoom: 2, panX: 0, panY: 0 }));
  await page.waitForTimeout(200);
  const sparseCentre = await page.evaluate(() => {
    const r = document.querySelector("svg.sample-map-svg")!.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const sparseBefore = await page.evaluate(() => ({ ...(window as any).__sm.app.mapCamera }));
  await page.mouse.move(sparseCentre.x, sparseCentre.y);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.mouse.move(sparseCentre.x - 90, sparseCentre.y - 45, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const sparsePan = await page.evaluate(() => ({ ...(window as any).__sm.app.mapCamera }));
  console.log("PAN ON SPARSE MAP @zoom2", JSON.stringify({ sparseBefore, sparsePan }));
  expect(sparsePan).not.toEqual(sparseBefore);
  expect(sparsePan.zoom).toBe(sparseBefore.zoom);
  expect(sparsePan.panX).toBeLessThan(0);

  // Back to the dense set for the remaining checks.
  await serve(page, 1000);
  await page.evaluate(() => (window as any).__sm.app.refreshSearch());
  await page.waitForTimeout(250);
  // The pan only moves the view: no sample data changed.
  const denseCoverage = await page.evaluate(() => {
    const svg = document.querySelector("svg.sample-map-svg")!;
    return (
      svg.querySelectorAll("circle[data-testid^='map-point-']").length +
      [...svg.querySelectorAll("[data-cluster-count]")].reduce(
        (a, e) => a + Number(e.getAttribute("data-cluster-count")),
        0,
      )
    );
  });
  expect(denseCoverage).toBe(1000);

  // --- 1 -> 2 -> 4 -> 8 -> 4 -> 2 -> 1 round trip is deterministic --------
  const trip: number[] = [];
  for (const z of [2, 4, 8, 4, 2, 1]) {
    await measureAtZoom(page, z);
    await page.waitForTimeout(100);
    const m = await page.evaluate(() => {
      const svg = document.querySelector("svg.sample-map-svg")!;
      return {
        zoom: (window as any).__sm.app.mapCamera.zoom,
        points: svg.querySelectorAll("circle[data-testid^='map-point-']").length,
        clusters: svg.querySelectorAll("[data-cluster-cell]").length,
      };
    });
    trip.push(m.points, m.clusters);
  }
  const [p2, c2, p4, c4, p8, c8, p4b, c4b, p2b, c2b, p1b, c1b] = trip;
  expect(p4b).toBe(p4);
  expect(c4b).toBe(c4);
  expect(p2b).toBe(p2);
  expect(c2b).toBe(c2);
  // Back at zoom 1 the same rendering as the start.
  const z1 = await measureAtZoom(page, 1);
  expect(p1b).toBe(z1.points);
  expect(c1b).toBe(z1.clusters);
  console.log("ROUNDTRIP", JSON.stringify({ p2, c2, p4, c4, p8, c8 }));

  // --- a plain point is still selectable --------------------------------
  const pointTarget = await page.evaluate(() => {
    const svg = document.querySelector("svg.sample-map-svg")!;
    const el = svg.querySelector("circle[data-testid^='map-point-']");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      id: el.getAttribute("data-sample-id"),
    };
  });
  expect(pointTarget).not.toBeNull();
  await page.mouse.click(pointTarget!.x, pointTarget!.y);
  await page.waitForTimeout(250);
  // A GLOBAL point is not a local batch member: the click opens the global
  // inspection (preview) via inspectGlobalPoint and must NOT add it to
  // selectedSampleIds.
  const sel = await page.evaluate(() => ({
    selected: [...((window as any).__sm.app.selectedSampleIds ?? [])],
    inspection: (window as any).__sm.app.globalInspection?.sampleId ?? null,
    preview: (window as any).__sm.app.globalInspection?.point?.sampleId ?? null,
    cameraZoom: (window as any).__sm.app.mapCamera.zoom,
  }));
  console.log("POINT CLICK", JSON.stringify({ pointTarget, sel }));
  expect(sel.inspection).toBe(pointTarget!.id);
  expect(sel.preview).toBe(pointTarget!.id);
  expect(sel.selected).toEqual([]);
  expect(sel.cameraZoom).toBe(1);
});

test("E. determinism: same data twice, and shuffled input order", async () => {
  const runs: Record<string, { entries: string; clusters: string; counts: string }> = {};

  for (const [label, order] of [
    ["run1-natural", "natural"],
    ["run2-natural", "natural"],
    ["run3-reversed", "reversed"],
    ["run4-shuffled", "shuffled"],
  ] as const) {
    await serve(page, 1000, order);
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await page.waitForTimeout(300);
    for (const z of ZOOMS) {
      await measureAtZoom(page, z);
      await page.waitForTimeout(120);
      // DOM fingerprint (what is actually painted) ...
      const fp = await clusterFingerprint(page);
      const ep = await entryFingerprint(page);
      // ... plus the PRODUCT result including the per-cluster MEMBER
      // assignment, which the DOM deliberately never exposes.
      const prod = await page.evaluate(
        (zz) => (window as any).__sm.cluster.inspect(zz as number),
        z,
      );
      const memberFp = (prod as { entries: Array<{ cell: string | null; count: number; members: string[] }> })
        .entries
        .filter((e) => e.cell !== null)
        .map((e) => `${e.cell}|${e.count}|${[...e.members].sort().join(",")}`)
        .sort()
        .join("\n");
      runs[`${label}@${z}`] = {
        entries: ep,
        clusters: fp,
        counts: memberFp,
      };
    }
  }

  const diffs: string[] = [];
  for (const z of ZOOMS) {
    const a = runs[`run1-natural@${z}`];
    for (const other of [`run2-natural@${z}`, `run3-reversed@${z}`, `run4-shuffled@${z}`]) {
      const b = runs[other];
      if (a.entries !== b.entries) diffs.push(`${other}@${z}: entry set differs`);
      if (a.clusters !== b.clusters) diffs.push(`${other}@${z}: cluster fingerprint differs`);
      if (a.counts !== b.counts) diffs.push(`${other}@${z}: cluster counts differ`);
    }
  }
  mkdirSync("e2e/artifacts", { recursive: true });
  writeFileSync(
    "e2e/artifacts/stress-determinism.json",
    JSON.stringify(
      Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { entries: v.entries.length, clusters: v.clusters.length }])),
      null,
      2,
    ),
  );
  if (diffs.length) console.log("DETERMINISM DIFFS:\n" + diffs.join("\n"));
  expect(diffs, `non-determinism:\n${diffs.join("\n")}`).toEqual([]);
});

test("F. CLUSTER_MIN_POINTS boundary: 10 / 23 / 24 / 25", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const problems: string[] = [];

  // (1) FULLY COINCIDENT points: the exact switch probe. A cell holds at most
  // one cluster, so below the threshold nothing clusters and from the
  // threshold upwards exactly one cluster must appear.
  for (const n of [10, 23, 24, 25]) {
    await page.evaluate(
      (count) => (window as any).__sm.global.serveCoincident(count),
      n,
    );
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await page.waitForTimeout(250);

    const m = await measureAtZoom(page, 1);
    const expectClusters = n >= 24 ? 1 : 0;
    const expectEntries = n >= 24 ? 1 : n;
    rows.push({
      set: "coincident",
      input: m.input,
      points: m.points,
      clusters: m.clusters,
      renderEntries: m.renderEntries,
      coverage: m.coverage,
      maxCluster: m.maxCluster,
    });
    if (m.coverage !== n) problems.push(`coincident ${n}: coverage ${m.coverage} != ${n}`);
    if (m.clusters !== expectClusters)
      problems.push(`coincident ${n}: ${m.clusters} clusters, expected ${expectClusters}`);
    if (m.renderEntries !== expectEntries)
      problems.push(`coincident ${n}: ${m.renderEntries} entries, expected ${expectEntries}`);
  }

  // (2) REALISTIC spread: clustering may or may not trigger, but the map must
  // stay complete and never cluster below the threshold.
  for (const n of [10, 23, 24, 25]) {
    await serve(page, n);
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await page.waitForTimeout(250);

    const m = await measureAtZoom(page, 1);
    rows.push({
      set: "realistic",
      input: m.input,
      points: m.points,
      clusters: m.clusters,
      renderEntries: m.renderEntries,
      coverage: m.coverage,
      maxCluster: m.maxCluster,
    });
    if (m.coverage !== m.input)
      problems.push(`realistic ${n}: coverage ${m.coverage} != ${m.input}`);
    if (n < 24 && m.clusters > 0)
      problems.push(`realistic ${n}: ${m.clusters} clusters below the threshold`);
    if (n < 24 && m.renderEntries !== n)
      problems.push(`realistic ${n}: ${m.renderEntries} entries, expected ${n} (no clustering)`);
  }

  console.log("MIN_POINTS", JSON.stringify(rows, null, 2));
  if (problems.length) console.log("BOUNDARY PROBLEMS:\n" + problems.join("\n"));
  expect(problems, `boundary problems:\n${problems.join("\n")}`).toEqual([]);
});
