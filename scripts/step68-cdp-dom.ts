import { chromium } from "playwright";

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(5000);

  const dom = await page.evaluate(`(() => {
    const all = [...document.querySelectorAll("button, section, h2, h3, div")];
    const bodies = [];
    for (const el of document.body.querySelectorAll("div, section, button, h2, h3")) {
      const t = el.textContent?.trim();
      if (t && t.length < 120 && (t.startsWith("Samples") || t.startsWith("Results") || t.startsWith("Status") || t.startsWith("Library") || t.startsWith("Analysis") || t.startsWith("Scan") || t.startsWith("Connect") || t.startsWith("Map") || t.startsWith("Empty") || t.startsWith("No samples") || t.startsWith("Eligible") || t.startsWith("Budget") || t.startsWith("Global"))) {
        bodies.push({ tag: el.tagName, cls: el.className?.toString().slice(0,40), text: t });
      }
    }
    return {
      btns: [...document.querySelectorAll("button")].map(b => ({ text: b.textContent?.trim(), cls: b.className, testid: b.getAttribute("data-testid") })),
      sections: bodies.slice(0, 40),
      hasApp: !!document.getElementById("app"),
      appChildCount: document.getElementById("app")?.childElementCount ?? 0,
    };
  })`);
  console.log(JSON.stringify(dom, null, 2));
  await page.close();
  await browser.close();
}
main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
