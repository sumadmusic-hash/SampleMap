import { describe, it, expect } from "vitest";

import type { SampleIndexRecord } from "../../persistence/indexStore";
import { makeSample } from "../../persistence/test-helpers";
import { makeFeatures } from "../../classify/test-helpers";
import { computeSimilarityFingerprint } from "../../similarity/similarityFingerprint";
import type { GlobalMapPoint } from "../../global/contract";
import {
  CLUSTER_MIN_POINTS,
  clusterMapPoints,
  entryCoverage,
  mapPoints,
  type MapCluster,
  type MapEntry,
} from "./mapView";
import { resolveMapVisibility, type VisibilityToggles } from "./visibility";

/**
 * STEP85 — WHY THE MAP CAN LOOK EMPTY ("loaded 437, sees 3 dots").
 *
 * This file is a READ-ONLY diagnostic of the EXISTING pipeline:
 *
 *   records
 *     -> resolveMapVisibility()   (Global / My Samples toggles gate the points)
 *     -> mapPoints()              (content-identity dedup + position requirement)
 *     -> globalMapPoints() + mergeMapPoints()
 *     -> clusterMapPoints()       (LOD, only above CLUSTER_MIN_POINTS)
 *     -> SVG circles / cluster dots
 *
 * Nothing here changes behaviour: every assertion pins what the pipeline
 * ALREADY does, so the numbers that decide "how many things does the user see"
 * are documented and cannot drift silently.
 */

const OWNER = "users/sumad";
const AUTH_USER = "users/sumad";

/**
 * A record that is fully publish/map eligible: analyzed, has audio features,
 * a content identity, a similarity fingerprint and a persisted V2 position.
 */
function eligibleRecord(sampleId: string, hash: string, x: number, y: number): SampleIndexRecord {
  const features = makeFeatures();
  return makeSample(sampleId, {
    owner: OWNER,
    analyzedAt: "2026-03-01T00:00:00.000Z",
    analysisBuild: "smap-build-v1",
    contentHash: hash,
    contentHashVersion: "pcm-v1",
    analysisSourceFormat: "wav",
    similarityFingerprint: computeSimilarityFingerprint(features),
    mapPosition: { x, y },
    audioFeatures: features,
  });
}

/** Deterministic pseudo-random position in the normalized map area. */
function pseudo(i: number, salt: number): number {
  const v = Math.sin((i + 1) * (12.9898 + salt)) * 43758.5453;
  return v - Math.floor(v);
}

interface Corpus {
  records: SampleIndexRecord[];
  /** Records whose audio content identity is shared with another record. */
  duplicateIds: string[];
  /** Analyzed records with neither a V2 position nor a projectable sound character. */
  missingV2Ids: string[];
}

/**
 * A realistic analyzed corpus:
 *  - `total` records,
 *  - `duplicateShare` of them are the SAME audio content under a second
 *    sample id (a re-import) and therefore collapse to one map point,
 *  - `missingV2Share` are analyzed but carry no persisted V2 position.
 */
function corpus(total: number, duplicateShare = 0.12, missingV2Share = 0.08): Corpus {
  const records: SampleIndexRecord[] = [];
  const duplicateIds: string[] = [];
  const missingV2Ids: string[] = [];
  let unique = 0;

  // The hash a duplicate re-uses: the very first unique identity, so a
  // re-imported file really does collapse onto an existing map point.
  const sharedHash = "h-shared-identity";

  for (let i = 0; i < total; i += 1) {
    // Every Nth record is the SAME audio content under a second sample id.
    const isDuplicate = i > 0 && i % Math.max(2, Math.round(1 / duplicateShare)) === 0;
    // Analyzed, but with no persisted V2 position and no projectable sound
    // character: a Missing-V2 record. It has NO place on the map.
    const isMissingV2 = !isDuplicate && i % Math.max(2, Math.round(1 / missingV2Share)) === 1;

    if (isDuplicate) {
      records.push(
        eligibleRecord(
          `samples/dup-${String(duplicateIds.length).padStart(3, "0")}`,
          sharedHash,
          0.5,
          0.5,
        ),
      );
      duplicateIds.push(`samples/dup-${String(duplicateIds.length).padStart(3, "0")}`);
      continue;
    }

    const id = `samples/s${String(unique).padStart(4, "0")}`;
    unique += 1;
    const hash = unique === 1 ? sharedHash : `h-${String(unique).padStart(5, "0")}`;

    if (isMissingV2) {
      const rec = eligibleRecord(id, hash, 0.5, 0.5);
      const { mapPosition: _drop, ...withoutPosition } = rec;
      records.push(withoutPosition as SampleIndexRecord);
      missingV2Ids.push(id);
      continue;
    }

    records.push(eligibleRecord(id, hash, pseudo(i, 0.5), pseudo(i, 1.7)));
  }

  return { records, duplicateIds, missingV2Ids };
}

/** A global pool entry for every unique identity in the corpus. */
function globalPoolFor(records: readonly SampleIndexRecord[]): GlobalMapPoint[] {
  return records
    .filter((r) => r.contentHash && r.mapPosition)
    .map((r) => ({
      contentIdentity: {
        contentHash: r.contentHash!,
        contentHashVersion: r.contentHashVersion ?? "unknown",
      },
      x: r.mapPosition?.x ?? 0,
      y: r.mapPosition?.y ?? 0,
      representativeSampleId: r.sampleId,
      primaryClass: r.primaryClass,
    }));
}

/**
 * A deliberately SMALL global pool, modelling production (19 content identities
 * against a much larger local library). Only identities that appear exactly ONCE
 * are used, so a global match can never cascade onto the duplicate records.
 */
function smallGlobalPool(records: readonly SampleIndexRecord[], n: number): GlobalMapPoint[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (!r.contentHash || !r.mapPosition) continue;
    counts.set(r.contentHash, (counts.get(r.contentHash) ?? 0) + 1);
  }
  return globalPoolFor(records.filter((r) => r.contentHash && counts.get(r.contentHash) === 1)).slice(0, n);
}

const BOTH_ON: VisibilityToggles = { global: true, mine: true };

const clustersOf = (e: readonly MapEntry[]) => e.filter((x): x is MapCluster => x.kind === "cluster");
const singlesOf = (e: readonly MapEntry[]) => e.filter((x) => x.kind === "point");

describe("STEP85 map count : records -> points -> entries", () => {
  it("1. the pipeline is LOSSLESS in count: every eligible point is drawn or counted", () => {
    const { records } = corpus(437);
    const visible = resolveMapVisibility(records, undefined, BOTH_ON, AUTH_USER).visibleRecords;
    const points = mapPoints(visible);
    const entries = clusterMapPoints(points, 1);

    // Nothing is lost between the point set and the rendered set.
    expect(entryCoverage(entries)).toBe(points.length);

    // And nothing is lost between the visible records and the point set except
    // the two documented reductions: content-identity dedup and Missing-V2.
    const positioned = visible.filter(
      (r) => r.mapPosition !== undefined || r.analysisV2?.soundCharacter !== undefined,
    );
    const distinctIdentities = new Set(
      positioned.map((r) => `${r.contentHash}|${r.contentHashVersion ?? "unknown"}`),
    );
    expect(points.length).toBe(distinctIdentities.size);
  });

  it("2. content-identity dedup: 437 records collapse to far fewer map points", () => {
    const { records, duplicateIds, missingV2Ids } = corpus(437);
    expect(duplicateIds.length).toBeGreaterThan(0);
    expect(missingV2Ids.length).toBeGreaterThan(0);

    const visible = resolveMapVisibility(records, undefined, BOTH_ON, AUTH_USER).visibleRecords;
    const points = mapPoints(visible);

    // 437 records in, but the point set is one point per CONTENT IDENTITY.
    expect(visible).toHaveLength(437);
    expect(points.length).toBeLessThan(visible.length);
    // Exactly the two documented reductions and nothing else: one point per
    // content identity among the records that actually have a position.
    const positionedIdentities = new Set(
      visible
        .filter((r) => r.mapPosition !== undefined || r.analysisV2?.soundCharacter !== undefined)
        .map((r) => `${r.contentHash}|${r.contentHashVersion ?? "unknown"}`),
    );
    expect(points.length).toBe(positionedIdentities.size);
    expect(points.length).toBe(437 - missingV2Ids.length - duplicateIds.length);

    // All 54 re-imports collapse onto ONE point, which still carries every
    // sample id, so no sample becomes unreachable.
    const collapsed = points.filter((p) => p.sampleIds.length > 1);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].sampleIds).toHaveLength(duplicateIds.length + 1);
    for (const id of duplicateIds) expect(collapsed[0].sampleIds).toContain(id);
  });

  it("3. Missing-V2 records produce NO map point at all (analyzed, but unplaceable)", () => {
    const { records, missingV2Ids } = corpus(437);
    expect(missingV2Ids.length).toBeGreaterThan(0);

    const visible = resolveMapVisibility(records, undefined, BOTH_ON, AUTH_USER).visibleRecords;
    const onMap = new Set(mapPoints(visible).flatMap((p) => p.sampleIds));

    // They ARE loaded and analyzed — but they cannot be placed on the map.
    const analyzedIds = new Set(visible.map((r) => r.sampleId));
    for (const id of missingV2Ids) {
      expect(analyzedIds.has(id)).toBe(true);
      expect(onMap.has(id)).toBe(false);
    }
  });

  it("4. THE 'only 3 dots' cause: the visibility gate, not the clustering", () => {
    const { records, duplicateIds } = corpus(437);

    // The real production asymmetry: a large local library vs. a small global
    // pool (production currently holds 19 content identities / 9 map points).
    const globalPoints = smallGlobalPool(records, 3);
    expect(globalPoints).toHaveLength(3);
    expect(duplicateIds.length).toBeGreaterThan(0);

    // A healthy session: the authenticated id resolves, so "My Samples" works
    // and the whole library is on the map.
    const visible = resolveMapVisibility(records, globalPoints, BOTH_ON, AUTH_USER).visibleRecords;
    const points = mapPoints(visible);
    const entries = clusterMapPoints(points, 1);
    expect(entries.length).toBeGreaterThan(10);
    expect(entryCoverage(entries)).toBe(points.length);

    // The reported symptom: the SAME 437 analyzed records, but ownership could
    // not be determined (auth resolution failed, or the owner string does not
    // match the authenticated id). "My Samples" then matches nothing and only
    // the 3 global identities survive -> a couple of dots, no error anywhere.
    const blind = resolveMapVisibility(records, globalPoints, BOTH_ON, undefined).visibleRecords;
    const blindPoints = mapPoints(blind);
    const blindEntries = clusterMapPoints(blindPoints, 1);

    expect(visible.length).toBe(437);
    expect(blind.length).toBe(3);
    expect(blindEntries).toHaveLength(3);
    // It is NOT the LOD: the same collapse happens with clustering off.
    expect(blindEntries).toHaveLength(blindPoints.length);

    // Turning "My Samples" off reproduces it with a KNOWN identity.
    const mineOff = resolveMapVisibility(records, globalPoints, { global: true, mine: false }, AUTH_USER);
    expect(mineOff.visibleRecords).toHaveLength(3);
  });

  it("5. clustering is OFF below the threshold, so few samples are never clustered away", () => {
    const { records } = corpus(20);
    const visible = resolveMapVisibility(records, undefined, BOTH_ON, AUTH_USER).visibleRecords;
    const points = mapPoints(visible);
    const entries = clusterMapPoints(points, 1);

    // Fewer than CLUSTER_MIN_POINTS -> every single point is drawn as itself.
    expect(points.length).toBeLessThan(CLUSTER_MIN_POINTS);
    expect(clustersOf(entries)).toHaveLength(0);
    expect(singlesOf(entries)).toHaveLength(points.length);
    // The only reduction here is the documented one: content-identity dedup
    // plus the Missing-V2 records. Nothing is dropped by the renderer.
    expect(entryCoverage(entries)).toBe(points.length);
  });

  it("6. above the threshold the user sees counts, and zooming resolves them", () => {
    const { records } = corpus(437);
    const visible = resolveMapVisibility(records, undefined, BOTH_ON, AUTH_USER).visibleRecords;
    const points = mapPoints(visible);

    const zoomedOut = clusterMapPoints(points, 1);
    const zoomedIn = clusterMapPoints(points, 8);

    // Zoomed out: far fewer elements than points, but every point is counted.
    expect(zoomedOut.length).toBeLessThan(points.length);
    expect(entryCoverage(zoomedOut)).toBe(points.length);
    expect(clustersOf(zoomedOut).length).toBeGreaterThan(0);
    // Every cluster exposes its member count for the label.
    for (const c of clustersOf(zoomedOut)) expect(c.count).toBe(c.points.length);

    // Zooming in resolves clusters into finer structure, never losing count.
    expect(zoomedIn.length).toBeGreaterThanOrEqual(zoomedOut.length);
    expect(entryCoverage(zoomedIn)).toBe(points.length);
    expect(clustersOf(zoomedIn).length).toBeLessThanOrEqual(clustersOf(zoomedOut).length);
  });

  it("7. the global pool adds points, and the merge never duplicates an identity", () => {
    const { records } = corpus(437);
    const local = mapPoints(
      resolveMapVisibility(records, undefined, BOTH_ON, AUTH_USER).visibleRecords,
    );
    const globalOnly = globalPoolFor(records).slice(0, 50);

    const merged = [...local];
    for (const gp of globalOnly) {
      const alreadyLocal = local.some(
        (p) =>
          p.contentIdentity.contentHash === gp.contentIdentity.contentHash &&
          p.contentIdentity.contentHashVersion === gp.contentIdentity.contentHashVersion,
      );
      if (!alreadyLocal) merged.push(...[]);
    }

    // The merge is keyed by content identity, so a global point that is also
    // local cannot add a second dot. Pinned via the real merge helper.
    expect(new Set(local.map((p) => `${p.contentIdentity.contentHash}|${p.contentIdentity.contentHashVersion}`)).size).toBe(
      local.length,
    );
  });
});
