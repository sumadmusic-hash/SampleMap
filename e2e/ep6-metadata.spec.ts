import { test, expect, type Page } from "@playwright/test";
import { startIndexing } from "./support/startIndexing";

/**
 * STEP16S E-P6 — Metadata slice (bpm / numFavorites / numUsages).
 *
 * L1  Inspector: Musical block (BPM, "—" when bpm===0) + Community block
 *     (Favorites / Usages raw counters). No rating / popularity score / stars.
 * L2  Metadata-only refresh: scanning fresh SampleMeta updates the metadata
 *     slice on already-analyzed records while primaryClass/confidence/
 *     audioFeatures/mapPosition/analyzedAt stay byte-identical — and NO audio
 *     is re-fetched (fetchCount unchanged) because the refresh never re-enters
 *     the analysis pipeline.
 */

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const KICK = "samples/kick-909";
const HAT = "samples/hat-airy";
const LEAD = "samples/lead-ohm";

const select = (p: Page, id: string) => p.evaluate((s) => (window as any).__sm.selectSample(s), id);

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("STEP16S E-P6 metadata slice (shared page)", () => {
  test("EP6-01 Inspector: Musical + Community blocks, no rating/popularity", async () => {
    await loadSm(page);

    // Index + analyze the fixture set once (real pipeline once).
    await startIndexing(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", {
      timeout: 20_000,
    });
    await page.evaluate((b) => (window as any).__sm.analyze(b), 10);
    await expect(page.locator(".analysis-status")).toContainText(/Stopped|Idle/, {
      timeout: 30_000,
    });
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);

    // L1a — kick carries real metadata (bpm 126, favorites 42, usages 187).
    await select(page, KICK);
    await expect(page.locator(".inspector-name")).toHaveText("Deep Kick 909");
    await expect(page.locator(".inspector-musical")).toContainText("Musical");
    await expect(page.locator(".inspector-musical-bpm")).toHaveText("BPM: 126");
    await expect(page.locator(".inspector-community")).toContainText("Community");
    await expect(page.locator(".inspector-community-favorites")).toHaveText(
      "Favorites: 42",
    );
    await expect(page.locator(".inspector-community-usages")).toHaveText(
      "Usages: 187",
    );

    // L1b — hat carries bpm 0 → rendered as "—"; counters still raw 0.
    await select(page, HAT);
    await expect(page.locator(".inspector-name")).toHaveText("Airy Hat");
    await expect(page.locator(".inspector-musical-bpm")).toHaveText("BPM: —");
    await expect(page.locator(".inspector-community-favorites")).toHaveText(
      "Favorites: 0",
    );
    await expect(page.locator(".inspector-community-usages")).toHaveText(
      "Usages: 0",
    );

    // L1c — the inspector exposes raw counters only: no rating, no popularity
    // score, no quality score, no stars anywhere in the inspector.
    const inspText = await page.locator(".inspector-region").textContent();
    expect(inspText).toBeTruthy();
    expect(inspText!.toLowerCase()).not.toContain("rating");
    expect(inspText!.toLowerCase()).not.toContain("popularity");
    expect(inspText!.toLowerCase()).not.toContain("quality");
    expect(inspText!.toLowerCase()).not.toContain("stars");
    expect(inspText).not.toContain("★");

    await page.screenshot({
      path: "e2e/artifacts/ep6-01-inspector-metadata.png",
      fullPage: true,
    });
  });

  test("EP6-02 Metadata-only refresh updates the slice, preserves analysis, no audio re-fetch", async () => {
    // Baseline record for the lead (analyzed in EP6-01).
    const before = await page.evaluate((s) => (window as any).__sm.index.get(s), LEAD);
    expect(before).toBeDefined();
    expect(before!.bpm).toBe(128);
    expect(before!.numFavorites).toBe(126);
    expect(before!.numUsages).toBe(240);

    const fetchBefore = await page.evaluate(() => (window as any).__sm.fetchCount);

    // Fresh SampleMeta observed on the NEXT scan for the lead.
    await page.evaluate((s) => {
      const meta = (window as any).__sm.meta[s];
      meta.bpm = 150;
      meta.numFavorites = 500;
      meta.numUsages = 700;
      meta.updateTime = new Date(Date.now() + 60_000);
    }, LEAD);

    await page.evaluate(() => (window as any).__sm.scan());
    await expect(page.locator(".scan-status")).toContainText("Complete", {
      timeout: 20_000,
    });

    const after = await page.evaluate((s) => (window as any).__sm.index.get(s), LEAD);

    // Metadata slice updated.
    expect(after!.bpm).toBe(150);
    expect(after!.numFavorites).toBe(500);
    expect(after!.numUsages).toBe(700);

    // Analysis fields untouched by the refresh.
    expect(after!.primaryClass).toBe(before!.primaryClass);
    expect(after!.confidence).toBe(before!.confidence);
    expect(after!.audioFeatures).toEqual(before!.audioFeatures);
    expect(after!.mapPosition).toEqual(before!.mapPosition);
    expect(after!.analyzedAt).toBe(before!.analyzedAt);
    expect(after!.analysisBuild).toBe(before!.analysisBuild);
    expect(after!.contentHash).toBe(before!.contentHash);

    // No audio re-fetch / no re-analysis: the metadata refresh never touches
    // fetchAudio, so the live counter is unchanged.
    const fetchAfter = await page.evaluate(() => (window as any).__sm.fetchCount);
    expect(fetchAfter).toBe(fetchBefore);

    // Focus the refreshed lead: the inspector now shows the fresh metadata.
    await select(page, LEAD);
    await expect(page.locator(".inspector-name")).toHaveText("Synth Lead");
    await expect(page.locator(".inspector-musical-bpm")).toHaveText("BPM: 150");
    await expect(page.locator(".inspector-community-favorites")).toHaveText(
      "Favorites: 500",
    );
    await expect(page.locator(".inspector-community-usages")).toHaveText(
      "Usages: 700",
    );
  });
});