/**
 * Command envelope (RL-002, spec/adcos-integration.md §5 - exact fields,
 * RL-LOCK-014 idempotent commands).
 *
 * Every externally mutating command carries:
 *   commandId, correlationId, idempotencyKey, actorId, tenantId,
 *   intentVersion / orderVersion (where applicable), createdAt (UTC instant),
 *   retry metadata (attempt number, last error).
 *
 * The constructor validates ALL invariants and the resulting envelope is
 * deeply frozen. Deterministic canonical serialization (`canonicalJson` /
 * `digest`) lets persistence and idempotency recording treat identical
 * commands as identical bytes.
 */
import {
  ERROR_REASON_PATTERN,
  ValidationError,
  isErrorKind,
  type ErrorKind,
} from "../errors/errors.js";
import {
  parseCommandId,
  parseCorrelationId,
  parseIdempotencyKey,
  type CommandId,
  type CorrelationId,
  type IdempotencyKey,
} from "../ids/command-ids.js";
import { parseActorId, parseTenantId, type ActorId, type TenantId } from "../ids/tenant.js";
import { parseUtcInstant, type UtcInstant } from "../time/utc-instant.js";
import type { Revision } from "../versioning/versioning.js";
import { canonicalizeJson } from "../serialization/canonical-json.js";
import { canonicalJsonDigest, type Digest } from "../serialization/digest.js";

/** Machine-readable record of the last failed attempt, if any. */
export interface CommandLastError {
  readonly reason: string;
  readonly kind: ErrorKind;
  readonly occurredAt: UtcInstant;
}

export interface CommandRetryMetadata {
  /** 1-based attempt counter: 1 = first attempt (no retries yet). */
  readonly attempt: number;
  readonly lastError?: CommandLastError;
}

export interface CommandLastErrorInput {
  readonly reason: string;
  readonly kind: string;
  readonly occurredAt: string;
}

export interface CommandRetryMetadataInput {
  readonly attempt: number;
  readonly lastError?: CommandLastErrorInput;
}

/** Input accepted by the {@link CommandEnvelope} constructor. */
export interface CommandEnvelopeInput {
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly tenantId: string;
  readonly intentVersion?: number;
  readonly orderVersion?: number;
  readonly createdAt: string;
  readonly retry: CommandRetryMetadataInput;
}

/** Serialized form of an envelope (exactly the contract fields). */
export interface CommandEnvelopePlain {
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: IdempotencyKey;
  readonly actorId: ActorId;
  readonly tenantId: TenantId;
  readonly intentVersion?: Revision;
  readonly orderVersion?: Revision;
  readonly createdAt: UtcInstant;
  readonly retry: CommandRetryMetadata;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "commandId",
  "correlationId",
  "idempotencyKey",
  "actorId",
  "tenantId",
  "intentVersion",
  "orderVersion",
  "createdAt",
  "retry",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`CommandEnvelope rejected: ${label} - ${issue}`, {
    reason: "COMMAND_ENVELOPE_INVALID",
    details: [{ path: label, issue }],
  });
}

/** Runs a parser, converting any failure into an envelope field error. */
function parseField<T>(label: string, issue: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    field(label, issue);
  }
}

function parseOptionalRevision(value: unknown, label: string): Revision | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    field(label, "must be a positive integer revision when present");
  }
  return value as Revision;
}

function parseRetry(input: CommandRetryMetadataInput): CommandRetryMetadata {
  const { attempt } = input;
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
    field("retry.attempt", "must be an integer >= 1 (1 = first attempt)");
  }
  const lastErrorInput = input.lastError;
  if (lastErrorInput === undefined) {
    return Object.freeze({ attempt });
  }
  if (lastErrorInput === null || typeof lastErrorInput !== "object") {
    field("retry.lastError", "must be an object when present");
  }
  const lastError = lastErrorInput;
  if (typeof lastError.reason !== "string" || !ERROR_REASON_PATTERN.test(lastError.reason)) {
    field("retry.lastError.reason", "must be an UPPER_SNAKE_CASE reason code");
  }
  if (!isErrorKind(lastError.kind)) {
    field("retry.lastError.kind", "must be a member of the RoamLink error taxonomy");
  }
  const occurredAt = parseField(
    "retry.lastError.occurredAt",
    "must be a UTC instant with an explicit zone designator",
    () => parseUtcInstant(lastError.occurredAt),
  );
  return Object.freeze({
    attempt,
    lastError: Object.freeze({
      reason: lastError.reason,
      kind: lastError.kind,
      occurredAt,
    }),
  });
}

export class CommandEnvelope {
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: IdempotencyKey;
  readonly actorId: ActorId;
  readonly tenantId: TenantId;
  /** Optional own properties - only present when set (declare keeps them from being defined as undefined). */
  declare readonly intentVersion?: Revision;
  declare readonly orderVersion?: Revision;
  readonly createdAt: UtcInstant;
  readonly retry: CommandRetryMetadata;

  constructor(input: CommandEnvelopeInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the envelope carries exactly the §5 contract fields)");
      }
    }

    const commandId = parseField("commandId", "must be a canonical lowercase UUID", () =>
      parseCommandId(input.commandId),
    );
    const correlationId = parseField(
      "correlationId",
      "must be a non-empty safe reference string",
      () => parseCorrelationId(input.correlationId),
    );
    const idempotencyKey = parseField(
      "idempotencyKey",
      "must be a non-empty safe reference string (RL-LOCK-014)",
      () => parseIdempotencyKey(input.idempotencyKey),
    );
    const actorId = parseField("actorId", "must be a non-empty safe reference string", () =>
      parseActorId(input.actorId),
    );
    const tenantId = parseField(
      "tenantId",
      "must be 'org:<uuid>' or 'usr:<uuid>' (organization/customer boundary)",
      () => parseTenantId(input.tenantId),
    );
    const createdAt = parseField(
      "createdAt",
      "must be a UTC instant with an explicit zone designator",
      () => parseUtcInstant(input.createdAt),
    );
    if (input.retry === null || typeof input.retry !== "object") {
      field("retry", "must be an object with an attempt counter");
    }
    const intentVersion = parseOptionalRevision(input.intentVersion, "intentVersion");
    const orderVersion = parseOptionalRevision(input.orderVersion, "orderVersion");
    const retry = parseRetry(input.retry);

    this.commandId = commandId;
    this.correlationId = correlationId;
    this.idempotencyKey = idempotencyKey;
    this.actorId = actorId;
    this.tenantId = tenantId;
    this.createdAt = createdAt;
    this.retry = retry;
    if (intentVersion !== undefined) {
      this.intentVersion = intentVersion;
    }
    if (orderVersion !== undefined) {
      this.orderVersion = orderVersion;
    }
    Object.freeze(this);
  }

  /** Plain, serializable form with exactly the contract fields. */
  toPlain(): CommandEnvelopePlain {
    const plain: CommandEnvelopePlain = {
      commandId: this.commandId,
      correlationId: this.correlationId,
      idempotencyKey: this.idempotencyKey,
      actorId: this.actorId,
      tenantId: this.tenantId,
      createdAt: this.createdAt,
      retry: this.retry,
    };
    if (this.intentVersion !== undefined && this.orderVersion !== undefined) {
      return { ...plain, intentVersion: this.intentVersion, orderVersion: this.orderVersion };
    }
    if (this.intentVersion !== undefined) {
      return { ...plain, intentVersion: this.intentVersion };
    }
    if (this.orderVersion !== undefined) {
      return { ...plain, orderVersion: this.orderVersion };
    }
    return plain;
  }

  /** Deterministic canonical JSON (sorted keys) of the envelope. */
  canonicalJson(): string {
    return canonicalizeJson(this.toPlain());
  }

  /** Deterministic SHA-256 digest of the canonical JSON form. */
  digest(): Digest {
    return canonicalJsonDigest(this.toPlain());
  }

  /** Validating round-trip from an unknown (e.g. JSON-parsed) value. */
  static fromPlain(value: unknown): CommandEnvelope {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      field("$", "fromPlain expects an object");
    }
    return new CommandEnvelope(value as CommandEnvelopeInput);
  }
}
