/**
 * STEP44 — hierarchical classifier orchestrator (Stage 0 → 1 → 2 → reconcile).
 *
 * Pipeline: structure (authoritative kind/duration) → sound family (independent
 * acoustic scores + name/tag hints) → family-conditional type (no global
 * 22-class race) → subtype (existing drum ontology) → metadata reconciliation →
 * calibrated decision confidence → legacy surface mapping.
 *
 * Confidence is a DECISION confidence (§11), not a statistical probability:
 *   base = familyShare × (0.5 + 0.5 × typeMargin)
 *   AGREE            → ×1.1   CONFLICT        → ×0.8
 *   TAG-SUPPORTED    → ×1.15  missing V2      → ×0.85
 *   AUDIO-SUPPORTED  → ×1.0   family unknown  → base 0.1
 *   cap ≤ 0.95, floor ≥ 0.05.
 *
 * The surface mapping (SC11) reuses the EXISTING ClassId vocabulary verbatim so
 * search/`isKnownClass` are unaffected, and is ADDITIVE (SC12): `hier` records
 * live alongside `heuristic-v1` records and no mass migration ever runs.
 */
import { round4 } from "./round";
import type { ClassOutput, SecondaryClass } from "../classifier";
import { familyOfType, parseNameEvidence, parseTagEvidence, subtypeToType, toFamilyHints } from "./evidence";
import { scoreFamilies } from "./family";
import { classifyStructure } from "./structure";
import { classifyType, type TypeScoring } from "./type";
import { reconcile } from "./reconcile";
import {
  HIER_CLASSIFICATION_VERSION,
  UNKNOWN_TYPE,
  type HierClassification,
  type HierClassifyInput,
  type HierResult,
  type Reconciliation,
  type SoundFamily,
} from "./types";

export const CONFIDENCE_CAP = 0.95;
export const CONFIDENCE_FLOOR = 0.05;
export const AGREE_MULT = 1.1;
export const TAG_SUPPORTED_MULT = 1.15;
export const CONFLICT_MULT = 0.8;
export const MISSING_V2_MULT = 0.85;
export const UNKNOWN_FAMILY_BASE = 0.1;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** First specific drum subtype across tag then name evidence. */
function pickSubtype(
  tagSubtypes: readonly import("../drumOntology").SubtypeId[],
  nameSubtypes: readonly import("../drumOntology").SubtypeId[],
): import("../drumOntology").SubtypeId | undefined {
  const subtypes = [...tagSubtypes, ...nameSubtypes];
  return subtypes.length > 0 ? subtypes[0] : undefined;
}

/** Keep a subtype only when its display family matches the decided type. */
function subtypeForType(
  subtype: import("../drumOntology").SubtypeId | undefined,
  type: import("../classifier").ClassId,
): import("../drumOntology").SubtypeId | undefined {
  if (subtype === undefined || type === UNKNOWN_TYPE || type === "other") return undefined;
  return subtypeToType(subtype) === type ? subtype : undefined;
}

function computeConfidence(opts: {
  family: SoundFamily;
  familyShare: number;
  typeMargin: number;
  status: Reconciliation["status"];
  hasV2: boolean;
}): number {
  let base: number;
  if (opts.family === "unknown") {
    base = UNKNOWN_FAMILY_BASE;
  } else {
    base = clamp01(opts.familyShare) * (0.5 + 0.5 * clamp01(opts.typeMargin));
  }
  switch (opts.status) {
    case "AGREE":
      base *= AGREE_MULT;
      break;
    case "TAG-SUPPORTED":
      base *= TAG_SUPPORTED_MULT;
      break;
    case "CONFLICT":
      base *= CONFLICT_MULT;
      break;
    default:
      break; // AUDIO-SUPPORTED / UNKNOWN: ×1.0
  }
  if (!opts.hasV2) base *= MISSING_V2_MULT;
  const clamped = Math.max(CONFIDENCE_FLOOR, Math.min(CONFIDENCE_CAP, base));
  return round4(clamped);
}

/** Legacy surface mapping (SC11): existing ClassId vocabulary, additive. */
function mapToSurface(hier: HierClassification, typeSc: TypeScoring): ClassOutput {
  const primaryClass = hier.family === "unknown" ? UNKNOWN_TYPE : hier.type;
  const secondaries: SecondaryClass[] = [];
  // Map the within-family runner types (existing vocabulary) onto confidences.
  // STEP48: when metadata adoption moved the final family across the acoustic
  // family, drop runners that no longer belong to the decided family so the
  // surface never advertises stale acoustic-family secondaries.
  for (const c of typeSc.runners) {
    if (c === primaryClass) continue;
    if (familyOfType(c) !== hier.family) continue;
    const s = typeSc.scores[c];
    const confidence = round4(clamp01((s ?? 0) * 0.35));
    if (confidence > 0) {
      secondaries.push({ class: c, confidence });
    }
    if (secondaries.length >= 3) break;
  }
  return { primaryClass, confidence: round4(hier.confidence), secondaryClasses: secondaries };
}

/** Full deterministic STEP44 classification. Pure; no audio, no I/O. */
export function classifyHier(input: HierClassifyInput): HierResult {
  const { features, meta, v2 } = input;
  const structure = classifyStructure({ kind: meta.kind, durationSeconds: meta.durationSeconds });

  const nameEv = parseNameEvidence(meta.name);
  const tagEv = parseTagEvidence(meta.tags);
  const hints = toFamilyHints(nameEv, tagEv);

  const familySc = scoreFamilies({
    features,
    v2: v2 ?? null,
    structure,
    hints,
    durationSeconds: meta.durationSeconds,
  });

  const typeSc = classifyType({
    family: familySc.family,
    features,
    v2: v2 ?? null,
    structure,
    durationSeconds: meta.durationSeconds,
  });

  const audioType = typeSc.type;
  const audioStrong = familySc.family !== "unknown" && !typeSc.ambiguous;

  const reconciliation = reconcile({
    audioType,
    audioStrong,
    name: nameEv,
    tag: tagEv,
  });

  // Decide family + type after reconciliation (winner-aware; tag never truth).
  let family = familySc.family;
  let type = audioType;
  if (reconciliation.winningSource === "tag" || reconciliation.winningSource === "name") {
    // TAG-SUPPORTED: audio is weak. The metadata type is adopted as a LOW
    // confidence hypothesis (§26). The family ALWAYS follows the decided type
    // so the persisted `hier.family`/`hier.type` pair stays coherent
    // (STEP44.1 finding: type could transcend the acoustic family). The
    // acoustic picture is not lost — it remains in `evidence.audio.familyScores`.
    const metaType =
      reconciliation.winningSource === "tag" ? reconciliation.tagType : reconciliation.nameType;
    if (metaType !== undefined && metaType !== "other") {
      type = metaType;
      const metaFamily = familyOfType(metaType);
      if (metaFamily !== "unknown") family = metaFamily;
    }
  }

  const subtype = subtypeForType(pickSubtype(tagEv.subtypes, nameEv.subtypes), type);

  const confidence = computeConfidence({
    family,
    familyShare: familySc.shareTop,
    typeMargin: typeSc.marginRatio,
    status: reconciliation.status,
    hasV2: v2 !== null && v2 !== undefined,
  });

  const ambiguous = family === "unknown" || typeSc.ambiguous;

  const hier: HierClassification = {
    structure,
    family,
    type,
    subtype,
    confidence,
    ambiguous,
    classificationVersion: HIER_CLASSIFICATION_VERSION,
    evidence: {
      audio: { familyScores: familySc.scores },
      name: nameEv,
      tag: tagEv,
    },
    reconciliation,
  };

  const surface = mapToSurface(hier, typeSc);
  return { hier, surface };
}