#!/usr/bin/env -S npx tsx
/**
 * STEP45 — Metrics runner: BEFORE / AFTER / DELTA over the SAME rows.
 *
 * Reuses the step44.1 `evaluate()` metric definitions verbatim (AUDIO_AGREEMENT
 * etc.) so STEP45 is directly comparable to STEP44.1. BEFORE = the stored STEP45
 * analysis rows (as analysed with the ORIGINAL hier-v1). AFTER = the same rows
 * re-run offline with the STEP45 calibration (step45-reclass-after.ndjson).
 *
 * Usage:
 *   npx tsx scripts/step45-metrics.ts --before <analysis.ndjson> --after <reclass-after.ndjson>
 *   Emits <dir>/step45-summary.json (+ prints the per-class BEFORE/AFTER/DELTA table).
 */
import fs from "node:fs";
import path from "node:path";
import { evaluate } from "./step44.1-eval";

const BEFORE_PATH = parseArg("--before") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step45/step45-analysis.ndjson";
const AFTER_PATH = parseArg("--after") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step45/step45-reclass-after.ndjson";
const OUT_DIR = parseArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step45";

function parseArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function loadRows(p: string): ReturnType<typeof evaluate>[] {
  const rows: any[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind !== "analysis" || !r.audioOnly || !r.full) continue;
      rows.push(r);
    } catch {
      // torn tail
    }
  }
  return rows;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function main() {
  if (!fs.existsSync(BEFORE_PATH) || !fs.existsSync(AFTER_PATH)) {
    console.error("before/after files must exist");
    process.exit(1);
  }
  const beforeRows = loadRows(BEFORE_PATH);
  const afterRows = loadRows(AFTER_PATH);
  if (beforeRows.length !== afterRows.length) {
    console.error(`row-count mismatch before=${beforeRows.length} after=${afterRows.length}`);
    process.exit(1);
  }
  const sameIds =
    beforeRows.every((b, i) => b.sampleId === afterRows[i].sampleId) &&
    afterRows.every((a, i) => a.sampleId === beforeRows[i].sampleId);
  if (!sameIds) {
    console.error("before/after rows are not the SAME set (sampleId order mismatch)");
    process.exit(1);
  }

  // Offline-fidelity: the classifier-INDEPENDENT layers (structure for both
  // modes + Mode-A family) reproduce offline on 630/630 rows (noop gate). The
  // earlier "5 rows excluded" diagnosis misread reconciliation-sensitive Mode-B
  // `family` as input drift; those rows reproduce exactly and are legitimately
  // calibration effects (§classify family-follows-type). FULL delta therefore
  // measures all 630 rows. `--exclude-b` remains available for experiments.
  const excludeB = process.argv.includes("--exclude-b")
    ? new Set(JSON.parse(parseArg("--exclude-ids") ?? "[]") as string[])
    : new Set<string>();
  const before625 = beforeRows.filter((r) => !excludeB.has(r.sampleId));
  const after625 = afterRows.filter((r) => !excludeB.has(r.sampleId));

  const before = evaluate(beforeRows);
  const after = evaluate(afterRows);
  const beforeFull = evaluate(before625);
  const afterFull = evaluate(after625);

  const perClassBefore = before.perClass as Record<string, Record<string, number>>;
  const perClassAfter = after.perClass as Record<string, Record<string, number>>;
  const perClassBeforeFull = beforeFull.perClass as Record<string, Record<string, number>>;
  const perClassAfterFull = afterFull.perClass as Record<string, Record<string, number>>;
  const allClasses = Array.from(
    new Set([...Object.keys(perClassBefore), ...Object.keys(perClassAfter)]),
  ).sort();

  const perClassDelta: Record<string, Record<string, number>> = {};
  for (const c of allClasses) {
    const b = perClassBefore[c] ?? { n: 0, audioAgreement: 0, fullAgreement: 0, audioAmbiguousRate: 0, medianDuration: 0 };
    const a = perClassAfter[c] ?? { n: 0, audioAgreement: 0, fullAgreement: 0, audioAmbiguousRate: 0, medianDuration: 0 };
    const bf = perClassBeforeFull[c] ?? { n: 0, fullAgreement: 0 };
    const af = perClassAfterFull[c] ?? { n: 0, fullAgreement: 0 };
    perClassDelta[c] = {
      n: a.n ?? b.n,
      audioAgreementBefore: b.audioAgreement,
      audioAgreementAfter: a.audioAgreement,
      audioAgreementDelta: round3((a.audioAgreement ?? 0) - (b.audioAgreement ?? 0)),
      fullAgreementBefore: bf.fullAgreement,
      fullAgreementAfter: af.fullAgreement,
      fullAgreementDelta: round3((af.fullAgreement ?? 0) - (bf.fullAgreement ?? 0)),
      audioAmbiguousRateBefore: b.audioAmbiguousRate,
      audioAmbiguousRateAfter: a.audioAmbiguousRate,
      audioAmbiguousDelta: round3((a.audioAmbiguousRate ?? 0) - (b.audioAmbiguousRate ?? 0)),
    };
  }

  const summary = {
    audit: "STEP45 before/after metrics — same rows, same audio, offline reclassify",
    generatedAt: new Date().toISOString(),
    n: beforeRows.length,
    fullConsistentN: before625.length,
    fullConsistentExcluded: beforeRows.length - before625.length,
    fullConsistentNote:
      "FULL delta measured on all 630 rows (same inputs, same audio). The Mode-B family-follows-type change is a calibration effect, not input drift; offline fidelity gate reproduces structure both modes + Mode-A family on 630/630.",
    audioAgreement: {
      before: before.audioAgreement,
      after: after.audioAgreement,
      delta: round3((after.audioAgreement as number) - (before.audioAgreement as number)),
    },
    fullAgreement: {
      before: beforeFull.fullAgreement,
      after: afterFull.fullAgreement,
      delta: round3((afterFull.fullAgreement as number) - (beforeFull.fullAgreement as number)),
    },
    confidence: {
      before: before.confidence,
      after: after.confidence,
    },
    perClassDelta,
    before,
    after,
  };
  const out = path.join(OUT_DIR, "step45-summary.json");
  fs.writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
  console.log(`wrote ${out}`);

  console.log(`\n=== STEP45 BEFORE → AFTER (n=${beforeRows.length}) ===`);
  console.log(`AUDIO_AGREEMENT ${before.audioAgreement} → ${after.audioAgreement}  (Δ ${round3((after.audioAgreement as number) - (before.audioAgreement as number))})`);
  console.log(`FULL_AGREEMENT  ${beforeFull.fullAgreement} → ${afterFull.fullAgreement}  (Δ ${round3((afterFull.fullAgreement as number) - (beforeFull.fullAgreement as number))})  [${before625.length} rows]`);
  console.log("\n| class | n | audioBefore | audioAfter | audioΔ | fullBefore | fullAfter | fullΔ | ambBefore | ambAfter |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const c of allClasses) {
    const d = perClassDelta[c];
    console.log(`| ${c} | ${d.n} | ${d.audioAgreementBefore} | ${d.audioAgreementAfter} | ${d.audioAgreementDelta} | ${d.fullAgreementBefore} | ${d.fullAgreementAfter} | ${d.fullAgreementDelta} | ${d.audioAmbiguousRateBefore} | ${d.audioAmbiguousRateAfter} |`);
  }
}

main();