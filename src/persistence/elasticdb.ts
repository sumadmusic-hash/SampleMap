/**
 * Thin promise-based wrapper around IndexedDB.
 *
 * Responsibilities:
 *  - open a named database at a given schema version
 *  - run migrations via `onupgradeneeded` when the schema version increases
 *  - expose small typed CRUD + iteration helpers
 *
 * This layer is deliberately value-agnostic: it persists whatever the caller
 * stores. The SampleMap persistence contract ("never persist audio bytes",
 * see SAMPLEMAP_V1_SPEC §1.1) is enforced at the store level (SampleIndexRecord /
 * AnalysisJob shapes) plus the dedicated invariant test in indexStore.test.ts.
 */
export type StoreUpgrade = (
  db: IDBDatabase,
  tx: IDBTransaction,
  oldVersion: number,
  newVersion: number,
) => void;

export class ElasticDB {
  private readonly dbPromise: Promise<IDBDatabase>;

  constructor(
    private readonly name: string,
    private readonly version: number,
    onUpgrade: StoreUpgrade,
  ) {
    this.dbPromise = this.open(onUpgrade);
  }

  private open(onUpgrade: StoreUpgrade): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(this.name, this.version);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = (ev) => {
        onUpgrade(
          req.result as IDBDatabase,
          req.transaction as IDBTransaction,
          ev.oldVersion ?? 0,
          ev.newVersion ?? 0,
        );
      };
      req.onsuccess = () => resolve(req.result as IDBDatabase);
      req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
      req.onblocked = () => reject(new Error("IDB open blocked"));
    });
  }

  async get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    const db = await this.dbPromise;
    return new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error ?? new Error("get failed"));
    });
  }

  async getAll<T>(store: string): Promise<T[]> {
    const db = await this.dbPromise;
    return new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve((req.result as T[] | undefined) ?? []);
      req.onerror = () => reject(req.error ?? new Error("getAll failed"));
    });
  }

  async put(
    store: string,
    value: unknown,
    key?: IDBValidKey,
  ): Promise<IDBValidKey> {
    const db = await this.dbPromise;
    return new Promise<IDBValidKey>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      const req =
        key === undefined
          ? tx.objectStore(store).put(value)
          : tx.objectStore(store).put(value, key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("put failed"));
    });
  }

  async delete(store: string, key: IDBValidKey): Promise<void> {
    const db = await this.dbPromise;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error("delete failed"));
    });
  }

  async clear(store: string): Promise<void> {
    const db = await this.dbPromise;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      const req = tx.objectStore(store).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error("clear failed"));
    });
  }

  async count(store: string): Promise<number> {
    const db = await this.dbPromise;
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("count failed"));
    });
  }

  async close(): Promise<void> {
    const db = await this.dbPromise;
    db.close();
  }
}
