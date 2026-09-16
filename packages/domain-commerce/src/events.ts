/**
 * Immutable commerce event records (RL-021, spec/data-model.md "Commerce").
 *
 * Every commerce state transition is recorded as an APPEND-ONLY event with
 * the full §5 command correlation (actor, command, correlation,
 * idempotency key): the event log is the durable history of the aggregate
 * while the aggregate records themselves are compare-and-swapped forward.
 * Events are immutable - no mutation API exists on the repository port - and
 * are chained per aggregate (`sequence` must be exactly previous + 1), the
 * same chain-continuity discipline the experience domain applies to device
 * snapshots.
 *
 * Events carry the POST-TRANSITION aggregate record in `payload`, so the log
 * alone reconstructs the aggregate's history without trusting current state
 * (event sourcing with explicit, typed transitions only - no inferred
 * diffs).
 *
 * NO connectivity semantics live here (RL-LOCK-008 "payment is not
 * delivery"): an order event describes commercial intent only; delivery,
 * reservations, sessions and usage belong to ADCOS (RL-LOCK-001/005) and are
 * referenced - never modeled - by Wave 3 work (RL-023).
 */
import {
  ValidationError,
  parseActorId,
  parseCommandId,
  parseContractVersion,
  parseCorrelationId,
  parseIdempotencyKey,
  parseRevision,
  parseTenantId,
  parseUtcInstant,
  type ActorId,
  type CanonicalJsonValue,
  type CommandId,
  type ContractVersion,
  type CorrelationId,
  type IdempotencyKey,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  DOMAIN_COMMERCE_CONTRACT_VERSION,
  describeDomainCommerceVersionExpectation,
  isDomainCommerceRecordVersionCompatible,
} from "./version.js";

/** The aggregate types that emit commerce events. */
export const COMMERCE_AGGREGATE_TYPES = [
  "product",
  "product_variant",
  "order",
  "subscription",
] as const;

export type CommerceAggregateType = (typeof COMMERCE_AGGREGATE_TYPES)[number];

export function isCommerceAggregateType(value: unknown): value is CommerceAggregateType {
  return (
    typeof value === "string" &&
    (COMMERCE_AGGREGATE_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The closed transition vocabulary - every entry is an EXPLICIT, typed
 * transition of one aggregate's state machine. Order lines are recorded as
 * `order.line_added` events on the ORDER chain (the line record itself is
 * an immutable insert in its own repository).
 */
export const COMMERCE_TRANSITIONS = [
  "product.created",
  "product.activated",
  "product.retired",
  "product_variant.created",
  "product_variant.retired",
  "order.created",
  "order.line_added",
  "order.placed",
  "order.completed",
  "order.cancelled",
  "subscription.created",
  "subscription.activated",
  "subscription.suspended",
  "subscription.resumed",
  "subscription.cancelled",
  "subscription.expired",
  "subscription.superseded",
] as const;

export type CommerceTransition = (typeof COMMERCE_TRANSITIONS)[number];

export function isCommerceTransition(value: unknown): value is CommerceTransition {
  return (
    typeof value === "string" && (COMMERCE_TRANSITIONS as readonly string[]).includes(value)
  );
}

/** The aggregate chain a transition belongs to. */
export function aggregateTypeOfTransition(transition: CommerceTransition): CommerceAggregateType {
  if (transition.startsWith("product_variant.")) return "product_variant";
  if (transition.startsWith("product.")) return "product";
  if (transition.startsWith("order.")) return "order";
  return "subscription";
}

/** Serialized (plain) form of a commerce event. */
export interface CommerceEventRecord {
  readonly contractVersion: ContractVersion;
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly aggregateType: CommerceAggregateType;
  readonly aggregateId: string;
  /** The aggregate revision AFTER the transition (audit anchor). */
  readonly aggregateRevision: Revision;
  /** 1-based position in the per-aggregate event chain. */
  readonly sequence: number;
  readonly transition: CommerceTransition;
  /** Transition facts as canonical JSON (post-transition aggregate record). */
  readonly payload: CanonicalJsonValue;
  readonly actorId: ActorId;
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: IdempotencyKey;
  readonly occurredAt: UtcInstant;
}

/** Input accepted by the {@link CommerceEvent} constructor. */
export interface CommerceEventInput {
  readonly eventId: string;
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateRevision: number;
  readonly sequence: number;
  readonly transition: string;
  readonly payload: unknown;
  readonly actorId: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "eventId",
  "tenantId",
  "aggregateType",
  "aggregateId",
  "aggregateRevision",
  "sequence",
  "transition",
  "payload",
  "actorId",
  "commandId",
  "correlationId",
  "idempotencyKey",
  "occurredAt",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`CommerceEvent rejected: ${label} - ${issue}`, {
    reason: "COMMERCE_EVENT_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * A validated commerce event. Frozen deeply; events are values (no methods
 * that mutate anything).
 */
export class CommerceEvent {
  readonly contractVersion: ContractVersion;
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly aggregateType: CommerceAggregateType;
  readonly aggregateId: string;
  readonly aggregateRevision: Revision;
  readonly sequence: number;
  readonly transition: CommerceTransition;
  readonly payload: CanonicalJsonValue;
  readonly actorId: ActorId;
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: IdempotencyKey;
  readonly occurredAt: UtcInstant;

  constructor(input: CommerceEventInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the commerce event vocabulary is closed)");
      }
    }
    this.contractVersion = DOMAIN_COMMERCE_CONTRACT_VERSION;
    if (typeof input.eventId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.eventId)) {
      field("eventId", "must be a canonical lowercase UUID");
    }
    this.eventId = input.eventId;
    this.tenantId = parseTenantIdOrField(input.tenantId);
    if (!isCommerceAggregateType(input.aggregateType)) {
      field("aggregateType", "must be product, product_variant, order or subscription");
    }
    this.aggregateType = input.aggregateType;
    if (typeof input.aggregateId !== "string" || input.aggregateId.length === 0 || input.aggregateId.length > 255) {
      field("aggregateId", "must be a non-empty aggregate reference");
    }
    this.aggregateId = input.aggregateId;
    this.aggregateRevision = parsePositiveIntOrField(
      input.aggregateRevision,
      "aggregateRevision",
      "must be a positive integer (the post-transition aggregate revision)",
    ) as Revision;
    this.sequence = parsePositiveIntOrField(
      input.sequence,
      "sequence",
      "must be a positive integer (1-based per-aggregate chain position)",
    );
    if (!isCommerceTransition(input.transition)) {
      field("transition", "must be a member of the closed commerce transition vocabulary");
    }
    this.transition = input.transition;
    if (aggregateTypeOfTransition(input.transition) !== this.aggregateType) {
      field("transition", "the transition does not belong to the stated aggregate type");
    }
    if (input.payload === null || typeof input.payload !== "object" || Array.isArray(input.payload)) {
      field("payload", "must be a JSON object of transition facts");
    }
    this.payload = Object.freeze(structuredClone(input.payload)) as CanonicalJsonValue;
    this.actorId = parseActorIdOrField(input.actorId);
    this.commandId = parseCommandIdOrField(input.commandId);
    this.correlationId = parseCorrelationIdOrField(input.correlationId);
    this.idempotencyKey = parseIdempotencyKeyOrField(input.idempotencyKey);
    this.occurredAt = parseUtcInstantOrField(input.occurredAt);
    Object.freeze(this);
  }

  toRecord(): CommerceEventRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      eventId: this.eventId,
      tenantId: this.tenantId,
      aggregateType: this.aggregateType,
      aggregateId: this.aggregateId,
      aggregateRevision: this.aggregateRevision,
      sequence: this.sequence,
      transition: this.transition,
      payload: this.payload,
      actorId: this.actorId,
      commandId: this.commandId,
      correlationId: this.correlationId,
      idempotencyKey: this.idempotencyKey,
      occurredAt: this.occurredAt,
    });
  }

  static fromRecord(record: CommerceEventRecord): CommerceEvent {
    return new CommerceEvent({
      eventId: record.eventId,
      tenantId: record.tenantId,
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      aggregateRevision: record.aggregateRevision,
      sequence: record.sequence,
      transition: record.transition,
      payload: record.payload,
      actorId: record.actorId,
      commandId: record.commandId,
      correlationId: record.correlationId,
      idempotencyKey: record.idempotencyKey,
      occurredAt: record.occurredAt,
    });
  }
}

/** Validates a stored record's contract version (fail-closed). */
export function assertCommerceEventRecordVersion(record: CommerceEventRecord): void {
  const version = parseContractVersion(record.contractVersion);
  if (!isDomainCommerceRecordVersionCompatible(version)) {
    field("contractVersion", describeDomainCommerceVersionExpectation());
  }
}

// --- shared field parsers (keep error reason COMMERCE_EVENT_INVALID) ------------

function parseTenantIdOrField(value: string): TenantId {
  try {
    return parseTenantId(value);
  } catch {
    field("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'");
  }
}

function parseActorIdOrField(value: string): ActorId {
  try {
    return parseActorId(value);
  } catch {
    field("actorId", "must be a safe actor reference");
  }
}

function parseCommandIdOrField(value: string): CommandId {
  try {
    return parseCommandId(value);
  } catch {
    field("commandId", "must be a canonical lowercase UUID");
  }
}

function parseCorrelationIdOrField(value: string): CorrelationId {
  try {
    return parseCorrelationId(value);
  } catch {
    field("correlationId", "must be a safe correlation reference");
  }
}

function parseIdempotencyKeyOrField(value: string): IdempotencyKey {
  try {
    return parseIdempotencyKey(value);
  } catch {
    field("idempotencyKey", "must be a safe idempotency reference");
  }
}

function parseUtcInstantOrField(value: string): UtcInstant {
  try {
    return parseUtcInstant(value);
  } catch {
    field("occurredAt", "must be a UTC instant with a zone designator");
  }
}

function parsePositiveIntOrField(value: number, label: string, issue: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    field(label, issue);
  }
  return value;
}

/** Revision re-export convenience for event builders. */
export function asRevision(value: number): Revision {
  return parseRevision(value);
}
