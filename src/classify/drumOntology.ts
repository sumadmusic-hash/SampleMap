import type { ClassId } from "../persistence/indexStore";
import { normalizeTag } from "./normalizeTag";

/**
 * STEP38 — the fine-grained drum / percussion ontology.
 *
 * The frozen V1 taxonomy (`src/classify/taxonomy.ts`) stays authoritative for
 * the ANALYSIS classifier. This module is a SEPARATE, additive SEMANTIC layer:
 * it defines the 16 drum/percussion SUBTYPES that the map + inspector color
 * resolution understands. It is pure data + pure tag mapping — no audio, no
 * I/O, no side effects.
 *
 * Hierarchical relation to the V1 drum families (STEP38 §18):
 *   hihat      → closedhat | openhat
 *   cymbal     → ride | crash
 *   percussion → shaker | tambourine | rim | cowbell | bongo | conga | clave |
 *                percussion-other
 *   kick/snare/clap/tom  → their own subtype (already fine-grained).
 *
 * NOTE: `ClassId` is imported only as a data type; no classifier dependency.
 */
export type SubtypeId =
  | "kick"
  | "snare"
  | "clap"
  | "closedhat"
  | "openhat"
  | "ride"
  | "crash"
  | "tom"
  | "shaker"
  | "tambourine"
  | "rim"
  | "cowbell"
  | "bongo"
  | "conga"
  | "clave"
  | "percussion-other";

/** Canonical order (also the display order used by any legend). */
export const SUBTYPE_IDS: readonly SubtypeId[] = [
  "kick",
  "snare",
  "clap",
  "closedhat",
  "openhat",
  "ride",
  "crash",
  "tom",
  "shaker",
  "tambourine",
  "rim",
  "cowbell",
  "bongo",
  "conga",
  "clave",
  "percussion-other",
];

/** Human display labels (Title Case) for each subtype. */
export const SUBTYPE_LABELS: Record<SubtypeId, string> = {
  kick: "Kick",
  snare: "Snare",
  clap: "Clap",
  closedhat: "Closed Hat",
  openhat: "Open Hat",
  ride: "Ride",
  crash: "Crash",
  tom: "Tom",
  shaker: "Shaker",
  tambourine: "Tambourine",
  rim: "Rim",
  cowbell: "Cowbell",
  bongo: "Bongo",
  conga: "Conga",
  clave: "Clave",
  "percussion-other": "Other Percussion",
};

/**
 * The V1 audio family each subtype DISPLAYS under (used by legends / colour
 * fallback). Note: `hihat` and `openhat` are sibling V1 classes, and the
 * canonical SUBTYPE split labels both closedhat and openhat as "hi-hat family";
 * the reconciliation refinement set (in `semanticClassification.ts`) is what
 * actually decides which audio families may refine into which subtypes.
 */
export const SUBTYPE_FAMILY: Record<SubtypeId, ClassId> = {
  kick: "kick",
  snare: "snare",
  clap: "clap",
  closedhat: "hihat",
  openhat: "hihat",
  ride: "cymbal",
  crash: "cymbal",
  tom: "tom",
  shaker: "percussion",
  tambourine: "percussion",
  rim: "percussion",
  cowbell: "percussion",
  bongo: "percussion",
  conga: "percussion",
  clave: "percussion",
  "percussion-other": "percussion",
};

/** Hi-hat family split. */
export const HAT_SUBTYPES: readonly SubtypeId[] = ["closedhat", "openhat"];

/** Cymbal family split. */
export const CYMBAL_SUBTYPES: readonly SubtypeId[] = ["ride", "crash"];

/** The percussion generic-subtype bucket. */
export const PERCUSSION_SUBTYPES: readonly SubtypeId[] = [
  "shaker",
  "tambourine",
  "rim",
  "cowbell",
  "bongo",
  "conga",
  "clave",
  "percussion-other",
];

/**
 * Tag evidence table: normalized tag strings → subtype id. Tags are EVIDENCE
 * only (STEP38 §15) — they refine an audio family but never override it. All
 * aliases are pre-normalized (lowercase, alnum only, single spaces).
 */
export const TAG_SUBTYPE_ALIASES: Record<
  SubtypeId,
  { readonly exact: readonly string[]; readonly phrases: readonly string[] }
> = {
  kick: { exact: ["kick"], phrases: ["kick", "bassdrum", "bass drum", "subkick"] },
  snare: { exact: ["snare", "snares"], phrases: ["snare", "snaredrum", "snare drum"] },
  clap: { exact: ["clap", "claps"], phrases: ["clap", "handclap", "hand clap", "handclaps"] },
  closedhat:
  { exact: ["chh"], phrases: ["closedhihat", "closed hi hat", "closedhat", "closed hat"] },
  openhat:
  { exact: ["ohh"], phrases: ["openhihat", "open hi hat", "openhat", "open hat"] },
  ride: { exact: ["ride", "rides"], phrases: ["ride cymbal", "ride"] },
  crash: { exact: ["crash", "crashes"], phrases: ["crash cymbal", "crash"] },
  tom: { exact: ["tom", "toms"], phrases: ["tomtom", "tom tom", "racktom", "floortom", "tom"] },
  shaker: { exact: ["shaker", "shakers"], phrases: ["shaker", "maraca", "maracas", "cabasa"] },
  tambourine:
  { exact: ["tambourine", "tambourines"], phrases: ["tambourine", "tambourines", "tamb"] },
  rim: { exact: ["rim", "rims"], phrases: ["rimshot", "rim shot", "rim", "sidestick"] },
  cowbell: { exact: ["cowbell", "cowbells"], phrases: ["cowbell", "cow bell"] },
  bongo: { exact: ["bongo", "bongos"], phrases: ["bongo", "bongos"] },
  conga: { exact: ["conga", "congas"], phrases: ["conga", "congas", "tumba", "quinto"] },
  clave: { exact: ["clave", "claves"], phrases: ["clave", "claves", "woodblock", "wood block"] },
  "percussion-other":
  { exact: ["percussion", "perc"], phrases: ["percussion", "perc"] },
};

/** Match a normalized tag against a subtype's alias set (phrase-boundary aware). */
export function tagMatchesSubtype(
  normalizedTag: string,
  subtype: SubtypeId,
): boolean {
  const alias = TAG_SUBTYPE_ALIASES[subtype];
  for (const p of alias.phrases) {
    if (matchPhrase(normalizedTag, p)) return true;
  }
  // Short exact markers (e.g. "chh", "ohh") only match the whole token.
  return alias.exact.includes(normalizedTag);
}

function matchPhrase(tag: string, phrase: string): boolean {
  if (tag === phrase) return true;
  return (
    tag.startsWith(phrase + " ") ||
    tag.includes(" " + phrase + " ") ||
    tag.endsWith(" " + phrase)
  );
}

/**
 * Resolve a single (raw) tag to a drum subtype id, or `undefined` when the tag
 * carries no drum-subtype evidence. Deterministic; `undefined` on unknown.
 */
export function tagToSubtype(tag: string): SubtypeId | undefined {
  const norm = normalizeTag(tag);
  if (norm.length === 0) return undefined;
  for (const subtype of SUBTYPE_IDS) {
    if (tagMatchesSubtype(norm, subtype)) return subtype;
  }
  return undefined;
}