/**
 * The webhook inbox drain loop (RL-107).
 *
 * Webhook admission (the API edge) is synchronous and durable; PROJECTION
 * is the worker's concern (RL-LOCK-009: admission is not truth). This loop
 * drives the LANDED `AdcosWebhookInboxService.processPending` on a bounded
 * schedule: every tick processes at most `batchLimit` non-terminal records
 * in admission order (the AR-008 batch progression makes repeated bounded
 * ticks advance through any backlog), failures are retried by the record's
 * own processing state, and PROJECTED is terminal (never re-projected).
 *
 * Every tick is observable (`onTick` + the snapshot counters) and shutdown
 * is graceful (the in-flight tick finishes).
 */
import type { UtcInstant } from "@roamlink/contracts";
import type { LeveledLogger } from "@roamlink/observability";
import type { WebhookProcessingReport } from "@roamlink/webhook-inbox";

import type { WorkerTimer } from "./timer.js";

/** The drain surface the loop needs (satisfied by the boundary's inbox). */
export interface WebhookInboxDrainSource {
  processPending(limit?: number): Promise<WebhookProcessingReport>;
}

export interface InboxDrainOptions {
  readonly inbox: WebhookInboxDrainSource;
  readonly now: () => UtcInstant;
  readonly timer: WorkerTimer;
  /** Bounded batch per tick (default 50). */
  readonly batchLimit?: number;
  /** Delay between ticks (default 2000ms). */
  readonly intervalMs?: number;
  /** Delay before the next tick after a failure (default 10_000ms). */
  readonly errorDelayMs?: number;
  readonly logger?: LeveledLogger;
  readonly onTick?: (report: WebhookProcessingReport) => void;
}

export interface InboxDrainHandle {
  start(): void;
  stop(): Promise<void>;
  /** One bounded tick, awaitable (the scheduled loop uses exactly this). */
  tickOnce(): Promise<WebhookProcessingReport>;
  snapshot(): {
    readonly ticks: number;
    readonly applied: number;
    readonly failed: number;
    readonly conflicts: number;
    readonly stopped: boolean;
  };
}

export function createInboxDrain(options: InboxDrainOptions): InboxDrainHandle {
  const batchLimit = parsePositiveInt(options.batchLimit ?? 50, "batchLimit");
  const intervalMs = parsePositiveInt(options.intervalMs ?? 2_000, "intervalMs");
  const errorDelayMs = parsePositiveInt(options.errorDelayMs ?? 10_000, "errorDelayMs");

  let started = false;
  let stopped = false;
  let cancelPending: (() => void) | null = null;
  let inFlight: Promise<void> | null = null;
  const totals = { ticks: 0, applied: 0, failed: 0, conflicts: 0 };

  const runTick = async (): Promise<WebhookProcessingReport> => {
    const report = await options.inbox.processPending(batchLimit);
    totals.ticks += 1;
    totals.applied += report.applied;
    totals.failed += report.failed;
    totals.conflicts += report.conflicts;
    options.onTick?.(report);
    return report;
  };

  const scheduleNext = (delayMs: number): void => {
    if (stopped) return;
    cancelPending = options.timer.schedule(() => {
      cancelPending = null;
      inFlight = (async () => {
        try {
          await runTick();
          scheduleNext(intervalMs);
        } catch (error) {
          options.logger?.warn("inbox_tick_error", { reason: error instanceof Error ? error.name : "unknown" });
          scheduleNext(errorDelayMs);
        }
      })();
    }, delayMs);
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      scheduleNext(0);
    },
    stop(): Promise<void> {
      stopped = true;
      cancelPending?.();
      cancelPending = null;
      return (inFlight ?? Promise.resolve()).then(() => undefined);
    },
    tickOnce(): Promise<WebhookProcessingReport> {
      return runTick();
    },
    snapshot() {
      return { ...totals, stopped };
    },
  };
}

function parsePositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`inbox drain ${label} must be an integer >= 1 (got ${String(value)})`);
  }
  return value;
}
