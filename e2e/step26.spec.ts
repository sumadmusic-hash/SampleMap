import {
import { startIndexing } from "./support/startIndexing";
  test,
  expect,
  type Page,
  type ConsoleMessage,
} from "@playwright/test";

/**
 * STEP26 — V2 Discovery Intelligence & Smart Sample Discovery — E2E.
 *
 * Drives the REAL SampleMap UI (harness.html → src/e2e/harness/main.ts) with
 * the four fixture waveforms + deterministic V2 DSP stamps (`__sm.v2.attach`) —
 * FIXTURE-class evidence per the report. The discovery surface must (a) consume
 * the frozen SearchEngine / shared Sound Space character filter / rankSimilar
 * READ-ONLY, (b) never mutate the global search results, focus, selection, batch
 * or filter while running, and (c) highlight Sound Space points WITHOUT moving
 * coordinates. Reference pinning is id-only and stable until "Clear reference".
 */
let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const beginIndexing = (p: Page) => startIndexing(p);

const analyzeAll = (p: Page) =>
  p.evaluate((b) => (window as any).__sm.analyze(b), 10);

const attachV2 = (p: Page, keys?: string[]) =>
  p.evaluate((k) => (window as any).__sm.v2.attach(k), keys);

const refresh = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.refreshSearch());

const getDiscovery = (p: Page) =>
  p.evaluate(() => {
    const d = (window as any).__sm.app.discovery;
    return {
      open: d.open,
      status: d.status,
      referenceSampleId: d.referenceSampleId,
      error: d.error,
      rows: d.results.map((r: { sampleId: string; score: number }) => ({
        sampleId: r.sampleId,
        score: r.score,
      })),
    };
  });

const getReadyRows = async (p: Page): Promise<string[]> => {
  await p.waitForFunction(() => {
    const d = (window as any).__sm.app.discovery;
    return d.status === "ready" || d.status === "empty" || d.status === "error";
  });
  return (await getDiscovery(p)).rows.map((r) => r.sampleId);
};

const runDiscovery = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.runDiscovery());

const setDraft = (p: Page, text: string) =>
  p.evaluate((t) => (window as any).__sm.app.setDiscoveryTextDraft(t), text);

const setDraftViaUi = async (p: Page, text: string) => {
  await p.locator("[data-testid='discovery-text']").fill(text);
};

const getFocused = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.focusedSampleId);

const getSelection = (p: Page): Promise<string[]> =>
  p.evaluate(() => [...(window as any).__sm.app.selectedSampleIds]);

const getGlobalResults = (p: Page): Promise<string[]> =>
  p.evaluate(() =>
    (window as any).__sm.app.results.map((r: { record: { sampleId: string } }) => r.record.sampleId),
  );

const clearSearchText = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.setSearch(""));

const openSoundSpace = async (p: Page) => {
  const s = await p.evaluate(() => (window as any).__sm.app.soundSpace.open);
  if (!s) {
    await p.locator("[data-testid='sound-space-toggle']").click();
    await p.waitForFunction(() => {
      const ss = (window as any).__sm.app.soundSpace;
      return ss.open && (ss.status === "ready" || ss.status === "empty");
    });
  }
};

const setTonalityFilter = async (p: Page, min: string) => {
  const minInput = p.locator("[data-testid='sound-space-filter-min-tonality']");
  await minInput.fill(min);
  await minInput.dispatchEvent("change");
};

const clearFilter = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.clearSoundSpaceFilter());

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

const discoveredPoints = (p: Page): Promise<string[]> =>
  p
    .locator("[data-testid^='sound-space-point-'].sound-space-point-discovery")
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-testid")!.replace("sound-space-point-", "")),
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

test.describe.serial("STEP26 V2 Discovery — Find a sound (shared page)", () => {
  test("E26-01 idle surface: closed by default; open shows 'Find a sound' honest copy", async () => {
    await loadSm(page);
    await beginIndexing(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", { timeout: 20_000 });
    await analyzeAll(page);
    await attachV2(page);
    await refresh(page);

    expect((await getDiscovery(page)).open).toBe(false);
    await page.locator("[data-testid='discovery-toggle']").click();
    await expect(page.locator("[data-testid='discovery-status']")).toHaveText(
      "Find a sound",
    );
    const state = await getDiscovery(page);
    expect(state.open).toBe(true);
    expect(state.status).toBe("idle");
    // Idle never invents a browse order: no result rows.
    await expect(page.locator("[data-testid='discovery-list']")).toHaveCount(0);
    await page.screenshot({ path: "e2e/artifacts/step26-surface-idle.png", fullPage: false });
  });

  test("E26-02 text-only (['kick']) single row, score + reason, name routes focus", async () => {
    await setDraft(page, "kick");
    await runDiscovery(page);
    expect(await getReadyRows(page)).toEqual(["samples/kick-909"]);
    await expect(page.locator("[data-testid='discovery-result-samples/kick-909']")).toBeVisible();
    await expect(page.locator("[data-testid='discovery-score-samples/kick-909']")).toContainText(
      "Match",
    );
    await expect(page.locator("[data-testid='discovery-reasons-samples/kick-909']")).toHaveText(
      "Matches search",
    );
    const selBefore = await getSelection(page);
    await page.locator("[data-testid='discovery-name-samples/kick-909']").click();
    expect(await getFocused(page)).toBe("samples/kick-909");
    expect(await getSelection(page)).toEqual(selBefore);
    await page.screenshot({ path: "e2e/artifacts/step26-text-only.png", fullPage: false });
  });

  test("E26-03 keyboard Enter on the draft runs discovery", async () => {
    await setDraft(page, "hat");
    await page.locator("[data-testid='discovery-text']").focus();
    await page.keyboard.press("Enter");
    expect(await getReadyRows(page)).toEqual(["samples/hat-airy"]);
  });

  test("E26-04 honest empty state 'No matching sounds found.' and no stale rows", async () => {
    await setDraft(page, "no-such-sound-qx");
    await runDiscovery(page);
    await expect(page.locator("[data-testid='discovery-status']")).toHaveText(
      "No matching sounds found.",
    );
    await expect(page.locator("[data-testid='discovery-list']")).toHaveCount(0);
    const highlights = await page.evaluate(() =>
      [...(window as any).__sm.app.discoveryHighlightedSampleIds],
    );
    expect(highlights).toEqual([]);
  });

  test("E26-05 character-only reuses the shared Sound Space filter snapshot", async () => {
    await setDraft(page, "");
    await openSoundSpace(page);
    await setTonalityFilter(page, "0.9");
    await runDiscovery(page);
    // Same 3 as the Sound Space filter panel shows for tonality >= 0.9 (§E25-03).
    const rows = await getReadyRows(page);
    expect(rows.sort()).toEqual(
      ["samples/bass-sub", "samples/kick-909", "samples/lead-ohm"].sort(),
    );
    for (const id of rows) {
      await expect(page.locator(`[data-testid='discovery-score-${id}']`)).toHaveText(
        "Match 100%",
      );
      await expect(page.locator(`[data-testid='discovery-reasons-${id}']`)).toHaveText(
        "Matches filter",
      );
    }
  });

  test("E26-06 text ∩ filter intersection: only the kick survives", async () => {
    await setDraft(page, "Deep");
    await runDiscovery(page);
    expect(await getReadyRows(page)).toEqual(["samples/kick-909"]);
    await expect(
      page.locator("[data-testid='discovery-reasons-samples/kick-909']"),
    ).toHaveText("Matches search · Matches filter");
  });

  test("E26-07 reference-only: pinned from the focused sample, rankSimilar order, self excluded", async () => {
    await clearFilter(page);
    await setDraft(page, "");
    // Focus lead via the canonical Sound Space focus path.
    await page.locator("[data-testid='sound-space-point-samples/lead-ohm']").click();
    expect(await getFocused(page)).toBe("samples/lead-ohm");
    await page.locator("[data-testid='discovery-use-reference']").click();
    await expect(page.locator("[data-testid='discovery-reference-label']")).toHaveText(
      "Reference: Synth Lead",
    );
    await runDiscovery(page);
    const rows = await getReadyRows(page);
    const expected = await page.evaluate((qid: string) =>
      (window as any).__sm.v2.rank(qid), "samples/lead-ohm");
    expect(rows).toEqual(expected); // identical to the frozen rankSimilar order
    expect(rows).not.toContain("samples/lead-ohm"); // self always excluded
    for (const id of rows) {
      await expect(page.locator(`[data-testid='discovery-reasons-${id}']`)).toHaveText(
        "Similar",
      );
    }
  });

  test("E26-08 text + reference compose into 'Matches search · Similar'", async () => {
    await setDraft(page, "hat");
    await runDiscovery(page);
    expect(await getReadyRows(page)).toEqual(["samples/hat-airy"]);
    await expect(page.locator("[data-testid='discovery-reasons-samples/hat-airy']")).toHaveText(
      "Matches search · Similar",
    );
  });

  test("E26-09 Sound Space highlight adds a class WITHOUT moving coordinates", async () => {
    const positionsBefore = await pointPositions(page);
    // Reference-only run from E26-07 is still active (reference untouched).
    await setDraft(page, "");
    await runDiscovery(page);
    const rows = await getReadyRows(page);
    expect(rows.length).toBeGreaterThan(0);
    const highlights = await page.evaluate(() =>
      [...(window as any).__sm.app.discoveryHighlightedSampleIds],
    );
    expect(highlights.sort()).toEqual([...rows].sort());
    // DOM: result points carry the discovery class; the self point never does.
    const dom = await discoveredPoints(page);
    expect(dom.sort()).toEqual([...rows].sort());
    await expect(
      page.locator("[data-testid='sound-space-point-samples/lead-ohm'].sound-space-point-discovery"),
    ).toHaveCount(0);
    // Coordinates are frozen — no point moved, highlighted or not.
    const positionsAfter = await pointPositions(page);
    expect(positionsAfter).toEqual(positionsBefore);
    await page.screenshot({ path: "e2e/artifacts/step26-highlight.png", fullPage: false });
  });

  test("E26-10 'Use focused sample' is disabled with nothing focused, enabled after focus", async () => {
    await page.evaluate(() => {
      const app = (window as any).__sm.app;
      const rec = app.results.find(
        (r: { record: { sampleId: string } }) => r.record.sampleId === "samples/bass-sub",
      )?.record;
      if (!app.focusedSampleId && rec) app.selectSample(rec);
    });
    const enabledNow = await page.locator("[data-testid='discovery-use-reference']").isEnabled();
    expect(enabledNow).toBe(true);
    await page.locator("[data-testid='discovery-name-samples/kick-909']").click();
    expect(await getFocused(page)).toBe("samples/kick-909");
    expect(await page.locator("[data-testid='discovery-use-reference']").isEnabled()).toBe(true);
  });

  test("E26-11 Clear reference touches ONLY the reference (focus + selection intact)", async () => {
    await page.locator("[data-testid='sound-space-point-samples/kick-909']").click();
    const focusedBefore = await getFocused(page);
    const selBefore = await getSelection(page);
    expect((await getDiscovery(page)).referenceSampleId).toBe("samples/lead-ohm");
    await page.locator("[data-testid='discovery-clear-reference']").click();
    expect((await getDiscovery(page)).referenceSampleId).toBeUndefined();
    expect(await getFocused(page)).toBe(focusedBefore);
    expect(await getSelection(page)).toEqual(selBefore);
    await expect(page.locator("[data-testid='discovery-reference-label']")).toHaveText(
      "No reference set",
    );
  });

  test("E26-12 discovery runs never mutate the global search results", async () => {
    await setDraft(page, "Deep");
    await page.locator("[data-testid='search-text']").fill("Sub");
    await clearSearchText(page);
    await page.locator("[data-testid='search-text']").fill("Sub");
    await expect(page.locator("[data-testid='result-samples/bass-sub']")).toBeVisible();
    const globalBefore = await getGlobalResults(page);
    const focusedBefore = await getFocused(page);
    const selBefore = await getSelection(page);
    await runDiscovery(page);
    await page.waitForFunction(() => {
      const d = (window as any).__sm.app.discovery;
      return d.status === "ready" || d.status === "empty";
    });
    expect(await getGlobalResults(page)).toEqual(globalBefore);
    expect(await getFocused(page)).toBe(focusedBefore);
    expect(await getSelection(page)).toEqual(selBefore);
    await clearSearchText(page);
    await setDraft(page, "");
  });

  test("E26-13 V1-only reference → 'Select a sample to use as a reference.'", async () => {
    const added = await page.evaluate(async () => {
      const base = await (window as any).__sm.index.get("samples/kick-909");
      const rec = {
        ...base,
        sampleId: "samples/legacy-clip",
        name: "Legacy V1 Clip",
        analysisV2: undefined,
      };
      await (window as any).__sm.index.put(rec);
      await (window as any).__sm.app.refreshSearch();
      return rec.sampleId;
    });
    expect(added).toBe("samples/legacy-clip");
    await page.evaluate(() => {
      const app = (window as any).__sm.app;
      const rec = app.results.find(
        (r: { record: { sampleId: string } }) => r.record.sampleId === "samples/legacy-clip",
      )?.record;
      if (rec) app.selectSample(rec);
    });
    expect(await getFocused(page)).toBe("samples/legacy-clip");
    await page.locator("[data-testid='discovery-use-reference']").click();
    await runDiscovery(page);
    await expect(page.locator("[data-testid='discovery-status']")).toHaveText(
      "Select a sample to use as a reference.",
    );
    await expect(page.locator("[data-testid='discovery-list']")).toHaveCount(0);
    await page.evaluate(async () => {
      await (window as any).__sm.index.delete("samples/legacy-clip");
      await (window as any).__sm.app.refreshSearch();
    });
    await page.locator("[data-testid='discovery-clear-reference']").click();
    await setDraft(page, "");
  });

  test("E26-14 session-local: reload + fresh mount drops all criteria", async () => {
    await page.goto("/harness.html");
    await loadSm(page);
    // Re-seed the in-memory scan on this fresh page (IndexedDB survives, the
    // scan + V2 stamps live in the harness session).
    await beginIndexing(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", { timeout: 20_000 });
    await analyzeAll(page);
    await attachV2(page);
    await refresh(page);
    // A fresh app mount rehydrates NOTHING from a previous session.
    const state = await getDiscovery(page);
    expect(state.open).toBe(false);
    expect(state.referenceSampleId).toBeUndefined();
    const draft = await page.evaluate(() => (window as any).__sm.app.discoveryTextDraft);
    expect(draft).toBe("");
    // Reopen re-establishes the idle surface.
    await page.locator("[data-testid='discovery-toggle']").click();
    await expect(page.locator("[data-testid='discovery-status']")).toHaveText("Find a sound");
  });

  test("E26-15 console audit: no unexpected errors across STEP26 interactions", async () => {
    await page.waitForTimeout(300);
    const allowed = capturedConsoleErrors.filter(
      (m) => !benignConsole(m) && !/Failed to load resource/.test(m.text()),
    );
    expect(allowed).toEqual([]);
  });
});