/**
 * Command correlation identifiers (RL-002, spec/adcos-integration.md §5).
 *
 * Every externally mutating command carries a RoamLink command ID, a
 * correlation ID and an idempotency key (RL-LOCK-014). Command IDs are
 * RoamLink-generated canonical UUIDs; correlation IDs and idempotency keys
 * may originate from external parties, so they use the conservative
 * foreign-reference charset.
 */
import type { Branded } from "../brand.js";
import {
  isCanonicalUuid,
  isForeignRefShaped,
  parseCanonicalUuidAs,
  parseForeignRefAs,
} from "./id-shapes.js";

/** RoamLink-generated identifier of a single mutating command. */
export type CommandId = Branded<"CommandId">;

/** Correlates a request flow across boundaries (request ID / trace correlation). */
export type CorrelationId = Branded<"CorrelationId">;

/** Caller-chosen key making a mutation idempotent under retries (RL-LOCK-014). */
export type IdempotencyKey = Branded<"IdempotencyKey">;

export function parseCommandId(value: unknown): CommandId {
  return parseCanonicalUuidAs<CommandId>(value, "CommandId");
}

export function parseCorrelationId(value: unknown): CorrelationId {
  return parseForeignRefAs<CorrelationId>(value, "CorrelationId");
}

export function parseIdempotencyKey(value: unknown): IdempotencyKey {
  return parseForeignRefAs<IdempotencyKey>(value, "IdempotencyKey");
}

export function isCommandId(value: unknown): value is CommandId {
  return isCanonicalUuid(value);
}

export function isCorrelationId(value: unknown): value is CorrelationId {
  return isForeignRefShaped(value);
}

export function isIdempotencyKey(value: unknown): value is IdempotencyKey {
  return isForeignRefShaped(value);
}
