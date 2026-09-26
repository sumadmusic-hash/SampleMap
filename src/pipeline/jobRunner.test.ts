import { describe, it, expect } from "vitest";
import type { SampleMeta } from "@audiotool/nexus/api";
import { AnalysisPipeline } from "./analysisPipeline";
import { JobRunner } from "./jobRunner";
import type { Classifier } from "../classify/classifier";
import { makeFeatures } from "../classify/test-helpers";
import { makeSampleMeta } from "../library/test-helpers";
import { openTestDatabase } from "../persistence/test-helpers";
import { QueueStore } from "../persistence/queueStore";
import type { DecodedAudio } from "../audio/decodedAudio";
import { buildWavWithSeed } from "../audio/fixtures";

function makeDecoded(): DecodedAudio {
  return {
    sampleRate: 44100,
    channels: 1,
    mono: new Float32Array(44100),
    durationSeconds: 1,
  };
}

interface Rig {
  runner: JobRunner;
  queue: QueueStore;
  clock: { value: number; set: (v: number) => void };
  pipeline: AnalysisPipeline;
}

interface RigOptions {
  budget?: 10 | 100 | 1000;
  maxAttempts?: number;
  backoffMs?: number;
  /** Override resolution to be controlled per test. */
  resolveSample?: (id: string) => Promise<SampleMeta | undefined>;
  /** Fail (throw) for a given sampleId when fetching audio. */
  failFetch?: (id: string) => boolean;
  /** Return a gate that, when awaited, blocks the fetch for that sample. */
  fetchGate?: (id: string) => Promise<void>;
}

async function mk(opts: RigOptions = {}): Promise<Rig> {
  const handle = await openTestDatabase();
  let t = 0;
  const clock = { value: 0, set: (v: number) => (t = v) };
  const queue = new QueueStore(handle.db, {
    now: () => t,
    backoffMs: opts.backoffMs ?? 0,
    retryJitterMs: 0,
    maxAttempts: opts.maxAttempts,
  });

  const classifier: Classifier = {
    id: "heuristic",
    version: "heuristic-v1",
    classify: async () => ({
      primaryClass: "kick",
      confidence: 0.9,
      secondaryClasses: [],
    }),
  };

  const resolveSample =
    opts.resolveSample ??
    (async (id: string) => makeSampleMeta(id));

  const pipeline = new AnalysisPipeline({
    fetchAudio: async (sample: SampleMeta) => {
      if (opts.failFetch?.(sample.name)) throw new Error(`fetch failed: ${sample.name}`);
      if (opts.fetchGate) await opts.fetchGate(sample.name);
      return { bytes: buildWavWithSeed({ frames: 10, seed: sample.name.length }), release: () => undefined };
    },
    decode: async () => makeDecoded(),
    extract: () => makeFeatures(),
    classifier,
    resolveSample,
    index: handle.index,
    analysisVersion: "features-v1",
    now: () => new Date(t),
  });

  const runner = new JobRunner({
    pipeline,
    queue,
    analysisBuild: "build-v1",
    budget: opts.budget,
  });

  return { runner, queue, clock, pipeline };
}

/** Enqueue several samples under the runner's analysisBuild. */
async function seed(r: Rig, ids: string[]): Promise<void> {
  for (const id of ids) {
    await r.queue.enqueue(id, "build-v1");
  }
}

describe("JobRunner", () => {
  it("processes all queued jobs and stops on empty", async () => {
    const r = await mk();
    await seed(r, ["samples/a", "samples/b", "samples/c"]);
    const progress = await r.runner.start();
    expect(progress.analyzed).toBe(3);
    expect(progress.stoppedReason).toBe("empty");
    expect(await r.queue.countByStatus("analyzed")).toBe(3);
    expect(await r.queue.countByStatus("queued")).toBe(0);
  });

  it("is idempotent: already-analyzed jobs are not re-processed", async () => {
    const r = await mk();
    await seed(r, ["samples/a"]);
    const first = await r.runner.start();
    expect(first.analyzed).toBe(1);
    // Re-running the same build adds nothing new.
    const second = await r.runner.start();
    expect(second.analyzed).toBe(0);
    expect(second.stoppedReason).toBe("empty");
    expect(await r.queue.countByStatus("analyzed")).toBe(1);
  });

  it("respects budget 10 and leaves the rest queued for a later run", async () => {
    const r = await mk({ budget: 10 });
    await seed(r, Array.from({ length: 12 }, (_, i) => `samples/s${i}`));
    const progress = await r.runner.start();
    expect(progress.analyzed).toBe(10);
    expect(progress.stoppedReason).toBe("budget");
    expect(await r.queue.countByStatus("analyzed")).toBe(10);
    expect(await r.queue.countByStatus("queued")).toBe(2);
    // Resume with a higher budget processes the remainder without re-analyzing.
    const resume = await new JobRunner({
      pipeline: r.pipeline,
      queue: r.queue,
      analysisBuild: "build-v1",
      budget: 1000,
    }).start();
    expect(resume.analyzed).toBe(2);
    expect(await r.queue.countByStatus("analyzed")).toBe(12);
  });

  it("runs to completion under budget 100 and 1000", async () => {
    for (const budget of [100, 1000] as const) {
      const r = await mk({ budget });
      await seed(r, ["samples/a", "samples/b"]);
      const progress = await r.runner.start();
      expect(progress.analyzed).toBe(2);
      expect(progress.stoppedReason).toBe("empty");
    }
  });

  it("pauses cleanly without losing jobs, then resumes", async () => {
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (releaseFetch = resolve));
    const r = await mk({
      fetchGate: async (id) => {
        if (id === "samples/a") await gate;
      },
    });
    await seed(r, ["samples/a", "samples/b", "samples/c"]);

    const run = r.runner.start();
    // Give the in-flight first job a moment to reach its fetch gate.
    await new Promise((res) => setTimeout(res, 10));
    r.runner.pause();
    releaseFetch!();
    const progress = await run;

    expect(progress.stoppedReason).toBe("pause");
    expect(progress.analyzed).toBe(1); // the in-flight job completed
    // No job loss: the remaining ones are still queued/pending.
    expect(await r.queue.countByStatus("queued")).toBe(2);

    // Resume runs to completion.
    const resumed = await r.runner.start();
    expect(resumed.analyzed).toBe(2);
    expect(resumed.stoppedReason).toBe("empty");
    expect(await r.queue.countByStatus("analyzed")).toBe(3);
  });

  it("retries a once-failing job (backoff) until it succeeds", async () => {
    let fetchAttempts = 0;
    const r = await mk({
      backoffMs: 1000,
      failFetch: (id) => id === "samples/a" && fetchAttempts++ === 0,
    });
    await seed(r, ["samples/a"]);
    // First run: job fails; retry scheduled but not yet due.
    const first = await r.runner.start();
    expect(first.failed).toBe(1);
    expect(await r.queue.countByStatus("failed")).toBe(1);
    // Advance past the backoff window so the retry is due, then resume.
    r.clock.set(5000);
    const second = await r.runner.start();
    expect(second.analyzed).toBe(1);
    const job = await r.queue.get("samples/a");
    expect(job?.status).toBe("analyzed");
    expect(job?.attempts).toBeGreaterThan(0);
  });

  it("respects maxAttempts and stops retrying terminal failures", async () => {
    const r = await mk({ maxAttempts: 2, backoffMs: 0, failFetch: () => true });
    await seed(r, ["samples/a"]);
    const progress = await r.runner.start();
    expect(progress.failed).toBe(2);
    expect(progress.stoppedReason).toBe("empty");
    const job = await r.queue.get("samples/a");
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(2);
    expect(job?.nextRetryAt).toBeUndefined();
  });

  it("isolates errors: a failing sample does not stop the queue", async () => {
    const r = await mk({
      maxAttempts: 1,
      failFetch: (id) => id === "samples/bad",
    });
    await seed(r, ["samples/good", "samples/bad", "samples/also-good"]);
    const progress = await r.runner.start();
    expect(progress.stoppedReason).toBe("empty");
    expect(progress.failed).toBe(1);
    expect(progress.analyzed).toBe(2);
    expect(await r.queue.countByStatus("failed")).toBe(1);
    expect(await r.queue.countByStatus("analyzed")).toBe(2);
  });

  it("marks unreachable samples as gone without blocking the queue", async () => {
    const r = await mk({
      resolveSample: async (id) =>
        id === "samples/ghost" ? undefined : makeSampleMeta(id),
    });
    await seed(r, ["samples/ghost", "samples/real"]);
    const progress = await r.runner.start();
    expect(progress.gone).toBe(1);
    expect(progress.analyzed).toBe(1);
    expect(await r.queue.countByStatus("gone")).toBe(1);
    expect(await r.queue.countByStatus("analyzed")).toBe(1);
  });

  it("recovers stuck 'processing' jobs left by a crash", async () => {
    const r = await mk();
    await seed(r, ["samples/a"]);
    // Simulate a crash: pull the job, mark it processing, never finish it.
    const stuck = (await r.queue.nextDue(1))[0];
    await r.queue.markProcessing(stuck);
    expect(await r.queue.countByStatus("processing")).toBe(1);

    // A fresh runner (recovery enabled) requeues and completes it.
    const runner2 = new JobRunner({
      pipeline: r.pipeline,
      queue: r.queue,
      analysisBuild: "build-v1",
    });
    const progress = await runner2.start();
    expect(progress.analyzed).toBe(1);
    expect(await r.queue.countByStatus("processing")).toBe(0);
    expect(await r.queue.countByStatus("analyzed")).toBe(1);
  });

  it("does not reprocess stuck jobs when recovery is disabled", async () => {
    const r = await mk();
    await seed(r, ["samples/a"]);
    const stuck = (await r.queue.nextDue(1))[0];
    await r.queue.markProcessing(stuck);
    const runner2 = new JobRunner({
      pipeline: r.pipeline,
      queue: r.queue,
      analysisBuild: "build-v1",
      recoverStuck: false,
    });
    const progress = await runner2.start();
    expect(progress.analyzed).toBe(0);
    // The processing job is not queued, so nothing was due.
    expect(progress.stoppedReason).toBe("empty");
    expect(await r.queue.countByStatus("processing")).toBe(1);
  });
});