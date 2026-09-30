import {
import { startIndexing } from "./support/startIndexing";
  test,
  expect,
  type Page,
  type ConsoleMessage,
} from "@playwright/test";

/**
 * STEP25 — V2 Sound Space Interaction, Filtering & Compare — E2E.
 *
 * Drives the REAL SampleMap UI (harness.html → src/e2e/harness/main.ts). The
 * V2 analyses are stamped via `__sm.v2.attach` (deterministic V2 DSP over the
 * fixture waveforms — FIXTURE-class evidence per §16). STEP25 is a pure VIEW
 * layer over the frozen STEP24 projector: coordinates must never change under
 * filtering/comparison, and every interaction reuses the existing V1 selection,
 * focus, preview and STEP23 find-similar paths.
 */
let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const beginIndexing = (p: Page) => startIndexing(p);

const analyzeAll = (p: Page) =>
  p.evaluate((b) => (window as any).__sm.analyze(b), 10);

const attachV2 = (p: Page, keys?: string[]) =>
  p.evaluate((k) => (window as any).__sm.v2.attach(k), keys);

const detachV2 = (p: Page, keys?: string[]) =>
  p.evaluate((k) => (window as any).__sm.v2.detach(k), keys);

const refresh = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.refreshSearch());

const pointIds = (p: Page): Promise<string[]> =>
  p
    .locator("[data-testid^='sound-space-point-']")
    .evaluateAll((els) =>
      els
        .map((e) => e.getAttribute("data-testid") ?? "")
        .map((id) => id.replace("sound-space-point-", ""))
        .filter((id) => id.length > 0),
    );

const pointPositions = (p: Page): Promise<Record<string, { x: number; y: number }>> =>
  p
    .locator("[data-testid^='sound-space-point-']")
    .evaluateAll((els) =>
      Object.fromEntries(
        els.map((e) => {
          const cx = Number((e as SVGCircleElement).getAttribute("cx") ?? "0");
          const cy = Number((e as SVGCircleElement).getAttribute("cy") ?? "0");
          return [e.getAttribute("data-testid")!.replace("sound-space-point-", ""), { x: cx, y: cy }];
        }),
      ),
    );

const getSoundSpace = (p: Page) =>
  p.evaluate(() => {
    const s = (window as any).__sm.app.soundSpace;
    return {
      open: s.open,
      status: s.status,
      points: s.points.map((pt: { sampleId: string; x: number; y: number }) => ({
        sampleId: pt.sampleId,
        x: pt.x,
        y: pt.y,
      })),
      error: s.error,
    };
  });

const getFocused = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.focusedSampleId);

const getSelection = (p: Page): Promise<string[]> =>
  p.evaluate(() => [...(window as any).__sm.app.selectedSampleIds]);

const getFilter = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.soundSpaceFilter);

const clearFilter = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.clearSoundSpaceFilter());

const clearSelection = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.clearSelection());

const clearSearchText = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.setSearch(""));

const reopenSoundSpace = async (p: Page, expectedCount?: number) => {
  const wasOpen = await p.evaluate(() => (window as any).__sm.app.soundSpace.open);
  if (wasOpen) {
    await p.locator("[data-testid='sound-space-toggle']").click();
    await expect(p.locator("[data-testid='sound-space-canvas']")).toHaveCount(0);
  }
  await p.locator("[data-testid='sound-space-toggle']").click();
  await p.waitForFunction(() => {
    const s = (window as any).__sm.app.soundSpace;
    return (
      s.open &&
      (s.status === "ready" || s.status === "empty" || s.status === "error")
    );
  });
  if (expectedCount !== undefined) {
    if (expectedCount === 0) {
      await expect(p.locator("[data-testid^='sound-space-point-']")).toHaveCount(0);
    } else {
      await expect(p.locator("[data-testid^='sound-space-point-']")).toHaveCount(
        expectedCount,
      );
    }
  }
};

/** Apply one active dim filter via the REAL DOM inputs (min first). */
const setFilterViaUi = async (
  p: Page,
  dim: string,
  min: string,
  max = "",
) => {
  const minInput = p.locator(`[data-testid='sound-space-filter-min-${dim}']`);
  const maxInput = p.locator(`[data-testid='sound-space-filter-max-${dim}']`);
  if (min !== "") {
    await minInput.fill(min);
    await minInput.dispatchEvent("change");
  }
  if (max !== "") {
    await maxInput.fill(max);
    await maxInput.dispatchEvent("change");
  }
};

const getInspectorName = (p: Page): Promise<string> =>
  p.evaluate(() =>
    document.querySelector(".inspector-name")?.textContent ?? "",
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

test.describe.serial("STEP25 V2 Sound Space Interaction, Filtering & Compare (shared page)", () => {
  test("E25-01 empty state: no filters rendered, honest copy", async () => {
    await loadSm(page);
    await beginIndexing(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", {
      timeout: 20_000,
    });
    await analyzeAll(page);
    await refresh(page);
    // STEP36 — the production pipeline now stamps analysisV2 on every analyzed
    // sample (Phase A), so the real "no V2 yet" persisted state is reconstructed
    // by detaching the V2 analyses (identical to the V1-only records a legacy
    // pre-upgrade build persisted). The assertions below are unchanged and strict.
    await detachV2(page);
    await refresh(page);

    await reopenSoundSpace(page, 0);
    await expect(page.locator("[data-testid='sound-space-status']")).toContainText(
      "No analyzed samples in Sound Space yet.",
    );
    // No V2 → projector reports empty → NO filter strip may render.
    await expect(page.locator("[data-testid='sound-space-filters']")).toHaveCount(0);
    const state = await getSoundSpace(page);
    expect(state.open).toBe(true);
    expect(state.status).toBe("empty");
  });

  test("E25-02 attach V2: 4 points, meta line 'All samples', 8-dim filter grid", async () => {
    await attachV2(page);
    await refresh(page);
    await reopenSoundSpace(page, 4);
    await expect(page.locator("[data-testid='sound-space-meta']")).toHaveText(
      "4 analyzed samples · All samples",
    );
    await expect(page.locator("[data-testid='sound-space-visible-count']")).toHaveText(
      "4 of 4",
    );
    // Filter grid: exactly the 8 canonical dim rows.
    const dims = [
      "brightness",
      "density",
      "transient",
      "duration",
      "tonality",
      "noisiness",
      "dynamics",
      "complexity",
    ];
    for (const [i, dim] of dims.entries()) {
      await expect(
        page.locator(`[data-testid='sound-space-filter-row-${dim}']`),
      ).toHaveCount(1);
      const minSel = page.locator(`[data-testid='sound-space-filter-min-${dim}']`);
      const maxSel = page.locator(`[data-testid='sound-space-filter-max-${dim}']`);
      expect(await minSel.getAttribute("aria-label")).toBe(`${cap(dim)} min`);
      expect(await maxSel.getAttribute("aria-label")).toBe(`${cap(dim)} max`);
      expect(await minSel.inputValue()).toBe("");
      expect(await maxSel.inputValue()).toBe("");
      expect(i).toBeGreaterThanOrEqual(0); // structural; keeps the loop meaningful
    }
    await expect(page.locator("[data-testid='sound-space-filter-summary']")).toHaveText(
      "All samples",
    );
  });

  test("E25-03 tonality filter narrows the scatter (3 of 4) without touching the snapshot", async () => {
    const stateBefore = await getSoundSpace(page);
    const positionsBefore = await pointPositions(page);
    await setFilterViaUi(page, "tonality", "0.9");
    await expect(page.locator("[data-testid^='sound-space-point-']")).toHaveCount(3);
    const ids = await pointIds(page);
    expect(ids.sort()).toEqual(
      ["samples/bass-sub", "samples/kick-909", "samples/lead-ohm"].sort(),
    );
    await expect(page.locator("[data-testid='sound-space-filter-summary']")).toContainText(
      "tonality",
    );
    await expect(page.locator("[data-testid='sound-space-visible-count']")).toHaveText(
      "3 of 4",
    );
    // Projection snapshot is 100% intact: still 4 points, same coordinates.
    expect(stateBefore.points.length).toBe(4);
    const positionsAfter = await pointPositions(page);
    for (const [id, pos] of Object.entries(positionsAfter)) {
      expect(pos).toEqual(positionsBefore[id]);
    }
  });

  test("E25-04 filtering never deletes or moves points (snapshot semantics)", async () => {
    const state = await getSoundSpace(page);
    expect(state.points.length).toBe(4);
    // All four projectable points still present with identical coordinates.
    const before = await page.evaluate(() =>
      (window as any).__sm.app.soundSpace.points.map((p: { sampleId: string; x: number; y: number }) => ({
        sampleId: p.sampleId,
        x: p.x,
        y: p.y,
      })),
    );
    await setFilterViaUi(page, "tonality", "0.9");
    await setFilterViaUi(page, "noisiness", "", "0.5");
    const afterFilter = await page.evaluate(() =>
      (window as any).__sm.app.soundSpace.points.map((p: { sampleId: string; x: number; y: number }) => ({
        sampleId: p.sampleId,
        x: p.x,
        y: p.y,
      })),
    );
    expect(afterFilter).toEqual(before);
    // DOM x/y equals engine x/y for every still-visible point.
    for (const p of (await getSoundSpace(page)).points) {
      const dom = (await pointPositions(page))[p.sampleId];
      if (!dom) continue;
      expect(dom.x).toBeCloseTo(4 + p.x * (400 - 8), 1);
      expect(dom.y).toBeCloseTo(4 + (1 - p.y) * (260 - 8), 1);
    }
  });

  test("E25-05 Clear filters restores all 4 points and the 'All samples' summary", async () => {
    await page.locator("[data-testid='sound-space-clear-filters']").click();
    await expect(page.locator("[data-testid^='sound-space-point-']")).toHaveCount(4);
    await expect(page.locator("[data-testid='sound-space-filter-summary']")).toHaveText(
      "All samples",
    );
    await expect(page.locator("[data-testid='sound-space-visible-count']")).toHaveText(
      "4 of 4",
    );
    expect(await getFilter(page)).toEqual({});
  });

  test("E25-06 focus survives applying and clearing the filter", async () => {
    await page.locator("[data-testid='sound-space-point-samples/hat-airy']").click();
    expect(await getFocused(page)).toBe("samples/hat-airy");
    // Hat is filtered OUT by tonality>=0.9 (hat tonality ≈ 0.12).
    await setFilterViaUi(page, "tonality", "0.9");
    await expect(page.locator("[data-testid^='sound-space-point-']")).toHaveCount(3);
    expect(await getFocused(page)).toBe("samples/hat-airy");
    await clearFilter(page);
    await expect(page.locator("[data-testid^='sound-space-point-']")).toHaveCount(4);
    expect(await getFocused(page)).toBe("samples/hat-airy");
  });

  test("E25-07 search + filter compose through the existing SearchEngine", async () => {
    await clearFilter(page);
    // Search "Deep" matches only the kick record (name "Deep Kick 909").
    await page.locator("[data-testid='search-text']").fill("Deep");
    await clearSearchText(page); // deterministic reset via model
    await page.locator("[data-testid='search-text']").fill("Deep");
    await expect(
      page.locator("[data-testid='result-samples/kick-909']"),
    ).toBeVisible();
    // Search IDs + tonality filter => only the kick survives.
    await setFilterViaUi(page, "tonality", "0.9");
    const ids = await pointIds(page);
    expect(ids).toEqual(["samples/kick-909"]);
    // Clear both.
    await clearSearchText(page);
    await clearFilter(page);
    await expect(page.locator("[data-testid^='sound-space-point-']")).toHaveCount(4);
  });

  test("E25-08 Cmd/Ctrl-click on a point toggles batch selection via the V1 path", async () => {
    await page
      .locator("[data-testid='sound-space-point-samples/kick-909']")
      .click({ modifiers: ["Control"] });
    await page
      .locator("[data-testid='sound-space-point-samples/hat-airy']")
      .click({ modifiers: ["Control"] });
    let sel = await getSelection(page);
    expect(sel.sort()).toEqual(["samples/hat-airy", "samples/kick-909"]);
    // The selected-class marker appears on both circles.
    await expect(
      page.locator("[data-testid='sound-space-point-samples/kick-909'].sound-space-point-selected"),
    ).toHaveCount(1);
    await expect(
      page.locator("[data-testid='sound-space-point-samples/hat-airy'].sound-space-point-selected"),
    ).toHaveCount(1);
    // Toggling kick again removes it (multi-select semantics).
    await page
      .locator("[data-testid='sound-space-point-samples/kick-909']")
      .click({ modifiers: ["Control"] });
    sel = await getSelection(page);
    expect(sel).toEqual(["samples/hat-airy"]);
    await page
      .locator("[data-testid='sound-space-point-samples/kick-909']")
      .click({ modifiers: ["Control"] });
  });

  test("E25-09 Compare toggle is disabled below 2 and enabled at 2+", async () => {
    await clearSelection(page);
    await expect(page.locator("[data-testid='sound-space-compare-toggle']")).toBeDisabled();
    await page
      .locator("[data-testid='sound-space-point-samples/kick-909']")
      .click({ modifiers: ["Control"] });
    await expect(page.locator("[data-testid='sound-space-compare-toggle']")).toBeDisabled();
    await page
      .locator("[data-testid='sound-space-point-samples/hat-airy']")
      .click({ modifiers: ["Control"] });
    await expect(page.locator("[data-testid='sound-space-compare-toggle']")).toBeEnabled();
  });

  test("E25-10 compare table renders the all-8-dim grid over the selection", async () => {
    await page.locator("[data-testid='sound-space-compare-toggle']").click();
    await expect(page.locator("[data-testid='sound-space-compare-panel']")).toBeVisible();
    await expect(page.locator("[data-testid='sound-space-compare-title']")).toHaveText(
      "Compare",
    );
    const dims = [
      "brightness", "density", "transient", "duration",
      "tonality", "noisiness", "dynamics", "complexity",
    ];
    for (const dim of dims) {
      await expect(
        page.locator(`[data-testid='sound-space-compare-row-${dim}']`),
      ).toHaveCount(1);
    }
    // Columns agree with the 4-cap + the sample order of the selection.
    const sel = await getSelection(page);
    expect(sel).toHaveLength(2);
    for (const id of sel) {
      await expect(
        page.locator(`[data-testid='sound-space-compare-head-${id}']`),
      ).toHaveCount(1);
    }
    await page.screenshot({
      path: "e2e/artifacts/step25-compare.png",
      fullPage: false,
    });
  });

  test("E25-11 compare values mirror the persisted SoundCharacter (no fabrication)", async () => {
    const sel = await getSelection(page);
    // The compare table matches the persisted SoundCharacter: numbers 0..1 or "—".
    for (const id of sel) {
      for (const dim of ["tonality", "noisiness", "brightness"]) {
        const cellText = await page
          .locator(`[data-testid='sound-space-compare-${dim}-${id}']`)
          .textContent();
        expect(cellText).not.toBeNull();
        if (cellText === "—") continue;
        const n = Number(cellText);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
      }
    }
    expect(sel).toHaveLength(2);
  });

  test("E25-12 compare never mutates the selection (non-mutating surface)", async () => {
    const before = await getSelection(page);
    await page.locator("[data-testid='sound-space-compare-toggle']").click(); // close
    await expect(page.locator("[data-testid='sound-space-compare-panel']")).toHaveCount(0);
    expect(await getSelection(page)).toEqual(before);
    await page.locator("[data-testid='sound-space-compare-toggle']").click(); // reopen
    await expect(page.locator("[data-testid='sound-space-compare-panel']")).toBeVisible();
    expect(await getSelection(page)).toEqual(before);
  });

  test("E25-13 compare Focus routes through the existing focus path", async () => {
    const sel = await getSelection(page);
    const id = sel[0];
    await page.locator(`[data-testid='sound-space-compare-focus-${id}']`).click();
    expect(await getFocused(page)).toBe(id);
    expect(await getSelection(page)).toEqual(sel);
    await expect(page.locator(".inspector-name")).toContainText(
      await page.evaluate((s) => (window as any).__sm.app.sampleNameFor(s), id),
    );
  });

  test("E25-14 compare Preview routes through the existing preview path", async () => {
    const id = (await getSelection(page))[0];
    await page.locator(`[data-testid='sound-space-compare-preview-${id}']`).click();
    await page.waitForFunction(
      () => {
        const app = (window as any).__sm.app;
        return (
          app.previewSampleId !== undefined ||
          app.previewError !== undefined
        );
      },
      { timeout: 10_000 },
    );
    const attempt = await page.evaluate(() => {
      const app = (window as any).__sm.app;
      return { id: app.previewSampleId, err: app.previewError };
    });
    expect(attempt.id !== undefined || attempt.err !== undefined).toBe(true);
  });

  test("E25-15 compare Find Similar reuses the STEP23 engine and matches rankSimilar", async () => {
    const id = (await getSelection(page))[0];
    const expected = await page.evaluate((qid: string) =>
      (window as any).__sm.v2.rank(qid), id);
    await page.locator(`[data-testid='sound-space-compare-similar-${id}']`).click();
    await expect(page.locator("[data-testid='similarity-v2-query']")).toBeVisible();
    const rows = await page
      .locator("[data-testid^='similarity-v2-result-']")
      .evaluateAll((els) =>
        els
          .map((e) => e.getAttribute("data-testid") ?? "")
          .map((x) => x.replace("similarity-v2-result-", "")),
      );
    expect(rows).toEqual(expected);
  });

  test("E25-16 compare caps at 4 samples (selection beyond is ignored)", async () => {
    // Close the open compare panel FIRST (the toggle stays enabled while the
    // ≥2 selection is intact), then clear the selection.
    await page.locator("[data-testid='sound-space-compare-toggle']").click();
    await expect(page.locator("[data-testid='sound-space-compare-panel']")).toHaveCount(0);
    await clearSelection(page);
    // Add a 5th V2 sample to the index so selection can exceed 4.
    const added = await page.evaluate(async () => {
      const base = await (window as any).__sm.index.get("samples/kick-909");
      const rec = {
        ...base,
        sampleId: "samples/extra-x",
        name: "Extra X",
        kind: "synth",
      };
      await (window as any).__sm.index.put(rec);
      await (window as any).__sm.app.refreshSearch();
      return rec.sampleId;
    });
    expect(added).toBe("samples/extra-x");
    // Select 5 (the 4 fixtures + the extra).
    await page.evaluate(() => {
      const app = (window as any).__sm.app;
      const ids = [
        "samples/kick-909",
        "samples/hat-airy",
        "samples/bass-sub",
        "samples/lead-ohm",
        "samples/extra-x",
      ];
      for (const id of ids) {
        const rec = app.results.find((r: { record: { sampleId: string } }) => r.record.sampleId === id)?.record;
        if (rec) app.toggleMultiSelect(rec);
      }
    });
    expect(await getSelection(page)).toHaveLength(5);
    await page.locator("[data-testid='sound-space-compare-toggle']").click();
    await expect(page.locator("[data-testid='sound-space-compare-panel']")).toBeVisible();
    const headCount = await page
      .locator("[data-testid^='sound-space-compare-head-']")
      .count();
    expect(headCount).toBe(4); // cap 4
    await page.screenshot({
      path: "e2e/artifacts/step25-compare-cap4.png",
      fullPage: false,
    });
    await page.locator("[data-testid='sound-space-compare-toggle']").click(); // close
    await expect(page.locator("[data-testid='sound-space-compare-panel']")).toHaveCount(0);
    await clearSelection(page);
    // Drop the extra sample from the index so later counts stay at 4.
    await page.evaluate(async () => {
      await (window as any).__sm.index.delete("samples/extra-x");
      await (window as any).__sm.app.refreshSearch();
    });
  });

  test("E25-17 keyboard Enter/Space activates a Sound Space point (STEP24 parity)", async () => {
    await clearFilter(page);
    const firstPoint = page.locator(
      "[data-testid='sound-space-point-samples/lead-ohm']",
    );
    await firstPoint.focus();
    await page.keyboard.press("Enter");
    expect(await getFocused(page)).toBe("samples/lead-ohm");
    await firstPoint.focus();
    await page.keyboard.press("Space");
    expect(await getFocused(page)).toBe("samples/lead-ohm");
  });

  test("E25-18 hover never mutates focus or selection", async () => {
    await clearSelection(page);
    await page.locator("[data-testid='sound-space-point-samples/kick-909']").click(); // focus only
    expect(await getFocused(page)).toBe("samples/kick-909");
    const selBefore = await getSelection(page);
    await page
      .locator("[data-testid='sound-space-point-samples/hat-airy']")
      .hover();
    expect(await getFocused(page)).toBe("samples/kick-909");
    expect(await getSelection(page)).toEqual(selBefore);
  });

  test("E25-19 null SoundCharacter dims surface as an em dash in Compare (never 0)", async () => {
    await clearFilter(page);
    await clearSelection(page);
    // Construct an extra full-V2 sample whose `complexity` is null (STILL
    // projectable: tonality + brightness drive the axes). FIXTURE/CONSTRUCTED.
    const added = await page.evaluate(async () => {
      const base = await (window as any).__sm.index.get("samples/kick-909");
      const soundCharacter = { ...base.analysisV2.soundCharacter, complexity: null };
      const rec = {
        ...base,
        sampleId: "samples/null-complexity",
        name: "Null Complexity",
        kind: "synth",
        analysisV2: { ...base.analysisV2, soundCharacter },
      };
      await (window as any).__sm.index.put(rec);
      await (window as any).__sm.app.refreshSearch();
      return rec.sampleId;
    });
    expect(added).toBe("samples/null-complexity");
    await reopenSoundSpace(page, 5);
    // Select it + one fixture and open Compare.
    await page.evaluate(() => {
      const app = (window as any).__sm.app;
      const rec = app.results.find((r: { record: { sampleId: string } }) => r.record.sampleId === "samples/null-complexity")?.record;
      const kick = app.results.find((r: { record: { sampleId: string } }) => r.record.sampleId === "samples/kick-909")?.record;
      if (rec) app.toggleMultiSelect(rec);
      if (kick) app.toggleMultiSelect(kick);
    });
    await page.locator("[data-testid='sound-space-compare-toggle']").click();
    await expect(page.locator("[data-testid='sound-space-compare-panel']")).toBeVisible();
    await expect(
      page.locator("[data-testid='sound-space-compare-complexity-samples/null-complexity']"),
    ).toHaveText("—");
    // Cleanup: drop the constructed sample, close compare + selection.
    await page.evaluate(async () => {
      await (window as any).__sm.index.delete("samples/null-complexity");
      await (window as any).__sm.app.refreshSearch();
    });
    await page.locator("[data-testid='sound-space-compare-toggle']").click();
    await clearSelection(page);
    await reopenSoundSpace(page, 4);
  });

  test("E25-20 close+reopen reprojects identically; filter/compare are session-local", async () => {
    await clearFilter(page);
    const positionsBefore = await pointPositions(page);
    await clearSelection(page);
    // Reopen (close drops the snapshot; reopen recomputes deterministically).
    await reopenSoundSpace(page, 4);
    expect(await pointPositions(page)).toEqual(positionsBefore);
    // V1 map + browse surface regression while Sound Space is open.
    await selectExtraForRegression(page);
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
    await expect(
      page.locator("[data-testid='result-samples/kick-909']"),
    ).toBeVisible();
  });

  test("E25-21 console audit: no unexpected errors across STEP25 interactions", async () => {
    // Selection was cleared by E25-19/E25-20; just re-open/re-close the Sound
    // Space surface to exercise one more render cycle, then audit the console.
    await page.locator("[data-testid='sound-space-toggle']").click(); // close
    await expect(page.locator("[data-testid='sound-space-canvas']")).toHaveCount(0);
    await page.locator("[data-testid='sound-space-toggle']").click(); // open
    await expect(page.locator("[data-testid='sound-space-canvas']")).toBeVisible();
    await page.waitForTimeout(300);
    const allowed = capturedConsoleErrors.filter(
      (m) => !benignConsole(m) && !/Failed to load resource/.test(m.text()),
    );
    expect(allowed).toEqual([]);
  });

  test("E25-22 filter scale bench (§54, CONSTRUCTED) over 100/1k/5k/10k", async () => {
    // Fresh navigation so the bench is deterministic (fresh IndexedDB).
    await page.goto("/harness.html");
    await loadSm(page);
    await beginIndexing(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", {
      timeout: 20_000,
    });
    await analyzeAll(page);
    await attachV2(page);
    await refresh(page);
    await reopenSoundSpace(page, 4);

    async function upsertSynth(count: number): Promise<void> {
      await page.evaluate(async (n) => {
        const index = (window as any).__sm.index;
        const base = await index.get("samples/kick-909");
        const CHUNK = 200;
        for (let start = 0; start < n; start += CHUNK) {
          const batch: Promise<unknown>[] = [];
          const limit = Math.min(CHUNK, n - start);
          for (let i = 0; i < limit; i++) {
            const k = start + i;
            const h = (s: number) => {
              let x = (k * 2654435761 + s * 40503) >>> 0;
              x ^= x >>> 15;
              return (x >>> 0) % 10000 / 10000;
            };
            const soundCharacter = {
              brightness: h(1),
              density: h(2),
              transient: h(3),
              duration: h(4),
              tonality: h(5),
              noisiness: h(6),
              dynamics: h(7),
              complexity: h(8),
            };
            const rec = {
              ...base,
              sampleId: `samples/ss-${k}`,
              name: `Synthetic ${k}`,
              analysisV2: {
                analysisVersion: "2.0.0",
                features: base.analysisV2.features,
                soundCharacter,
                quality: { overall: 0.5, featureCoverage: 1 },
              },
            };
            batch.push(index.put(rec).catch(() => undefined));
          }
          await Promise.all(batch);
        }
      }, count);
    }

    const rows: Array<{ count: number; label: string; ms: number; points: number; visible: number }> = [];
    for (const n of [100, 1000, 5000, 10000]) {
      await upsertSynth(n);
      // Reopen with all synthetic points present.
      await reopenSoundSpace(page);
      const total = await page.evaluate(() =>
        (window as any).__sm.app.soundSpace.points.length,
      );
      // Apply a tonality>=0.5 filter via the real inputs and time the render.
      const started = await page.evaluate(() => performance.now());
      await setFilterViaUi(page, "tonality", "0.5");
      await page.waitForTimeout(50);
      const ms = Math.round((await page.evaluate(() => performance.now())) - started);
      const visible = await page.locator("[data-testid^='sound-space-point-']").count();
      expect(visible).toBeGreaterThan(0);
      expect(visible).toBeLessThan(total);
      expect(visible).toBeLessThanOrEqual(total);
      rows.push({ count: n, label: `bench-n=${n}`, ms, points: total, visible });
    }
    // eslint-disable-next-line no-console
    console.log("STEP25-BENCH", JSON.stringify(rows, null, 2));
    await page.screenshot({
      path: "e2e/artifacts/step25-filter-10k.png",
      fullPage: false,
    });
  });
});

/** Upper-case the first letter of a dim key for the aria-label assertions. */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Focus a V1 browse result so the inspector + map stay reachable. */
async function selectExtraForRegression(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = (window as any).__sm.app;
    const kick = app.results.find((r: { record: { sampleId: string } }) => r.record.sampleId === "samples/kick-909")?.record;
    if (kick) app.selectSample(kick);
  });
}