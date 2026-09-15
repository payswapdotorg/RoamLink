/**
 * Structured log record contract (RL-040 platform scaffolding, RL-LOCK-016:
 * no secret leakage).
 *
 * Fields are TYPED, and secret-bearing values are redacted BY CONTRACT: the
 * only way to attach a secret-bearing value to a log record is
 * {@link secretLogValue}, which returns a {@link RedactedLogValue} wrapper.
 * The wrapper stores the raw value in a true private class field with NO
 * accessor - `JSON.stringify`, `String()`, `util.inspect` and property
 * enumeration all yield only "[REDACTED]". The raw value is unreachable
 * through the record.
 *
 * Validation rejects everything else that could smuggle secrets: non-primitive
 * field values, oversized messages/fields, control characters.
 */
import { inspect } from "node:util";
import {
  ValidationError,
  parseCorrelationId,
  parseTenantId,
  parseUtcInstant,
  type CorrelationId,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> = Object.freeze({
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
});

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

export function parseLogLevel(value: unknown): LogLevel {
  if (!isLogLevel(value)) {
    throw new ValidationError(
      "value is not a member of the closed log-level vocabulary (trace, debug, info, warn, error, fatal)",
      {
        reason: "LOG_LEVEL_INVALID",
        details: [{ path: "LogLevel", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/** Severity rank of a level (trace = 0 ... fatal = 5). */
export function logLevelSeverity(level: LogLevel): number {
  return LOG_LEVEL_SEVERITY[level];
}

/** True when `level` is at or above `threshold` severity. */
export function meetsLogLevelThreshold(level: LogLevel, threshold: LogLevel): boolean {
  return logLevelSeverity(level) >= logLevelSeverity(threshold);
}

/** The placeholder every serialization of a redacted value yields. */
export const REDACTED_LOG_PLACEHOLDER = "[REDACTED]";

/**
 * A secret-bearing log value that can never serialize its raw content. The
 * raw string lives in a true private field with no accessor; `toString`,
 * `toJSON`, `util.inspect` and property access all yield only
 * {@link REDACTED_LOG_PLACEHOLDER} (RL-LOCK-016).
 */
export class RedactedLogValue {
  // Deliberately write-only: the raw value is stored so it exists only in
  // memory, but NO code path ever reads it back - that is the redaction
  // seam itself (RL-LOCK-016).
  // eslint-disable-next-line no-unused-private-class-members
  #value: string;

  constructor(raw: string) {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) {
      throw new ValidationError("RedactedLogValue wraps a non-empty string of at most 4096 chars", {
        reason: "LOG_VALUE_INVALID",
        details: [{ path: "RedactedLogValue", issue: "not a bounded non-empty string" }],
      });
    }
    this.#value = raw;
  }

  toString(): string {
    return REDACTED_LOG_PLACEHOLDER;
  }

  toJSON(): string {
    return REDACTED_LOG_PLACEHOLDER;
  }

  [inspect.custom](): string {
    return "RedactedLogValue([REDACTED])";
  }
}

/** Wraps a secret-bearing value for log fields; never leaks it back out. */
export function secretLogValue(raw: string): RedactedLogValue {
  return new RedactedLogValue(raw);
}

/** The only value types a structured log field may carry. */
export type LogFieldValue = string | number | boolean | null | RedactedLogValue;

/** The structured log record contract. */
export interface StructuredLogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly at: UtcInstant;
  readonly correlationId?: CorrelationId;
  readonly tenantId?: TenantId;
  readonly fields: Readonly<Record<string, LogFieldValue>>;
}

/** Input accepted by {@link makeStructuredLogRecord}. */
export interface StructuredLogRecordInput {
  readonly level: string;
  readonly message: string;
  readonly at: string;
  readonly correlationId?: string;
  readonly tenantId?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

const LOG_FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_MESSAGE_LENGTH = 512;
const MAX_STRING_FIELD_LENGTH = 1024;
const MAX_FIELDS = 32;

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function parseFieldValue(key: string, value: unknown): LogFieldValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`log field '${key}' must be a finite number`, {
        reason: "LOG_RECORD_INVALID",
        details: [{ path: `fields.${key}`, issue: "non-finite number" }],
      });
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_FIELD_LENGTH || hasControlCharacter(value)) {
      throw new ValidationError(
        `log field '${key}' must be at most ${MAX_STRING_FIELD_LENGTH} chars and control-character free`,
        {
          reason: "LOG_RECORD_INVALID",
          details: [{ path: `fields.${key}`, issue: "string value out of bounds" }],
        },
      );
    }
    return value;
  }
  if (value instanceof RedactedLogValue) return value;
  throw new ValidationError(
    `log field '${key}' must be a string, number, boolean, null or a redacted value (wrap secrets with secretLogValue - RL-LOCK-016)`,
    {
      reason: "LOG_RECORD_INVALID",
      details: [{ path: `fields.${key}`, issue: "unsupported value type" }],
    },
  );
}

/** Builds a validated, frozen structured log record. */
export function makeStructuredLogRecord(input: StructuredLogRecordInput): StructuredLogRecord {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("StructuredLogRecord input must be an object", {
      reason: "LOG_RECORD_INVALID",
      details: [{ path: "StructuredLogRecord", issue: "not an object" }],
    });
  }
  const level = parseLogLevel(input.level);
  if (
    typeof input.message !== "string" ||
    input.message.length === 0 ||
    input.message.length > MAX_MESSAGE_LENGTH ||
    hasControlCharacter(input.message)
  ) {
    throw new ValidationError(
      `log message must be a non-empty, printable string of at most ${MAX_MESSAGE_LENGTH} chars`,
      {
        reason: "LOG_RECORD_INVALID",
        details: [{ path: "message", issue: "out of bounds" }],
      },
    );
  }
  const at = parseUtcInstant(input.at);

  let fields: Readonly<Record<string, LogFieldValue>> = Object.freeze({});
  if (input.fields !== undefined) {
    if (input.fields === null || typeof input.fields !== "object" || Array.isArray(input.fields)) {
      throw new ValidationError("log fields must be an object", {
        reason: "LOG_RECORD_INVALID",
        details: [{ path: "fields", issue: "not an object" }],
      });
    }
    const entries = Object.entries(input.fields);
    if (entries.length > MAX_FIELDS) {
      throw new ValidationError(`log records carry at most ${MAX_FIELDS} fields`, {
        reason: "LOG_RECORD_INVALID",
        details: [{ path: "fields", issue: "too many entries" }],
      });
    }
    const parsed: Record<string, LogFieldValue> = {};
    for (const [key, value] of entries) {
      if (!LOG_FIELD_KEY_PATTERN.test(key)) {
        throw new ValidationError(
          "log field keys must be safe labels (1-64 chars, starts alphanumeric, then [A-Za-z0-9_.-] only)",
          {
            reason: "LOG_RECORD_INVALID",
            details: [{ path: "fields", issue: `key '${key}' is not a safe label` }],
          },
        );
      }
      parsed[key] = parseFieldValue(key, value);
    }
    fields = Object.freeze(parsed);
  }

  return Object.freeze({
    level,
    message: input.message,
    at,
    ...(input.correlationId !== undefined ? { correlationId: parseCorrelationId(input.correlationId) } : {}),
    ...(input.tenantId !== undefined ? { tenantId: parseTenantId(input.tenantId) } : {}),
    fields,
  });
}

/** The guaranteed-plain, JSON-safe serialization of a log record. */
export interface SerializedStructuredLogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly at: UtcInstant;
  readonly correlationId?: CorrelationId;
  readonly tenantId?: TenantId;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * A guaranteed-plain, JSON-safe serialization of the record with redaction
 * applied to secret-bearing fields. (`JSON.stringify(record)` is ALSO safe -
 * RedactedLogValue serializes itself to "[REDACTED]" - but this returns a
 * plain object with no wrapper classes at all.)
 */
export function serializeStructuredLogRecord(
  record: StructuredLogRecord,
): SerializedStructuredLogRecord {
  const serializedFields: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(record.fields)) {
    serializedFields[key] =
      value instanceof RedactedLogValue ? REDACTED_LOG_PLACEHOLDER : value;
  }
  return Object.freeze({
    level: record.level,
    message: record.message,
    at: record.at,
    ...(record.correlationId !== undefined ? { correlationId: record.correlationId } : {}),
    ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
    fields: Object.freeze(serializedFields),
  });
}
