/**
 * STEP38 — tag normalization.
 *
 * Normalizes raw Audiotool tags to deterministic, comparable tokens for the
 * SEMANTIC classification layer. The normalization is lossy for display but
 * faithful for matching: lowercase, non-alphanumeric runs become single
 * spaces, runs collapse, edges are trimmed. Input tags are NEVER mutated.
 */
export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Normalize a tag list preserving order; empty/blank tags become "". */
export function normalizeTags(tags: readonly string[]): string[] {
  return tags.map((t) => normalizeTag(t));
}