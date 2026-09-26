import { chromium } from "playwright";
import { writeFileSync } from "fs";

const OUT = "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step68";

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(4000);

  const start = Date.now();
  // Click Start Scan
  const clicked = await page.evaluate(
    "(function(){ var b = document.querySelector('.scan-start'); if (!b) return 'no-scan-btn'; b.click(); return 'clicked'; })()",
  );
  console.error("scan-start click:", clicked);

  let got = "";
  try {
    await page.waitForFunction(
      "(function(){ var s = document.querySelector('.scan-status'); return s && /Status: (done|error)/.test(s.textContent); })()",
      { timeout: 120000 },
    );
    got = "";
  } catch {
    got = "";
  }
  const elapsed = Math.round((Date.now() - start) / 1000);
  console.error(`scan finished in ${elapsed}s`);

  const state = await page.evaluate(
    "(function(){ var q=function(s){return document.querySelector(s)}; return { scanCount: q('.scan-count')? q('.scan-count').textContent:null, scanStatus: q('.scan-status')? q('.scan-status').textContent:null, scanEligibility: q('.scan-eligibility')? q('.scan-eligibility').textContent:null, scanPages: q('.scan-pages')? q('.scan-pages').textContent:null, scanError: q('.scan-error')? q('.scan-error').textContent:null }; })()",
  );

  // Now read job/sample counts again
  const idb = await page.evaluate(
    "(async function(){ try { var db = await new Promise(function(res,rej){ var r=indexedDB.open('samplemap',3); r.onerror=function(){rej(r.error)}; r.onsuccess=function(){res(r.result)} }); var readAll=function(store){ return new Promise(function(res,rej){ var tx=db.transaction(store,'readonly'); var req=tx.objectStore(store).getAll(); req.onsuccess=function(){res(req.result)}; req.onerror=function(){rej(req.error)} }) }; var jobs=await readAll('jobs'); var samples=await readAll('samples'); var js={}; for (var j of jobs) js[j.status]=(js[j.status]||0)+1; var ss={}; for (var s of samples) ss[s.status]=(ss[s.status]||0)+1; return { jobs: jobs.length, jobStatuses: js, samples: samples.length, sampleStatuses: ss }; } catch(e){ return { error: String(e) } } })()",
  );

  const out = { at: new Date().toISOString(), elapsedSec: elapsed, state, idb };
  writeFileSync(`${OUT}/step68-scan-live.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await page.close();
  await browser.close();
}

main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });