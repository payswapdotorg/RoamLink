/**
 * The outbox delivery ports (RL-107).
 *
 * The worker host OWNS the delivery seam: the drain loop (outbox-drain.ts)
 * claims due obligations and hands each one to an `OutboxDeliveryPort`. The
 * port's closed outcome vocabulary maps onto the durable outbox's closed
 * state machine (packages/persistence outbox.ts):
 *
 *   DELIVERED           -> markDelivered (terminal DELIVERED)
 *   RETRYABLE_FAILURE   -> markAttemptFailed (PENDING with backoff, or
 *                          terminal FAILED when the budget is exhausted)
 *   PERMANENT_FAILURE   -> markAttemptFailed with a typed reason (the state
 *                          machine's own budget rules still apply; the
 *                          reason is always the diagnosable code)
 *
 * Durability laws carried through (RL-LOCK-014 / the recovery runbook): the
 * claim commits BEFORE the attempt and the outcome commits AFTER it, so a
 * crash strands the record in DELIVERING and the startup sweep
 * (`recoverInFlight`, AR-007/RL-093) re-owns it without consuming budget.
 * Redelivery is at-least-once and safe because every obligation is
 * idempotency-keyed.
 *
 * Shipped production bindings:
 *  - {@link qstashOutboxDeliveryPort} — hands each obligation to the QStash
 *    DurableJobDeliveryPort (the sanctioned retryable async channel); the
 *    outbox obligation is "delivered" when the handoff receipt is accepted.
 *  - {@link commandLedgerDeliveryPort} — executes command-kind obligations
 *    in-process through composed executors and records the `executed` stage
 *    on the stored command. A kind without a composed executor is a
 *    RETRYABLE failure with the honest reason (a rolling deploy that adds
 *    the executor self-heals; an exhausted budget lands terminal FAILED with
 *    the diagnosable reason - loud, never silent).
 */
import { ValidationError, type UtcInstant } from "@roamlink/contracts";
import type { OutboxRecord } from "@roamlink/persistence";
import type { DurableJobDeliveryPort } from "@roamlink/provider-qstash";

/** The closed delivery-outcome vocabulary (see the module doc). */
export type OutboxDeliveryOutcome =
  | { readonly outcome: "DELIVERED" }
  | { readonly outcome: "RETRYABLE_FAILURE"; readonly reason: string }
  | { readonly outcome: "PERMANENT_FAILURE"; readonly reason: string };

/** The seam the drain loop delivers through (never throws for a failure). */
export interface OutboxDeliveryPort {
  deliver(record: OutboxRecord): Promise<OutboxDeliveryOutcome>;
}

/** Guards a delivery reason as a diagnosable UPPER_SNAKE code (log-safe). */
export function deliveryReason(reason: string): string {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(reason)) {
    throw new ValidationError("outbox delivery failure reasons must be UPPER_SNAKE reason codes", {
      reason: "OUTBOX_REASON_INVALID",
      details: [{ path: "reason", issue: "must match the reason-code pattern" }],
    });
  }
  return reason;
}

// --------------------------------------------------------------------------------
// QStash handoff (the sanctioned retryable async channel)
// --------------------------------------------------------------------------------

export interface QStashOutboxDeliveryOptions {
  /** The durable HTTP-jobs transport (Upstash QStash or its fake). */
  readonly port: DurableJobDeliveryPort;
  /** The HTTPS receiver that will verify the signature and act on the job. */
  readonly destination: string;
}

/**
 * Delivers an outbox obligation by handing its payload to the QStash
 * durable-jobs channel. jobId = the obligation's idempotency key (the
 * transport dedupes per jobId, so a re-claimed redelivery enqueues the same
 * job without duplicating it).
 */
export function qstashOutboxDeliveryPort(options: QStashOutboxDeliveryOptions): OutboxDeliveryPort {
  return {
    async deliver(record: OutboxRecord): Promise<OutboxDeliveryOutcome> {
      const payload = JSON.parse(new TextDecoder().decode(record.payloadBytes)) as unknown;
      try {
        const receipt = await options.port.enqueue({
          jobId: record.idempotencyKey,
          destination: options.destination,
          payload,
        });
        if (receipt.accepted) {
          return { outcome: "DELIVERED" };
        }
        return { outcome: "RETRYABLE_FAILURE", reason: deliveryReason("QSTASH_ENQUEUE_RETRYABLE") };
      } catch (error) {
        // The handoff itself failed: transport failures are retryable
        // (RL-LOCK-014 makes the retry safe); a rejected enqueue (validation,
        // conflict on a different payload) is permanent and diagnosable.
        const isValidationError = error instanceof ValidationError;
        if (isValidationError) {
          return { outcome: "PERMANENT_FAILURE", reason: deliveryReason("QSTASH_ENQUEUE_REJECTED") };
        }
        return { outcome: "RETRYABLE_FAILURE", reason: deliveryReason("QSTASH_ENQUEUE_UNAVAILABLE") };
      }
    },
  };
}

// --------------------------------------------------------------------------------
// In-process command execution (composed executors)
// --------------------------------------------------------------------------------

/** The payload the API service enqueues for a command obligation. */
export interface CommandObligationPayload {
  readonly commandId: string;
  readonly kind: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly payload: unknown;
  readonly expectedVersion?: number;
}

/** Executes one command obligation's payload (composed per kind). */
export type CommandExecutor = (
  record: OutboxRecord,
  payload: CommandObligationPayload,
  at: UtcInstant,
) => Promise<void>;

/** Records the `executed` stage on the stored command (the stage-truth law). */
export interface CommandLedger {
  markExecuted(commandId: string, at: UtcInstant): Promise<void>;
}

export interface CommandLedgerDeliveryOptions {
  /** Composed executors by command kind (device.enroll, order.place, ...). */
  readonly executors: Readonly<Record<string, CommandExecutor>>;
  /** Opens the unit of work that records the executed stage. */
  readonly ledger: CommandLedger;
  readonly now: () => UtcInstant;
}

/**
 * Delivers a command obligation by executing it and recording the `executed`
 * stage on the stored command. Unknown kinds and executor failures are
 * RETRYABLE with honest, diagnosable reasons (never silent, never invented
 * success) — the acknowledgement stages never lie (spec/api.md).
 */
export function commandLedgerDeliveryPort(options: CommandLedgerDeliveryOptions): OutboxDeliveryPort {
  return {
    async deliver(record: OutboxRecord): Promise<OutboxDeliveryOutcome> {
      let obligation: CommandObligationPayload;
      try {
        obligation = JSON.parse(new TextDecoder().decode(record.payloadBytes)) as CommandObligationPayload;
      } catch {
        return { outcome: "PERMANENT_FAILURE", reason: deliveryReason("COMMAND_PAYLOAD_UNREADABLE") };
      }
      const executor = options.executors[obligation.kind];
      if (executor === undefined) {
        return {
          outcome: "RETRYABLE_FAILURE",
          reason: deliveryReason("COMMAND_EXECUTOR_NOT_COMPOSED"),
        };
      }
      try {
        await executor(record, obligation, options.now());
      } catch {
        // The attempt happened; its outcome is unknown. The attempt-failure
        // consumes one retry slot and schedules the backoff (RL-LOCK-014
        // makes the retry safe); the reason is diagnosable, never a value.
        return { outcome: "RETRYABLE_FAILURE", reason: deliveryReason("COMMAND_EXECUTION_FAILED") };
      }
      try {
        await options.ledger.markExecuted(obligation.commandId, options.now());
      } catch {
        return { outcome: "RETRYABLE_FAILURE", reason: deliveryReason("COMMAND_LEDGER_WRITE_FAILED") };
      }
      return { outcome: "DELIVERED" };
    },
  };
}
