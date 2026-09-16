/**
 * The reconciliation job record (RL-035, spec/data-model.md
 * `AdcosReconciliationJob`, spec/adcos-integration.md §5+§7).
 *
 * One record per reconciliation job run. The record IS the §5 command: it
 * carries the full idempotency metadata set (command/job id, correlation id,
 * idempotency key, actor/tenant, creation timestamp, retry metadata), so a
 * crashed job can be re-run BY ID and converges to the same outcome instead
 * of duplicating effects (RL-LOCK-014).
 *
 * The per-target repair evidence lives in the append-only `actions` list:
 * every scanned canonical resource gets exactly one CANONICAL_REFRESH action
 * whose outcome names the repair class from spec §7. All action details are
 * log-safe (codes and shapes only - never payloads, never secrets,
 * RL-LOCK-016).
 *
 * State machine (closed):
 *
 *   PENDING -> RUNNING -> COMPLETED
 *                     \-> FAILED -> RUNNING (retry after a deterministic failure)
 *
 * Transient ADCOS failures NEVER fail a job - they degrade projections to
 * STALE/UNKNOWN and complete honestly (spec §7: "the system does not guess").
 */
import {
  ValidationError,
  parseActorId,
  parseCommandId,
  parseCorrelationId,
  parseIdempotencyKey,
  parseTenantId,
  parseUtcInstant,
  type ActorId,
  type CanonicalJsonValue,
  type CommandId,
  type CorrelationId,
  type IdempotencyKey,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";
import { type AdcosProjectionResourceType } from "@roamlink/projections";

// --------------------------------------------------------------------------------
// Closed vocabularies
// --------------------------------------------------------------------------------

/** The job lifecycle (a command lifecycle, not a connectivity lifecycle). */
export const RECONCILIATION_JOB_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "FAILED"] as const;

export type ReconciliationJobStatus = (typeof RECONCILIATION_JOB_STATUSES)[number];

export function isReconciliationJobStatus(value: unknown): value is ReconciliationJobStatus {
  return (
    typeof value === "string" &&
    (RECONCILIATION_JOB_STATUSES as readonly string[]).includes(value)
  );
}

/** The legal job transitions (COMPLETED is terminal; FAILED is retryable). */
export const RECONCILIATION_JOB_TRANSITIONS: Readonly<
  Record<ReconciliationJobStatus, readonly ReconciliationJobStatus[]>
> = Object.freeze({
  PENDING: ["RUNNING"],
  RUNNING: ["COMPLETED", "FAILED"],
  FAILED: ["RUNNING"],
  COMPLETED: [],
});

/** Why a job was started. */
export const RECONCILIATION_TRIGGER_REASONS = [
  "scheduled",
  "startup",
  "manual",
  "crash-recovery",
] as const;

export type ReconciliationTriggerReason = (typeof RECONCILIATION_TRIGGER_REASONS)[number];

export function isReconciliationTriggerReason(value: unknown): value is ReconciliationTriggerReason {
  return (
    typeof value === "string" &&
    (RECONCILIATION_TRIGGER_REASONS as readonly string[]).includes(value)
  );
}

/** What a phase of the job did (spec §7 repair classes map onto these). */
export const RECONCILIATION_ACTION_TYPES = [
  "FRESHNESS_SWEEP",
  "INBOX_DRAIN",
  "DISCOVERY",
  "CANONICAL_REFRESH",
] as const;

export type ReconciliationActionType = (typeof RECONCILIATION_ACTION_TYPES)[number];

export function isReconciliationActionType(value: unknown): value is ReconciliationActionType {
  return (
    typeof value === "string" &&
    (RECONCILIATION_ACTION_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The closed outcome vocabulary of one action. The §7 repair classes surface
 * as: REPAIRED (missed webhook / stale / partial / out-of-order repaired),
 * ALREADY_CONSISTENT (duplicates verified harmless), DEGRADED_STALE /
 * DEGRADED_UNKNOWN (truth unobtainable - never a guess), CANONICAL_ABSENT
 * (the authority says the resource is gone), DEFERRED (retry next job),
 * FAILED (deterministic integrity failure of the action itself).
 */
export const RECONCILIATION_ACTION_OUTCOMES = [
  "REPAIRED",
  "ALREADY_CONSISTENT",
  "DEGRADED_STALE",
  "DEGRADED_UNKNOWN",
  "CANONICAL_ABSENT",
  "DEFERRED",
  "FAILED",
] as const;

export type ReconciliationActionOutcome = (typeof RECONCILIATION_ACTION_OUTCOMES)[number];

export function isReconciliationActionOutcome(value: unknown): value is ReconciliationActionOutcome {
  return (
    typeof value === "string" &&
    (RECONCILIATION_ACTION_OUTCOMES as readonly string[]).includes(value)
  );
}

// --------------------------------------------------------------------------------
// Records
// --------------------------------------------------------------------------------

/** §5 retry metadata (mirrors the Wave-0 command envelope retry shape). */
export interface ReconciliationJobRetry {
  /** 1-based attempt counter: 1 = first attempt (no retries yet). */
  readonly attempt: number;
  readonly lastError?: {
    readonly reason: string;
    readonly kind: string;
    readonly occurredAt: UtcInstant;
  };
}

/** One repair/scan unit performed by a job (append-only evidence). */
export interface ReconciliationActionRecord {
  /** Deterministic: `<job_id>#<ordinal>` within the job's action list. */
  readonly action_id: string;
  readonly action_type: ReconciliationActionType;
  readonly outcome: ReconciliationActionOutcome;
  readonly resource_type?: AdcosProjectionResourceType;
  readonly resource_id?: string;
  /** Log-safe detail (codes/shape names only - RL-LOCK-016). */
  readonly detail: string;
  readonly attempted_at: UtcInstant;
  /** How many canonical-read attempts this action consumed (>= 1). */
  readonly attempts: number;
  /** Closed, log-safe counters (e.g. the inbox-drain report). */
  readonly metrics?: CanonicalJsonValue;
}

/** The durable job record: §5 command fields + lifecycle + repair evidence. */
export interface ReconciliationJobRecord {
  readonly job_id: CommandId;
  readonly correlation_id: CorrelationId;
  readonly idempotency_key: IdempotencyKey;
  readonly actor_id: ActorId;
  readonly tenant_id: TenantId;
  readonly created_at: UtcInstant;
  readonly retry: ReconciliationJobRetry;
  readonly trigger_reason: ReconciliationTriggerReason;
  readonly status: ReconciliationJobStatus;
  readonly started_at: UtcInstant | null;
  readonly completed_at: UtcInstant | null;
  readonly failure_reason?: string;
  readonly actions: readonly ReconciliationActionRecord[];
  readonly summary: ReconciliationJobSummary | null;
}

/** Deterministic roll-up of the action list. */
export interface ReconciliationJobSummary {
  readonly scanned: number;
  readonly repaired: number;
  readonly alreadyConsistent: number;
  readonly degradedStale: number;
  readonly degradedUnknown: number;
  readonly canonicalAbsent: number;
  readonly deferred: number;
  readonly failed: number;
}

const JOB_FIELDS = [
  "job_id",
  "correlation_id",
  "idempotency_key",
  "actor_id",
  "tenant_id",
  "created_at",
  "retry",
  "trigger_reason",
  "status",
  "started_at",
  "completed_at",
  "failure_reason",
  "actions",
  "summary",
] as const;

const ACTION_FIELDS = [
  "action_id",
  "action_type",
  "outcome",
  "resource_type",
  "resource_id",
  "detail",
  "attempted_at",
  "attempts",
  "metrics",
] as const;

const SUMMARY_FIELDS = [
  "scanned",
  "repaired",
  "alreadyConsistent",
  "degradedStale",
  "degradedUnknown",
  "canonicalAbsent",
  "deferred",
  "failed",
] as const;

function field(label: string, issue: string): never {
  throw new ValidationError(`ReconciliationJobRecord rejected: ${label} - ${issue}`, {
    reason: "RECONCILIATION_JOB_RECORD_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseNullableInstant(value: unknown, label: string): UtcInstant | null {
  if (value === null) return null;
  if (typeof value !== "string") field(label, "must be a UTC instant string or null");
  try {
    return parseUtcInstant(value);
  } catch {
    field(label, "must be a UTC instant string or null");
  }
}

function parseRetry(value: unknown): ReconciliationJobRetry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("retry", "must be an object with an attempt counter");
  }
  const retry = value as Record<string, unknown>;
  if (
    typeof retry["attempt"] !== "number" ||
    !Number.isInteger(retry["attempt"]) ||
    retry["attempt"] < 1
  ) {
    field("retry.attempt", "must be an integer >= 1 (1 = first attempt)");
  }
  if (retry["lastError"] === undefined) {
    return Object.freeze({ attempt: retry["attempt"] as number });
  }
  const lastError = retry["lastError"];
  if (lastError === null || typeof lastError !== "object" || Array.isArray(lastError)) {
    field("retry.lastError", "must be an object when present");
  }
  const error = lastError as Record<string, unknown>;
  if (typeof error["reason"] !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(error["reason"])) {
    field("retry.lastError.reason", "must be an UPPER_SNAKE_CASE reason code");
  }
  if (typeof error["kind"] !== "string" || error["kind"].length === 0) {
    field("retry.lastError.kind", "must be a non-empty error-kind name");
  }
  return Object.freeze({
    attempt: retry["attempt"] as number,
    lastError: Object.freeze({
      reason: error["reason"] as string,
      kind: error["kind"] as string,
      occurredAt: parseUtcInstant(error["occurredAt"]),
    }),
  });
}

/**
 * Validates and freezes a job record from persistence. The field set is
 * CLOSED: unknown fields are rejected so the record shape stays an audited
 * contract (RL-LOCK-017 spirit).
 */
export function parseReconciliationJobRecord(value: unknown): ReconciliationJobRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(JOB_FIELDS as readonly string[]).includes(key)) {
      field(key, "unknown field (the job-record vocabulary is closed)");
    }
  }
  for (const required of ["job_id", "correlation_id", "idempotency_key", "actor_id", "tenant_id", "created_at", "retry", "trigger_reason", "status", "actions", "summary", "started_at", "completed_at"]) {
    if (record[required] === undefined) {
      field(required, "is required");
    }
  }

  let jobId: CommandId;
  try {
    jobId = parseCommandId(record["job_id"]);
  } catch {
    field("job_id", "must be a canonical lowercase UUID (the §5 command id)");
  }
  let correlationId: CorrelationId;
  try {
    correlationId = parseCorrelationId(record["correlation_id"]);
  } catch {
    field("correlation_id", "must be a safe reference string");
  }
  let idempotencyKey: IdempotencyKey;
  try {
    idempotencyKey = parseIdempotencyKey(record["idempotency_key"]);
  } catch {
    field("idempotency_key", "must be a safe reference string (RL-LOCK-014)");
  }
  let actorId: ActorId;
  try {
    actorId = parseActorId(record["actor_id"]);
  } catch {
    field("actor_id", "must be a safe reference string");
  }
  let tenantId: TenantId;
  try {
    tenantId = parseTenantId(record["tenant_id"]);
  } catch {
    field("tenant_id", "must be 'org:<uuid>' or 'usr:<uuid>'");
  }
  if (!isReconciliationTriggerReason(record["trigger_reason"])) {
    field("trigger_reason", "must be scheduled, startup, manual or crash-recovery");
  }
  if (!isReconciliationJobStatus(record["status"])) {
    field("status", "must be PENDING, RUNNING, COMPLETED or FAILED");
  }
  if (record["failure_reason"] !== undefined) {
    if (typeof record["failure_reason"] !== "string" || record["failure_reason"].length === 0) {
      field("failure_reason", "must be a non-empty reason code when present");
    }
  }
  if (!Array.isArray(record["actions"])) {
    field("actions", "must be an array of action records");
  }
  const actions = (record["actions"] as unknown[]).map((entry, index) =>
    parseAction(entry, `actions[${index}]`, jobId),
  );

  let summary: ReconciliationJobSummary | null = null;
  if (record["summary"] !== null) {
    if (record["summary"] === undefined) field("summary", "is required (null before completion)");
    const raw = record["summary"];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      field("summary", "must be an object or null");
    }
    const summaryRecord = raw as Record<string, unknown>;
    for (const key of Object.keys(summaryRecord)) {
      if (!(SUMMARY_FIELDS as readonly string[]).includes(key)) {
        field(`summary.${key}`, "unknown field (the summary vocabulary is closed)");
      }
    }
    for (const required of SUMMARY_FIELDS) {
      const value = summaryRecord[required];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        field(`summary.${required}`, "must be a non-negative integer");
      }
    }
    summary = Object.freeze({
      scanned: summaryRecord["scanned"] as number,
      repaired: summaryRecord["repaired"] as number,
      alreadyConsistent: summaryRecord["alreadyConsistent"] as number,
      degradedStale: summaryRecord["degradedStale"] as number,
      degradedUnknown: summaryRecord["degradedUnknown"] as number,
      canonicalAbsent: summaryRecord["canonicalAbsent"] as number,
      deferred: summaryRecord["deferred"] as number,
      failed: summaryRecord["failed"] as number,
    });
  }

  return Object.freeze({
    job_id: jobId,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    actor_id: actorId,
    tenant_id: tenantId,
    created_at: parseUtcInstant(record["created_at"]),
    retry: parseRetry(record["retry"]),
    trigger_reason: record["trigger_reason"] as ReconciliationTriggerReason,
    status: record["status"] as ReconciliationJobStatus,
    started_at: parseNullableInstant(record["started_at"], "started_at"),
    completed_at: parseNullableInstant(record["completed_at"], "completed_at"),
    ...(record["failure_reason"] !== undefined
      ? { failure_reason: record["failure_reason"] as string }
      : {}),
    actions: Object.freeze(actions),
    summary,
  });
}

/** Validates and freezes one action record against its owning job id. */
export function parseReconciliationActionRecord(
  value: unknown,
  jobId: CommandId,
): ReconciliationActionRecord {
  return parseAction(value, `action`, jobId);
}

function parseAction(value: unknown, label: string, jobId: CommandId): ReconciliationActionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field(label, "must be an object");
  }
  const action = value as Record<string, unknown>;
  for (const key of Object.keys(action)) {
    if (!(ACTION_FIELDS as readonly string[]).includes(key)) {
      field(`${label}.${key}`, "unknown field (the action vocabulary is closed)");
    }
  }
  for (const required of ["action_id", "action_type", "outcome", "detail", "attempted_at", "attempts"]) {
    if (action[required] === undefined) {
      field(`${label}.${required}`, "is required");
    }
  }
  if (typeof action["action_id"] !== "string" || !action["action_id"].startsWith(`${jobId}#`)) {
    field(`${label}.action_id`, `must be the deterministic '<job_id>#<ordinal>' identity`);
  }
  if (!isReconciliationActionType(action["action_type"])) {
    field(`${label}.action_type`, "must be one of the closed action types");
  }
  if (!isReconciliationActionOutcome(action["outcome"])) {
    field(`${label}.outcome`, "must be one of the closed action outcomes");
  }
  if (typeof action["detail"] !== "string" || action["detail"].length === 0 || action["detail"].length > 512) {
    field(`${label}.detail`, "must be a non-empty log-safe detail (max 512 chars)");
  }
  if (
    typeof action["attempts"] !== "number" ||
    !Number.isInteger(action["attempts"]) ||
    action["attempts"] < 1
  ) {
    field(`${label}.attempts`, "must be an integer >= 1");
  }
  if (action["resource_id"] !== undefined) {
    if (typeof action["resource_id"] !== "string" || action["resource_id"].length === 0) {
      field(`${label}.resource_id`, "must be a non-empty canonical resource id when present");
    }
  }
  if (action["metrics"] !== undefined) {
    if (action["metrics"] === null || typeof action["metrics"] !== "object") {
      field(`${label}.metrics`, "must be a log-safe JSON object when present");
    }
  }
  return Object.freeze({
    action_id: action["action_id"] as string,
    action_type: action["action_type"] as ReconciliationActionType,
    outcome: action["outcome"] as ReconciliationActionOutcome,
    ...(action["resource_type"] !== undefined
      ? { resource_type: action["resource_type"] as AdcosProjectionResourceType }
      : {}),
    ...(action["resource_id"] !== undefined ? { resource_id: action["resource_id"] as string } : {}),
    detail: action["detail"] as string,
    attempted_at: parseUtcInstant(action["attempted_at"]),
    attempts: action["attempts"] as number,
    ...(action["metrics"] !== undefined
      ? { metrics: action["metrics"] as CanonicalJsonValue }
      : {}),
  });
}

// --------------------------------------------------------------------------------
// Transitions
// --------------------------------------------------------------------------------

/**
 * Computes the next job record with ONLY lifecycle fields changed. Throws a
 * typed ValidationError when the transition is illegal or when immutable §5
 * command fields are altered (a job's command identity never changes).
 */
export function applyReconciliationJobTransition(
  current: ReconciliationJobRecord,
  next: Pick<ReconciliationJobRecord, "status"> &
    Partial<
      Pick<
        ReconciliationJobRecord,
        | "started_at"
        | "completed_at"
        | "actions"
        | "summary"
        | "retry"
        | "failure_reason"
        | "trigger_reason"
      >
    >,
): ReconciliationJobRecord {
  const legal = RECONCILIATION_JOB_TRANSITIONS[current.status];
  if (legal === undefined || !legal.includes(next.status)) {
    field(
      "status",
      `illegal job transition ${current.status} -> ${next.status} (COMPLETED is terminal; FAILED jobs may re-run)`,
    );
  }
  for (const [key, value] of Object.entries(current)) {
    if (
      key === "status" ||
      key === "started_at" ||
      key === "completed_at" ||
      key === "actions" ||
      key === "summary" ||
      key === "retry" ||
      key === "failure_reason" ||
      key === "trigger_reason"
    ) {
      continue;
    }
    const nextValue = (next as Record<string, unknown>)[key];
    if (nextValue !== undefined && nextValue !== value) {
      field(key, "the §5 command identity fields are immutable for the life of the job");
    }
  }
  if (
    next.trigger_reason !== undefined &&
    next.trigger_reason !== current.trigger_reason &&
    current.status !== "FAILED"
  ) {
    field("trigger_reason", "may only change when a FAILED job is re-run (as crash-recovery)");
  }
  const merged: Record<string, unknown> = { ...current, ...next };
  if (next.status === "RUNNING") {
    // A re-started job carries no failure record (it is being retried).
    delete merged["failure_reason"];
  }
  return parseReconciliationJobRecord(merged);
}

/** The deterministic idempotency key of a job (safe reference charset). */
export function reconciliationJobIdempotencyKey(jobId: CommandId): IdempotencyKey {
  return parseIdempotencyKey(`idem.reconcile-job.${jobId}`);
}

/** Computes the deterministic summary over an action list. */
export function summarizeReconciliationActions(
  actions: readonly ReconciliationActionRecord[],
  scanned: number,
): ReconciliationJobSummary {
  const summary: ReconciliationJobSummary = {
    scanned,
    repaired: countOutcome(actions, "REPAIRED"),
    alreadyConsistent: countOutcome(actions, "ALREADY_CONSISTENT"),
    degradedStale: countOutcome(actions, "DEGRADED_STALE"),
    degradedUnknown: countOutcome(actions, "DEGRADED_UNKNOWN"),
    canonicalAbsent: countOutcome(actions, "CANONICAL_ABSENT"),
    deferred: countOutcome(actions, "DEFERRED"),
    failed: countOutcome(actions, "FAILED"),
  };
  return Object.freeze(summary);
}

function countOutcome(
  actions: readonly ReconciliationActionRecord[],
  outcome: ReconciliationActionOutcome,
): number {
  let total = 0;
  for (const action of actions) {
    if (action.outcome === outcome) total += 1;
  }
  return total;
}
