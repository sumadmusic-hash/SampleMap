import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  test: {
    globals: true,
    environment: "node",
    // The Cloudflare worker provider lives in its own subproject (workers/) with
    // its own vitest config + fake-D1 harness. Exclude it from the app run so the
    // app baseline suite stays deterministic (the worker tests run separately).
    exclude: ["workers/**", "node_modules/**", "dist/**", "e2e/**"],
  },
});