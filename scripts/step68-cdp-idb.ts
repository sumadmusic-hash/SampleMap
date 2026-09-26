import { chromium } from "playwright";

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(4000);

  const probe = await page.evaluate(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("samplemap", 3); r.onerror = () => rej(r.error);
      r.onsuccess = () => res(r.result);
    });
    const readStore = (name) => new Promise((res, rej) => {
      const tx = db.transaction(name, "readonly");
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
    });
    const count = (name) => new Promise((res, rej) => {
      const tx = db.transaction(name, "readonly");
      const q = tx.objectStore(name).count();
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
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
    const c = await count("jobs");
    db.close();
    return {
      jobsCount: c, jobs: jobs.length, jobStatuses,
      samples: samples.length, sampleStatuses, analyzed, audio, mapPos, sc,
    };
  })`).catch((e) => ({ error: e.message }));

  const dom = await page.evaluate(`({
    mapPoints: document.querySelectorAll("[data-testid=sample-map] circle").length,
    mapEmpty: !!document.querySelector(".map-empty"),
    scanCount: document.querySelector(".scan-count")?.textContent ?? null,
    resultsEmpty: !!document.querySelector(".results-empty"),
    resultsList: document.querySelectorAll(".result-row").length,
  })`).catch((e) => ({ error: e.message }));

  console.log(JSON.stringify({ idb: probe, dom }, null, 2));
  await page.close();
  await browser.close();
}
main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
