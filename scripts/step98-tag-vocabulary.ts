/**
 * STEP98 — real tag-vocabulary measurement over the public Audiotool library.
 *
 * Read-only metadata enumeration (no audio download, no writes, no D1 access).
 * Its purpose is to measure how much of the vocabulary users ACTUALLY tag drum
 * samples with is recognised by the current classifier vocabulary
 * (`TYPE_TERMS`, `TAG_SUBTYPE_ALIASES`, `GENERIC_TERMS`) — the recall gap that
 * limits tag-driven recognition.
 *
 * Usage:
 *   AT_PAT=<pat> npx tsx scripts/step98-tag-vocabulary.ts [--max-samples 5000] [--out <dir>]
 *
 * Output: a report on stdout and `tag-vocabulary.json` in the output directory
 * (default: a temp dir, never the repository).
 */
import { createAudiotoolClient, createPATAuth } from "@audiotool/nexus";
import { createNodeTransport, createDiskWasmLoader } from "@audiotool/nexus/node";
import type { SampleMeta } from "@audiotool/nexus/api";
import { mkdirSync, writeFileSync } from "node:fs";
import { normalizeTag } from "../src/classify/normalizeTag";
import { GENERIC_TERMS, TYPE_TERMS, isStrongTypeTerm } from "../src/classify/hier/evidence";
import { tagToSubtype } from "../src/classify/drumOntology";
import { ALL_CLASSES } from "../src/classify/taxonomy";

const PAT = process.env.AT_PAT ?? "";
if (!PAT) {
  console.error("AT_PAT not set (see .env)");
  process.exit(1);
}

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const MAX_SAMPLES = Number(readArg("--max-samples") ?? "5000");
const PAGE_SIZE = Number(readArg("--page-size") ?? "100");
const OUT_DIR =
  readArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step98";

/** The eight one-shot drum ClassIds and their family. */
const DRUM_TYPES = ["kick", "snare", "clap", "hihat", "openhat", "tom", "cymbal", "percussion"];

type Recognition = "subtype" | "drum-type" | "other-type" | "generic" | "unrecognized";

/** How the current vocabulary understands one normalized tag. */
function recognise(norm: string): Recognition {
  if (norm.length === 0) return "unrecognized";
  if (tagToSubtype(norm) !== undefined) return "subtype";
  for (const type of ALL_CLASSES) {
    if (!isStrongTypeTerm(norm, type)) continue;
    return (DRUM_TYPES as readonly string[]).includes(type) ? "drum-type" : "other-type";
  }
  for (const g of GENERIC_TERMS) if (g === norm) return "generic";
  return "unrecognized";
}

/** A tag that carries drum evidence today. */
const isDrumEvidence = (norm: string) => {
  const r = recognise(norm);
  return r === "subtype" || r === "drum-type";
};

async function main() {
  const client = await createAudiotoolClient({
    auth: createPATAuth(PAT),
    transport: createNodeTransport(),
    wasm: createDiskWasmLoader(),
  });
  if (!client.samples) throw new Error("client.samples unavailable");

  const samples: SampleMeta[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  while (samples.length < MAX_SAMPLES) {
    const result = await client.samples.list({ pageSize: PAGE_SIZE, pageToken });
    if (result instanceof Error) throw new Error(`list failed: ${result.message}`);
    pages++;
    for (const s of result.samples) {
      if (samples.length >= MAX_SAMPLES) break;
      samples.push(s);
    }
    pageToken = result.nextPageToken || undefined;
    if (!pageToken) break;
    process.stderr.write(`\r  enumerated ${samples.length} samples (${pages} pages)`);
  }
  process.stderr.write("\n");

  const tagCount = new Map<string, number>(); // normalized tag -> occurrences
  const tagExamples = new Map<string, string>(); // normalized -> one raw spelling
  const recognition = new Map<string, Recognition>();
  let withTags = 0;
  let totalTags = 0;

  // Drum-context: samples that carry at least one recognised drum-evidence tag.
  // Tags co-occurring on those samples are the most likely missing drum terms.
  const drumContextTags = new Map<string, number>();
  let drumSamples = 0;
  let drumSamplesWithoutRecognisedTag = 0;
  // Composition opportunity: a sample whose JOINED tag string matches a phrase
  // that no single one of its tags matches (e.g. tags ["closed","hat"]).
  let compositionSubtypeGain = 0;
  let compositionTypeGain = 0;
  const compositionExamples = new Map<string, string>();

  for (const s of samples) {
    const tags = s.tags ?? [];
    if (tags.length > 0) withTags++;
    totalTags += tags.length;
    const norms = tags.map((t) => normalizeTag(t)).filter((t) => t.length > 0);
    const hasDrumEvidence = norms.some(isDrumEvidence);
    if (hasDrumEvidence) drumSamples++;
    for (const norm of norms) {
      tagCount.set(norm, (tagCount.get(norm) ?? 0) + 1);
      if (!tagExamples.has(norm)) {
        tagExamples.set(norm, tags[norms.indexOf(norm)] ?? norm);
      }
      if (!recognition.has(norm)) recognition.set(norm, recognise(norm));
      if (hasDrumEvidence) {
        drumContextTags.set(norm, (drumContextTags.get(norm) ?? 0) + 1);
      }
    }
    // Would joining the tags reveal a phrase no single tag carries?
    if (norms.length > 1) {
      const joined = norms.join(" ");
      const singleSubtype = norms.some((n) => tagToSubtype(n) !== undefined);
      const singleType = norms.some((n) =>
        ALL_CLASSES.some((t) => isStrongTypeTerm(n, t)),
      );
      if (!singleSubtype && tagToSubtype(joined) !== undefined) {
        compositionSubtypeGain++;
        compositionExamples.set(norms.join("+"), "subtype");
      }
      if (
        !singleType &&
        ALL_CLASSES.some((t) => isStrongTypeTerm(joined, t))
      ) {
        compositionTypeGain++;
        compositionExamples.set(norms.join("+"), "type");
      }
    }
    // Relaxed drum-context measure: a one-shot drum PLACE held by a tag the
    // vocabulary does not know. Purely descriptive.
    if (
      (s.kind === "one-shot" || s.kind === "unknown") &&
      norms.length > 0 &&
      !hasDrumEvidence &&
      norms.some((n) => recognition.get(n) === "unrecognized")
    ) {
      drumSamplesWithoutRecognisedTag++;
    }
  }

  const byRecognition: Record<Recognition, number> = {
    subtype: 0,
    "drum-type": 0,
    "other-type": 0,
    generic: 0,
    unrecognized: 0,
  };
  for (const [norm, n] of tagCount) {
    byRecognition[recognition.get(norm) ?? "unrecognized"] += n;
  }

  const top = (m: Map<string, number>, limit: number, filter?: (k: string) => boolean) =>
    [...m.entries()]
      .filter(([k]) => (filter ? filter(k) : true))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit);

  const unrecognisedDrumContext = top(
    drumContextTags,
    60,
    (k) => recognition.get(k) === "unrecognized" || recognition.get(k) === "generic",
  );
  const unrecognisedGlobal = top(tagCount, 60, (k) => recognition.get(k) === "unrecognized");

  const report = {
    enumeratedAt: new Date().toISOString(),
    samples: samples.length,
    pages,
    samplesWithTags: withTags,
    totalTags,
    avgTagsPerSample: samples.length ? totalTags / samples.length : 0,
    distinctNormalizedTags: tagCount.size,
    recognisedTagOccurrences: byRecognition,
    recognisedShare:
      totalTags > 0
        ? (totalTags - byRecognition.unrecognized) / totalTags
        : 0,
    drumSamples,
    oneShotSamplesWithOnlyUnknownTags: drumSamplesWithoutRecognisedTag,
    compositionSubtypeGain,
    compositionTypeGain,
    compositionExamples: Object.fromEntries([...compositionExamples.entries()].slice(0, 25)),
  };

  console.log("=== STEP98 tag-vocabulary measurement ===");
  console.log(JSON.stringify(report, null, 2));
  console.log("\nrecognition of tag occurrences:");
  for (const [k, v] of Object.entries(byRecognition)) {
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(7)}  ${((v / Math.max(1, totalTags)) * 100).toFixed(1)}%`);
  }
  console.log(`\ntop UNRECOGNISED tags in drum context (n=${unrecognisedDrumContext.length}):`);
  for (const [k, v] of unrecognisedDrumContext) console.log(`  ${String(v).padStart(5)}  ${k}`);
  console.log(`\ntop UNRECOGNISED tags overall:`);
  for (const [k, v] of unrecognisedGlobal) console.log(`  ${String(v).padStart(5)}  ${k}`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    `${OUT_DIR}/tag-vocabulary.json`,
    JSON.stringify(
      {
        report,
        recognitionByTag: Object.fromEntries(
          [...tagCount.entries()].map(([k, v]) => [
            k,
            { count: v, recognition: recognition.get(k), example: tagExamples.get(k) },
          ]),
        ),
        drumContextTags: Object.fromEntries(unrecognisedDrumContext),
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${OUT_DIR}/tag-vocabulary.json`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
