import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import type { SampleMeta } from "@audiotool/nexus/api";
import type { SampleListPage, PageFetcher } from "./libraryScanner";
import {
  discoverPublicSamples,
  publishPublicAnalyses,
  isPublicListable,
  DISCOVERY_META_KEY,
  PUBLIC_DISCOVERY_PAGE_BUDGET,
  PUBLIC_DISCOVERY_SAMPLE_BUDGET,
} from "./publicDiscovery";
import { makeSampleMeta } from "./test-helpers";
import { openTestDatabase, makeSample, withPublishFields } from "../persistence/test-helpers";
import type { DatabaseHandle } from "../persistence/db";
import { IndexStore } from "../persistence/indexStore";
import { QueueStore } from "../persistence/queueStore";
import { mapVersion } from "../map/mapPosition";
import { GlobalPublishQueue } from "../global/publishQueue";
import type {
  GlobalSampleIndex,
  GlobalPublishResult,
  GlobalPublishOutcome,
} from "../global/contract";
import type { SampleIndexRecord } from "../persistence/indexStore";

// ─────────────────────────────────────────────────────────────────────────────
// STEP80 — Public Audiotool sample discovery.
//
// Exercises the REAL architecture: fake-indexeddb-backed IndexStore/QueueStore,
// a fake PageFetcher implementing the real `PageFetcher` contract (the same one
// the own-library scan uses), and the real GlobalPublishQueue with a fake
// provider implementing the real `GlobalSampleIndex` contract. No parallel
// abstractions.
//
// Covers: multi-page pagination, page budget, sample budget, visibility gate,
// known-id dedup, no re-analysis of analyzed samples, repeat-round idempotency,
// nextPageToken threading, cursor contents (discovery metadata ONLY) and the
// no-audio-persistence invariant.
// ─────────────────────────────────────────────────────────────────────────────

const BUILD = "build-step80-test";

interface Rig {
  index: IndexStore;
  queue: QueueStore;
  db: DatabaseHandle["db"];
  close: () => void;
}

async function freshRig(): Promise<Rig> {
  const handle = await openTestDatabase();
  return {
    index: new IndexStore(handle.db),
    queue: new QueueStore(handle.db),
    db: handle.db,
    close: () => handle.db.close(),
  };
}

/** Build a fake fetcher serving fixed pages; records every call it receives. */
function fakeFetcher(pages: Record<string, SampleListPage>) {
  const calls: Array<{ pageSize?: number; pageToken?: string }> = [];
  const fetchPage: PageFetcher = async (opts) => {
    calls.push(opts);
    const key = opts.pageToken ?? "";
    const page = pages[key];
    if (!page) throw new Error(`unexpected pageToken ${JSON.stringify(key)}`);
    return page;
  };
  return { fetchPage, calls };
}

function page(samples: SampleMeta[], nextPageToken?: string): SampleListPage {
  return { samples, nextPageToken };
}

/** A fully publishable analyzed record (existing project test-helpers only). */
function analyzedRecord(sampleId: string): SampleIndexRecord {
  return withPublishFields(makeSample(sampleId, { analysisBuild: BUILD }));
}

class FakeProvider implements GlobalSampleIndex {
  public publishCalls: GlobalPublishResult[][] = [];
  async lookupSamples() { return []; }
  async lookupContentIdentities() { return []; }
  async queryMapViewport() { return { mapVersion, points: [] }; }
  async publishAnalysisResults(batch: GlobalPublishResult[]): Promise<GlobalPublishOutcome> {
    this.publishCalls.push([...batch]);
    return {
      items: batch.map(() => ({ status: "stored" as const })),
      accepted: true,
    };
  }
}

describe("STEP80 public discovery — discoverPublicSamples", () => {
  it("1+8: paginates over several pages and threads nextPageToken correctly", async () => {
    const rig = await freshRig();
    try {
      const a = makeSampleMeta("samples/aaaa");
      const b = makeSampleMeta("samples/bbbb");
      const c = makeSampleMeta("samples/cccc");
      const d = makeSampleMeta("samples/dddd");
      const { fetchPage, calls } = fakeFetcher({
        "": page([a, b], "tok-2"),
        "tok-2": page([c, d], "tok-3"),
        "tok-3": page([]),
      });

      const res = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
        { pageSize: 2 },
      );

      // token threading: first call without token, then exactly the tokens
      // handed out by the previous page.
      expect(calls.map((c) => c.pageToken)).toEqual([undefined, "tok-2", "tok-3"]);
      expect(calls.every((c) => c.pageSize === 2)).toBe(true);
      expect(res.pagesFetched).toBe(3);
      expect(res.seenCount).toBe(4);
      expect(res.newlyEnqueued).toBe(4);
      expect(res.stoppedReason).toBe("exhausted");
      // all four entered the EXISTING queue as due jobs
      for (const m of [a, b, c, d]) {
        const job = await rig.queue.get(m.name);
        expect(job?.status).toBe("queued");
        expect(job?.analysisBuild).toBe(BUILD);
      }
      // exhausted listing → next round starts again at the first page
      expect(res.cursor.lastPageToken).toBe("");
    } finally {
      rig.close();
    }
  });

  it("2: stops at PUBLIC_DISCOVERY_PAGE_BUDGET and resumes where it stopped", async () => {
    const rig = await freshRig();
    try {
      // More pages than the budget can ever fetch in one round.
      const mk = (i: number) => makeSampleMeta(`samples/p${i}`);
      const pages: Record<string, SampleListPage> = {};
      let token = "";
      for (let p = 0; p < PUBLIC_DISCOVERY_PAGE_BUDGET + 3; p++) {
        const next = `tok-${p + 1}`;
        pages[token] = page([mk(p)], p === 0 ? undefined : next);
        // deterministic chain: ""→tok-0? simpler: explicit below
        token = next;
      }
      // rebuild chain cleanly: page i is addressed by tok-(i-1) (page 0 by "")
      const chained: Record<string, SampleListPage> = {};
      for (let p = 0; p < PUBLIC_DISCOVERY_PAGE_BUDGET + 3; p++) {
        const key = p === 0 ? "" : `tok-${p - 1}`;
        chained[key] = page([mk(p)], `tok-${p}`);
      }
      const { fetchPage, calls } = fakeFetcher(chained);

      const res = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
      );

      expect(res.pagesFetched).toBe(PUBLIC_DISCOVERY_PAGE_BUDGET);
      expect(res.stoppedReason).toBe("budget");
      expect(calls.length).toBe(PUBLIC_DISCOVERY_PAGE_BUDGET);
      // resume state: the NEXT token that was NOT yet fetched
      expect(res.cursor.lastPageToken).toBe(`tok-${PUBLIC_DISCOVERY_PAGE_BUDGET - 1}`);

      // second round resumes exactly there — the very first call of round 2
      // must use the persisted token.
      const res2 = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
        { maxPages: 1 },
      );
      expect(res2.cursor.rounds).toBe(2);
      const round2FirstToken = calls[PUBLIC_DISCOVERY_PAGE_BUDGET]?.pageToken;
      expect(round2FirstToken).toBe(`tok-${PUBLIC_DISCOVERY_PAGE_BUDGET - 1}`);
    } finally {
      rig.close();
    }
  });

  it("3: stops at PUBLIC_DISCOVERY_SAMPLE_BUDGET", async () => {
    const rig = await freshRig();
    try {
      const many = Array.from({ length: PUBLIC_DISCOVERY_SAMPLE_BUDGET + 10 }, (_, i) =>
        makeSampleMeta(`samples/s${i}`),
      );
      const { fetchPage } = fakeFetcher({
        "": page(many.slice(0, 100), "t2"),
        t2: page(many.slice(100, 200), "t3"),
        t3: page(many.slice(200, 300), "t4"),
      });

      const res = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
        { maxPages: 100 }, // only the SAMPLE budget may stop this round
      );

      expect(res.seenCount).toBeLessThanOrEqual(PUBLIC_DISCOVERY_SAMPLE_BUDGET);
      expect(res.stoppedReason).toBe("budget");
      expect(res.newlyEnqueued).toBe(PUBLIC_DISCOVERY_SAMPLE_BUDGET);
    } finally {
      rig.close();
    }
  });

  it("4: only visibility === 'public' entries are enqueued", async () => {
    const rig = await freshRig();
    try {
      const pub = makeSampleMeta("samples/pub");
      const unlisted = makeSampleMeta("samples/unl", { visibility: "unlisted" });
      // The listing type only models public/unlisted — a hypothetical unknown
      // visibility value must be rejected by the gate just like "unlisted".
      const unknownVis = makeSampleMeta("samples/priv", {
        visibility: "unlisted",
      }) as SampleMeta;
      (unknownVis as { visibility: string }).visibility = "private";
      const { fetchPage } = fakeFetcher({
        "": page([pub, unlisted, unknownVis]),
      });

      const res = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
      );

      expect(res.publicCount).toBe(1);
      expect(res.skippedNonPublic).toBe(2);
      expect(res.newlyEnqueued).toBe(1);
      expect(await rig.queue.get(pub.name)).toBeDefined();
      expect(await rig.queue.get(unlisted.name)).toBeUndefined();
      expect(await rig.queue.get(unknownVis.name)).toBeUndefined();
    } finally {
      rig.close();
    }
  });

  it("isPublicListable gates on the exact 'public' value", () => {
    expect(isPublicListable({ visibility: "public" })).toBe(true);
    expect(isPublicListable({ visibility: "unlisted" })).toBe(false);
    // unknown/future visibility values are rejected too (gate is === "public")
    expect(isPublicListable({ visibility: "private" as never })).toBe(false);
  });

  it("5: an already-known sample id creates NO new queue entry", async () => {
    const rig = await freshRig();
    try {
      const known = makeSampleMeta("samples/known");
      // Known via the local INDEX (analyzed record), not via the queue.
      await rig.index.put(analyzedRecord(known.name));
      const fresh = makeSampleMeta("samples/fresh");
      const { fetchPage } = fakeFetcher({ "": page([known, fresh]) });

      const res = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
      );

      expect(res.alreadyKnown).toBe(1);
      expect(res.newlyEnqueued).toBe(1);
      // The known record is untouched: still analyzed, no new job row created.
      expect((await rig.index.get(known.name))?.status).toBe("analyzed");
      expect(await rig.queue.get(known.name)).toBeUndefined();
    } finally {
      rig.close();
    }
  });

  it("6: an already-analyzed sample is not queued again (no re-analysis)", async () => {
    const rig = await freshRig();
    try {
      const done = makeSampleMeta("samples/done");
      // Simulate the existing pipeline having finished this sample: analyzed
      // job row (same build) + analyzed index record.
      await rig.queue.enqueue(done.name, BUILD);
      const finishedJob = await rig.queue.get(done.name);
      if (finishedJob) {
        await rig.queue.markAnalyzed(finishedJob);
      }
      await rig.index.put(analyzedRecord(done.name));
      const before = await rig.queue.get(done.name);

      const { fetchPage } = fakeFetcher({ "": page([done]) });
      const res = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
      );

      expect(res.newlyEnqueued).toBe(0);
      expect(res.alreadyKnown).toBe(1);
      const after = await rig.queue.get(done.name);
      expect(after?.status).toBe(before?.status); // still "analyzed", not re-queued
    } finally {
      rig.close();
    }
  });

  it("7: repeated discovery rounds produce no duplicates", async () => {
    const rig = await freshRig();
    try {
      const a = makeSampleMeta("samples/r1");
      const b = makeSampleMeta("samples/r2");
      const { fetchPage } = fakeFetcher({ "": page([a, b]) });

      const r1 = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
      );
      const r2 = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
      );

      expect(r1.newlyEnqueued).toBe(2);
      expect(r2.newlyEnqueued).toBe(0);
      expect(r2.alreadyKnown).toBe(2);
      expect(r2.cursor.rounds).toBe(2);
      // queue holds exactly two job rows — one per sample id, no duplicates
      const jobs = await rig.queue.all();
      expect(jobs.length).toBe(2);
      expect(await rig.queue.get(a.name)).toBeDefined();
      expect(await rig.queue.get(b.name)).toBeDefined();
      expect(await rig.queue.countByStatus("queued")).toBe(2);
    } finally {
      rig.close();
    }
  });

  it("9: the persisted cursor contains ONLY discovery bookkeeping", async () => {
    const rig = await freshRig();
    try {
      const a = makeSampleMeta("samples/cursor");
      const { fetchPage } = fakeFetcher({ "": page([a]) });
      await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
        { now: () => "2026-09-28T00:00:00.000Z" },
      );

      const raw = await rig.db.get<Record<string, unknown>>("meta", DISCOVERY_META_KEY);
      expect(raw).toBeDefined();
      expect(Object.keys(raw!).sort()).toEqual(
        ["cursorVersion", "kind", "lastPageToken", "lastRoundAt", "rounds"],
      );
      expect(raw!.kind).toBe("public-discovery");
      // no sample ids, no metadata values, no audio anywhere in the record
      const json = JSON.stringify(raw);
      expect(json).not.toContain(a.name);
      expect(json).not.toContain("wavUrl");
      expect(json).not.toContain("mp3");
    } finally {
      rig.close();
    }
  });

  it("10: discovery persists no audio bytes (index/jobs/meta stay audio-free)", async () => {
    const rig = await freshRig();
    try {
      const a = makeSampleMeta("samples/noaudio");
      const { fetchPage } = fakeFetcher({ "": page([a]) });
      await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
      );
      // Job rows are metadata-only by store construction; assert the stores
      // hold no Blob/ArrayBuffer/typed-array values reachable from the job.
      const job = await rig.queue.get(a.name);
      expect(job).toBeDefined();
      expect(JSON.stringify(job)).not.toMatch(/ArrayBuffer|Blob|"data"/);
      // ...and a publish pass over a hand-written analyzed record keeps the
      // no-audio guarantee enforced by createPublishCandidate/assertNoAudioBytes.
      // Real production flow: enqueue() only writes to the local queue; the
      // provider is called by the existing flush path (flushPendingPublications
      // → queue.flush()), so run the flush before inspecting provider calls.
      await rig.index.put(analyzedRecord(a.name));
      const provider = new FakeProvider();
      const pq = new GlobalPublishQueue(provider, {});
      const pass = await publishPublicAnalyses({ index: rig.index, publishQueue: pq });
      expect(pass.enqueued).toBe(1);
      await pq.flush();
      expect(provider.publishCalls[0]?.[0]).toBeDefined();
      expect(JSON.stringify(provider.publishCalls[0])).not.toMatch(/audioBytes|ArrayBuffer/);
    } finally {
      rig.close();
    }
  });
});

describe("STEP80 public discovery — publishPublicAnalyses (existing publish path only)", () => {
  it("feeds analyzed public records through createPublishCandidate → GlobalPublishQueue once", async () => {
    const rig = await freshRig();
    try {
      const idA = "samples/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const idB = "samples/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      await rig.index.put(analyzedRecord(idA));
      await rig.index.put({
        ...analyzedRecord(idB),
        contentHash: "e".repeat(64),
        // B was usage-accepted earlier with its own timestamp + pending marker.
        globalPublish: { usageAcceptedAt: "2026-02-02T00:00:00.000Z", delivery: "pending" },
      });
      const provider = new FakeProvider();
      const pq = new GlobalPublishQueue(provider, {});

      const r1 = await publishPublicAnalyses({
        index: rig.index,
        publishQueue: pq,
        now: () => "2026-09-28T12:00:00.000Z",
      });
      expect(r1.candidatesSeen).toBe(2);
      expect(r1.enqueued).toBe(2);
      expect(r1.duplicates).toBe(0);
      expect(r1.marked).toBe(1); // only the UNMARKED record gets a marker

      // A got the fresh pending marker; B's original acceptance time survives.
      expect((await rig.index.get(idA))?.globalPublish).toEqual({
        usageAcceptedAt: "2026-09-28T12:00:00.000Z",
        delivery: "pending",
      });
      expect((await rig.index.get(idB))?.globalPublish?.usageAcceptedAt).toBe(
        "2026-02-02T00:00:00.000Z",
      );

      // Repeat pass: queue-level dedup rejects both as duplicates, nothing is
      // re-marked, and the queue still holds exactly two items.
      const r2 = await publishPublicAnalyses({ index: rig.index, publishQueue: pq });
      expect(r2.enqueued).toBe(0);
      expect(r2.duplicates).toBe(2);
      expect(r2.marked).toBe(0);
      expect(pq.snapshot().length).toBe(2);
    } finally {
      rig.close();
    }
  });

  it("Missing-V2 records are honestly skipped, never published", async () => {
    const rig = await freshRig();
    try {
      const id = "samples/cccccccc-cccc-cccc-cccc-cccccccccccc";
      const rec = analyzedRecord(id);
      delete (rec as { mapPosition?: unknown }).mapPosition;
      await rig.index.put(rec);
      const provider = new FakeProvider();
      const pq = new GlobalPublishQueue(provider, {});

      const r = await publishPublicAnalyses({ index: rig.index, publishQueue: pq });
      expect(r.candidatesSeen).toBe(1);
      expect(r.enqueued).toBe(0);
      expect(r.skippedNotPublishable).toBe(1);
      expect(pq.snapshot().length).toBe(0);
      expect((await rig.index.get(id))?.globalPublish).toBeUndefined();
    } finally {
      rig.close();
    }
  });
});
