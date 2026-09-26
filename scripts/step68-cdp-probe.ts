import { chromium } from "playwright";
import { writeFileSync } from "fs";

const OUT = "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step68";

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(4000);

  const dom = await page.evaluate(`(async () => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : null;
    };
    const result = {
      scanCount: text(".scan-count") || null,
      scanStatus: text(".scan-status") || null,
      scanEligibility: text(".scan-eligibility") || null,
      analysisStatus: text(".analysis-status") || null,
      analysisBudget: text(".analysis-budget") || null,
      resultsPanel: text(".results-panel, section") || null,
      resultsEmpty: !!document.querySelector(".results-empty"),
      mapEmpty: !!document.querySelector(".map-empty"),
      mapTestId: !!document.querySelector('[data-testid="sample-map"]'),
      mapPoints: document.querySelectorAll("[data-testid=sample-map] circle").length,
      bodySnippet: document.body ? document.body.innerText.slice(0, 600) : "",
    };
    return result;
  })`);

  // Now try to read IDB
  const idb = await page.evaluate(`(async () => {
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
    for (const j of jobs) jobStatuses[j.status] = (jobStatuses[j.status]||0)+1;
    const sampleStatuses = {};
    let audio=0, mapPos=0, sc=0, analyzed=0;
    for (const s of samples) {
      sampleStatuses[s.status] = (sampleStatuses[s.status]||0)+1;
      if (s.status==="analyzed") analyzed++;
      if (s.audioFeatures) audio++;
      if (s.mapPosition) mapPos++;
      if (s.analysisV2?.soundCharacter) sc++;
    }
    db.close();
    return {
      jobs: jobs.length, jobStatuses,
      samples: samples.length, sampleStatuses, analyzed, audio, mapPos, sc,
    };
  })`);

  const out = { at: new Date().toISOString(), url: page.url(), dom, idb };
  writeFileSync(`${OUT}/step68-live-probe.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));

  await page.screenshot({ path: `${OUT}/step68-live.png`, fullPage: false });
  await page.close();
  await browser.close();
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });