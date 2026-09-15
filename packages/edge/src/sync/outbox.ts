/**
 * Encrypted outbox record contract (RL-040 - TYPES ONLY; encryption and the
 * sync engine are RL-042, Wave 2; spec/mobile.md "Offline", RL-LOCK-015).
 *
 * The record SHAPE for durable offline queuing of desired-state commands:
 *
 *  - the payload travels ONLY as ciphertext inside
 *    {@link EdgeOutboxCiphertextEnvelope} (algorithm id + KEY REFERENCE +
 *    base64url ciphertext). Key material is never a field (RL-LOCK-016) and
 *    a plaintext command envelope is not even a valid field of this record -
 *    the parser rejects it as an unknown field;
 *  - identity/dedupe metadata (command id, correlation id, the envelope's
 *    idempotency key and the physical action dedupe key) stays in the clear
 *    so retries can be deduplicated WITHOUT decrypting anything
 *    (RL-LOCK-014);
 *  - retry policy, attempt counter and the last-known freshness of the
 *    carried desired state are first-class fields;
 *  - the state machine is validated invariants-only: pending -> in-flight ->
 *    synced, with dead-lettering only after the retry policy is exhausted.
 */
import {
  ValidationError,
  parseCommandId,
  parseContractVersion,
  parseCorrelationId,
  parseFreshness,
  parseIdempotencyKey,
  parseUtcInstant,
  type CommandId,
  type ContractVersion,
  type CorrelationId,
  type Freshness,
  type IdempotencyKey,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  parseEdgeDesiredStateId,
  parseEdgeDeviceRef,
  parseEdgeOutboxRecordId,
  type EdgeDesiredStateId,
  type EdgeDeviceRef,
  type EdgeOutboxRecordId,
} from "../ids.js";
import { describeEdgeContractVersionExpectation, isEdgeRecordVersionCompatible } from "../version.js";

// ---------------------------------------------------------------------------
// Ciphertext envelope
// ---------------------------------------------------------------------------

/** Safe-label charset for algorithm ids and key references. */
export const EDGE_OUTBOX_SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

/** base64url ciphertext charset (standard base64 with URL-safe alphabet). */
export const EDGE_OUTBOX_CIPHERTEXT_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

const MAX_CIPHERTEXT_LENGTH = 8192;

/**
 * The encrypted payload envelope. `keyId` references the key that encrypted
 * the payload - it is an IDENTIFIER, never key material (RL-LOCK-016). The
 * plaintext (command envelope + parameters) is only ever produced
 * transiently by the encryption boundary (RL-042).
 */
export interface EdgeOutboxCiphertextEnvelope {
  /** Encryption algorithm identifier (RL-042 pins the supported set). */
  readonly algorithm: string;
  /** Key reference (rotation-aware identifier); never the key itself. */
  readonly keyId: string;
  /** base64url-encoded ciphertext of the encrypted payload. */
  readonly ciphertext: string;
}

export function parseEdgeOutboxCiphertextEnvelope(value: unknown): EdgeOutboxCiphertextEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("EdgeOutboxCiphertextEnvelope must be an object", {
      reason: "EDGE_OUTBOX_CIPHERTEXT_INVALID",
      details: [{ path: "EdgeOutboxCiphertextEnvelope", issue: "not an object" }],
    });
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["algorithm", "keyId", "ciphertext"].includes(key)) {
      throw new ValidationError(
        `EdgeOutboxCiphertextEnvelope rejected unknown field '${key}'`,
        {
          reason: "EDGE_OUTBOX_CIPHERTEXT_INVALID",
          details: [{ path: `EdgeOutboxCiphertextEnvelope.${key}`, issue: "unknown field" }],
        },
      );
    }
  }
  const algorithm = record["algorithm"];
  if (typeof algorithm !== "string" || !EDGE_OUTBOX_SAFE_LABEL_PATTERN.test(algorithm)) {
    throw new ValidationError(
      "EdgeOutboxCiphertextEnvelope.algorithm must be a safe label (1-64 chars, starts alphanumeric)",
      {
        reason: "EDGE_OUTBOX_CIPHERTEXT_INVALID",
        details: [{ path: "algorithm", issue: "not a safe label" }],
      },
    );
  }
  const keyId = record["keyId"];
  if (typeof keyId !== "string" || !EDGE_OUTBOX_SAFE_LABEL_PATTERN.test(keyId)) {
    throw new ValidationError(
      "EdgeOutboxCiphertextEnvelope.keyId must be a safe key REFERENCE (1-64 chars) - key material is never stored here (RL-LOCK-016)",
      {
        reason: "EDGE_OUTBOX_CIPHERTEXT_INVALID",
        details: [{ path: "keyId", issue: "not a safe key reference" }],
      },
    );
  }
  const ciphertext = record["ciphertext"];
  if (
    typeof ciphertext !== "string" ||
    ciphertext.length === 0 ||
    ciphertext.length > MAX_CIPHERTEXT_LENGTH ||
    !EDGE_OUTBOX_CIPHERTEXT_PATTERN.test(ciphertext)
  ) {
    throw new ValidationError(
      `EdgeOutboxCiphertextEnvelope.ciphertext must be base64url text of 1-${MAX_CIPHERTEXT_LENGTH} chars`,
      {
        reason: "EDGE_OUTBOX_CIPHERTEXT_INVALID",
        details: [{ path: "ciphertext", issue: "not bounded base64url text" }],
      },
    );
  }
  return Object.freeze({ algorithm, keyId, ciphertext });
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/** Input accepted by {@link makeEdgeOutboxRetryPolicy}. */
export interface EdgeOutboxRetryPolicyInput {
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly backoffMultiplier: number;
  readonly maxBackoffMs: number;
}

/** The parsed, frozen retry policy. */
export interface EdgeOutboxRetryPolicy {
  /** Maximum total attempts (>= 1; the first attempt counts). */
  readonly maxAttempts: number;
  /** Backoff before the first retry, whole milliseconds. */
  readonly initialBackoffMs: number;
  /** Exponential factor applied per attempt (>= 1). */
  readonly backoffMultiplier: number;
  /** Upper bound on the computed backoff. */
  readonly maxBackoffMs: number;
}

export function makeEdgeOutboxRetryPolicy(input: EdgeOutboxRetryPolicyInput): EdgeOutboxRetryPolicy {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("EdgeOutboxRetryPolicy must be an object", {
      reason: "EDGE_OUTBOX_RETRY_POLICY_INVALID",
      details: [{ path: "EdgeOutboxRetryPolicy", issue: "not an object" }],
    });
  }
  const { maxAttempts, initialBackoffMs, backoffMultiplier, maxBackoffMs } = input;
  if (
    typeof maxAttempts !== "number" ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 100
  ) {
    throw new ValidationError("maxAttempts must be an integer between 1 and 100", {
      reason: "EDGE_OUTBOX_RETRY_POLICY_INVALID",
      details: [{ path: "maxAttempts", issue: "out of bounds" }],
    });
  }
  if (
    typeof initialBackoffMs !== "number" ||
    !Number.isInteger(initialBackoffMs) ||
    initialBackoffMs < 1 ||
    initialBackoffMs > 3_600_000
  ) {
    throw new ValidationError("initialBackoffMs must be an integer between 1 and 3600000", {
      reason: "EDGE_OUTBOX_RETRY_POLICY_INVALID",
      details: [{ path: "initialBackoffMs", issue: "out of bounds" }],
    });
  }
  if (
    typeof backoffMultiplier !== "number" ||
    !Number.isFinite(backoffMultiplier) ||
    backoffMultiplier < 1 ||
    backoffMultiplier > 100
  ) {
    throw new ValidationError("backoffMultiplier must be a finite number between 1 and 100", {
      reason: "EDGE_OUTBOX_RETRY_POLICY_INVALID",
      details: [{ path: "backoffMultiplier", issue: "out of bounds" }],
    });
  }
  if (
    typeof maxBackoffMs !== "number" ||
    !Number.isInteger(maxBackoffMs) ||
    maxBackoffMs < initialBackoffMs ||
    maxBackoffMs > 86_400_000
  ) {
    throw new ValidationError(
      "maxBackoffMs must be an integer between initialBackoffMs and 86400000",
      {
        reason: "EDGE_OUTBOX_RETRY_POLICY_INVALID",
        details: [{ path: "maxBackoffMs", issue: "out of bounds or below the initial backoff" }],
      },
    );
  }
  return Object.freeze({ maxAttempts, initialBackoffMs, backoffMultiplier, maxBackoffMs });
}

// ---------------------------------------------------------------------------
// Outbox record
// ---------------------------------------------------------------------------

export const EDGE_OUTBOX_RECORD_STATES = ["pending", "in-flight", "synced", "dead-lettered"] as const;

export type EdgeOutboxRecordState = (typeof EDGE_OUTBOX_RECORD_STATES)[number];

export function isEdgeOutboxRecordState(value: unknown): value is EdgeOutboxRecordState {
  return (
    typeof value === "string" &&
    (EDGE_OUTBOX_RECORD_STATES as readonly string[]).includes(value)
  );
}

export function parseEdgeOutboxRecordState(value: unknown): EdgeOutboxRecordState {
  if (!isEdgeOutboxRecordState(value)) {
    throw new ValidationError(
      "value is not a member of the closed outbox state vocabulary (pending, in-flight, synced, dead-lettered)",
      {
        reason: "EDGE_OUTBOX_STATE_INVALID",
        details: [{ path: "EdgeOutboxRecordState", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/** Input accepted by {@link parseEdgeOutboxRecord}. */
export interface EdgeOutboxRecordInput {
  readonly outboxRecordId: string;
  readonly contractVersion: string;
  readonly deviceRef: string;
  readonly desiredStateId: string;
  readonly actionDedupeKey: string;
  readonly commandIdempotencyKey: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly ciphertextEnvelope: EdgeOutboxCiphertextEnvelope;
  readonly state: string;
  readonly retryPolicy: EdgeOutboxRetryPolicyInput;
  readonly attempts: number;
  readonly lastAttemptAt: string | null;
  readonly createdAt: string;
  readonly lastKnownFreshness:
    | Freshness
    | {
        readonly observedAt?: string | null;
        readonly receivedAt?: string | null;
        readonly freshUntil?: string | null;
        readonly freshnessState?: string;
      };
}

/** The parsed, frozen encrypted-outbox record. */
export interface EdgeOutboxRecord {
  readonly outboxRecordId: EdgeOutboxRecordId;
  readonly contractVersion: ContractVersion;
  readonly deviceRef: EdgeDeviceRef;
  readonly desiredStateId: EdgeDesiredStateId;
  /** Dedupes the PHYSICAL device-side action across re-deliveries. */
  readonly actionDedupeKey: IdempotencyKey;
  /** The encrypted command envelope's idempotency key (server-side dedupe). */
  readonly commandIdempotencyKey: IdempotencyKey;
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly ciphertextEnvelope: EdgeOutboxCiphertextEnvelope;
  readonly state: EdgeOutboxRecordState;
  readonly retryPolicy: EdgeOutboxRetryPolicy;
  /** Attempts started so far (0..maxAttempts). */
  readonly attempts: number;
  readonly lastAttemptAt: UtcInstant | null;
  readonly createdAt: UtcInstant;
  readonly lastKnownFreshness: Freshness;
}

const ALLOWED_FIELDS = new Set([
  "outboxRecordId",
  "contractVersion",
  "deviceRef",
  "desiredStateId",
  "actionDedupeKey",
  "commandIdempotencyKey",
  "commandId",
  "correlationId",
  "ciphertextEnvelope",
  "state",
  "retryPolicy",
  "attempts",
  "lastAttemptAt",
  "createdAt",
  "lastKnownFreshness",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`EdgeOutboxRecord rejected: ${label} - ${issue}`, {
    reason: "EDGE_OUTBOX_RECORD_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * Parses and freezes an encrypted-outbox record. Validates the ciphertext
 * envelope, the retry policy, the closed state vocabulary and the state
 * invariants:
 *
 *  - `pending`: attempts 0 with no lastAttemptAt, or attempts > 0 with one;
 *  - `in-flight` / `synced`: at least one attempt and a lastAttemptAt;
 *  - `dead-lettered`: ONLY after the retry policy is exhausted
 *    (attempts === maxAttempts) with a lastAttemptAt.
 *
 * A plaintext command envelope is not a field of this record - it is
 * rejected as unknown (the payload is ciphertext-only, RL-LOCK-015/016).
 */
export function parseEdgeOutboxRecord(value: unknown): EdgeOutboxRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      field(key, "unknown field (the outbox record carries exactly its contract fields; the payload is ciphertext-only)");
    }
  }

  let outboxRecordId: EdgeOutboxRecordId;
  try {
    outboxRecordId = parseEdgeOutboxRecordId(input["outboxRecordId"]);
  } catch {
    field("outboxRecordId", "must be a canonical lowercase UUID");
  }
  let contractVersion: ContractVersion;
  try {
    contractVersion = parseContractVersion(input["contractVersion"]);
  } catch {
    field("contractVersion", "must be a MAJOR.MINOR contract version");
  }
  if (!isEdgeRecordVersionCompatible(contractVersion)) {
    field("contractVersion", describeEdgeContractVersionExpectation());
  }
  let deviceRef: EdgeDeviceRef;
  try {
    deviceRef = parseEdgeDeviceRef(input["deviceRef"]);
  } catch {
    field("deviceRef", "must be a non-empty safe reference string");
  }
  let desiredStateId: EdgeDesiredStateId;
  try {
    desiredStateId = parseEdgeDesiredStateId(input["desiredStateId"]);
  } catch {
    field("desiredStateId", "must be a canonical lowercase UUID");
  }
  let actionDedupeKey: IdempotencyKey;
  try {
    actionDedupeKey = parseIdempotencyKey(input["actionDedupeKey"]);
  } catch {
    field("actionDedupeKey", "must be a non-empty safe reference string");
  }
  let commandIdempotencyKey: IdempotencyKey;
  try {
    commandIdempotencyKey = parseIdempotencyKey(input["commandIdempotencyKey"]);
  } catch {
    field("commandIdempotencyKey", "must be a non-empty safe reference string");
  }
  let commandId: CommandId;
  try {
    commandId = parseCommandId(input["commandId"]);
  } catch {
    field("commandId", "must be a canonical lowercase UUID");
  }
  let correlationId: CorrelationId;
  try {
    correlationId = parseCorrelationId(input["correlationId"]);
  } catch {
    field("correlationId", "must be a non-empty safe reference string");
  }
  let ciphertextEnvelope: EdgeOutboxCiphertextEnvelope;
  try {
    ciphertextEnvelope = parseEdgeOutboxCiphertextEnvelope(input["ciphertextEnvelope"]);
  } catch (error) {
    if (error instanceof ValidationError) {
      field("ciphertextEnvelope", error.message);
    }
    throw error;
  }
  const state = (() => {
    try {
      return parseEdgeOutboxRecordState(input["state"]);
    } catch {
      field("state", "must be a member of the closed outbox state vocabulary");
    }
  })();
  let retryPolicy: EdgeOutboxRetryPolicy;
  try {
    retryPolicy = makeEdgeOutboxRetryPolicy(input["retryPolicy"] as EdgeOutboxRetryPolicyInput);
  } catch (error) {
    if (error instanceof ValidationError) {
      field("retryPolicy", error.message);
    }
    throw error;
  }

  const attempts = input["attempts"];
  if (
    typeof attempts !== "number" ||
    !Number.isInteger(attempts) ||
    attempts < 0 ||
    attempts > retryPolicy.maxAttempts
  ) {
    field("attempts", `must be an integer between 0 and the retry policy's maxAttempts (${retryPolicy.maxAttempts})`);
  }

  let lastAttemptAt: UtcInstant | null = null;
  if (input["lastAttemptAt"] !== null && input["lastAttemptAt"] !== undefined) {
    try {
      lastAttemptAt = parseUtcInstant(input["lastAttemptAt"]);
    } catch {
      field("lastAttemptAt", "must be null or a UTC instant with an explicit zone designator");
    }
  }
  let createdAt: UtcInstant;
  try {
    createdAt = parseUtcInstant(input["createdAt"]);
  } catch {
    field("createdAt", "must be a UTC instant with an explicit zone designator");
  }
  let lastKnownFreshness: Freshness;
  try {
    lastKnownFreshness = parseFreshness(input["lastKnownFreshness"]);
  } catch {
    field("lastKnownFreshness", "must be a Wave-0 freshness record");
  }

  // --- state invariants -----------------------------------------------------
  const hasAttemptTime = lastAttemptAt !== null;
  switch (state) {
    case "pending":
      if (attempts === 0 && hasAttemptTime) {
        field("lastAttemptAt", "a pending record with zero attempts must not carry a lastAttemptAt");
      }
      if (attempts > 0 && !hasAttemptTime) {
        field("lastAttemptAt", "a pending record with prior attempts must carry a lastAttemptAt");
      }
      break;
    case "in-flight":
      if (attempts < 1 || !hasAttemptTime) {
        field("state", "an in-flight record must have at least one started attempt and a lastAttemptAt");
      }
      break;
    case "synced":
      if (attempts < 1 || !hasAttemptTime) {
        field("state", "a synced record must have at least one attempt and a lastAttemptAt");
      }
      break;
    case "dead-lettered":
      if (attempts !== retryPolicy.maxAttempts || !hasAttemptTime) {
        field(
          "state",
          "a dead-lettered record must have exhausted the retry policy (attempts === maxAttempts) and carry a lastAttemptAt",
        );
      }
      break;
  }

  return Object.freeze({
    outboxRecordId,
    contractVersion,
    deviceRef,
    desiredStateId,
    actionDedupeKey,
    commandIdempotencyKey,
    commandId,
    correlationId,
    ciphertextEnvelope,
    state,
    retryPolicy,
    attempts,
    lastAttemptAt,
    createdAt,
    lastKnownFreshness,
  });
}
