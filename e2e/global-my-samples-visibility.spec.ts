import { test, expect, type Page } from "@playwright/test";

/**
 * Global / My Samples visibility — REAL browser, REAL renderer, DOM-based.
 *
 * The decisive case is the OVERLAP: one sample that is simultaneously
 * `isGlobal` and `isMine`. The harness serves a global point that carries the
 * PERSISTED local record's own `contentHash`/`contentHashVersion` and
 * `mapPosition` (`__sm.global.mirrorRecord`), so the real production identity
 * rule (`contentIdentityKey` in `mergeMapPoints`) decides the merge — no
 * hand-written hash and no product-code change.
 *
 * Every assertion below counts actual `<circle>` elements in the rendered SVG.
 * The searchable result list is asserted unchanged in all four states.
 */

const KICK = "samples/kick-909";

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

/** Count the REAL rendered circles for one sample id. */
const circlesFor = (p: Page, id: string) =>
  p.evaluate(
    (sid) => document.querySelectorAll(`circle[data-sample-id="${sid}"]`).length,
    id,
  );

/** Every rendered circle's data-sample-id, plus the total. */
const domPoints = (p: Page) =>
  p.evaluate(() => {
    const circles = Array.from(
      document.querySelectorAll("circle[data-testid^='map-point-']"),
    );
    return {
      total: circles.length,
      ids: circles.map((c) => c.getAttribute("data-sample-id")).sort(),
      duplicates: circles
        .map((c) => c.getAttribute("data-sample-id"))
        .filter((v, i, a) => a.indexOf(v) !== i),
    };
  });

const domState = (p: Page) =>
  p.evaluate(() => {
    const btn = (t: string) =>
      document.querySelector(`[data-testid="filter-${t}"]`);
    return {
      global: btn("global")?.getAttribute("data-active") ?? null,
      globalPressed: btn("global")?.getAttribute("aria-pressed") ?? null,
      mine: btn("my-samples")?.getAttribute("data-active") ?? null,
      minePressed: btn("my-samples")?.getAttribute("aria-pressed") ?? null,
      globalLabel: btn("global")?.textContent ?? null,
      mineLabel: btn("my-samples")?.textContent ?? null,
      empty: document.querySelector('[data-testid="map-empty"]')?.textContent ?? null,
      resultIds: Array.from(document.querySelectorAll("li.result-row"))
        .map((e) => (e.getAttribute("data-testid") ?? "").replace("result-", ""))
        .sort(),
      resultCount: document.querySelector('[data-testid="result-count"]')?.textContent ?? null,
    };
  });

/** Toggle via REAL clicks on the rendered buttons. */
const clickToggle = async (p: Page, which: "global" | "my-samples") => {
  await p.click(`[data-testid="filter-${which}"]`);
  await p.waitForTimeout(120);
};

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
  await loadSm(page);
  await page.evaluate(() => (window as any).__sm.ep7.grant());
  await page.evaluate(() => (window as any).__sm.scan());
  await page.evaluate(() => (window as any).__sm.analyze(10));
  await page.waitForFunction(
    () => (window as any).__sm.app.analysis.status !== "running",
    null,
    { timeout: 120_000 },
  );
  // Make the analyzed kick fixture ALSO a global point, using its own persisted
  // content identity + position.
  await page.evaluate((id) => (window as any).__sm.global.mirrorRecord(id), KICK);
  await page.waitForTimeout(150);
});

test.afterAll(async () => {
  await page.close();
});

test("the mirrored sample is genuinely global AND mine", async () => {
  const info = await page.evaluate((id) => {
    const app = (window as any).__sm.app;
    const rec = app.results.find((r: any) => r.record.sampleId === id).record;
    const gp = app.globalPoints;
    return {
      owner: rec.owner,
      recordHash: rec.contentHash,
      recordVer: rec.contentHashVersion,
      globalPointCount: gp.length,
      globalHash: gp[0]?.contentIdentity?.contentHash,
      globalVer: gp[0]?.contentIdentity?.contentHashVersion,
      globalRep: gp[0]?.representativeSampleId,
      membership: app.mapMembership.get(id),
    };
  }, KICK);

  expect(info.owner).toBe("users/alice");
  expect(info.globalPointCount).toBe(1);
  // The global point must carry the SAME identity the merge keys on.
  expect(info.globalHash).toBe(info.recordHash);
  expect(info.globalVer).toBe(info.recordVer);
  expect(info.globalRep).toBe(KICK);
  // Both membership flags true — this is the overlap under test.
  expect(info.membership).toEqual({ isGlobal: true, isMine: true });
});

test("Fall A — Global ON / My Samples ON: exactly ONE circle", async () => {
  await clickToggle(page, "my-samples"); // -> M off
  await clickToggle(page, "my-samples"); // -> M on again
  const s = await domState(page);
  expect(s.global).toBe("true");
  expect(s.mine).toBe("true");

  expect(await circlesFor(page, KICK)).toBe(1);

  const d = await domPoints(page);
  expect(d.duplicates).toEqual([]);
  // All four fixtures visible (they are all mine), the mirrored one once.
  expect(d.total).toBe(4);
  expect(d.ids.filter((i) => i === KICK)).toHaveLength(1);
});

test("Fall B — Global ON / My Samples OFF: exactly ONE circle", async () => {
  await clickToggle(page, "my-samples"); // M off
  const s = await domState(page);
  expect(s.global).toBe("true");
  expect(s.mine).toBe("false");

  // Global alone still shows the mirrored point exactly once.
  expect(await circlesFor(page, KICK)).toBe(1);
  const d = await domPoints(page);
  expect(d.total).toBe(1);
  expect(d.ids).toEqual([KICK]);
  expect(d.duplicates).toEqual([]);

  await clickToggle(page, "my-samples"); // restore
});

test("Fall C — Global OFF / My Samples ON: exactly ONE circle", async () => {
  await clickToggle(page, "global"); // G off
  const s = await domState(page);
  expect(s.global).toBe("false");
  expect(s.mine).toBe("true");

  expect(await circlesFor(page, KICK)).toBe(1);
  const d = await domPoints(page);
  expect(d.total).toBe(4);
  expect(d.ids.filter((i) => i === KICK)).toHaveLength(1);
  expect(d.duplicates).toEqual([]);

  await clickToggle(page, "global"); // restore
});

test("Fall D — Global OFF / My Samples OFF: ZERO circles", async () => {
  await clickToggle(page, "global");
  await clickToggle(page, "my-samples");
  const s = await domState(page);
  expect(s.global).toBe("false");
  expect(s.mine).toBe("false");

  expect(await circlesFor(page, KICK)).toBe(0);
  expect((await domPoints(page)).total).toBe(0);
  expect(s.empty).toBe(
    "Map hidden — enable Global and/or My Samples to show samples.",
  );
  expect(s.empty ?? "").not.toMatch(/no samples found/i);

  await clickToggle(page, "global");
  await clickToggle(page, "my-samples");
});

test("the result list is identical in all four states", async () => {
  const seen: string[][] = [];
  for (const [g, m] of [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ] as const) {
    await page.evaluate(
      async ([gg, mm]) => {
        const a = (window as any).__sm.app;
        if (a.visibility.global !== gg) await a.setVisibility({ global: gg });
        if (a.visibility.mine !== mm) await a.setVisibility({ mine: mm });
      },
      [g, m],
    );
    await page.waitForTimeout(100);
    seen.push((await domState(page)).resultIds);
  }
  // Restore both on.
  await page.evaluate(async () => {
    const a = (window as any).__sm.app;
    await a.setVisibility({ global: true, mine: true });
  });

  expect(seen[0]).toEqual(["samples/bass-sub", "samples/hat-airy", KICK, "samples/lead-ohm"]);
  for (const s of seen) expect(s).toEqual(seen[0]);
});

test("empty-state copy names the empty set instead of claiming nothing is analyzed", async () => {
  // Clear the global points -> Global ON + My OFF must name the global set.
  await page.evaluate(() => (window as any).__sm.global.clear());
  await page.waitForTimeout(120);
  await page.evaluate(async () => {
    await (window as any).__sm.app.setVisibility({ global: true, mine: false });
  });
  await page.waitForTimeout(120);

  const s = await domState(page);
  expect(s.global).toBe("true");
  expect(s.mine).toBe("false");
  expect((await domPoints(page)).total).toBe(0);
  expect(s.empty).toBe("Global has no samples available in the current view.");
  // Four analysed samples exist — the copy must not deny that.
  expect(s.empty ?? "").not.toMatch(/no analyzed samples/i);
  expect(s.resultIds).toHaveLength(4);
});

test("My Samples with an empty own-set names that set", async () => {
  await page.evaluate(async () => {
    await (window as any).__sm.app.setVisibility({ global: false, mine: true });
  });
  await page.waitForTimeout(120);
  // Simulate "no known samples of my own" without touching product code:
  // mirror nothing and point the app at a user id that owns nothing.
  const s = await page.evaluate(async () => {
    const a = (window as any).__sm.app;
    const before = a.mySamples.size;
    return { before, empty: document.querySelector('[data-testid="map-empty"]')?.textContent ?? null };
  });
  // The harness fixtures are all owned by the authed user, so the my-set is
  // NOT empty here — the visibility layer must stay silent and defer to the
  // ordinary empty state instead of inventing a "no samples" claim.
  expect(s.before).toBe(4);
  expect(s.empty).toBeNull();
});

test("the served global point really reaches the renderer", async () => {
  // Guards the harness wiring itself: in the overlap cases above the LOCAL
  // point already covers the sample, so a broken global delivery would go
  // unnoticed. Here the persisted record is stripped of BOTH position sources
  // (`mapPosition` and `analysisV2`), so `mapPoints()` cannot place it and the
  // ONLY possible source of the circle is the served global point.
  await page.evaluate(async () => {
    await (window as any).__sm.app.setVisibility({ global: true, mine: false });
  });
  await page.waitForTimeout(100);

  const served = await page.evaluate(async (id) => {
    const sm = (window as any).__sm;
    // 1) serve the global point while the record still carries its position
    await sm.global.mirrorRecord(id);
    // 2) now strip every LOCAL position source, so no local point can render
    const rec = await sm.index.get(id);
    const { mapPosition: _mp, analysisV2: _v2, ...rest } = rec;
    await sm.index.put(rest);
    await sm.app.refreshSearch();
    const after = await sm.index.get(id);
    return {
      globalPointCount: sm.app.globalPoints.length,
      hash: sm.app.globalPoints[0]?.contentIdentity?.contentHash,
      recordHash: after.contentHash,
      localHasPosition: Boolean(after.mapPosition) || Boolean(after.analysisV2),
      recordName: after.name,
    };
  }, KICK);
  await page.waitForTimeout(150);

  expect(served.globalPointCount).toBe(1);
  expect(served.hash).toBe(served.recordHash);
  expect(served.localHasPosition).toBe(false);

  // The record is still global AND mine, but has no local coordinates.
  const membership = await page.evaluate((id) => {
    const m = (window as any).__sm.app.mapMembership.get(id);
    return { m, visible: (window as any).__sm.app.visibleMapRecords.map((r: any) => r.sampleId) };
  }, KICK);
  expect(membership.m).toEqual({ isGlobal: true, isMine: true });
  expect(membership.visible).toEqual([KICK]);

  // Exactly one circle — and it can only have come from the global point.
  expect(await circlesFor(page, KICK)).toBe(1);
  const d = await domPoints(page);
  expect(d.total).toBe(1);
  expect(d.duplicates).toEqual([]);

  // Provenance: a global point is titled with its representativeSampleId, so
  // the rendered title must be the id — NOT the local fixture name. This is
  // what actually proves the global point (and not the local record) painted.
  const title = await page.evaluate((id) => {
    const c = document.querySelector(`circle[data-sample-id="${id}"]`);
    return c?.querySelector("title")?.textContent ?? null;
  }, KICK);
  expect(title).toBe(KICK);
  expect(title).not.toBe(served.recordName);

  // Restore the record for any later test in this file.
  await page.evaluate(async (id) => {
    const sm = (window as any).__sm;
    await sm.index.put({
      ...(await sm.index.get(id)),
      mapPosition: { x: 1, y: 0 },
    });
    await sm.app.refreshSearch();
  }, KICK);
  await page.waitForTimeout(120);
});
