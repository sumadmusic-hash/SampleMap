#!/usr/bin/env -S npx tsx
/**
 * STEP44 evaluation — metrics table over the real STEP44 audit corpus.
 *
 * Reads `<out>/step44-analysis.ndjson` (180 rows, each carrying BOTH the
 * heuristic-v1 surface in `legacy` and the hier-v1 tree in `hier`) and prints
 * the comparison vs the documented STEP42/STEP44 baselines:
 *
 *   baseline (heuristic-v1): 60% loop-label, ~65% musical-hint->loop collapse,
 *   ultra-short one-shots auto-"kick", confidence ∈ [0.2245, 0.5791] with
 *   72.5% < 0.35, always 4 secondaries.
 *
 * Output is a markdown table for the STEP44 report; no audio, no network.
 */
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = process.argv[2] ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step42";
const rows = fs
  .readFileSync(path.join(OUT_DIR, "step44-analysis.ndjson"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

console.error(`corpus: ${rows.length} analyzed rows`);

const n = rows.length;
const pct = (x: number, d = 1) => `${((100 * x) / n).toFixed(d)}%`;

// ---- structure/kind split -------------------------------------------------
const kindCount = count(rows, (r) => r.kind);
console.error(`kinds: ${JSON.stringify(kindCount)}`);

// ---- 1) loop-classification (SC1/SC2) -------------------------------------
const loops = rows.filter((r) => r.kind === "loop");
const loopLabel = (r: Record<string, unknown>) => r.primaryClass === "loop";
const loopLegacy = (r: Record<string, unknown>) => r.legacy?.primaryClass === "loop";
const loopCollapse = rows.filter((r) => r.legacy?.primaryClass === "loop").length;
const loopCollapseHinted = rows.filter(
  (r) => r.legacy?.primaryClass === "loop" && r.originalTags?.some((t: string) => /^(music|melodic|melody|instrument|guitar|piano|bass|synth|vocal|vox|lead|pad|strings)/i.test(t)),
).length;
// structure stays loop (never mis-gated to one-shot/sustained) — count rows whose kind=loop
// and hier.structure reflects loop/respects kind.
const loopStructureOk = rows.filter((r) => r.kind === "loop" && r.hierTree?.structure === "loop").length;

// ---- 2) ultra-short one-shots and the kick bug (SC4) -----------------------
const ultraShort = rows.filter((r) => r.kind === "one-shot" && r.durationSeconds !== undefined && r.durationSeconds <= 0.5);
const legacyUltraKick = ultraShort.filter((r) => r.legacy?.primaryClass === "kick").length;
const hierUltraKick = ultraShort.filter((r) => r.primaryClass === "kick").length;
const hierUltraPerc = ultraShort.filter((r) => r.primaryClass === "percussion").length;
const hierUltraAmb = ultraShort.filter((r) => r.hierTree?.ambiguous === true).length;

// ---- 3) structurally-constrained: loops stay loops; kind=one-shot stays     --
// one-shot (never promoted to loop purely by tags) ---------------------------
const oneShots = rows.filter((r) => r.kind === "one-shot");
const oneShotAsLoop = oneShots.filter((r) => r.primaryClass === "loop").length;

// ---- 4) confidence spread (should now be a DECISION confidence) ------------
const allConf = rows.map((r) => r.hier.confidence);
const confMin = Math.min(...allConf);
const confMax = Math.max(...allConf);
const confMean = allConf.reduce((a, b) => a + b, 0) / allConf.length;
const confLT35 = allConf.filter((c) => c < 0.35).length;
const confLT30 = allConf.filter((c) => c < 0.3).length;
const legacyConfMin = Math.min(...rows.map((r) => r.legacy?.confidence ?? 1));
const legacyConfMax = Math.max(...rows.map((r) => r.legacy?.confidence ?? 0));

// ---- 5) secondary classes ------------------------------------------------
const hierSecCounts = new Map<number, number>();
for (const r of rows) {
  const k = (r.secondaryClasses ?? []).length;
  hierSecCounts.set(k, (hierSecCounts.get(k) ?? 0) + 1);
}
const legacySec4 = rows.filter((r) => (r.legacy?.secondaryClasses ?? []).length === 4).length;

// ---- 6) reconciliation + family + ambiguous -------------------------------
const recCounts = count(rows, (r) => r.hier.reconciliation.status);
const familyCounts = count(rows, (r) => r.hier.family);
const ambiguousCount = rows.filter((r) => r.hierTree?.ambiguous === true).length;
const subtypeCount = rows.filter((r) => r.hierTree?.subtype !== undefined).length;
const skinAgreeRecon = rows.filter((r) => r.hier.reconciliation.status === "AGREE").length;

// ---- 7) tag/name-vocal sanity: samples with an explicit vocal tag ----------
const vocalTagged = rows.filter((r) => r.originalTags?.some((t: string) => /^(vocal|vox|vocals|sing|rap|spok)/i.test(t)));
const vocalTaggedClassified = vocalTagged.filter((r) => ["vocal"].includes(r.primaryClass)).length;

console.log(`\n## STEP44 evaluation (corpus n=${n}, real audio via AnalysisPipeline, hier-v1 vs heuristic-v1)`);
console.log(`\n| metric | heuristic-v1 (baseline) | hier-v1 (STEP44) | target/note |`);
console.log(`|---|---|---|---|`);
console.log(`| loops labelled \`loop\` (of n_loops=${loops.length}) | ${Math.round((100 * loops.filter((r) => r.legacy?.primaryClass === "loop").length) / loops.length)}% | ${Math.round((100 * loops.filter((r) => r.primaryClass === "loop").length) / loops.length)}% | loops stay loop-label only when real (SC1) |`);
console.log(`| \`loop\` labels overall (n=${n}) | ${Math.round((100 * loopCollapse) / n)}% (${loopCollapse}) | ${Math.round((100 * rows.filter((r) => r.primaryClass === "loop").length) / n)}% (${rows.filter((r) => r.primaryClass === "loop").length}) | musical-hint→loop collapse eliminated |`);
console.log(`| loop rows whose structure stays \`loop\` (SC2) | — | ${Math.round((100 * loopStructureOk) / Math.max(1, loops.length))}% (${loopStructureOk}/${loops.length}) | kind authoritative |`);
console.log(`| ultra-short one-shots ≤0.5s → \`kick\` | ${legacyUltraKick}/${ultraShort.length} | ${hierUltraKick}/${ultraShort.length} | duration NEVER auto-kicks (SC4) |`);
console.log(`| ultra-short → \`percussion\` + ambiguous | — | ${hierUltraPerc}/${ultraShort.length} (${hierUltraAmb} ambiguous) | honest fallback over wrong certainty |`);
console.log(`| one-shots → \`loop\` | ${Math.round((100 * oneShots.filter((r) => r.legacy?.primaryClass === "loop").length) / Math.max(1, oneShots.length))}% | ${Math.round((100 * oneShotAsLoop) / Math.max(1, oneShots.length))}% | no duration/tag race on one-shots |`);
console.log(`| confidence min / max | ${legacyConfMin.toFixed(4)} / ${legacyConfMax.toFixed(4)} | ${confMin.toFixed(4)} / ${confMax.toFixed(4)} | bounded [0.05, 0.95] |`);
console.log(`| confidence mean / <0.35 / <0.30 | — / ${72.5}% / — | ${confMean.toFixed(4)} / ${Math.round((100 * confLT35) / n)}% / ${Math.round((100 * confLT30) / n)}% | honesly low when uncertain (§11) |`);
console.log(`| rows with ≥1 secondary class | — | ${Math.round((100 * [...hierSecCounts.entries()].filter(([k]) => k > 0).reduce((a, [, c]) => a + c, 0)) / n)}% | top-3 runners only |`);
console.log(`| secondary-count distribution | always 4 | ${[...hierSecCounts.entries()].map(([k, c]) => `${k}:${c}`).join(", ")} | ≤3 (SC11 surface reuse) |`);
console.log(`| explicit vocal tag → \`vocal\` | — | ${Math.round((100 * vocalTaggedClassified) / Math.max(1, vocalTagged.length))}% (${vocalTaggedClassified}/${vocalTagged.length}) | tag corroborates, never truth (§26) |`);
console.log(`| reconciliation distribution | — | ${JSON.stringify(recCounts)} | 5-state (§23) |`);
console.log(`| family distribution | — | ${JSON.stringify(familyCounts)} | — |`);
console.log(`| ambiguous flag set | — | ${Math.round((100 * ambiguousCount) / n)}% | honest uncertainty (§28) |`);
console.log(`| subtype resolved (drum ontology) | — | ${subtypeCount}/${n} | optional (§15) |`);
console.log(`\n_Provenance: rows from ${path.join(OUT_DIR, "step44-analysis.ndjson")}; each is the SAME real sample classified two ways by the CURRENT code (heuristic-v1 in \`legacy\`, hier-v1 in \`primaryClass\`/\`hier\`). Small-coverage audit (~180), proxy oracles only — no universal calibration claim (§29–§31)._`);

function count<T extends Record<string, any>>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}