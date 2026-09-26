import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import { ElasticDB } from "./elasticdb";
import { QueueStore, QueueOptions } from "./queueStore";

/** Open an isolated QueueStore over a throw-away IndexedDB with a controllable clock. */
async function freshQueue(
  opts: Pick<QueueOptions, "backoffMs" | "maxAttempts"> = {},
) {
  let t = 0;
  const clock = { value: 0, set: (v: number) => (t = v) };
  const db = new ElasticDB(
    `queue-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    1,
    (idb) => {
      idb.createObjectStore("jobs", { keyPath: "sampleId" });
    },
  );
  const queue = new QueueStore(db, {
    now: () => t,
    backoffMs: opts.backoffMs,
    maxAttempts: opts.maxAttempts,
  });
  return { queue, db, clock };
}

describe("QueueStore", () => {
  it("enqueues a new job as 'added'", async () => {
    const { queue, db } = await freshQueue();
    try {
      const r = await queue.enqueue("samples/a", "build-v1");
      expect(r).toBe("added");
      expect(await queue.countByStatus("queued")).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("is idempotent for the same build after success", async () => {
    const { queue, db } = await freshQueue();
    try {
      await queue.enqueue("samples/a", "build-v1");
      const due = await queue.nextDue(1);
      expect(due.length).toBe(1);
      await queue.markAnalyzed(due[0]);
      const again = await queue.enqueue("samples/a", "build-v1");
      expect(again).toBe("existing");
      expect(await queue.countByStatus("analyzed")).toBe(1);
      expect(await queue.countByStatus("queued")).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("re-queues a failed job when retry is due (exponential backoff)", async () => {
    const { queue, db, clock } = await freshQueue({ backoffMs: 1000 });
    try {
      clock.set(0);
      await queue.enqueue("samples/a", "build-v1");
      const job = (await queue.nextDue(1))[0];
      await queue.markFailed(job, "network error");
      clock.set(500);
      expect(await queue.nextDue(1)).toHaveLength(0);
      clock.set(2000);
      const due = await queue.nextDue(1);
      expect(due.length).toBe(1);
      expect(due[0].status).toBe("failed");
      expect(due[0].attempts).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("respects maxAttempts and stops scheduling further retries", async () => {
    const { queue, db, clock } = await freshQueue({ maxAttempts: 2 });
    try {
      clock.set(0);
      await queue.enqueue("samples/a", "build-v1");
      let job = (await queue.nextDue(1))[0];
      await queue.markFailed(job, "e1");
      clock.set(5000);
      job = (await queue.nextDue(1))[0];
      await queue.markFailed(job, "e2");
      const persisted = await queue.get("samples/a");
      expect(persisted?.attempts).toBe(2);
      expect(persisted?.nextRetryAt).toBeUndefined();
      clock.set(10_000);
      expect(await queue.nextDue(1)).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it("marks skipped and gone", async () => {
    const { queue, db } = await freshQueue();
    try {
      await queue.enqueue("samples/skip", "build-v1");
      await queue.enqueue("samples/gone", "build-v1");
      const skip = (await queue.nextDue(1))[0];
      await queue.markSkipped(skip, "already analyzed");
      const gone = (await queue.nextDue(1))[0];
      await queue.markGone(gone, "404 sample missing");
      expect(await queue.countByStatus("skipped")).toBe(1);
      expect(await queue.countByStatus("gone")).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("returns due jobs in FIFO order", async () => {
    const { queue, db, clock } = await freshQueue();
    try {
      clock.set(1000);
      await queue.enqueue("samples/b", "v1");
      clock.set(2000);
      await queue.enqueue("samples/a", "v1");
      const due = await queue.nextDue(5);
      expect(due.map((j) => j.sampleId)).toEqual(["samples/b", "samples/a"]);
    } finally {
      await db.close();
    }
  });

  it("never stores audio byte containers in jobs", async () => {
    const { queue, db } = await freshQueue();
    try {
      await queue.enqueue("samples/a", "build-v1");
      await queue.enqueue("samples/b", "build-v1");
      const all = await queue.all();
      for (const job of all) {
        expect(JSON.stringify(job)).not.toContain("data:");
        expect(job).not.toHaveProperty("blob");
        expect(job).not.toHaveProperty("arrayBuffer");
      }
    } finally {
      await db.close();
    }
  });
});
