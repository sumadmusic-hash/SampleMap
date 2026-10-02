import { describe, it, expect } from "vitest";
import {
  computeAnalysisEligibility,
  computeEligibilityFromMeta,
  computeEligibilityFromRecord,
  priorityGroupOf,
  priorityGroupOfMeta,
  PRIORITY_GROUP_LABELS,
  FOREIGN_MIN_FAVORITES,
  FOREIGN_MIN_USAGES,
} from "./eligibility";
import { makeSample } from "../persistence/test-helpers";
import type { SampleMeta } from "@audiotool/nexus/api";

const META = (o: Partial<SampleMeta>): SampleMeta => ({
  name: "samples/abc",
  displayName: "Hard Kick",
  description: "",
  ownerName: "users/bob",
  favoritedByUser: false,
  numFavorites: 0,
  numUsages: 0,
  bpm: 0,
  kind: "one-shot",
  visibility: "public",
  tags: ["kick"],
  createTime: new Date("2026-01-01"),
  updateTime: new Date("2026-01-01"),
  durationSeconds: 0.5,
  mp3Url: "https://x/mp3",
  wavUrl: "https://x/wav",
  flacUrl: "https://x/flac",
  previewMp3Url: "https://x/prev",
  getWaveformUrl: () => "https://x/wf",
  ...o,
});

describe("computeAnalysisEligibility (STEP38 §5/§6)", () => {
  it("OWN sample is always eligible, even with zero favorites and zero usage", () => {
    const r = computeAnalysisEligibility({
      owner: "users/alice",
      numFavorites: 0,
      numUsages: 0,
      authenticatedUserId: "users/alice",
    });
    expect(r.eligible).toBe(true);
    expect(r.own).toBe(true);
    expect(r.reason).toBe("own");
  });

  it("own detection requires the STABLE account id to match, NOT a display name", () => {
    const r = computeAnalysisEligibility({
      owner: "alice", // display name, not users/{uuid}
      numFavorites: 0,
      numUsages: 0,
      authenticatedUserId: "users/alice",
    });
    expect(r.own).toBe(false);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("foreign-no-signal");
  });

  it("FOREIGN zero-favorite + zero-usage sample is INELIGIBLE", () => {
    const r = computeAnalysisEligibility({
      owner: "users/bob",
      numFavorites: 0,
      numUsages: 0,
      authenticatedUserId: "users/alice",
    });
    expect(r.eligible).toBe(false);
    expect(r.own).toBe(false);
    expect(r.reason).toBe("foreign-no-signal");
  });

  it("FOREIGN favorites >= FOREIGN_MIN_FAVORITES alone is eligible", () => {
    const r = computeAnalysisEligibility({
      owner: "users/bob",
      numFavorites: FOREIGN_MIN_FAVORITES,
      numUsages: 0,
      authenticatedUserId: "users/alice",
    });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("foreign-favorite");
  });

  it("FOREIGN usage >= FOREIGN_MIN_USAGES alone is eligible", () => {
    const r = computeAnalysisEligibility({
      owner: "users/bob",
      numFavorites: 0,
      numUsages: FOREIGN_MIN_USAGES,
      authenticatedUserId: "users/alice",
    });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("foreign-usage");
  });

  it("FOREIGN below BOTH thresholds is INELIGIBLE (new stricter gate)", () => {
    const r = computeAnalysisEligibility({
      owner: "users/bob",
      numFavorites: FOREIGN_MIN_FAVORITES - 1,
      numUsages: FOREIGN_MIN_USAGES - 1,
      authenticatedUserId: "users/alice",
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("foreign-no-signal");
  });

  it("FOREIGN favorites AND usage both at/above thresholds uses the combined reason", () => {
    const r = computeAnalysisEligibility({
      owner: "users/bob",
      numFavorites: FOREIGN_MIN_FAVORITES,
      numUsages: FOREIGN_MIN_USAGES,
      authenticatedUserId: "users/alice",
    });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("foreign-favorite-and-usage");
  });

  it("MISSING (undefined) counters are never coerced positive", () => {
    const missing = computeAnalysisEligibility({
      owner: "users/bob",
      numFavorites: undefined,
      numUsages: undefined,
      authenticatedUserId: "users/alice",
    });
    expect(missing.eligible).toBe(false);
    expect(missing.reason).toBe("foreign-no-signal");

    const oneMissing = computeAnalysisEligibility({
      owner: "users/bob",
      numFavorites: FOREIGN_MIN_FAVORITES,
      numUsages: undefined,
      authenticatedUserId: "users/alice",
    });
    expect(oneMissing.eligible).toBe(true);
    expect(oneMissing.reason).toBe("foreign-favorite");
  });

  it("negative counters behave like zero (never lenient)", () => {
    const r = computeAnalysisEligibility({
      owner: "users/bob",
      numFavorites: -3,
      numUsages: -1,
      authenticatedUserId: "users/alice",
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("foreign-no-signal");
  });

  it("unsigned identity (authenticatedUserId undefined) → own unavailable, foreign rules; never wrongly OWN", () => {
    const ownExpected = computeAnalysisEligibility({
      owner: "users/alice",
      numFavorites: 0,
      numUsages: 0,
      authenticatedUserId: undefined,
    });
    expect(ownExpected.own).toBe(false);
    expect(ownExpected.eligible).toBe(false);
    expect(ownExpected.reason).toBe("identity-unavailable");

    const foreignHits1 = computeAnalysisEligibility({
      owner: "users/bob",
      numFavorites: FOREIGN_MIN_FAVORITES,
      numUsages: 0,
      authenticatedUserId: undefined,
    });
    expect(foreignHits1.eligible).toBe(true);
    expect(foreignHits1.reason).toBe("foreign-favorite");
  });

  it("is deterministic (same input ⇒ same output, stable reason set)", () => {
    const input = {
      owner: "users/bob",
      numFavorites: FOREIGN_MIN_FAVORITES,
      numUsages: 0,
      authenticatedUserId: "users/alice",
    };
    const a = computeAnalysisEligibility(input);
    const b = computeAnalysisEligibility({ ...input });
    expect(a).toEqual(b);
    expect(Object.keys(PRIORITY_GROUP_LABELS)).toHaveLength(6);
  });

  it("computeEligibilityFromMeta adapts the SampleMeta contract", () => {
    const own = computeEligibilityFromMeta(META({ ownerName: "users/alice" }), "users/alice");
    expect(own.own).toBe(true);
    expect(own.eligible).toBe(true);

    const foreign = computeEligibilityFromMeta(
      META({ ownerName: "users/bob", numFavorites: FOREIGN_MIN_FAVORITES }),
      "users/alice",
    );
    expect(foreign.eligible).toBe(true);
    expect(foreign.own).toBe(false);
  });

  it("computeEligibilityFromRecord adapts the persisted record contract", () => {
    const rec = makeSample("samples/r1", { owner: "users/alice", numFavorites: 0, numUsages: 0 });
    expect(computeEligibilityFromRecord(rec, "users/alice").eligible).toBe(true);

    const foreign = makeSample("samples/r2", { owner: "users/bob" });
    expect(computeEligibilityFromRecord(foreign, "users/alice").eligible).toBe(false);
  });
});

describe("priorityGroupOf (STEP38 §11, one-shots before loops, own before foreign)", () => {
  it("order is own-one-shot < other-one-shot < own-loop < other-loop < own-other < other-other", () => {
    const groups = [
      priorityGroupOf({ owner: "users/alice", kind: "one-shot", authenticatedUserId: "users/alice" }),
      priorityGroupOf({ owner: "users/bob", kind: "one-shot", authenticatedUserId: "users/alice" }),
      priorityGroupOf({ owner: "users/alice", kind: "loop", authenticatedUserId: "users/alice" }),
      priorityGroupOf({ owner: "users/bob", kind: "loop", authenticatedUserId: "users/alice" }),
      priorityGroupOf({ owner: "users/alice", kind: "unknown", authenticatedUserId: "users/alice" }),
      priorityGroupOf({ owner: "users/bob", kind: "unknown", authenticatedUserId: "users/alice" }),
    ];
    expect(groups).toEqual([0, 1, 2, 3, 4, 5]);
    expect(groups[0]).toBeLessThan(groups[1]);
    expect(groups[1]).toBeLessThan(groups[2]);
    expect(groups[2]).toBeLessThan(groups[3]);
    expect(groups[3]).toBeLessThan(groups[4]);
    expect(groups[4]).toBeLessThan(groups[5]);
    expect(PRIORITY_GROUP_LABELS[0]).toBe("own one-shot");
    expect(PRIORITY_GROUP_LABELS[3]).toBe("other loop");
  });

  it("reuses the persisted kind values; everything not one-shot/loop lands in the other tier", () => {
    expect(priorityGroupOf({ owner: "users/alice", kind: "kick", authenticatedUserId: "users/alice" })).toBe(4);
    expect(priorityGroupOf({ owner: "users/bob", kind: undefined, authenticatedUserId: "users/alice" })).toBe(5);
  });

  it("kind comparison is case-insensitive and trimmed", () => {
    expect(
      priorityGroupOf({ owner: "users/bob", kind: " LOOP ", authenticatedUserId: "users/alice" }),
    ).toBe(3);
  });

  it("authenticatedUserId is irrelevant for determinism of tier when owner differs", () => {
    const withId = priorityGroupOf({ owner: "users/bob", kind: "one-shot", authenticatedUserId: "users/alice" });
    const withoutId = priorityGroupOf({ owner: "users/bob", kind: "one-shot", authenticatedUserId: undefined });
    expect(withId).toBe(1);
    expect(withoutId).toBe(1);
  });

  it("priorityGroupOfMeta adapts SampleMeta", () => {
    expect(priorityGroupOfMeta(META({ ownerName: "users/alice", kind: "one-shot" }), "users/alice")).toBe(0);
    expect(priorityGroupOfMeta(META({ ownerName: "users/bob", kind: "loop" }), "users/alice")).toBe(3);
  });
});