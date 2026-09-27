import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isOwnedByAuthenticatedUser,
  mineSampleIds,
  resolveMapVisibility,
  globalContentIdentities,
  visibleGlobalPoints,
  mapEmptyMessage,
} from "./visibility";
import { mapPoints } from "./mapView";
import { SampleMapApp } from "../app";
import type { SampleMapAppDeps } from "../app";
import { createMemoryEp7ConsentStore } from "../ep7Consent";
import { makeSample } from "../../persistence/test-helpers";
import { SampleMapSearchEngine } from "../../search/searchEngine";
import type { SearchQuery } from "../../search/searchEngine";
import { makeFeatures } from "../../classify/test-helpers";
import type { GlobalMapPoint } from "../../global/contract";
import type { JobRunner, AnalysisBudget, RunProgress } from "../../pipeline/jobRunner";

/**
 * Global / My Samples — two independent visibility modes on one shared map.
 *
 * FIXTURE-MARKED: the real Audiotool OAuth session is not available in CI, so
 * ownership is driven by explicit `users/{slug}` owner values on records plus an
 * explicit `authenticatedUserId`. That is the real data shape (persisted
 * `owner` holds the canonical `users/...` resource name, and
 * `resolveAuthenticatedUserId` returns the same form), so the comparison under
 * test is the production one — only the identity source is a fixture.
 */

const USER = "users/alice";
const OTHER = "users/bob";
const HASH_A = "hash-a";
const HASH_B = "hash-b";
const HASH_C = "hash-c";
const HASH_D = "hash-d";
const BUILD = "build-v1";

/** A record that is a member of the global set (its content identity is in it). */
function analyzed(sampleId: string, owner: string, contentHash: string) {
  return makeSample(sampleId, {
    owner,
    analysisBuild: BUILD,
    audioFeatures: makeFeatures(),
    mapPosition: { x: 0.25, y: 0.75 },
    contentHash,
    contentHashVersion: "v1",
  });
}

/** The global set as the existing index reports it. */
function globalPoint(contentHash: string, representativeSampleId: string): GlobalMapPoint {
  return {
    contentIdentity: { contentHash, contentHashVersion: "v1" },
    x: 0.25,
    y: 0.75,
    representativeSampleId,
    primaryClass: "kick",
  };
}

// ── Fixtures: one sample per membership combination ───────────────────────────
const MINE_ONLY = () => analyzed("samples/mine-only", USER, HASH_A);
const GLOBAL_ONLY = () => analyzed("samples/global-only", OTHER, HASH_B);
const BOTH = () => analyzed("samples/both", USER, HASH_C);
const NEITHER = () => analyzed("samples/neither", OTHER, HASH_D);

const ALL_RECORDS = () => [MINE_ONLY(), GLOBAL_ONLY(), BOTH(), NEITHER()];
const GLOBAL_POOL = () => [globalPoint(HASH_B, "samples/global-only"), globalPoint(HASH_C, "samples/both")];

const ids = (recs: readonly { sampleId: string }[]) => recs.map((r) => r.sampleId).sort();

// ─────────────────────────────────────────────────────────────────────────────
describe("visibility: ownership predicate", () => {
  it("matches only identical non-empty canonical identities", () => {
    expect(isOwnedByAuthenticatedUser(USER, USER)).toBe(true);
    expect(isOwnedByAuthenticatedUser(OTHER, USER)).toBe(false);
  });

  it("never claims ownership when an identity is missing (no false positives)", () => {
    expect(isOwnedByAuthenticatedUser(USER, undefined)).toBe(false);
    expect(isOwnedByAuthenticatedUser(undefined, USER)).toBe(false);
    expect(isOwnedByAuthenticatedUser("", USER)).toBe(false);
    expect(isOwnedByAuthenticatedUser(USER, "")).toBe(false);
  });

  it("a blank owner is never 'mine' — not even when both sides are blank", () => {
    // A plain `owner === userId` comparison would wrongly claim ownership here.
    expect(isOwnedByAuthenticatedUser("", "")).toBe(false);
    expect(isOwnedByAuthenticatedUser("   ", "   ")).toBe(false);
    // The pipeline persists "unknown" when the meta has no owner name.
    expect(isOwnedByAuthenticatedUser("unknown", "")).toBe(false);
    expect(mineSampleIds([makeSample("samples/x", { owner: "" })], "")).toHaveLength(0);
    expect(mineSampleIds([makeSample("samples/x", { owner: "unknown" })], "")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("visibility: the two independent toggles", () => {
  // 1. Global ON / My Samples OFF
  it("1. Global ON / My Samples OFF shows exactly the global set", () => {
    const v = resolveMapVisibility(ALL_RECORDS(), GLOBAL_POOL(), { global: true, mine: false }, USER);
    expect(ids(v.visibleRecords)).toEqual(["samples/both", "samples/global-only"]);
  });

  // 2. Global OFF / My Samples ON
  it("2. Global OFF / My Samples ON shows exactly my samples", () => {
    const v = resolveMapVisibility(ALL_RECORDS(), GLOBAL_POOL(), { global: false, mine: true }, USER);
    expect(ids(v.visibleRecords)).toEqual(["samples/both", "samples/mine-only"]);
  });

  // 3. both OFF
  it("3. both OFF shows nothing", () => {
    const v = resolveMapVisibility(ALL_RECORDS(), GLOBAL_POOL(), { global: false, mine: false }, USER);
    expect(v.visibleRecords).toHaveLength(0);
    // Membership is still known for every record — nothing is lost.
    expect(v.membershipAll.size).toBe(4);
  });

  // 4. both ON → UNION, never the intersection
  it("4. both ON shows the UNION (global ∪ mine), not the intersection", () => {
    const v = resolveMapVisibility(ALL_RECORDS(), GLOBAL_POOL(), { global: true, mine: true }, USER);
    expect(ids(v.visibleRecords)).toEqual([
      "samples/both",
      "samples/global-only",
      "samples/mine-only",
    ]);
    // The intersection would be only "samples/both" — explicitly not the case.
    expect(v.visibleRecords).toHaveLength(3);
  });

  it("toggling one flag never changes the other", () => {
    const both = resolveMapVisibility(ALL_RECORDS(), GLOBAL_POOL(), { global: true, mine: true }, USER);
    const onlyGlobal = resolveMapVisibility(ALL_RECORDS(), GLOBAL_POOL(), { global: true, mine: false }, USER);
    // Global-only is a strict subset of the union; nothing global was dropped.
    for (const id of ids(onlyGlobal.visibleRecords)) {
      expect(ids(both.visibleRecords)).toContain(id);
    }
  });

  it("with no authenticated identity My Samples contributes nothing but Global still works", () => {
    const v = resolveMapVisibility(ALL_RECORDS(), GLOBAL_POOL(), { global: true, mine: true }, undefined);
    expect(ids(v.visibleRecords)).toEqual(["samples/both", "samples/global-only"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("visibility: membership and deduplication", () => {
  // 5. a sample in BOTH sets appears exactly once
  it("5. a sample in both sets appears exactly once and keeps both flags", () => {
    const v = resolveMapVisibility(ALL_RECORDS(), GLOBAL_POOL(), { global: true, mine: true }, USER);
    const bothPoints = v.visibleRecords.filter((r) => r.sampleId === "samples/both");
    expect(bothPoints).toHaveLength(1);
    expect(v.membership.get("samples/both")).toEqual({ isGlobal: true, isMine: true });
    // And it renders as exactly one map point for that sample, not two.
    const pointsForBoth = mapPoints(v.visibleRecords).filter((p) => p.sampleId === "samples/both");
    expect(pointsForBoth).toHaveLength(1);
  });

  it("never emits a sampleId twice even if the input repeats it", () => {
    const dup = [...ALL_RECORDS(), BOTH(), MINE_ONLY()];
    const v = resolveMapVisibility(dup, GLOBAL_POOL(), { global: true, mine: true }, USER);
    const seen = v.visibleRecords.map((r) => r.sampleId);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((s) => s === "samples/both")).toHaveLength(1);
  });

  // 6. only-global
  it("6. a global-only sample is visible via Global alone", () => {
    const v = resolveMapVisibility(ALL_RECORDS(), GLOBAL_POOL(), { global: true, mine: false }, USER);
    expect(v.membership.get("samples/global-only")).toEqual({ isGlobal: true, isMine: false });
    expect(ids(v.visibleRecords)).toContain("samples/global-only");
  });

  // 7. only-mine
  it("7. a my-samples-only sample is visible via My Samples alone", () => {
    const v = resolveMapVisibility(ALL_RECORDS(), GLOBAL_POOL(), { global: false, mine: true }, USER);
    expect(v.membership.get("samples/mine-only")).toEqual({ isGlobal: false, isMine: true });
    expect(ids(v.visibleRecords)).toContain("samples/mine-only");
  });

  it("a sample in neither set is never visible but stays in membershipAll", () => {
    for (const toggles of [
      { global: true, mine: true },
      { global: true, mine: false },
      { global: false, mine: true },
      { global: false, mine: false },
    ]) {
      const v = resolveMapVisibility(ALL_RECORDS(), GLOBAL_POOL(), toggles, USER);
      expect(ids(v.visibleRecords)).not.toContain("samples/neither");
      expect(v.membershipAll.get("samples/neither")).toEqual({ isGlobal: false, isMine: false });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("visibility: My Samples set completeness (not viewport/analyzed limited)", () => {
  it("includes records in ANY analysis status, not only analyzed ones", () => {
    const analyzedMine = analyzed("samples/a-analyzed", USER, HASH_A);
    const pendingMine = makeSample("samples/b-pending", {
      owner: USER,
      analysisBuild: BUILD,
      status: "pending",
    });
    const failedMine = makeSample("samples/c-failed", {
      owner: USER,
      analysisBuild: BUILD,
      status: "failed",
    });
    const set = mineSampleIds([analyzedMine, pendingMine, failedMine], USER);
    expect([...set].sort()).toEqual([
      "samples/a-analyzed",
      "samples/b-pending",
      "samples/c-failed",
    ]);
  });

  it("includes records that have NO position and NO audio features yet", () => {
    // A known-but-not-yet-analyzed sample is still part of the user's set; the
    // set must not be derived from the positionable/analyzed subset.
    const unanalyzed = makeSample("samples/unanalyzed", {
      owner: USER,
      status: "pending",
      mapPosition: undefined,
      audioFeatures: undefined,
      analyzedAt: undefined,
    });
    expect(unanalyzed.mapPosition).toBeUndefined();
    expect(mineSampleIds([unanalyzed], USER).has("samples/unanalyzed")).toBe(true);

    // ...and it is known as mine even though it cannot become a map point.
    const v = resolveMapVisibility([unanalyzed], [], { global: false, mine: true }, USER);
    expect(v.membershipAll.get("samples/unanalyzed")).toEqual({
      isGlobal: false,
      isMine: true,
    });
  });

  it("is not limited to the current map viewport (no coordinate filtering)", () => {
    // Positions far outside any default viewport still count as "mine".
    const far = makeSample("samples/far", {
      owner: USER,
      analysisBuild: BUILD,
      audioFeatures: makeFeatures(),
      mapPosition: { x: 0.999, y: 0.001 },
    });
    expect(mineSampleIds([far], USER).has("samples/far")).toBe(true);
  });

  it("excludes foreign samples", () => {
    expect(mineSampleIds([GLOBAL_ONLY(), NEITHER()], USER)).toHaveLength(0);
  });

  it("globalContentIdentities reads the existing global set", () => {
    const set = globalContentIdentities(GLOBAL_POOL());
    expect([...set].sort()).toEqual(["v1:" + HASH_B, "v1:" + HASH_C]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("visibility: which global points reach the map", () => {
  it("passes the whole existing pool while Global is on", () => {
    expect(visibleGlobalPoints(GLOBAL_POOL(), { global: true })).toHaveLength(2);
  });

  it("passes nothing while Global is off, even with My Samples on", () => {
    expect(visibleGlobalPoints(GLOBAL_POOL(), { global: false })).toHaveLength(0);
  });

  it("tolerates a missing global pool", () => {
    expect(visibleGlobalPoints(undefined, { global: true })).toHaveLength(0);
    expect(visibleGlobalPoints(undefined, { global: false })).toHaveLength(0);
  });

  it("does not mutate the caller's pool", () => {
    const pool = GLOBAL_POOL();
    visibleGlobalPoints(pool, { global: false });
    expect(pool).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("visibility: sound space coordinates are untouched", () => {
  // 10. existing map coordinates remain unchanged
  it("10. does not alter mapPosition and yields the same coordinates as the unfiltered set", () => {
    const records = ALL_RECORDS();
    const unfiltered = mapPoints(records);
    const all = resolveMapVisibility(records, GLOBAL_POOL(), { global: true, mine: true }, USER);

    for (const rec of records) {
      const fromAll = all.visibleRecords.find((r) => r.sampleId === rec.sampleId);
      if (!fromAll) continue;
      expect(fromAll.mapPosition).toEqual(rec.mapPosition);
    }
    // Every rendered point keeps the persisted coordinate, byte for byte.
    for (const p of mapPoints(all.visibleRecords)) {
      const source = all.visibleRecords.find((r) => r.sampleId === p.sampleId);
      expect(p.x).toBe(source?.mapPosition?.x);
      expect(p.y).toBe(source?.mapPosition?.y);
    }
    // The two global-only samples were never positionable locally; the rest
    // still project to exactly the same coordinates as before the filter.
    expect(mapPoints(all.visibleRecords)).toHaveLength(unfiltered.length - 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("visibility: empty-map copy never blames the toggles wrongly", () => {
  const base = {
    visibleCount: 0,
    globalPointCount: 0,
    mySampleCount: 0,
    hasIdentity: true,
    hasActiveSearch: false,
    resultCount: 4,
  };

  it("OFF/OFF says the map is hidden by choice", () => {
    expect(mapEmptyMessage({ ...base, toggles: { global: false, mine: false } })).toBe(
      "Map hidden — enable Global and/or My Samples to show samples.",
    );
  });

  it("OFF/OFF wins over every other empty reason", () => {
    // Even with an unknown identity and both sets empty, "hidden" is the truth.
    expect(
      mapEmptyMessage({
        ...base,
        hasIdentity: false,
        toggles: { global: false, mine: false },
      }),
    ).toBe("Map hidden — enable Global and/or My Samples to show samples.");
  });

  it("Global ON with an empty global set does NOT claim 'No analyzed samples yet.'", () => {
    const msg = mapEmptyMessage({
      ...base,
      mySampleCount: 4, // four analysed samples exist, they are just filtered off
      toggles: { global: true, mine: false },
    });
    expect(msg).toBe("Global has no samples available in the current view.");
    expect(msg).not.toMatch(/no analyzed samples/i);
  });

  it("My Samples ON with an empty my-set reports that set", () => {
    expect(
      mapEmptyMessage({ ...base, toggles: { global: false, mine: true } }),
    ).toBe("My Samples has no samples available.");
  });

  it("keeps the unknown-identity hint when My Samples is on", () => {
    expect(
      mapEmptyMessage({
        ...base,
        hasIdentity: false,
        toggles: { global: false, mine: true },
      }),
    ).toBe(
      "My Samples is on, but the authenticated user is unknown — ownership cannot be determined.",
    );
  });

  it("unknown identity outranks an empty global set (both toggles on)", () => {
    expect(
      mapEmptyMessage({
        ...base,
        hasIdentity: false,
        toggles: { global: true, mine: true },
      }),
    ).toMatch(/authenticated user is unknown/);
  });

  it("both toggles on and both sets empty names both sets", () => {
    expect(mapEmptyMessage({ ...base, toggles: { global: true, mine: true } })).toBe(
      "Global and My Samples have no samples available.",
    );
  });

  it("both toggles on, only the global set empty names the global set", () => {
    expect(
      mapEmptyMessage({ ...base, mySampleCount: 4, toggles: { global: true, mine: true } }),
    ).toBe("Global has no samples available in the current view.");
  });

  it("both toggles on, only the my-set empty names the my-set", () => {
    expect(
      mapEmptyMessage({ ...base, globalPointCount: 3, toggles: { global: true, mine: true } }),
    ).toBe("My Samples has no samples available.");
  });

  it("stays silent when the active sets are non-empty (not a visibility problem)", () => {
    // Both sets have data but nothing is positionable -> the ordinary
    // search/analysis empty state must apply, NOT a visibility message.
    expect(
      mapEmptyMessage({
        ...base,
        globalPointCount: 2,
        mySampleCount: 4,
        toggles: { global: true, mine: true },
      }),
    ).toBeUndefined();
    expect(
      mapEmptyMessage({ ...base, globalPointCount: 2, toggles: { global: true, mine: false } }),
    ).toBeUndefined();
    expect(
      mapEmptyMessage({ ...base, mySampleCount: 4, toggles: { global: false, mine: true } }),
    ).toBeUndefined();
  });

  it("stays silent when something is actually visible", () => {
    expect(
      mapEmptyMessage({
        ...base,
        visibleCount: 1,
        toggles: { global: false, mine: false },
      }),
    ).toBeUndefined();
  });

  // ── search precedence (pre-existing contract, pinned by e2e EP2/EP4) ──
  it("an active search that matched nothing keeps its own message", () => {
    expect(
      mapEmptyMessage({
        ...base,
        hasActiveSearch: true,
        resultCount: 0,
        toggles: { global: true, mine: true },
      }),
    ).toBeUndefined();
    expect(
      mapEmptyMessage({
        ...base,
        hasActiveSearch: true,
        resultCount: 0,
        toggles: { global: true, mine: false },
      }),
    ).toBeUndefined();
  });

  it("an active search that DID match still lets the toggles explain the emptiness", () => {
    // 1 hit found, then My Samples filtered it away -> the toggle is the cause.
    expect(
      mapEmptyMessage({
        ...base,
        hasActiveSearch: true,
        resultCount: 1,
        mySampleCount: 4,
        globalPointCount: 0,
        toggles: { global: true, mine: false },
      }),
    ).toBe("Global has no samples available in the current view.");
  });

  it("OFF/OFF still says 'hidden' even when the search matched nothing", () => {
    expect(
      mapEmptyMessage({
        ...base,
        hasActiveSearch: true,
        resultCount: 0,
        toggles: { global: false, mine: false },
      }),
    ).toBe("Map hidden — enable Global and/or My Samples to show samples.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// APP LEVEL (fixtures/mocks — no real Audiotool auth)
afterEach(() => {
  vi.useRealTimers();
});

function indexStub(records: () => ReturnType<typeof makeSample>[]) {
  return {
    getAll: async () => records(),
    get: async (id: string) => records().find((r) => r.sampleId === id),
  } as never;
}

function runnerDouble() {
  const progress: RunProgress = {
    analyzed: 0,
    failed: 0,
    skipped: 0,
    gone: 0,
    stoppedReason: undefined,
  };
  let onJobDone: ((p: Readonly<RunProgress>) => void) | undefined;
  let resolveStart: ((p: RunProgress) => void) | undefined;
  const runner = {
    start: () => new Promise<RunProgress>((res) => (resolveStart = res)),
    pause: () => undefined,
    isRunning: () => true,
    isPaused: () => false,
    progressSnapshot: () => progress,
    lastStoppedReason: () => progress.stoppedReason,
    lastErrorReason: () => undefined,
  } as unknown as JobRunner;
  return {
    runner,
    bind: (h?: (p: Readonly<RunProgress>) => void) => (onJobDone = h),
    finishAnalyzed: (n = 1) => {
      progress.analyzed += n;
      onJobDone?.(progress);
    },
    end: async () => {
      resolveStart?.(progress);
      for (let i = 0; i < 40; i++) await Promise.resolve();
    },
  };
}

async function appRig(records: () => ReturnType<typeof makeSample>[], userId: string | undefined) {
  const realSearch = new SampleMapSearchEngine(indexStub(records));
  const ctrl = runnerDouble();
  const consent = createMemoryEp7ConsentStore();
  consent.grant();
  const deps: Partial<SampleMapAppDeps> = {
    queue: { enqueue: async () => "added" } as never,
    index: indexStub(records),
    search: { search: (q: SearchQuery) => realSearch.search(q) } as never,
    preview: { dispose: () => undefined } as never,
    machiniste: { send: () => undefined } as never,
    createRunner: ((_b: AnalysisBudget, onJobDone?: (p: Readonly<RunProgress>) => void) => {
      ctrl.bind(onJobDone);
      return ctrl.runner;
    }) as SampleMapAppDeps["createRunner"],
    fetchPage: (async () => ({ samples: [], nextPageToken: "" })) as never,
    known: { getUpdatedAt: async () => undefined },
    previewUrlFor: () => undefined,
    analysisBuild: BUILD,
    authenticatedUserId: userId,
    ep7Consent: consent,
  };
  const app = new SampleMapApp(deps as SampleMapAppDeps);
  await app.refreshSearch();
  return { app, ctrl };
}

describe("app: visibility toggles (fixture identity)", () => {
  it("exposes all four toggle states through the app", async () => {
    const store = () => [MINE_ONLY(), GLOBAL_ONLY(), BOTH(), NEITHER()];
    const { app } = await appRig(store, USER);
    app.globalPoints = GLOBAL_POOL();

    await app.setVisibility({ global: true, mine: false });
    expect(ids(app.visibleMapRecords)).toEqual(["samples/both", "samples/global-only"]);

    await app.setVisibility({ global: false, mine: true });
    expect(ids(app.visibleMapRecords)).toEqual(["samples/both", "samples/mine-only"]);

    await app.setVisibility({ global: false, mine: false });
    expect(app.visibleMapRecords).toHaveLength(0);

    await app.setVisibility({ global: true, mine: true });
    expect(app.visibleMapRecords).toHaveLength(3);
  });

  it("setVisibility only changes the key it is given", async () => {
    const { app } = await appRig(() => [MINE_ONLY()], USER);
    app.globalPoints = [];
    await app.setVisibility({ global: true, mine: true });
    await app.setVisibility({ global: false });
    expect(app.visibility).toEqual({ global: false, mine: true });
  });

  // 8. search keeps working with both toggles
  it("8. search still finds samples that are currently not on the map", async () => {
    const { app } = await appRig(() => [MINE_ONLY(), GLOBAL_ONLY()], USER);
    app.globalPoints = GLOBAL_POOL();

    // Hide everything from the map.
    await app.setVisibility({ global: false, mine: false });
    expect(app.visibleMapRecords).toHaveLength(0);

    // The searchable set is untouched: both samples are still findable.
    expect(app.results.map((r) => r.record.sampleId).sort()).toEqual([
      "samples/global-only",
      "samples/mine-only",
    ]);

    await app.setSearch("Hard");
    expect(app.results.length).toBeGreaterThan(0);
    // Still off the map — findable, not mapped.
    expect(app.visibleMapRecords).toHaveLength(0);
  });

  it("search + visibility compose: a hit outside both sets is found but not mapped", async () => {
    const { app } = await appRig(() => [MINE_ONLY(), NEITHER()], USER);
    app.globalPoints = [];
    await app.setVisibility({ global: true, mine: false });
    expect(app.visibleMapRecords).toHaveLength(0);
    expect(app.results).toHaveLength(2);
    expect(app.mapMembership.get("samples/neither")).toEqual({ isGlobal: false, isMine: false });
  });

  // 9. live analysis updates the correct set
  it("9. live analysis adds a newly persisted sample to My Samples", async () => {
    vi.useFakeTimers();
    const store: ReturnType<typeof makeSample>[] = [];
    const { app, ctrl } = await appRig(() => store, USER);
    app.globalPoints = [];
    await app.setVisibility({ global: false, mine: true });

    expect(app.mySamples.size).toBe(0);
    expect(app.visibleMapRecords).toHaveLength(0);

    void app.analyze(100);
    expect(app.analysis.status).toBe("running");

    // A job finishes: the pipeline persisted it before the run ends.
    store.push(analyzed("samples/live-1", USER, HASH_A));
    ctrl.finishAnalyzed();
    await vi.advanceTimersByTimeAsync(500);

    expect(app.analysis.status).toBe("running");
    expect(app.mySamples.has("samples/live-1")).toBe(true);
    expect(ids(app.visibleMapRecords)).toEqual(["samples/live-1"]);

    await ctrl.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.analysis.status).toBe("stopped");
    expect(ids(app.visibleMapRecords)).toEqual(["samples/live-1"]);
  });

  it("a live-analyzed FOREIGN sample does not enter My Samples", async () => {
    vi.useFakeTimers();
    const store: ReturnType<typeof makeSample>[] = [];
    const { app, ctrl } = await appRig(() => store, USER);
    app.globalPoints = [];
    await app.setVisibility({ global: false, mine: true });

    void app.analyze(100);
    store.push(analyzed("samples/foreign", OTHER, HASH_B));
    ctrl.finishAnalyzed();
    await vi.advanceTimersByTimeAsync(500);

    expect(app.mySamples.has("samples/foreign")).toBe(false);
    expect(app.visibleMapRecords).toHaveLength(0);
    await ctrl.end();
  });

  it("My Samples count covers unanalyzed records while the map shows only positioned ones", async () => {
    const records = () => [
      analyzed("samples/pos", USER, HASH_A),
      makeSample("samples/pending", { owner: USER, analysisBuild: BUILD, status: "pending" }),
    ];
    const { app } = await appRig(records, USER);
    app.globalPoints = [];
    await app.setVisibility({ global: false, mine: true });

    expect(app.mySamples.size).toBe(2);
    expect(ids(app.visibleMapRecords)).toEqual(["samples/pos"]);
  });

  it("reports the identity as unavailable instead of guessing ownership", async () => {
    const { app } = await appRig(() => [MINE_ONLY(), GLOBAL_ONLY()], undefined);
    app.globalPoints = GLOBAL_POOL();
    expect(app.hasAuthenticatedIdentity).toBe(false);
    expect(app.mySamples.size).toBe(0);
    await app.setVisibility({ global: false, mine: true });
    expect(app.visibleMapRecords).toHaveLength(0);
  });

  it("a stale, slower refresh cannot overwrite a newer My Samples set", async () => {
    // The membership read is awaited, so an older refresh can finish AFTER a
    // newer one. The searchEpoch guard must drop the stale write.
    let store: ReturnType<typeof makeSample>[] = [analyzed("samples/old", USER, HASH_A)];
    let getAllCalls = 0;
    let releaseFirst: (() => void) | undefined;

    const realSearch = new SampleMapSearchEngine(indexStub(() => store));
    const consent = createMemoryEp7ConsentStore();
    consent.grant();
    const deferredIndex = {
      getAll: async () => {
        getAllCalls++;
        // Snapshot the current generation, then hang on the first call only.
        const snapshot = [...store];
        if (getAllCalls === 1) {
          await new Promise<void>((res) => {
            releaseFirst = res;
          });
        }
        return snapshot;
      },
      get: async (id: string) => store.find((r) => r.sampleId === id),
    } as never;

    const deps: Partial<SampleMapAppDeps> = {
      queue: { enqueue: async () => "added" } as never,
      index: deferredIndex,
      search: { search: (q: SearchQuery) => realSearch.search(q) } as never,
      preview: { dispose: () => undefined } as never,
      machiniste: { send: () => undefined } as never,
      fetchPage: (async () => ({ samples: [], nextPageToken: "" })) as never,
      known: { getUpdatedAt: async () => undefined },
      previewUrlFor: () => undefined,
      analysisBuild: BUILD,
      authenticatedUserId: USER,
      ep7Consent: consent,
    };
    const app = new SampleMapApp(deps as SampleMapAppDeps);

    // Refresh #1 starts against the OLD generation and stalls inside getAll().
    const stale = app.refreshSearch();
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));

    // A new sample is persisted, then refresh #2 runs to completion.
    store = [analyzed("samples/new", USER, HASH_A), analyzed("samples/other", OTHER, HASH_B)];
    await app.refreshSearch();
    expect([...app.mySamples].sort()).toEqual(["samples/new"]);

    // NOW the stale refresh resumes and tries to write the OLD generation.
    releaseFirst?.();
    await stale;

    expect([...app.mySamples].sort()).toEqual(["samples/new"]);
  });
});
