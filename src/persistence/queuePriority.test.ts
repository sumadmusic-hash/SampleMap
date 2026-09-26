import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import { ElasticDB } from "./elasticdb";
import { QueueStore } from "./queueStore";
import { PRIORITY_GROUP_LEGACY } from "../analysis/eligibility";

async function freshQueue() {
  let t = 0;
  const clock = { set: (v: number) => (t = v), now: () => t };
  const db = new ElasticDB(
    `queue-prio-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    1,
    (idb) => {
      idb.createObjectStore("jobs", { keyPath: "sampleId" });
    },
  );
  const queue = new QueueStore(db, { now: () => t });
  return { queue, db, clock };
}

describe("QueueStore priority ordering (STEP38 §11)", () => {
  it("drains ONE-SHOTS before LOOPS and OWN before FOREIGN regardless of enqueue order", async () => {
    const { queue, db, clock } = await freshQueue();
    try {
      clock.set(1000);
      await queue.enqueue("samples/foreign-loop", "build", 3);
      await queue.enqueue("samples/own-loop", "build", 2);
      await queue.enqueue("samples/foreign-one-shot", "build", 1);
      await queue.enqueue("samples/own-one-shot", "build", 0);

      const due = await queue.nextDue(4);
      expect(due.map((j) => j.sampleId)).toEqual([
        "samples/own-one-shot",
        "samples/foreign-one-shot",
        "samples/own-loop",
        "samples/foreign-loop",
      ]);
    } finally {
      await db.close();
    }
  });

  it("within the same group, FIFO by createdAt is preserved", async () => {
    const { queue, db, clock } = await freshQueue();
    try {
      clock.set(100);
      await queue.enqueue("samples/a", "build", 1);
      clock.set(200);
      await queue.enqueue("samples/b", "build", 1);
      clock.set(300);
      await queue.enqueue("samples/c", "build", 1);

      const due = await queue.nextDue(3);
      expect(due.map((j) => j.sampleId)).toEqual(["samples/a", "samples/b", "samples/c"]);
    } finally {
      await db.close();
    }
  });

  it("legacy jobs (no priorityGroup) keep FIFO-by-createdAt and sort after prioritized ones", async () => {
    const { queue, db, clock } = await freshQueue();
    try {
      clock.set(100);
      await queue.enqueue("samples/legacy-early", "build"); // group defaults to LEGACY
      clock.set(200);
      await queue.enqueue("samples/one-shot", "build", 0);
      clock.set(300);
      await queue.enqueue("samples/legacy-late", "build"); // group defaults to LEGACY

      const due = await queue.nextDue(3);
      // The prioritized one-shot (group 0) always comes first; the two legacy
      // jobs (group LEGACY=5) keep their createdAt order.
      expect(due.map((j) => j.sampleId)).toEqual([
        "samples/one-shot",
        "samples/legacy-early",
        "samples/legacy-late",
      ]);
    } finally {
      await db.close();
    }
  });

  it("persists and re-reads priorityGroup; re-queue keeps a caller-provided group", async () => {
    const { queue, db } = await freshQueue();
    try {
      await queue.enqueue("samples/a", "build", 0);
      const saved = (await queue.all())[0];
      expect(saved.priorityGroup).toBe(0);

      // Re-queue with a new group wins.
      await queue.enqueue("samples/a", "build-v2", 3);
      const reSaved = (await queue.all())[0];
      expect(reSaved.priorityGroup).toBe(3);
    } finally {
      await db.close();
    }
  });

  it("legacy constant is stable and equals the 'other-other' tier for backward compat", () => {
    expect(PRIORITY_GROUP_LEGACY).toBe(5);
  });
});