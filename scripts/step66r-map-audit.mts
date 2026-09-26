#!/usr/bin/env -S npx tsx
/**
 * STEP66R — REAL BROWSER map-population audit (AUDIT ONLY).
 *
 * Drives the REAL SampleMap app in real Chrome using a COPY of the real
 * Chrome profile (real OAuth/cookies/localStorage) against the real live
 * backend — exactly the STEP63R/64 methodology. No mocks, no production
 * change.
 *
 * Answers:
 *   - how many samples does the indexed DB of the real app actually hold?
 *   - how many local points does the map MODEL have (mapPoints gate over the
 *     index: analyzed + audioFeatures + position, dedup by content identity)?
 *   - how many points are actually RENDERED in the DOM (circle.map-point)?
 *   - does the app load global points (/map), and how many arrive?
 *   - is the app stuck at a login wall, empty state, or loaded-but-not-drawn?
 *
 * Usage: npx tsx scripts/step66r-map-audit.mts   (vite dev server on :5173)
 */
import { chromium } from "@playwright/test";

const APP_URL = "http://127.0.0.1:5173/";
const PROFILE = "/tmp/sm-real-profile";

interface Event {
  at: number;
  seq: number;
  text: string;
}

function capture(ctx: Awaited<ReturnType<typeof chromium.launchPersistentContext>>) {
  const events: Event[] = [];
  let seq = 0;
  ctx.on("console", (msg) => {
    const text = msg.text();
    if (
      /\[sm-timing\]|Login|authenticated|SampleMap mount failed|Samples returned|list\(\)/.test(text)
    ) {
      events.push({ at: Date.now(), seq: ++seq, text });
    }
  });
  return events;
}

async function idbState(page: import("@playwright/test").Page) {
  return page
    .evaluate(
      "(async () => {" +
        "try {" +
        "const db = await new Promise((resolve) => {" +
        "const req = indexedDB.open('samplemap');" +
        "req.onsuccess = () => resolve(req.result);" +
        "req.onerror = () => resolve(null);" +
        "});" +
        "if (!db) return { error: 'no indexedDB' };" +
        "const g = { stores: Array.from(db.objectStoreNames) };" +
        "const tx = db.transaction(db.objectStoreNames, 'readonly');" +
        "for (const name of db.objectStoreNames) {" +
        "const st = tx.objectStore(name);" +
        "g[name] = { count: await new Promise((res) => { const r = st.count(); r.onsuccess = () => res(r.result); r.onerror = () => res(-1); }) };" +
        "if (name === 'samples') {" +
        "const all = await new Promise((res) => { const r = st.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });" +
        "const byStatus = {}; for (const s of all) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;" +
        "const analyzed = all.filter((s) => s.status === 'analyzed');" +
        "const withAudio = analyzed.filter((s) => !!s.audioFeatures);" +
        "const withMapPos = analyzed.filter((s) => !!(s.mapPosition && typeof s.mapPosition.x === 'number' && typeof s.mapPosition.y === 'number'));" +
        "const projectable = analyzed.filter((s) => { const c = s.analysisV2 && s.analysisV2.soundCharacter; if (!c) return false; return (c.tonality !== null && c.tonality !== undefined) || (c.noisiness !== null && c.noisiness !== undefined); });" +
        "const withBrightness = analyzed.filter((s) => { const c = s.analysisV2 && s.analysisV2.soundCharacter; return !!c && c.brightness !== null && c.brightness !== undefined; });" +
        "const canonicalProjectable = projectable.filter((s) => withBrightness.includes(s));" +
        "const withEitherPos = analyzed.filter((s) => { const c = s.analysisV2 && s.analysisV2.soundCharacter; const canon = c && ((c.tonality !== null && c.tonality !== undefined) || (c.noisiness !== null && c.noisiness !== undefined)) && c.brightness !== null && c.brightness !== undefined; return !!canon || !!(s.mapPosition && typeof s.mapPosition.x === 'number' && typeof s.mapPosition.y === 'number'); });" +
        "const keys = new Set(); for (const s of withEitherPos) keys.add(s.contentHash ? (s.contentHashVersion ?? 'unknown') + ':' + s.contentHash : 'legacy:' + s.sampleId);" +
        "g.samples.sampleCount = all.length;" +
        "g.samples.byStatus = byStatus;" +
        "g.samples.analyzed = analyzed.length;" +
        "g.samples.analyzedWithAudioFeatures = withAudio.length;" +
        "g.samples.withMapPosition = withMapPos.length;" +
        "g.samples.canonicalProjectableApprox = canonicalProjectable.length;" +
        "g.samples.distinctHashes = new Set(analyzed.filter((s) => s.contentHash).map((s) => s.contentHash)).size;" +
        "g.samples.potentialMapPointsAfterDedup = keys.size;" +
        "}" +
        "if (name === 'jobs') {" +
        "const all = await new Promise((res) => { const r = st.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });" +
        "const byStatus = {}; for (const j of all) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;" +
        "g.jobs.count = all.length; g.jobs.byStatus = byStatus;" +
        "}" +
        "}" +
        "db.close();" +
        "return g;" +
        "} catch(e) { return { error: e.message || String(e) }; }" +
        "})()",
    )
    .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
}

async function domState(page: import("@playwright/test").Page) {
  return page
    .evaluate(
      "(() => {" +
        "const q = (sel) => document.querySelectorAll(sel).length;" +
        "const txt = (sel) => { const el = document.querySelector(sel); return el ? (el.textContent || '').trim() : null; };" +
        "const out = {};" +
        "out.loginWall = !!document.querySelector('#login');" +
        "out.mapEmpty = q('[data-testid=\"map-empty\"]');" +
        "out.sampleMapSvg = q('[data-testid=\"sample-map\"]');" +
        "out.mapPointCircles = q('[data-testid=\"sample-map\"] circle.map-point');" +
        "out.mapGlobalState = txt('[data-testid=\"map-global-state\"]');" +
        "out.resultCount = txt('[data-testid=\"result-count\"]');" +
        "out.resultsListItems = q('#results-list li');" +
        "out.resultsEmpty = q('[data-testid=\"results-empty\"]');" +
        "out.searchInput = txt('.search-query input, input[data-testid*=\"search\"]');" +
        "out.activeClassChips = Array.from(document.querySelectorAll('.search-actions .filter-chip, .class-filter .active, .chip.active')).map((e) => e.textContent.trim()).join(',');" +
        "out.soundSpaceStatus = txt('[data-testid=\"sound-space-status\"], .sound-space-status');" +
        "out.zoomLabel = txt('[data-testid=\"map-zoom-label\"]');" +
        "return out;" +
        "})()",
    )
    .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
}

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 1400 },
    args: ["--disable-background-timer-throttling", "--no-first-run"],
  });
  const events = capture(ctx);
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  // Network: capture /map (and any /samples/lookup) responses for the audit.
  const mapResponses: string[] = [];
  page.on("response", async (res) => {
    const u = res.url();
    if (u.includes("/map") && res.request().method() === "GET") {
      try {
        const j = (await res.json()) as {
          points?: unknown[];
          nextCursor?: string;
        };
        mapResponses.push(
          `GET ${u} -> ${res.status()} points=${j.points?.length ?? "?"} nextCursor=${j.nextCursor ?? "none"}`,
        );
      } catch {
        mapResponses.push(`GET ${u} -> ${res.status()} (non-json)`);
      }
    }
  });

  await page.waitForTimeout(500);
  const t0 = Date.now();
  await page.goto(APP_URL, { waitUntil: "commit" });

  // Wait for: mounted UI (marker) | login wall | results/map DOM.
  let reachedAt: number | null = null;
  let loginAt: number | null = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const login = await page.locator("#login").isVisible().catch(() => false);
    const markers = events.some((e) => /mountAuthenticated:mountSampleMap/.test(e.text));
    const any = await page
      .locator('[data-testid="sample-map"], [data-testid="map-empty"], #results-list')
      .count()
      .catch(() => 0);
    if (markers || any > 0) {
      reachedAt = Date.now();
      break;
    }
    if (login) {
      loginAt = Date.now();
      break;
    }
    await page.waitForTimeout(150);
  }
  console.log(
    `boot: UI reached at +${reachedAt ? reachedAt - t0 : "?"}ms${
      loginAt ? ` | LOGIN WALL at +${loginAt - t0}ms` : ""
    }`,
  );

  // Let the app settle (search + global refresh).
  await page.waitForTimeout(6000);

  const idb = await idbState(page);
  const dom = await domState(page);

  console.log("\n═══ IDB samplemap (real profile) ═══");
  console.log(JSON.stringify(idb, null, 1));
  console.log("\n═══ DOM/rendered state ═══");
  console.log(JSON.stringify(dom, null, 1));
  console.log("\n═══ /map network responses ═══");
  if (mapResponses.length === 0) console.log("  (no /map GET observed — global read not wired or not reached)");
  for (const r of mapResponses) console.log(`  ${r}`);

  console.log("\n═══ boot events (console markers) ═══");
  for (const e of events.slice(0, 60)) {
    console.log(`  +${(e.at - t0).toFixed(0)}ms  ${e.text}`);
  }

  await ctx.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});