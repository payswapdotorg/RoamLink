/**
 * Durable outbox primitives (RL-003).
 *
 * A durable outbox record captures an outbound delivery obligation that MUST
 * be committed atomically with the business write that produced it (the
 * transactional-outbox pattern). Enqueue is only reachable through a
 * {@link ./unit-of-work.js.UnitOfWork} so that "business write + enqueue"
 * commits or rolls back as one unit, by construction.
 *
 * Delivery state machine (closed):
 *
 *   PENDING --> DELIVERING --> DELIVERED            (success, terminal)
 *                    |
 *                    +------------> PENDING         (retryable failure:
 *                    |                               retryCount + 1,
 *                    |                               nextAttemptAt = at + backoff)
 *                    |
 *                    +------------> FAILED         (attempt budget exhausted,
 *                                                    terminal)
 *
 * DELIVERED and FAILED are terminal. DELIVERED/FAILED records carry
 * `nextAttemptAt: null`.
 *
 * All instants are explicit caller-supplied UTC instants - never ambient
 * clocks - so every operation is deterministic and reproducible in tests
 * (spec/definition-of-done.md "Deterministic test data").
 */
import {
  ERROR_REASON_PATTERN,
  DomainError,
  ValidationError,
  addMilliseconds,
  canonicalizeJson,
  epochMsOf,
  parseIdempotencyKey,
  parseUtcInstant,
  sha256Hex,
  type CanonicalJsonValue,
  type Digest,
  type IdempotencyKey,
  type UtcInstant,
} from "@roamlink/contracts";

export const OUTBOX_DELIVERY_STATES = ["PENDING", "DELIVERING", "DELIVERED", "FAILED"] as const;

export type OutboxDeliveryState = (typeof OUTBOX_DELIVERY_STATES)[number];

/**
 * The closed legal-transition table of the outbox delivery state machine.
 * Terminals (DELIVERED, FAILED) have no outgoing edges.
 */
export const OUTBOX_DELIVERY_TRANSITIONS: Readonly<
  Record<OutboxDeliveryState, readonly OutboxDeliveryState[]>
> = Object.freeze<Record<OutboxDeliveryState, readonly OutboxDeliveryState[]>>({
  PENDING: ["DELIVERING"],
  DELIVERING: ["DELIVERED", "PENDING", "FAILED"],
  DELIVERED: [],
  FAILED: [],
});

/** Terminal delivery states: no further transitions are legal. */
export const OUTBOX_TERMINAL_DELIVERY_STATES: readonly OutboxDeliveryState[] = Object.freeze([
  "DELIVERED",
  "FAILED",
]);

export function isOutboxDeliveryState(value: unknown): value is OutboxDeliveryState {
  return (
    typeof value === "string" && (OUTBOX_DELIVERY_STATES as readonly string[]).includes(value)
  );
}

/** Parses a delivery state; anything outside the closed set is rejected. */
export function parseOutboxDeliveryState(value: unknown): OutboxDeliveryState {
  if (!isOutboxDeliveryState(value)) {
    throw new ValidationError(
      "OutboxDeliveryState must be one of: PENDING, DELIVERING, DELIVERED, FAILED",
      {
        reason: "OUTBOX_STATE_INVALID",
        details: [{ path: "OutboxDeliveryState", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/** True when `from -> to` is a legal edge of the delivery state machine. */
export function canTransitionOutboxDelivery(
  from: OutboxDeliveryState,
  to: OutboxDeliveryState,
): boolean {
  const legal = OUTBOX_DELIVERY_TRANSITIONS[from];
  return legal !== undefined && legal.includes(to);
}

// --------------------------------------------------------------------------------
// Retry policy
// --------------------------------------------------------------------------------

/**
 * Durable per-record retry policy. Stored on the record so a delivery worker
 * can schedule retries without consulting anything else.
 *
 * `maxAttempts` counts TOTAL delivery attempts (the initial one included);
 * `backoffScheduleMs` are the delays after the 1st..n-th failed attempt
 * (values beyond the schedule clamp to the last entry).
 */
export interface OutboxRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffScheduleMs: readonly number[];
}

/**
 * Default RoamLink outbox retry policy (1s, 10s, 1m, 10m, 1h; 6 attempts
 * total). This is a RoamLink-side operational default, deliberately NOT the
 * ADCOS webhook retry schedule; callers override per record as needed.
 */
export const DEFAULT_OUTBOX_RETRY_POLICY: OutboxRetryPolicy = Object.freeze({
  maxAttempts: 6,
  backoffScheduleMs: Object.freeze([1_000, 10_000, 60_000, 600_000, 3_600_000]),
});

/** Optional per-record override of the default policy (missing parts default). */
export interface OutboxRetryPolicyOverride {
  readonly maxAttempts?: number;
  readonly backoffScheduleMs?: readonly number[];
}

function resolveRetryPolicy(override: OutboxRetryPolicyOverride | undefined): OutboxRetryPolicy {
  const maxAttempts = override?.maxAttempts ?? DEFAULT_OUTBOX_RETRY_POLICY.maxAttempts;
  const backoffScheduleMs =
    override?.backoffScheduleMs ?? DEFAULT_OUTBOX_RETRY_POLICY.backoffScheduleMs;
  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ValidationError("OutboxRetryPolicy.maxAttempts must be an integer >= 1", {
      reason: "OUTBOX_RETRY_POLICY_INVALID",
      details: [{ path: "OutboxRetryPolicy.maxAttempts", issue: "not an integer >= 1" }],
    });
  }
  if (
    !Array.isArray(backoffScheduleMs) ||
    backoffScheduleMs.length === 0 ||
    !backoffScheduleMs.every((ms) => Number.isInteger(ms) && ms >= 1)
  ) {
    throw new ValidationError(
      "OutboxRetryPolicy.backoffScheduleMs must be a non-empty list of positive integer milliseconds",
      {
        reason: "OUTBOX_RETRY_POLICY_INVALID",
        details: [{ path: "OutboxRetryPolicy.backoffScheduleMs", issue: "not positive integers" }],
      },
    );
  }
  return Object.freeze({ maxAttempts, backoffScheduleMs: Object.freeze([...backoffScheduleMs]) });
}

function backoffMsForAttempt(policy: OutboxRetryPolicy, failedAttemptCount: number): number {
  const schedule = policy.backoffScheduleMs;
  const index = Math.min(failedAttemptCount - 1, schedule.length - 1);
  const value = schedule[index];
  if (value === undefined) {
    throw new DomainError("outbox backoff schedule invariant violated (empty schedule)", {
      reason: "OUTBOX_RETRY_POLICY_INVALID",
    });
  }
  return value;
}

// --------------------------------------------------------------------------------
// Record
// --------------------------------------------------------------------------------

/**
 * A durable outbox record. Identity is the {@link IdempotencyKey}: at most one
 * record exists per key (duplicate enqueue with the same payload digest is a
 * no-op; a different digest for the same key is a typed conflict, never a
 * silent overwrite - RL-LOCK-014).
 */
export interface OutboxRecord {
  readonly idempotencyKey: IdempotencyKey;
  /** Canonical-JSON payload as UTF-8 bytes (deterministic serialization). */
  readonly payloadBytes: Uint8Array;
  /** SHA-256 digest over the canonical payload bytes. */
  readonly payloadDigest: Digest;
  readonly createdAt: UtcInstant;
  readonly deliveryState: OutboxDeliveryState;
  /** Failed delivery attempts so far (0 on enqueue). */
  readonly retryCount: number;
  /** Next attempt is due at this instant; null exactly when terminal. */
  readonly nextAttemptAt: UtcInstant | null;
  /** Set when delivery completes; null otherwise. */
  readonly deliveredAt: UtcInstant | null;
  /** UPPER_SNAKE reason code of the last failed attempt; null when none. */
  readonly lastErrorReason: string | null;
  readonly retryPolicy: OutboxRetryPolicy;
}

/** Input accepted by {@link OutboxWriteRepository.enqueue}. */
export interface OutboxEnqueueInput {
  readonly idempotencyKey: string;
  /** Must be a canonicalizable JSON value; serialized deterministically. */
  readonly payload: CanonicalJsonValue;
  readonly createdAt: string;
  readonly retryPolicy?: OutboxRetryPolicyOverride;
}

export type OutboxEnqueueOutcome =
  | { readonly outcome: "ENQUEUED"; readonly record: OutboxRecord }
  | { readonly outcome: "ALREADY_ENQUEUED"; readonly record: OutboxRecord };

// --------------------------------------------------------------------------------
// Pure state-machine transitions (repositories persist what these compute)
// --------------------------------------------------------------------------------

function transitionError(from: OutboxDeliveryState, to: OutboxDeliveryState): never {
  throw new DomainError(
    `illegal outbox delivery transition ${from} -> ${to} (legal edges: ${OUTBOX_DELIVERY_TRANSITIONS[from].join(", ") || "none, terminal state"})`,
    { reason: "OUTBOX_TRANSITION_INVALID" },
  );
}

/**
 * Claims a PENDING record that is due at `at` and moves it to DELIVERING.
 * Throws a typed DomainError when the record is not PENDING or not due.
 */
export function claimOutboxRecord(record: OutboxRecord, at: UtcInstant): OutboxRecord {
  if (record.deliveryState !== "PENDING") {
    transitionError(record.deliveryState, "DELIVERING");
  }
  const dueAt = record.nextAttemptAt;
  if (dueAt === null || epochMsOf(dueAt) > epochMsOf(at)) {
    throw new DomainError(
      "outbox record is not due for delivery at the given instant (nextAttemptAt is later, or already terminal)",
      { reason: "OUTBOX_NOT_DUE" },
    );
  }
  return Object.freeze({ ...record, deliveryState: "DELIVERING" });
}

/** Completes delivery of a DELIVERING record (terminal DELIVERED). */
export function completeOutboxDelivery(record: OutboxRecord, at: UtcInstant): OutboxRecord {
  if (record.deliveryState !== "DELIVERING") {
    transitionError(record.deliveryState, "DELIVERED");
  }
  return Object.freeze({
    ...record,
    deliveryState: "DELIVERED",
    deliveredAt: at,
    nextAttemptAt: null,
  });
}

/**
 * Records a failed delivery attempt on a DELIVERING record:
 *  - attempts remain in budget -> back to PENDING with retryCount + 1 and
 *    nextAttemptAt = at + backoff(retryCount);
 *  - budget exhausted -> terminal FAILED.
 */
export function failOutboxAttempt(
  record: OutboxRecord,
  at: UtcInstant,
  reason?: string,
): OutboxRecord {
  if (record.deliveryState !== "DELIVERING") {
    transitionError(record.deliveryState, "FAILED");
  }
  if (reason !== undefined && (typeof reason !== "string" || !ERROR_REASON_PATTERN.test(reason))) {
    throw new ValidationError(
      "outbox failure reason must be an UPPER_SNAKE_CASE reason code (never a free-form message with values)",
      {
        reason: "OUTBOX_REASON_INVALID",
        details: [{ path: "reason", issue: "must match the reason-code pattern" }],
      },
    );
  }
  const retryCount = record.retryCount + 1;
  const next: OutboxRecord = {
    ...record,
    retryCount,
    lastErrorReason: reason ?? record.lastErrorReason,
  };
  if (retryCount >= record.retryPolicy.maxAttempts) {
    return Object.freeze({ ...next, deliveryState: "FAILED", nextAttemptAt: null });
  }
  return Object.freeze({
    ...next,
    deliveryState: "PENDING",
    nextAttemptAt: addMilliseconds(at, backoffMsForAttempt(record.retryPolicy, retryCount)),
  });
}

// --------------------------------------------------------------------------------
// Repository ports (write views exist only inside a UnitOfWork)
// --------------------------------------------------------------------------------

/** Transactional outbox writes - available only through a UnitOfWork. */
export interface OutboxWriteRepository {
  /**
   * Idempotently enqueues an outbound record. Same idempotency key + same
   * payload digest -> ALREADY_ENQUEUED (no second record); same key with a
   * different digest -> typed ConflictError (RL-LOCK-014).
   */
  enqueue(input: OutboxEnqueueInput): Promise<OutboxEnqueueOutcome>;
  /**
   * Atomically moves up to `limit` due PENDING records to DELIVERING and
   * returns them. Records already claimed by a concurrent committed unit of
   * work surface as a ConflictError at commit time.
   */
  claimDue(at: string, limit: number): Promise<readonly OutboxRecord[]>;
  /** DELIVERING -> DELIVERED (terminal). */
  markDelivered(idempotencyKey: string, at: string): Promise<OutboxRecord>;
  /** DELIVERING -> PENDING (retry scheduled) or DELIVERING -> FAILED (budget exhausted). */
  markAttemptFailed(idempotencyKey: string, at: string, reason?: string): Promise<OutboxRecord>;
}

/** Read-only view over committed outbox records. */
export interface OutboxReadRepository {
  get(idempotencyKey: string): Promise<OutboxRecord | null>;
  list(deliveryState?: OutboxDeliveryState): Promise<readonly OutboxRecord[]>;
  count(deliveryState?: OutboxDeliveryState): Promise<number>;
}

/**
 * Transactional outbox view: writes plus read-your-own-writes reads over the
 * unit-of-work state. Available only through a UnitOfWork.
 */
export interface OutboxRepository extends OutboxWriteRepository, OutboxReadRepository {}

/** Builds a fully validated, frozen PENDING outbox record. */
export function buildOutboxRecord(input: OutboxEnqueueInput): OutboxRecord {
  const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
  const createdAt = parseUtcInstant(input.createdAt);
  const retryPolicy = resolveRetryPolicy(input.retryPolicy);
  const canonical = canonicalizeJson(input.payload); // throws on non-JSON payloads
  return Object.freeze({
    idempotencyKey,
    payloadBytes: new TextEncoder().encode(canonical),
    payloadDigest: sha256Hex(canonical),
    createdAt,
    deliveryState: "PENDING",
    retryCount: 0,
    nextAttemptAt: createdAt,
    deliveredAt: null,
    lastErrorReason: null,
    retryPolicy,
  });
}
