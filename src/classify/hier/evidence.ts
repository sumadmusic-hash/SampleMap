/**
 * STEP44 — name + tag evidence (§19–§22).
 *
 * Evidence is parsed SEPARATELY from classification and is NEVER allowed to
 * become the classifier itself. Two independent parsers produce two evidence
 * records:
 *
 *  - NAME evidence: the sample name, normalized (lowercase, punctuation →
 *    spaces) and matched against phrase-boundary type aliases. Sub-string
 *    mistakes are avoided: "skick" never matches "kick" unless a phrase
 *    boundary exists. Compound machine names like "808 Kick Punchy" match the
 *    "kick" phrase; "snare02" keeps no type evidence (explicitly not forced).
 *
 *  - TAG evidence: each original user tag normalized separately; STRONG type
 *    terms are kept as types; GENERIC terms (drum/music/sample/sound/loop/fx/
 *    audio) are recorded but NEVER fix a precise type (§21). Raw tags are never
 *    mutated.
 *
 * Both surfaces stay deterministic and pure. Subtype evidence reuses the
 * existing drum ontology (`tagToSubtype`) — no duplicated ontology.
 */
import type { ClassId } from "../classifier";
import type { SubtypeId } from "../drumOntology";
import { SUBTYPE_FAMILY, tagToSubtype } from "../drumOntology";
import { normalizeTag, normalizeTags } from "../normalizeTag";
import type { NameEvidence, SoundFamily, TagEvidence } from "./types";

/**
 * Specific type aliases per ClassId (normalized phrases). Matched on phrase
 * boundaries so abbreviations and compound tokens do not collide.
 */
export const TYPE_TERMS: Record<ClassId, readonly string[]> = {
  kick: ["kick", "kicks", "bassdrum", "bass drum", "subkick"],
  snare: ["snare", "snares", "snaredrum", "snare drum"],
  clap: ["clap", "claps", "handclap", "hand clap", "handclaps"],
  hihat: ["hihat", "hi hat", "hat", "hats"],
  openhat: ["openhihat", "open hi hat", "openhat", "open hat"],
  tom: ["tom", "toms", "tomtom", "tom tom", "racktom", "floortom"],
  cymbal: ["cymbal", "cymbals", "crash cymbal", "ride cymbal", "crash", "rides", "china"],
  percussion: ["percussion", "perc", "shaker", "tambourine", "maraca", "cabasa",
    "cowbell", "cow bell", "bongo", "bongos", "conga", "congas", "clave",
    "woodblock", "wood block", "rimshot", "rim shot", "sidestick"],
  bass: ["bass", "subbass", "sub bass", "bassline"],
  piano: ["piano", "pianos", "grand", "upright"],
  guitar: ["guitar", "guitars", "gtr", "acoustic", "electric"],
  strings: ["strings", "string", "violin", "cello", "viola", "harp", "orchestra"],
  keys: ["keys", "keyboard", "keyboards", "rhodes", "organ", "ep"],
  synth: ["synth", "synths", "synthesizer", "synthwave"],
  pad: ["pad", "pads"],
  lead: ["lead", "leads", "melody", "melodies", "pluck", "plucks", "arp"],
  vocal: ["vocal", "vocals", "vox", "singing", "singer", "voice", "rap", "rapped",
    "chant", "choir", "spoken", "lyrics", "humming", "hum", "breath"],
  fx: ["fx", "effect", "effects", "riser", "risers", "sweep", "sweeps", "whoosh",
    "whooshes", "transition", "downlifter", "uplifter"],
  atmosphere: ["ambience", "ambient", "atmosphere", "texture", "drone", "roomtone",
    "room tone", "wind", "rain", "field recording", "white noise"],
  noise: ["noise", "static", "hiss", "crackle"],
};

/** The strong-type vocabulary = union of non-empty alias lists above. */
export function isStrongTypeTerm(normalized: string, type: ClassId): boolean {
  const phrases = TYPE_TERMS[type];
  if (!phrases || phrases.length === 0) return false;
  for (const phrase of phrases) {
    if (phrase.length === 0 || phrase === "led?" || phrase.endsWith("?")) continue;
    if (matchPhrase(normalized, phrase)) return true;
  }
  return false;
}

/** Generic (weak) tag tokens — never enough to fix a precise type (§21). */
export const GENERIC_TERMS: readonly string[] = [
  "drum", "drums", "music", "musical", "sample", "samples", "sound", "loop",
  "fx", "audio", "wav", "beat",
];

/** Extra family-only hints (no precise type) used to corroborate a family. */
const FAMILY_HINT_TERMS: Record<Exclude<SoundFamily, "unknown">, readonly string[]> = {
  drums: ["drum", "drums", "beat", "break", "breakbeat", "hithat", "hihat", "hat", "kit"],
  musical: ["music", "musical", "melody", "melodic", "instrumental"],
  vocal: ["vocal", "vocals", "voice", "sing", "rap", "chorus", "spoken", "lyrics", "acapella"],
  fx: ["fx", "effect", "riser", "sweep", "whoosh", "impact", "uplifter", "downlifter"],
  "atmosphere-noise": ["ambient", "atmos", "texture", "drone", "room", "noise", "static", "hiss", "bed"],
};

const FAMILY_OF_TYPE: Record<string, SoundFamily> = {
  kick: "drums", snare: "drums", clap: "drums", hihat: "drums", openhat: "drums",
  tom: "drums", cymbal: "drums", percussion: "drums",
  bass: "musical", synth: "musical", piano: "musical", guitar: "musical",
  strings: "musical", keys: "musical", pad: "musical", lead: "musical",
  vocal: "vocal", fx: "fx", atmosphere: "atmosphere-noise", noise: "atmosphere-noise",
};

export function familyOfType(type: ClassId): SoundFamily {
  return FAMILY_OF_TYPE[type] ?? "unknown";
}

/** Boundary-aware phrase matching — "skick" never matches "kick". */
export function matchPhrase(text: string, phrase: string): boolean {
  if (text === phrase) return true;
  return (
    text.startsWith(phrase + " ") ||
    text.includes(" " + phrase + " ") ||
    text.endsWith(" " + phrase)
  );
}

/** Map a drum subtype to its closed/open-aware ClassId. */
export function subtypeToType(subtype: SubtypeId): ClassId {
  if (subtype === "openhat") return "openhat";
  if (subtype === "closedhat") return "hihat";
  return SUBTYPE_FAMILY[subtype];
}

function resolveTypesFromText(normalizedParts: readonly string[]): {
  types: ClassId[]; subtypes: SubtypeId[]; generic: string[];
} {
  const types: ClassId[] = [];
  const subtypes: SubtypeId[] = [];
  const generic: string[] = [];
  for (const part of normalizedParts) {
    const subtype = tagToSubtype(part);
    if (subtype !== undefined) {
      const t = subtypeToType(subtype);
      if (!types.includes(t)) types.push(t);
      if (!subtypes.includes(subtype)) subtypes.push(subtype);
    }
    for (const t of Object.keys(TYPE_TERMS) as ClassId[]) {
      if (isStrongTypeTerm(part, t) && !types.includes(t)) types.push(t);
    }
    const g = GENERIC_TERMS.find((x) => x === part);
    if (g !== undefined && !generic.includes(g)) generic.push(g);
  }
  return { types, subtypes, generic };
}

function familyHintsFrom(types: readonly ClassId[], parts: readonly string[]): SoundFamily[] {
  const hints = new Set<SoundFamily>();
  for (const t of types) {
    const fam = FAMILY_OF_TYPE[t];
    if (fam !== undefined) hints.add(fam);
  }
  for (const part of parts) {
    for (const fam of Object.keys(FAMILY_HINT_TERMS) as Exclude<SoundFamily, "unknown">[]) {
      for (const phrase of FAMILY_HINT_TERMS[fam]) {
        if (matchPhrase(part, phrase)) hints.add(fam);
      }
    }
  }
  return [...hints];
}

/** Parse NAME evidence. Independent of tags; name is never overwritten. */
export function parseNameEvidence(name: string): NameEvidence & { subtypes: SubtypeId[] } {
  const normalized = normalizeTag(name);
  const parts = normalized.length > 0 ? [normalized] : [];
  if (parts.length === 0) return { present: false, types: [], subtypes: [], familyHints: [] };
  const { types, subtypes } = resolveTypesFromText(parts);
  return {
    present: true,
    types,
    subtypes,
    familyHints: familyHintsFrom(types, parts),
  };
}

/** Parse TAG evidence. Original tags are preserved verbatim by the caller. */
export function parseTagEvidence(
  rawTags: readonly string[],
): TagEvidence & { subtypes: SubtypeId[] } {
  const normalized = normalizeTags([...rawTags]);
  const parts = normalized.filter((n) => n.length > 0);
  const { types, subtypes, generic } = resolveTypesFromText(parts);
  return {
    types,
    generic,
    subtypes,
    familyHints: familyHintsFrom(types, parts),
  };
}

/** Convenience: family hint booleans consumed by the family scorer. */
export function toFamilyHints(
  name: Pick<NameEvidence, "familyHints">,
  tag: Pick<TagEvidence, "familyHints">,
): { drums: boolean; musical: boolean; vocal: boolean; fx: boolean; atmosphere: boolean; noise: boolean } {
  const all = [...name.familyHints, ...tag.familyHints];
  return {
    drums: all.includes("drums"),
    musical: all.includes("musical"),
    vocal: all.includes("vocal"),
    fx: all.includes("fx"),
    atmosphere: all.includes("atmosphere-noise"),
    noise: all.includes("atmosphere-noise"),
  };
}