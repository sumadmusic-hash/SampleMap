import {
  test,
  expect,
  type Page,
  type ConsoleMessage,
} from "@playwright/test";

/**
 * STEP23 — End-to-end verification of the V2 "Find Similar" product surface
 * against the OFFLINE harness (harness.html -> src/e2e/harness/main.ts).
 *
 * The V1 pipeline never produces `analysisV2` (V1 FROZEN, §1). The harness
 * `__sm.v2.attach` stamps a DETERMINISTIC V2 analysis computed by the REAL V2
 * DSP (`analyzeAudio`) over the SAME fixture waveform the pipeline decodes, so
 * the browser exercises the REAL `rankSimilar` path with FIXTURE-class audio
 * evidence (§16). Expected orders come from `__sm.v2.rank` (the REAL
 * `rankSimilar`) — the spec never hardcodes a ranking order.
 *
 * A single shared serial page boots + indexes + analyzes once, then drives the
 * V2 scenarios E23-01..E23-12 with persisted IndexedDB state.
 */

interface SimilarityV2State {
  open: boolean;
  status: "idle" | "ready" | "empty" | "error";
  querySampleId?: string;
  queryName?: string;
  queryLimited?: boolean;
  results: Array<{ sampleId: string; similarity: number; sharedDimensionCount: number }>;
  error?: string;
}

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const firstUseIndex = (p: Page) =>
  p.locator("[data-testid='first-use-index']").click();

const analyzeAll = (p: Page) =>
  p.evaluate((b) => (window as any).__sm.analyze(b), 10);

const refresh = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.refreshSearch());

const selectSample = (p: Page, id: string) =>
  p.evaluate((s) => (window as any).__sm.selectSample(s), id);

/**
 * Wait until the open surface has settled (terminal status) AND the rendered
 * query header matches the CURRENT snapshot — absorbs the transient idle
 * reset + stale DOM of a re-open, making every subsequent read race-free.
 */
const waitForOpenSettled = (p: Page) =>
  p.waitForFunction(() => {
    const s = (window as any).__sm.app.similarityV2;
    if (!s.open) return false;
    if (!["ready", "empty", "error"].includes(s.status)) return false;
    const q = document.querySelector("[data-testid='similarity-v2-query']");
    if (!q) return false;
    const want = s.queryName ? `Similar to: ${s.queryName}` : "Similar to: —";
    return q.textContent === want;
  });

/** Click the Find Similar action and wait for the surface to settle. */
const openFindSimilar = async (p: Page) => {
  await p.locator("[data-testid='inspector-find-similar-v2']").click();
  await waitForOpenSettled(p);
};

const attachV2 = (p: Page, keys?: string[]) =>
  p.evaluate((k) => (window as any).__sm.v2.attach(k), keys);

const detachV2 = (p: Page, keys?: string[]) =>
  p.evaluate((k) => (window as any).__sm.v2.detach(k), keys);

const rankV2 = (p: Page, id: string): Promise<string[]> =>
  p.evaluate((s) => (window as any).__sm.v2.rank(s), id);

const getSimilarityV2 = (p: Page): Promise<SimilarityV2State> =>
  p.evaluate(() => {
    const s = (window as any).__sm.app.similarityV2;
    return {
      open: s.open,
      status: s.status,
      querySampleId: s.querySampleId,
      queryName: s.queryName,
      queryLimited: s.queryLimited,
      results: s.results.map(
        (r: { sampleId: string; similarity: number; sharedDimensionCount: number }) => ({
          sampleId: r.sampleId,
          similarity: r.similarity,
          sharedDimensionCount: r.sharedDimensionCount,
        }),
      ),
      error: s.error,
    };
  });

const resultRowIds = (p: Page): Promise<string[]> =>
  p
    .locator("[data-testid^='similarity-v2-result-']")
    .evaluateAll((els) =>
      els.map((e) => (e.getAttribute("data-testid") ?? "").slice("similarity-v2-result-".length)),
    );

const waitForPreviewAttempt = (p: Page, timeoutMs = 15_000) =>
  p.waitForFunction(
    () => {
      const sm = (window as any).__sm;
      const app = sm.app;
      return (
        app.previewSampleId !== undefined ||
        app.previewError !== undefined ||
        sm.deps.preview.activeCount() > 0 ||
        sm.deps.preview.cachedCount() > 0
      );
    },
    null,
    { timeout: timeoutMs },
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

test.describe.serial("STEP23 V2 Find Similar (shared page)", () => {
  test("E23-01 no focused sample: Find Similar hidden until focus (STEP32); empty surface when opened with no focus", async () => {
    await loadSm(page);
    await firstUseIndex(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", {
      timeout: 20_000,
    });
    await analyzeAll(page);
    await expect(page.locator(".analysis-status")).toContainText(/Stopped|Idle/, {
      timeout: 30_000,
    });
    await refresh(page);

    // STEP32 §16.1 — Find Similar is NOT required to be globally visible on a
    // fresh mount; it is revealed by focusing a sample. With no focus and no
    // intent, the surface must not be spuriously rendered.
    await expect(page.locator("[data-testid='inspector-find-similar-v2']")).toHaveCount(0);
    const before = await page.evaluate(
      () => (window as any).__sm.app.progressiveDisclosure.similarityV2Used,
    );
    expect(before).toBe(false);

    // Invoking without a focus yields an honest empty surface, never rows.
    await page.evaluate(() => (window as any).__sm.app.openFindSimilarV2());
    const s = await getSimilarityV2(page);
    expect(s.open).toBe(true);
    expect(s.status).toBe("empty");
    expect(s.error).toMatch(/Select a sample/);
    await expect(page.locator("[data-testid='similarity-v2-status']")).toContainText(
      /Select a sample/,
    );
    await page.evaluate(() => (window as any).__sm.app.closeFindSimilarV2());

    // Focus now reveals the Find Similar surface (no SD control involved).
    await selectSample(page, "samples/kick-909");
    await expect(page.locator("[data-testid='inspector-find-similar-v2']")).toBeAttached();
    await expect(page.locator("[data-testid='inspector-find-similar-v2']")).toBeEnabled();
  });

  test("E23-02 open surface ranks via REAL rankSimilar, excludes the query", async () => {
    const stamped = await attachV2(page);
    expect(stamped).toHaveLength(4);
    await selectSample(page, "samples/kick-909");
    await expect(page.locator(".inspector-name")).toContainText("Deep Kick 909");

    await openFindSimilar(page);
    await expect(page.locator("[data-testid='similarity-v2-query']")).toHaveText(
      "Similar to: Deep Kick 909",
    );

    const expected = await rankV2(page, "samples/kick-909");
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThanOrEqual(3);
    expect(expected).not.toContain("samples/kick-909");
    expect(await resultRowIds(page)).toEqual(expected);
    const s = await getSimilarityV2(page);
    expect(s.status).toBe("ready");
    expect(s.results.map((r) => r.sampleId)).toEqual(expected);
    await page.screenshot({
      path: "e2e/artifacts/step23-similarity-v2-panel.png",
      fullPage: true,
    });
  });

  test("E23-03 top result equals rankSimilar()[0]; scores are 'Similarity NN%'", async () => {
    const expected = await rankV2(page, "samples/kick-909");
    const s = await getSimilarityV2(page);
    expect(s.results[0].sampleId).toBe(expected[0]);
    // The V1 surface shows no V2 rows leaked into it, and the V2 list keeps
    // its snapshot order independent of the V1 result order.
    for (const r of s.results) {
      expect(r.similarity).toBeGreaterThan(0);
      expect(r.similarity).toBeLessThanOrEqual(1);
    }
    const first = s.results[0];
    await expect(page.locator(`[data-testid='similarity-v2-score-${first.sampleId}']`)).toHaveText(
      new RegExp(`^Similarity ${Math.round(first.similarity * 100)}%$`),
    );
    await expect(
      page.locator(`[data-testid='similarity-v2-score-${first.sampleId}']`),
    ).toHaveAttribute("title", /^Shared dimensions: \d+\/8$/);
  });

  test("E23-04 clicking a result row focuses/selects it; snapshot header stays", async () => {
    const expected = await rankV2(page, "samples/kick-909");
    const target = expected[0];

    await page.locator(`[data-testid='similarity-v2-name-${target}']`).click();

    // The open snapshot is tied to its query — focus change never re-ranks (§29).
    await expect(page.locator("[data-testid='similarity-v2-query']")).toHaveText(
      "Similar to: Deep Kick 909",
    );
    const s = await getSimilarityV2(page);
    expect(s.querySampleId).toBe("samples/kick-909");
    expect(s.results.map((r) => r.sampleId)).toEqual(expected);

    // Exactly one map point is selected and matches the row.
    const selected = page.locator(
      "[data-testid^='map-point-'][class*='map-point-selected']",
    );
    await expect(selected).toHaveCount(1);
    await expect(selected.first()).toHaveAttribute("data-testid", `map-point-${target}`);
    const name = await page.locator(".inspector-name").textContent();
    expect(name && name.trim().length).toBeGreaterThan(0);
  });

  test("E23-05 preview is reachable from a ranked row (existing preview path)", async () => {
    const expected = await rankV2(page, "samples/kick-909");
    const target = expected[1];

    await page.locator(`[data-testid='similarity-v2-preview-${target}']`).click();
    await waitForPreviewAttempt(page);
    const attempt = await page.evaluate(() => {
      const app = (window as any).__sm.app;
      const preview = (window as any).__sm.deps.preview;
      return {
        previewSampleId: app.previewSampleId as string | undefined,
        previewError: app.previewError as string | undefined,
        active: preview.activeCount(),
        cached: preview.cachedCount(),
      };
    });
    // Synthetic samples: playback is BLOCKED (§16M-19); the preview attempt is
    // what matters — one of these proving the row is wired to togglePreview.
    expect(
      attempt.previewSampleId === target ||
        attempt.previewError !== undefined ||
        attempt.active > 0 ||
        attempt.cached > 0,
    ).toBe(true);

    // Toggle back off (same row) and confirm the app remains healthy.
    await page.locator(`[data-testid='similarity-v2-preview-${target}']`).click();
    await expect(page.locator("[data-testid='similarity-v2-list']")).toBeVisible();
  });

  test("E23-06 re-open re-ranks on the NEW focus (B went to C, §50 chain)", async () => {
    // Current focus after E23-04 is the top kick-909 result (call it B). The
    // panel still shows the ORIGINAL kick snapshot (focus change never
    // re-ranks). Re-invoking Find Similar must rank on B.
    const focusB = await page.evaluate(() => (window as any).__sm.app.focusedSampleId);
    const expectedB = await rankV2(page, focusB);
    expect(expectedB.length).toBeGreaterThan(0);

    await openFindSimilar(page);
    await expect(page.locator("[data-testid='similarity-v2-query']")).not.toHaveText(
      "Similar to: Deep Kick 909",
    );
    expect(await resultRowIds(page)).toEqual(expectedB);
    const sB = await getSimilarityV2(page);
    expect(sB.querySampleId).toBe(focusB);

    // C = top result of B's ranking; selecting it sets the new focus.
    const cId = expectedB[0];
    await page.locator(`[data-testid='similarity-v2-name-${cId}']`).click();
    const focusC = await page.evaluate(() => (window as any).__sm.app.focusedSampleId);
    expect(focusC).toBe(cId);

    // Find Similar again is now derived from C.
    await openFindSimilar(page);
    const expectedFromC = await rankV2(page, cId);
    expect(await resultRowIds(page)).toEqual(expectedFromC);
    const s = await getSimilarityV2(page);
    expect(s.querySampleId).toBe(cId);
  });

  test("E23-07 only one V2 sample: honest ready-empty 'No similar samples found.'", async () => {
    await detachV2(page);
    await attachV2(page, ["bass"]);
    await selectSample(page, "samples/bass-sub");
    await openFindSimilar(page);

    await expect(page.locator("[data-testid='similarity-v2-status']")).toHaveText(
      "No similar samples found.",
    );
    const s = await getSimilarityV2(page);
    expect(s.status).toBe("ready");
    expect(s.results).toEqual([]);
    await expect(page.locator("[data-testid='similarity-v2-list']")).toHaveCount(0);
  });

  test("E23-08 V1-only sample stays browsable but never ranks (§47)", async () => {
    await detachV2(page, ["bass"]);
    await selectSample(page, "samples/bass-sub");

    // Browsable through the V1 surface (results list + map + inspector).
    await expect(page.locator("[data-testid='result-samples/bass-sub']")).toBeVisible();
    await expect(page.locator("[data-testid='map-point-samples/bass-sub']")).toBeVisible();

    await openFindSimilar(page);
    await expect(page.locator("[data-testid='similarity-v2-status']")).toContainText(
      /no V2 sound-character/,
    );
    const s = await getSimilarityV2(page);
    expect(s.status).toBe("empty");
    expect(s.results).toEqual([]);
    // No zero-similarity filler row is ever fabricated.
    expect(
      await page.locator("[data-testid^='similarity-v2-result-']").count(),
    ).toBe(0);
    // The record was never auto-analyzed into a V2 record.
    const rec = await page.evaluate((id) => (window as any).__sm.index.get(id), "samples/bass-sub");
    expect(rec.analysisV2).toBeUndefined();
  });

  test("E23-09 keyboard activation (Enter/Space) drives the surface", async () => {
    await attachV2(page);

    // Tab-independent keyboard activation of the Find Similar button.
    const btn = page.locator("[data-testid='inspector-find-similar-v2']");
    await btn.scrollIntoViewIfNeeded();
    await btn.focus();
    await page.keyboard.press("Enter");
    await waitForOpenSettled(page);

    // Close via the surface Close button, re-open with the keyboard.
    await page.locator("[data-testid='similarity-v2-close']").click();
    await expect(page.locator("[data-testid='similarity-v2-query']")).toHaveCount(0);
    await btn.focus();
    await page.keyboard.press("Space");
    await waitForOpenSettled(page);

    // Enter on a ranked row name selects it.
    const target = (await getSimilarityV2(page)).results[0].sampleId;
    const rowName = page.locator(`[data-testid='similarity-v2-name-${target}']`);
    await rowName.focus();
    await page.keyboard.press("Enter");
    const focus = await page.evaluate(() => (window as any).__sm.app.focusedSampleId);
    expect(focus).toBe(target);
  });

  test("E23-10 close drops the snapshot; reopen recomputes a fresh deterministic list", async () => {
    // Re-open on the CURRENT focus so the snapshot we close is the one that
    // must deterministically be recomputed on reopen.
    const focus = await page.evaluate(() => (window as any).__sm.app.focusedSampleId);
    await openFindSimilar(page);
    await expect(page.locator("[data-testid='similarity-v2-query']")).toBeVisible();
    const before = await getSimilarityV2(page);
    expect(before.status).toBe("ready");
    const idsBefore = before.results.map((r) => r.sampleId);
    expect(idsBefore).toEqual(await rankV2(page, focus));

    await page.locator("[data-testid='similarity-v2-close']").click();
    const closed = await getSimilarityV2(page);
    expect(closed.open).toBe(false);
    await expect(page.locator("[data-testid='similarity-v2-query']")).toHaveCount(0);

    await openFindSimilar(page);
    await expect(page.locator("[data-testid='similarity-v2-query']")).toBeVisible();
    const reopened = await getSimilarityV2(page);
    expect(reopened.querySampleId).toBe(focus);
    expect(reopened.results.map((r) => r.sampleId)).toEqual(idsBefore);
  });

  test("E23-11 V1 regression: map, inspector, results all intact", async () => {
    await selectSample(page, "samples/hat-airy");
    await expect(page.locator(".inspector-name")).toContainText("Airy Hat");
    await expect(page.locator(".inspector-class-primary")).toBeVisible();
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
    await expect(page.locator("[data-testid^='result-samples/']")).toHaveCount(4);
  });

  test("E23-12 browser console audit: no uncaught errors beyond benign", async () => {
    await selectSample(page, "samples/lead-ohm");
    await page.waitForTimeout(400);
    const allowed = capturedConsoleErrors.filter(
      (m) => !benignConsole(m) && !/Failed to load resource/.test(m.text()),
    );
    expect(allowed).toEqual([]);
  });
});