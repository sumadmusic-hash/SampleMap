/**
 * STEP28 — the persistent Sound Collection store.
 *
 * This is the IndexedDB adapter for `PersistedSoundCollection` documents. The
 * persisted document holds ONLY metadata + sampleId REFERENCES — never audio
 * bytes and never `SampleIndexRecord` snapshots (§17/§22). The write path
 * re-validates with the pure core (`serializeCollection`) and refuses corrupt
 * writes; the read path validates every row and surfaces invalid rows to the
 * caller instead of silently dropping, repairing or deleting them (§20/§21).
 *
 * Ordering rule (§46, documented decision): `list()` returns collections
 * deterministically by `updatedAt` DESCENDING (most recently updated first)
 * with `id` ascending as the stable tiebreak.
 */
import { ElasticDB } from "./elasticdb";
import { STORES } from "./db";
import { assertNoAudioBytes } from "./indexStore";
import {
  serializeCollection,
  validatePersistedCollection,
  type CollectionValidationResult,
  type PersistedSoundCollection,
} from "../analysis/collectionPersistence";

/** A row returned by the store: a valid collection or a rejected invalid one. */
export type CollectionListRow = CollectionValidationResult;

/**
 * STEP28 persistence boundary. The app depends on this interface; the
 * IndexedDB implementation lives here and tests may substitute an in-memory
 * fake that honors the same contracts (same-name duplicates allowed, corrupt
 * rows surfaced, unsupported versions never deleted).
 */
export interface CollectionStore {
  /** Every persisted collection, deterministic order (§46). Invalid rows are
   *  surfaced (not dropped): `ok:false` rows keep the app honest. */
  list(): Promise<readonly CollectionListRow[]>;
  /** One collection by id; `undefined` when no such key exists. Corrupt rows
   *  are surfaced as `ok:false` — never silently deleted or replaced. */
  get(id: string): Promise<CollectionListRow | undefined>;
  /** Persist a collection. Throws (refuses) when the model fails validation —
   *  a corrupt write is a programming-contract violation. */
  put(collection: PersistedSoundCollection): Promise<void>;
  /** Remove a collection. Removing a missing id is a no-op success
   *  (IndexedDB semantics). NEVER deletes index/library/analysis rows — it
   *  only removes the reference document (§32). */
  delete(id: string): Promise<void>;
  /** Remove every collection (test/utility only, mirrors other stores). */
  clear(): Promise<void>;
}

export class IndexedDBCollectionStore implements CollectionStore {
  constructor(private readonly db: ElasticDB) {}

  async list(): Promise<readonly CollectionListRow[]> {
    const rows = await this.db.getAll<unknown>(STORES.collections);
    const results = rows
      .map((raw) => validatePersistedCollection(raw))
      .sort(compareRows);
    return results;
  }

  async get(id: string): Promise<CollectionListRow | undefined> {
    const raw = await this.db.get<unknown>(STORES.collections, id);
    if (raw === undefined) return undefined;
    return validatePersistedCollection(raw);
  }

  async put(collection: PersistedSoundCollection): Promise<void> {
    // Guard the ORIGINAL document first: a smuggled byte container would be
    // silently stripped by serializeCollection; refuse it before any write.
    assertNoAudioBytes(collection);
    const serialized = serializeCollection(collection);
    assertNoAudioBytes(serialized);
    await this.db.put(STORES.collections, serialized);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(STORES.collections, id);
  }

  async clear(): Promise<void> {
    await this.db.clear(STORES.collections);
  }
}

function compareRows(
  a: CollectionListRow,
  b: CollectionListRow,
): number {
  const aKey = sortKey(a);
  const bKey = sortKey(b);
  if (aKey.updatedAt === bKey.updatedAt) {
    return aKey.id.localeCompare(bKey.id);
  }
  return bKey.updatedAt - aKey.updatedAt;
}

function sortKey(row: CollectionListRow): { updatedAt: number; id: string } {
  if (row.ok) {
    return { updatedAt: row.collection.updatedAt, id: row.collection.id };
  }
  return { updatedAt: 0, id: row.invalid.id ?? "" };
}