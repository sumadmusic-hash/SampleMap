import { test, expect, type Page } from "@playwright/test";
import { startIndexing } from "./support/startIndexing";

/**
 * STEP16R E-P6 — Global publish-status surface (read-only).
 *
 * L1  Additive "Global Publish" inspector block exists and shows "None" +
 *     offline delivery for a never-accepted sample; the LOCAL map stays
 *     fully functional (additive only).
 * L2  Offline-first: accepted+queued (pending) marker → "Pending"; flushing
 *     against the offline provider (temporary-unavailable) → "Temporary
 *     unavailable", never an error.
 * L3  Live delivery: stored → "Stored" (+ marker "published"),
 *     already-known → "Known", conflict stays terminal ("Conflict"), and a
 *     validation rejection → "Rejected". Terminal states are never shown as
 *     published.
 *
 * The harness drives the REAL publish queue + the REAL 16H orchestration
 * (acceptUsageAndEnqueue / flushPendingPublications) with a scripted provider;
 * the UI only reads queue snapshots (no enqueue/flush/retry from the UI).
 */

let page: Page;

const loadSm = (p: Page) =>
  p.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

const KICK = "samples/kick-909";
const HAT = "samples/hat-airy";
const BASS = "samples/bass-sub";
const LEAD = "samples/lead-ohm";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("STEP16R E-P6 publish-status surface (shared page)", () => {
  test("EP6-01 Additive block: Pending + offline delivery, local map untouched", async () => {
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
    // Wait for the async population to settle
    await page.waitForFunction(() => (window as any).__sm.publish.queue.pendingCount >= 1);
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);

    // Auto-populated analyzed sample → "Pending" + offline delivery label.
    await page.evaluate((s) => (window as any).__sm.selectSample(s), KICK);
    await expect(page.locator(".inspector-publish")).toContainText("Global Publish");
    await expect(page.locator("[data-testid='inspector-publish-status']")).toHaveText(
      "Status: Pending",
    );
    await expect(
      page.locator("[data-testid='inspector-publish-delivery']"),
    ).toHaveText("Delivery: Offline / waiting for live provider");

    // Additive only: the local inspector still carries classification, and the
    // map still renders every local sample.
    await expect(page.locator(".inspector-class-primary")).toHaveText("kick");
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);

    await page.screenshot({
      path: "e2e/artifacts/ep6-publish-none.png",
      fullPage: true,
    });
  });

  test("EP6-02 Offline pending: accepted + queued shows Pending, not an error", async () => {
    await loadSm(page);
    // 16H acceptance → marker "pending" + queue item pending (no outcome yet).
    const accepted = await page.evaluate((s) => (window as any).__sm.publish.accept(s), KICK);
    expect(accepted).toEqual(
      expect.objectContaining({ accepted: true, sampleId: KICK, delivery: "pending" }),
    );
    const rec = await page.evaluate((s) => (window as any).__sm.index.get(s), KICK);
    expect(rec?.globalPublish?.delivery).toBe("pending");
    await page.evaluate(() => (window as any).__sm.publish.refresh());

    await page.evaluate((s) => (window as any).__sm.selectSample(s), KICK);
    await expect(page.locator("[data-testid='inspector-publish-status']")).toHaveText(
      "Status: Pending",
    );
    await expect(
      page.locator("[data-testid='inspector-publish-delivery']"),
    ).toHaveText("Delivery: Offline / waiting for live provider");
  });

  test("EP6-03 Offline flush: provider unavailable → Temporary unavailable, not an error", async () => {
    // Flush against the offline provider (every publish temporary-unavailable).
    const res = await page.evaluate(() => (window as any).__sm.publish.flush());
    expect(res.retryable).toBeGreaterThanOrEqual(1);
    expect(res.succeeded).toBe(0);

    await page.evaluate((s) => (window as any).__sm.selectSample(s), KICK);
    await expect(page.locator("[data-testid='inspector-publish-status']")).toHaveText(
      "Status: Temporary unavailable",
    );
    await expect(
      page.locator("[data-testid='inspector-publish-delivery']"),
    ).toHaveText("Delivery: Offline / waiting for live provider");

    await page.screenshot({
      path: "e2e/artifacts/ep6-publish-temp-unavailable.png",
      fullPage: true,
    });
  });

  test("EP6-04 Live delivery: stored → Stored, marker published", async () => {
    // Re-mount with a live delivery label (records persist; no re-analysis).
    await page.evaluate(() => (window as any).__sm.publish.remount("live"));
    await expect(
      page.locator("[data-testid^='map-point-']"),
    ).toHaveCount(4);

    await page.evaluate(() => (window as any).__sm.publish.clear());
    await page.evaluate((s) => (window as any).__sm.publish.accept(s), HAT);
    const res = await page.evaluate(() =>
      (window as any).__sm.publish.flush({
        "samples/hat-airy": { status: "stored" },
      }),
    );
    expect(res.succeeded).toBe(1);
    expect(res.markedPublished).toBe(1);

    await page.evaluate((s) => (window as any).__sm.selectSample(s), HAT);
    await expect(page.locator(".inspector-name")).toHaveText("Airy Hat");
    await expect(page.locator("[data-testid='inspector-publish-status']")).toHaveText(
      "Status: Stored",
    );
    await expect(
      page.locator("[data-testid='inspector-publish-delivery']"),
    ).toHaveText("Delivery: Live worker");

    const deliveryRec = await page.evaluate((s) => (window as any).__sm.index.get(s), HAT);
    expect(deliveryRec?.globalPublish?.delivery).toBe("published");
  });

  test("EP6-05 already-known → Known", async () => {
    await page.evaluate(() => (window as any).__sm.publish.clear());
    await page.evaluate((s) => (window as any).__sm.publish.accept(s), BASS);
    const res = await page.evaluate(() =>
      (window as any).__sm.publish.flush({
        "samples/bass-sub": { status: "already-known" },
      }),
    );
    expect(res.succeeded).toBe(1);

    await page.evaluate((s) => (window as any).__sm.selectSample(s), BASS);
    await expect(page.locator("[data-testid='inspector-publish-status']")).toHaveText(
      "Status: Known",
    );
  });

  test("EP6-06 conflict stays terminal, never shown as published", async () => {
    await page.evaluate(() => (window as any).__sm.publish.clear());
    await page.evaluate((s) => (window as any).__sm.publish.accept(s), LEAD);
    const res = await page.evaluate(() =>
      (window as any).__sm.publish.flush({
        "samples/lead-ohm": { status: "rejected", reason: "conflict: already exists" },
      }),
    );
    expect(res.rejected).toBe(1);

    await page.evaluate((s) => (window as any).__sm.selectSample(s), LEAD);
    await expect(page.locator("[data-testid='inspector-publish-status']")).toHaveText(
      "Status: Conflict",
    );

    // Terminal and stable: another render must NOT flip it to published.
    const recLead = await page.evaluate((s) => (window as any).__sm.index.get(s), LEAD);
    expect(recLead?.globalPublish?.delivery).toBe("pending");
    await page.evaluate(() => (window as any).__sm.publish.refresh());
    await expect(page.locator("[data-testid='inspector-publish-status']")).toHaveText(
      "Status: Conflict",
    );

    await page.screenshot({
      path: "e2e/artifacts/ep6-publish-conflict.png",
      fullPage: true,
    });
  });

  test("EP6-07 validation rejection → Rejected", async () => {
    await page.evaluate(() => (window as any).__sm.publish.clear());
    await page.evaluate((s) => (window as any).__sm.publish.accept(s), KICK);
    const res = await page.evaluate(() =>
      (window as any).__sm.publish.flush({
        "samples/kick-909": { status: "rejected", reason: "validation-rejected" },
      }),
    );
    expect(res.rejected).toBe(1);

    await page.evaluate((s) => (window as any).__sm.selectSample(s), KICK);
    await expect(page.locator("[data-testid='inspector-publish-status']")).toHaveText(
      "Status: Rejected",
    );

    const recKick = await page.evaluate((s) => (window as any).__sm.index.get(s), KICK);
    expect(recKick?.globalPublish?.delivery).toBe("pending");
  });

  test("EP6-08 Additive integrity: local map + classification still intact", async () => {
    // The whole publish-status churn (offline + live + terminal states) must
    // leave the LOCAL SampleMap surface untouched.
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);
    await page.evaluate((s) => (window as any).__sm.selectSample(s), BASS);
    await expect(page.locator(".inspector-class-primary")).toHaveText("bass");
    await page.evaluate((s) => (window as any).__sm.selectSample(s), HAT);
    await expect(page.locator(".inspector-musical-bpm")).toHaveText("BPM: —");
  });

  test("EP6-09 BUG #1: conflict → re-accept → stored shows Stored, never the stale Conflict", async () => {
    // KICK currently holds a TERMINAL failed item (validation-rejected from
    // EP6-07). Re-accepting must create a NEW queue item (enqueue after failed
    // is allowed) — the E-P6 projection reads the NEWEST item for the sample.
    await page.evaluate(() => (window as any).__sm.publish.clear());
    await page.evaluate(() => (window as any).__sm.publish.provider.setAllOffline());
    await page.evaluate((s) => (window as any).__sm.publish.accept(s), KICK);

    // Phase 1: flush into a conflict → terminal Conflict shown.
    let res = await page.evaluate(() =>
      (window as any).__sm.publish.flush({
        "samples/kick-909": { status: "rejected", reason: "conflict: already exists" },
      }),
    );
    expect(res.rejected).toBe(1);
    await page.evaluate((s) => (window as any).__sm.selectSample(s), KICK);
    await expect(page.locator("[data-testid='inspector-publish-status']")).toHaveText(
      "Status: Conflict",
    );

    // Phase 2: re-accept + a later stored flush. THREE queue items now exist
    // for KICK (old validation-failed, conflict-failed, newest succeeded) — the
    // NEWEST must win → Stored, NOT the stale Conflict.
    await page.evaluate((s) => (window as any).__sm.publish.accept(s), KICK);
    res = await page.evaluate(() =>
      (window as any).__sm.publish.flush({
        "samples/kick-909": { status: "stored" },
      }),
    );
    expect(res.succeeded).toBe(1);
    expect(res.markedPublished).toBe(1);

    await page.evaluate((s) => (window as any).__sm.selectSample(s), KICK);
    await expect(page.locator("[data-testid='inspector-publish-status']")).toHaveText(
      "Status: Stored",
    );

    // The queue really holds multiple items for KICK (proves the scenario).
    const snap = await page.evaluate(() =>
      (window as any).__sm.publish.queue.snapshot(),
    );
    const kickItems = snap.filter((i: { sampleId: string }) => i.sampleId === KICK);
    expect(kickItems.length).toBeGreaterThanOrEqual(2);
    expect(kickItems[kickItems.length - 1].status).toBe("succeeded");

    await page.screenshot({
      path: "e2e/artifacts/ep6-bug1-reaccept-stored.png",
      fullPage: true,
    });
  });

  test("EP6-10 BUG #3: batch-level worker failure body keeps its kind, never [object Object]", async () => {
    // Force the provider to THROW a plain worker failure object (the browser
    // adapter surfaces the HTTP error body as a GlobalIndexError plain object).
    // The queue must classify it like a per-item rejection and KEEP a semantic
    // reason so the UI never renders "[object Object]".
    await page.evaluate(() => (window as any).__sm.publish.clear());
    await page.evaluate((s) => (window as any).__sm.publish.accept(s), HAT);
    await page.evaluate(() => {
      const q = (window as any).__sm.publish;
      q.provider.publishAnalysisResults = () => {
        throw { kind: "rate-limited" };
      };
    });

    const res = await page.evaluate(() => (window as any).__sm.publish.flush());
    expect(res.retryable).toBe(1);
    expect(res.rejected).toBe(0);

    // The retained reason is the semantic kind, not a stringified object.
    const item = await page.evaluate(() =>
      (window as any).__sm.publish.queue.snapshot().find(
        (i: { sampleId: string }) => i.sampleId === "samples/hat-airy",
      ),
    );
    expect(item.lastError).not.toContain("[object Object]");
    expect(item.lastError).toBe("rate-limited");
    expect(item.status).toBe("retryable");

    await page.evaluate((s) => (window as any).__sm.selectSample(s), HAT);
    await expect(page.locator("[data-testid='inspector-publish-status']")).toHaveText(
      "Status: Temporary unavailable",
    );

    // Restore the scripted provider for any follow-on specs.
    await page.evaluate(() => (window as any).__sm.publish.resetOutcomes());
    await page.evaluate(() => (window as any).__sm.publish.provider.setAllOffline());
  });
});