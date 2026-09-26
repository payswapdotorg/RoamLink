/**
 * The deterministic in-memory durable-job delivery queue (RL-097 fake).
 *
 * Implements the {@link DurableJobDeliveryPort} AND models the QStash
 * delivery loop (push, retry with exponential backoff, dead-letter after
 * the attempt budget, redrive) so receivers are fully testable without a
 * real account. Deliveries are SIGNED with the configured signing key
 * (pinned header scheme), so receiver-side verification tests exercise
 * the REAL verifier.
 *
 * Determinism: explicit clock; no sleeps; deliveries run when the caller
 * invokes `runDueDeliveries`. Tests/local only - the production path is
 * the QStash client, and DURABLE TRUTH stays in the caller's
 * PostgreSQL-backed ledger either way.
 */
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  epochMsOf,
  parseUtcInstant,
} from "@roamlink/contracts";
import {
  type JobDelivery,
  type JobEnqueueReceipt,
  type JobEnqueueRequest,
  type JobId,
  type JobRecord,
  type JobReceiver,
  type JobState,
  type DurableJobDeliveryPort,
  type TransportProbePort,
  DEFAULT_MAX_PAYLOAD_BYTES,
  validateDestination,
  validateJobId,
} from "./port.js";
import {
  type RecurringDeliverySchedule,
  type RecurringDeliveryScheduleListing,
  type RecurringDeliveryScheduleRequest,
  type DurableJobSchedulePort,
  validateCronExpression,
} from "./schedule.js";
import { deterministicQStashJti, renderQStashSignatureHeader } from "./verifier.js";

export interface InMemoryJobDeliveryQueueOptions {
  /** REQUIRED explicit clock (deterministic deliveries). */
  readonly clock: { now(): string };
  /** Signing key used to sign outgoing deliveries (tests: receivers verify). */
  readonly signingKey: string;
  /** Attempt budget per job (default 5). */
  readonly maxAttempts?: number;
  /** Backoff base before the first retry (default 1000ms). */
  readonly initialBackoffMs?: number;
  /** Exponential backoff multiplier (default 2). */
  readonly backoffMultiplier?: number;
  /** Backoff cap (default 300000ms). */
  readonly maxBackoffMs?: number;
  /** Payload admission bound (default 1 MiB, the documented QStash limit). */
  readonly maxPayloadBytes?: number;
  /** DLQ capacity (default 1000). */
  readonly deadLetterCapacity?: number;
  /** Deterministic message-id generator (defaults to `msg-<n>`). */
  readonly messageIdFactory?: () => string;
}

interface MutableJob {
  jobId: JobId;
  messageId: string;
  destination: string;
  payload: string;
  payloadHash: string;
  state: JobState;
  attempts: number;
  deliverNotBeforeMs: number;
  lastErrorPhase?: "receiver-status" | "receiver-unreachable";
  lastReceiverStatus?: number;
}

const STATE_RANK: Record<JobState, number> = {
  pending: 0,
  retrying: 1,
  delivered: 2,
  "dead-lettered": 3,
};

function isLive(state: JobState): boolean {
  return state === "pending" || state === "retrying";
}

export class InMemoryJobDeliveryQueue implements DurableJobDeliveryPort, TransportProbePort, DurableJobSchedulePort {
  readonly #clock: InMemoryJobDeliveryQueueOptions["clock"];
  readonly #signingKey: string;
  readonly #maxAttempts: number;
  readonly #initialBackoffMs: number;
  readonly #backoffMultiplier: number;
  readonly #maxBackoffMs: number;
  readonly #maxPayloadBytes: number;
  readonly #deadLetterCapacity: number;
  readonly #messageIdFactory: () => string;
  readonly #jobs = new Map<JobId, MutableJob>();
  #deadLetterCount = 0;

  constructor(options: InMemoryJobDeliveryQueueOptions) {
    if (options === null || typeof options !== "object") {
      throw new ValidationError("InMemoryJobDeliveryQueueOptions must be an object", {
        reason: "QSTASH_FAKE_CONFIG_INVALID",
        details: [{ path: "options", issue: "not an object" }],
      });
    }
    if (typeof options.clock?.now !== "function") {
      throw new ValidationError("the fake queue requires an explicit clock", {
        reason: "QSTASH_FAKE_CONFIG_INVALID",
        details: [{ path: "clock", issue: "missing" }],
      });
    }
    if (typeof options.signingKey !== "string" || options.signingKey.length === 0) {
      throw new ValidationError("the fake queue requires a signing key (deliveries are signed)", {
        reason: "QSTASH_FAKE_CONFIG_INVALID",
        details: [{ path: "signingKey", issue: "missing" }],
      });
    }
    this.#clock = options.clock;
    this.#signingKey = options.signingKey;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.#backoffMultiplier = options.backoffMultiplier ?? 2;
    this.#maxBackoffMs = options.maxBackoffMs ?? 300_000;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.#deadLetterCapacity = options.deadLetterCapacity ?? 1_000;
    this.#messageIdFactory = options.messageIdFactory ?? (() => `msg-${this.#jobs.size + 1}`);
    this.#validateConfig();
  }

  #validateConfig(): void {
    for (const [key, value, min, max] of [
      ["maxAttempts", this.#maxAttempts, 1, 100],
      ["initialBackoffMs", this.#initialBackoffMs, 1, 3_600_000],
      ["maxBackoffMs", this.#maxBackoffMs, 1, 86_400_000],
      ["maxPayloadBytes", this.#maxPayloadBytes, 1, 16_777_216],
      ["deadLetterCapacity", this.#deadLetterCapacity, 1, 1_048_576],
    ] as const) {
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new ValidationError(`fake queue option '${key}' must be an integer between ${min} and ${max}`, {
          reason: "QSTASH_FAKE_CONFIG_INVALID",
          details: [{ path: key, issue: "out of bounds" }],
        });
      }
    }
    if (!Number.isFinite(this.#backoffMultiplier) || this.#backoffMultiplier < 1 || this.#backoffMultiplier > 100) {
      throw new ValidationError("backoffMultiplier must be a finite number between 1 and 100", {
        reason: "QSTASH_FAKE_CONFIG_INVALID",
        details: [{ path: "backoffMultiplier", issue: "out of bounds" }],
      });
    }
  }

  async enqueue(request: JobEnqueueRequest): Promise<JobEnqueueReceipt> {
    if (request === null || typeof request !== "object") {
      throw new ValidationError("JobEnqueueRequest must be an object", {
        reason: "JOB_REQUEST_INVALID",
        details: [{ path: "request", issue: "not an object" }],
      });
    }
    validateJobId(request.jobId);
    validateDestination(request.destination);
    const payload = canonicalJson(request.payload);
    if (Buffer.byteLength(payload, "utf8") > this.#maxPayloadBytes) {
      throw new ValidationError(
        `job payloads are admitted only up to ${this.#maxPayloadBytes} bytes (transport budget discipline)`,
        {
          reason: "JOB_PAYLOAD_TOO_LARGE",
          details: [{ path: "payload", issue: "exceeds the admission bound" }],
        },
      );
    }
    const deliverAfterMs = request.deliverAfterMs ?? 0;
    if (!Number.isInteger(deliverAfterMs) || deliverAfterMs < 0 || deliverAfterMs > 86_400_000) {
      throw new ValidationError("deliverAfterMs must be an integer between 0 and 86400000", {
        reason: "JOB_DELAY_INVALID",
        details: [{ path: "deliverAfterMs", issue: "out of bounds" }],
      });
    }

    const existing = this.#jobs.get(request.jobId);
    if (existing !== undefined) {
      if (existing.payloadHash !== payloadHash(payload)) {
        throw new ConflictError(
          "the job id is already recorded with a DIFFERENT payload (idempotency-key discipline: reuse the id only for the same logical job)",
          {
            reason: "JOB_ID_PAYLOAD_CONFLICT",
            details: [{ path: "jobId", issue: "already recorded with a different payload" }],
          },
        );
      }
      if (STATE_RANK[existing.state] >= STATE_RANK.delivered) {
        throw new ConflictError(
          "the job is already terminal (delivered/dead-lettered); redeliver through a new job id or the explicit redrive",
          {
            reason: "JOB_ALREADY_TERMINAL",
            details: [{ path: "jobId", issue: `state ${existing.state}` }],
          },
        );
      }
      return {
        jobId: existing.jobId,
        messageId: existing.messageId,
        accepted: true,
        deliverNotBeforeMs: existing.deliverNotBeforeMs,
        duplicate: true,
      };
    }

    const nowMs = this.#nowMs();
    const messageId = this.#messageIdFactory();
    const job: MutableJob = {
      jobId: request.jobId,
      messageId,
      destination: request.destination,
      payload,
      payloadHash: payloadHash(payload),
      state: "pending",
      attempts: 0,
      deliverNotBeforeMs: nowMs + deliverAfterMs,
    };
    this.#jobs.set(request.jobId, job);
    return {
      jobId: job.jobId,
      messageId,
      accepted: true,
      deliverNotBeforeMs: job.deliverNotBeforeMs,
      duplicate: false,
    };
  }

  async job(jobId: JobId): Promise<JobRecord | null> {
    validateJobId(jobId);
    const job = this.#jobs.get(jobId);
    return job === undefined ? null : this.#freeze(job);
  }

  #freeze(job: MutableJob): JobRecord {
    return Object.freeze({
      jobId: job.jobId,
      messageId: job.messageId,
      destination: job.destination,
      payload: job.payload,
      state: job.state,
      attempts: job.attempts,
      maxAttempts: this.#maxAttempts,
      deliverNotBeforeMs: job.deliverNotBeforeMs,
      ...(job.lastErrorPhase !== undefined ? { lastErrorPhase: job.lastErrorPhase } : {}),
      ...(job.lastReceiverStatus !== undefined ? { lastReceiverStatus: job.lastReceiverStatus } : {}),
    });
  }

  /**
   * Runs ONE due delivery attempt per pending/retrying job whose
   * `deliverNotBeforeMs` has passed (multiple calls advance the loop).
   * Returns the number of attempts made.
   */
  async runDueDeliveries(receiver: JobReceiver): Promise<number> {
    if (typeof receiver !== "function") {
      throw new ValidationError("runDueDeliveries requires a JobReceiver", {
        reason: "JOB_RECEIVER_INVALID",
        details: [{ path: "receiver", issue: "not a function" }],
      });
    }
    const nowMs = this.#nowMs();
    const due = [...this.#jobs.values()].filter(
      (job) => isLive(job.state) && job.deliverNotBeforeMs <= nowMs && job.attempts < this.#maxAttempts,
    );
    let attempts = 0;
    for (const job of due) {
      if (!isLive(job.state) || job.deliverNotBeforeMs > this.#nowMs()) continue;
      job.attempts += 1;
      attempts += 1;
      const sentAtMs = this.#nowMs();
      const delivery: JobDelivery = {
        jobId: job.jobId,
        messageId: job.messageId,
        destination: job.destination,
        payload: job.payload,
        attempt: job.attempts,
        sentAtMs,
        // Live claim shape (PA-017): sub = the delivery's destination,
        // jti deterministic per (iat, body) - the fake stays reproducible.
        signatureHeader: renderQStashSignatureHeader(this.#signingKey, Math.floor(sentAtMs / 1000), job.payload, {
          sub: job.destination,
          jti: deterministicQStashJti(Math.floor(sentAtMs / 1000), job.payload),
        }),
      };
      try {
        const status = await receiver(delivery);
        job.lastReceiverStatus = status;
        if (status >= 200 && status < 300) {
          job.state = "delivered";
        } else {
          job.lastErrorPhase = "receiver-status";
          this.#scheduleRetryOrDeadLetter(job, nowMs);
        }
      } catch {
        job.lastErrorPhase = "receiver-unreachable";
        this.#scheduleRetryOrDeadLetter(job, nowMs);
      }
    }
    return attempts;
  }

  #scheduleRetryOrDeadLetter(job: MutableJob, _nowMs: number): void {
    if (job.attempts >= this.#maxAttempts) {
      if (this.#deadLetterCount >= this.#deadLetterCapacity) {
        throw new ConflictError("the dead-letter path is at capacity (bounded DLQ discipline)", {
          reason: "JOB_DLQ_CAPACITY_EXCEEDED",
          details: [{ path: "deadLetterCapacity", issue: "exceeded" }],
        });
      }
      job.state = "dead-lettered";
      this.#deadLetterCount += 1;
      return;
    }
    const backoff = Math.min(
      this.#maxBackoffMs,
      this.#initialBackoffMs * Math.pow(this.#backoffMultiplier, job.attempts - 1),
    );
    job.state = "retrying";
    job.deliverNotBeforeMs = this.#nowMs() + backoff;
  }

  /** Dead-lettered jobs (bounded snapshot, oldest first). */
  deadLetters(): readonly JobRecord[] {
    return [...this.#jobs.values()]
      .filter((job) => job.state === "dead-lettered")
      .map((job) => this.#freeze(job));
  }

  /**
   * Explicit redrive: requeues a dead-lettered job with the attempt budget
   * reset (same payload - redrive never mutates the job's content).
   */
  async redrive(jobId: JobId): Promise<JobEnqueueReceipt> {
    validateJobId(jobId);
    const job = this.#jobs.get(jobId);
    if (job === undefined) {
      throw new NotFoundError("no job is recorded under this id", {
        reason: "JOB_NOT_FOUND",
        details: [{ path: "jobId", issue: "unknown" }],
      });
    }
    if (job.state !== "dead-lettered") {
      throw new ConflictError("only dead-lettered jobs can be redriven", {
        reason: "JOB_REDRIVE_INVALID",
        details: [{ path: "jobId", issue: `state ${job.state}` }],
      });
    }
    job.state = "pending";
    job.attempts = 0;
    job.deliverNotBeforeMs = this.#nowMs();
    this.#deadLetterCount -= 1;
    return {
      jobId: job.jobId,
      messageId: job.messageId,
      accepted: true,
      deliverNotBeforeMs: job.deliverNotBeforeMs,
      duplicate: false,
    };
  }

  #nowMs(): number {
    return epochMsOf(parseUtcInstant(this.#clock.now()));
  }

  // --------------------------------------------------------------------------
  // The recurring-delivery schedule surface (PA-025; see schedule.ts)
  // --------------------------------------------------------------------------

  readonly #schedules: { scheduleId: string; destination: string; cron: string; body: string | null }[] = [];
  #scheduleCounter = 0;

  /**
   * Deterministic schedule creation: records the recurring delivery and
   * returns a stable id (`sch-<n>`). Validation mirrors the hosted client
   * (HTTPS destination, 5-field cron, bounded body) so the fake stays the
   * contract reference (ADR-0003).
   */
  async createSchedule(request: RecurringDeliveryScheduleRequest): Promise<RecurringDeliverySchedule> {
    if (request === null || typeof request !== "object") {
      throw new ValidationError("RecurringDeliveryScheduleRequest must be an object", {
        reason: "SCHEDULE_REQUEST_INVALID",
        details: [{ path: "request", issue: "not an object" }],
      });
    }
    validateDestination(request.destination);
    validateCronExpression(request.cron);
    if (request.body !== undefined && (typeof request.body !== "string" || Buffer.byteLength(request.body, "utf8") > this.#maxPayloadBytes)) {
      throw new ValidationError(
        `schedule bodies are admitted only up to ${this.#maxPayloadBytes} bytes (transport budget discipline)`,
        {
          reason: "SCHEDULE_BODY_INVALID",
          details: [{ path: "body", issue: "not a bounded string" }],
        },
      );
    }
    this.#scheduleCounter += 1;
    const scheduleId = `sch-${String(this.#scheduleCounter).padStart(3, "0")}`;
    this.#schedules.push({
      scheduleId,
      destination: request.destination,
      cron: request.cron,
      body: request.body ?? null,
    });
    return { scheduleId };
  }

  /** The deterministic schedule listing (the idempotent-setup read). */
  async listSchedules(): Promise<readonly RecurringDeliveryScheduleListing[]> {
    return this.#schedules.map((schedule) => ({
      scheduleId: schedule.scheduleId,
      destination: schedule.destination,
      cron: schedule.cron,
    }));
  }

  /**
   * Test helper: fires every schedule ONE delivery round (the scheduled
   * transport's tick). Each fire delivers the schedule's body to its
   * receiver through the SAME signed-delivery loop as ordinary jobs, so
   * receivers under test verify REAL signatures. Returns the number of
   * delivery attempts made.
   */
  async runDueSchedules(receiver: JobReceiver): Promise<number> {
    if (typeof receiver !== "function") {
      throw new ValidationError("runDueSchedules requires a JobReceiver", {
        reason: "JOB_RECEIVER_INVALID",
        details: [{ path: "receiver", issue: "not a function" }],
      });
    }
    const nowMs = this.#nowMs();
    let attempts = 0;
    for (const schedule of this.#schedules) {
      if (schedule.body === null) continue; // no body configured: nothing to deliver deterministically
      attempts += 1;
      const sentAtMs = nowMs;
      const delivery: JobDelivery = {
        jobId: `schedule:${schedule.scheduleId}:${Math.floor(sentAtMs / 1000)}`,
        messageId: `scheduled-${schedule.scheduleId}-${Math.floor(sentAtMs / 1000)}`,
        destination: schedule.destination,
        payload: schedule.body,
        attempt: 1,
        sentAtMs,
        signatureHeader: renderQStashSignatureHeader(this.#signingKey, Math.floor(sentAtMs / 1000), schedule.body, {
          sub: schedule.destination,
          jti: deterministicQStashJti(Math.floor(sentAtMs / 1000), schedule.body),
        }),
      };
      try {
        await receiver(delivery);
      } catch {
        // A schedule fire whose receiver is unreachable is counted as an
        // attempt (the live transport retries on its own cadence); the
        // deterministic fake never blocks on it.
      }
    }
    return attempts;
  }

  // --------------------------------------------------------------------------
  // The read-only transport probe (RL-100; see TransportProbePort)
  // --------------------------------------------------------------------------

  #probeFailure: string | null = null;

  /**
   * Deterministic probe: resolves unless {@link breakProbes} forced an
   * outage. Reads nothing, mutates nothing, creates no message.
   */
  async probe(): Promise<void> {
    if (this.#probeFailure !== null) throw new Error(this.#probeFailure);
  }

  /** Test control: forces probe() to reject (simulated transport outage). */
  breakProbes(reason = "simulated transport outage"): void {
    this.#probeFailure = reason;
  }

  /** Test control: restores probe() to the healthy answer. */
  repairProbes(): void {
    this.#probeFailure = null;
  }
}

import { createHash } from "node:crypto";

/** Canonical JSON: stable key order (delivery + signature must be byte-exact). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = record[key];
      return sorted;
    }
    return entry;
  });
}

function payloadHash(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
