/**
 * SampleMap GlobalSampleIndex — Cloudflare Worker HTTP API (16F-9).
 *
 * Thin routing layer over `CloudflareGlobalSampleIndex`. Responsibilities:
 *   - map HTTP routes → contract operations (READ anonymous, WRITE protected),
 *   - enforce request-size / batch caps (16E §14),
 *   - re-run the no-audio guard on every inbound body (16E §16),
 *   - map `GlobalIndexError` kinds → HTTP status codes via a stable envelope,
 *   - restricted CORS / Origin policy for browser use,
 *   - never leak stack traces / internals to clients.
 *
 * Security honesty (16E §14, OQ-9): the publish write-path AUTH MECHANISM is an
 * OPEN product decision, NOT invented here. To avoid faking a scheme, the
 * Worker exposes injectable `PublishAuthorizer` + `RateLimiter` hooks; the
 * defaults are permissive and are explicitly NOT a security boundary. Real
 * auth (Nexus/Audiotool token, Cloudflare Access, shared secret) and server
 * rate-limiting are deferred to a live infra decision (OQ-9). Reads are
 * anonymous by design.
 */
import { CloudflareGlobalSampleIndex } from "./provider";
import type {
  GlobalIndexError,
  GlobalPublishBatch,
  MapViewportQuery,
} from "../../../src/global/contract";
import { assertNoAudioBytes } from "../../../src/persistence/indexStore";

interface Env {
  DB: D1Database;
  PUBLISH_MAX_BATCH: string;
  PUBLISH_MAX_BODY_BYTES: string;
  MAP_DEFAULT_LIMIT: string;
  MAP_MAX_LIMIT: string;
  API_ALLOWED_ORIGIN: string;
}

/**
 * Extension point for write-path protection (OQ-9). 16F does NOT invent auth:
 * the default allows all writes and is documented as a placeholder awaiting the
 * live auth decision. A real deployment injects a non-permissive authorizer.
 */
export interface PublishAuthorizer {
  /** Returns an error to reject the publish, or null to allow. */
  authorize(request: Request): GlobalIndexError | null;
}

/** Extension point for rate limiting (16E §14). 16F supplies a permissive stub. */
export interface RateLimiter {
  check(request: Request): GlobalIndexError | null;
}

const PERMISSIVE_AUTHORIZER: PublishAuthorizer = {
  authorize() {
    // OQ-9: auth mechanism not invented in 16F. NOT a security boundary.
    return null;
  },
};

const PERMISSIVE_RATE_LIMITER: RateLimiter = {
  check() {
    // 16E §14 rate-limiting is a live-infra item; not implemented in 16F.
    return null;
  },
};

// HTTP status per GlobalIndexError kind.
const ERROR_STATUS: Record<GlobalIndexError["kind"], number> = {
  "not-found": 404,
  "validation-rejected": 400,
  "version-incompatible": 422,
  conflict: 409,
  "rate-limited": 429,
  "temporary-unavailable": 503,
};

function makeProvider(env: Env): CloudflareGlobalSampleIndex {
  return new CloudflareGlobalSampleIndex(env.DB, {
    maxBatchSize: Number(env.PUBLISH_MAX_BATCH) || 100,
    defaultMapLimit: Number(env.MAP_DEFAULT_LIMIT) || 200,
    maxMapLimit: Number(env.MAP_MAX_LIMIT) || 1000,
  });
}

async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > maxBytes) {
    throw { kind: "validation-rejected", reason: "request body too large" };
  }
  const text = new TextDecoder().decode(raw);
  return JSON.parse(text) as unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowedOrigin = env.API_ALLOWED_ORIGIN?.split(",").map((s) => s.trim());

    // CORS preflight.
    if (request.method === "OPTIONS") {
      const headers = corsHeaders(origin, allowedOrigin);
      return new Response(null, { status: 204, headers });
    }

    try {
      const baseHeaders = corsHeaders(origin, allowedOrigin);
      const route = `${request.method} ${url.pathname}`;
      const provider = makeProvider(env);

      switch (route) {
        case "POST /samples/lookup": {
          const body = await readJsonBody(
            request,
            Number(env.PUBLISH_MAX_BODY_BYTES) || 262144,
          );
          if (!isStringArray(body)) {
            return errorResponse(
              { kind: "validation-rejected", reason: "samples must be a string[]" },
              baseHeaders,
            );
          }
          const hits = await provider.lookupSamples(body);
          return json(hits, baseHeaders);
        }

        case "POST /content/lookup": {
          const body = await readJsonBody(
            request,
            Number(env.PUBLISH_MAX_BODY_BYTES) || 262144,
          );
          if (!isIdentityArray(body)) {
            return errorResponse(
              {
                kind: "validation-rejected",
                reason: "identities must be [{contentHash, contentHashVersion}]",
              },
              baseHeaders,
            );
          }
          const identities = body.map((id) => ({
            contentHash: id.contentHash,
            contentHashVersion: id.contentHashVersion,
          }));
          const hits = await provider.lookupContentIdentities(identities);
          return json(hits, baseHeaders);
        }

        case "POST /publish": {
          // WRITE path: protected (OQ-9). Extension point — not fake auth.
          const authError = PERMISSIVE_AUTHORIZER.authorize(request);
          if (authError) return errorResponse(authError, baseHeaders);
          const rateError = PERMISSIVE_RATE_LIMITER.check(request);
          if (rateError) return errorResponse(rateError, baseHeaders);

          const raw = await readJsonBody(
            request,
            Number(env.PUBLISH_MAX_BODY_BYTES) || 262144,
          );
          assertNoAudioBytes(raw, "$publish");
          const batch = raw as GlobalPublishBatch;
          if (!Array.isArray(batch)) {
            return errorResponse(
              { kind: "validation-rejected", reason: "publish body must be an array" },
              baseHeaders,
            );
          }
          const outcome = await provider.publishAnalysisResults(batch);
          return json(outcome, baseHeaders);
        }

        case "GET /map": {
          const xMin = numOrUndefined(url.searchParams.get("xMin"));
          const xMax = numOrUndefined(url.searchParams.get("xMax"));
          const yMin = numOrUndefined(url.searchParams.get("yMin"));
          const yMax = numOrUndefined(url.searchParams.get("yMax"));
          const mapVersion = url.searchParams.get("mapVersion") ?? "";
          if (
            !mapVersion ||
            xMin === undefined ||
            xMax === undefined ||
            yMin === undefined ||
            yMax === undefined
          ) {
            return errorResponse(
              {
                kind: "validation-rejected",
                reason:
                  "mapVersion, xMin, xMax, yMin, yMax are required for /map",
              },
              baseHeaders,
            );
          }
          const query: MapViewportQuery = {
            mapVersion,
            xMin,
            xMax,
            yMin,
            yMax,
            zoom: numOrUndefined(url.searchParams.get("zoom")),
            primaryClass: url.searchParams.get("primaryClass") ?? undefined,
            limit: intOrUndefined(url.searchParams.get("limit")),
            cursor: url.searchParams.get("cursor") ?? undefined,
          };
          const result = await provider.queryMapViewport(query);
          return json(result, baseHeaders);
        }

        case "GET /health": {
          return json({ status: "ok" }, baseHeaders);
        }

        default: {
          return errorResponse({ kind: "not-found" }, baseHeaders);
        }
      }
    } catch (err) {
      return errorResponse(mapError(err), corsHeaders(origin, allowedOrigin));
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Response helpers
// ─────────────────────────────────────────────────────────────────────────────

function corsHeaders(origin: string | null, allowed: string[] | undefined): HeadersInit {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  };
  if (origin && allowed?.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function json(body: unknown, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function errorResponse(error: GlobalIndexError, headers: HeadersInit): Response {
  // Never expose stack traces or internals; only the stable error kind + reason.
  return new Response(JSON.stringify(error), {
    status: ERROR_STATUS[error.kind] ?? 500,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function mapError(err: unknown): GlobalIndexError {
  if (err && typeof err === "object" && "kind" in err) {
    return err as GlobalIndexError;
  }
  return { kind: "temporary-unavailable" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Small validators
// ─────────────────────────────────────────────────────────────────────────────

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isIdentityArray(
  v: unknown,
): v is { contentHash: string; contentHashVersion: string }[] {
  return (
    Array.isArray(v) &&
    v.every(
      (x) =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as { contentHash?: unknown }).contentHash === "string" &&
        typeof (x as { contentHashVersion?: unknown }).contentHashVersion === "string",
    )
  );
}

function numOrUndefined(v: string | null): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function intOrUndefined(v: string | null): number | undefined {
  const n = numOrUndefined(v);
  return n === undefined ? undefined : Math.floor(n);
}
