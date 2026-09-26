import { chromium } from "playwright";

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  console.error("opened page");
  try {
    const resp = await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 20000 });
    console.error("goto status:", resp?.status());
  } catch (e) {
    console.error("goto error:", (e as Error).message);
  }
  await page.waitForTimeout(4000);
  console.error("url now:", page.url());
  const shown = await page.evaluate("document.body ? document.body.innerText.slice(0, 400) : 'NO BODY'");
  console.error("---BODY---");
  console.error(shown);
  console.error("---END---");
  const dom = await page.evaluate(`({
    scanCount: document.querySelector(".scan-count")?.textContent?.trim() ?? null,
    mapEmpty: !!document.querySelector(".map-empty"),
    mapPoints: document.querySelectorAll("[data-testid=sample-map] circle").length,
  })`);
  console.error("dom:", JSON.stringify(dom));
  await page.close();
  await browser.close();
}

main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });