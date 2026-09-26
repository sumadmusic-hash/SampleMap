#!/usr/bin/env -S npx tsx
/**
 * STEP67 — measurement over the analysed 500-sample drum corpus.
 *
 * Pure measurement over the FULL persisted SampleIndexRecords (the exact rows
 * that get hydrated into the real browser IndexedDB). It mirrors the map's own
 * view-model pipeline: mapPoints gate (status analyzed + audioFeatures),
 * canonical Sound Space point (computeCanonicalSoundSpacePoint) with the
 * persisted mapPosition as fallback, content-identity dedup — then reports
 * §10–§14 numbers.
 *
 * Usage: npx tsx scripts/step67-measure.ts [--out <dir>] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { computeCanonicalSoundSpacePoint } from "../src/analysis/soundSpaceProjector";
import {
  contentIdentityKey,
  selectRepresentative,
} from "../src/identity/audioContentIdentity";
import type { SampleIndexRecord } from "../src/persistence/indexStore";

const OUT_DIR = parseArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step67";
const PRETTY = !process.argv.includes("--json");

function parseArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function readJsonl(p: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(p)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r?.sampleId === "string") out.push(r);
    } catch {
      // torn tail
    }
  }
  return out;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i];
}

function median(nums: number[]): number {
  if (nums.length === 0) return Number.NaN;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(nums: number[]): number {
  if (nums.length === 0) return Number.NaN;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function axisStats(values: number[]): Record<string, number | string> {
  const s = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    min: round4(s[0]),
    p05: round4(percentile(s, 0.05)),
    p25: round4(percentile(s, 0.25)),
    median: round4(median(values)),
    p75: round4(percentile(s, 0.75)),
    p95: round4(percentile(s, 0.95)),
    max: round4(s[s.length - 1]),
    mean: round4(mean(values)),
    buckets: {
      under025: values.filter((v) => v < 0.25).length,
      "025to05": values.filter((v) => v >= 0.25 && v < 0.5).length,
      "05to075": values.filter((v) => v >= 0.5 && v <= 0.75).length,
      over075: values.filter((v) => v > 0.75).length,
    },
  };
}

function main() {
  const records = readJsonl(path.join(OUT_DIR, "step67-records.ndjson")) as SampleIndexRecord[];
  const corpus = readJsonl(path.join(OUT_DIR, "step67-corpus.ndjson"));
  const skipped = readJsonl(path.join(OUT_DIR, "step67-skipped.ndjson"));

  // corpus bucket map (selection category — NOT the classifier result)
  const bucketOf = new Map<string, string>();
  for (const c of corpus) bucketOf.set(c.sampleId as string, (c.bucket as string) ?? "unknown");

  // ── §10 population chain (same gates as mapPoints, STEP15I/STEP37) ────────
  const selected = corpus.length;
  const analyzed = records.filter((r) => r.status === "analyzed").length;
  const withAudio = records.filter((r) => r.status === "analyzed" && !!r.audioFeatures).length;
  const withMapPos = records.filter(
    (r) =>
      r.status === "analyzed" &&
      !!r.mapPosition &&
      typeof r.mapPosition.x === "number" &&
      typeof r.mapPosition.y === "number",
  ).length;
  const withV2 = records.filter((r) => r.status === "analyzed" && !!r.analysisV2?.soundCharacter).length;
  // canonical projection (map model source of truth)
  const projected: Array<{ sampleId: string; x: number; y: number; canonical: boolean }> = [];
  let missing = 0;
  for (const r of records) {
    if (r.status !== "analyzed" || !r.audioFeatures) continue;
    const canonical = (() => {
      try {
        return computeCanonicalSoundSpacePoint(r);
      } catch {
        return null;
      }
    })();
    const pos = canonical ?? r.mapPosition;
    if (!pos || typeof pos.x !== "number") {
      missing++;
      continue;
    }
    projected.push({ sampleId: r.sampleId, x: pos.x, y: pos.y, canonical: canonical !== null });
  }
  // dedup on content identity (production rule)
  const groups = new Map<string, string[]>();
  for (const p of projected) {
    const rec = records.find((r) => r.sampleId === p.sampleId)!;
    const key = rec.contentHash
      ? contentIdentityKey({
          contentHash: rec.contentHash,
          contentHashVersion: rec.contentHashVersion ?? "unknown",
        })
      : `legacy:${rec.sampleId}`;
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
    }
    g.push(p.sampleId);
  }
  const dedupPoints = groups.size;

  // ── §12/§13 X/Y on the MAP MODEL (deduplicated canonical/mapPos points) ──
  const representX: number[] = [];
  const representY: number[] = [];
  const byKey = new Map<string, { x: number; y: number }>();
  for (const [key, ids] of groups) {
    const repId = selectRepresentative(ids);
    const p = projected.find((x) => x.sampleId === repId)!;
    byKey.set(key, p);
    representX.push(p.x);
    representY.push(p.y);
  }
  const quadrant = (x: number, y: number): string =>
    x < 0.5 ? (y < 0.5 ? "lower-left" : "upper-left") : y < 0.5 ? "lower-right" : "upper-right";
  const quadCounts: Record<string, number> = {};
  for (let i = 0; i < representX.length; i++) {
    const q = quadrant(representX[i], representY[i]);
    quadCounts[q] = (quadCounts[q] ?? 0) + 1;
  }

  // ── §14 category table (selection buckets), representative points ─────────
  const byBucket: Record<string, { count: number; x: number[]; y: number[] }> = {};
  for (const [key, ids] of groups) {
    const repId = selectRepresentative(ids);
    const bucket = bucketOf.get(repId) ?? "unknown";
    const b = (byBucket[bucket] ??= { count: 0, x: [], y: [] });
    b.count++;
    b.x.push(byKey.get(key)!.x);
    b.y.push(byKey.get(key)!.y);
  }

  // ── §3/§4 one-shot vs loop (production `kind` from the record) ────────────
  const kindCounts: Record<string, number> = {};
  for (const r of records) {
    if (r.status !== "analyzed") continue;
    const k: string = r.kind ?? "unknown";
    kindCounts[k] = (kindCounts[k] ?? 0) + 1;
  }

  // ── STEP65 reference (whole 1439 corpus) for question B ───────────────────
  let step65: Record<string, unknown> | null = null;
  const s65 = path.join(OUT_DIR, "step65", "step65-distribution.json");
  if (fs.existsSync(s65)) {
    step65 = JSON.parse(fs.readFileSync(s65, "utf8"));
  }

  const out = {
    step: "STEP67",
    measuredAt: new Date().toISOString(),
    populationChain: {
      selected: selected,
      persistedAnalyzed: analyzed,
      withAudioFeatures: withAudio,
      withMapPosition: withMapPos,
      withSoundCharacterV2: withV2,
      projectedToMapModel: projected.length,
      unprojectableRecords: missing,
      deduplicatedMapModelPoints: dedupPoints,
    },
    dedup: {
      records: withAudio,
      distinctContentIdentities: dedupPoints,
      collisions: withAudio - dedupPoints,
    },
    oneShotVsLoop: kindCounts,
    canonicalProjection: {
      canonical: projected.filter((p) => p.canonical).length,
      mapPositionFallback: projected.filter((p) => !p.canonical).length,
    },
    mapModelX: axisStats(representX),
    mapModelY: axisStats(representY),
    quadrants: {
      "upper-left": { count: quadCounts["upper-left"] ?? 0, percent: round4(((quadCounts["upper-left"] ?? 0) / representX.length) * 100) },
      "upper-right": { count: quadCounts["upper-right"] ?? 0, percent: round4(((quadCounts["upper-right"] ?? 0) / representX.length) * 100) },
      "lower-left": { count: quadCounts["lower-left"] ?? 0, percent: round4(((quadCounts["lower-left"] ?? 0) / representX.length) * 100) },
      "lower-right": { count: quadCounts["lower-right"] ?? 0, percent: round4(((quadCounts["lower-right"] ?? 0) / representX.length) * 100) },
      rightHalfPercent: round4((((quadCounts["upper-right"] ?? 0) + (quadCounts["lower-right"] ?? 0)) / representX.length) * 100),
    },
    categories: Object.fromEntries(
      Object.entries(byBucket)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([bucket, b]) => [
          bucket,
          {
            count: b.count,
            meanX: round4(mean(b.x)),
            medianX: round4(median(b.x)),
            meanY: round4(mean(b.y)),
            medianY: round4(median(b.y)),
          },
        ]),
    ),
    skipped: skipped.length,
    skippedReasons: skipped.reduce<Record<string, number>>(
      (m, r) => ((m[(r.reason as string) ?? "UNKNOWN"] = (m[(r.reason as string) ?? "UNKNOWN"] ?? 0) + 1), m),
      {},
    ),
    step65Comparison: step65
      ? {
          step65CanonicalXMean: (step65 as Record<string, unknown>).canonicalXMean ?? undefined,
          step65CanonicalXMedian: (step65 as Record<string, unknown>).canonicalXMedian ?? undefined,
        }
      : undefined,
  };
  fs.writeFileSync(path.join(OUT_DIR, "step67-measure.json"), JSON.stringify(out, null, 2) + "\n");
  if (PRETTY) {
    console.log("═══ STEP67 MEASURE ═══");
    console.log(JSON.stringify(out, null, 1));
  } else {
    console.log(JSON.stringify(out));
  }
}

main();