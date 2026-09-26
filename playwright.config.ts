import { defineConfig, devices } from "@playwright/test";

/**
 * Step 16M Layer A verification: drive the REAL SampleMap UI in a REAL browser
 * (system Chrome via channel: 'chrome') against the OFFLINE harness
 * (harness.html -> src/e2e/harness/main.ts). No Playwright browser is
 * downloaded; we reuse the installed Google Chrome.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 1400 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  outputDir: "./e2e/artifacts/test-results",
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173/harness.html",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
