import type { AnalysisJob, QueueStore } from "../persistence/queueStore";
import type { AnalysisPipeline } from "./analysisPipeline";

/**
 * JobRunner — incremental, pausable/resumable analysis orchestration (§5.0 /
 * §20.8).
 *
 *  - processes the persisted job queue via `QueueStore.nextDue`
 *  - controlled budget mode: analyze `10 / 100 / 1000` NEW samples per run,
 *    then stop cleanly (a later, higher-budget run resumes from the persisted
 *    state without re-analyzing — idempotency via `(sampleId, analysisBuild)`)
 *  - pause / resume without job loss: pause is checked between jobs; persisted
 *    queue state means resume reprocesses from where it stopped
 *  - retry / backoff / maxAttempts: delegated to QueueStore.markFailed +
 *    nextDue (failed jobs are only due again after their backoff window)
 *  - error isolation: a failure marks only that job (failed/gone/skipped) and
 *    never blocks the rest of the queue
 *  - recovery: on start, stuck `processing` jobs (left by a crash/interrupt)
 *    are reset to `queued` via the existing QueueStore.enqueue API
 *
 * Concurrency is intentionally 1 (MAX_CONCURRENCY, spec §5.1): sequential
 * fetch→decode→infer per sample keeps the browser-resident analysis tractable.
 */

export type AnalysisBudget = 10 | 100 | 1000;

export type RunStopReason = "budget" | "pause" | "empty";

export interface RunProgress {
  analyzed: number;
  failed: number;
  skipped: number;
  gone: number;
  stoppedReason: RunStopReason | undefined;
}

export interface JobRunnerOptions {
  pipeline: AnalysisPipeline;
  queue: QueueStore;
  analysisBuild: string;
  /** How many NEW samples to analyze this run (controlled mode). Default: no budget. */
  budget?: AnalysisBudget;
  /** Reset stuck `processing` jobs to `queued` on start. Default: true. */
  recoverStuck?: boolean;
}

export class JobRunner {
  private readonly pipeline: AnalysisPipeline;
  private readonly queue: QueueStore;
  private readonly analysisBuild: string;
  private readonly budget: number | undefined;
  private readonly recoverStuck: boolean;

  private running = false;
  private paused = false;
  private progress: RunProgress = {
    analyzed: 0,
    failed: 0,
    skipped: 0,
    gone: 0,
    stoppedReason: undefined,
  };
  private lastError: string | undefined;

  constructor(opts: JobRunnerOptions) {
    this.pipeline = opts.pipeline;
    this.queue = opts.queue;
    this.analysisBuild = opts.analysisBuild;
    this.budget = opts.budget;
    this.recoverStuck = opts.recoverStuck ?? true;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Latest progress of the most recent/current run. */
  progressSnapshot(): Readonly<RunProgress> {
    return { ...this.progress };
  }

  /** Value of `progressSnapshot().stoppedReason` (undefined while running). */
  lastStoppedReason(): RunStopReason | undefined {
    return this.progress.stoppedReason;
  }

  /** The last per-job error encountered (for diagnostics). */
  lastErrorReason(): string | undefined {
    return this.lastError;
  }

  /**
   * Signal a clean pause. The in-flight job (concurrency 1) completes and is
   * persisted; the loop stops before starting the next job, losing nothing.
   */
  pause(): void {
    if (this.running) this.paused = true;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Run the queue until the budget is used up, the queue is empty, or `pause()`
   * is requested. Calling `start()` again afterwards resumes from persisted
   * state (this is "resume").
   */
  async start(): Promise<RunProgress> {
    if (this.running) {
      throw new Error("job runner is already running");
    }
    this.running = true;
    this.paused = false;
    this.progress = {
      analyzed: 0,
      failed: 0,
      skipped: 0,
      gone: 0,
      stoppedReason: undefined,
    };
    this.lastError = undefined;

    try {
      if (this.recoverStuck) {
        await this.recoverStuckProcessing();
      }

      for (;;) {
        if (this.paused) {
          this.progress.stoppedReason = "pause";
          break;
        }
        if (this.budget !== undefined && this.progress.analyzed >= this.budget) {
          this.progress.stoppedReason = "budget";
          break;
        }

        const due = await this.queue.nextDue(1);
        const job = due[0];
        if (!job) {
          this.progress.stoppedReason = "empty";
          break;
        }

        await this.processOne(job);
      }
    } finally {
      this.running = false;
    }

    return this.progressSnapshot();
  }

  /** Requeue jobs left in `processing` by a crash/interrupt, so they retry. */
  private async recoverStuckProcessing(): Promise<void> {
    const jobs = await this.queue.all();
    for (const job of jobs) {
      if (job.status === "processing") {
        await this.queue.enqueue(job.sampleId, this.analysisBuild);
      }
    }
  }

  private async processOne(job: AnalysisJob): Promise<void> {
    try {
      await this.queue.markProcessing(job);
    } catch (e) {
      this.progress.failed++;
      this.lastError = String(e);
      return;
    }

    try {
      const outcome = await this.pipeline.run(job.sampleId, this.analysisBuild);
      switch (outcome.status) {
        case "analyzed":
          await this.queue.markAnalyzed(job);
          this.progress.analyzed++;
          break;
        case "skipped":
          await this.queue.markSkipped(job, outcome.error);
          this.progress.skipped++;
          break;
        case "gone":
          await this.queue.markGone(job, outcome.error);
          this.progress.gone++;
          break;
        case "failed":
          await this.queue.markFailed(job, outcome.error);
          this.progress.failed++;
          this.lastError = outcome.error;
          break;
      }
    } catch (e) {
      // Defence-in-depth: per-job isolation so one failure cannot stop the queue.
      const message = e instanceof Error ? e.message : String(e);
      try {
        await this.queue.markFailed(job, message);
      } catch {
        // Ignore a failed status write; the loop continues regardless.
      }
      this.progress.failed++;
      this.lastError = message;
    }
  }
}
