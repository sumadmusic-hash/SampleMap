/**
 * STEP98 — drum recognition measured against USER TAGS, over the real library.
 *
 * Joins two read-only public sources by sample id, without downloading any audio:
 *   1. the Audiotool `samples.list` metadata (name, tags, kind) via AT_PAT, and
 *   2. the published analysis (`primaryClass`) from the SampleMap D1 worker's
 *      read-only `POST /samples/lookup`.
 *
 * A sample's user tags give the LABEL; the published classifier output gives the
 * PREDICTION. Only samples whose drum tags resolve to exactly ONE drum ClassId
 * are used, so an ambiguous tag set can never fabricate a disagreement.
 *
 * Usage:
 *   AT_PAT=<pat> npx tsx scripts/step98-drum-agreement.ts [--max-samples 20000] [--worker <url>]
 *
 * Output: report on stdout + `drum-agreement.json` in a temp dir (never the repo).
 */
import { createAudiotoolClient, createPATAuth } from "@audiotool/nexus";
import { createNodeTransport, createDiskWasmLoader } from "@audiotool/nexus/node";
import type { SampleMeta } from "@audiotool/nexus/api";
import { mkdirSync, writeFileSync } from "node:fs";
import { normalizeTag } from "../src/classify/normalizeTag";
import { isStrongTypeTerm, subtypeToType } from "../src/classify/hier/evidence";
import { tagToSubtype } from "../src/classify/drumOntology";
import type { ClassId } from "../src/classify/classifier";

const PAT = process.env.AT_PAT ?? "";
if (!PAT) {
  console.error("AT_PAT not set (see .env)");
  process.exit(1);
}

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const MAX_SAMPLES = Number(readArg("--max-samples") ?? "20000");
const PAGE_SIZE = Number(readArg("--page-size") ?? "100");
const WORKER =
  readArg("--worker") ??
  process.env.VITE_GLOBAL_WORKER_URL ??
  "https://samplemap-d1-worker.sumadmusic.workers.dev";
const OUT_DIR =
  readArg("--out") ?? "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step98";

const DRUM_TYPES: readonly ClassId[] = [
  "kick", "snare", "clap", "hihat", "openhat", "tom", "cymbal", "percussion",
];

/** Every drum ClassId the tags provide evidence for. */
function drumLabelsFromTags(tags: readonly string[]): ClassId[] {
  const found = new Set<ClassId>();
  for (const raw of tags) {
    const norm = normalizeTag(raw);
    if (norm.length === 0) continue;
    const subtype = tagToSubtype(norm);
    if (subtype !== undefined) found.add(subtypeToType(subtype));
    for (const t of DRUM_TYPES) if (isStrongTypeTerm(norm, t)) found.add(t);
  }
  return [...found];
}

type Row = {
  sampleId: string;
  name: string;
  kind: string | undefined;
  durationSeconds: number | undefined;
  tags: string[];
  label: ClassId;
  predicted: ClassId | undefined;
  classificationVersion: string | undefined;
};

async function lookup(ids: readonly string[]) {
  const res = await fetch(`${WORKER}/samples/lookup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ids),
  });
  if (!res.ok) throw new Error(`lookup ${res.status}`);
  return (await res.json()) as {
    status: "known" | "unknown";
    sampleId: string;
    analysis?: { primaryClass: ClassId; classificationVersion: string };
  }[];
}

async function main() {
  const client = await createAudiotoolClient({
    auth: createPATAuth(PAT),
    transport: createNodeTransport(),
    wasm: createDiskWasmLoader(),
  });
  if (!client.samples) throw new Error("client.samples unavailable");

  const samples: SampleMeta[] = [];
  let pageToken: string | undefined;
  while (samples.length < MAX_SAMPLES) {
    const result = await client.samples.list({ pageSize: PAGE_SIZE, pageToken });
    if (result instanceof Error) throw new Error(`list failed: ${result.message}`);
    for (const s of result.samples) {
      if (samples.length >= MAX_SAMPLES) break;
      samples.push(s);
    }
    pageToken = result.nextPageToken || undefined;
    if (!pageToken) break;
    process.stderr.write(`\r  enumerated ${samples.length}`);
  }
  process.stderr.write("\n");

  const labelled: Row[] = [];
  let ambiguous = 0;
  for (const s of samples) {
    const labels = drumLabelsFromTags(s.tags ?? []);
    if (labels.length === 0) continue;
    if (labels.length > 1) {
      ambiguous++;
      continue; // tag set does not pin one drum type — unusable as a label
    }
    labelled.push({
      sampleId: s.name,
      name: s.displayName,
      kind: s.kind,
      durationSeconds: s.durationSeconds,
      tags: [...(s.tags ?? [])],
      label: labels[0],
      predicted: undefined,
      classificationVersion: undefined,
    });
  }
  console.log(
    `samples=${samples.length}  labelled(unambiguous drum tag)=${labelled.length}  ambiguous(skipped)=${ambiguous}`,
  );

  const known = new Map<string, { primaryClass: ClassId; classificationVersion: string }>();
  for (let i = 0; i < labelled.length; i += 100) {
    const batch = labelled.slice(i, i + 100);
    const hits = await lookup(batch.map((r) => r.sampleId));
    for (const h of hits) {
      if (h.status === "known" && h.analysis) {
        known.set(h.sampleId, {
          primaryClass: h.analysis.primaryClass,
          classificationVersion: h.analysis.classificationVersion,
        });
      }
    }
    process.stderr.write(`\r  looked up ${Math.min(i + 100, labelled.length)}`);
  }
  process.stderr.write("\n");

  for (const r of labelled) {
    const k = known.get(r.sampleId);
    if (k) {
      r.predicted = k.primaryClass;
      r.classificationVersion = k.classificationVersion;
    }
  }
  const resolved = labelled.filter((r) => r.predicted !== undefined);

  const matrix = new Map<string, Map<string, number>>();
  for (const r of resolved) {
    const row = matrix.get(r.label) ?? new Map<string, number>();
    row.set(r.predicted!, (row.get(r.predicted!) ?? 0) + 1);
    matrix.set(r.label, row);
  }

  const exact = resolved.filter((r) => r.label === r.predicted).length;
  const inDrums = resolved.filter((r) => DRUM_TYPES.includes(r.predicted!)).length;

  const kindBucket = (k: string | undefined) =>
    k === "loop" ? "loop" : k === "one-shot" ? "one-shot" : "other";

  console.log(`\nresolved against the global index: ${resolved.length}`);
  console.log(`  exact type agreement : ${exact}  (${((exact / Math.max(1, resolved.length)) * 100).toFixed(1)}%)`);
  console.log(`  predicted as some drum: ${inDrums}  (${((inDrums / Math.max(1, resolved.length)) * 100).toFixed(1)}%)`);

  console.log("\nby kind (user tag says a drum type):");
  for (const bucket of ["one-shot", "loop", "other"]) {
    const rows = resolved.filter((r) => kindBucket(r.kind) === bucket);
    if (rows.length === 0) continue;
    const dr = rows.filter((r) => DRUM_TYPES.includes(r.predicted!)).length;
    const ex = rows.filter((r) => r.label === r.predicted).length;
    console.log(
      `  ${bucket.padEnd(9)} n=${String(rows.length).padStart(4)}  predicted drum: ${((dr / rows.length) * 100).toFixed(0)}%  exact: ${((ex / rows.length) * 100).toFixed(0)}%`,
    );
  }

  console.log("\nconfusion (user tag label -> predicted), rows with data:");
  for (const label of DRUM_TYPES) {
    const row = matrix.get(label);
    if (!row) continue;
    const total = [...row.values()].reduce((a, b) => a + b, 0);
    const cells = [...row.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join("  ");
    console.log(`  ${label.padEnd(11)} n=${String(total).padStart(4)}  ${cells}`);
  }

  const disagreements = resolved
    .filter((r) => r.label !== r.predicted)
    .slice(0, 40)
    .map((r) => ({
      name: r.name,
      kind: r.kind,
      dur: r.durationSeconds,
      tags: r.tags,
      label: r.label,
      predicted: r.predicted,
      cv: r.classificationVersion,
    }));

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    `${OUT_DIR}/drum-agreement.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        worker: WORKER,
        samples: samples.length,
        labelled: labelled.length,
        ambiguous,
        resolved: resolved.length,
        exact,
        inDrums,
        matrix: Object.fromEntries(
          [...matrix.entries()].map(([k, v]) => [k, Object.fromEntries(v)]),
        ),
        disagreements,
        resolvedRows: resolved.map((r) => ({
          sampleId: r.sampleId,
          name: r.name,
          kind: r.kind,
          dur: r.durationSeconds,
          tags: r.tags,
          label: r.label,
          predicted: r.predicted,
          cv: r.classificationVersion,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${OUT_DIR}/drum-agreement.json`);
  if (disagreements.length) {
    console.log("\nfirst disagreements (tag label vs published class):");
    for (const d of disagreements.slice(0, 15)) {
      console.log(
        `  ${d.label.padEnd(11)} -> ${String(d.predicted).padEnd(11)} ${d.kind ?? "?"} ${(d.dur ?? 0).toFixed(2)}s  "${d.name}"  [${d.tags.join(", ")}]`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
