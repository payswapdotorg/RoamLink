/**
 * SQL <-> port-state mapping for the PostgreSQL persistence adapter (RL-091).
 *
 * Every row -> record conversion re-validates through the port constructors
 * and parsers (fail closed against corrupted or hand-edited rows - never
 * guess). Every record -> row conversion canonicalizes JSON and instants so
 * what lands in the database is exactly the port's canonical form.
 */
import {
  ValidationError,
  parseDigest,
  parseIdempotencyKey,
  parseRevision,
  parseUtcInstant,
  type CanonicalJsonValue,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  parseOutboxDeliveryState,
  type OutboxDeliveryState,
  type OutboxRecord,
  type OutboxRetryPolicy,
} from "@roamlink/persistence";
import { isInboxAdmissionState, type InboxRecord } from "@roamlink/persistence";
import type { VersionedRecord } from "@roamlink/persistence";

// --------------------------------------------------------------------------------
// Instants
// --------------------------------------------------------------------------------

/** Converts a driver value (Date, ISO text, or PG text render) to a UtcInstant. */
export function instantFromSql(value: unknown, column: string): UtcInstant {
  if (value instanceof Date) {
    return parseUtcInstant(value.toISOString());
  }
  if (typeof value === "string") {
    // Normalize the classic PG text render `2026-01-15 08:30:00+00` into the
    // canonical form before strict parsing.
    const normalized = value.replace(" ", "T").replace("+00", "Z");
    return parseUtcInstant(normalized);
  }
  throw new ValidationError(`database column ${column} does not carry a parseable instant`, {
    reason: "SQL_ROW_CORRUPT",
    details: [{ path: column, issue: "not an instant" }],
  });
}

/** Converts a UtcInstant into the ISO parameter form drivers accept. */
export function instantToParam(instant: UtcInstant): string {
  return instant;
}

// --------------------------------------------------------------------------------
// Canonical JSON values
// --------------------------------------------------------------------------------

/** Parses a jsonb column (requested as ::text) into a canonical JSON value. */
export function jsonFromSql(value: unknown, column: string): CanonicalJsonValue {
  if (typeof value !== "string") {
    throw new ValidationError(`database column ${column} does not carry JSON text`, {
      reason: "SQL_ROW_CORRUPT",
      details: [{ path: column, issue: "not JSON text" }],
    });
  }
  try {
    return JSON.parse(value) as CanonicalJsonValue;
  } catch {
    throw new ValidationError(`database column ${column} is not valid JSON`, {
      reason: "SQL_ROW_CORRUPT",
      details: [{ path: column, issue: "invalid JSON" }],
    });
  }
}

/** Canonicalizes a value before it may be written (fail closed on non-JSON). */
export function jsonToParam(value: CanonicalJsonValue): string {
  const canonical = JSON.stringify(value);
  return canonical;
}

// --------------------------------------------------------------------------------
// Versioned records
// --------------------------------------------------------------------------------

const RECORD_COLUMNS =
  "repository, record_id, version, (value::text) AS value_json";

function recordFromRow(row: Record<string, unknown>): VersionedRecord {
  const recordId = row["record_id"];
  const version = row["version"];
  if (typeof recordId !== "string") {
    throw new ValidationError("record row is missing record_id", {
      reason: "SQL_ROW_CORRUPT",
      details: [{ path: "record_id", issue: "missing" }],
    });
  }
  return Object.freeze({
    recordId,
    version: parseRevision(typeof version === "number" ? version : Number(version)),
    value: jsonFromSql(row["value_json"], "value"),
  });
}

function repositoryOf(row: Record<string, unknown>): string {
  const repository = row["repository"];
  if (typeof repository !== "string") {
    throw new ValidationError("record row is missing the repository name", {
      reason: "SQL_ROW_CORRUPT",
      details: [{ path: "repository", issue: "missing" }],
    });
  }
  return repository;
}

export {
  RECORD_COLUMNS,
  recordFromRow,
  repositoryOf,
};

// --------------------------------------------------------------------------------
// Outbox records
// --------------------------------------------------------------------------------

const OUTBOX_COLUMNS = [
  "idempotency_key",
  "payload_bytes AS payload_bytes_raw",
  "payload_digest",
  "created_at",
  "delivery_state",
  "retry_count",
  "next_attempt_at",
  "delivered_at",
  "last_error_reason",
  "retry_max_attempts",
  "(retry_backoff_ms::text) AS retry_backoff_json",
].join(", ");

function retryPolicyFromRow(row: Record<string, unknown>): OutboxRetryPolicy {
  const maxAttempts = row["retry_max_attempts"];
  const schedule = jsonFromSql(row["retry_backoff_json"], "retry_backoff_ms");
  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ValidationError("outbox row carries an invalid retry_max_attempts", {
      reason: "SQL_ROW_CORRUPT",
      details: [{ path: "retry_max_attempts", issue: "not a positive integer" }],
    });
  }
  if (!Array.isArray(schedule) || !schedule.every((ms) => typeof ms === "number" && Number.isInteger(ms) && ms >= 1)) {
    throw new ValidationError("outbox row carries an invalid retry_backoff_ms schedule", {
      reason: "SQL_ROW_CORRUPT",
      details: [{ path: "retry_backoff_ms", issue: "not a positive-integer schedule" }],
    });
  }
  return Object.freeze({
    maxAttempts,
    backoffScheduleMs: Object.freeze(schedule),
  });
}

function outboxFromRow(row: Record<string, unknown>): OutboxRecord {
  const key = row["idempotency_key"];
  const digest = row["payload_digest"];
  const bytesRaw = row["payload_bytes_raw"];
  if (typeof key !== "string" || typeof digest !== "string") {
    throw new ValidationError("outbox row is missing its idempotency key or payload digest", {
      reason: "SQL_ROW_CORRUPT",
      details: [{ path: "idempotency_key", issue: "missing" }],
    });
  }
  // bytea arrives as the driver's representation; both pg and pglite hand
  // Uint8Array/Buffer back for bytea columns - normalize defensively.
  let payloadBytes: Uint8Array;
  if (bytesRaw instanceof Uint8Array) {
    payloadBytes = new Uint8Array(bytesRaw);
  } else if (typeof bytesRaw === "string") {
    payloadBytes = new TextEncoder().encode(bytesRaw);
  } else {
    throw new ValidationError("outbox row payload_bytes is not decodable", {
      reason: "SQL_ROW_CORRUPT",
      details: [{ path: "payload_bytes", issue: "unsupported driver representation" }],
    });
  }
  const nextAttemptRaw = row["next_attempt_at"];
  const deliveredRaw = row["delivered_at"];
  const lastErrorRaw = row["last_error_reason"];
  return Object.freeze({
    idempotencyKey: parseIdempotencyKey(key),
    payloadBytes,
    payloadDigest: parseDigest(digest),
    createdAt: instantFromSql(row["created_at"], "created_at"),
    deliveryState: parseOutboxDeliveryState(row["delivery_state"]),
    retryCount:
      typeof row["retry_count"] === "number"
        ? row["retry_count"]
        : Number(row["retry_count"]),
    nextAttemptAt:
      nextAttemptRaw === null || nextAttemptRaw === undefined
        ? null
        : instantFromSql(nextAttemptRaw, "next_attempt_at"),
    deliveredAt:
      deliveredRaw === null || deliveredRaw === undefined
        ? null
        : instantFromSql(deliveredRaw, "delivered_at"),
    lastErrorReason: typeof lastErrorRaw === "string" ? lastErrorRaw : null,
    retryPolicy: retryPolicyFromRow(row),
  });
}

function outboxUpdateParams(record: OutboxRecord): readonly unknown[] {
  return [
    record.deliveryState satisfies OutboxDeliveryState,
    record.retryCount,
    record.nextAttemptAt === null ? null : instantToParam(record.nextAttemptAt),
    record.deliveredAt === null ? null : instantToParam(record.deliveredAt),
    record.lastErrorReason,
  ];
}

export { OUTBOX_COLUMNS, outboxFromRow, outboxUpdateParams };

// --------------------------------------------------------------------------------
// Inbox records
// --------------------------------------------------------------------------------

const INBOX_COLUMNS =
  "sequence, source, external_event_id, received_at, dedupe_key, admission_state";

function inboxFromRow(row: Record<string, unknown>): InboxRecord {
  const state = row["admission_state"];
  if (!isInboxAdmissionState(state)) {
    throw new ValidationError("inbox row carries an admission state outside the closed vocabulary", {
      reason: "SQL_ROW_CORRUPT",
      details: [{ path: "admission_state", issue: "outside the closed vocabulary" }],
    });
  }
  return Object.freeze({
    sequence:
      typeof row["sequence"] === "number" ? row["sequence"] : Number(row["sequence"]),
    source: String(row["source"] ?? ""),
    externalEventId: String(row["external_event_id"] ?? ""),
    receivedAt: instantFromSql(row["received_at"], "received_at"),
    dedupeKey: String(row["dedupe_key"] ?? ""),
    admissionState: state,
  });
}

export { INBOX_COLUMNS, inboxFromRow };
