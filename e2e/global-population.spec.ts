import { test, expect, type Page } from "@playwright/test";

/**
 * Step 70 E2E — Automatic Global Population & Map Verification
 *
 * Verifies end-to-end in real browser:
 *  1. Local analysis completion automatically populates publish queue
 *  2. Candidates carry ONLY metadata, NO audio bytes
 *  3. Dedup: re-population is sampleId-level idempotent
 *  4. Offline: delivery remains pending until a live flush
 *  5. Live flush delivers candidates and marks local records as "published"
 *  6. Global visibility projection (Global ON/OFF, My Samples ON/OFF, Overlap union)
 */

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

/**
 * STEP82 — the live E2E Worker URL.
 *
 * Test 6 performs REAL D1 WRITES, so it must run against a dedicated, disposable
 * E2E deployment and NEVER against production:
 *
 *   SAMPLEMAP_E2E_WORKER_URL=https://samplemap-d1-worker-e2e.sumadmusic.workers.dev \
 *     npx playwright test e2e/global-population.spec.ts
 *
 * The E2E Worker is the SAME implementation as production (same `main`, same
 * migrations, same publish/conflict/dedup semantics) — it is only bound to a
 * separate D1 database via the `e2e` environment in
 * `workers/d1-worker/wrangler.toml`.
 *
 * The production URL is deliberately NOT baked in as a default. If the variable
 * is missing the test throws, because silently writing test rows into the
 * production GlobalSampleIndex database is exactly the failure this guards
 * against. The production URL is also rejected explicitly.
 */
const E2E_WORKER_URL = process.env.SAMPLEMAP_E2E_WORKER_URL;

/** Production Worker. Named only so it can be refused — never a fallback. */
const PRODUCTION_WORKER_URL = "https://samplemap-d1-worker.sumadmusic.workers.dev";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("Step 70 — Automatic Global Population E2E", () => {
  test("1. Analysis completion automatically enqueues all eligible analyzed records", async () => {
    await loadSm(page);

    // Initial state: queue is empty
    const initialPending = await page.evaluate(
      () => (window as any).__sm.publish.queue.pendingCount,
    );
    expect(initialPending).toBe(0);

    // Scan + analyze fixture library (4 samples)
    await page.locator("[data-testid='first-use-index']").click();
    await expect(page.locator(".scan-status")).toContainText("Complete", {
      timeout: 20_000,
    });
    await page.evaluate((b) => (window as any).__sm.analyze(b), 10);
    await expect(page.locator(".analysis-status")).toContainText(/Stopped|Idle/, {
      timeout: 30_000,
    });

    // Wait for the automatic population to settle
    await page.waitForFunction(
      () => (window as any).__sm.publish.queue.pendingCount === 4,
      null,
      { timeout: 5_000 },
    );

    const snapshot = await page.evaluate(() =>
      (window as any).__sm.publish.queue.snapshot(),
    );
    expect(snapshot).toHaveLength(4);

    const sampleIds = snapshot.map((i: any) => i.sampleId).sort();
    expect(sampleIds).toEqual([
      "samples/bass-sub",
      "samples/hat-airy",
      "samples/kick-909",
      "samples/lead-ohm",
    ]);

    // Check all candidates are pending
    for (const item of snapshot) {
      expect(item.status).toBe("pending");
      expect(item.attempts).toBe(0);
    }

    // Check all records have pending marker
    const records = await page.evaluate(() => (window as any).__sm.index.getAll());
    expect(records).toHaveLength(4);
    for (const rec of records) {
      expect(rec.globalPublish).toBeDefined();
      expect(rec.globalPublish.delivery).toBe("pending");
      expect(typeof rec.globalPublish.usageAcceptedAt).toBe("string");
    }
  });

  test("2. No-audio invariant: publish candidate payloads are strictly audio-free", async () => {
    const candidates = await page.evaluate(() =>
      (window as any).__sm.publish.queue.snapshot().map((i: any) => i.candidate),
    );
    expect(candidates).toHaveLength(4);

    for (const cand of candidates) {
      // Must have sampleId, contentIdentity, analysis, features
      expect(cand.sampleId).toBeDefined();
      expect(cand.contentIdentity.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(cand.contentIdentity.contentHashVersion).toBe("pcm-v1");
      expect(cand.analysis.map.x).toBeGreaterThanOrEqual(0);
      expect(cand.analysis.map.x).toBeLessThanOrEqual(1);
      expect(cand.analysis.map.y).toBeGreaterThanOrEqual(0);
      expect(cand.analysis.map.y).toBeLessThanOrEqual(1);

      // JSON serialized string MUST NOT contain any audio buffers or raw byte fields
      const json = JSON.stringify(cand);
      expect(json).not.toMatch(/"audioBuffer"|"pcm"|"audioData"|"rawAudio"|"wavBytes"/i);
    }
  });

  test("3. Idempotency: re-running analysis when nothing due does not duplicate queue entries", async () => {
    // Re-run analyze with no new samples due
    await page.evaluate((b) => (window as any).__sm.analyze(b), 10);
    await page.waitForTimeout(300);

    const count = await page.evaluate(
      () => (window as any).__sm.publish.queue.pendingCount,
    );
    expect(count).toBe(4); // still 4, no duplicates
  });

  test("4. Live flush delivers candidates to provider and updates local delivery markers", async () => {
    // Switch delivery to live and flush with success outcomes
    await page.evaluate(() => (window as any).__sm.publish.remount("live"));
    const flushRes = await page.evaluate(() =>
      (window as any).__sm.publish.flush({
        "samples/kick-909": { status: "stored" },
        "samples/hat-airy": { status: "stored" },
        "samples/bass-sub": { status: "already-known" },
        "samples/lead-ohm": { status: "stored" },
      }),
    );

    expect(flushRes.submitted).toBe(4);
    expect(flushRes.succeeded).toBe(4);
    expect(flushRes.markedPublished).toBe(4);

    // Verify local markers are now published
    const records = await page.evaluate(() => (window as any).__sm.index.getAll());
    for (const rec of records) {
      expect(rec.globalPublish?.delivery).toBe("published");
    }
  });

  test("5. Global map visibility & overlap: Global ON / My OFF / Union semantics", async () => {
    // Inject the published candidates as GlobalMapPoints into the provider
    const candidates = await page.evaluate(() =>
      (window as any).__sm.publish.queue.snapshot().map((i: any) => i.candidate),
    );

    await page.evaluate((cands: any[]) => {
      const pts = cands.map((c: any) => ({
        contentIdentity: c.contentIdentity,
        x: c.analysis.map.x,
        y: c.analysis.map.y,
        representativeSampleId: c.sampleId,
        primaryClass: c.analysis.primaryClass,
      }));
      (window as any).__sm.publish.provider.setMapPoints(pts);
    }, candidates);

    // Refresh global points
    await page.evaluate(() => (window as any).__sm.app.refreshGlobalPoints());
    await page.waitForTimeout(200);

    // Case 1: Global ON + My ON (default) -> Union (all 4 points, no duplicates)
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: true, mine: true }),
    );
    await page.waitForTimeout(100);
    const visibleUnion = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(visibleUnion).toBe(4);

    // Case 2: Global OFF + My ON -> My Samples only (4 local records)
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: false, mine: true }),
    );
    await page.waitForTimeout(100);
    const visibleMineOnly = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(visibleMineOnly).toBe(4);

    // Case 3: Global ON + My OFF -> Global only (4 global records)
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: true, mine: false }),
    );
    await page.waitForTimeout(100);
    const visibleGlobalOnly = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(visibleGlobalOnly).toBe(4);

    // Case 4: Global OFF + My OFF -> Empty map
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: false, mine: false }),
    );
    await page.waitForTimeout(100);
    const visibleNone = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(visibleNone).toBe(0);

    // Restore default
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: true, mine: true }),
    );
  });

  test("6. Dedicated E2E Cloudflare/D1 Worker: publish, query /map, verify returned points and DOM deduplication", async () => {
    // STEP82 TEST ISOLATION.
    //
    // 1) TARGET: this test WRITES to D1, so it is pinned to the dedicated E2E
    //    deployment (SAMPLEMAP_E2E_WORKER_URL). There is no production fallback
    //    — see E2E_WORKER_URL above.
    if (!E2E_WORKER_URL) {
      throw new Error(
        "SAMPLEMAP_E2E_WORKER_URL is not set. Test 6 performs real D1 writes and " +
          "must not run against production. Point it at the dedicated E2E Worker " +
          "(the `e2e` environment in workers/d1-worker/wrangler.toml):\n" +
          "  SAMPLEMAP_E2E_WORKER_URL=https://samplemap-d1-worker-e2e.sumadmusic.workers.dev " +
          "npx playwright test e2e/global-population.spec.ts",
      );
    }
    if (E2E_WORKER_URL === PRODUCTION_WORKER_URL) {
      throw new Error(
        `SAMPLEMAP_E2E_WORKER_URL points at the PRODUCTION worker (${PRODUCTION_WORKER_URL}). ` +
          "Refusing to write test rows into the production D1 database.",
      );
    }
    const workerUrl = E2E_WORKER_URL;

    // 2) SAMPLE IDs: the E2E D1 is disposable, but the per-run
    //    `e2e/step82/<runId>/…` sampleIds are still used so a rerun never
    //    collides with its own previous rows. contentIdentity, analysis,
    //    map-v2 position and features are carried over verbatim from the
    //    records analyzed in test 1 — no new analysis, no local mutation, and
    //    no change to publish/conflict/dedup semantics.

    // Check real worker connectivity from browser
    const workerLive = await page.evaluate(async (url) => {
      try {
        const res = await fetch(`${url}/health`);
        return res.ok;
      } catch {
        return false;
      }
    }, workerUrl);

    expect(workerLive, `E2E worker not reachable at ${workerUrl}`).toBe(true);

    // Stash the candidates produced by the real analysis pipeline (test 1).
    // This happens BEFORE connectLiveWorker, because connecting remounts a
    // fresh, empty publish queue.
    await page.evaluate(() => {
      const sm = (window as any).__sm;
      (window as any).__step82Source = sm.publish.queue
        .snapshot()
        .map((i: any) => ({ sampleId: i.sampleId, candidate: i.candidate }));
    });

    // 1. Connect harness to the dedicated E2E Cloudflare/D1 worker
    await page.evaluate(async (url) => {
      await (window as any).__sm.publish.connectLiveWorker(url);
    }, workerUrl);

    // Snapshot the local publish state so we can prove it is never mutated.
    const localBefore = await page.evaluate(() =>
      (window as any).__sm.index
        .getAll()
        .then((rs: any[]) =>
          rs.map((r: any) => ({
            sampleId: r.sampleId,
            contentHash: r.contentHash,
            contentHashVersion: r.contentHashVersion,
            delivery: r.globalPublish?.delivery ?? null,
          })),
        ),
    );
    expect(localBefore).toHaveLength(4);

    // 2. Re-key the analyzed candidates onto unique per-run test sampleIds.
    //    Only the top-level `sampleId` (the sample_ref edge) changes; the
    //    contentIdentity, analysis and features are carried over verbatim.
    const runId = crypto.randomUUID();
    const testSampleIdPrefix = `e2e/step82/${runId}/`;
    const assigned = await page.evaluate((prefix: string) => {
      const sm = (window as any).__sm;
      const source: any[] = (window as any).__step82Source;
      if (!Array.isArray(source) || source.length !== 4) {
        throw new Error(
          `expected 4 analyzed candidates, got ${source?.length ?? "none"}`,
        );
      }
      // Start from an empty queue so the four fixture sampleIds are never sent.
      sm.publish.clear();
      const mapped: {
        testSampleId: string;
        sourceSampleId: string;
        contentHash: string;
        contentHashVersion: string;
        mapVersion: string;
        x: number;
        y: number;
        primaryClass: string;
      }[] = [];
      for (const item of source) {
        const slug = item.sampleId.split("/").pop() ?? item.sampleId;
        const testSampleId = `${prefix}${slug}`;
        const result = sm.publish.queue.enqueue({
          ...item.candidate,
          sampleId: testSampleId,
        });
        if (result !== "queued") {
          throw new Error(`enqueue refused for ${testSampleId}: ${result}`);
        }
        mapped.push({
          testSampleId,
          sourceSampleId: item.sampleId,
          contentHash: item.candidate.contentIdentity.contentHash,
          contentHashVersion: item.candidate.contentIdentity.contentHashVersion,
          mapVersion: item.candidate.analysis.map.mapVersion,
          x: item.candidate.analysis.map.x,
          y: item.candidate.analysis.map.y,
          primaryClass: item.candidate.analysis.primaryClass,
        });
      }
      return mapped;
    }, testSampleIdPrefix);

    expect(assigned).toHaveLength(4);
    // Every test id is unique and carries the per-run prefix.
    expect(new Set(assigned.map((a) => a.testSampleId)).size).toBe(4);
    for (const a of assigned) {
      expect(a.testSampleId.startsWith(testSampleIdPrefix)).toBe(true);
      // Requirement: payload really is the current analyzed fixture content.
      expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(a.contentHashVersion).toBe("pcm-v1");
      expect(a.mapVersion).toBe("map-v2");
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThanOrEqual(1);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeLessThanOrEqual(1);
    }
    // The candidates are the ones from the real pipeline, one per fixture.
    expect(assigned.map((a) => a.sourceSampleId).sort()).toEqual([
      "samples/bass-sub",
      "samples/hat-airy",
      "samples/kick-909",
      "samples/lead-ohm",
    ]);

    const pendingCount = await page.evaluate(
      () => (window as any).__sm.publish.queue.pendingCount,
    );
    expect(pendingCount).toBe(4);

    // 3. Trigger Publish to real Worker
    const liveFlush = await page.evaluate(async () => {
      return await (window as any).__sm.publish.flush();
    });

    expect(liveFlush.submitted).toBe(4);

    // Evaluate the REAL per-item provider response before trusting any counter.
    // `lastOutcome` is the verbatim `GlobalPublishItemOutcome` the provider
    // returned for that sampleId during this flush.
    const itemStates = await page.evaluate(() =>
      (window as any).__sm.publish.queue
        .snapshot()
        .map((i: any) => ({
          sampleId: i.sampleId,
          status: i.status,
          attempts: i.attempts,
          lastError: i.lastError ?? null,
          lastOutcome: i.lastOutcome ?? null,
        })),
    );
    expect(itemStates).toHaveLength(4);

    const describeItems = (items: any[]) =>
      items
        .map(
          (i) =>
            `sampleId=${i.sampleId} status=${i.status} outcome=${JSON.stringify(i.lastOutcome)} lastError=${i.lastError ?? "-"}`,
        )
        .join("\n    ");

    // No item may be rejected — in particular there must be no conflict.
    const notSucceeded = itemStates.filter((i) => i.status !== "succeeded");
    expect(
      notSucceeded,
      `provider did not accept every item:\n    ${describeItems(notSucceeded)}`,
    ).toEqual([]);

    // "stored" and "already-known" are both acceptable; "rejected" is not.
    for (const item of itemStates) {
      expect(
        ["stored", "already-known"],
        `unexpected provider status for ${item.sampleId}: ${JSON.stringify(item.lastOutcome)}`,
      ).toContain(item.lastOutcome?.status);
      const reason = String(item.lastOutcome?.reason ?? "");
      expect(
        reason.toLowerCase(),
        `conflict/reason reported for ${item.sampleId}: ${reason}`,
      ).not.toContain("conflict");
      expect(item.lastError).toBeNull();
    }

    expect(liveFlush.succeeded).toBe(4);
    expect(liveFlush.rejected).toBe(0);
    expect(liveFlush.retryable).toBe(0);

    // 4. Local test publish state: the per-run test sampleIds match no local
    //    record, so a live success must NOT upgrade or corrupt any local marker,
    //    and the analyzed fixture records must be byte-for-byte unchanged.
    expect(liveFlush.markedPublished).toBe(0);
    const localAfter = await page.evaluate(() =>
      (window as any).__sm.index
        .getAll()
        .then((rs: any[]) =>
          rs.map((r: any) => ({
            sampleId: r.sampleId,
            contentHash: r.contentHash,
            contentHashVersion: r.contentHashVersion,
            delivery: r.globalPublish?.delivery ?? null,
          })),
        ),
    );
    expect(localAfter).toEqual(localBefore);
    // The local records still keep their real sampleIds (never re-keyed).
    for (const a of assigned) {
      expect(localAfter.map((r) => r.sampleId)).toContain(a.sourceSampleId);
      expect(localAfter.map((r) => r.sampleId)).not.toContain(a.testSampleId);
    }

    // 5. Query global points from real Worker
    await page.evaluate(async () => {
      await (window as any).__sm.app.refreshGlobalPoints();
    });

    // Wait for the global map state to be "ok"
    await page.waitForFunction(
      () => (window as any).__sm.app.globalMapState === "ok",
      null,
      { timeout: 15_000 },
    );

    // Check that points returned from real D1 include our 4 samples
    const globalPoints = await page.evaluate(
      () => (window as any).__sm.app.globalPoints,
    );
    expect(globalPoints.length).toBeGreaterThanOrEqual(4);

    // /map (read straight from the live provider) must return the four current
    // content identities, and app.refreshGlobalPoints() must hold the same set.
    const directMap = await page.evaluate(() =>
      (window as any).__sm.publish.provider.queryMapViewport({
        mapVersion: "map-v2",
        xMin: 0,
        xMax: 1,
        yMin: 0,
        yMax: 1,
        limit: 200,
      }),
    );
    const identityOf = (p: any) =>
      `${p.contentIdentity.contentHashVersion}:${p.contentIdentity.contentHash}`;
    const directKeys = new Set(directMap.points.map(identityOf));
    for (const a of assigned) {
      expect(
        directKeys.has(`${a.contentHashVersion}:${a.contentHash}`),
        `/map is missing the published content identity for ${a.testSampleId} (${a.contentHash})`,
      ).toBe(true);
    }
    const appKeys = new Set(globalPoints.map(identityOf));
    for (const key of directKeys) {
      expect(appKeys.has(key)).toBe(true);
    }

    const fixtureHashes = new Set(assigned.map((a) => a.contentHash));
    const matchedPoints = globalPoints.filter((pt: any) =>
      fixtureHashes.has(pt.contentIdentity.contentHash),
    );
    expect(matchedPoints).toHaveLength(4);

    // 6. Test Global ON + My OFF -> Local records that are also global
    //    visibleMapRecords only contains LOCAL records whose content identity
    //    is in the global set — global-only points (from prior D1 runs) don't
    //    appear here. So we expect exactly 4 (our fixture records).
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: true, mine: false }),
    );
    await page.waitForTimeout(200);

    const globalOnlyCount = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(globalOnlyCount).toBe(4);

    // 7. Test Global ON + My ON -> Union of Global and My Samples
    //    All 4 local records are both "mine" and "global" → union = 4.
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: true, mine: true }),
    );
    await page.waitForTimeout(200);

    const unionCount = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(unionCount).toBe(4);

    // 8. Verify the rendered DOM circles.
    //
    //    Dedup happens by CONTENT IDENTITY (mergeMapPoints), so the correct
    //    invariant is: exactly one circle per content identity, local points
    //    winning over global points. It is deliberately NOT "every data-sample-id
    //    is unique": the shared live D1 still holds the four historical content
    //    identities that the fixture sampleIds are bound to, and those rows
    //    legitimately render under the same sampleId as the current local
    //    record — two different contents, one sampleId. Asserting id-uniqueness
    //    would make the test depend on that stale production data.
    const domInfo = await page.evaluate(() => {
      const app = (window as any).__sm.app;
      const circles = Array.from(
        document.querySelectorAll("circle[data-sample-id]"),
      );
      const ids = circles
        .map((c) => c.getAttribute("data-sample-id")!)
        .sort();

      const keyOf = (id: { contentHash: string; contentHashVersion: string }) =>
        `${id.contentHashVersion}:${id.contentHash}`;
      // Expected multiset: one id per content identity in local ∪ global,
      // local winning.
      const localByKey = new Map<string, string>();
      for (const r of app.visibleMapRecords) {
        localByKey.set(
          keyOf({
            contentHash: r.contentHash,
            contentHashVersion: r.contentHashVersion,
          }),
          r.sampleId,
        );
      }
      const globalByKey = new Map<string, string>();
      for (const p of app.globalPoints) {
        globalByKey.set(keyOf(p.contentIdentity), p.representativeSampleId);
      }
      const keys = new Set([...localByKey.keys(), ...globalByKey.keys()]);
      const expected = [...keys]
        .map((k) => localByKey.get(k) ?? globalByKey.get(k)!)
        .sort();

      return {
        total: ids.length,
        ids,
        expected,
        contentIdentities: keys.size,
      };
    });
    expect(domInfo.ids).toEqual(domInfo.expected);
    expect(domInfo.total).toBe(domInfo.contentIdentities);
    // The four analyzed fixture samples are on the map under their real
    // sampleIds; the test-only re-keyed publish ids never reach the UI.
    for (const a of assigned) {
      expect(domInfo.ids).toContain(a.sourceSampleId);
      expect(domInfo.ids).not.toContain(a.testSampleId);
    }
    for (const id of domInfo.ids) {
      expect(id.startsWith("e2e/step82/")).toBe(false);
    }

    // 9. Test Global OFF + My ON -> Exactly 4 local samples
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: false, mine: true }),
    );
    await page.waitForTimeout(200);
    const mineOnlyCount = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(mineOnlyCount).toBe(4);

    // 10. Test Global OFF + My OFF -> 0 points
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: false, mine: false }),
    );
    await page.waitForTimeout(200);
    const noneCount = await page.evaluate(
      () => (window as any).__sm.app.visibleMapRecords.length,
    );
    expect(noneCount).toBe(0);

    // Restore default
    await page.evaluate(() =>
      (window as any).__sm.app.setVisibility({ global: true, mine: true }),
    );
  });
});

