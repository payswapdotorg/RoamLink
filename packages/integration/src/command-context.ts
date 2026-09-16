/**
 * Shared §5 command-context construction for the ADCOS integration adapters
 * (RL-031/RL-032, spec/adcos-integration.md §5, RL-LOCK-014).
 *
 * Every externally mutating command carries: RoamLink command ID, correlation
 * ID, idempotency key, actor/tenant ID, intent/order version where
 * applicable, creation timestamp and retry metadata. The idempotency key is
 * DERIVED DETERMINISTICALLY from (operation, subject, payload digest) so the
 * same logical command always carries the same key - retries after timeout,
 * connection loss or duplicate delivery cannot create duplicate effects.
 */
import {
  ValidationError,
  canonicalJsonDigest,
  parseIdempotencyKey,
} from "@roamlink/contracts";
import { CommandEnvelope } from "@roamlink/contracts";
import type { CanonicalJsonValue, UtcInstant } from "@roamlink/contracts";

/** The §5 command metadata a RoamLink caller supplies for an ADCOS mutation. */
export interface AdcosCommandContext {
  readonly actorId: string;
  readonly tenantId: string;
  /** Caller correlation id; derived from the command identity when absent. */
  readonly correlationId?: string;
  /** Caller RoamLink command id (canonical UUID); generated when absent. */
  readonly commandId?: string;
  /** Caller idempotency key; derived deterministically when absent. */
  readonly idempotencyKey?: string;
  /** The intent version the command relates to, when applicable. */
  readonly intentVersion?: number;
  /** The order version the command relates to, when applicable. */
  readonly orderVersion?: number;
}

/** Deterministically derives the idempotency key for an operation command. */
export function deriveOperationIdempotencyKey(
  operation: string,
  subjectId: string,
  payloadDigest: string,
): string {
  return parseIdempotencyKey(`idem.${operation}.${subjectId}.${payloadDigest.slice(0, 16)}`);
}

/** Deterministically derives the default correlation id for an operation command. */
export function deriveOperationCorrelationId(operation: string, subjectId: string): string {
  return `corr.${operation}.${subjectId}`;
}

/**
 * The built command: the §5 envelope plus the digest of the canonical
 * request payload (audit input; the request itself travels separately).
 */
export interface BuiltAdcosCommand {
  readonly envelope: CommandEnvelope;
  readonly payloadDigest: string;
}

/**
 * Builds the full §5 command envelope for an ADCOS mutation over a subject
 * resource. `payload` must be the canonicalizable request body; its digest
 * participates in the derived idempotency key, so byte-identical commands
 * derive identical keys.
 */
export function buildAdcosCommand(options: {
  readonly operation: string;
  readonly subjectId: string;
  readonly payload: CanonicalJsonValue;
  readonly context: AdcosCommandContext;
  readonly at: UtcInstant;
  readonly commandId: string;
  readonly attempt?: number;
}): BuiltAdcosCommand {
  const payloadDigest = canonicalJsonDigest(options.payload);
  const idempotencyKey =
    options.context.idempotencyKey ??
    deriveOperationIdempotencyKey(options.operation, options.subjectId, payloadDigest);
  const envelope = new CommandEnvelope({
    commandId: options.context.commandId ?? options.commandId,
    correlationId:
      options.context.correlationId ?? deriveOperationCorrelationId(options.operation, options.subjectId),
    idempotencyKey,
    actorId: options.context.actorId,
    tenantId: options.context.tenantId,
    ...(options.context.intentVersion !== undefined
      ? { intentVersion: options.context.intentVersion }
      : {}),
    ...(options.context.orderVersion !== undefined
      ? { orderVersion: options.context.orderVersion }
      : {}),
    createdAt: options.at,
    retry: { attempt: options.attempt ?? 1 },
  });
  return Object.freeze({ envelope, payloadDigest });
}

/**
 * Rebuilds a command envelope for a retry attempt: same command id, same
 * idempotency key, same payload digest; only the retry metadata advances.
 * A changed payload under the same key fails loudly (RL-LOCK-014).
 */
export function retryAdcosCommand(
  command: BuiltAdcosCommand,
  options: {
    readonly payload: CanonicalJsonValue;
    readonly at: UtcInstant;
    readonly lastError: { readonly reason: string; readonly kind: string; readonly occurredAt: string };
  },
): BuiltAdcosCommand {
  const payloadDigest = canonicalJsonDigest(options.payload);
  if (payloadDigest !== command.payloadDigest) {
    throw new ValidationError(
      "retryAdcosCommand: the retried payload maps to a different digest; an idempotency key must never be reused for a different payload (RL-LOCK-014)",
      {
        reason: "ADCOS_COMMAND_RETRY_MISMATCH",
        details: [{ path: "payloadDigest", issue: "the retry payload differs from the original command" }],
      },
    );
  }
  const previous = command.envelope;
  const attempt = previous.retry.attempt + 1;
  const envelope = new CommandEnvelope({
    commandId: previous.commandId,
    correlationId: previous.correlationId,
    idempotencyKey: previous.idempotencyKey,
    actorId: previous.actorId,
    tenantId: previous.tenantId,
    ...(previous.intentVersion !== undefined ? { intentVersion: previous.intentVersion } : {}),
    ...(previous.orderVersion !== undefined ? { orderVersion: previous.orderVersion } : {}),
    createdAt: previous.createdAt,
    retry: {
      attempt,
      lastError: {
        reason: options.lastError.reason,
        kind: options.lastError.kind,
        occurredAt: options.lastError.occurredAt,
      },
    },
  });
  return Object.freeze({ envelope, payloadDigest });
}
