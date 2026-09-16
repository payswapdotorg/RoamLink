/**
 * Immutable connectivity-reference event records (RL-023).
 *
 * Same discipline as the commerce event log: every reference transition is
 * an APPEND-ONLY event with the full §5 command correlation, chained per
 * aggregate (`sequence` must be exactly previous + 1). Relinking evidence
 * appends a NEW event carrying the new snapshot AND the previous
 * snapshot's digest - the full observation history of a subject stays
 * auditable forever (RL-LOCK-010 provenance).
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
  COMMERCE_CONNECTIVITY_CONTRACT_VERSION,
  describeCommerceConnectivityVersionExpectation,
  isCommerceConnectivityRecordVersionCompatible,
} from "./version.js";

/** The closed EVENT transition vocabulary of the reference aggregate. */
export const CONNECTIVITY_REFERENCE_EVENT_TRANSITIONS = [
  "connectivity_reference.created",
  "connectivity_reference.evidence_linked",
  "connectivity_reference.retired",
] as const;

export type ConnectivityReferenceEventTransition =
  (typeof CONNECTIVITY_REFERENCE_EVENT_TRANSITIONS)[number];

export function isConnectivityReferenceEventTransition(
  value: unknown,
): value is ConnectivityReferenceEventTransition {
  return (
    typeof value === "string" &&
    (CONNECTIVITY_REFERENCE_EVENT_TRANSITIONS as readonly string[]).includes(value)
  );
}

/** Serialized (plain) form of a reference event. */
export interface ConnectivityReferenceEventRecord {
  readonly contractVersion: ContractVersion;
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly aggregateType: "connectivity_reference";
  readonly aggregateId: string;
  /** The aggregate revision AFTER the transition (audit anchor). */
  readonly aggregateRevision: Revision;
  /** 1-based position in the per-aggregate event chain. */
  readonly sequence: number;
  readonly transition: ConnectivityReferenceEventTransition;
  readonly payload: CanonicalJsonValue;
  readonly actorId: ActorId;
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: IdempotencyKey;
  readonly occurredAt: UtcInstant;
}

/** Input accepted by the {@link ConnectivityReferenceEvent} constructor. */
export interface ConnectivityReferenceEventInput {
  readonly eventId: string;
  readonly tenantId: string;
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
  throw new ValidationError(`ConnectivityReferenceEvent rejected: ${label} - ${issue}`, {
    reason: "CONNECTIVITY_REFERENCE_EVENT_INVALID",
    details: [{ path: label, issue }],
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A validated, deeply frozen reference event. */
export class ConnectivityReferenceEvent {
  readonly contractVersion: ContractVersion;
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly aggregateType = "connectivity_reference" as const;
  readonly aggregateId: string;
  readonly aggregateRevision: Revision;
  readonly sequence: number;
  readonly transition: ConnectivityReferenceEventTransition;
  readonly payload: CanonicalJsonValue;
  readonly actorId: ActorId;
  readonly commandId: CommandId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: IdempotencyKey;
  readonly occurredAt: UtcInstant;

  constructor(input: ConnectivityReferenceEventInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the reference event vocabulary is closed)");
      }
    }
    this.contractVersion = COMMERCE_CONNECTIVITY_CONTRACT_VERSION;
    if (typeof input.eventId !== "string" || !UUID_PATTERN.test(input.eventId)) {
      field("eventId", "must be a canonical lowercase UUID");
    }
    this.eventId = input.eventId;
    this.tenantId = parseTenantField(input.tenantId);
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
    if (!isConnectivityReferenceEventTransition(input.transition)) {
      field("transition", "must be a member of the closed reference transition vocabulary");
    }
    this.transition = input.transition;
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

  toRecord(): ConnectivityReferenceEventRecord {
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

  static fromRecord(record: ConnectivityReferenceEventRecord): ConnectivityReferenceEvent {
    return new ConnectivityReferenceEvent({
      eventId: record.eventId,
      tenantId: record.tenantId,
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
export function assertConnectivityReferenceEventRecordVersion(
  record: ConnectivityReferenceEventRecord,
): void {
  if (
    !isCommerceConnectivityRecordVersionCompatible(parseContractVersion(record.contractVersion))
  ) {
    field("contractVersion", describeCommerceConnectivityVersionExpectation());
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
export function asReferenceRevision(value: number): Revision {
  return parseRevision(value);
}
