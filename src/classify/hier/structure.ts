/**
 * STEP44 — Stage 0: structural identity (§7–§8).
 *
 * Structure is bound from AUTHORITATIVE METADATA only:
 *   kind === "loop"                          → "loop"
 *   kind === "one-shot" && duration > 4s     → "sustained-phrase"
 *   otherwise                                → "one-shot"
 *
 * The old `duration > 2.5 → loop` race is GONE: a one-shot remains a one-shot
 * regardless of duration unless it satisfies the explicit sustained-phrase
 * rule, and a loop remains a loop because `kind === "loop"` — even when the
 * loop is shorter than 2.5s (§8). Duration alone NEVER flips kind identity.
 */
import type { SoundStructure } from "./types";

/** One-shot lengths above this (seconds) are long enough to be a full phrase. */
export const SUSTAINED_PHRASE_THRESHOLD_SEC = 4;

export interface StructureMeta {
  kind: string;
  durationSeconds: number;
}

/** Deterministic Stage 0 classification. Pure; no audio. */
export function classifyStructure(meta: StructureMeta): SoundStructure {
  const kind = (meta.kind ?? "unknown").toLowerCase().trim();
  if (kind === "loop") return "loop";
  if (kind === "one-shot" && meta.durationSeconds > SUSTAINED_PHRASE_THRESHOLD_SEC)
    return "sustained-phrase";
  return "one-shot";
}