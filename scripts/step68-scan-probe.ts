import { chromium } from "playwright";
import { writeFileSync } from "fs";

const OUT = "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step68";

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(3000);

  // Read scan panel / buttons presence
  const before = await page.evaluate(`({
    scanCount: document.querySelector(".scan-count")?.textContent ?? null,
    scanStart: !!document.querySelector(".scan-start"),
    analyzeBtns: [...document.querySelectorAll(".analysis-budget-btn")].map(b => b.textContent),
  })`);
  console.error("BEFORE:", JSON.stringify(before));

  // Click Start Scan if present
  const hasScan = await page.evaluate(`!!document.querySelector(".scan-start")`);
  if (hasScan) {
    await page.click(".scan-start");
    console.error("clicked scan-start; waiting for completion...");
    // Wait up to 120s for scan to finish (status != scanning)
    await page.waitForFunction(
      `document.querySelector(".scan-status")?.textContent.includes("Status: done") ||
       document.querySelector(".scan-error")?.textContent.includes("Error")`,
      { timeout: 120000 },
    );
    await page.waitForTimeout(1500);
  }

  const after = await page.evaluate(`(async () => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("samplemap", 3); r.onerror = () => rej(r.error);
      r.onsuccess = () => res(r.result);
    });
    const readStore = (name) => new Promise((res, rej) => {
      const tx = db.transaction(name, "readonly");
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
    });
    const jobs = await readStore("jobs");
    const samples = await readStore("samples");
    const jobStatuses = {};
    let jobSample = 0;
    const jobOwners = new Set();
    for (const j of jobs) {
      jobStatuses[j.status] = (jobStatuses[j.status]||0)+1;
      jobSample++;
    }
    const sampleStatuses = {};
    for (const s of samples) sampleStatuses[s.status] = (sampleStatuses[s.status]||0)+1;
    db.close();
    return {
      scanCount: text(".scan-count"),
      scanStatus: text(".scan-status"),
      scanEligibility: text(".scan-eligibility"),
      scanPages: text(".scan-pages"),
      scanError: text(".scan-error"),
      mapEmpty: !!document.querySelector(".map-empty"),
      mapPoints: document.querySelectorAll("[data-testid=sample-map] circle").length,
      resultCount: text(".results-panel section") ?? null,
      totalJobs: jobs.length,
      jobStatuses,
      totalSamples: samples.length,
      sampleStatuses,
    };
  })`);

  writeFileSync(`${OUT}/step68-scan-probe.json`, JSON.stringify({ before, after }, null, 2));
  console.log(JSON.stringify({ before, after }, null, 2));
  await page.close();
  await browser.close();
}

main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });