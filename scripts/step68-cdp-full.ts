import { chromium } from "playwright";
import { writeFileSync } from "fs";

const OUT = "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step68";

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(4000);

  const result: Record<string, unknown> = { url: page.url() };

  result.dom = await page.evaluate(
    "(function(){ var q=function(s){return document.querySelector(s)}; var qa=function(s){return document.querySelectorAll(s)}; return { mapSvg: !!q('[data-testid=sample-map]'), mapPoints: qa('[data-testid=sample-map] circle').length, mapEmpty: !!q('.map-empty'), scanCount: q('.scan-count')? q('.scan-count').textContent : null, scanStatus: q('.scan-status')? q('.scan-status').textContent : null, scanEligibility: q('.scan-eligibility')? q('.scan-eligibility').textContent : null, results: q('.results-panel h2, .results-panel section')? q('.results-panel h2, .results-panel section').textContent : null, resultsEmpty: !!q('.results-empty'), resultsList: qa('.result-row').length, analysisStatus: q('.analysis-status')? q('.analysis-status').textContent : null, analysisBudget: q('.analysis-budget')? q('.analysis-budget').textContent : null, analyzeButtons: Array.prototype.slice.call(qa('.analysis-budget-btn')).map(function(b){return b.textContent}), scanButton: !!q('.scan-start'), hasLoginWall: !!q('#login'), url: location.href }; })()",
  ).catch((e) => ({ error: (e as Error).message }));

  // Probe IDB state
  result.idb = await page.evaluate(
    "(async function(){ try { var db = await new Promise(function(res, rej){ var r = indexedDB.open('samplemap', 3); r.onerror = function(){ rej(r.error); }; r.onsuccess = function(){ res(r.result); }; }); var readAll = function(store){ return new Promise(function(res, rej){ var tx = db.transaction(store, 'readonly'); var req = tx.objectStore(store).getAll(); req.onsuccess = function(){ res(req.result); }; req.onerror = function(){ rej(req.error); }; }); }; var jobs = await readAll('jobs'); var samples = await readAll('samples'); var jobStatuses = {}; for (var j of jobs) jobStatuses[j.status] = (jobStatuses[j.status] || 0) + 1; var sampleStatuses = {}; var analyzed = 0, audio = 0, mapPos = 0, sc = 0; for (var s of samples) { sampleStatuses[s.status] = (sampleStatuses[s.status] || 0) + 1; if (s.status === 'analyzed') analyzed++; if (s.audioFeatures) audio++; if (s.mapPosition) mapPos++; if (s.analysisV2 && s.analysisV2.soundCharacter) sc++; } db.close(); return { jobsCount: jobs.length, jobStatuses: jobStatuses, samplesCount: samples.length, sampleStatuses: sampleStatuses, analyzed: analyzed, audio: audio, mapPos: mapPos, sc: sc }; } catch (e) { return { error: String(e) }; } })()",
  ).catch((e) => ({ error: (e as Error).message }));

  writeFileSync(`${OUT}/step68-cdp-full.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await page.close();
  await browser.close();
}

main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });