/**
 * STEP28 — Persistent Sound Collections: the pure persistence core.
 *
 * This module serializes/validates/normalizes the STEP27 `SoundCollectionState`
 * working set into a durable `PersistedSoundCollection`. It is 100% PURE: no
 * DOM, no IndexedDB, no network, no Audiotool, no browser APIs beyond
 * `globalThis.crypto` (used only for collision-resistant collection IDs and
 * with a deterministic fallback). Persistence itself lives in the IndexedDB
 * adapter (`src/persistence/collectionStore.ts`); the app wires the two.
 *
 * Hard rules (§12–§21):
 *   - a persisted collection holds at most `COLLECTION_MAX_SAMPLES` (50) ids;
 *     >50 is INVALID (never silently truncated)
 *   - duplicate ids in persisted data are INVALID (never silently deduplicated)
 *   - only `COLLECTION_PERSISTENCE_SCHEMA_VERSION` ("1.0.0") is supported;
 *     unknown versions are rejected without mutation/deletion/guessing
 *   - corrupt data is DETECTED and REJECTED, never silently repaired
 *   - order is authoritative and preserved exactly through serialization
 *   - NO audio may ever be persisted — references (sample IDs) only
 *
 * A persisted collection is a reference container for `sampleId`s. It never
 * snapshots `SampleIndexRecord` objects; loaded ids are always re-resolved
 * against the current index (§36 Keep derived data current).
 */
import { COLLECTION_MAX_SAMPLES } from "./collection";

/** STEP28 persistence schema version (§18, initial 1.0.0). */
export const COLLECTION_PERSISTENCE_SCHEMA_VERSION = "1.0.0" as const;

/** Maximum name length in Unicode code points (§11). */
export const COLLECTION_NAME_MAX_CODE_POINTS = 100;

/** Default name for a freshly created collection (§24). */
export const DEFAULT_COLLECTION_NAME = "New Collection";

/**
 * STEP28 — the persisted, durable collection shape (§9).
 *
 * `id` is an immutable collision-resistant identifier independent from sample
 * IDs (§10). `sampleIds` is the authoritative explicit order (§14) of SampleMap
 * references (never full records — §17/§22). `createdAt`/`updatedAt` are ms
 * epoch timestamps; `version` pins the persistence schema (distinct from the
 * STEP27 in-memory `COLLECTION_VERSION`).
 */
export interface PersistedSoundCollection {
  id: string;
  name: string;
  sampleIds: readonly string[];
  createdAt: number;
  updatedAt: number;
  version: string;
}

/** STEP28 — a collection that failed validation, classified for the UI. */
export interface InvalidPersistedCollection {
  /** The raw persisted record key when it carried a usable string id. */
  id: string | undefined;
  /** "unsupported-version" (never mutate/never delete) vs "corrupt". */
  kind: "unsupported-version" | "corrupt";
  /** Human-readable honest reason (surfaced, never hidden). */
  reason: string;
  /** The unknown schema version when kind === "unsupported-version". */
  unknownVersion: string | undefined;
}

export type CollectionValidationResult =
  | { ok: true; collection: PersistedSoundCollection }
  | { ok: false; invalid: InvalidPersistedCollection };

/**
 * Normalize a user-provided collection name (§11):
 * trim leading/trailing whitespace, preserve Unicode, enforce at most
 * `COLLECTION_NAME_MAX_CODE_POINTS` Unicode code points, reject the empty
 * result. Duplicate names are allowed (§11 — no uniqueness constraint).
 */
export function normalizeCollectionName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return null;
  if (Array.from(name).length > COLLECTION_NAME_MAX_CODE_POINTS) return null;
  return name;
}

/**
 * Collision-resistant collection id (§10). NOT derived from name, member ids,
 * sample count or timestamp alone. Uses the runtime `crypto.randomUUID` when
 * available (browser + modern Node); a high-entropy fallback (two random
 * 128-bit-style segments + a clock component) otherwise.
 */
export function newCollectionId(): string {
  const c = globalThis.crypto;
  if (typeof c === "object" && c !== null && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  const rand = () =>
    Math.random().toString(36).slice(2).padEnd(12, "0");
  return `col-${Date.now().toString(36)}-${rand()}${rand()}`;
}

/**
 * Create a new persisted collection (§24): non-empty normalized name, empty
 * member list unless supplied, fresh `createdAt`/`updatedAt`, schema version.
 * `id`/`now` are injectable for tests (and `newCollectionId()` is the default).
 * Throws on an invalid name — the caller is required to normalize first.
 */
export function createPersistedCollection(opts: {
  name: string;
  id?: string;
  sampleIds?: readonly string[];
  now?: () => number;
}): PersistedSoundCollection {
  const name = normalizeCollectionName(opts.name);
  if (name === null) {
    throw new TypeError("collection name must be a non-empty string ≤ 100 code points");
  }
  if (opts.sampleIds !== undefined && !isValidSampleIds(opts.sampleIds)) {
    throw new TypeError("invalid sampleIds for collection creation");
  }
  const now = opts.now?.() ?? Date.now();
  return {
    id: opts.id ?? newCollectionId(),
    name,
    sampleIds: [...(opts.sampleIds ?? [])],
    createdAt: now,
    updatedAt: now,
    version: COLLECTION_PERSISTENCE_SCHEMA_VERSION,
  };
}

function isValidSampleIds(sampleIds: readonly unknown[]): boolean {
  if (sampleIds.length > COLLECTION_MAX_SAMPLES) return false;
  const seen = new Set<string>();
  for (const id of sampleIds) {
    if (typeof id !== "string" || id.length === 0) return false;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * Produce the next persisted state after a successful mutation (§25/§45):
 * copies `collection`, applies the optional name/membership change (both name
 * and ids revalidated — no silent corruption), and stamps a fresh `updatedAt`
 * from `now`. `createdAt`/`id`/`version` are immutable. Throws on invalid
 * input (a programming-contract failure; persisted PUTs never carry corrupt
 * writes).
 */
export function withUpdatedCollection(
  collection: PersistedSoundCollection,
  patch: { name?: string; sampleIds?: readonly string[] },
  now?: number,
): PersistedSoundCollection {
  const name = patch.name !== undefined ? normalizeCollectionName(patch.name) : collection.name;
  if (name === null) throw new TypeError("invalid collection name");
  const sampleIds = patch.sampleIds ?? collection.sampleIds;
  if (!isValidSampleIds(sampleIds)) throw new TypeError("invalid sampleIds update");
  return {
    ...collection,
    name,
    sampleIds: [...sampleIds],
    updatedAt: now ?? Date.now(),
  };
}

/**
 * Validate a value read from the persistence layer (§19). Every required field
 * is checked; unsupported versions and malformed records are rejected with an
 * honest classification — never silently truncated, deduplicated, deleted or
 * guessed (§20/§21). Returns a fresh copy so the caller cannot alias corrupt
 * persisted storage into the live model (immutability, P17).
 */
export function validatePersistedCollection(
  value: unknown,
): CollectionValidationResult {
  if (typeof value !== "object" || value === null) {
    return invalid("corrupt", "collection record is not an object");
  }
  const rec = value as Record<string, unknown>;

  // --- version gate FIRST: an unknown version is never interpreted (§21) ---
  if (typeof rec.version !== "string") {
    return invalid("corrupt", 'missing required string field "version"');
  }
  if (rec.version !== COLLECTION_PERSISTENCE_SCHEMA_VERSION) {
    return {
      ok: false,
      invalid: {
        id: typeof rec.id === "string" ? rec.id : undefined,
        kind: "unsupported-version",
        reason: `unsupported collection schema version "${rec.version}"`,
        unknownVersion: rec.version,
      },
    };
  }

  if (typeof rec.id !== "string" || rec.id.trim().length === 0) {
    return invalid("corrupt", 'invalid required field "id"');
  }
  const name = typeof rec.name === "string" ? normalizeCollectionName(rec.name) : null;
  if (name === null) {
    return invalid("corrupt", 'invalid required field "name"');
  }
  if (!Array.isArray(rec.sampleIds)) {
    return invalid("corrupt", 'invalid required field "sampleIds" (expected array)');
  }
  const sampleIds = rec.sampleIds as unknown[];
  if (sampleIds.length > COLLECTION_MAX_SAMPLES) {
    return invalid(
      "corrupt",
      `collection has ${sampleIds.length} sample ids (hard limit ${COLLECTION_MAX_SAMPLES})`,
    );
  }
  const ids: string[] = [];
  for (const id of sampleIds) {
    if (typeof id !== "string" || id.length === 0) {
      return invalid("corrupt", "sampleIds must contain only non-empty string ids");
    }
    ids.push(id);
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      return invalid("corrupt", `duplicate sample id in collection: "${id}"`);
    }
    seen.add(id);
  }
  if (!isFiniteTimestamp(rec.createdAt)) {
    return invalid("corrupt", 'invalid required field "createdAt"');
  }
  if (!isFiniteTimestamp(rec.updatedAt)) {
    return invalid("corrupt", 'invalid required field "updatedAt"');
  }

  return {
    ok: true,
    collection: {
      id: rec.id as string,
      name,
      sampleIds: [...ids],
      createdAt: rec.createdAt as number,
      updatedAt: rec.updatedAt as number,
      version: rec.version as string,
    },
  };

  function invalid(kind: "corrupt", reason: string): CollectionValidationResult {
    return {
      ok: false,
      invalid: {
        id: typeof rec.id === "string" ? rec.id : undefined,
        kind,
        reason,
        unknownVersion: undefined,
      },
    };
  }
}

function isFiniteTimestamp(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Serialize a collection for persistence (§17): a deterministic plain-object
 * copy that preserves ordering, timestamps and ids. Never writes audio bytes —
 * the ONLY content is metadata + sample ids. Throws on an invalid model (the
 * store refuses to persist a corrupt program-level document).
 */
export function serializeCollection(
  collection: PersistedSoundCollection,
): PersistedSoundCollection {
  const check = validatePersistedCollection(collection);
  if (!check.ok) {
    throw new TypeError(`refusing to serialize invalid collection: ${check.invalid.reason}`);
  }
  return {
    id: check.collection.id,
    name: check.collection.name,
    sampleIds: [...check.collection.sampleIds],
    createdAt: check.collection.createdAt,
    updatedAt: check.collection.updatedAt,
    version: check.collection.version,
  };
}