#!/usr/bin/env -S npx tsx
/**
 * STEP44.1 — Reference Corpus Evaluation & Metrics.
 *
 * Pure, deterministic (no network) evaluation over step44.1-analysis.ndjson.
 * Produces the §16–§24 table plus step44.1-summary.json.
 *
 * Metric definitions (from the STEP44.1 spec):
 *  - AUDIO_AGREEMENT (primary): acoustic-only TYPE == reference (per class + all).
 *  - FULL_AGREEMENT: full-reconciliation TYPE == reference (reported separately).
 *  - TAG_RESCUE (NOT accuracy): acoustic-only wrong/ambiguous AND the specific
 *    TAG reaches the reference in the full run.
 *  - TAG_AUDIO_CONFLICT: metadata reference exists AND audio is STRONG
 *    (!audioAmbiguous) AND audioType != reference → candidat manual review.
 *  - Drum confusion matrix: reference vs acoustic-only type.
 *  - Ultra-short: audio duration <= 0.35 and (0.35, 0.5] — verified never
 *    auto-kicks structure; kick precision/recall; per-class accuracy; ambiguous
 *    rate.
 *  - Long one-shots: > 2.5s and > 4s — structure must still be one-shot and
 *    type classification possible.
 *  - Loop validation: structure == loop for ALL; family/type never erased.
 *  - Confidence: distribution by correctness / ambiguity / reconciliation
 *    status. low-but-correct → calibration issue; high-on-incorrect → serious.
 *  - Coherence: hier.family must equal familyOfType(hier.type) (STEP44.1 fix
 *    regression check).
 *
 * Usage: npx tsx scripts/step44.1-eval.ts [--out <dir>] [--an <analysis.ndjson>]
 */
import fs from "node:fs";
import path from "node:path";
import { familyOfType } from "../src/classify/hier/evidence";

const OUT_DIR = parseArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step44.1";
const ANALYSIS_PATH = parseArg("--an") ?? path.join(OUT_DIR, "step44.1-analysis.ndjson");

const ULTRA_SHORT_BIN1 = 0.35;
const ULTRA_SHORT_BIN2 = 0.5;
const LONG_BIN1 = 2.5;
const LONG_BIN2 = 4.0;

interface Row {
  corpusRole: string;
  sampleId: string;
  name: string;
  referenceClass: string | null;
  referenceTier: string | null;
  originalTags: string[];
  metadataDurationSeconds: number;
  audioFeatures: Record<string, number>;
  audioOnly: {
    structure: string; family: string; type: string; confidence: number; ambiguous: boolean;
  };
  full: {
    structure: string; family: string; type: string; confidence: number; ambiguous: boolean;
    reconciliationStatus: string; reconciliationWinningSource: string; tagType?: string | null;
    nameType?: string | null; audioType?: string | null;
  };
  legacy?: { primaryClass: string; confidence: number };
}

function parseArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function load(): Row[] {
  const out: Row[] = [];
  for (const line of fs.readFileSync(ANALYSIS_PATH, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind !== "analysis" || !r.audioOnly || !r.full) continue;
      out.push(r);
    } catch {
      // torn tail
    }
  }
  return out;
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function confBucket(rows: Row[], sel: (r: Row) => boolean): Record<string, number> {
  const cf = rows.filter(sel).map((r) => r.audioOnly.confidence);
  return {
    n: cf.length,
    mean: round3(mean(cf)),
    min: cf.length ? round3(Math.min(...cf)) : 0,
    max: cf.length ? round3(Math.max(...cf)) : 0,
  };
}

export function evaluate(rowsIn: Row[]): Record<string, unknown> {
  const rows = rowsIn.filter((r) => r.corpusRole === "reference");
  const loops = rowsIn.filter((r) => r.corpusRole === "loop-validation");
  const n = rows.length;

  // ── per-class agreement ────────────────────────────────────────────────────
  const byClass: Record<string, Row[]> = {};
  for (const r of rows) (byClass[r.referenceClass ?? "@null"] ??= []).push(r);

  const perClass: Record<string, unknown> = {};
  for (const [clazz, rs] of Object.entries(byClass)) {
    const audioOk = rs.filter((r) => r.audioOnly.type === clazz).length;
    const fullOk = rs.filter((r) => r.full.type === clazz).length;
    const dur = rs.map((r) => r.audioFeatures.duration ?? r.metadataDurationSeconds);
    perClass[clazz] = {
      n: rs.length,
      audioAgreement: round3(audioOk / rs.length),
      fullAgreement: round3(fullOk / rs.length),
      audioAmbiguousRate: round3(rs.filter((r) => r.audioOnly.ambiguous).length / rs.length),
      medianDuration: round3([...dur].sort((a, b) => a - b)[Math.floor(dur.length / 2)] ?? 0),
    };
  }

  const audioAgreementTotal = round3(rows.filter((r) => r.audioOnly.type === r.referenceClass).length / n);
  const fullAgreementTotal = round3(rows.filter((r) => r.full.type === r.referenceClass).length / n);

  // ── TAG_RESCUE ─────────────────────────────────────────────────────────────
  const rescueRows = rows.filter(
    (r) =>
      (r.audioOnly.type !== r.referenceClass || r.audioOnly.ambiguous) &&
      r.full.type === r.referenceClass &&
      r.full.tagType === r.referenceClass,
  );
  const rescueRc: Record<string, number> = {};
  for (const r of rescueRows) rescueRc[r.referenceClass!] = (rescueRc[r.referenceClass!] ?? 0) + 1;

  // ── TAG_AUDIO_CONFLICT (metadata ref vs STRONG audio) ──────────────────────
  const conflictRows = rows.filter(
    (r) => !r.audioOnly.ambiguous && r.audioOnly.type !== r.referenceClass && r.referenceClass !== null,
  );
  const conflictExamples = conflictRows
    .slice(0, 15)
    .map((r) => ({
      sampleId: r.sampleId,
      name: r.name,
      referenceClass: r.referenceClass,
      audioType: r.audioOnly.type,
      audioConfidence: r.audioOnly.confidence,
      fullType: r.full.type,
      reconciliation: r.full.reconciliationStatus,
      tags: r.originalTags,
    }));

  // ── drum confusion matrix (all rows, focused output) ───────────────────────
  const DRUMS = ["kick", "snare", "clap", "hihat", "openhat", "tom", "cymbal", "percussion"];
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    (confusion[r.referenceClass ?? "@null"] ??= {})[r.audioOnly.type] =
      (confusion[r.referenceClass ?? "@null"]?.[r.audioOnly.type] ?? 0) + 1;
  }
  const drumConfusion: Record<string, Record<string, number>> = {};
  for (const ref of DRUMS) {
    const row = confusion[ref] ?? {};
    drumConfusion[ref] = Object.fromEntries(DRUMS.map((t) => [t, row[t] ?? 0]));
  }
  // targeted pairs the spec calls out (reference → misread-as)
  const pair = (p: number, q: number) => (drumConfusion[p]?.[q] ?? 0);

  // ── ultra-short & long one-shot splits ─────────────────────────────────────
  const dur = (r: Row) => r.audioFeatures.duration ?? r.metadataDurationSeconds;
  const ultra1 = rows.filter((r) => dur(r) <= ULTRA_SHORT_BIN1);
  const ultra2 = rows.filter((r) => dur(r) > ULTRA_SHORT_BIN1 && dur(r) <= ULTRA_SHORT_BIN2);
  const long1 = rows.filter((r) => dur(r) > LONG_BIN1);
  const long2 = rows.filter((r) => dur(r) > LONG_BIN2);

  const splitMetrics = (rs: Row[]) => {
    const k = rs.length;
    const ok = rs.filter((r) => r.audioOnly.type === r.referenceClass).length;
    const kicksRef = rs.filter((r) => r.referenceClass === "kick");
    const kicksPred = rs.filter((r) => r.audioOnly.type === "kick");
    const kickTP = rs.filter((r) => r.referenceClass === "kick" && r.audioOnly.type === "kick").length;
    const perClassAcc: Record<string, number> = {};
    for (const r of rs) {
      if (!r.referenceClass) continue;
      const rowsC = rs.filter((x) => x.referenceClass === r.referenceClass);
      const acc = rowsC.filter((x) => x.audioOnly.type === r.referenceClass).length / rowsC.length;
      perClassAcc[r.referenceClass] = round3(acc);
    }
    return {
      n: k,
      audioAgreement: round3(ok / Math.max(1, k)),
      kickPrecision: round3(kickTP / Math.max(1, kicksPred.length)),
      kickRecall: round3(kickTP / Math.max(1, kicksRef.length)),
      ambiguousRate: round3(rs.filter((r) => r.audioOnly.ambiguous).length / Math.max(1, k)),
      structureNotLoop: rs.filter((r) => r.audioOnly.structure !== "loop").length,
      perClassAccuracy: perClassAcc,
    };
  };

  // ── loop validation ────────────────────────────────────────────────────────
  const loopStructureOk = loops.filter((r) => r.audioOnly.structure === "loop" && r.full.structure === "loop").length;
  const loopFamilyErased = loops.filter((r) => r.full.family === "unknown" || r.full.type === "other").length;
  const loopFamilyDist: Record<string, number> = {};
  const loopTypeDist: Record<string, number> = {};
  for (const r of loops) {
    loopFamilyDist[r.full.family] = (loopFamilyDist[r.full.family] ?? 0) + 1;
    loopTypeDist[r.full.type] = (loopTypeDist[r.full.type] ?? 0) + 1;
  }

  // ── confidence distributions ───────────────────────────────────────────────
  const confByCorrect = {
    correct: confBucket(rows, (r) => r.audioOnly.type === r.referenceClass),
    incorrect: confBucket(rows, (r) => r.audioOnly.type !== r.referenceClass),
  };
  const confByAmbiguity = {
    ambiguous: confBucket(rows, (r) => r.audioOnly.ambiguous),
    notAmbiguous: confBucket(rows, (r) => !r.audioOnly.ambiguous),
  };
  const confByRecon: Record<string, Record<string, number>> = {};
  for (const s of ["AGREE", "TAG-SUPPORTED", "AUDIO-SUPPORTED", "CONFLICT", "UNKNOWN"]) {
    confByRecon[s] = confBucket(rows, (r) => r.full.reconciliationStatus === s);
  }
  // calibration flags
  const lowButCorrect = rows.filter((r) => r.audioOnly.type === r.referenceClass && r.audioOnly.confidence < 0.2).length;
  const highOnIncorrect = rows.filter((r) => r.audioOnly.type !== r.referenceClass && r.audioOnly.confidence >= 0.5).length;

  // ── coherence (family must equal familyOfType(type)) ───────────────────────
  let coherent = 0;
  const incoherentExamples: Array<Record<string, unknown>> = [];
  for (const r of rowsIn) {
    if (familyOfType(r.full.type) === r.full.family) coherent++;
    else if (incoherentExamples.length < 12)
      incoherentExamples.push({
        sampleId: r.sampleId, name: r.name, role: r.corpusRole,
        family: r.full.family, type: r.full.type, reconcil: r.full.reconciliationStatus,
      });
  }

  // ── reconciliation status distribution ─────────────────────────────────────
  const reconDist: Record<string, number> = {};
  for (const r of rows) reconDist[r.full.reconciliationStatus] = (reconDist[r.full.reconciliationStatus] ?? 0) + 1;

  // ── full-layer confidence (decision-relevant: by full correctness/ambiguity) ─
  const fullConfBucket = (sel: (r: Row) => boolean): Record<string, number> => {
    const cf = rows.filter(sel).map((r) => r.full.confidence);
    return {
      n: cf.length,
      mean: round3(mean(cf)),
      min: cf.length ? round3(Math.min(...cf)) : 0,
      max: cf.length ? round3(Math.max(...cf)) : 0,
    };
  };
  const fullConfByCorrect = {
    correct: fullConfBucket((r) => r.full.type === r.referenceClass),
    incorrect: fullConfBucket((r) => r.full.type !== r.referenceClass),
  };
  const fullConfByAmbiguity = {
    ambiguous: fullConfBucket((r) => r.full.ambiguous),
    notAmbiguous: fullConfBucket((r) => !r.full.ambiguous),
  };
  const fullConfByRecon: Record<string, Record<string, number>> = {};
  for (const st of ["AGREE", "TAG-SUPPORTED", "AUDIO-SUPPORTED", "CONFLICT", "UNKNOWN"]) {
    fullConfByRecon[st] = fullConfBucket((r) => r.full.reconciliationStatus === st);
  }
  const fullLowButCorrect = rows.filter((r) => r.full.type === r.referenceClass && r.full.confidence < 0.2).length;
  const fullHighOnIncorrect = rows.filter((r) => r.full.type !== r.referenceClass && r.full.confidence >= 0.5).length;

  // ── per-tier full agreement (reference quality effect) ─────────────────────
  const byTier: Record<string, number> = {};
  for (const r of rows) {
    if (!r.referenceTier) continue;
    const ok = r.full.type === r.referenceClass ? 1 : 0;
    byTier[r.referenceTier] = (byTier[r.referenceTier] ?? 0) + ok;
    byTier[r.referenceTier + "#n"] = (byTier[r.referenceTier + "#n"] ?? 0) + 1;
  }
  const tierAgreement: Record<string, Record<string, number>> = {};
  for (const [k, v] of Object.entries(byTier)) {
    if (k.endsWith("#n")) continue;
    const band = k + "#n";
    tierAgreement[k] = { n: byTier[band] ?? 0, fullAgreement: round3(v / Math.max(1, byTier[band] ?? 0)) };
  }
  tierAgreement.order = ["A", "B", "C"];

  return {
    n,
    loopValidationN: loops.length,
    audioAgreement: audioAgreementTotal,
    fullAgreement: fullAgreementTotal,
    perClass,
    tagRescue: { n: rescueRows.length, byClass: rescueRc },
    tagAudioConflict: { n: conflictRows.length, examples: conflictExamples },
    drumConfusion: {
      kickToHihat: pair("kick", "hihat"),
      kickToSnare: pair("kick", "snare"),
      hihatToKick: pair("hihat", "kick"),
      openhatToHihat: pair("openhat", "hihat"),
      clapToSnare: pair("clap", "snare"),
      cymbalToOpenhat: pair("cymbal", "openhat"),
      matrix: drumConfusion,
    },
    ultraShort: {
      threshold: ULTRA_SHORT_BIN1,
      leBin: splitMetrics(ultra1),
      between: { thresholdLow: ULTRA_SHORT_BIN1, thresholdHigh: ULTRA_SHORT_BIN2, ...splitMetrics(ultra2) },
      verifiedNeverAutoKick: ultra1.filter((r) => r.audioOnly.structure !== "one-shot" && r.audioOnly.structure !== "sustained-phrase").length,
    },
    longOneShot: {
      gtBin1: splitMetrics(long1),
      gtBin2: splitMetrics(long2),
      structureNotLoopGTBin1: long1.filter((r) => r.audioOnly.structure === "loop").length,
      structureNotLoopGTBin2: long2.filter((r) => r.audioOnly.structure === "loop").length,
    },
    loopValidation: {
      n: loops.length,
      structureAlwaysLoop: loopStructureOk,
      familyOrTypeErased: loopFamilyErased,
      bandHints: { in: loops.filter((r) => r.loopBand).length },
      familyDistribution: loopFamilyDist,
      typeDistribution: loopTypeDist,
    },
    confidence: {
      byCorrectness: confByCorrect,
      byAmbiguity: confByAmbiguity,
      byReconciliationStatus: confByRecon,
      calibrationFlags: { lowButCorrect, highOnIncorrect },
    },
    reconciliationDistribution: reconDist,
    fullConfidence: {
      byCorrectness: fullConfByCorrect,
      byAmbiguity: fullConfByAmbiguity,
      byReconciliationStatus: fullConfByRecon,
      calibrationFlags: { lowButCorrect: fullLowButCorrect, highOnIncorrect: fullHighOnIncorrect },
    },
    tierFullAgreement: tierAgreement,
    coherence: { matched: coherent, total: rowsIn.length, rate: round3(coherent / Math.max(1, rowsIn.length)), incoherentExamples },
  };
}

function printTable(name: string, e: Record<string, unknown>): void {
  console.log(`\n=== ${name} ===`);
  console.log(`n=${e.n} AUDIO_AGREEMENT=${e.audioAgreement} FULL_AGREEMENT=${e.fullAgreement}`);
  console.log("\n| referenceClass | n | audioAgree | fullAgree | audioAmbig | medDur |");
  console.log("|---|---|---|---|---|---|");
  const perClass = e.perClass as Record<string, Record<string, number>>;
  for (const [c, v] of Object.entries(perClass)) {
    console.log(`| ${c} | ${v.n} | ${v.audioAgreement} | ${v.fullAgreement} | ${v.audioAmbiguousRate} | ${v.medianDuration} |`);
  }
  const tr = e.tagRescue as { n: number; byClass: Record<string, number> };
  console.log(`\nTAG_RESCUE n=${tr.n} byClass=${JSON.stringify(tr.byClass)}`);
  const tc = e.tagAudioConflict as { n: number };
  console.log(`TAG_AUDIO_CONFLICT n=${tc.n} (see summary.json examples)`);
  const dc = e.drumConfusion as Record<string, unknown>;
  console.log("\nDRUM CONFUSION pairs kick→hihat=%s kick→snare=%s hihat→kick=%s openhat→hihat=%s clap→snare=%s cymbal→openhat=%s",
    dc.kickToHihat, dc.kickToSnare, dc.hihatToKick, dc.openhatToHihat, dc.clapToSnare, dc.cymbalToOpenhat);
  const us = e.ultraShort as Record<string, Record<string, unknown>>;
  console.log(`\nULTRA-SHORT <=0.35: n=${us.leBin.n} agree=${us.leBin.audioAgreement} kickP=${us.leBin.kickPrecision} kickR=${us.leBin.kickRecall} amb=${us.leBin.ambiguousRate} notLoop=${us.leBin.structureNotLoop}`);
  console.log(`ULTRA-SHORT 0.35-0.5: n=${us.between.n} agree=${us.between.audioAgreement} kickP=${us.between.kickPrecision} kickR=${us.between.kickRecall} amb=${us.between.ambiguousRate} notLoop=${us.between.structureNotLoop}`);
  const lo = e.longOneShot as Record<string, Record<string, unknown>>;
  console.log(`\nLONG >2.5: n=${lo.gtBin1.n} agree=${lo.gtBin1.audioAgreement} amb=${lo.gtBin1.ambiguousRate} loops=${lo.structureNotLoopGTBin1}`);
  console.log(`LONG >4: n=${lo.gtBin2.n} agree=${lo.gtBin2.audioAgreement} amb=${lo.gtBin2.ambiguousRate} loops=${lo.structureNotLoopGTBin2}`);
  const lv = e.loopValidation as Record<string, unknown>;
  console.log(`\nLOOP VALIDATION n=${lv.n} structureAlwaysLoop=${lv.structureAlwaysLoop} familyOrTypeErased=${lv.familyOrTypeErased} familyDist=${JSON.stringify(lv.familyDistribution)}`);
  const cf = e.confidence as Record<string, Record<string, Record<string, number>>>;
  console.log(`\nCONF correct=${JSON.stringify(cf.byCorrectness.correct)} incorrect=${JSON.stringify(cf.byCorrectness.incorrect)}`);
  console.log(`CONF recon=${JSON.stringify(cf.byReconciliationStatus)}`);
  console.log(`CALIBRATION FLAGS lowButCorrect=${cf.calibrationFlags.lowButCorrect} highOnIncorrect=${cf.calibrationFlags.highOnIncorrect}`);
  const coh = e.coherence as Record<string, unknown>;
  console.log(`\nCOHERENCE family==familyOfType(type): ${coh.matched}/${coh.total} (${coh.rate})`);
  const rd = e.reconciliationDistribution as Record<string, number>;
  console.log(`RECONCILIATION ${JSON.stringify(rd)}`);
}

function main() {
  const rows = load();
  if (rows.length === 0) {
    console.error("no step44.1 analysis rows found");
    process.exit(1);
  }
  const evaluation = evaluate(rows);
  const summary = {
    audit: "STEP44.1 targeted one-shot reference corpus metrics",
    classifierVersion: "hier-v1",
    classifierVersionNote: "hier-v1 includes the STEP44.1 family/type coherence fix (family always follows the decided type on tag/name adoption); type + confidence logic unchanged",
    generatedAt: new Date().toISOString(),
    analysisRows: rows.length,
    corpusSource: ANALYSIS_PATH,
    ...evaluation,
  };
  fs.writeFileSync(path.join(OUT_DIR, "step44.1-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  printTable("STEP44.1 metrics", evaluation);
}

main();