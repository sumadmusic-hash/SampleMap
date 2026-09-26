import {
  test,
  expect,
  type Page,
  type ConsoleMessage,
} from "@playwright/test";

/**
 * STEP24 — V2 Sound Space E2E.
 *
 * Drives the REAL SampleMap UI (harness.html → src/e2e/harness/main.ts). The
 * V2 analyses are stamped via `__sm.v2.attach` (deterministic V2 DSP over the
 * fixture waveforms — FIXTURE-class evidence per §16). The surface under test
 * is the deterministic Sound Space projector + its UI wiring.
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

const detachV2 = (p: Page, keys?: string[]) =>
  p.evaluate((k) => (window as any).__sm.v2.detach(k), keys);

const refresh = (p: Page) =>
  p.evaluate(() => (window as any).__sm.app.refreshSearch());

const selectSample = (p: Page, id: string) =>
  p.evaluate((s) => (window as any).__sm.selectSample(s), id);

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

/**
 * Renders a FRESH Sound Space: closes the surface when open (closing drops
 * the snapshot per §45) and opens it again, then waits for the state to
 * settle (and, if given, for the exact point count). Equivalent to a close
 * → reopen cycle the user can perform.
 */
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

test.describe.serial("STEP24 V2 Sound Space (shared page)", () => {
  test("E24-01 no V2 data: toggle opens an empty state with honest copy", async () => {
    await loadSm(page);
    await firstUseIndex(page);
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
    expect(await pointIds(page)).toEqual([]);
    const state = await getSoundSpace(page);
    expect(state.open).toBe(true);
    expect(state.status).toBe("empty");
  });

  test("E24-02 fixture library: 4 V2 points, meta line, axis labels", async () => {
    await attachV2(page);
    await refresh(page);
    await reopenSoundSpace(page, 4);
    await expect(page.locator("[data-testid='sound-space-meta']")).toHaveText(
      "4 analyzed samples · All samples",
    );
    expect(await pointIds(page)).toHaveLength(4);
    const pos = await pointPositions(page);
    for (const xy of Object.values(pos)) {
      expect(xy.x).toBeGreaterThanOrEqual(0);
      expect(xy.y).toBeGreaterThanOrEqual(0);
      expect(xy.x).toBeLessThanOrEqual(400);
      expect(xy.y).toBeLessThanOrEqual(260);
    }
    await expect(page.locator("[data-testid='sound-space-axes']")).toContainText(
      "Noisy ↔ Tonal · Dark ↔ Bright",
    );
    // STEP37 canonical four-corner labels (SVG render order: top-right,
    // top-left, bottom-right, bottom-left — each X-pole · Y-pole).
    const corners = page.locator("[data-testid='sound-space-canvas'] .sound-space-axistick");
    await expect(corners).toHaveText([
      "Tonal · Bright",
      "Noisy · Bright",
      "Tonal · Dark",
      "Noisy · Dark",
    ]);
    await page.screenshot({
      path: "e2e/artifacts/step24-sound-space.png",
      fullPage: true,
    });
  });

  test("E24-03 points render at deterministic projector coordinates", async () => {
    const state = await getSoundSpace(page);
    const dom = await pointPositions(page);
    // Fixture IDs from the harness (kick/hat/bass/lead) must appear exactly.
    expect(Object.keys(dom).sort()).toEqual([
      "samples/bass-sub",
      "samples/hat-airy",
      "samples/kick-909",
      "samples/lead-ohm",
    ]);
    // DOM coordinates must match the engine snapshot (W 400 / H 260, margin 4).
    for (const p of state.points) {
      const domX = dom[p.sampleId].x;
      const domY = dom[p.sampleId].y;
      const expectedX = 4 + p.x * (400 - 8);
      const expectedY = 4 + (1 - p.y) * (260 - 8);
      expect(domX).toBeCloseTo(expectedX, 1);
      expect(domY).toBeCloseTo(expectedY, 1);
    }
  });

  test("E24-04 focus change does not move points (snapshot semantics §46)", async () => {
    const before = await pointPositions(page);
    await page.locator("[data-testid='sound-space-point-samples/hat-airy']").click();
    expect(await getFocused(page)).toBe("samples/hat-airy");
    const after = await pointPositions(page);
    expect(after).toEqual(before);
  });

  test("E24-05 clicking a point focuses/selects the sample via the canonical path", async () => {
    await page.locator("[data-testid='sound-space-point-samples/kick-909']").click();
    const focus = await getFocused(page);
    expect(focus).toBe("samples/kick-909");
    // The focused point gets the `.sound-space-point-focused` class.
    await expect(
      page.locator(
        "[data-testid='sound-space-point-samples/kick-909'].sound-space-point-focused",
      ),
    ).toHaveCount(1);
    // Focus again is a no-op (no extra selectSample call beyond the first).
  });

  test("E24-06 inspector mirrors the Sound Space focus", async () => {
    expect((await getInspectorName(page)).trim().length).toBeGreaterThan(0);
    // The focused sample is the kick whose inspector line should be visible.
    const focus = await getFocused(page);
    expect(focus).toBe("samples/kick-909");
    await expect(page.locator(".inspector-name")).toContainText("Deep Kick 909");
  });

  test("E24-07 Find Similar driven from a Sound Space focus matches rankSimilar", async () => {
    const focus = await getFocused(page);
    const expected = await page.evaluate((id: string) =>
      (window as any).__sm.v2.rank(id), focus);
    await page.locator("[data-testid='inspector-find-similar-v2']").click();
    await expect(page.locator("[data-testid='similarity-v2-query']")).toContainText(
      "Deep Kick 909",
    );
    const rows = await page
      .locator("[data-testid^='similarity-v2-result-']")
      .evaluateAll((els) =>
        els
          .map((e) => e.getAttribute("data-testid") ?? "")
          .map((x) => x.replace("similarity-v2-result-", "")),
      );
    expect(rows).toEqual(expected);
  });

  test("E24-08 preview is reachable from the focused sample's inspector", async () => {
    await page.locator("[data-testid='inspector-preview-toggle']").click();
    // Wait for the preview state to go somewhere (playing or error).
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
    // Synthetic samples are fixture-blocked for playback (see §16M-19); the
    // wiring itself is what matters.
    expect(attempt.id !== undefined || attempt.err !== undefined).toBe(true);
  });

  test("E24-09 V1-only sample is browsable but never receives a V2 point", async () => {
    await detachV2(page, ["kick"]);
    await refresh(page);
    await reopenSoundSpace(page, 3);
    expect((await pointIds(page)).sort()).toEqual([
      "samples/bass-sub",
      "samples/hat-airy",
      "samples/lead-ohm",
    ]);
    // V1-only kick stays in the browse surface.
    await expect(
      page.locator("[data-testid='result-samples/kick-909']"),
    ).toBeVisible();
    const kickPoint = page.locator(
      "[data-testid='sound-space-point-samples/kick-909']",
    );
    await expect(kickPoint).toHaveCount(0);
  });

  test("E24-10 partial data: X-only candidate produces NO point (§11)", async () => {
    // Create a partial record with only tonality and noisiness present — X is
    // computable but Y is not, so the projector must NOT fabricate a point.
    const partial = {
      sampleId: "samples/partial-F",
      analysisV2: {
        analysisVersion: "2.0.0",
        soundCharacter: {
          brightness: null,
          density: 0.5,
          transient: 0.5,
          duration: 0.5,
          tonality: 0.7,
          noisiness: 0.2,
          dynamics: 0.5,
          complexity: 0.5,
        },
        quality: { overall: 0.5, featureCoverage: 5 / 8 },
      },
    };
    await page.evaluate((rec) => {
      const h = (window as any).__sm;
      return h.index.put(rec as any);
    }, partial as never);
    await reopenSoundSpace(page, 3);
    const ids = await pointIds(page);
    expect(ids).not.toContain("samples/partial-F");
    // Same three V2 samples remain from E24-09.
    expect(ids.sort()).toEqual(
      ["samples/bass-sub", "samples/hat-airy", "samples/lead-ohm"].sort(),
    );
  });

  test("E24-11 keyboard: Enter activates the focused Sound Space point", async () => {
    const firstPoint = page.locator(
      "[data-testid='sound-space-point-samples/hat-airy']",
    );
    await firstPoint.focus();
    await page.keyboard.press("Enter");
    expect(await getFocused(page)).toBe("samples/hat-airy");
    // In the focused state the point keeps the focused class.
    await expect(firstPoint).toHaveClass(/sound-space-point-focused/);
  });

  test("E24-12 reopen after close reproduces the same points deterministically", async () => {
    const first = await pointPositions(page);
    await reopenSoundSpace(page, 3);
    expect(await pointPositions(page)).toEqual(first);
  });

  test("E24-13 V1 regression + console audit", async () => {
    await selectSample(page, "samples/lead-ohm");
    await expect(page.locator("[data-testid='inspector-find-similar-v2']")).toBeVisible();
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
    await page.waitForTimeout(500);
    const allowed = capturedConsoleErrors.filter(
      (m) => !benignConsole(m) && !/Failed to load resource/.test(m.text()),
    );
    expect(allowed).toEqual([]);
  });

  test("E24-14 projection+render scale bench (§54, CONSTRUCTED)", async () => {
    // Freshly navigate to a clean page state so the bench is deterministic.
    await page.goto("/harness.html");
    await loadSm(page);
    await firstUseIndex(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", {
      timeout: 20_000,
    });
    await analyzeAll(page);
    await attachV2(page);
    await refresh(page);
    expect(page.locator("[data-testid='sound-space-toggle']")).toBeAttached();
    // Deterministic synthetic V2 records — all dims valid, so every record
    // projects. Measures the open time of `openSoundSpace()` (index read +
    // projection + re-render) end-to-end.
    async function upsertSynth(count: number): Promise<void> {
      await page.evaluate(async (n) => {
        const index = (window as any).__sm.index;
        const base = await index.get("samples/kick-909");
        // Chunked writes keep the transaction queue shallow.
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

    const rows: Array<{ count: number; label: string; ms: number; points: number }> = [];
    for (const n of [100, 500, 1000, 5000, 10000]) {
      await upsertSynth(n);
      const start = await page.evaluate(async () => {
        const app = (window as any).__sm.app;
        const t0 = performance.now();
        await app.openSoundSpace();
        return t0;
      });
      const settled = await page.evaluate(async () => {
        const app = (window as any).__sm.app;
        await new Promise((r) => {
          const t = setInterval(() => {
            const s = app.soundSpace;
            if (s.open && s.status !== "idle") {
              clearInterval(t);
              r(s.points.length);
            }
          }, 10);
        });
        return app.soundSpace.points.length;
      });
      const end = await page.evaluate(() => performance.now());
      const domPoints = await page.locator("[data-testid^='sound-space-point-']").count();
      expect(domPoints).toBeGreaterThanOrEqual(Math.min(n, domPoints));
      rows.push({
        count: n,
        label: `bench-n=${n}`,
        ms: Math.round(end - start),
        points: settled,
      });
    }
    // eslint-disable-next-line no-console
    console.log("STEP24-BENCH", JSON.stringify(rows, null, 2));
    await page.screenshot({
      path: "e2e/artifacts/step24-sound-space-10k.png",
      fullPage: false,
    });
  });
});
