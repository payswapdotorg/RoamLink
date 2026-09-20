/**
 * Correlated leveled logger (RL-040 platform scaffolding).
 *
 * A thin, dependency-free composition of the log-record contract, the
 * correlation context carrier and a sink port: every emitted record is
 * built via {@link makeStructuredLogRecord} (fail-closed validation) and
 * automatically carries the current context's correlation id and tenant id.
 * The in-memory sink supports tests and local development.
 */
import { nowUtc, ValidationError, type UtcInstant } from "@roamlink/contracts";

import type { CorrelationContextCarrier } from "../correlation/correlation-context.js";
import {
  makeStructuredLogRecord,
  meetsLogLevelThreshold,
  parseLogLevel,
  serializeStructuredLogRecord,
  type LogLevel,
  type LogFieldValue,
  type StructuredLogRecord,
} from "./log-record.js";

/** Where validated log records go (console adapter, pipeline, test buffer...). */
export type StructuredLogSink = (record: StructuredLogRecord) => void;

/**
 * The production console sink (RL-105/RL-107 wiring): one JSON line per
 * record through the guaranteed-plain serialization (secret-bearing fields
 * render as "[REDACTED]" - RL-LOCK-016). The write seam is injectable so
 * tests capture lines without ambient console access.
 */
export function createConsoleStructuredLogSink(
  write: (line: string) => void = (line) => console.log(line),
): StructuredLogSink {
  return (record: StructuredLogRecord) => {
    write(JSON.stringify(serializeStructuredLogRecord(record)));
  };
}

/** In-memory sink with a frozen snapshot view (tests, local dev). */
export interface InMemoryLogSink {
  readonly sink: StructuredLogSink;
  records(): readonly StructuredLogRecord[];
  clear(): void;
}

export function createInMemoryLogSink(): InMemoryLogSink {
  const buffer: StructuredLogRecord[] = [];
  return {
    sink: (record) => {
      buffer.push(record);
    },
    records: () => Object.freeze([...buffer]),
    clear: () => {
      buffer.length = 0;
    },
  };
}

/** Leveled logger surface. */
export interface LeveledLogger {
  trace(message: string, fields?: Readonly<Record<string, LogFieldValue>>): void;
  debug(message: string, fields?: Readonly<Record<string, LogFieldValue>>): void;
  info(message: string, fields?: Readonly<Record<string, LogFieldValue>>): void;
  warn(message: string, fields?: Readonly<Record<string, LogFieldValue>>): void;
  error(message: string, fields?: Readonly<Record<string, LogFieldValue>>): void;
  fatal(message: string, fields?: Readonly<Record<string, LogFieldValue>>): void;
}

/** Options for {@link createCorrelatedLogger}. */
export interface CorrelatedLoggerOptions {
  readonly sink: StructuredLogSink;
  readonly carrier: CorrelationContextCarrier;
  /** Minimum level to emit; defaults to "info". */
  readonly minLevel?: string;
  /** Injectable clock (deterministic tests); defaults to the system clock. */
  readonly now?: () => UtcInstant;
}

/**
 * Builds a leveled logger whose records carry the current correlation
 * context. Records below `minLevel` are dropped before the sink. Invalid
 * messages/fields fail fast (fail-closed validation, never a silent
 * partial record).
 */
export function createCorrelatedLogger(options: CorrelatedLoggerOptions): LeveledLogger {
  if (options === null || typeof options !== "object") {
    throw new ValidationError("CorrelatedLoggerOptions must be an object", {
      reason: "LOGGER_INVALID",
      details: [{ path: "CorrelatedLoggerOptions", issue: "not an object" }],
    });
  }
  const minLevel = options.minLevel === undefined ? "info" : parseLogLevel(options.minLevel);
  const now = options.now ?? nowUtc;

  const emit = (level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void => {
    if (!meetsLogLevelThreshold(level, minLevel)) return;
    const context = options.carrier.current();
    const record = makeStructuredLogRecord({
      level,
      message,
      at: now(),
      ...(context?.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
      ...(context?.tenantId !== undefined ? { tenantId: context.tenantId } : {}),
      ...(fields !== undefined ? { fields } : {}),
    });
    options.sink(record);
  };

  return {
    trace: (message, fields) => emit("trace", message, fields),
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    fatal: (message, fields) => emit("fatal", message, fields),
  };
}
