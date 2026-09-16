/**
 * The reconciliation scheduler (RL-035, spec §7 "periodically").
 *
 * A thin composition utility that runs reconciliation jobs on an interval.
 * Time is injectable (a timer port) so scheduling is deterministic in tests;
 * the production timer wraps `setTimeout`. Job failures are captured through
 * the `onJobError` callback (typed, log-safe errors) and NEVER stop the
 * schedule - a failed job is just a job; the next tick retries.
 */
import { ValidationError } from "@roamlink/contracts";
import type { ReconciliationJobRecord } from "./job-record.js";
import type { ReconciliationJobRequest } from "./engine.js";

/** Anything that can run reconciliation jobs (the engine satisfies this). */
export interface ReconciliationRunner {
  runJob(request: ReconciliationJobRequest): Promise<ReconciliationJobRecord>;
}

/** Schedules a callback after a delay; returns the cancel function. */
export interface ReconciliationTimer {
  schedule(callback: () => void, delayMs: number): () => void;
}

/** The production timer (setTimeout-based). */
export class SystemReconciliationTimer implements ReconciliationTimer {
  schedule(callback: () => void, delayMs: number): () => void {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  }
}

export interface AdcosReconciliationSchedulerOptions {
  readonly reconciler: ReconciliationRunner;
  /** The schedule period in milliseconds (>= 1). */
  readonly intervalMs: number;
  readonly timer: ReconciliationTimer;
  /** Extra job-request fields for scheduled runs (reason defaults to "scheduled"). */
  readonly request?: Partial<ReconciliationJobRequest>;
  /** Captures job failures so operators see them (jobs are retried next tick). */
  readonly onJobError?: (error: unknown) => void;
}

export interface ReconciliationSchedule {
  /** Stops the schedule; the in-flight tick (if any) finishes. */
  stop(): void;
}

export class AdcosReconciliationScheduler {
  readonly #options: AdcosReconciliationSchedulerOptions;
  #stopped = false;
  #cancelPending: (() => void) | null = null;

  constructor(options: AdcosReconciliationSchedulerOptions) {
    if (
      typeof options.intervalMs !== "number" ||
      !Number.isInteger(options.intervalMs) ||
      options.intervalMs < 1
    ) {
      throw new ValidationError("AdcosReconciliationScheduler intervalMs must be a positive integer", {
        reason: "RECONCILIATION_SCHEDULE_INVALID",
        details: [{ path: "intervalMs", issue: "must be an integer >= 1" }],
      });
    }
    this.#options = options;
  }

  /**
   * Starts the periodic schedule. The first job runs after one interval
   * (call `runNow` for an immediate run, e.g. at startup).
   */
  start(): ReconciliationSchedule {
    this.#stopped = false;
    this.#arm();
    return { stop: () => this.stop() };
  }

  /** Runs one job immediately (outside the schedule; awaitable). */
  async runNow(): Promise<void> {
    await this.#tick();
  }

  /** Stops the periodic schedule. */
  stop(): void {
    this.#stopped = true;
    if (this.#cancelPending !== null) {
      this.#cancelPending();
      this.#cancelPending = null;
    }
  }

  #arm(): void {
    if (this.#stopped) return;
    this.#cancelPending = this.#options.timer.schedule(() => {
      this.#cancelPending = null;
      void this.#tick().then(() => this.#arm());
    }, this.#options.intervalMs);
  }

  async #tick(): Promise<void> {
    try {
      await this.#options.reconciler.runJob({
        reason: "scheduled",
        ...this.#options.request,
      });
    } catch (error) {
      // A failed job never stops the schedule; the failure is surfaced.
      this.#options.onJobError?.(error);
    }
  }
}
