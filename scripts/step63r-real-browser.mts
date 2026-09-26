#!/usr/bin/env -S npx tsx
/**
 * STEP63R.1 — REAL BROWSER startup-timing verification (AUDIT ONLY).
 *
 * Drives the REAL SampleMap app in the REAL installed Google Chrome, using a
 * COPY of the user's real Chrome profile (real OAuth session / cookies /
 * localStorage — NOT a synthetic or PAT identity), against the REAL live
 * Audiotool backend.
 *
 *   Run A: cold open   (new page, real existing IDB session)
 *   Run B: reload
 *   Run C: second reload
 *
 * Captures:
 *   - wall-clock until first useful SampleMap render (map canvas)
 *   - every [sm-timing] marker emitted by the instrumented boot
 *   - network resource timeline for audiotool hosts
 *   - STEP62 startup-state (IndexedDB queue/jobs snapshots) at settle
 *
 * No production behavior is changed. All instrumentation is the existing
 * temporary STEP63R/STEP63R.1 logging.
 */
import { chromium } from "@playwright/test";

const APP_URL = "http://127.0.0.1:5173/";
const PROFILE = "/tmp/sm-real-profile";
const CANVAS = '[data-testid="sound-space-canvas"]';

interface Event {
  at: number; // wall clock ms (Date.now())
  seq: number;
  text: string;
}

function capture(ctx: Awaited<ReturnType<typeof chromium.launchPersistentContext>>) {
  const events: Event[] = [];
  let seq = 0;
  ctx.on("console", (msg) => {
    const text = msg.text();
    if (/\[sm-timing\]|Login|authenticated|SampleMap mount failed/.test(text)) {
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
        "g[name] = { count: await new Promise((res) => {" +
        "const r = st.count(); r.onsuccess = () => res(r.result); r.onerror = () => res(-1);" +
        "}) };" +
        "if (name === 'jobs') {" +
        "const jobs = await new Promise((res) => {" +
        "const r = st.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]);" +
        "});" +
        "const byStatus = {};" +
        "for (const j of jobs) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;" +
        "g.jobs = { count: jobs.length, byStatus };" +
        "}" +
        "}" +
        "db.close();" +
        "return g;" +
        "} catch(e) { return { error: e.message || String(e) }; }" +
        "})()",
    )
    .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
}

async function run(
  page: import("@playwright/test").Page,
  events: Event[],
  label: string,
  reload: boolean,
) {
  const t0 = Date.now();
  const base = events.length;
  const navStart = t0;
  if (reload) {
    // Switch to the dev-server host + port used by the real session (5173).
    await page.goto(APP_URL, { waitUntil: "commit" });
    await page.reload();
  } else {
    await page.goto(APP_URL, { waitUntil: "commit" });
  }
  const navTime = navStart;

  // Wait for one of: authenticated map canvas | unauthenticated login wall.
  let usableAt: number | null = null;
  let loginWallAt: number | null = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const login = await page.locator("#login").isVisible().catch(() => false);
    const canvas = await page.locator(CANVAS).count().catch(() => 0);
    if (canvas > 0) {
      usableAt = Date.now();
      break;
    }
    if (login) {
      loginWallAt = Date.now();
      break;
    }
    // Fallback: trust the instrumented marker when DOM detection lags. The
    // map canvas only renders when the Sound Space panel is OPEN with >=1
    // analyzed sample; with an empty real index (STEP62: 0 samples) it never
    // mounts, so this marker is the authoritative "mount arrived" signal.
    const hasMountMarker = events
      .slice(base)
      .some((e) => /mountAuthenticated:mountSampleMap/.test(e.text));
    if (hasMountMarker) {
      usableAt = Date.now();
      break;
    }
    await page.waitForTimeout(150);
  }

  const runEvents = events.slice(base).map((e) => ({
    ...e,
    rel: e.at - navTime,
  }));

  console.log(`\n═══ RUN ${label} — ${reload ? "reload" : "cold open"} ═══`);
  console.log(`first-load-req... goto at t=${navTime}`);
  if (usableAt !== null) {
    console.log(
      `timeUntilfirstUsefulRender: ${(usableAt - navTime).toFixed(0)}ms (SampleMap UI mounted)`,
    );
  } else if (loginWallAt !== null) {
    console.log(`LOGIN WALL at +${(loginWallAt - navTime).toFixed(0)}ms (unauthenticated)`);
  } else {
    console.log(`NEITHER canvas nor login wall within 90s — timeout`);
  }
  if (loginWallAt !== null) usableAt = null;

  for (const e of runEvents) {
    console.log(`  +${e.rel.toFixed(0)}ms  ${e.text}`);
  }

  // Network timeline for audiotool hosts during this run.
  let net: { name: string; initiator: string; start: number; dur: number; transfer: number }[] = [];
  try {
    net = await page.evaluate(() => {
      const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const hosts = [
        "oauth.audiotool.com",
        "accounts.audiotool.com",
        "rpc.audiotool.com",
        "rpc.audiotool",
        "audiotool.com",
      ];
      const out = [];
      for (const e of entries) {
        if (!hosts.some((h) => e.name.includes(h))) continue;
        out.push({
          name: e.name.split("/").slice(0, 5).join("/"),
          initiator: e.initiatorType,
          start: Math.round(e.startTime),
          dur: Math.round(e.duration),
          transfer: Math.round(e.transferSize),
        });
      }
      return out;
    });
  } catch {
    /* non-fatal — timing from markers is sufficient */
  }
  console.log(`  network(resource entries, audiotool hosts):`);
  for (const r of net) if (r.dur > 5) console.log(`    +${r.start}ms dur=${r.dur}ms ${r.initiator} ${r.name}`);

  // STEP62 startup-state once settled.
  await page.waitForTimeout(4000);
  const idb = await idbState(page);
  console.log(`  STEP62 indexeddb state: ${JSON.stringify(idb)}`);

  return { usableAt, net, idb };
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

  // Give Chrome a moment with the profile prefs loaded.
  await page.waitForTimeout(500);

  // ---- Run A (cold open) ----
  const A = await run(page, events, "A (cold open)", false);

  // ---- Run B (reload) ----
  const B = await run(page, events, "B (reload)", true);

  // ---- Run C (second reload) ----
  const C = await run(page, events, "C (2nd reload)", true);

  console.log(`\n════ SUMMARY ════`);
  for (const [k, v] of Object.entries({ A, B, C })) {
    console.log(
      `${k}: usable=${v.usableAt !== null ? "yes" : "NO"}${
        v.usableAt !== null ? "" : " (login wall or timeout)"
      }`,
    );
  }

  await ctx.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});