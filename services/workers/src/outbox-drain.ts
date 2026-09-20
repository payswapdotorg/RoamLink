/**
 * The bounded outbox drain loop (RL-107).
 *
 * The production consumer of the command queue: a long-running, bounded,
 * observable loop over the LANDED persistence outbox port
 * (`claimDue` / `markDelivered` / `markAttemptFailed` / `recoverInFlight`).
 *
 * Tick shape (the recovery runbook's delivery discipline):
 *
 *   1. STARTUP SWEEP (once, before the first claim): `recoverInFlight(at)`
 *      re-owns every record stranded in DELIVERING by a previous crash —
 *      the AR-007/RL-093 discipline this item was gated on. The sweep must
 *      run only when no live worker still holds claims: the host calls it
 *      exactly once per process start, before its first claim.
 *   2. CLAIM: `claimDue(at, batchSize)` in its own unit of work, committed
 *      BEFORE any attempt (claim-commit -> attempt -> outcome-commit).
 *   3. DELIVER: each claimed record is handed to the OutboxDeliveryPort.
 *   4. OUTCOME: the typed outcome commits in its own unit of work
 *      (DELIVERED terminal / retryable failure re-scheduled with backoff /
 *      permanent failure diagnosable). A crash here strands DELIVERING —
 *      recovered by the next process's startup sweep, never lost, never
 *      double-owned (FOR UPDATE SKIP LOCKED claims are disjoint, RL-106).
 *
 * Every batch is bounded (`batchSize`), every idle/error gap is bounded
 * (`idleDelayMs` / `errorDelayMs`), every tick is observable (`onTick` +
 * the snapshot counters), and shutdown is graceful: `stop()` cancels the
 * schedule and awaits any in-flight tick. An abandoned mid-batch claim is
 * SAFE by construction — the restarted process's sweep re-owns it (pinned
 * by tests).
 */
import { parseUtcInstant, type UtcInstant } from "@roamlink/contracts";
import type { UnitOfWorkFactory } from "@roamlink/persistence";
import type { LeveledLogger } from "@roamlink/observability";

import { deliveryReason, type OutboxDeliveryPort } from "./delivery.js";
import type { WorkerTimer } from "./timer.js";

export interface OutboxDrainTickReport {
  readonly at: UtcInstant;
  /** Records claimed by this tick. */
  readonly claimed: number;
  readonly delivered: number;
  readonly retryableFailures: number;
  readonly permanentFailures: number;
  /** Outcomes that failed to COMMIT (the claim stays owned; swept on restart). */
  readonly outcomeErrors: number;
  /** The startup sweep's re-owned count (first tick of a process only). */
  readonly recoveredOnStart: number | null;
}

export interface OutboxDrainOptions {
  readonly persistence: UnitOfWorkFactory;
  readonly delivery: OutboxDeliveryPort;
  readonly now: () => UtcInstant;
  readonly timer: WorkerTimer;
  /** Bounded batch per tick (default 10; must be an integer >= 1). */
  readonly batchSize?: number;
  /** Delay between ticks when the queue was empty (default 1000ms). */
  readonly idleDelayMs?: number;
  /** Delay before the next tick after a failure (default 5000ms). */
  readonly errorDelayMs?: number;
  readonly logger?: LeveledLogger;
  readonly onTick?: (report: OutboxDrainTickReport) => void;
}

export interface OutboxDrainHandle {
  /** Starts the loop: the startup sweep first, then the claim loop. */
  start(): void;
  /** Resolves when the startup sweep settled (the first claim follows it). */
  whenStartupSettled(): Promise<void>;
  /** Graceful stop: cancels the schedule, awaits the in-flight tick. */
  stop(): Promise<void>;
  /** One bounded tick, awaitable (the scheduled loop uses exactly this). */
  tickOnce(): Promise<OutboxDrainTickReport>;
  /** The observable counters (totals across all ticks of this process). */
  snapshot(): {
    readonly ticks: number;
    readonly delivered: number;
    readonly retryableFailures: number;
    readonly permanentFailures: number;
    readonly outcomeErrors: number;
    readonly recoveredOnStart: number | null;
    readonly stopped: boolean;
  };
}

export function createOutboxDrain(options: OutboxDrainOptions): OutboxDrainHandle {
  const batchSize = parsePositiveInt(options.batchSize ?? 10, "batchSize");
  const idleDelayMs = parsePositiveInt(options.idleDelayMs ?? 1_000, "idleDelayMs");
  const errorDelayMs = parsePositiveInt(options.errorDelayMs ?? 5_000, "errorDelayMs");

  let started = false;
  let stopped = false;
  let cancelPending: (() => void) | null = null;
  let inFlight: Promise<void> | null = null;
  let recoveredOnStart: number | null = null;

  const totals = { ticks: 0, delivered: 0, retryableFailures: 0, permanentFailures: 0, outcomeErrors: 0 };

  const runStartupSweep = async (): Promise<number> => {
    const at = parseUtcInstant(options.now());
    const unitOfWork = await options.persistence.begin();
    try {
      const recovered = await unitOfWork.outbox.recoverInFlight(at);
      await unitOfWork.commit();
      if (recovered.length > 0) {
        options.logger?.warn("outbox_startup_sweep", { recovered: recovered.length });
      } else {
        options.logger?.info("outbox_startup_sweep", { recovered: 0 });
      }
      return recovered.length;
    } catch (error) {
      await unitOfWork.rollback();
      throw error;
    }
  };

  const runTick = async (): Promise<OutboxDrainTickReport> => {
    const at = parseUtcInstant(options.now());
    const report = {
      at,
      claimed: 0,
      delivered: 0,
      retryableFailures: 0,
      permanentFailures: 0,
      outcomeErrors: 0,
      recoveredOnStart: null as number | null,
    };

    // --- claim (committed BEFORE any attempt) -----------------------------
    const claimUnit = await options.persistence.begin();
    let claimed;
    try {
      claimed = await claimUnit.outbox.claimDue(at, batchSize);
      await claimUnit.commit();
    } catch (error) {
      await claimUnit.rollback();
      throw error;
    }
    report.claimed = claimed.length;

    // --- deliver + outcome (per record, its own unit of work) -------------
    for (const record of claimed) {
      let outcome;
      try {
        outcome = await options.delivery.deliver(record);
      } catch {
        // A port that throws violated its contract; the attempt DID happen
        // and its outcome is unknown: an honest retryable attempt-failure.
        outcome = { outcome: "RETRYABLE_FAILURE", reason: "DELIVERY_ATTEMPT_UNKNOWN" } as const;
      }
      const outcomeUnit = await options.persistence.begin();
      try {
        if (outcome.outcome === "DELIVERED") {
          await outcomeUnit.outbox.markDelivered(record.idempotencyKey, parseUtcInstant(options.now()));
          report.delivered += 1;
        } else {
          const reason = deliveryReason(outcome.reason);
          await outcomeUnit.outbox.markAttemptFailed(
            record.idempotencyKey,
            parseUtcInstant(options.now()),
            reason,
          );
          if (outcome.outcome === "RETRYABLE_FAILURE") report.retryableFailures += 1;
          else report.permanentFailures += 1;
        }
        await outcomeUnit.commit();
      } catch (error) {
        // The outcome could not commit (e.g. the concurrent sweep re-owned
        // the claim and won the race, or the database is failing): the
        // outcome is NOT applied, nothing is overwritten, and the record
        // stays owned by the discipline that won it. Counted, never hidden.
        await outcomeUnit.rollback();
        report.outcomeErrors += 1;
        options.logger?.warn("outbox_outcome_error", { reason: error instanceof Error ? error.name : "unknown" });
      }
    }

    totals.ticks += 1;
    totals.delivered += report.delivered;
    totals.retryableFailures += report.retryableFailures;
    totals.permanentFailures += report.permanentFailures;
    totals.outcomeErrors += report.outcomeErrors;
    const frozen: OutboxDrainTickReport = Object.freeze({ ...report });
    options.onTick?.(frozen);
    return frozen;
  };

  const scheduleNext = (delayMs: number): void => {
    if (stopped) return;
    cancelPending = options.timer.schedule(() => {
      cancelPending = null;
      inFlight = (async () => {
        try {
          await runTick();
          scheduleNext(idleDelayMs);
        } catch (error) {
          options.logger?.warn("outbox_tick_error", { reason: error instanceof Error ? error.name : "unknown" });
          scheduleNext(errorDelayMs);
        }
      })();
    }, delayMs);
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      inFlight = (async () => {
        try {
          // The RL-093 discipline: sweep BEFORE the first claim.
          recoveredOnStart = await runStartupSweep();
        } catch (error) {
          options.logger?.warn("outbox_startup_sweep_error", {
            reason: error instanceof Error ? error.name : "unknown",
          });
        }
        scheduleNext(0);
      })();
    },

    whenStartupSettled(): Promise<void> {
      return (inFlight ?? Promise.resolve()).then(() => undefined);
    },

    stop(): Promise<void> {
      stopped = true;
      cancelPending?.();
      cancelPending = null;
      return (inFlight ?? Promise.resolve()).then(() => undefined);
    },

    tickOnce(): Promise<OutboxDrainTickReport> {
      return runTick();
    },

    snapshot() {
      return {
        ticks: totals.ticks,
        delivered: totals.delivered,
        retryableFailures: totals.retryableFailures,
        permanentFailures: totals.permanentFailures,
        outcomeErrors: totals.outcomeErrors,
        recoveredOnStart,
        stopped,
      };
    },
  };
}

function parsePositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`outbox drain ${label} must be an integer >= 1 (got ${String(value)})`);
  }
  return value;
}
