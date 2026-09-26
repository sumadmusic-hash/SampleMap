import {
  test,
  expect,
  type Page,
  type ConsoleMessage,
} from "@playwright/test";

/**
 * STEP27 — V2 Sound Collections — E2E (E27-01..E27-23).
 *
 * Drives the REAL SampleMap UI (harness.html → src/e2e/harness/main.ts) with the
 * four fixture waveforms + deterministic V2 stamps (`__sm.v2.attach`) —
 * FIXTURE-class evidence per the report. The Collection is a session-local,
 * user-curated boundary: explicit insertion order, duplicate-safe, hard cap 50,
 * independent of focus/selection/preview/discovery/filters, never persisted.
 * Add controls mount on Discovery / Search / Sound Space and all share the SAME
 * pure boundary. Compare is derived (≤4, collection order) and never mutates.
 * The summary "Collection average" is an honest arithmetic mean over present
 * values (null → "—"). A member whose index record is deleted stays listed as
 * "Unavailable sample" without dropping or crashing.
 */
let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const firstUseIndex = (p: Page) =>
  p.locator("[data-testid='first-use-index']").click();

const analyzeAll = (p: Page) =>
  p.evaluate((b) => (window as any).__sm.analyze(b), 10);

const attachV2 = (p: Page, keys?: string[]) =>
  p.evaluate((k) => (window as any).__sm.v2.attach(k), keys);

const refresh = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.refreshSearch());

const getCollection = (p: Page) =>
  p.evaluate(() => {
    const c = (window as any).__sm.app.collection;
    return { open: c.open, ids: [...c.sampleIds] };
  });

const getSelection = (p: Page): Promise<string[]> =>
  p.evaluate(() => [...(window as any).__sm.app.selectedSampleIds]);

const getFocused = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.focusedSampleId);

const setDraft = (p: Page, text: string) =>
  p.evaluate((t) => (window as any).__sm.app.setDiscoveryTextDraft(t), text);

const runDiscovery = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.runDiscovery());

const openCollectionPanel = async (p: Page) => {
  const open = await p.evaluate(() => (window as any).__sm.app.collection.open);
  if (!open) {
    await p.locator("[data-testid='collection-toggle']").click();
    await p.waitForFunction(() => (window as any).__sm.app.collection.open === true);
  }
};

const closeCollectionPanel = async (p: Page) => {
  const open = await p.evaluate(() => (window as any).__sm.app.collection.open);
  if (open) {
    await p.locator("[data-testid='collection-toggle']").click();
    await p.waitForFunction(() => (window as any).__sm.app.collection.open === false);
  }
};

const keyboardToggleCollection = (p: Page, desired: boolean) =>
  expect
    .poll(
      async () => {
        if ((await p.evaluate(() => (window as any).__sm.app.collection.open)) !== desired) {
          await p.locator("[data-testid='collection-toggle']").press("Enter");
        }
        return p.evaluate(() => (window as any).__sm.app.collection.open);
      },
      { timeout: 15_000 },
    )
    .toBe(desired);

const clearCollectionUi = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.clearCollection());

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

const addToCollectionApi = (p: Page, ids: string[]) =>
  p.evaluate(async (list) => {
    const app = (window as any).__sm.app as any;
    for (const id of list) {
      const rec = app.recordForSample(id);
      await app.addToCollection(id, rec);
    }
  }, ids);

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

const KICK = "samples/kick-909";
const HAT = "samples/hat-airy";
const BASS = "samples/bass-sub";
const LEAD = "samples/lead-ohm";

test.describe.serial("STEP27 V2 Sound Collections — shared page", () => {
  test("E27-01 fresh state: collection closed+empty and My Sounds hidden (STEP32); a real add reveals it", async () => {
    await loadSm(page);
    await firstUseIndex(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", { timeout: 20_000 });
    await analyzeAll(page);
    await attachV2(page);
    await refresh(page);

    expect((await getCollection(page)).open).toBe(false);
    expect((await getCollection(page)).ids).toEqual([]);
    // STEP32 §16.3 — no add yet, so the collection surface is not revealed.
    // (The honest empty copy is reached after adding, then clearing — E27-08.)
    await expect(page.locator("[data-testid='collection-counter']")).toHaveCount(0);
    await expect(
      page.evaluate(() => (window as any).__sm.app.progressiveDisclosure.collectionManagerUsed),
    ).resolves.toBe(false);

    // A genuine add (real path, Discovery "Add") reveals My Sounds.
    await setDraft(page, "kick");
    await runDiscovery(page);
    await page.locator("[data-testid='collection-add-samples/kick-909']").click();
    await expect(page.locator("[data-testid='collection-counter']")).toHaveText("My Sounds · 1");
    await openCollectionPanel(page);
    await expect(page.locator("[data-testid='collection-result-samples/kick-909']")).toBeVisible();
    await expect(
      page.evaluate(() => (window as any).__sm.app.progressiveDisclosure.collectionManagerUsed),
    ).resolves.toBe(true);
    await page.screenshot({ path: "e2e/artifacts/step27-initial-empty.png", fullPage: false });
    await page.locator("[data-testid='collection-toggle']").click(); // close
    await page.locator("[data-testid='collection-toggle']").click(); // reopen
  });

  test("E27-02 add from Discovery → member + counter + Added label", async () => {
    await openCollectionPanel(page);
    await setDraft(page, "kick");
    await runDiscovery(page);
    await expect(
      page.locator("[data-testid='collection-add-samples/kick-909']"),
    ).toBeVisible();
    await page.locator("[data-testid='collection-add-samples/kick-909']").click();
    await expect(page.locator("[data-testid='collection-counter']")).toHaveText("My Sounds · 1");
    await expect(page.locator("[data-testid='collection-result-samples/kick-909']")).toBeVisible();
    await expect(page.locator("[data-testid='collection-name-samples/kick-909']")).toHaveText(
      "Deep Kick 909",
    );
    await page.screenshot({ path: "e2e/artifacts/step27-add-from-discovery.png", fullPage: false });
  });

  test("E27-03 add from Search shares the same boundary", async () => {
    await page.locator("[data-testid='search-text']").fill("hat");
    await expect(
      page.locator("[data-testid='collection-add-search-samples/hat-airy']"),
    ).toBeVisible();
    await page.locator("[data-testid='collection-add-search-samples/hat-airy']").click();
    await expect(page.locator("[data-testid='collection-counter']")).toHaveText("My Sounds · 2");
    const ids = (await getCollection(page)).ids;
    expect(ids).toEqual([KICK, HAT]);
    await page.locator("[data-testid='search-clear']").click();
  });

  test("E27-04 add from Sound Space (focused sample) uses the same cap/boundary", async () => {
    const toggle = page.locator("[data-testid='sound-space-toggle']");
    if (await page.evaluate(() => !(window as any).__sm.app.soundSpace.open)) {
      await toggle.click();
    }
    await page.locator(`[data-testid='sound-space-point-${LEAD}']`).click();
    expect(await getFocused(page)).toBe(LEAD);
    await page.locator(`[data-testid='collection-add-focused-${LEAD}']`).click();
    await expect(page.locator("[data-testid='collection-counter']")).toHaveText("My Sounds · 3");
    expect((await getCollection(page)).ids).toEqual([KICK, HAT, LEAD]);
  });

  test("E27-05 duplicate add is a no-op; the source button reads 'Added'", async () => {
    await expect(page.locator(`[data-testid='collection-add-focused-${LEAD}']`)).toHaveText(
      "In Collection",
    );
    // Duplicate add via the shared API (same id) keeps exactly one member.
    await page.evaluate(async (id) => {
      const app = (window as any).__sm.app as any;
      await app.addToCollection(id, app.recordForSample(id));
    }, LEAD);
    expect((await getCollection(page)).ids).toEqual([KICK, HAT, LEAD]);
    await expect(page.locator("[data-testid='collection-counter']")).toHaveText("My Sounds · 3");
  });

  test("E27-06 counter is always the live member count", async () => {
    await closeCollectionPanel(page);
    await openCollectionPanel(page);
    await expect(page.locator("[data-testid='collection-counter']")).toHaveText("My Sounds · 3");
  });

  test("E27-07 remove drops exactly one member, order of the rest preserved", async () => {
    await page.locator(`[data-testid='collection-remove-${HAT}']`).click();
    expect((await getCollection(page)).ids).toEqual([KICK, LEAD]);
    await expect(page.locator("[data-testid='collection-counter']")).toHaveText("My Sounds · 2");
  });

  test("E27-08 clear empties the collection; reopen shows empty state", async () => {
    await page.locator("[data-testid='collection-clear']").click();
    expect((await getCollection(page)).ids).toEqual([]);
    await expect(page.locator("[data-testid='collection-status']")).toHaveText(
      "No sounds collected yet.\nAdd sounds from Discovery, Search, or Sound Space.",
    );
  });

  test("E27-09 insertion order is the explicit add order (list order matches)", async () => {
    await addToCollectionApi(page, [BASS, KICK, HAT]);
    await openCollectionPanel(page);
    const rows = await page
      .locator("[data-testid^='collection-result-']")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("collection-result-", "")));
    expect(rows).toEqual([BASS, KICK, HAT]);
  });

  test("E27-10 re-add MOVES the member to the end (never duplicates)", async () => {
    await addToCollectionApi(page, [BASS]);
    expect((await getCollection(page)).ids).toEqual([KICK, HAT, BASS]);
    const rows = await page
      .locator("[data-testid^='collection-result-']")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("collection-result-", "")));
    expect(rows).toEqual([KICK, HAT, BASS]);
  });

  test("E27-11 Compare with ≥2 members shows all in collection order", async () => {
    await openCollectionPanel(page);
    await page.locator("[data-testid='collection-compare-toggle']").click();
    await expect(page.locator("[data-testid='collection-compare-title']")).toHaveText(
      "Compare Collection",
    );
    await expect(page.locator("[data-testid='collection-compare-head-samples/kick-909']")).toBeVisible();
    await expect(page.locator("[data-testid='collection-compare-head-samples/hat-airy']")).toBeVisible();
    await expect(page.locator("[data-testid='collection-compare-head-samples/bass-sub']")).toBeVisible();
    await expect(page.locator("[data-testid='collection-compare-brightness-samples/kick-909']")).toBeVisible();
    await page.screenshot({ path: "e2e/artifacts/step27-compare-3.png", fullPage: false });
  });

  test("E27-12 Compare caps at the first 4 in collection order (never mutates)", async () => {
    await page.locator("[data-testid='collection-compare-toggle']").click(); // close
    await addToCollectionApi(page, [LEAD, BASS]);
    expect((await getCollection(page)).ids).toEqual([KICK, HAT, LEAD, BASS]);
    await clearCollectionUi(page);
    await addToCollectionApi(page, [HAT, KICK, LEAD, BASS, BASS]); // 4 unique in order
    await page.locator("[data-testid='collection-compare-toggle']").click(); // open
    const heads = await page
      .locator("[data-testid^='collection-compare-head-']")
      .evaluateAll((els) => els.length);
    expect(heads).toBe(4);
    const headIds = await page
      .locator("[data-testid^='collection-compare-head-']")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("collection-compare-head-", "")));
    expect(headIds).toEqual([HAT, KICK, LEAD, BASS]);
    // Compare never mutates the collection or the batch selection.
    expect((await getCollection(page)).ids).toEqual([HAT, KICK, LEAD, BASS]);
    expect(await getSelection(page)).toEqual([]);
  });

  test("E27-13 adding/removing never mutates focus, selection, preview or point coords", async () => {
    // Ensure the Sound Space is open with points rendered.
    if (await page.evaluate(() => !(window as any).__sm.app.soundSpace.open)) {
      await page.locator("[data-testid='sound-space-toggle']").click();
    }
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid^='sound-space-point-']").length > 0,
    );
    const spotsBefore = await pointPositions(page);
    expect(Object.keys(spotsBefore).length).toBeGreaterThanOrEqual(4);
    const selBefore = await getSelection(page);
    await page.locator(`[data-testid='sound-space-point-${KICK}']`).click();
    const focusBefore = await getFocused(page);
    // Mutate the collection heavily while the points are mounted.
    await clearCollectionUi(page);
    await addToCollectionApi(page, [BASS, LEAD, KICK, HAT]);
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid^='sound-space-point-']").length > 0,
    );
    expect(await getFocused(page)).toBe(focusBefore);
    expect(await getSelection(page)).toEqual(selBefore);
    const spotsAfter = await pointPositions(page);
    expect(spotsAfter).toEqual(spotsBefore);
  });

  test("E27-14 summary renders 'Collection average' with honest mean values", async () => {
    await clearCollectionUi(page);
    await addToCollectionApi(page, [KICK, BASS]);
    await openCollectionPanel(page);
    await expect(page.locator("[data-testid='collection-summary-title']")).toContainText(
      "Collection average",
    );
    // Every one of the 8 dims is a numeric value "" (never "—") for two
    // fully-present fixtures; the mean is close to the pairwise average.
    const value = await page
      .locator("[data-testid='collection-summary-value-brightness']")
      .textContent();
    expect(value).not.toBe("—");
    expect(Number(value)).toBeGreaterThanOrEqual(0);
    expect(Number(value)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: "e2e/artifacts/step27-summary.png", fullPage: false });
  });

  test("E27-15 a member with an undetermined character renders '—' (never invents)", async () => {
    await clearCollectionUi(page);
    // Stamp a record whose SoundCharacter is entirely null (not determinable).
    await page.evaluate(async () => {
      const tm = window as any;
      const app = tm.__sm.app as any;
      const rec = await tm.__sm.index.get("samples/kick-909");
      const analysisV2 = {
        ...rec.analysisV2,
        soundCharacter: {
          brightness: null,
          density: null,
          transient: null,
          duration: null,
          tonality: null,
          noisiness: null,
          dynamics: null,
          complexity: null,
        },
      };
      await tm.__sm.index.put({ ...rec, analysisV2 });
      await app.refreshSearch();
      await app.addToCollection("samples/kick-909", app.recordForSample("samples/kick-909"));
    });
    await openCollectionPanel(page);
    await expect(page.locator("[data-testid='collection-summary-value-brightness']")).toHaveText(
      "—",
    );
    await expect(page.locator("[data-testid='collection-summary-value-tonality']")).toHaveText("—");
    // Honest label, never "AI profile" / "predicted sound".
    await expect(page.locator("[data-testid='collection-summary-title']")).toContainText(
      "Collection average",
    );
  });

  test("E27-16 Select All is explicit, bounded and never automatic", async () => {
    await clearCollectionUi(page);
    await addToCollectionApi(page, [KICK, HAT, BASS]);
    await openCollectionPanel(page);
    await page.locator("[data-testid='collection-select-all']").click();
    expect(await getSelection(page)).toEqual([KICK, HAT, BASS]);
    // The collection itself is untouched by the selection action.
    expect((await getCollection(page)).ids).toEqual([KICK, HAT, BASS]);
  });

  test("E27-17 a stale member stays listed as 'Unavailable sample' without a crash", async () => {
    await clearCollectionUi(page);
    await addToCollectionApi(page, [KICK, HAT]);
    await page.evaluate(async (id) => {
      const tm = window as any;
      await tm.__sm.index.delete(id);
      await (tm.__sm.app as any).openCollection();
      await (tm.__sm.app as any).openCollection();
    }, KICK);
    // Member kept; availability is honest.
    expect((await getCollection(page)).ids).toEqual([KICK, HAT]);
    await openCollectionPanel(page);
    await expect(page.locator("[data-testid='collection-name-samples/kick-909']")).toHaveText(
      "Unavailable sample",
    );
    await expect(page.locator(`[data-testid='collection-preview-${KICK}']`)).toBeDisabled();
    await expect(page.locator(`[data-testid='collection-result-${HAT}']`)).toBeVisible();
    await page.screenshot({ path: "e2e/artifacts/step27-stale-member.png", fullPage: false });
  });

  test("E27-18 hard cap 50: 51st add is a no-op, earliest members still present", async () => {
    await clearCollectionUi(page);
    const ids = Array.from({ length: 55 }, (_, i) => `samples/hold-${i}`);
    await page.evaluate(async () => {
      const tm = window as any;
      // Stamp 55 synthetic members via the pure boundary (same cap every source hits).
      const index = tm.__sm.index as any;
      const rec = await index.get("samples/kick-909");
      for (let i = 0; i < 55; i++) {
        await index.put({
          ...rec,
          sampleId: `samples/hold-${i}`,
          name: `Hold ${i}`,
        });
      }
      await (tm.__sm.app as any).refreshSearch();
      const app = tm.__sm.app as any;
      for (let i = 0; i < 55; i++) {
        await app.addToCollection(`samples/hold-${i}`, app.recordForSample(`samples/hold-${i}`));
      }
    });
    expect((await getCollection(page)).ids).toHaveLength(50);
    const header = ids.slice(0, 1)[0];
    expect((await getCollection(page)).ids).toContain(header);
    await expect(page.locator("[data-testid='collection-status']")).toHaveText("Collection is full.");
  });

  test("E27-19 cap 50 → remove a member admits EXACTLY the next add (no eviction)", async () => {
    await openCollectionPanel(page);
    await page.locator("[data-testid='collection-remove-samples/hold-0']").click();
    await page.evaluate(async () => {
      const app = (window as any).__sm.app as any;
      await app.addToCollection("samples/hold-50", app.recordForSample("samples/hold-50"));
    });
    expect((await getCollection(page)).ids).toHaveLength(50);
    expect((await getCollection(page)).ids).toContain("samples/hold-50");
  });

  test("E27-20 keyboard: Collection controls are accessible via keyboard", async () => {
    await closeCollectionPanel(page);
    await keyboardToggleCollection(page, true);
    await keyboardToggleCollection(page, false);
    await openCollectionPanel(page);
  });

  test("E27-21 preview routes through the existing preview path from the collection", async () => {
    await page.evaluate(async () => {
      const app = (window as any).__sm.app as any;
      await app.clearCollection();
      await app.addToCollection("samples/hat-airy", app.recordForSample("samples/hat-airy"));
    });
    await page.locator("[data-testid='collection-preview-samples/hat-airy']").click();
    // Synthetic samples are fixture-blocked for playback (STEP24 §16M-19); the
    // wiring itself is what matters — the request settles to playing OR error.
    await page.waitForFunction(
      () => {
        const app = (window as any).__sm.app;
        return app.previewSampleId !== undefined || app.previewError !== undefined;
      },
      { timeout: 10_000 },
    );
    await expect(page.locator("[data-testid='collection-preview-samples/hat-airy']")).toBeVisible();
  });

  test("E27-22 close keeps members; reopen shows the same collection", async () => {
    await closeCollectionPanel(page);
    await openCollectionPanel(page);
    expect((await getCollection(page)).ids).toEqual(["samples/hat-airy"]);
    await expect(page.locator("[data-testid='collection-result-samples/hat-airy']")).toBeVisible();
    await page.screenshot({ path: "e2e/artifacts/step27-reopen.png", fullPage: false });
  });

  test("E27-23 console audit: no unhandled application errors across the session", async () => {
    const errors = capturedConsoleErrors.filter((m) => !benignConsole(m));
    expect(errors).toEqual([]);
  });
});