/**
 * STEP68 — PRISTINE real Default-profile IndexedDB, authoritative in-browser
 * decode via real Chromium + the REAL profile copy (rsync'd BEFORE STEP67
 * hydration). READ-ONLY. No hydration, no login, no production change.
 *
 * This resolves: STEP66/STEP67 claimed `samples=0` (in-browser), but raw .ldb
 * `strings` shows ~85× analysisV2 / soundCharacter / spectralCentroid /
 * mapPosition markers (analyzed-only fields). Which is right for the PRISTINE
 * real profile? We answer by opening the pristine copy's IndexedDB in a real
 * Chromium and reading the stores/records the app actually reads.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const PROFILE = process.env.SM_REAL_PROFILE ?? "/tmp/sm-real-profile";
const outDir = "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step68";

async function idbState(page: import("@playwright/test").Page) {
  return page
    .evaluate(
      "(async () => {" +
        "const out = {};" +
        "try {" +
        "const db = await new Promise((res, rej) => { const r = indexedDB.open('samplemap'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onupgradeneeded = () => {}; });" +
        "out.stores = Array.from(db.objectStoreNames);" +
        "for (const name of db.objectStoreNames) {" +
        "  const st = db.transaction(name, 'readonly').objectStore(name);" +
        "  const all = await new Promise((res) => { const r = st.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });" +
        "  const rec = { count: all.length };" +
        "  const byStatus = {}; for (const x of all) byStatus[x.status] = (byStatus[x.status] ?? 0) + 1; rec.byStatus = byStatus;" +
        "  if (name === 'samples') {" +
        "    const analyzed = all.filter((s) => s.status === 'analyzed');" +
        "    rec.analyzed = analyzed.length;" +
        "    rec.analyzedWithAudioFeatures = analyzed.filter((s) => !!s.audioFeatures).length;" +
        "    rec.withMapPosition = analyzed.filter((s) => !!(s.mapPosition && typeof s.mapPosition.x === 'number')).length;" +
        "    rec.distinctContentHashes = new Set(analyzed.map((s) => s.contentHash).filter(Boolean)).size;" +
        "    rec.canonicalProjectable = analyzed.filter((s) => { const c = s.analysisV2?.soundCharacter; return !!c && c.brightness != null && (c.tonality != null || c.noisiness != null); }).length;" +
        "    rec.sampleIdsSample = analyzed.slice(0, 5).map((s) => s.sampleId);" +
        "  }" +
        "  if (name === 'jobs') {" +
        "    rec.withAttempts = all.filter((j) => j.attempts > 0).length;" +
        "  }" +
        "  out[name] = rec;" +
        "}" +
        "return out;" +
        "} catch (e) { return { error: String(e) }; }" +
        "})()",
    )
    .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
}

async function main() {
  const profile = PROFILE;
  console.log(`profile: ${profile}`);
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1200, height: 900 },
  });
  const [page] = ctx.pages();
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(1500);
  const idb = await idbState(page);
  console.log("\n═══ STEP68 PRISTINE real-profile IndexedDB (real Chromium decode) ═══");
  console.log(JSON.stringify(idb, null, 2));
  await ctx.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
