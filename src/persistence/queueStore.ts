import { ElasticDB } from "./elasticdb";
import { STORES } from "./db";
import { PRIORITY_GROUP_LEGACY } from "../analysis/eligibility";

export type JobStatus =
  | "queued"
  | "processing"
  | "analyzed"
  | "failed"
  | "gone"
  | "skipped";

/**
 * Persisted analysis-job state (metadata only — never audio bytes).
 * Keyed by sampleId so there is exactly one job per sample (idempotency unit).
 */
export interface AnalysisJob {
  sampleId: string;
  status: JobStatus;
  analysisBuild: string;
  attempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  nextRetryAt?: string;
  /**
   * STEP38 — deterministic queue priority tier (0..5, own-before-foreign,
   * one-shot-before-loop; see `src/analysis/eligibility`). OPTIONAL (additive):
   * jobs enqueued before this field existed omit it and sort by `createdAt`
   * within the legacy tier, preserving their historical FIFO order.
   */
  priorityGroup?: number;
}

export interface QueueOptions {
  maxAttempts?: number;
  backoffMs?: number;
  retryJitterMs?: number;
  /** Deterministic clock (ms epoch) for tests. */
  now?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 1000;

export class QueueStore {
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly retryJitterMs: number;
  private readonly nowFn: () => number;

  constructor(
    private readonly db: ElasticDB,
    opts: QueueOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.retryJitterMs = opts.retryJitterMs ?? this.backoffMs;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  private isoNow(): string {
    return new Date(this.nowFn()).toISOString();
  }

  /**
   * Add a sample to the queue. Idempotent: if a job already exists for the
   * sample with the same build and is not in a terminal-failure state, the
   * existing job is returned untouched.
   */
  async enqueue(
    sampleId: string,
    analysisBuild: string,
    priorityGroup?: number,
  ): Promise<"added" | "existing"> {
    const existing = await this.db.get<AnalysisJob>(STORES.jobs, sampleId);
    if (existing) {
      const done =
        existing.status === "analyzed" || existing.status === "skipped";
      if (existing.analysisBuild === analysisBuild && done) {
        return "existing";
      }
      // Same build but failed/gone, or a new build -> (re)queue. Keep the
      // priority group stable unless the caller re-provides one.
      await this.db.put(STORES.jobs, {
        ...existing,
        status: "queued",
        analysisBuild,
        nextRetryAt: undefined,
        updatedAt: this.isoNow(),
        ...(priorityGroup !== undefined ? { priorityGroup } : {}),
      });
      return "existing";
    }
    const job: AnalysisJob = {
      sampleId,
      status: "queued",
      analysisBuild,
      attempts: 0,
      createdAt: this.isoNow(),
      updatedAt: this.isoNow(),
      ...(priorityGroup !== undefined ? { priorityGroup } : {}),
    };
    await this.db.put(STORES.jobs, job);
    return "added";
  }

  /** Return the oldest due jobs (queued, or failed-but-retry-due) up to `limit`. */
  async nextDue(limit = 1): Promise<AnalysisJob[]> {
    const all = await this.db.getAll<AnalysisJob>(STORES.jobs);
    const now = this.nowFn();
    return all
      .filter((j) => {
        if (j.status === "queued") return true;
        if (j.status === "failed" && j.nextRetryAt) {
          return new Date(j.nextRetryAt).getTime() <= now;
        }
        return false;
      })
      .sort(
        (a, b) =>
          (a.priorityGroup !== undefined ? a.priorityGroup : PRIORITY_GROUP_LEGACY) -
            (b.priorityGroup !== undefined ? b.priorityGroup : PRIORITY_GROUP_LEGACY) ||
          a.createdAt.localeCompare(b.createdAt),
      )
      .slice(0, limit);
  }

  async markProcessing(job: AnalysisJob): Promise<void> {
    await this.write({ ...job, status: "processing", updatedAt: this.isoNow() });
  }

  async markAnalyzed(job: AnalysisJob): Promise<void> {
    await this.write({ ...job, status: "analyzed", updatedAt: this.isoNow() });
  }

  async markSkipped(job: AnalysisJob, reason: string): Promise<void> {
    await this.write({
      ...job,
      status: "skipped",
      error: reason,
      updatedAt: this.isoNow(),
    });
  }

  /** Mark a job failed; schedule a retry until maxAttempts is reached. */
  async markFailed(job: AnalysisJob, error: string): Promise<void> {
    const attempts = job.attempts + 1;
    const nextRetryAt =
      attempts < this.maxAttempts ? this.scheduleRetry(attempts) : undefined;
    await this.write({
      ...job,
      status: "failed",
      attempts,
      error,
      nextRetryAt,
      updatedAt: this.isoNow(),
    });
  }

  async markGone(job: AnalysisJob, error: string): Promise<void> {
    await this.write({
      ...job,
      status: "gone",
      error,
      updatedAt: this.isoNow(),
    });
  }

  async get(sampleId: string): Promise<AnalysisJob | undefined> {
    return this.db.get<AnalysisJob>(STORES.jobs, sampleId);
  }

  async all(): Promise<AnalysisJob[]> {
    return this.db.getAll<AnalysisJob>(STORES.jobs);
  }

  async countByStatus(status: JobStatus): Promise<number> {
    return (await this.all()).filter((j) => j.status === status).length;
  }

  async clear(): Promise<void> {
    await this.db.clear(STORES.jobs);
  }

  private scheduleRetry(attempts: number): string {
    const delay =
      this.backoffMs * 2 ** (attempts - 1) + Math.random() * this.retryJitterMs;
    return new Date(this.nowFn() + delay).toISOString();
  }

  private async write(job: AnalysisJob): Promise<void> {
    assertNoAudioBytes(job);
    await this.db.put(STORES.jobs, job);
  }
}

function assertNoAudioBytes(value: unknown): void {
  // Jobs are pure JSON metadata; a defensive check keeps the invariant.
  if (
    value !== null &&
    typeof value === "object" &&
    (value instanceof Blob ||
      value instanceof ArrayBuffer ||
      // SharedArrayBuffer is not a global in non-cross-origin-isolated browser
      // contexts (including default headless Chrome); guard it so the invariant
      // check never throws ReferenceError and breaks job writes in the browser.
      (typeof SharedArrayBuffer !== "undefined" &&
        value instanceof SharedArrayBuffer) ||
      (ArrayBuffer.isView(value) && !(value instanceof Float32Array)))
  ) {
    throw new Error("audio byte container prohibited in queue job");
  }
}
