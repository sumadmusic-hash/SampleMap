/**
 * STEP38 — Semantic classification: hierarchical (family → subtype)
 * reconciliation between the AUDIO classifier result and TAG evidence.
 *
 * This module is a pure, deterministic, side-effect-free boundary that CONSUMES
 * the frozen V1 classifier output (`ClassOutput`) and the sample's original
 * tags, and produces an additive `SemanticClassification`. It never re-runs
 * audio analysis, never mutates tags, never overwrites `primaryClass` /
 * `confidence`, and never affects map coordinates (position stays the STEP37
 * canonical Sound Space).
 *
 * RULES (STEP38 §15/§18/§22):
 *   - The AUDIO family is authoritative. Tags are EVIDENCE: they may REFINE the
 *     family into a subtype (hihat → closedhat/openhat, cymbal → ride/crash,
 *     percussion → shaker/tambourine/rim/cowbell/bongo/conga/clave/other) but
 *     NEVER override a distinct audio family.
 *   - CONFLICT = tag evidence points at a subtype whose AUDIO FAMILY differs
 *     from the classifier's family (e.g. audio=clap, tags=shaker). On conflict
 *     the audio family/subtype wins, `conflict` is set, and the reconciled
 *     confidence is discounted (deterministic factor).
 *   - Confidence is EXPLICIT: refinement boosts by a fixed additive epsilon
 *     (cap 1), conflict discounts by a fixed multiplicative factor. Favorites /
 *     usage are NEVER part of this arithmetic (§22).
 *   - Tags are preserved by the caller; `tagEvidence` records the ORIGINAL tags
 *     that contributed (never rewritten).
 */
import type { ClassId, ClassOutput } from "./classifier";
import { tagToSubtype, type SubtypeId } from "./drumOntology";
import { normalizeTag } from "./normalizeTag";

/** Version of the semantic-reconciliation semantics. */
export const SEMANTIC_CLASSIFICATION_VERSION = "semantic-v1" as const;

/** Deterministic confidence adjustment constants (pure arithmetic). */
export const REFINEMENT_CONFIDENCE_EPSILON = 0.04;
export const CONFLICT_CONFIDENCE_DISCOUNT = 0.8;

/** Where the reconciled subtype evidence came from. */
export type SemanticSource = "audio" | "audio+tags";

export interface SemanticClassification {
  /** `SEMANTIC_CLASSIFICATION_VERSION`. */
  version: "semantic-v1";
  /** Audio family — the classifier's `primaryClass`, never overridden by tags. */
  family: ClassId;
  /**
   * Fine-grained display class: the ontology subtype when tag evidence refines
   * the family, otherwise the family itself (no fabricated specificity).
   */
  subtype: string;
  /** Explicit reconciled confidence in [0, 1] (rounded 4dp). */
  confidence: number;
  source: SemanticSource;
  /** True when tag evidence contradicted the audio family (§15: audio wins). */
  conflict: boolean;
  /** Original tags (verbatim) that contributed tag evidence. */
  tagEvidence: readonly string[];
}

/** Deciding subtypes per audio family (spec §18 hierarchy). */
const REFINABLE_FAMILIES: Record<ClassId, readonly SubtypeId[] | undefined> = {
  hihat: ["closedhat", "openhat"],
  openhat: ["openhat"],
  cymbal: ["ride", "crash"],
  percussion: [
    "shaker",
    "tambourine",
    "rim",
    "cowbell",
    "bongo",
    "conga",
    "clave",
    "percussion-other",
  ],
  tom: ["tom"],
  kick: ["kick"],
  snare: ["snare"],
  clap: ["clap"],
};

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Collect tag evidence: original tags → subtype ids (dedup, first-wins),
 * returned alongside the contributing ORIGINAL tag strings (preserved verbatim).
 */
export function collectTagEvidence(
  tags: readonly string[],
): { subtypes: SubtypeId[]; evidenceTags: string[] } {
  const subtypes: SubtypeId[] = [];
  const evidenceTags: string[] = [];
  const seen = new Set<SubtypeId>();
  for (const tag of tags) {
    const subtype = tagToSubtype(tag);
    if (subtype === undefined) continue;
    if (seen.has(subtype)) continue;
    seen.add(subtype);
    subtypes.push(subtype);
    evidenceTags.push(tag.trim());
  }
  return { subtypes, evidenceTags };
}

/**
 * The core reconciliation: pure `ClassOutput` + `originalTags` →
 * `SemanticClassification`. Deterministic; identical inputs ⇒ identical output.
 *
 * Conflict rule (STEP38 §15): a tag subtype is CONFLICTING when it is not the
 * audio family itself and not a subtype that the audio family may refine to.
 * Audio always wins; a conflict resets to the family, marks `conflict`, and
 * discounts the confidence by the deterministic factor.
 */
export function reconcileSemanticClassification(
  classOutput: ClassOutput,
  originalTags: readonly string[],
): SemanticClassification {
  const family = classOutput.primaryClass;
  const { subtypes, evidenceTags } = collectTagEvidence(originalTags);

  let subtype: string = family;
  let source: SemanticSource = "audio";
  let conflict = false;
  let confidence = classOutput.confidence;

  const refinable = REFINABLE_FAMILIES[family] ?? [];
  // Tag evidence is authoritative ONLY within the audio family's allowed
  // refinement set (a subtype equal to the family itself is always compatible,
  // e.g. audio kick + "kick" tag).
  const refining = subtypes.filter(
    (s) => s === family || (refinable as readonly string[]).includes(s),
  );
  if (refining.length > 0) {
    subtype = refining[0];
    source = "audio+tags";
    confidence = round4(Math.min(1, confidence + REFINEMENT_CONFIDENCE_EPSILON));
  }

  // Audio wins on any tag evidence the family may NOT refine to.
  const conflicting = subtypes.filter(
    (s) => s !== family && !(refinable as readonly string[]).includes(s),
  );
  if (conflicting.length > 0) {
    conflict = true;
    subtype = family;
    source = "audio";
    confidence = round4(classOutput.confidence * CONFLICT_CONFIDENCE_DISCOUNT);
  }

  return {
    version: SEMANTIC_CLASSIFICATION_VERSION,
    family,
    subtype,
    confidence,
    source,
    conflict,
    tagEvidence: [...evidenceTags],
  };
}

/** Normalize a raw tag and expose it (shared with display pipelines). */
export { normalizeTag };