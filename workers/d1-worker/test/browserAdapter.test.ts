/**
 * Step 16F — browser adapter unit tests over a mocked `fetch`.
 *
 * Verifies the `CloudflareGlobalAdapter` maps contract calls to Worker HTTP
 * routes and responses WITHOUT any real network. Includes the no-audio guard
 * on responses and error mapping for non-2xx Worker responses. This keeps
 * src/global/* untouched (the adapter only consumes the contract types).
 */
import { describe, it, expect, vi } from "vitest";
import { CloudflareGlobalAdapter } from "../src/browserAdapter";
import { makeValidPublish } from "./fixtures";

function mockAdapter(
  handler: (url: string, init?: RequestInit) => Response,
  opts: { publishToken?: string } = {},
) {
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  ) as unknown as typeof fetch;
  return new CloudflareGlobalAdapter({
    baseUrl: "https://samplemap-global.test",
    origin: "http://localhost:5176",
    fetchImpl,
    publishToken: opts.publishToken,
  });
}

describe("CloudflareGlobalAdapter", () => {
  it("lookupSamples posts to /samples/lookup and returns hits", async () => {
    const expected = [
      { status: "unknown", sampleId: "samples/aaa" },
      { status: "known", sampleId: "samples/bbb", contentIdentity: {}, analysis: {} },
    ];
    let called = "";
    let body: unknown = null;
    const adapter = mockAdapter((url, init) => {
      called = url;
      body = init?.body;
      return new Response(JSON.stringify(expected), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const hits = await adapter.lookupSamples(["samples/aaa", "samples/bbb"]);
    expect(called).toBe("https://samplemap-global.test/samples/lookup");
    expect(body).toBe(JSON.stringify(["samples/aaa", "samples/bbb"]));
    expect(hits).toEqual(expected);
  });

  it("lookupContentIdentities posts (hash,version) pairs to /content/lookup", async () => {
    let body: unknown = null;
    const adapter = mockAdapter((_url, init) => {
      body = init?.body;
      return new Response("[]", { status: 200 });
    });
    const hits = await adapter.lookupContentIdentities([
      { contentHash: "a".repeat(64), contentHashVersion: "pcm-v1" },
    ]);
    expect(hits).toEqual([]);
    expect(body).toBe(
      JSON.stringify([
        { contentHash: "a".repeat(64), contentHashVersion: "pcm-v1" },
      ]),
    );
  });

  it("publishAnalysisResults posts the batch and reflects the outcome", async () => {
    let body: unknown = null;
    let auth: string | null = null;
    const adapter = mockAdapter(
      (_url, init) => {
        body = init?.body;
        auth = (init?.headers as Record<string, string>)?.Authorization ?? null;
        return new Response(
          JSON.stringify({ items: [{ status: "stored" }], accepted: true }),
          { status: 200 },
        );
      },
      { publishToken: "secret-token" },
    );
    const item = makeValidPublish({ sampleId: "samples/aaa" });
    const outcome = await adapter.publishAnalysisResults([item]);
    expect(outcome).toEqual({ items: [{ status: "stored" }], accepted: true });
    expect(auth).toBe("secret-token");
    expect(body).toBe(JSON.stringify([item]));
  });

  it("throws a GlobalIndexError on a non-2xx Worker response", async () => {
    const adapter = mockAdapter(() =>
      new Response(JSON.stringify({ kind: "conflict", detail: "x" }), {
        status: 409,
      }),
    );
    await expect(
      adapter.publishAnalysisResults([makeValidPublish()]),
    ).rejects.toMatchObject({ kind: "conflict" });
  });

  it("queryMapViewport issues a GET with the right query params", async () => {
    let url = "";
    const adapter = mockAdapter((u) => {
      url = u;
      return new Response(
        JSON.stringify({ mapVersion: "map-v2", points: [] }),
        { status: 200 },
      );
    });
    const result = await adapter.queryMapViewport({
      mapVersion: "map-v2",
      xMin: -1,
      xMax: 1,
      yMin: -2,
      yMax: 2,
      primaryClass: "kick",
      limit: 50,
    });
    expect(result.points).toEqual([]);
    expect(url).toContain("/map?");
    expect(url).toContain("mapVersion=map-v2");
    expect(url).toContain("xMin=-1");
    expect(url).toContain("primaryClass=kick");
    expect(url).toContain("limit=50");
  });

  it("rejects (throws) if a response carries real audio byte containers", async () => {
    // Over HTTP/JSON audio bytes cannot survive, but the adapter keeps a
    // defensive no-audio guard on parsed responses. Feed it a fake response
    // whose json() returns a literal ArrayBuffer to prove the guard runs.
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        async json() {
          return [
            { status: "known", sampleId: "s", contentIdentity: {}, analysis: { b: new ArrayBuffer(4) } },
          ];
        },
      } as unknown as Response),
    ) as unknown as typeof fetch;
    const adapter = new CloudflareGlobalAdapter({
      baseUrl: "https://samplemap-global.test",
      fetchImpl,
    });
    await expect(adapter.lookupSamples(["s"])).rejects.toThrow(
      /audio byte container prohibited/i,
    );
  });
});
