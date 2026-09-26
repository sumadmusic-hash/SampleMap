import type { IndexStore, SampleIndexRecord } from "../persistence/indexStore";
import type { ClassId } from "../persistence/indexStore";
import {
  DRUM_CLASSES,
  MUSICAL_CLASSES,
  OTHER_CLASSES,
} from "../classify/taxonomy";

/**
 * SearchEngine — read-only, deterministic search over the SampleMap Index
 * (SAMPLEMAP_V1_SPEC §8.2).
 *
 * It works EXCLUSIVELY against the given `IndexStore` (read via getAll) and
 * never writes, never loads audio, never triggers analysis, and never calls a
 * classifier. It is a pure, side-effect-free projection:
 *
 *   index.getAll() � text / class / confidence / status filters �
 *   relevance scoring � deterministic sort � limit � SearchResult[]
 *
 * Design notes:
 *  - Deterministic: every comparator is total (a stable sampleId tiebreaker is
 *    applied after the chosen sort key), so identical index + query yield an
 *    identical result regardless of IndexedDB iteration order.
 *  - Default status is `analyzed`; `gone` (and other non-analysed statuses) are
 *    excluded unless explicitly requested via `statuses`.
 *  - Class filter accepts both single classes (kick, bass, vocal) AND taxonomy
 *    group names (drums, musical, other), OR-ed together (multi-select).
 *  - Relevance, when a text query is present, blends token match strength with
 *    classification confidence; without text it reduces to confidence (matching
 *    the spec's "Relevanz (Konfidenz bei Filterabfragen)").
 */

/** Fields searched by the text query. */
export type SearchTextFields = "name" | "originalTags" | "owner";

export type SearchSort = "relevance" | "confidence" | "name" | "analyzedAt";
export type SearchSortDir = "asc" | "desc";

export interface SearchQuery {
  /** Free-text token query over name, originalTags and owner. */
  text?: string;
  /**
   * Multi-select class filter (OR). Entries may be a ClassId (e.g. "kick",
   * "bass", "vocal") or a taxonomy group name ("drums", "musical", "other").
   * A record matches if its primaryClass OR any secondaryClass is in the set.
   */
  classes?: readonly string[];
  /** Optional minimum primary confidence, inclusive, 0..1. */
  minConfidence?: number;
  /** Allowed analysis statuses. Defaults to ["analyzed"]. */
  statuses?: readonly ("pending" | "analyzed" | "failed" | "gone")[];
  /** Sort key. Default "relevance". */
  sortBy?: SearchSort;
  /** Sort direction. Default "desc". */
  sortDir?: SearchSortDir;
  /** Maximum number of results to return. */
  limit?: number;
}

export interface SearchResult {
  record: SampleIndexRecord;
  /** 0..1 relevance score used for "relevance" ordering. */
  score: number;
}

export interface SearchEngine {
  search(query?: SearchQuery): Promise<SearchResult[]>;
}

interface Scored {
  record: SampleIndexRecord;
  textScore: number;
  score: number;
}

/** Taxonomy group name -> member classes (for "Drums" / "Musical" / "Other"). */
const GROUP_MEMBERS: Record<string, readonly ClassId[]> = {
  drums: DRUM_CLASSES,
  musical: MUSICAL_CLASSES,
  other: OTHER_CLASSES,
};

const DEFAULT_STATUSES: readonly ("pending" | "analyzed" | "failed" | "gone")[] = [
  "analyzed",
];
const DEFAULT_SORT_BY: SearchSort = "relevance";
const DEFAULT_SORT_DIR: SearchSortDir = "desc";

export class SampleMapSearchEngine implements SearchEngine {
  constructor(private readonly index: IndexStore) {}

  async search(query: SearchQuery = {}): Promise<SearchResult[]> {
    const statuses = query.statuses ?? DEFAULT_STATUSES;
    const accepted = expandClasses(query.classes ?? []);
    const minConfidence = query.minConfidence;
    const sortBy = query.sortBy ?? DEFAULT_SORT_BY;
    const dir = query.sortDir ?? DEFAULT_SORT_DIR;
    const queryTokens = query.text ? tokenize(query.text) : [];

    const all = await this.index.getAll();
    const scored: Scored[] = [];

    for (const record of all) {
      if (!statuses.includes(record.status)) continue;
      if (accepted.size > 0 && !matchesAnyClass(record, accepted)) continue;
      if (minConfidence !== undefined && record.confidence < minConfidence) {
        continue;
      }

      const textScore = queryTokens.length > 0
        ? scoreText(record, queryTokens)
        : 1;
      if (queryTokens.length > 0 && textScore <= 0) continue;

      // Relevance merges text-match strength with confidence; without text the
      // spec's "relevance" reduces to confidence ordering.
      const score =
        queryTokens.length > 0
          ? 0.75 * textScore + 0.25 * record.confidence
          : record.confidence;

      scored.push({ record, textScore, score });
    }

    const ordered = scored.sort((a, b) =>
      compare(a, b, sortBy, dir),
    );

    const limited = query.limit !== undefined
      ? ordered.slice(0, Math.max(0, query.limit))
      : ordered;

    return limited.map((s) => ({ record: s.record, score: round4(s.score) }));
  }
}

/** Total deterministic comparator: chosen sort key, then sampleId tiebreaker. */
function compare(a: Scored, b: Scored, sortBy: SearchSort, dir: SearchSortDir): number {
  let cmp: number;
  switch (sortBy) {
    case "confidence":
      cmp = a.record.confidence - b.record.confidence;
      break;
    case "name":
      cmp = a.record.name.localeCompare(b.record.name);
      break;
    case "analyzedAt":
      cmp = a.record.analyzedAt.localeCompare(b.record.analyzedAt);
      break;
    // "relevance" (or default)
    default: {
      const d = a.score - b.score;
      // Equal relevance -> fall back to text strength, then confidence.
      cmp = d !== 0 ? d : a.textScore - b.textScore;
      if (cmp === 0) cmp = a.record.confidence - b.record.confidence;
    }
  }
  if (cmp === 0) {
    // Stable tiebreaker guarantees determinism regardless of input order.
    cmp = a.record.sampleId.localeCompare(b.record.sampleId);
  }
  return dir === "asc" ? cmp : -cmp;
}

/** Expand class/group tokens into a set of matching ClassIds. */
function expandClasses(classes: readonly string[]): Set<ClassId> {
  const out = new Set<ClassId>();
  for (const raw of classes) {
    const c = raw.toLowerCase().trim();
    if (!c) continue;
    const group = GROUP_MEMBERS[c];
    if (group) {
      for (const member of group) out.add(member);
    } else {
      out.add(c);
    }
  }
  return out;
}

function matchesAnyClass(record: SampleIndexRecord, accepted: Set<ClassId>): boolean {
  if (accepted.has(record.primaryClass)) return true;
  return record.secondaryClasses.some((s) => accepted.has(s.class));
}

/**
 * Deterministic token match strength of a record against the query tokens.
 * Returns > 0 (matched) or 0 (no match). Uses prefix/substring matching for
 * simple, robust fuzzy behaviour.
 */
function scoreText(record: SampleIndexRecord, queryTokens: string[]): number {
  const haystack = searchableTokens(record);
  let total = 0;
  for (const q of queryTokens) {
    const best = bestTokenMatch(q, haystack);
    if (best <= 0) return 0; // a required token is absent -> no match
    total += best;
  }
  return total / (3 * queryTokens.length); // exact = 3, prefix = 2, substring = 1
}

/** Lowercased unique tokens across name, originalTags and owner. */
function searchableTokens(record: SampleIndexRecord): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (s: string) => {
    for (const t of tokenize(s)) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  };
  push(record.name);
  for (const tag of record.originalTags) push(tag);
  push(record.owner);
  return out;
}

function bestTokenMatch(q: string, haystack: string[]): number {
  let best = 0;
  for (const t of haystack) {
    if (t === q) return 3;
    if (t.startsWith(q)) best = Math.max(best, 2);
    else if (t.includes(q)) best = Math.max(best, 1);
  }
  return best;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
