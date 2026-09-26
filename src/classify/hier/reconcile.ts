/**
 * STEP44 — metadata reconciliation (§23–§26).
 *
 * Combines the ACOUSTIC decision (family + within-family type from Stage 1/2)
 * with the two INDEPENDENT text surfaces (NAME and TAG evidence). Reconciliation
 * is a separate stage that NEVER fabricates audio truth and NEVER rewrites a raw
 * user tag.
 *
 * States (§23):
 *   AGREE          — strong audio + matching strong tag/name type.
 *   TAG-SUPPORTED  — audio is weak; a specific tag/name type materially improves
 *                    the classification. This NEVER means "the tag was verified
 *                    correct" (§26): the decision stays a hypothesis and the
 *                    confidence stays low.
 *   AUDIO-SUPPORTED — audio is decisive; metadata carries no specific type
 *                    (absent, generic, or conflicting across sources).
 *   CONFLICT       — strong audio type ≠ a strong tag/name type. Audio wins
 *                    (§24); the disagreement stays observable in the status and
 *                    both pointers are preserved.
 *   UNKNOWN        — audio weak and no usable metadata type.
 *
 * Winner precedence: audio > name (when name and tag disagree, the name is the
 * closer editorial signal than community tags), tag. `winningSource` records
 * which surface actually produced the decided type.
 */
import type { ClassId } from "../classifier";
import type { NameEvidence, Reconciliation, TagEvidence } from "./types";

export interface ReconcileInput {
  audioType: ClassId;
  /** True only when the acoustic decision is decisive (§24). */
  audioStrong: boolean;
  name?: NameEvidence;
  tag?: TagEvidence;
}

function metadataStrongType(
  name: NameEvidence | undefined,
  tag: TagEvidence | undefined,
  audioType: ClassId,
):
  | { present: true; type: ClassId; source: "name" | "tag"; conflict: boolean }
  | { present: false; conflict: boolean } {
  const nameTypes = (name?.types ?? []).filter((t) => t !== "other");
  const tagTypes = (tag?.types ?? []).filter((t) => t !== "other");
  if (nameTypes.length === 0 && tagTypes.length === 0) {
    return { present: false, conflict: false };
  }

  // Prefer the specific type that matches the acoustic decision when present.
  const pick = (types: readonly ClassId[]): ClassId | undefined =>
    types.find((t) => t === audioType) ?? types[0];

  const nameType = nameTypes.length > 0 ? pick(nameTypes) : undefined;
  const tagType = tagTypes.length > 0 ? pick(tagTypes) : undefined;
  if (nameType !== undefined && tagType !== undefined && nameType !== tagType) {
    // Two independent text surfaces disagree → neither fixes a type; the
    // disagreement is surfaced as a metadata conflict.
    return { present: false, conflict: true };
  }
  const winner: ClassId = tagType !== undefined ? tagType : nameType!;
  const source: "name" | "tag" =
    tagType !== undefined && (nameType === undefined || nameType === tagType)
      ? "tag"
      : "name";
  return { present: true, type: winner, source, conflict: false };
}

/**
 * Deterministic reconciliation. Pure; mutates nothing.
 */
export function reconcile(input: ReconcileInput): Reconciliation {
  const name = input.name;
  const tag = input.tag;
  const meta = metadataStrongType(name, tag, input.audioType);

  const nameType =
    name && name.types.filter((t) => t !== "other").length > 0
      ? name.types.find((t) => t === input.audioType) ??
        name.types.filter((t) => t !== "other")[0]
      : undefined;
  const tagType =
    tag && tag.types.filter((t) => t !== "other").length > 0
      ? tag.types.find((t) => t === input.audioType) ??
        tag.types.filter((t) => t !== "other")[0]
      : undefined;

  // 1) No usable specific metadata type --------------------------------------
  if (!meta.present) {
    if (input.audioStrong) {
      return {
        status: "AUDIO-SUPPORTED",
        winningSource: "audio",
        agreement: true,
        conflict: meta.conflict,
        audioType: input.audioType,
        tagType,
        nameType,
      };
    }
    return {
      status: "UNKNOWN",
      winningSource: "none",
      agreement: false,
      conflict: meta.conflict,
      audioType: input.audioType,
      tagType,
      nameType,
    };
  }

  // 2) Strong audio - decide by agreement -------------------------------------
  if (input.audioStrong) {
    const agree = meta.type === input.audioType;
    if (agree) {
      return {
        status: "AGREE",
        winningSource: "audio",
        agreement: true,
        conflict: false,
        audioType: input.audioType,
        tagType,
        nameType,
      };
    }
    // §24: strong audio wins, the tag/name disagreement is preserved.
    return {
      status: "CONFLICT",
      winningSource: "audio",
      agreement: false,
      conflict: true,
      audioType: input.audioType,
      tagType,
      nameType,
    };
  }

  // 3) Weak audio - metadata supports the classification (§25) ----------------
  // The metadata type is adopted under a low-confidence TAG-SUPPORTED status.
  // When the tag and name disagree but audio is weak, nothing is strong enough
  // to decide: UNKNOWN with the conflict surfaced.
  if (meta.conflict) {
    return {
      status: "UNKNOWN",
      winningSource: "none",
      agreement: false,
      conflict: true,
      audioType: input.audioType,
      tagType,
      nameType,
    };
  }
  const closeEnoughToAudio = meta.type === input.audioType;
  return {
    status: "TAG-SUPPORTED",
    winningSource: meta.source,
    agreement: closeEnoughToAudio,
    conflict: false,
    audioType: input.audioType,
    tagType,
    nameType,
  };
}