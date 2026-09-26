import { ElasticDB } from "./elasticdb";
import { IndexStore } from "./indexStore";
import { QueueStore } from "./queueStore";
import { CollectionStore, IndexedDBCollectionStore } from "./collectionStore";

/**
 * Central schema + wiring for the SampleMap IndexedDB database.
 *
 * The schema version is incremented when the persisted shape changes; the
 * upgrade callback applies incremental migrations from the old version.
 *
 * v3 (STEP28): adds the dedicated `collections` object store (keyPath "id")
 * that persists Sound Collections as metadata + sampleId references only.
 */
export const SCHEMA_VERSION = 3;

export const STORES = {
  samples: "samples",
  jobs: "jobs",
  collections: "collections",
} as const;

export interface DatabaseHandle {
  index: IndexStore;
  queue: QueueStore;
  collections: CollectionStore;
  db: ElasticDB;
}

/**
 * Open (or create) the SampleMap database at the requested schema version.
 * Each open with a higher version triggers the incremental migrations below.
 *
 * @param name    IndexedDB database name (isolated per test instance)
 * @param version target schema version (>= 1)
 */
export async function openDatabase(
  name = "samplemap",
  version = SCHEMA_VERSION,
): Promise<DatabaseHandle> {
  const db = new ElasticDB(name, version, (idb, tx, oldVersion) => {
    if (oldVersion < 1) {
      const samples = idb.createObjectStore(STORES.samples, {
        keyPath: "sampleId",
      });
      samples.createIndex("primaryClass", "primaryClass", { unique: false });
      samples.createIndex("status", "status", { unique: false });
      samples.createIndex("analyzedAt", "analyzedAt", { unique: false });

      const jobs = idb.createObjectStore(STORES.jobs, {
        keyPath: "sampleId",
      });
      jobs.createIndex("status", "status", { unique: false });
      jobs.createIndex("updatedAt", "updatedAt", { unique: false });

      const collections = idb.createObjectStore(STORES.collections, {
        keyPath: "id",
      });
      collections.createIndex("updatedAt", "updatedAt", { unique: false });
    }
    // --- v1 -> v2 migration: add an owner index on samples ---
    if (oldVersion < 2 && oldVersion >= 1) {
      const samples = tx.objectStore(STORES.samples);
      if (!samples.indexNames.contains("owner")) {
        samples.createIndex("owner", "owner", { unique: false });
      }
    }
    // --- v2 -> v3 migration (STEP28): add the collections store ---
    if (oldVersion < 3 && oldVersion >= 2) {
      if (!tx.objectStoreNames.contains(STORES.collections)) {
        const collections = idb.createObjectStore(STORES.collections, {
          keyPath: "id",
        });
        collections.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    }
  });

  return {
    index: new IndexStore(db),
    queue: new QueueStore(db),
    collections: new IndexedDBCollectionStore(db),
    db,
  };
}
