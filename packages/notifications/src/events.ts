/**
 * Immutable notifications-domain event records (RL-014).
 *
 * Same discipline as the sibling domain packages: every state transition is
 * an APPEND-ONLY event with the full §5 command correlation, chained per
 * aggregate (sequence = previous + 1). Notification events additionally
 * carry the SOURCE transition identity in their payload - the audit trail
 * proves every notification originated from a durable RoamLink state
 * transition (RL-LOCK-009).
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
  NOTIFICATIONS_CONTRACT_VERSION,
  describeNotificationsVersionExpectation,
  isNotificationsRecordVersionCompatible,
} from "./version.js";

/** The aggregate types that emit notifications-domain events. */
export const NOTIFICATIONS_AGGREGATE_TYPES = ["notification", "support_case"] as const;

export type NotificationsAggregateType = (typeof NOTIFICATIONS_AGGREGATE_TYPES)[number];

export function isNotificationsAggregateType(
  value: unknown,
): value is NotificationsAggregateType {
  return (
    typeof value === "string" &&
    (NOTIFICATIONS_AGGREGATE_TYPES as readonly string[]).includes(value)
  );
}

/** The closed transition vocabulary. */
export const NOTIFICATIONS_EVENT_TRANSITIONS = [
  "notification.created",
  "notification.delivered",
  "notification.failed",
  "notification.read",
  "notification.suppressed",
  "notification.channel_delivery_recorded",
  "support_case.created",
  "support_case.started_progress",
  "support_case.resolved",
  "support_case.closed",
  "support_case.cancelled",
  "support_case.message_added",
  "support_case.related_ref_linked",
] as const;

export type NotificationsEventTransition = (typeof NOTIFICATIONS_EVENT_TRANSITIONS)[number];

export function isNotificationsEventTransition(
  value: unknown,
): value is NotificationsEventTransition {
  return (
    typeof value === "string" &&
    (NOTIFICATIONS_EVENT_TRANSITIONS as readonly string[]).includes(value)
  );
}

/** The aggregate chain a transition belongs to. */
export function aggregateTypeOfNotificationsTransition(
  transition: NotificationsEventTransition,
): NotificationsAggregateType {
  return transition.startsWith("notification.") ? "notification" : "support_case";
}

/** Serialized (plain) form of a notifications-domain event. */
export interface NotificationsEventRecord {
  readonly contractVersion: ContractVersion;
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly aggregateType: NotificationsAggregateType;
  readonly aggregateId: string;
  /** The aggregate revision AFTER the transition (audit anchor). */
  readonly aggregateRevision: Revision;
  /** 1-based position in the per-aggregate event chain. */
  readonly sequence: number;
  readonly transition: NotificationsEventTransition;
  readonly payload: CanonicalJsonValue;
  readonly actorId: ActorId;
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: IdempotencyKey;
  readonly occurredAt: UtcInstant;
}

/** Input accepted by the {@link NotificationsEvent} constructor. */
export interface NotificationsEventInput {
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
  throw new ValidationError(`NotificationsEvent rejected: ${label} - ${issue}`, {
    reason: "NOTIFICATIONS_EVENT_INVALID",
    details: [{ path: label, issue }],
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A validated, deeply frozen notifications-domain event. */
export class NotificationsEvent {
  readonly contractVersion: ContractVersion;
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly aggregateType: NotificationsAggregateType;
  readonly aggregateId: string;
  readonly aggregateRevision: Revision;
  readonly sequence: number;
  readonly transition: NotificationsEventTransition;
  readonly payload: CanonicalJsonValue;
  readonly actorId: ActorId;
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: IdempotencyKey;
  readonly occurredAt: UtcInstant;

  constructor(input: NotificationsEventInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the notifications event vocabulary is closed)");
      }
    }
    this.contractVersion = NOTIFICATIONS_CONTRACT_VERSION;
    if (typeof input.eventId !== "string" || !UUID_PATTERN.test(input.eventId)) {
      field("eventId", "must be a canonical lowercase UUID");
    }
    this.eventId = input.eventId;
    this.tenantId = parseTenantField(input.tenantId);
    if (!isNotificationsAggregateType(input.aggregateType)) {
      field("aggregateType", "must be notification or support_case");
    }
    this.aggregateType = input.aggregateType;
    if (typeof input.aggregateId !== "string" || input.aggregateId.length === 0) {
      field("aggregateId", "must be a non-empty aggregate reference");
    }
    this.aggregateId = input.aggregateId;
    this.aggregateRevision = parsePositiveInt(
      input.aggregateRevision,
      "aggregateRevision",
      "must be a positive integer (the post-transition aggregate revision)",
    ) as Revision;
    this.sequence = parsePositiveInt(
      input.sequence,
      "sequence",
      "must be a positive integer (1-based per-aggregate chain position)",
    );
    if (!isNotificationsEventTransition(input.transition)) {
      field("transition", "must be a member of the closed notifications transition vocabulary");
    }
    this.transition = input.transition;
    if (aggregateTypeOfNotificationsTransition(input.transition) !== this.aggregateType) {
      field("transition", "the transition does not belong to the stated aggregate type");
    }
    if (input.payload === null || typeof input.payload !== "object" || Array.isArray(input.payload)) {
      field("payload", "must be a JSON object of transition facts");
    }
    this.payload = Object.freeze(structuredClone(input.payload)) as CanonicalJsonValue;
    this.actorId = parseActorField(input.actorId);
    this.commandId = parseCommandField(input.commandId);
    this.correlationId = parseCorrelationField(input.correlationId);
    this.idempotencyKey = parseIdempotencyField(input.idempotencyKey);
    this.occurredAt = parseInstantField(input.occurredAt, "occurredAt");
    Object.freeze(this);
  }

  toRecord(): NotificationsEventRecord {
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

  static fromRecord(record: NotificationsEventRecord): NotificationsEvent {
    return new NotificationsEvent({
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

/** Validates a stored event record's contract version (fail-closed). */
export function assertNotificationsEventRecordVersion(record: NotificationsEventRecord): void {
  if (!isNotificationsRecordVersionCompatible(parseContractVersion(record.contractVersion))) {
    field("contractVersion", describeNotificationsVersionExpectation());
  }
}

// --- shared field parsers ------------------------------------------------------

function parseTenantField(value: string): TenantId {
  try {
    return parseTenantId(value);
  } catch {
    field("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'");
  }
}

function parseActorField(value: string): ActorId {
  try {
    return parseActorId(value);
  } catch {
    field("actorId", "must be a safe actor reference");
  }
}

function parseCommandField(value: string): CommandId {
  try {
    return parseCommandId(value);
  } catch {
    field("commandId", "must be a canonical lowercase UUID");
  }
}

function parseCorrelationField(value: string): CorrelationId {
  try {
    return parseCorrelationId(value);
  } catch {
    field("correlationId", "must be a safe correlation reference");
  }
}

function parseIdempotencyField(value: string): IdempotencyKey {
  try {
    return parseIdempotencyKey(value);
  } catch {
    field("idempotencyKey", "must be a safe idempotency reference");
  }
}

function parseInstantField(value: string, label: string): UtcInstant {
  try {
    return parseUtcInstant(value);
  } catch {
    field(label, "must be a UTC instant with a zone designator");
  }
}

function parsePositiveInt(value: number, label: string, issue: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    field(label, issue);
  }
  return value;
}

/** Revision re-export convenience for event builders. */
export function asNotificationsRevision(value: number): Revision {
  return parseRevision(value);
}
