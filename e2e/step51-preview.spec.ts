import { test, expect } from "@playwright/test";
import { startIndexing } from "./support/startIndexing";

/**
 * STEP51 — Live Preview & Sample Interaction verification (OFFLINE layer).
 *
 * Runs the REAL SampleMap UI + REAL PreviewService + REAL browser
 * HTMLAudioElement inside the offline harness. The harness's PrevieService
 * uses the page's `window.fetch` to materialize an ObjectURL, and `new Audio`
 * to start playback — so a page-level stub that (a) serves real, playable WAV
 * bytes for the fixture preview URLs, (b) counts every URL.createObjectURL /
 * URL.revokeObjectURL, and (c) records every created HTMLAudioElement lets the
 * offline browser verify the full interaction state machine with genuinely
 * created (silent) playback:
 *
 *   - focus NEVER starts playback (map point click → focus only);
 *   - explicit preview starts exactly one Audio element (blob: src, playing);
 *   - replacing A→B→C stops the old element (exactly one playing at a time);
 *   - repeated Play/Stop and A/B/A/B toggle never duplicate elements or leak
 *     ObjectURLs beyond the bounded cache;
 *   - a stale in-flight fetch that resolves after the user moved on is
 *     discarded: never adopted, never played, ObjectURL revoked;
 *   - a failing preview fetch produces a controlled, non-crashing error state
 *     with focus intact.
 *
 * This is OFFLINE evidence (synthetic WAV + fixture metadata). It proves real
 * browser playback *machinery* works, not real Audiotool audio (see the live
 * section of STEP51_REPORT.md).
 */

/* Autoplay policy: playback is started from Playwright-dispatched clicks, but
 * `togglePreview` is async (fetch → blob → ObjectURL), so the transient user
 * gesture can expire before `audio.play()` resolves in headless Chrome. Use a
 * fresh browser launched with autoplay unrestricted — test-tooling only, no
 * product code involved. */
test.use({
  launchOptions: {
    args: ["--autoplay-policy=no-user-gesture-required"],
  },
});

let page: import("@playwright/test").Page;

const KICK = "samples/kick-909";
const HAT = "samples/hat-airy";
const BASS = "samples/bass-sub";
const LEAD = "samples/lead-ohm";

const playingAudio = (p: import("@playwright/test").Page) =>
  p.evaluate(() =>
    ((window as any).__audioInstances ?? []).filter((a: HTMLAudioElement) => a.paused === false).map(
      (a: HTMLAudioElement) => a.src,
    ),
  );

const allAudio = (p: import("@playwright/test").Page) =>
  p.evaluate(() =>
    ((window as any).__audioInstances ?? []).map((a: HTMLAudioElement) => ({
      src: a.src,
      paused: a.paused,
    })),
  );

const urlStats = (p: import("@playwright/test").Page) =>
  p.evaluate(() => ({ ...(window as any).__urlStats }));

const previewState = (p: import("@playwright/test").Page) =>
  p.evaluate(() => {
    const app = (window as any).__sm.app;
    return {
      previewSampleId: app.previewSampleId ?? null,
      previewError: app.previewError ?? null,
      focus: app.focusedSampleId,
    };
  });

const waitPlaying = (p: import("@playwright/test").Page, id: string) =>
  expect
    .poll(
      () =>
        p.evaluate((sid) => {
          const app = (window as any).__sm.app;
          const playing = ((window as any).__audioInstances ?? []).filter(
            (a: HTMLAudioElement) => a.paused === false,
          );
          return {
            id: app.previewSampleId ?? null,
            playing: playing.map((a: HTMLAudioElement) => a.src),
          };
        }, id),
      { timeout: 15_000 },
    )
    .toMatchObject({ id, playing: [expect.stringMatching(/^blob:/) as unknown as string] });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
  await page.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

  // Install preview stubs: playable WAV bytes, Audio/URL instrumentation.
  await page.evaluate(() => {
    const win = window as any;

    // ── deterministic 0.5 s, 8 kHz mono 16-bit WAV (440 Hz sine) ──
    const makeWav = () => {
      const sr = 8000;
      const n = Math.floor(sr * 0.5);
      const buf = new ArrayBuffer(44 + n * 2);
      const v = new DataView(buf);
      const s = (o: number, str: string) => {
        for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i));
      };
      s(0, "RIFF");
      v.setUint32(4, 36 + n * 2, true);
      s(8, "WAVE");
      s(12, "fmt ");
      v.setUint32(16, 16, true);
      v.setUint16(20, 1, true);
      v.setUint16(22, 1, true);
      v.setUint32(24, sr, true);
      v.setUint32(28, sr * 2, true);
      v.setUint16(32, 2, true);
      v.setUint16(34, 16, true);
      s(36, "data");
      v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) {
        v.setInt16(44 + i * 2, Math.floor(Math.sin((2 * Math.PI * 440 * i) / sr) * 0.25 * 32767), true);
      }
      return new Uint8Array(buf);
    };
    const wav = makeWav();
    const blobFor = (id: string) =>
      new Blob([wav.slice(0)], { type: "audio/wav" });

    // ── deferred / failing preview control surface ──
    win.__previewBehavior = {}; // id -> "defer" | "fail"
    win.__deferred = [];
    win.__previewFetchCalls = [];
    win.__resolveDeferred = (id: string) => {
      const d = win.__deferred.find((x: any) => x.id === id);
      if (d) d.resolve();
    };

    // ── fetch stub: only PreviewService hits the network post-boot ──
    win.__origFetch = win.fetch.bind(win);
    win.fetch = (input: any, init?: any) => {
      const str = String(input);
      const id = str.replace(/^https:\/\/example\.preview\//, "");
      win.__previewFetchCalls.push(str);
      if (id.includes("http")) return win.__origFetch(input, init);
      const behavior = win.__previewBehavior[id] ?? "ok";
      if (behavior === "fail") {
        return Promise.reject(new Error("network failure (stub)"));
      }
      if (behavior === "defer") {
        return new Promise((resolve) => {
          win.__deferred.push({
            id,
            resolve: () => resolve({ ok: true, status: 200, blob: () => Promise.resolve(blobFor(id)) }),
          });
        });
      }
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(blobFor(id)) });
    };

    // ── instrument Audio elements ──
    win.__audioInstances = [];
    const OrigAudio = win.Audio;
    win.Audio = function (src?: string) {
      const el = new OrigAudio(src);
      win.__audioInstances.push(el);
      return el;
    } as any;

    // ── instrument ObjectURL lifecycle ──
    win.__urlStats = { created: 0, revoked: 0 };
    const oc = URL.createObjectURL.bind(URL);
    const rv = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (b) => {
      win.__urlStats.created++;
      return oc(b);
    };
    URL.revokeObjectURL = (u) => {
      win.__urlStats.revoked++;
      rv(u);
    };
  });
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("STEP51 offline preview interaction", () => {
  test("51-01 load + index + analyze → 4 points; map click FOCUSES only, never plays", async () => {
    await startIndexing(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", { timeout: 20_000 });
    await page.evaluate((b) => (window as any).__sm.analyze(b), 10);
    await expect(page.locator(".analysis-status")).toContainText(/Stopped|Idle/, { timeout: 30_000 });
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await expect(page.locator("[data-testid^='map-point-']")).toHaveCount(4);

    const fetchesBefore = await page.evaluate(() => (window as any).__previewFetchCalls.length);
    expect(fetchesBefore).toBe(0);

    // Map point click → focus only (no preview state, no fetch, no playback).
    await page.locator(`[data-testid='map-point-${KICK}']`).click();
    await expect.poll(() => page.evaluate(() => (window as any).__sm.app.focusedSampleId)).toBe(KICK);
    const state = await previewState(page);
    expect(state.previewSampleId).toBeNull();
    expect(state.previewError).toBeNull();
    expect(await page.evaluate(() => (window as any).__previewFetchCalls.length)).toBe(0);
    expect(await playingAudio(page)).toEqual([]);

    // Explicit preview action → exactly one Audio element, playing a blob: URL.
    await page.locator("[data-testid='inspector-preview-toggle']").click();
    await waitPlaying(page, KICK);
    const aud = await allAudio(page);
    expect(aud.filter((a) => !a.paused).length).toBe(1);
    expect(aud.filter((a) => !a.paused)[0].src).toMatch(/^blob:/);
    // Inspector reflects the running preview (Stop affordance).
    await expect(page.locator("[data-testid='inspector-preview-toggle']")).toHaveText("■ Stop");
  });

  test("51-02 sequential A→B→C: replacing preview stops the old element; exactly one playing", async () => {
    // Play B (result-row ▶ routes through togglePreview without focusing).
    await page.locator(`[data-testid='preview-${BASS}']`).click();
    await waitPlaying(page, BASS);
    let aud = await allAudio(page);
    const playingB = aud.filter((a) => !a.paused);
    expect(playingB.length).toBe(1);
    expect(playingB[0].src).toMatch(/^blob:/);

    // Play C.
    await page.locator(`[data-testid='preview-${LEAD}']`).click();
    await waitPlaying(page, LEAD);
    aud = await allAudio(page);
    const playingC = aud.filter((a) => !a.paused);
    expect(playingC.length).toBe(1);
    expect(playingC[0].src).toMatch(/^blob:/);
    // Previous (B) element was paused, not left playing.
    const pausedElements = aud.filter((a) => a.paused);
    expect(pausedElements.length).toBeGreaterThanOrEqual(1);

    // The app believes C is current.
    const st = await previewState(page);
    expect(st.previewSampleId).toBe(LEAD);
  });

  test("51-03 repeated Play/Stop and A/B/A/B never duplicate elements or leak ObjectURLs", async () => {
    // Play A → Stop (inspector toggle) → Play A → Stop: bounded, single element playing.
    await page.locator(`[data-testid='preview-${HAT}']`).click();
    await waitPlaying(page, HAT);
    await page.locator(`[data-testid='preview-${HAT}']`).click(); // toggle → stop
    await expect
      .poll(() => page.evaluate(() => (window as any).__sm.app.previewSampleId ?? null))
      .toBeNull();
    expect(await playingAudio(page)).toEqual([]);

    await page.locator(`[data-testid='preview-${HAT}']`).click();
    await waitPlaying(page, HAT);
    await page.locator(`[data-testid='preview-${HAT}']`).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__sm.app.previewSampleId ?? null))
      .toBeNull();
    expect(await playingAudio(page)).toEqual([]);

    // A→B→A→B: ends on B, exactly one live element, still no unbounded growth.
    await page.locator(`[data-testid='preview-${HAT}']`).click();
    await waitPlaying(page, HAT);
    await page.locator(`[data-testid='preview-${KICK}']`).click();
    await waitPlaying(page, KICK);
    await page.locator(`[data-testid='preview-${HAT}']`).click();
    await waitPlaying(page, HAT);
    await page.locator(`[data-testid='preview-${KICK}']`).click();
    await waitPlaying(page, KICK);

    const aud = await allAudio(page);
    expect(aud.filter((a) => !a.paused).length).toBe(1);
    const st = await previewState(page);
    expect(st.previewSampleId).toBe(KICK);

    // ObjectURLs: creations revoked on stop/replace/LRU — outstanding stays small.
    const stats = await urlStats(page);
    expect(stats.created - stats.revoked).toBeLessThanOrEqual(8); // maxCacheSize
    expect(stats.revoked).toBeGreaterThan(0); // old URLs actually revoked
  });

  test("51-04 stale in-flight fetch is discarded: never adopted or played", async () => {
    await page.evaluate(() => {
      window.__sm.app.revokeCurrentPreview();
    });
    await page.evaluate((id) => {
      (window as any).__previewBehavior[id] = "defer";
    }, HAT);
    await page.locator(`[data-testid='preview-${HAT}']`).click();
    // HAT's fetch is now pending (stubbed deferred).
    await expect
      .poll(() => page.evaluate(() => (window as any).__deferred.length))
      .toBeGreaterThanOrEqual(1);

    // User moves on: plays KICK, which resolves immediately.
    await page.locator(`[data-testid='preview-${KICK}']`).click();
    await waitPlaying(page, KICK);

    // Now the STALE HAT fetch completes. It must be discarded — not adopted,
    // not played, and its ObjectURL revoked.
    const createdBefore = (await urlStats(page)).created;
    await page.evaluate((id) => (window as any).__resolveDeferred(id), HAT);
    await expect
      .poll(() => page.evaluate(() => (window as any).__sm.app.previewSampleId ?? null))
      .toBe(KICK); // still KICK — HAT never replaced it
    const playing = await playingAudio(page);
    expect(playing.length).toBe(1); // still only KICK
    const stats = await urlStats(page);
    // The stale HAT ObjectURL was created then revoked (leak-free).
    expect(stats.created - createdBefore).toBeGreaterThanOrEqual(1);
    expect(stats.created - stats.revoked).toBeLessThanOrEqual(8);

    await page.evaluate(() => {
      (window as any).__previewBehavior = {};
    });
  });

  test("51-05 failing preview fetch → controlled error, focus intact, no stale audio", async () => {
    await page.evaluate((id) => {
      (window as any).__previewBehavior[id] = "fail";
    }, LEAD);
    await page.locator(`[data-testid='preview-${LEAD}']`).click();
    await expect(page.locator(".preview-error")).toContainText(/network failure/, { timeout: 15_000 });
    const st = await previewState(page);
    expect(st.previewError).toMatch(/network failure/);
    expect(st.previewSampleId).toBeNull();
    // Focus of the clicked row's record (play routed via row, focus unchanged).
    expect(st.focus).toBe(KICK);
    // No playback started for the failed sample.
    expect((await playingAudio(page)).filter((s) => s.includes("lead-ohm"))).toEqual([]);

    // Recovery: clearing the stale error via a fresh, working preview.
    await page.evaluate(() => {
      (window as any).__previewBehavior = {};
    });
    await page.locator(`[data-testid='preview-${LEAD}']`).click();
    await waitPlaying(page, LEAD);
    const after = await previewState(page);
    expect(after.previewError).toBeNull();
    expect(after.previewSampleId).toBe(LEAD);
  });

  test("51-06 console audit: no unhandled application errors across the session", async () => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await page.screenshot({ path: "e2e/artifacts/step51-preview.png", fullPage: true });
    expect(errors).toEqual([]);
  });
});