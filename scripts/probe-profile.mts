import { chromium } from "@playwright/test";

async function main() {
  const ctx = await chromium.launchPersistentContext("/tmp/sm-real-profile", {
    channel: "chrome",
    headless: false,
    viewport: { width: 1200, height: 900 },
    args: ["--no-first-run"],
  });
  for (const host of ["localhost", "127.0.0.1"]) {
    for (const port of [5173, 5174, 5175, 5176, 5177, 3000, 8080]) {
      const origin = `http://${host}:${port}`;
      const page = await ctx.newPage();
      try {
        await page.goto(origin + "/", { waitUntil: "commit", timeout: 8000 });
        await page.waitForTimeout(600);
        const oidcKeys = await page.evaluate(() =>
          Object.keys(localStorage).filter((k) => k.includes("oidc")).map((k) => `  ${k} => ${(localStorage.getItem(k) || "").slice(0, 60)}`),
        );
        const cookies = (await ctx.cookies(origin)).length;
        console.log(`${origin}: oidcKeys=${oidcKeys.length} cookies=${cookies}`);
        for (const k of oidcKeys) console.log(k);
      } catch {
        // connection refused (no server) — skip silently
      }
      await page.close();
    }
  }
  await ctx.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});