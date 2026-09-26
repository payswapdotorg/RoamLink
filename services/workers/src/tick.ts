/**
 * The bounded single-tick worker composition (PA-025 — the live
 * command-execution path).
 *
 * THE BOUND LAW (spec/deployment.md §4): a Vercel request handler must
 * never become an unbounded long-running worker. This module is the
 * sanctioned bounded shape — ONE tick per invocation:
 *
 *   1. SWEEP: `recoverInFlight(at)` re-owns every record stranded in
 *      DELIVERING by a previous crashed/stopped invocation — the AR-007/
 *      RL-093 discipline, run once per tick BEFORE the claim (each endpoint
 *      invocation is process-like: sweep, claim, drain, return). Repeated
 *      ticks are safe — the sweep is a set-transition, idempotent by
 *      construction, and it never consumes retry budget.
 *   2. CLAIM: `claimDue(at, batchSize)` in its own unit of work, committed
 *      BEFORE any attempt (claim-commit -> attempt -> outcome-commit — the
 *      same discipline the outbox drain loop applies, mirrored here bounded
 *      to exactly one batch).
 *   3. DELIVER + OUTCOME, per claimed record: the deadline is checked
 *      BEFORE each attempt; a batch that would exceed the max-duration
 *      guard STOPS AFTER THE CURRENT ITEM (the un-attempted claimed records
 *      stay DELIVERING — safe by construction, re-owned by the next tick's
 *      sweep — the honest partial-progress law: the next scheduled delivery
 *      continues). Each delivery goes through the composed
 *      {@link OutboxDeliveryPort} (the SAME execution seam the production
 *      host uses) and its outcome commits in its own unit of work:
 *      DELIVERED terminal / retryable failure rescheduled with backoff /
 *      permanent failure diagnosable. Outcome-commit failures are counted,
 *      never hidden.
 *   4. INBOX: ONE bounded `processPending(batchLimit)` batch when an inbox
 *      source is composed (projection is the worker's concern — admission
 *      is not truth, RL-LOCK-009); without a composed source the report
 *      says so honestly.
 *   5. RECONCILIATION: ONE reconciliation tick when a reconcile seam is
 *      composed (optional); otherwise the report says so honestly.
 *
 * The production host (`createWorkerHost` / main.ts) is UNCHANGED and keeps
 * its loop; this tick is the SAME logic bounded to one iteration,
 * composable from the environment the same way `createWorkerHost` is
 * (env-driven, fail-closed, no secrets in code) and over the same seams
 * (tests override; production uses the env bindings).
 */
import { epochMsOf, parseUtcInstant, type UtcInstant } from "@roamlink/contracts";
import {
  createPostgresPersistence,
  type PostgresPersistence,
  type SqlDriver,
} from "@roamlink/persistence-postgres";

import { bindDriver, WorkerCompositionError, type WorkerHostEnv } from "./host.js";
import { deliveryReason, type OutboxDeliveryPort } from "./delivery.js";
import type { WebhookInboxDrainSource } from "./inbox-drain.js";

// --------------------------------------------------------------------------------
// Env + seams (mirrors WorkerHostEnv/WorkerHostSeams)
// --------------------------------------------------------------------------------

/** The env the bounded tick composes from (the createWorkerHost style). */
export interface WorkerTickEnv {
  readonly mode: "production" | "development";
  readonly databaseUrl: string | undefined;
  /** Bounded claim per tick (default 10; must be an integer >= 1). */
  readonly outboxBatchSize?: number;
  /** The bounded inbox batch limit (default 50). */
  readonly inboxBatchLimit?: number;
  /**
   * The max-duration guard in ms (default 45_000): a tick whose batch would
   * exceed it stops AFTER the current item and reports partial completion —
   * a platform-bound safety net, never a correctness fact (the next tick's
   * sweep re-owns the un-attempted remainder and continues).
   */
  readonly maxDurationMs?: number;
}

/** Composition seams (tests/hosts override; the env bindings fill the rest). */
export interface WorkerTickSeams {
  /**
   * A PRE-COMPOSED persistence (the hosted endpoint mount provides the
   * host's own persistence — one database, one truth). When absent the tick
   * binds its own driver from DATABASE_URL with the SAME fail-closed law as
   * the worker host (services/workers host.ts bindDriver).
   */
  readonly persistence?: PostgresPersistence;
  /** The driver backing the seam persistence (probe-able; optional with it). */
  readonly driver?: SqlDriver;
  /** Releases the seam-owned driver when the tick is disposed (tests). */
  readonly disposePersistence?: () => Promise<void>;
  /**
   * THE EXECUTION SEAM: the delivery port claimed obligations are handed to
   * (the command-executor port for the endpoint plane; the QStash handoff
   * for other compositions). REQUIRED — a tick with nothing to deliver
   * through would be a lie.
   */
  readonly delivery: OutboxDeliveryPort;
  readonly now?: () => UtcInstant;
  /** The webhook inbox drain source (one bounded batch per tick). */
  readonly inbox?: WebhookInboxDrainSource;
  /** One reconciliation tick (optional; composed by the caller). */
  readonly reconcile?: () => Promise<void>;
}

// --------------------------------------------------------------------------------
// The report (observability only — counts and honest skips, never business state)
// --------------------------------------------------------------------------------

/** One bounded tick's honest outcome summary. */
export interface WorkerTickReport {
  readonly at: UtcInstant;
  /** The tick's measured duration (the injected clock's elapsed ms). */
  readonly durationMs: number;
  /** The pre-claim sweep's re-owned count (stranded claims recovered). */
  readonly sweep: { readonly recovered: number };
  readonly outbox: {
    /** Records claimed by this tick (the capped claim). */
    readonly claimed: number;
    /**
     * Commands whose `executed` stage committed through the delivery port
     * (the command-executor port's DELIVERED outcome: executor applied +
     * ledger CAS write committed). 0 when the port is a pure transport.
     */
    readonly executed: number;
    /** Obligations whose terminal DELIVERED outcome committed. */
    readonly delivered: number;
    readonly retryableFailures: number;
    readonly permanentFailures: number;
    /** Outcomes that failed to COMMIT (the claim stays owned; swept next tick). */
    readonly outcomeErrors: number;
    /** Claimed records NOT attempted because the max-duration guard fired. */
    readonly deadlineAbandoned: number;
    /** PENDING obligations remaining after the tick (the honest backlog). */
    readonly remainingPending: number;
  };
  readonly inbox:
    | { readonly drained: false; readonly reason: string }
    | { readonly drained: true; readonly applied: number; readonly failed: number; readonly conflicts: number };
  readonly reconciliation:
    | { readonly ran: false; readonly reason: string }
    | { readonly ran: true; readonly outcome: "completed" | "failed"; readonly reason?: string };
}

export interface BoundedWorkerTick {
  /** Executes ONE bounded tick (the whole point: bounded, then returns). */
  execute(): Promise<WorkerTickReport>;
  /** Releases the tick-owned driver when it bound its own (the env path). */
  dispose(): Promise<void>;
}

// --------------------------------------------------------------------------------
// The composition
// --------------------------------------------------------------------------------

/** Default claim cap per tick (mirrors the drain loop's default batch). */
const DEFAULT_TICK_BATCH_SIZE = 10;

/** Default inbox batch limit (mirrors the inbox drain's default). */
const DEFAULT_TICK_INBOX_BATCH_LIMIT = 50;

/**
 * The max-duration guard default: a safety net sized under the serverless
 * platforms' own request budgets (Vercel Hobby functions run up to 60s), so
 * the endpoint RETURNS before the platform would kill it mid-write. A
 * deployment fact guiding a default, never encoded into correctness — the
 * tick is idempotent and crash-safe at ANY guard value.
 */
const DEFAULT_TICK_MAX_DURATION_MS = 45_000;

export function createBoundedWorkerTick(env: WorkerTickEnv, seams: WorkerTickSeams): BoundedWorkerTick {
  const batchSize = parsePositiveInt(env.outboxBatchSize ?? DEFAULT_TICK_BATCH_SIZE, "outboxBatchSize");
  const inboxBatchLimit = parsePositiveInt(env.inboxBatchLimit ?? DEFAULT_TICK_INBOX_BATCH_LIMIT, "inboxBatchLimit");
  const maxDurationMs = parsePositiveInt(env.maxDurationMs ?? DEFAULT_TICK_MAX_DURATION_MS, "maxDurationMs");
  const now = seams.now ?? (() => new Date().toISOString() as UtcInstant);

  // --- the REAL persistence (the SAME fail-closed law as the host) ---------
  const tickEnv: WorkerHostEnv = { mode: env.mode, databaseUrl: env.databaseUrl };
  let state:
    | { readonly kind: "unresolved" }
    | {
        readonly kind: "resolved";
        readonly persistence: PostgresPersistence;
        readonly dispose: () => Promise<void>;
      } = { kind: "unresolved" };

  const resolve = async (): Promise<{
    readonly persistence: PostgresPersistence;
    readonly dispose: () => Promise<void>;
  }> => {
    if (state.kind === "resolved") return state;
    if (seams.persistence !== undefined) {
      state = {
        kind: "resolved",
        persistence: seams.persistence,
        dispose: seams.disposePersistence ?? (async () => undefined),
      };
      return state;
    }
    const binding = await bindDriver(tickEnv).catch((error: unknown) => {
      throw error instanceof WorkerCompositionError
        ? error
        : new WorkerCompositionError(
            "the bounded tick could not bind its database driver (fail-closed; the tick never degrades to a fake)",
          );
    });
    state = {
      kind: "resolved",
      persistence: createPostgresPersistence(binding.driver),
      dispose: binding.dispose,
    };
    return state;
  };

  return {
    async execute(): Promise<WorkerTickReport> {
      const { persistence } = await resolve();
      const startedAtMs = epochMsOf(parseUtcInstant(now()));
      const at = parseUtcInstant(now());

      // --- 1. the sweep (RL-093: before the first claim, once per tick) ----
      let recovered = 0;
      const sweepUnit = await persistence.begin();
      try {
        recovered = (await sweepUnit.outbox.recoverInFlight(at)).length;
        await sweepUnit.commit();
      } catch (error) {
        await sweepUnit.rollback();
        throw error;
      }

      // --- 2. the claim (committed BEFORE any attempt) ---------------------
      const claimUnit = await persistence.begin();
      let claimed;
      try {
        claimed = await claimUnit.outbox.claimDue(at, batchSize);
        await claimUnit.commit();
      } catch (error) {
        await claimUnit.rollback();
        throw error;
      }

      const outbox = {
        claimed: claimed.length,
        executed: 0,
        delivered: 0,
        retryableFailures: 0,
        permanentFailures: 0,
        outcomeErrors: 0,
        deadlineAbandoned: 0,
      };

      // --- 3. deliver + outcome (per record, its own unit of work) ---------
      for (const record of claimed) {
        // The max-duration guard: stop BEFORE the next attempt when the
        // budget is spent. The un-attempted claimed records stay DELIVERING
        // — safe by construction (crash window discipline): the next tick's
        // sweep re-owns them without consuming budget. Honest partial
        // progress, never a lost obligation.
        if (epochMsOf(parseUtcInstant(now())) - startedAtMs >= maxDurationMs) {
          // Attempted items (delivered, failed, or outcome-errored) are done;
          // the claimed-but-un-attempted remainder is what the guard strands.
          const attempted =
            outbox.executed + outbox.retryableFailures + outbox.permanentFailures + outbox.outcomeErrors;
          outbox.deadlineAbandoned = claimed.length - attempted;
          break;
        }
        let outcome;
        try {
          outcome = await seams.delivery.deliver(record);
        } catch {
          // A port that throws violated its contract; the attempt DID happen
          // and its outcome is unknown: an honest retryable attempt-failure.
          outcome = { outcome: "RETRYABLE_FAILURE", reason: "DELIVERY_ATTEMPT_UNKNOWN" } as const;
        }
        // The command-executor port's DELIVERED outcome IS the executed
        // stage's commit (executor applied + ledger CAS write landed).
        if (outcome.outcome === "DELIVERED") {
          outbox.executed += 1;
        }
        const outcomeUnit = await persistence.begin();
        try {
          if (outcome.outcome === "DELIVERED") {
            await outcomeUnit.outbox.markDelivered(record.idempotencyKey, parseUtcInstant(now()));
            outbox.delivered += 1;
          } else {
            const reason = deliveryReason(outcome.reason);
            await outcomeUnit.outbox.markAttemptFailed(
              record.idempotencyKey,
              parseUtcInstant(now()),
              reason,
            );
            if (outcome.outcome === "RETRYABLE_FAILURE") outbox.retryableFailures += 1;
            else outbox.permanentFailures += 1;
          }
          await outcomeUnit.commit();
        } catch {
          // The outcome could not commit: the outcome is NOT applied,
          // nothing is overwritten, and the record stays owned by the
          // discipline that won it. Counted, never hidden.
          await outcomeUnit.rollback();
          outbox.outcomeErrors += 1;
        }
      }

      // --- 4. the inbox leg (one bounded batch when composed) --------------
      const inbox: WorkerTickReport["inbox"] =
        seams.inbox === undefined
          ? {
              drained: false,
              reason: "no webhook inbox with a composed projector is bound in this tick",
            }
          : await runInboxBatch(seams.inbox, inboxBatchLimit);

      // --- 5. the reconciliation leg (one tick when composed) --------------
      const reconciliation: WorkerTickReport["reconciliation"] =
        seams.reconcile === undefined
          ? { ran: false, reason: "no reconciliation tick is composed in this tick" }
          : await runReconciliation(seams.reconcile);

      const remainingPending = await persistence.outbox.count("PENDING");
      const durationMs = Math.max(0, epochMsOf(parseUtcInstant(now())) - startedAtMs);

      return {
        at,
        durationMs,
        sweep: { recovered },
        outbox: { ...outbox, remainingPending },
        inbox,
        reconciliation,
      };
    },

    dispose(): Promise<void> {
      return state.kind === "resolved" ? state.dispose() : Promise.resolve();
    },
  };
}

/** One bounded `processPending` batch (failures reported, never thrown past the tick). */
async function runInboxBatch(
  inbox: WebhookInboxDrainSource,
  batchLimit: number,
): Promise<WorkerTickReport["inbox"]> {
  try {
    const report = await inbox.processPending(batchLimit);
    return {
      drained: true,
      applied: report.applied,
      failed: report.failed,
      conflicts: report.conflicts,
    };
  } catch (error) {
    return {
      drained: false,
      reason: `the inbox batch failed (${error instanceof Error ? error.name : "unknown error"})`,
    };
  }
}

/** One reconciliation tick (failures reported, never thrown past the tick). */
async function runReconciliation(reconcile: () => Promise<void>): Promise<WorkerTickReport["reconciliation"]> {
  try {
    await reconcile();
    return { ran: true, outcome: "completed" };
  } catch (error) {
    return {
      ran: true,
      outcome: "failed",
      reason: error instanceof Error ? error.name : "unknown error",
    };
  }
}

function parsePositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`the bounded tick ${label} must be an integer >= 1 (got ${String(value)})`);
  }
  return value;
}
