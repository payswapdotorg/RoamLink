/**
 * The durable-jobs delivery PORT (RL-097).
 *
 * Job flow (spec/deployment.md §2/§4): webhook admission / scheduled work
 * -> DURABLE queue (PostgreSQL-backed ledger owned by the caller) ->
 * QStash delivery -> receiver endpoint verification. QStash is RETRYABLE
 * ASYNC TRANSPORT - never business-state authority (ADR-0003): the port
 * therefore REQUIRES a caller-supplied durable job id (the idempotency
 * key, RL-LOCK-014) and never invents durable truth itself.
 *
 * Delivery semantics:
 *  - `enqueue` hands a durably-recorded job to the transport; duplicate
 *    enqueues of the same (jobId, payload) are a no-op returning the same
 *    receipt; a jobId reused with a DIFFERENT payload is a typed conflict;
 *  - retries are the transport's responsibility (QStash retries non-2xx
 *    receivers with backoff); the fake models the same semantics
 *    deterministically so receivers are testable;
 *  - exhausted attempts land in a dead-letter path (DLQ) with an explicit
 *    redrive action - a stranded job is always diagnosable (the §17
 *    outbox-stranding finding is the anti-pattern this port refuses);
 *  - every delivery is SIGNED and receivers VERIFY before acting
 *    (webhook-inbox verification rigor).
 */
import { ValidationError, type ErrorDetail } from "@roamlink/contracts";

/** Default payload admission bound (QStash free tier documents 1 MB). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576;

/** Caller-supplied durable job id (idempotency key). */
export type JobId = string;

export interface JobEnqueueRequest {
  /**
   * REQUIRED durable id from the caller's PostgreSQL-backed ledger. The
   * transport never generates it: durable truth is not transport state.
   */
  readonly jobId: JobId;
  /** HTTPS receiver URL (the endpoint that will VERIFY the signature). */
  readonly destination: string;
  /** JSON-serializable payload (admitted under the size bound). */
  readonly payload: unknown;
  /** Earliest delivery as an epoch-ms delay from enqueue (>= 0). */
  readonly deliverAfterMs?: number;
}

export interface JobEnqueueReceipt {
  readonly jobId: JobId;
  /** The transport's message id (echoed on every delivery attempt). */
  readonly messageId: string;
  /** True when the transport accepted the job (dedupe returns accepted receipt). */
  readonly accepted: true;
  /** Absolute epoch ms of the earliest delivery (caller clock semantics). */
  readonly deliverNotBeforeMs: number;
  readonly duplicate: boolean;
}

/** The delivery a receiver endpoint sees (signed; verify BEFORE acting). */
export interface JobDelivery {
  readonly jobId: JobId;
  readonly messageId: string;
  readonly destination: string;
  /** Canonical JSON string (byte-exact; the signature covers it). */
  readonly payload: string;
  /** 1-based attempt number. */
  readonly attempt: number;
  readonly sentAtMs: number;
  /** The signature header value the receiver verifies (QStash scheme). */
  readonly signatureHeader: string;
}

/**
 * A receiver endpoint: returns the HTTP status it would answer with
 * (2xx = accepted). Throw = connection-level failure (retried).
 */
export type JobReceiver = (delivery: JobDelivery) => Promise<number>;

/** Terminal, diagnosable job states (closed vocabulary). */
export const JOB_STATES = ["pending", "retrying", "delivered", "dead-lettered"] as const;

export type JobState = (typeof JOB_STATES)[number];

export interface JobRecord {
  readonly jobId: JobId;
  readonly messageId: string;
  readonly destination: string;
  readonly payload: string;
  readonly state: JobState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly deliverNotBeforeMs: number;
  /** Set for dead-lettered jobs: the phase that finally failed. */
  readonly lastErrorPhase?: "receiver-status" | "receiver-unreachable";
  readonly lastReceiverStatus?: number;
}

export interface DurableJobDeliveryPort {
  /**
   * Hands a durably-recorded job to the transport. Idempotent per jobId:
   * same (jobId, payload) -> the same receipt (duplicate=true); different
   * payload for a live jobId -> typed conflict.
   *
   * The port is deliberately transport-only: job STATE is read from the
   * caller's PostgreSQL-backed ledger (durable truth is not transport
   * state, ADR-0003).
   */
  enqueue(request: JobEnqueueRequest): Promise<JobEnqueueReceipt>;
}

export const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function issue(path: string, problem: string): ErrorDetail {
  return { path, issue: problem };
}

export function validateJobId(jobId: string): string {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    throw new ValidationError(
      "job ids must be safe labels (1-128 chars, starts alphanumeric, then [A-Za-z0-9._:@-] only)",
      {
        reason: "JOB_ID_INVALID",
        details: [issue("jobId", "not a safe label")],
      },
    );
  }
  return jobId;
}

export function validateDestination(destination: string): string {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    throw new ValidationError("the job destination must be an absolute URL", {
      reason: "JOB_DESTINATION_INVALID",
      details: [issue("destination", "not an absolute URL")],
    });
  }
  if (url.protocol !== "https:") {
    throw new ValidationError("the job destination must be HTTPS (signed jobs on public wire)", {
      reason: "JOB_DESTINATION_INVALID",
      details: [issue("destination", "not https")],
    });
  }
  return destination;
}
