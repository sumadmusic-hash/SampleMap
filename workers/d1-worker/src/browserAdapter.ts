/**
 * Browser-side adapter implementing the `GlobalSampleIndex` contract
 * (src/global/contract.ts) over `fetch` to the SampleMap D1 Worker (16F-10).
 *
 * This is a thin, mechanical transport: it maps contract inputs → HTTP requests
 * to the Worker routes and HTTP responses → contract outputs / `GlobalIndexError`.
 * It performs NO domain logic (dedup, reuse decisions, representative selection)
 * — those live in src/global/* which stays unchanged. It is metadata-only and
 * never constructs or carries audio bytes.
 */
import type {
  GlobalSampleIndex,
  GlobalSampleLookupHit,
  GlobalContentLookupHit,
  GlobalPublishOutcome,
  GlobalPublishBatch,
  GlobalMapViewportResult,
  MapViewportQuery,
  GlobalIndexError,
} from "../../../src/global/contract";
import type { AudioContentIdentity } from "../../../src/identity/audioContentIdentity";
import { assertNoAudioBytes } from "../../../src/persistence/indexStore";

export interface GlobalIndexAdapterOptions {
  /** Base URL of the Worker (e.g. https://samplemap-global.example.workers.dev). */
  baseUrl: string;
  /** The app's own origin, sent as the Origin/CORS context. */
  origin?: string;
  /** Optional publish write-path token (OQ-9 — sent only if the caller configures it). */
  publishToken?: string;
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export class CloudflareGlobalAdapter implements GlobalSampleIndex {
  private readonly opts: GlobalIndexAdapterOptions;

  constructor(opts: GlobalIndexAdapterOptions) {
    this.opts = opts;
  }

  async lookupSamples(
    sampleIds: readonly string[],
  ): Promise<GlobalSampleLookupHit[]> {
    assertNoAudioBytes(sampleIds, "$samples");
    const body = await this.post("/samples/lookup", [...sampleIds]);
    return body as GlobalSampleLookupHit[];
  }

  async lookupContentIdentities(
    identities: readonly AudioContentIdentity[],
  ): Promise<GlobalContentLookupHit[]> {
    assertNoAudioBytes(identities, "$identities");
    const body = await this.post(
      "/content/lookup",
      identities.map((id) => ({
        contentHash: id.contentHash,
        contentHashVersion: id.contentHashVersion,
      })),
    );
    return body as GlobalContentLookupHit[];
  }

  async publishAnalysisResults(
    batch: GlobalPublishBatch,
  ): Promise<GlobalPublishOutcome> {
    assertNoAudioBytes(batch, "$publish");
    const headers: Record<string, string> = {};
    if (this.opts.publishToken) headers["Authorization"] = this.opts.publishToken;
    const body = await this.post("/publish", batch, headers);
    return body as GlobalPublishOutcome;
  }

  async queryMapViewport(
    query: MapViewportQuery,
  ): Promise<GlobalMapViewportResult> {
    const params = new URLSearchParams({
      mapVersion: query.mapVersion,
      xMin: String(query.xMin),
      xMax: String(query.xMax),
      yMin: String(query.yMin),
      yMax: String(query.yMax),
    });
    if (query.zoom !== undefined) params.set("zoom", String(query.zoom));
    if (query.primaryClass !== undefined)
      params.set("primaryClass", query.primaryClass);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const body = await this.request(`/map?${params.toString()}`, undefined, {});
    return body as GlobalMapViewportResult;
  }

  private async post(
    path: string,
    payload: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    return this.request(
      path,
      JSON.stringify(payload) as BodyInit,
      {
        "Content-Type": "application/json",
        ...extraHeaders,
      },
    );
  }

  private async request(
    path: string,
    body: BodyInit | undefined,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(`${this.opts.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(this.opts.origin ? { Origin: this.opts.origin } : {}),
        ...headers,
      },
      body,
    });

    if (!response.ok) {
      let error: GlobalIndexError = { kind: "temporary-unavailable" };
      try {
        const parsed = (await response.json()) as GlobalIndexError;
        if (parsed && typeof parsed === "object" && "kind" in parsed) {
          error = parsed as GlobalIndexError;
        }
      } catch {
        // fall through to the default error
      }
      throw error;
    }

    const json = (await response.json()) as unknown;
    assertNoAudioBytes(json, `$response${path}`);
    return json;
  }
}
