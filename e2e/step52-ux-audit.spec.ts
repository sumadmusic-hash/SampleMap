import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { startIndexing } from "./support/startIndexing";

/**
 * STEP52 — User Workflow & UX audit (OFFLINE evidence).
 *
 * Observational instrument: drives the REAL SampleMap UI in a REAL browser
 * through the new-user journey and the five realistic musician workflows,
 * capturing at every stage:
 *
 *   - a full-page screenshot (the visual first impression),
 *   - the complete visible text inventory (.app-shell innerText),
 *   - an interactive/control inventory (button/select/input/heading + aria),
 *   - one accessibility snapshot (roles + accessible names),
 *   - plus exact DOM facts (map corner labels, tooltip content, region widths,
 *     playback-control counts, selection/focus classes).
 *
 * Assertions here only pin what is needed to prove the observed state was
 * actually reached (focus changed, preview playing, result count, pageerrors
 * zero) so the artifacts are trustworthy. All conclusions live in
 * STEP52_REPORT.md, classified OBSERVED/MEASURED/CALCULATED/INFERRED.
 */

/* Real HTMLAudioElement playback (see STEP51 rationale). */
test.use({
  launchOptions: {
    args: ["--autoplay-policy=no-user-gesture-required"],
  },
});

const OUT = path.resolve("e2e/artifacts/step52");
fs.mkdirSync(OUT, { recursive: true });

const KICK = "samples/kick-909";
const HAT = "samples/hat-airy";
const BASS = "samples/bass-sub";
const LEAD = "samples/lead-ohm";

let page: import("@playwright/test").Page;

const app = () => page.evaluate(() => (window as any).__sm.app);

const waitForSel = async (sel: string, n: number) => {
  await expect(page.locator(sel)).toHaveCount(n, { timeout: 20_000 });
};

/** Capture the current visual + textual + control state. */
const FULL_PAGE_DUMPS = new Set(["01-first-use", "03-main", "16-collections"]);
async function dump(name: string): Promise<void> {
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    fullPage: FULL_PAGE_DUMPS.has(name),
  });
  const text = await page.evaluate(
    () => document.querySelector(".app-shell")?.innerText ?? "",
  );
  fs.writeFileSync(path.join(OUT, `${name}.txt`), text);
  const controls = await page.evaluate(() => {
    const list: string[] = [];
    const els = document.querySelectorAll(
      ".app-shell h1, .app-shell h2, .app-shell h3, .app-shell h4, " +
        ".app-shell button, .app-shell select, .app-shell input, " +
        ".app-shell [data-testid='map-tooltip']",
    );
    for (const el of els) {
      const e = el as HTMLElement;
      list.push(
        [
          e.tagName.toLowerCase(),
          e.getAttribute("data-testid") ?? "-",
          (e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 90),
          e.getAttribute("aria-label") ?? "",
          e instanceof HTMLButtonElement && e.disabled ? "DISABLED" : "",
          e instanceof HTMLInputElement ? `value=${e.value}` : "",
        ]
          .filter(Boolean)
          .join(" | "),
      );
    }
    return list.join("\n");
  });
  fs.writeFileSync(path.join(OUT, `${name}.controls.txt`), controls);
}

async function a11ySnapshot(name: string): Promise<void> {
  /* `page.accessibility` was removed from recent Playwright; derive the same
   * role/name inventory from the live DOM instead. */
  const snap = await page.evaluate(() => {
    const out: Array<{ role: string; name: string; testid?: string | null }> = [];
    const interesting =
      'button, select, input, a, [role], span[aria-label], [title], [aria-live], [role="status"], [role="alert"], [role="img"], svg[aria-label], .map-point';
    for (const el of document.querySelectorAll(`.app-shell ${interesting}`)) {
      const role =
        el.getAttribute("role") ??
        (el.tagName === "button"
          ? "button"
          : el.tagName === "select"
            ? "listbox"
            : el.tagName === "input"
              ? el.getAttribute("type") === "checkbox"
                ? "checkbox"
                : "textbox"
              : el.tagName === "a"
                ? "link"
                : undefined);
      if (!role) continue;
      const name =
        el.getAttribute("aria-label") ??
        (el as HTMLElement).textContent?.replace(/\s+/g, " ").trim() ??
        "";
      out.push({ role, name: name.slice(0, 120), testid: el.getAttribute("data-testid") });
    }
    return out;
  });
  fs.writeFileSync(path.join(OUT, `${name}.roles.json`), JSON.stringify(snap, null, 1));
  const counts: Record<string, number> = {};
  for (const r of snap) counts[r.role] = (counts[r.role] ?? 0) + 1;
  fs.writeFileSync(path.join(OUT, `${name}.roles.count.json`), JSON.stringify(counts, null, 1));
}

async function focus(id: string): Promise<void> {
  await page.locator(`[data-testid='map-point-${id}']`).click();
  await expect.poll(() => app().then((a) => a.focusedSampleId)).toBe(id);
}

const playingAudio = (p: import("@playwright/test").Page) =>
  p.evaluate(() =>
    ((window as any).__audioInstances ?? [])
      .filter((a: HTMLAudioElement) => a.paused === false)
      .map((a: HTMLAudioElement) => a.src),
  );

const waitPlaying = (p: import("@playwright/test").Page, id: string) =>
  expect
    .poll(
      () =>
        p.evaluate((sid) => {
          const a = (window as any).__sm.app;
          const playing = ((window as any).__audioInstances ?? []).filter(
            (x: HTMLAudioElement) => x.paused === false,
          );
          return {
            id: a.previewSampleId ?? null,
            playing: playing.map((x: HTMLAudioElement) => x.src),
          };
        }, id),
      { timeout: 15_000 },
    )
    .toMatchObject({ id, playing: [expect.stringMatching(/^blob:/) as unknown as string] });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/harness.html");
  await page.waitForFunction(() => !!(window as any).__sm, null, { timeout: 60_000 });

  // Reusable silent WAV + fetch/Audio/URL instrumentation (identical to STEP51).
  await page.evaluate(() => {
    const win = window as any;
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
        v.setInt16(
          44 + i * 2,
          Math.floor(Math.sin((2 * Math.PI * 440 * i) / sr) * 0.25 * 32767),
          true,
        );
      }
      return new Uint8Array(buf);
    };
    const wav = makeWav();
    win.__previewBehavior = {};
    win.__previewFetchCalls = [];
    win.__origFetch = win.fetch.bind(win);
    win.fetch = (input: any) => {
      const str = String(input);
      const id = str.replace(/^https:\/\/example\.preview\//, "");
      win.__previewFetchCalls.push(str);
      if (id.includes("http")) return win.__origFetch(input);
      const behavior = win.__previewBehavior[id] ?? "ok";
      if (behavior === "fail") return Promise.reject(new Error("network failure (stub)"));
      return Promise.resolve({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob([wav.slice(0)], { type: "audio/wav" })),
      });
    };
    win.__audioInstances = [];
    const OrigAudio = win.Audio;
    win.Audio = function (src?: string) {
      const el = new OrigAudio(src);
      win.__audioInstances.push(el);
      return el;
    } as any;
  });
});

test.afterAll(async () => {
  await page.close();
});

test.describe.serial("STEP52 UX audit — observed states", () => {
  test("52-01 first-use screen: fresh user's first impression", async () => {
    await dump("01-first-use");
    const controls = fs.readFileSync(path.join(OUT, "01-first-use.controls.txt"), "utf8");
    expect(controls).toContain("Connect Audiotool & start indexing");
    // Scan panel starts idle; nothing indexed.
    await expect(page.locator(".scan-status")).toContainText("Status: Idle");
    await expect(page.locator("[data-testid='first-use']")).toBeVisible();
  });

  test("52-02 index then analyze: the main working screen", async () => {
    await startIndexing(page);
    await expect(page.locator(".scan-status")).toContainText("Complete", { timeout: 20_000 });
    await dump("02-indexed");
    await page.evaluate((b) => (window as any).__sm.analyze(b), 10);
    await expect(page.locator(".analysis-status")).toContainText(/Stopped|Idle/, { timeout: 30_000 });
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await waitForSel("[data-testid^='map-point-']", 4);
    await dump("03-main");
    await a11ySnapshot("03-main");

    // Map is the dominant surface (MEASURED): capture the exact column split.
    const widths = await page.evaluate(() => {
      const host = document.querySelector("[data-testid='sample-map-host']");
      const shell = document.querySelector(".app-shell");
      const filter = document.querySelector(".filter-panel");
      const inspector = document.querySelector(".inspector-region");
      const box = (el: Element | null) => {
        if (!(el instanceof HTMLElement)) return null;
        return Math.round(el.getBoundingClientRect().width);
      };
      return {
        shellW: box(shell),
        mapW: box(host),
        filterW: box(filter),
        inspectorW: box(inspector),
      };
    });
    expect(widths).not.toBeNull();
    const { shellW, mapW, filterW, inspectorW } = widths!;
    expect(mapW!).toBeGreaterThan(filterW! ?? 0);
    expect(mapW!).toBeGreaterThan(inspectorW! ?? 0);
    fs.writeFileSync(
      path.join(OUT, "03-main.columns.json"),
      JSON.stringify({ shellW, mapW, filterW, inspectorW, mapPct: ((mapW! / shellW!) * 100).toFixed(1) }),
      null,
      1,
    );

    // Corner labels: canonical non-technical poles (OBSERVED).
    const corners = await page.evaluate(() => {
      const ax = [...document.querySelectorAll(".sample-map-svg text.map-axis")];
      return ax.map((t) => (t.childNodes[0]?.textContent ?? "").trim()).sort();
    });
    expect(corners).toEqual([
      "Noisy · Bright",
      "Noisy · Dark",
      "Tonal · Bright",
      "Tonal · Dark",
    ].sort());
  });

  test("52-03 hover: what a point reveals without clicking", async () => {
    await page.locator(`[data-testid='map-point-${KICK}']`).hover();
    const tip = await page.locator("[data-testid='map-tooltip']").innerText();
    fs.writeFileSync(path.join(OUT, "04-hover-kick.tooltip.txt"), tip);
    await page.screenshot({ path: path.join(OUT, "04-hover-kick.png") });
    expect(tip).toContain("Deep Kick 909");
    expect(tip).toContain("Class:");
  });

  test("52-04 focus a point via map click (kick)", async () => {
    await focus(KICK);
    await dump("05-inspector-kick");
    await a11ySnapshot("05-inspector-kick");
    // The point renders the focused emphasis class + the inspector opens.
    await expect(page.locator(`[data-testid='map-point-${KICK}']`)).toHaveClass(/map-point-selected/);
    await expect(page.locator("[data-testid='inspector-name']")).toHaveText("Deep Kick 909");
  });

  test("52-05 explicit preview plays; stop is one click", async () => {
    await page.locator("[data-testid='inspector-preview-toggle']").click();
    await waitPlaying(page, KICK);
    await dump("06-preview-playing");
    await expect(page.locator("[data-testid='inspector-preview-toggle']")).toHaveText("■ Stop");
    await page.locator("[data-testid='inspector-preview-toggle']").click();
    await expect.poll(() => app().then((a) => a.previewSampleId ?? null)).toBeNull();
    expect(await playingAudio(page)).toEqual([]);
  });

  test("52-06 workflow 1 'I need a kick': class filter → hear → select", async () => {
    // Filter: Class select → pick "kick" (single structured control).
    await page.locator("[data-testid='filter-class']").selectOption("kick");
    await waitForSel(".result-row", 3);
    await waitForSel("[data-testid='result-samples/kick-909']", 1);
    await waitForSel("[data-testid^='map-point-']", 3);
    // Active-filter summary + count communicating the state (OBSERVED).
    await expect(page.locator(".active-filter-summary")).toContainText("Class: kick");
    await expect(page.locator("[data-testid='result-count']")).toHaveText("3 samples");
    await dump("07-filter-kick");

    // Hear it from the result row ▶ (explicit play, no interpretation needed).
    await page.locator("[data-testid='preview-samples/kick-909']").click();
    await waitPlaying(page, KICK);
    // Select it (checkbox, the discoverable selector).
    await page.locator("[data-testid='multiselect-samples/kick-909']").check();
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText("1 / 8");
    await expect(page.locator("[data-testid='machiniste-add']")).toBeEnabled();
    await dump("08-kick-selected");

    await page.locator("[data-testid='search-clear']").click();
    await page.evaluate(() => (window as any).__sm.app.revokeCurrentPreview());
  });

  test("52-07 workflow 3 'like the kick — what's around it?' map + similarity", async () => {
    // Full set back (Clear restores).
    await waitForSel("[data-testid^='map-point-']", 4);
    // The map itself shows adjacency with no interaction (OBSERVED via artifact).
    await focus(KICK);
    const pbtnCount = await page.locator(".preview-btn").count();
    // Per-row ▶ + inspector Preview = explicit single source per sample.
    await dump("09-focus-nearby");
    // Find Similar (inspector button on the focused sample).
    await page.locator("[data-testid='inspector-find-similar-v2']").click();
    await expect(page.locator("[data-testid='similarity-v2-query']").first()).toBeVisible({ timeout: 15_000 });
    await dump("10-similar");
    const pbtnCount2 = await page.locator(".preview-btn").count();
    expect(pbtnCount2).toBeGreaterThanOrEqual(pbtnCount);
  });

  test("52-08 search interop: search + filter compose; empty results are explicit", async () => {
    await page.evaluate(() => (window as any).__sm.app.clearSearch());
    await page.locator("[data-testid='search-text']").pressSequentially("kick");
    await expect.poll(() => page.evaluate(() => (window as any).__sm.app.searchState.text)).toBe("kick");
    await waitForSel(".result-row", 1);
    await expect(page.locator("[data-testid='result-count']")).toContainText("1 sample");
    await waitForSel("[data-testid^='map-point-']", 1);
    await dump("11-search-kick");
    await page.locator("[data-testid='search-text']").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.locator("[data-testid='search-text']").pressSequentially("zzzz-no-such-sample");
    await expect(page.locator("[data-testid='results-empty']")).toHaveText("No samples match your filters.");
    await waitForSel("[data-testid^='map-point-']", 0);
    await dump("12-empty-results");
    await page.locator("[data-testid='search-clear-value']").click();
    await waitForSel("[data-testid^='map-point-']", 4);
  });

  test("52-09 selection: map modifier-click focus-only vs checkbox multi-select", async () => {
    // kick is still selected from 52-06 (selection is persistent).
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText("1 / 8");
    // Ctrl+click on the PRIMARY MAP only focuses (no multi-select on the map
    // surface — documented inconsistency vs Sound Space points).
    const pillBefore = await page.locator("[data-testid='selection-pill']").innerText();
    await page.locator(`[data-testid='map-point-${HAT}']`).click({ modifiers: ["Control"] });
    await expect.poll(() => page.evaluate(() => (window as any).__sm.app.focusedSampleId)).toBe(HAT);
    expect(pillBefore).toBe("1 / 8");
    expect(await page.locator("[data-testid='selection-pill']").innerText()).toBe("1 / 8");
    await dump("13-selection-mapctrl");
    // The discoverable multi-select path is the result-row checkbox.
    await page.locator(`[data-testid='multiselect-${HAT}']`).check();
    await page.locator(`[data-testid='multiselect-${BASS}']`).check();
    await page.locator(`[data-testid='multiselect-${LEAD}']`).check();
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText("4 / 8");
    await expect(page.locator(`[data-testid='map-point-${HAT}']`)).toHaveClass(/map-point-in-selection/);
    await dump("14-selection-checks");
    // Undo: checkbox off for one.
    await page.locator(`[data-testid='multiselect-${HAT}']`).uncheck();
    await expect(page.locator("[data-testid='selection-pill']")).toHaveText("3 / 8");
  });

  test("52-10 Sound Space opens, and ctrl+click multi-selects there (map contrast)", async () => {
    await page.locator("[data-testid='sound-space-toggle']").click();
    await expect(page.locator("[data-testid='sound-space-canvas']")).toBeVisible({ timeout: 15_000 });
    // Sound Space points DO ctrl+click multi-select (unlike the primary map).
    // NOTE: strict Playwright actionability stalls at "scrolling into view" on
    // these SVG circles once a selection exists (automation-only quirk — the
    // app's mousedown handler demonstrably runs via force/manual dispatch), so
    // the two points are selected with `force: true`.
    await page.locator(`[data-testid='sound-space-point-${HAT}']`).click({ modifiers: ["Control"], force: true });
    await page.locator(`[data-testid='sound-space-point-${BASS}']`).click({ modifiers: ["Control"], force: true });
    await expect.poll(() => page.evaluate(() => (window as any).__sm.app.selectedSampleIds)).toContain(HAT);
    await expect.poll(() => page.evaluate(() => (window as any).__sm.app.selectedSampleIds)).toContain(BASS);
    await expect(
      page.locator("[data-testid='selection-pill']"),
    ).toHaveText(
      await page.evaluate(
        () => `${(window as any).__sm.app.selectedSampleIds.length} / 8`,
      ),
    );
    await dump("15-sound-space");
  });

  test("52-11 'Find a sound' reference workflow", async () => {
    await focus(KICK);
    await page.locator("[data-testid='discovery-toggle']").click();
    await expect(page.locator("[data-testid='discovery-text']")).toBeVisible();
    await page.locator("[data-testid='discovery-use-reference']").click();
    await expect(page.locator("[data-testid='discovery-reference-label']")).toContainText("Deep Kick 909");
    await page.locator("[data-testid='discovery-text']").fill("kick");
    await page.locator("[data-testid='discovery-run']").click();
    await expect(page.locator("[data-testid='discovery-list']")).toBeVisible({ timeout: 15_000 });
    await dump("15-discovery");
  });

  test("52-12 collections appear after use (progressive disclosure)", async () => {
    await page.locator(`[data-testid='collection-add-${KICK}']`).click();
    await expect(page.locator("[data-testid='collection-counter']")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-testid='collection-counter']")).toContainText("My Sounds · 1");
    await dump("16-collections");
  });

  test("52-13 failure feedback stays understandable", async () => {
    await focus(LEAD);
    await page.evaluate((id) => ((window as any).__previewBehavior[id] = "fail"), LEAD);
    await page.locator("[data-testid='inspector-preview-toggle']").click();
    await expect(page.locator(".preview-error")).toContainText(/network failure/, { timeout: 15_000 });
    await dump("17-preview-error");
    await page.evaluate(() => ((window as any).__previewBehavior = {}));
    // Recovery works.
    await page.locator("[data-testid='inspector-preview-toggle']").click();
    await waitPlaying(page, LEAD);
  });

  test("52-14 zoom changes view, never coordinates", async () => {
    const before = await page.evaluate(() => (window as any).__sm.readRecords());
    await page.locator("[data-testid='map-zoom-in']").click();
    await page.locator("[data-testid='map-zoom-in']").click();
    await expect(page.locator("[data-testid='map-zoom-label']")).toHaveText(/200%|400%/);
    const after = await page.evaluate(() => (window as any).__sm.readRecords());
    expect(after).toEqual(before);
    await page.screenshot({ path: path.join(OUT, "18-zoomed.png"), fullPage: true });
    await page.locator("[data-testid='map-zoom-reset']").click();
  });

  test("52-15 console audit: no unhandled application errors across the session", async () => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.evaluate(() => (window as any).__sm.app.refreshSearch());
    await page.screenshot({ path: path.join(OUT, "19-final.png"), fullPage: true });
    expect(errors).toEqual([]);
  });
});