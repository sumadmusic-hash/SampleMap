#!/usr/bin/env -S npx tsx
/**
 * STEP64 — post-cleanup real-browser DOM probe (AUDIT EVIDENCE).
 * Opens the REAL app in the REAL profile; reports whether the SampleMap app
 * mounts: #app content, the map canvas testid, and mount timing. No markers
 * are present in the app source anymore, so this is a pure DOM check.
 */
import { chromium } from "@playwright/test";

const APP_URL = "http://127.0.0.1:5173/";
const PROFILE = "/tmp/sm-real-profile";

async function probe(label: string) {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 1400 },
    args: ["--disable-background-timer-throttling", "--no-first-run"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const t0 = Date.now();
  page.on("console", (m) => {
    const t = m.text();
    if (/authenticated|mounted|mount|SampleMap/.test(t)) console.log(`  [page] ${t}`);
  });
  await page.goto(APP_URL, { waitUntil: "commit" });

  let appLen = -1;
  let canvas = 0;
  let login = false;
  let shellAt: number | null = null;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (shellAt === null) {
      appLen = await page
        .locator("#app")
        .innerHTML()
        .then((h) => h.length)
        .catch(() => -1);
      if (appLen > 0) shellAt = Date.now() - t0;
    }
    canvas = await page.locator('[data-testid="sound-space-canvas"]').count().catch(() => 0);
    login = await page.locator("#login").isVisible().catch(() => false);
    if (canvas > 0 || login) break;
    await page.waitForTimeout(150);
  }
  const at = Date.now() - t0;
  const ssEmpty = appLen > 0
    ? await page
        .locator('[data-testid="sound-space-status"]')
        .textContent()
        .catch(() => null)
    : null;
  console.log(
    `${label}: shellAt=${shellAt}ms t=${at}ms  loginWall=${login}  #app.length=${appLen}  canvas=${canvas}  soundSpaceStatus=${JSON.stringify(ssEmpty)}`,
  );
  void page;
  await ctx.close();
  return { shellAt, at, appLen, canvas, login };
}

async function main() {
  const A = await probe("RUN A (cold)");
  const B = await probe("RUN B (reload)");
  console.log(JSON.stringify({ A, B }));
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});