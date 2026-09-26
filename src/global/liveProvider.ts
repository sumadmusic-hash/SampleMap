/**
 * Step 16I — Live Global Publish Provider Wiring.
 *
 * Connects the existing 16D/16H publish flow to the deployed, live
 * Cloudflare Worker/D1 backend by constructing the existing client
 * `CloudflareGlobalAdapter` (workers/d1-worker/src/browserAdapter.ts) around a
 * configured Worker base URL.
 *
 * Configuration (smallest existing-project mechanism): a single Vite env var
 * `VITE_GLOBAL_WORKER_URL` (the Worker URL is NOT a secret; see §14). Reads via
 * `import.meta.env`. No API keys / JWT / OAuth introduced — the Worker's 16F
 * authorization state (OQ-9) is unchanged.
 *
 * Offline-first is preserved: if no Worker URL is configured (or fetch is
 * unavailable), `createGlobalProvider` returns the deliberate offline provider
 * from 16H (every publish is `temporary-unavailable` → retryable → stays in the
 * queue as pending). Acceptance markers still persist; delivery resumes when a
 * live provider is configured.
 *
 * The adapter is injected-seam friendly: `fetchImpl` is overridable for tests.
 * It implements the SAME `GlobalSampleIndex` contract, so `GlobalPublishQueue`
 * and `usageAcceptance.ts` consume it unchanged.
 */
import type { GlobalSampleIndex } from "./contract";

/**
 * The offline-first fallback provider (16H). Every publish is
 * `temporary-unavailable` so items remain pending/retryable and the local
 * acceptance marker survives until a live provider is configured.
 */
export function offlineProvider(): GlobalSampleIndex {
  return {
    async lookupSamples() {
      return [];
    },
    async lookupContentIdentities() {
      return [];
    },
    async queryMapViewport() {
      return { mapVersion: "", points: [] };
    },
    async publishAnalysisResults(batch) {
      return {
        items: batch.map(() => ({
          status: "rejected",
          reason: "temporary-unavailable",
        })),
        accepted: false,
      };
    },
  };
}

/**
 * STEP58 — read-path wiring decision for the live authenticated entry.
 *
 * The live entry creates ONE provider (via `createGlobalProvider`) that already
 * backs the publish queue. When a live Worker URL is configured the SAME
 * instance is injected as `globalIndex` so the existing map-read path
 * (`mountAuthenticated` → `refreshGlobalPoints` → `queryMapViewport`) uses it —
 * no second provider, no fabricated points. When no live URL is configured the
 * read stays unwired (`undefined`): the offline provider is never installed as
 * the map source, so offline startup behavior is unchanged.
 */
export function readProviderFor(
  provider: GlobalSampleIndex | undefined,
  live: boolean,
): GlobalSampleIndex | undefined {
  return live ? provider : undefined;
}

export interface LiveProviderConfig {
  /** Worker base URL, e.g. `https://samplemap-d1-worker.<account>.workers.dev`. */
  baseUrl?: string;
  /** Optional fictional origin sent as Origin/CORS context. */
  origin?: string;
  /** Optional publish write-path token (OQ-9) — only sent if configured. */
  publishToken?: string;
  /** Injectable fetch for tests; defaults to the environment fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve the environment's Worker URL. Reads `VITE_GLOBAL_WORKER_URL` from
 * `import.meta.env` and returns `undefined` when absent/empty (→ offline).
 */
export function workerUrlFromEnv(
  env: { VITE_GLOBAL_WORKER_URL?: string } = import.meta.env as { VITE_GLOBAL_WORKER_URL?: string },
): string | undefined {
  const raw = env.VITE_GLOBAL_WORKER_URL;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed.replace(/\/+$/, "");
}

/**
 * Build the provider used by the publish queue. Uses the live
 * `CloudflareGlobalAdapter` when a Worker URL is configured; otherwise returns
 * the offline-first 16H fallback.
 */
export async function createGlobalProvider(
  config: LiveProviderConfig = {},
): Promise<GlobalSampleIndex> {
  const baseUrl: string | undefined =
    config.baseUrl ??
    workerUrlFromEnv(import.meta.env as { VITE_GLOBAL_WORKER_URL?: string });

  if (!baseUrl) {
    return offlineProvider();
  }

  const { CloudflareGlobalAdapter } = await import(
    "../../workers/d1-worker/src/browserAdapter"
  );

  const adapter = new CloudflareGlobalAdapter({
    baseUrl,
    origin: config.origin,
    publishToken: config.publishToken,
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
  });

  return adapter;
}
