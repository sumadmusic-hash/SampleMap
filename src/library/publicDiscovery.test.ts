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
  PUBLIC_DISCOVERY_LANES,
  PUBLIC_DISCOVERY_PAGE_SIZE,
  DISCOVERY_CURSOR_VERSION,
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

/**
 * Build a fake fetcher serving fixed pages; records every call it receives.
 *
 * STEP81: `perLane` selects a different listing per server-side `orderBy`, so a
 * test can serve a favorites-ordered and a usages-ordered listing. Without it
 * both lanes see the same listing.
 */
function fakeFetcher(pages: Record<string, SampleListPage>, perLane?: Record<string, Record<string, SampleListPage>>) {
  const calls: Array<{ pageSize?: number; pageToken?: string; orderBy?: string }> = [];
  const fetchPage: PageFetcher = async (opts) => {
    calls.push(opts);
    const key = opts.pageToken ?? "";
    const listing = perLane?.[opts.orderBy ?? ""] ?? pages;
    const page = listing[key];
    if (!page) {
      throw new Error(
        `unexpected pageToken ${JSON.stringify(key)} for orderBy ${JSON.stringify(opts.orderBy)}`,
      );
    }
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
        { pageSize: 2, maxPages: 6 },
      );

      // token threading, per lane: each lane walks the whole 3-page chain
      // (unlimited token, then the tokens handed out by the previous page).
      expect(calls.map((c) => c.pageToken)).toEqual([
        undefined,
        "tok-2",
        "tok-3",
        undefined,
        "tok-2",
        "tok-3",
      ]);
      expect(calls.every((c) => c.pageSize === 2)).toBe(true);
      expect(res.pagesFetched).toBe(6);
      // Each lane saw all 4 listing entries; the second lane enqueued nothing
      // new because the existing dedup found the jobs of the first lane.
      expect(res.seenCount).toBe(8);
      expect(res.newlyEnqueued).toBe(4);
      expect(res.alreadyKnown).toBe(4);
      expect(res.stoppedReason).toBe("exhausted");
      // all four entered the EXISTING queue as due jobs
      for (const m of [a, b, c, d]) {
        const job = await rig.queue.get(m.name);
        expect(job?.status).toBe("queued");
        expect(job?.analysisBuild).toBe(BUILD);
      }
      // exhausted listing → both lanes restart at the first page next round
      expect(res.cursor.laneTokens).toEqual({ favorites: "", usages: "" });
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

      // STEP81: the page budget is split evenly across the two popularity lanes.
      const laneMaxPages = Math.floor(PUBLIC_DISCOVERY_PAGE_BUDGET / 2);
      expect(laneMaxPages).toBe(PUBLIC_DISCOVERY_LANES.length > 0 ? 2 : 0);
      expect(res.pagesFetched).toBe(laneMaxPages * PUBLIC_DISCOVERY_LANES.length);
      expect(res.stoppedReason).toBe("budget");
      expect(calls.length).toBe(laneMaxPages * PUBLIC_DISCOVERY_LANES.length);
      // resume state PER LANE: the NEXT token that was NOT yet fetched
      const expectedToken = `tok-${laneMaxPages - 1}`;
      expect(res.cursor.laneTokens).toEqual({
        favorites: expectedToken,
        usages: expectedToken,
      });

      // second round resumes exactly there — the very first call of round 2
      // must use the persisted token.
      const callsAfterRound1 = calls.length;
      const res2 = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
        { maxPages: 1 },
      );
      expect(res2.cursor.rounds).toBe(2);
      const round2FirstToken = calls[callsAfterRound1]?.pageToken;
      expect(round2FirstToken).toBe(expectedToken);
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
      // Both lanes spend the SAMPLE budget on the same listing, so the second
      // lane's entries are deduplicated against the first lane's job rows.
      expect(res.newlyEnqueued).toBe(PUBLIC_DISCOVERY_SAMPLE_BUDGET / 2);
      expect(res.lanes.every((l) => l.stoppedReason === "budget")).toBe(true);
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

      // STEP81: the same listing is walked by every lane, so the GATE counters
      // are per lane (2 lanes), while the enqueue counter stays 1 because the
      // second lane deduplicates the job row the first lane created.
      expect(res.publicCount).toBe(PUBLIC_DISCOVERY_LANES.length);
      expect(res.skippedNonPublic).toBe(2 * PUBLIC_DISCOVERY_LANES.length);
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

      // `known` is skipped once per lane; `fresh` is enqueued by the first lane
      // and then deduped as a known job row in the second.
      expect(res.alreadyKnown).toBe(1 + PUBLIC_DISCOVERY_LANES.length);
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
      // seen once per lane, never re-enqueued
      expect(res.alreadyKnown).toBe(PUBLIC_DISCOVERY_LANES.length);
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
      expect(r2.alreadyKnown).toBe(2 * PUBLIC_DISCOVERY_LANES.length);
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
        ["cursorVersion", "kind", "laneTokens", "lastRoundAt", "rounds"],
      );
      expect(raw!.kind).toBe("public-discovery");
      expect(raw!.cursorVersion).toBe(DISCOVERY_CURSOR_VERSION);
      // only the lane keys are stored — no order strings, no sample ids, no
      // metadata values, no audio anywhere in the record
      expect(Object.keys(raw!.laneTokens as object).sort()).toEqual(
        PUBLIC_DISCOVERY_LANES.map((l) => l.key).sort(),
      );
      const json = JSON.stringify(raw);
      expect(json).not.toContain(a.name);
      expect(json).not.toContain("num_favorites");
      expect(json).not.toContain("num_usages");
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

// ─────────────────────────────────────────────────────────────────────────────
// STEP81 — Popularity-aware public discovery.
//
// The two documented objective signals are requested as TWO independent
// server-side orders. These tests pin: the exact `orderBy` strings sent, that
// each lane really receives ITS ordering, that no invented score is ever
// computed locally, that the two lanes deduplicate against each other through
// the existing QueueStore path, that each lane resumes at its OWN token, that
// only public samples ever enter, that a stale cursor version is discarded
// deterministically, and that the queue/analysis behaviour is untouched.
// ─────────────────────────────────────────────────────────────────────────────

const FAVORITES_ORDER = "sample.num_favorites desc";
const USAGES_ORDER = "sample.num_usages desc";

/**
 * A QueueStore whose clock ticks on every read, so each enqueued job gets a
 * distinct `createdAt`. The real QueueStore orders due jobs by
 * `priorityGroup`, then `createdAt` — with a frozen clock every job in one
 * millisecond ties and the order is not observable. With a ticking clock the
 * observed `nextDue` order is exactly the ENQUEUE order, i.e. exactly the
 * server-side popularity order discovery forwarded.
 */
function monotonicQueue(db: DatabaseHandle["db"]): QueueStore {
  let tick = 0;
  return new QueueStore(db, { now: () => ++tick });
}

describe("STEP81 popularity-aware public discovery", () => {
  it("declares exactly two lanes, each a single-field server-side order", () => {
    // NO invented formula: the lanes are pure pass-through `orderBy` strings.
    // There is no combined sort, no weighting, no normalization, no score.
    expect(PUBLIC_DISCOVERY_LANES).toEqual([
      { key: "favorites", orderBy: FAVORITES_ORDER },
      { key: "usages", orderBy: USAGES_ORDER },
    ]);
    for (const lane of PUBLIC_DISCOVERY_LANES) {
      // single field + direction only — no comma, no second field
      expect(lane.orderBy).toMatch(/^sample\.num_(favorites|usages) desc$/);
      expect(lane.orderBy).not.toContain(",");
    }
  });

  it("sends the favorites order and the usages order, one page walk each", async () => {
    const rig = await freshRig();
    try {
      const fav = makeSampleMeta("samples/fav", { numFavorites: 900, numUsages: 1 });
      const use = makeSampleMeta("samples/use", { numFavorites: 2, numUsages: 800 });
      // Each lane serves its own, differently ordered listing.
      const { fetchPage, calls } = fakeFetcher(
        { "": page([fav]) },
        {
          [FAVORITES_ORDER]: { "": page([fav], "fav-2") },
          [USAGES_ORDER]: { "": page([use], "use-2") },
        },
      );

      const res = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
        { maxPages: 1 },
      );

      // Exactly one fetch per lane, each carrying ITS order and no token.
      expect(calls).toEqual([
        {
          pageSize: PUBLIC_DISCOVERY_PAGE_SIZE,
          pageToken: undefined,
          orderBy: FAVORITES_ORDER,
        },
        {
          pageSize: PUBLIC_DISCOVERY_PAGE_SIZE,
          pageToken: undefined,
          orderBy: USAGES_ORDER,
        },
      ]);

      // Lane-by-lane breakdown in the fixed lane order.
      expect(res.lanes).toEqual([
        {
          lane: "favorites",
          orderBy: FAVORITES_ORDER,
          seenCount: 1,
          publicCount: 1,
          newlyEnqueued: 1,
          pagesFetched: 1,
          stoppedReason: "budget",
          nextPageToken: "fav-2",
        },
        {
          lane: "usages",
          orderBy: USAGES_ORDER,
          seenCount: 1,
          publicCount: 1,
          newlyEnqueued: 1,
          pagesFetched: 1,
          stoppedReason: "budget",
          nextPageToken: "use-2",
        },
      ]);

      // Both popularity signals reached the EXISTING queue.
      expect(await rig.queue.get(fav.name)).toBeDefined();
      expect(await rig.queue.get(use.name)).toBeDefined();
    } finally {
      rig.close();
    }
  });

  it("enqueues the most-favorited samples of the favorites lane first", async () => {
    const rig = await freshRig();
    try {
      // The server returns the lane in popularity order; discovery must forward
      // that order into the queue untouched (it never re-sorts locally).
      const top = makeSampleMeta("samples/fav-top", { numFavorites: 5000 });
      const mid = makeSampleMeta("samples/fav-mid", { numFavorites: 800 });
      const low = makeSampleMeta("samples/fav-low", { numFavorites: 3 });
      const favoritesPage = page([top, mid, low]);
      const { fetchPage, calls } = fakeFetcher(
        { "": favoritesPage },
        { [FAVORITES_ORDER]: { "": favoritesPage } },
      );
      const queue = monotonicQueue(rig.db);

      await discoverPublicSamples(
        { fetchPage, index: rig.index, queue, db: rig.db },
        BUILD,
        { maxPages: 1 },
      );

      // Only the favorites lane is exercised here; the usages lane saw the same
      // (deduplicated) listing and enqueued nothing.
      expect(calls.map((c) => c.orderBy)).toEqual([FAVORITES_ORDER, USAGES_ORDER]);
      // Queue insertion order is the server-side popularity order, verbatim.
      const due = await queue.nextDue(3);
      expect(due.map((j) => j.sampleId)).toEqual([top.name, mid.name, low.name]);
      // No priority group was invented: the ordering comes from enqueue order.
      expect(due.every((j) => j.priorityGroup === undefined)).toBe(true);
    } finally {
      rig.close();
    }
  });

  it("enqueues the most-used samples of the usages lane first", async () => {
    const rig = await freshRig();
    try {
      const top = makeSampleMeta("samples/use-top", { numUsages: 9000 });
      const mid = makeSampleMeta("samples/use-mid", { numUsages: 1200 });
      const low = makeSampleMeta("samples/use-low", { numUsages: 1 });
      const usagesPage = page([top, mid, low]);
      const { fetchPage, calls } = fakeFetcher(
        { "": usagesPage },
        { [USAGES_ORDER]: { "": usagesPage } },
      );
      const queue = monotonicQueue(rig.db);

      await discoverPublicSamples(
        { fetchPage, index: rig.index, queue, db: rig.db },
        BUILD,
        { maxPages: 1 },
      );

      expect(calls.map((c) => c.orderBy)).toEqual([FAVORITES_ORDER, USAGES_ORDER]);
      const due = await queue.nextDue(3);
      expect(due.map((j) => j.sampleId)).toEqual([top.name, mid.name, low.name]);
      expect(due.every((j) => j.priorityGroup === undefined)).toBe(true);
    } finally {
      rig.close();
    }
  });

  it("DEDUPLICATES across the two lanes: a sample found by both is enqueued once", async () => {
    const rig = await freshRig();
    try {
      // `both` is highly favorited AND highly used → it appears in BOTH lanes.
      const both = makeSampleMeta("samples/both", { numFavorites: 999, numUsages: 999 });
      const onlyFav = makeSampleMeta("samples/only-fav", { numFavorites: 500, numUsages: 0 });
      const onlyUse = makeSampleMeta("samples/only-use", { numFavorites: 0, numUsages: 500 });
      const { fetchPage } = fakeFetcher(
        { "": page([both, onlyFav, onlyUse]) },
        {
          [FAVORITES_ORDER]: { "": page([both, onlyFav]) },
          [USAGES_ORDER]: { "": page([both, onlyUse]) },
        },
      );

      const res = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
      );

      // `both` is SEEN twice (once per lane) but enqueued exactly ONCE.
      expect(res.lanes[0].newlyEnqueued).toBe(2); // both, onlyFav
      expect(res.lanes[1].newlyEnqueued).toBe(1); // onlyUse (both deduped)
      expect(res.newlyEnqueued).toBe(3);
      expect(res.alreadyKnown).toBe(1);
      // ...and there is exactly ONE job row per sample id.
      expect((await rig.queue.all()).map((j) => j.sampleId).sort()).toEqual(
        [both.name, onlyFav.name, onlyUse.name].sort(),
      );
    } finally {
      rig.close();
    }
  });

  it("resumes EACH lane at its own token across rounds", async () => {
    const rig = await freshRig();
    try {
      const a1 = makeSampleMeta("samples/fav-a1");
      const a2 = makeSampleMeta("samples/fav-a2");
      const b1 = makeSampleMeta("samples/use-b1");
      const b2 = makeSampleMeta("samples/use-b2");
      const { fetchPage, calls } = fakeFetcher(
        { "": page([a1]) },
        {
          [FAVORITES_ORDER]: {
            "": page([a1], "fav-2"),
            "fav-2": page([a2], "fav-3"),
            "fav-3": page([]),
          },
          [USAGES_ORDER]: {
            "": page([b1], "use-2"),
            "use-2": page([b2], "use-3"),
            "use-3": page([]),
          },
        },
      );
      const deps = { fetchPage, index: rig.index, queue: rig.queue, db: rig.db };

      const r1 = await discoverPublicSamples(deps, BUILD, { maxPages: 1 });
      expect(r1.stoppedReason).toBe("budget");
      expect(r1.cursor.laneTokens).toEqual({ favorites: "fav-2", usages: "use-2" });
      expect(calls.map((c) => c.pageToken)).toEqual([undefined, undefined]);

      // Round 2: BOTH lanes resume at their OWN persisted token, and the
      // favorites token is never handed to the usages lane.
      const r2 = await discoverPublicSamples(deps, BUILD, { maxPages: 1 });
      expect(r2.cursor.rounds).toBe(2);
      expect(calls.slice(2).map((c) => c.orderBy)).toEqual([FAVORITES_ORDER, USAGES_ORDER]);
      expect(calls.slice(2).map((c) => c.pageToken)).toEqual(["fav-2", "use-2"]);
      expect(r2.cursor.laneTokens).toEqual({ favorites: "fav-3", usages: "use-3" });
      // Round 2 continued both listings: the second page of each lane.
      expect(r2.lanes.map((l) => l.newlyEnqueued)).toEqual([1, 1]);
      expect(await rig.queue.get(a2.name)).toBeDefined();
      expect(await rig.queue.get(b2.name)).toBeDefined();

      // Round 3 exhausts both lanes → both tokens reset to "".
      const r3 = await discoverPublicSamples(deps, BUILD, { maxPages: 10 });
      expect(r3.stoppedReason).toBe("exhausted");
      expect(r3.cursor.laneTokens).toEqual({ favorites: "", usages: "" });
      // No re-enqueue of anything already known.
      expect(r3.newlyEnqueued).toBe(0);
    } finally {
      rig.close();
    }
  });

  it("discards a stale cursor version deterministically (v1 → v2 migration)", async () => {
    const rig = await freshRig();
    try {
      // A STEP80 (v1) cursor: a single `lastPageToken` for an UNORDERED walk.
      // Reusing it as a lane token would silently skip listings, so it must be
      // dropped and both lanes must restart at page one.
      await rig.db.put(
        "meta",
        {
          kind: "public-discovery",
          cursorVersion: 1,
          lastPageToken: "legacy-token",
          rounds: 41,
        },
        DISCOVERY_META_KEY,
      );

      const a = makeSampleMeta("samples/after-migration");
      const { fetchPage, calls } = fakeFetcher({ "": page([a], "t2"), t2: page([]) });

      const res = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
        { maxPages: 10 },
      );

      // No lane started from the legacy token; each lane restarts at page one
      // and walks its own 2-page listing to exhaustion.
      expect(calls.map((c) => c.pageToken)).toEqual([undefined, "t2", undefined, "t2"]);
      // A fresh v2 cursor is written; the round counter restarts from the
      // discarded v1 record (no v1 semantics leak into v2).
      expect(res.cursor.cursorVersion).toBe(DISCOVERY_CURSOR_VERSION);
      expect(res.cursor.rounds).toBe(1);
      expect(res.cursor.laneTokens).toEqual({ favorites: "", usages: "" });
      // ...and the stale token is gone from the persisted record.
      const raw = await rig.db.get<Record<string, unknown>>("meta", DISCOVERY_META_KEY);
      expect(JSON.stringify(raw)).not.toContain("legacy-token");
      expect(raw).not.toHaveProperty("lastPageToken");
    } finally {
      rig.close();
    }
  });

  it("keeps the public-only rule per lane: non-public never enters, in either lane", async () => {
    const rig = await freshRig();
    try {
      const pub = makeSampleMeta("samples/lane-pub", { numFavorites: 9, numUsages: 9 });
      const unlisted = makeSampleMeta("samples/lane-unl", {
        numFavorites: 9,
        numUsages: 9,
        visibility: "unlisted",
      });
      const { fetchPage } = fakeFetcher(
        { "": page([pub, unlisted]) },
        {
          [FAVORITES_ORDER]: { "": page([pub, unlisted]) },
          [USAGES_ORDER]: { "": page([pub, unlisted]) },
        },
      );

      const res = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
      );

      // The highly "popular" unlisted sample stays OUT of the queue in BOTH lanes.
      expect(await rig.queue.get(unlisted.name)).toBeUndefined();
      expect(await rig.queue.get(pub.name)).toBeDefined();
      expect(res.newlyEnqueued).toBe(1);
      // 1 non-public entry per lane × 2 lanes
      expect(res.skippedNonPublic).toBe(PUBLIC_DISCOVERY_LANES.length);
    } finally {
      rig.close();
    }
  });

  it("does NOT change queue behaviour: plain jobs, existing build, one row per id", async () => {
    const rig = await freshRig();
    try {
      const a = makeSampleMeta("samples/plain", { numFavorites: 3, numUsages: 4 });
      const { fetchPage } = fakeFetcher({ "": page([a]) });

      const res = await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
      );

      // The lane only changed the ORDER in which pages are requested. The job
      // itself is the ordinary existing queue job — no new fields, no lane
      // marker, no priority rewrite.
      expect(res.newlyEnqueued).toBe(1);
      const job = await rig.queue.get(a.name);
      expect(job).toBeDefined();
      expect(job!.analysisBuild).toBe(BUILD);
      expect(job!.status).toBe("queued");
      expect(job!.attempts).toBe(0);
      // Nothing about the popularity values is persisted on the job.
      expect(JSON.stringify(job)).not.toMatch(/numFavorites|numUsages|popularity|lane/);
    } finally {
      rig.close();
    }
  });

  it("does not invent a popularity formula: no local scoring of the two signals", async () => {
    const rig = await freshRig();
    try {
      // A sample that is TOP by favorites but BOTTOM by usages. If discovery
      // combined the signals into any score, its rank could change; instead the
      // favorites lane takes it first and the usages lane never sees it.
      const favHeavy = makeSampleMeta("samples/fav-heavy", { numFavorites: 1000, numUsages: 0 });
      const useHeavy = makeSampleMeta("samples/use-heavy", { numFavorites: 0, numUsages: 1000 });
      const { fetchPage, calls } = fakeFetcher(
        { "": page([favHeavy]) },
        {
          [FAVORITES_ORDER]: { "": page([favHeavy]) },
          [USAGES_ORDER]: { "": page([useHeavy]) },
        },
      );

      await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
      );

      // Each lane got exactly one request; no extra "combined" request exists.
      expect(calls.length).toBe(PUBLIC_DISCOVERY_LANES.length);
      expect(new Set(calls.map((c) => c.orderBy))).toEqual(
        new Set([FAVORITES_ORDER, USAGES_ORDER]),
      );
      // Both signals remain independently discoverable.
      expect(await rig.queue.get(favHeavy.name)).toBeDefined();
      expect(await rig.queue.get(useHeavy.name)).toBeDefined();
    } finally {
      rig.close();
    }
  });

  it("persists no audio payload or popularity payload in any lane round", async () => {
    const rig = await freshRig();
    try {
      const a = makeSampleMeta("samples/step81-noaudio", { numFavorites: 42, numUsages: 24 });
      const { fetchPage } = fakeFetcher({ "": page([a], "t2"), t2: page([]) });

      await discoverPublicSamples(
        { fetchPage, index: rig.index, queue: rig.queue, db: rig.db },
        BUILD,
      );

      const job = await rig.queue.get(a.name);
      expect(JSON.stringify(job)).not.toMatch(/ArrayBuffer|Blob|"data"|wav|mp3|flac/i);
      const raw = await rig.db.get<Record<string, unknown>>("meta", DISCOVERY_META_KEY);
      // The cursor stores lane keys only — no order strings, no audio, no values.
      expect(JSON.stringify(raw)).not.toMatch(/ArrayBuffer|Blob|wav|mp3|num_favorites|num_usages/i);
      // Nothing was written to the index by discovery (analysis is untouched).
      expect(await rig.index.get(a.name)).toBeUndefined();
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
