#!/usr/bin/env -S npx tsx
/**
 * STEP50 — Real-population spatial-distribution audit (audit artifact ONLY).
 *
 * Measures the spatial distribution of the largest legitimate REAL analyzed
 * Audiotool corpus available to the project (1439 unique samples from the
 * STEP42/44/44.1/45 calibration corpora, all downloaded + analyzed from the
 * real Audiotool catalogue via the real pipeline) under BOTH map-coordinate
 * systems:
 *
 *   1. canonical Sound Space (SOUND_SPACE_ALGORITHM_VERSION 1.0.0) — the
 *      coordinate source the production map prefers whenever the record has a
 *      projectable V2 sound character (mapView.mapPoints →
 *      computeCanonicalSoundSpacePoint), and
 *   2. persisted `mapPosition` (map-v2 legacy) — the fallback for records
 *      without a projectable V2 character.
 *
 * It uses the PRODUCTION projector function (`computeCanonicalSoundSpacePoint`)
 * — never a re-implementation — so the measurement is faithful to the shipped
 * product math. Classification (`hier` type) is used ONLY as an analysis label
 * for class-conditioned statistics; it is never an input to coordinates.
 *
 * The script is a diagnostic, not a runtime dependency and not part of the
 * product. Deterministic given the corpus files.
 *
 * Usage:
 *   npx tsx scripts/step50-map-distribution.ts
 *
 * Output:
 *   <TMP>/step50/step50-distribution.json   — machine-readable full results
 *   <TMP>/step50/console tables             — summaries on stdout
 */
import fs from "node:fs";
import path from "node:path";
import { computeCanonicalSoundSpacePoint } from "../src/analysis/soundSpaceProjector";

const OUT_DIR = "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step50";

interface CorpusRow {
  sampleId: string;
  name: string;
  owner: string;
  /** V1 spectral centroid in Hz. */
  centroidHz: number | null;
  /** V1 spectral flatness in [0,1]. */
  flatness: number | null;
  /** V1 duration seconds. */
  durationSec: number | null;
  /** persisted legacy map-v2 position. */
  mapPosition: { x: number; y: number } | null;
  /** 8-dim V2 sound character (all dims present in this corpus). */
  soundCharacter: Record<string, number | null>;
  /** does the row carry a V2 analysis (audioFeaturesV2 / quality)? */
  hasV2: boolean;
  /** hier-v1 structure label. */
  structure: string;
  /** hier-v1 primary type (class label ONLY). */
  type: string;
}

function load(): CorpusRow[] {
  const out: CorpusRow[] = [];
  const seen = new Set<string>();
  const files = [
    "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step42/step44-analysis.ndjson",
    "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step44.1/step44.1-analysis.ndjson",
    "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step45/step45-reclass-after.ndjson",
  ];
  for (const f of files) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const d = JSON.parse(line);
      if (seen.has(d.sampleId)) continue;
      seen.add(d.sampleId);
      const v1 = d.audioFeatures ?? d.classifierFeatures ?? null;
      const hier =
        d.full ??
        d.hier ??
        d.audioOnly ??
        (d.full === undefined && d.hier === undefined ? { structure: d.kind, type: d.primaryClass } : null);
      out.push({
        sampleId: d.sampleId,
        name: d.name ?? d.sampleId,
        owner: d.owner ?? "",
        centroidHz: v1 ? v1.spectralCentroid ?? null : null,
        flatness: v1 ? v1.spectralFlatness ?? null : null,
        durationSec:
          d.audioFeatures?.duration ?? d.durationSeconds ?? v1?.duration ?? null,
        mapPosition: d.mapPosition ?? null,
        soundCharacter: d.soundCharacter ?? null,
        hasV2: !!d.audioFeaturesV2 || !!d.soundCharacterQuality,
        structure: (hier && hier.structure) || d.sampleKind || "unknown",
        type: (hier && hier.type) || d.primaryClass || (d.legacy && d.legacy.primaryClass) || "unknown",
      });
    }
  }
  return out;
}

function canonicalXY(row: CorpusRow): { x: number; y: number } | null {
  if (!row.soundCharacter) return null;
  const out = computeCanonicalSoundSpacePoint({
    sampleId: row.sampleId,
    analysisV2: {
      soundCharacter: row.soundCharacter as Parameters<
        typeof computeCanonicalSoundSpacePoint
      >[0]["analysisV2"] extends infer V2
        ? NonNullable<V2> extends infer S
          ? S
          : never
        : never,
    },
  });
  return out ? { x: out.x, y: out.y } : null;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[idx];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stats(name: string, values: number[]): Record<string, number> {
  const n = values.length;
  const s = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const at = (p: number) => quantile(s, p);
  return {
    axis: name,
    n,
    min: s[0],
    p01: at(0.01),
    p05: at(0.05),
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p95: at(0.95),
    p99: at(0.99),
    max: s[n - 1],
    mean,
    std: Math.sqrt(variance),
    range: s[n - 1] - s[0],
    spanP05P95: at(0.95) - at(0.05),
    spanP25P75: at(0.75) - at(0.25),
    unique: new Set(values.map((v) => Number(v.toFixed(3)))).size,
    boundaryBelow: values.filter((v) => v <= 0.01).length,
    boundaryAbove: values.filter((v) => v >= 0.99).length,
    exact0: values.filter((v) => v === 0).length,
    exact1: values.filter((v) => v === 1).length,
  };
}

/** Deterministic occupancy grid. */
function grid(points: Array<{ x: number; y: number }>, cols: number, rows: number) {
  const cell = new Map<string, number>();
  for (const p of points) {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(p.x * cols)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(p.y * rows)));
    const key = `${cx},${cy}`;
    cell.set(key, (cell.get(key) ?? 0) + 1);
  }
  const occupied = cell.size;
  const total = cols * rows;
  const cells = [...cell.entries()].sort((a, b) => b[1] - a[1]);
  return {
    cols,
    rows,
    occupied,
    empty: total - occupied,
    occupancyRatio: occupied / total,
    maxCellCount: cells[0][1],
    maxCellKeys: cells.slice(0, 5),
    cellsWith1: [...cell.values()].filter((c) => c === 1).length,
    cellsWith2plus: [...cell.values()].filter((c) => c >= 2).length,
  };
}

/** O(n log n) 2-D nearest-neighbour-ish density via sorted-grid approx:
 *  exact brute force nearest neighbour distances (n=1439 → ~1M ops, fine). */
function nearestNeighbour(points: Array<{ x: number; y: number }>) {
  const dists: number[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      const dd = dx * dx + dy * dy;
      if (dd < best) best = dd;
    }
    dists.push(Math.sqrt(best));
  }
  const s = [...dists].sort((a, b) => a - b);
  return {
    median: quantile(s, 0.5),
    p05: quantile(s, 0.05),
    p95: quantile(s, 0.95),
    min: s[0],
    max: s[s.length - 1],
    mean: dists.reduce((a, b) => a + b, 0) / n,
  };
}

function fmt(x: number, d = 4): string {
  return Number(x).toFixed(d);
}

function printStat(name: string, s: Record<string, number>): void {
  console.log(
    `${name.padEnd(18)} n=${String(s.n).padStart(4)} min=${fmt(s.min)} p01=${fmt(s.p01)} p05=${fmt(
      s.p05,
    )} p25=${fmt(s.p25)} p50=${fmt(s.p50)} p75=${fmt(s.p75)} p95=${fmt(s.p95)} p99=${fmt(
      s.p99,
    )} max=${fmt(s.max)} mean=${fmt(s.mean)} std=${fmt(s.std)}\n` +
      `  range=${fmt(s.range, 5)} span(p05-p95)=${fmt(s.spanP05P95, 5)} span(p25-p75)=${fmt(
        s.spanP25P75,
        5,
      )} unique(res3)=${s.unique} near-bottom(<.01)=${s.boundaryBelow} near-top(>.99)=${s.boundaryAbove} exact0=${s.exact0} exact1=${s.exact1}`,
  );
}

const rows = load();
console.log(`\n=== STEP50 real-population audit ===`);
console.log(`unique samples: ${rows.length}`);
const structures: Record<string, number> = {};
for (const r of rows) structures[r.structure] = (structures[r.structure] ?? 0) + 1;
console.log("structure:", structures);
const hasV2n = rows.filter((r) => r.hasV2).length;
console.log(`hasV2 (analysisV2-style): ${hasV2n}/${rows.length}`);

const canonical: Array<{ x: number; y: number }> = [];
const persisted: Array<{ x: number; y: number }> = [];
const withType = new Map<string, Array<{ x: number; y: number }>>();
const withStructure = new Map<
  string,
  Array<{ x: number; y: number }>
>();

for (const r of rows) {
  const c = canonicalXY(r);
  if (c) {
    canonical.push(c);
    withType.set(r.type, [...(withType.get(r.type) ?? []), c]);
    withStructure.set(r.structure, [...(withStructure.get(r.structure) ?? []), c]);
  }
  if (r.mapPosition) persisted.push(r.mapPosition);
}

console.log(`\ncanonical sound-space projected: ${canonical.length}`);
console.log(`persisted map-v2 positions: ${persisted.length}`);

console.log("\n=== X distribution (canonical sound space) ===");
const cX = stats("x", canonical.map((p) => p.x));
const cY = stats("y", canonical.map((p) => p.y));
printStat("x (canonical)", cX);
console.log("\n=== Y distribution (canonical sound space) ===");
printStat("y (canonical)", cY);

console.log("\n=== X distribution (persisted map-v2) ===");
const pX = stats("x", persisted.map((p) => p.x));
const pY = stats("y", persisted.map((p) => p.y));
printStat("x (persisted)", pX);
console.log("\n=== Y distribution (persisted map-v2) ===");
printStat("y (persisted)", pY);

console.log("\n=== raw V1 feature dynamics (input range reference) ===");
const cents = rows
  .map((r) => r.centroidHz)
  .filter((v): v is number => v !== null && Number.isFinite(v));
const flats = rows
  .map((r) => r.flatness)
  .filter((v): v is number => v !== null && Number.isFinite(v));
const durs = rows
  .map((r) => r.durationSec)
  .filter((v): v is number => v !== null && Number.isFinite(v));
printStat("centroidHz", stats("centroidHz", cents));
printStat("flatness", stats("flatness", flats));
printStat("durationSec", stats("durationSec", durs));

console.log("\n=== occupancy grid 20x13 (canonical) ===");
const g = grid(canonical, 20, 13);
console.log(JSON.stringify(g));

console.log("\n=== occupancy grid 20x13 (persisted map-v2) ===");
const gp = grid(persisted, 20, 13);
console.log(JSON.stringify(gp));

console.log("\n=== nearest-neighbour (canonical, n = "
  + canonical.length + ") ===");
const nnC = nearestNeighbour(canonical);
console.log(JSON.stringify(nnC));
console.log("\n=== nearest-neighbour (persisted, n = "
  + persisted.length + ") ===");
const nnP = nearestNeighbour(persisted);
console.log(JSON.stringify(nnP));

console.log("\n=== class-conditioned (canonical), min n = 25 ===");
const classRows: Record<string, unknown> = {};
for (const [cls, pts] of [...withType.entries()].sort()) {
  if (pts.length < 25) continue;
  const mx = stats("x", pts.map((p) => p.x));
  const my = stats("y", pts.map((p) => p.y));
  classRows[cls] = {
    n: pts.length,
    meanX: mx.mean,
    stdX: mx.std,
    p50X: mx.p50,
    p05X: mx.p05,
    p95X: mx.p95,
    meanY: my.mean,
    stdY: my.std,
    p50Y: my.p50,
    p05Y: my.p05,
    p95Y: my.p95,
    centroidMeanHz: stats("c", cents).mean,
  };
  console.log(
    `${cls.padEnd(12)} n=${String(pts.length).padStart(3)} meanX=${fmt(mx.mean)} (p05..p95 ${fmt(
      mx.p05,
    )}..${fmt(mx.p95)}) meanY=${fmt(my.mean)} (p05..p95 ${fmt(my.p05)}..${fmt(my.p95)}) stdX=${fmt(
      mx.std,
    )} stdY=${fmt(my.std)}`,
  );
}

console.log("\n=== structure-conditioned (canonical) ===");
for (const [st, pts] of [...withStructure.entries()].sort()) {
  const mx = stats("x", pts.map((p) => p.x));
  const my = stats("y", pts.map((p) => p.y));
  console.log(
    `${st.padEnd(16)} n=${String(pts.length).padStart(4)} meanX=${fmt(mx.mean)} meanY=${fmt(
      my.mean,
    )} p05X=${fmt(mx.p05)} p95X=${fmt(mx.p95)} p05Y=${fmt(my.p05)} p95Y=${fmt(my.p95)}`,
  );
}

console.log("\n=== drum drumness: canonical cX of drums vs musical vs other ===");
function hub(typePrefix: string): { n: number; meanX: number; meanY: number } | null {
  const pts = [...withType.entries()]
    .filter(([t]) =>
      typePrefix === "drums"
        ? ["kick", "snare", "clap", "hihat", "openhat", "tom", "cymbal", "percussion"].includes(t)
        : t === typePrefix,
    )
    .flatMap(([, v]) => v);
  if (pts.length === 0) return null;
  return { n: pts.length, meanX: stats("x", pts.map((p) => p.x)).mean, meanY: stats("y", pts.map((p) => p.y)).mean };
}
for (const k of ["kick", "snare", "clap", "hihat", "openhat", "tom", "percussion"]) {
  const x = hub(k);
  console.log(k, x ? JSON.stringify(x) : "n/a");
}

// Determinism + metadata-independence demonstration on a concrete record.
const probe = rows[0];
const c1 = canonicalXY(probe)!;
const c2 = canonicalXY({ ...probe, name: "renamed!!", type: "piano", owner: "someone-else" })!;
const c3 = canonicalXY(probe)!;
const det = c1.x === c2.x && c1.y === c2.y && c1.x === c3.x && c1.y === c3.y;
console.log("\n=== projection correctness on first record", probe.sampleId, "===");
console.log("deterministic (+ classification/name/owner perturbation):", det);
console.log("coords:", JSON.stringify(c1));

// metadata-independence across the whole corpus: perturb all, expect all equal.
let allStable = true;
for (const r of rows) {
  const a = canonicalXY(r)!;
  const b = canonicalXY({ ...r, name: "-", owner: "-", type: "other", structure: "loop" })!;
  if (a.x !== b.x || a.y !== b.y) {
    allStable = false;
    break;
  }
}
console.log("metadata-independence (name/owner/class/structure perturbed), all n:", allStable);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, "step50-distribution.json"),
  JSON.stringify(
    {
      corpus: { unique: rows.length, structures, hasV2: hasV2n, canonicalProjected: canonical.length, persistedPositions: persisted.length },
      xCanonical: cX,
      yCanonical: cY,
      xPersisted: pX,
      yPersisted: pY,
      centroidHz: stats("centroidHz", cents),
      flatness: stats("flatness", flats),
      durationSec: stats("durationSec", durs),
      gridCanonical: g,
      gridPersisted: gp,
      nnCanonical: nnC,
      nnPersisted: nnP,
      classRows,
      metadataIndependence: allStable,
    },
    null,
    2,
  ),
);
console.log("\nwritten:", path.join(OUT_DIR, "step50-distribution.json"));