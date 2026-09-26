/**
 * STEP44 — hierarchical sound-type classification, shared types.
 *
 * This module defines the ADDITIVE `hier-v1` contract that lives alongside the
 * legacy surface vocabulary (`primaryClass` / `secondaryClasses` /
 * `semanticClassification`) and NEVER replaces it. All fields are optional on
 * persisted records: a record without `hier` stays fully readable.
 *
 * INVARIANTS
 *  - Pure data + validation: no audio, no I/O, no randomness, no time
 *    dependency — identical input produces an identical `HierClassification`.
 *  - Metadata only: numbers / strings / booleans / plain arrays. Never audio
 *    bytes; survives `assertNoAudioBytes`.
 *  - EVERY convention in this step is additive to the STEP38 semantic layer
 *    and to the V1/V2 analysis contracts.
 */
import type { AudioFeatures } from "../../persistence/indexStore";
import type { AudioFeaturesV2 } from "../../analysis/audioFeaturesV2";
import type { ClassId, ClassOutput } from "../classifier";
import type { SubtypeId } from "../drumOntology";
import { familyOfType } from "./evidence";

/** The hierarchical classifier version (surface `classificationVersion` too). */
export const HIER_CLASSIFICATION_VERSION = "hier-v1" as const;

/** Stage 0 structural identity (authoritative metadata, never derived duration rules). */
export type SoundStructure = "one-shot" | "loop" | "sustained-phrase";

/** Stage 1 acoustic sound family. */
export type SoundFamily =
  | "drums"
  | "musical"
  | "vocal"
  | "fx"
  | "atmosphere-noise"
  | "unknown";

/** Stage 2 acoustic sound types per family (existing ClassId vocabulary). */
export const FAMILY_TYPES: Record<Exclude<SoundFamily, "unknown">, readonly ClassId[]> = {
  // TAXONOMY.drums — drums/percussion one-hits.
  drums: ["kick", "snare", "clap", "hihat", "openhat", "tom", "cymbal", "percussion"],
  // TAXONOMY.musical — pitched/tonal instrument voices.
  musical: ["bass", "synth", "piano", "guitar", "strings", "keys", "pad", "lead"],
  // Single-type families (the vocabulary is intentionally unchanged).
  vocal: ["vocal"],
  fx: ["fx"],
  // `noise` is a genuine type here, never the fallback bucket; `atmosphere`
  // stays distinct from `noise`.
  "atmosphere-noise": ["atmosphere", "noise"],
};

/** The fallback type for `family = unknown` (existing "other" ClassId). */
export const UNKNOWN_TYPE: ClassId = "other";

/** Name evidence — independent of tags, parsed separately (§19). */
export interface NameEvidence {
  present: boolean;
  /** Specific sound-type terms found in the sample NAME (ordered, dedup). */
  types: ClassId[];
  /** Drum subtypes found in the NAME (ordered, dedup; the strict `NAME` view). */
  subtypes: SubtypeId[];
  familyHints: SoundFamily[];
}

/** Tag evidence — normalized separately, original tags NEVER mutated (§20). */
export interface TagEvidence {
  /** Specific strong-type terms found in the tags (ordered, dedup). */
  types: ClassId[];
  /** Drum subtypes found in the tags (ordered, dedup). */
  subtypes: SubtypeId[];
  /** Generic (weak) evidence tokens — never enough to fix a precise type (§21). */
  generic: string[];
  familyHints: SoundFamily[];
}

export type ReconciliationStatus =
  | "AGREE"
  | "TAG-SUPPORTED"
  | "AUDIO-SUPPORTED"
  | "CONFLICT"
  | "UNKNOWN";

export type ReconciliationWinner = "audio" | "tag" | "name" | "none";

/**
 * Reconciliation state (§23–§26). `TAG-SUPPORTED` means the tag/name materially
 * improves the classification under weak acoustic evidence — it NEVER means the
 * tag was verified correct. Pointers keep the disagreement observable; a raw
 * user tag is never rewritten.
 */
export interface Reconciliation {
  status: ReconciliationStatus;
  winningSource: ReconciliationWinner;
  /** True when the decided type equals the independent tag/name type. */
  agreement: boolean;
  /** True when strong acoustic + strong tag evidence disagree (§24). */
  conflict: boolean;
  /** The acoustic type before metadata influence (may equal `type`). */
  audioType?: ClassId;
  /** A specific type derived from user TAGS (undefined when none/weak). */
  tagType?: ClassId;
  /** A specific type derived from the sample NAME (undefined when none). */
  nameType?: ClassId;
}

/** Evidence slice persisted on the record (lean; raw tags already on the record). */
export interface HierEvidence {
  audio: {
    /** Per-family acoustic scores (documented, deterministic). */
    familyScores: Record<SoundFamily, number>;
  };
  name: NameEvidence;
  tag: TagEvidence;
}

/** The full STEP44 hierarchical classification (additive persisted record field). */
export interface HierClassification {
  structure: SoundStructure;
  family: SoundFamily;
  type: ClassId;
  subtype?: SubtypeId;
  /** 0..1 decision confidence — NOT a claimed statistical probability (§11). */
  confidence: number;
  /** True when the evidence cannot separate the top candidates (§28). */
  ambiguous: boolean;
  classificationVersion: typeof HIER_CLASSIFICATION_VERSION;
  evidence: HierEvidence;
  reconciliation: Reconciliation;
}

/** Input to the classifier: V1 features + authoritative metadata + optional V2. */
export interface HierClassifyInput {
  features: AudioFeatures;
  meta: {
    kind: string;
    durationSeconds: number;
    name: string;
    tags: readonly string[];
  };
  /** Canonical V2 features when an analysisV2 is available (null-safe). */
  v2?: AudioFeaturesV2 | null;
}

/** Full result: the `hier` classification + the legacy surface mapping. */
export interface HierResult {
  hier: HierClassification;
  surface: ClassOutput;
}

const FAMILIES: readonly SoundFamily[] = [
  "drums",
  "musical",
  "vocal",
  "fx",
  "atmosphere-noise",
  "unknown",
];

/** Conservative structural validation for persisted `hier` records. */
export function isWellFormedHierClassification(
  value: unknown,
): value is HierClassification {
  if (typeof value !== "object" || value === null) return false;
  const h = value as Record<string, unknown>;
  if (h.classificationVersion !== HIER_CLASSIFICATION_VERSION) return false;
  if (h.structure !== "one-shot" && h.structure !== "loop" && h.structure !== "sustained-phrase")
    return false;
  if (!FAMILIES.includes(h.family as SoundFamily)) return false;
  if (typeof h.type !== "string" || h.type.length === 0) return false;
  if (typeof h.ambiguous !== "boolean") return false;
  if (typeof h.confidence !== "number" || !Number.isFinite(h.confidence)) return false;
  if (h.confidence < 0 || h.confidence > 1) return false;
  // Family/type coherence (STEP48): a concrete type must be a real ontology
  // member whose family matches. `other` is the documented exception — valid
  // with a concrete OR unknown family (STEP47). Off-ontology type strings and
  // `unknown` family with a concrete type are rejected, so a persisted `hier`
  // can never pass structural validation with an incoherent pair.
  if (h.type !== UNKNOWN_TYPE) {
    const typeFamily = familyOfType(h.type as ClassId);
    if (typeFamily === "unknown" || typeFamily !== h.family) return false;
  }
  return true;
}