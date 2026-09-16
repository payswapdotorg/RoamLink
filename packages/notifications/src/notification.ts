/**
 * The Notification aggregate (RL-014, RL-LOCK-009 "webhooks are signals,
 * not truth").
 *
 * A Notification is emitted ONLY from RoamLink's OWN durable state
 * transitions - never directly from an unverified ADCOS event payload. The
 * record ENFORCES this structurally: its `source` is a
 * {@link TransitionOrigin} whose closed, single-member `origin` vocabulary
 * ("roamlink_state_transition"), closed RoamLink aggregate-type vocabulary
 * and REQUIRED durable `eventId` leave no room for a raw external payload
 * to masquerade as a source. The composition layer reads RoamLink's event
 * logs (commerce/experience/support) and calls the service with transition
 * facts; ADCOS-derived state reaches notifications only AFTER it has been
 * durably projected by RoamLink (and even then only as REFERENCES with
 * freshness, never as raw payloads).
 *
 * `notification_state` is its own closed vocabulary (pending, delivered,
 * failed, read, suppressed) - separate from every commerce/connectivity
 * state vocabulary (spec/data-model.md "State separation").
 *
 * State machine (validated transitions only; failed/read/suppressed are
 * terminal, delivered is terminal except for read):
 *
 *   pending ──deliver──> delivered ──markRead──> read
 *      │────────────────────────────markRead──────────> read
 *      ├──fail──> failed (terminal)
 *      └──suppress──> suppressed (terminal; preference-filtered)
 */
import {
  ValidationError,
  parseNotificationId,
  parseTenantId,
  parseUtcInstant,
  parseUserId,
  type ContractVersion,
  type NotificationId,
  type Revision,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";

import {
  NOTIFICATIONS_CONTRACT_VERSION,
  describeNotificationsVersionExpectation,
  isNotificationsRecordVersionCompatible,
} from "./version.js";

/** The closed notification-topic vocabulary. */
export const NOTIFICATION_TOPICS = [
  "order",
  "payment",
  "invoice",
  "refund",
  "subscription",
  "connectivity",
  "support",
  "system",
] as const;

export type NotificationTopic = (typeof NOTIFICATION_TOPICS)[number];

export function isNotificationTopic(value: unknown): value is NotificationTopic {
  return (
    typeof value === "string" && (NOTIFICATION_TOPICS as readonly string[]).includes(value)
  );
}

/** The closed severity vocabulary. */
export const NOTIFICATION_SEVERITIES = ["info", "warning", "critical"] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export function isNotificationSeverity(value: unknown): value is NotificationSeverity {
  return (
    typeof value === "string" && (NOTIFICATION_SEVERITIES as readonly string[]).includes(value)
  );
}

/**
 * The CLOSED `notification_state` vocabulary. Separate from every
 * commerce/connectivity state family by name and usage.
 */
export const NOTIFICATION_STATES = [
  "pending",
  "delivered",
  "failed",
  "read",
  "suppressed",
] as const;

export type NotificationState = (typeof NOTIFICATION_STATES)[number];

export function isNotificationState(value: unknown): value is NotificationState {
  return typeof value === "string" && (NOTIFICATION_STATES as readonly string[]).includes(value);
}

/** The typed, explicit notification transitions. */
export const NOTIFICATION_TRANSITIONS = ["deliver", "fail", "markRead", "suppress"] as const;

export type NotificationTransition = (typeof NOTIFICATION_TRANSITIONS)[number];

/**
 * The closed RoamLink aggregate-type vocabulary that may originate a
 * notification. Deliberately contains ONLY RoamLink-owned aggregates: an
 * ADCOS resource type can never appear here (RL-LOCK-009 - a raw ADCOS
 * event can never be a notification source).
 */
export const NOTIFICATION_SOURCE_AGGREGATE_TYPES = [
  "order",
  "subscription",
  "customer_payment",
  "customer_invoice",
  "customer_refund",
  "experience_intent",
  "device",
  "connectivity_reference",
  "support_case",
] as const;

export type NotificationSourceAggregateType =
  (typeof NOTIFICATION_SOURCE_AGGREGATE_TYPES)[number];

export function isNotificationSourceAggregateType(
  value: unknown,
): value is NotificationSourceAggregateType {
  return (
    typeof value === "string" &&
    (NOTIFICATION_SOURCE_AGGREGATE_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The single-member, closed origin vocabulary: notifications originate
 * ONLY from RoamLink durable state transitions. This constant exists so
 * the type system and reviewers can point at the invariant.
 */
export const NOTIFICATION_ORIGIN = "roamlink_state_transition" as const;

/** The provenance of a notification: WHICH durable transition caused it. */
export interface TransitionOrigin {
  /** Always "roamlink_state_transition" (closed single-member vocabulary). */
  readonly origin: typeof NOTIFICATION_ORIGIN;
  readonly aggregateType: NotificationSourceAggregateType;
  readonly aggregateId: string;
  /** The durable RoamLink transition name (e.g. "order.placed"). */
  readonly transition: string;
  /**
   * The durable RoamLink event id that recorded the transition - the
   * receipt proving the transition was PERSISTED before the notification
   * was emitted (RL-LOCK-009).
   */
  readonly eventId: string;
  readonly occurredAt: UtcInstant;
}

/** The typed related-reference kinds (event correlation, RL-014). */
export const NOTIFICATION_RELATED_REF_KINDS = [
  "order",
  "subscription",
  "payment",
  "invoice",
  "refund",
  "connectivity_reference",
  "experience_intent",
  "support_case",
] as const;

export type NotificationRelatedRefKind = (typeof NOTIFICATION_RELATED_REF_KINDS)[number];

export function isNotificationRelatedRefKind(
  value: unknown,
): value is NotificationRelatedRefKind {
  return (
    typeof value === "string" &&
    (NOTIFICATION_RELATED_REF_KINDS as readonly string[]).includes(value)
  );
}

/** One typed correlation reference on a notification. */
export interface NotificationRelatedRef {
  readonly kind: NotificationRelatedRefKind;
  readonly id: string;
}

export const MAX_TITLE_LENGTH = 120;
export const MAX_BODY_LENGTH = 2_000;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose of this pattern
const PRINTABLE_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

/** Serialized (plain) form of a notification. */
export interface NotificationRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly notificationId: NotificationId;
  readonly recipientUserId: UserId;
  readonly topic: NotificationTopic;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  readonly status: NotificationState;
  readonly source: TransitionOrigin;
  readonly relatedRefs: readonly NotificationRelatedRef[];
  readonly deliveredAt?: UtcInstant;
  readonly readAt?: UtcInstant;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link Notification} constructor. */
export interface NotificationInput {
  readonly notificationId: string;
  readonly tenantId: string;
  readonly recipientUserId: string;
  readonly topic: string;
  readonly severity: string;
  readonly title: string;
  readonly body: string;
  readonly status: string;
  readonly source: unknown;
  readonly relatedRefs?: unknown;
  readonly deliveredAt?: string;
  readonly readAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "notificationId",
  "tenantId",
  "recipientUserId",
  "topic",
  "severity",
  "title",
  "body",
  "status",
  "source",
  "relatedRefs",
  "deliveredAt",
  "readAt",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`Notification rejected: ${label} - ${issue}`, {
    reason: "NOTIFICATION_INVALID",
    details: [{ path: label, issue }],
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSITION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** Validates a transition-origin object (closed vocabulary, RL-LOCK-009). */
export function parseTransitionOrigin(value: unknown): TransitionOrigin {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("source", "must be a TransitionOrigin object (notifications originate ONLY from RoamLink durable state transitions, never from raw ADCOS payloads)");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["origin", "aggregateType", "aggregateId", "transition", "eventId", "occurredAt"].includes(key)) {
      field(`source.${key}`, "unknown field (the transition-origin vocabulary is closed; an ADCOS payload has no shape that fits here, RL-LOCK-009)");
    }
  }
  if (record["origin"] !== NOTIFICATION_ORIGIN) {
    field("source.origin", `must be '${NOTIFICATION_ORIGIN}' (the single-member closed vocabulary: a webhook/ADCOS payload is a SIGNAL, never a notification source)`);
  }
  if (!isNotificationSourceAggregateType(record["aggregateType"])) {
    field("source.aggregateType", "must be a member of the closed RoamLink aggregate-type vocabulary");
  }
  if (typeof record["aggregateId"] !== "string" || !UUID_PATTERN.test(record["aggregateId"])) {
    field("source.aggregateId", "must be a canonical lowercase UUID (the transitioning RoamLink aggregate)");
  }
  if (
    typeof record["transition"] !== "string" ||
    !TRANSITION_PATTERN.test(record["transition"]) ||
    record["transition"].length > 120
  ) {
    field("source.transition", "must be the durable RoamLink transition name (dotted lowercase tokens)");
  }
  if (typeof record["eventId"] !== "string" || !UUID_PATTERN.test(record["eventId"])) {
    field("source.eventId", "must be the durable RoamLink event id proving the transition was persisted (RL-LOCK-009 - no receipt, no notification)");
  }
  let occurredAt: UtcInstant;
  try {
    occurredAt = parseUtcInstant(record["occurredAt"]);
  } catch {
    field("source.occurredAt", "must be a UTC instant with a zone designator");
  }
  return Object.freeze({
    origin: NOTIFICATION_ORIGIN,
    aggregateType: record["aggregateType"] as NotificationSourceAggregateType,
    aggregateId: record["aggregateId"] as string,
    transition: record["transition"] as string,
    eventId: record["eventId"] as string,
    occurredAt,
  });
}

/** Validates the typed related-reference list. */
export function parseRelatedRefs(value: unknown): readonly NotificationRelatedRef[] {
  if (!Array.isArray(value)) {
    field("relatedRefs", "must be an array of typed related references");
  }
  const out: NotificationRelatedRef[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      field("relatedRefs[]", "must be an object with kind + id");
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!["kind", "id"].includes(key)) {
        field(`relatedRefs[].${key}`, "unknown field (the related-reference vocabulary is closed)");
      }
    }
    if (!isNotificationRelatedRefKind(record["kind"])) {
      field("relatedRefs[].kind", "must be a member of the closed related-reference kind vocabulary");
    }
    if (typeof record["id"] !== "string" || !UUID_PATTERN.test(record["id"])) {
      field("relatedRefs[].id", "must be a canonical lowercase UUID");
    }
    out.push(Object.freeze({ kind: record["kind"] as NotificationRelatedRefKind, id: record["id"] as string }));
  }
  return Object.freeze(out);
}

/**
 * The Notification aggregate. Frozen deeply; transitions return new
 * instances with the revision bumped (RL-LOCK-017).
 */
export class Notification {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly notificationId: NotificationId;
  readonly recipientUserId: UserId;
  readonly topic: NotificationTopic;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  readonly status: NotificationState;
  readonly source: TransitionOrigin;
  readonly relatedRefs: readonly NotificationRelatedRef[];
  declare readonly deliveredAt?: UtcInstant;
  declare readonly readAt?: UtcInstant;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: NotificationInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the notification vocabulary is closed)");
      }
    }
    this.contractVersion = NOTIFICATIONS_CONTRACT_VERSION;
    this.notificationId = parseNotificationIdField(input.notificationId);
    this.tenantId = parseTenantField(input.tenantId);
    this.recipientUserId = parseUserField(input.recipientUserId);
    if (!isNotificationTopic(input.topic)) {
      field("topic", "must be a member of the closed notification-topic vocabulary");
    }
    this.topic = input.topic;
    if (!isNotificationSeverity(input.severity)) {
      field("severity", "must be info, warning or critical");
    }
    this.severity = input.severity;
    if (
      typeof input.title !== "string" ||
      !PRINTABLE_PATTERN.test(input.title) ||
      input.title.length === 0 ||
      input.title.length > MAX_TITLE_LENGTH
    ) {
      field("title", `must be printable text of 1..${MAX_TITLE_LENGTH} characters`);
    }
    this.title = input.title;
    if (
      typeof input.body !== "string" ||
      !PRINTABLE_PATTERN.test(input.body) ||
      input.body.length === 0 ||
      input.body.length > MAX_BODY_LENGTH
    ) {
      field("body", `must be printable text of 1..${MAX_BODY_LENGTH} characters`);
    }
    this.body = input.body;
    if (!isNotificationState(input.status)) {
      field("status", "must be pending, delivered, failed, read or suppressed (the notification_state vocabulary is closed and separate from commerce/connectivity states)");
    }
    this.status = input.status;
    this.source = parseTransitionOrigin(input.source);
    this.relatedRefs = parseRelatedRefs(input.relatedRefs ?? []);
    if (input.deliveredAt !== undefined) {
      this.deliveredAt = parseInstantField(input.deliveredAt, "deliveredAt");
    }
    if (input.readAt !== undefined) {
      this.readAt = parseInstantField(input.readAt, "readAt");
    }
    if (this.status === "delivered" && this.deliveredAt === undefined) {
      field("deliveredAt", "a delivered notification must record its delivery instant");
    }
    if (this.status === "read" && this.readAt === undefined) {
      field("readAt", "a read notification must record its read instant");
    }
    this.createdAt = parseInstantField(input.createdAt, "createdAt");
    this.updatedAt = parseInstantField(input.updatedAt, "updatedAt");
    if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 1) {
      field("revision", "must be a positive integer (optimistic-concurrency token)");
    }
    this.revision = input.revision as Revision;
    Object.freeze(this);
  }

  /** pending -> delivered (first successful channel delivery). */
  deliver(at: UtcInstant): Notification {
    if (this.status !== "pending") {
      field("status", "only a pending notification can be delivered (failed, read and suppressed are terminal; a delivered notification cannot be re-delivered)");
    }
    return this.with({ status: "delivered", deliveredAt: at, updatedAt: at });
  }

  /** pending -> failed (every effective channel failed). */
  fail(at: UtcInstant): Notification {
    if (this.status !== "pending") {
      field("status", "only a pending notification can fail (failed, read and suppressed are terminal)");
    }
    return this.with({ status: "failed", updatedAt: at });
  }

  /** pending|delivered -> read (customer read receipt). */
  markRead(at: UtcInstant): Notification {
    if (this.status !== "pending" && this.status !== "delivered") {
      field("status", "only a pending or delivered notification can be marked read");
    }
    return this.with({ status: "read", readAt: at, updatedAt: at });
  }

  /** pending -> suppressed (preference-filtered before any delivery). */
  suppress(at: UtcInstant): Notification {
    if (this.status !== "pending") {
      field("status", "only a pending notification can be suppressed (delivery already happened; suppression is a pre-delivery state)");
    }
    return this.with({ status: "suppressed", updatedAt: at });
  }

  /** The next notification state after a typed transition (read-side helper). */
  static transitionFrom(
    status: NotificationState,
    transition: NotificationTransition,
  ): NotificationState {
    switch (transition) {
      case "deliver":
        return status === "pending" ? "delivered" : field("status", "only a pending notification can be delivered");
      case "fail":
        return status === "pending" ? "failed" : field("status", "only a pending notification can fail");
      case "markRead":
        return status === "pending" || status === "delivered"
          ? "read"
          : field("status", "only a pending or delivered notification can be marked read");
      case "suppress":
        return status === "pending" ? "suppressed" : field("status", "only a pending notification can be suppressed");
    }
  }

  private with(overrides: {
    status?: NotificationState;
    deliveredAt?: UtcInstant;
    readAt?: UtcInstant;
    updatedAt?: UtcInstant;
  }): Notification {
    return new Notification({
      notificationId: this.notificationId,
      tenantId: this.tenantId,
      recipientUserId: this.recipientUserId,
      topic: this.topic,
      severity: this.severity,
      title: this.title,
      body: this.body,
      status: overrides.status ?? this.status,
      source: this.source,
      relatedRefs: this.relatedRefs,
      ...(overrides.deliveredAt !== undefined
        ? { deliveredAt: overrides.deliveredAt }
        : this.deliveredAt !== undefined
          ? { deliveredAt: this.deliveredAt }
          : {}),
      ...(overrides.readAt !== undefined
        ? { readAt: overrides.readAt }
        : this.readAt !== undefined
          ? { readAt: this.readAt }
          : {}),
      createdAt: this.createdAt,
      updatedAt: overrides.updatedAt ?? this.updatedAt,
      revision: this.revision + 1,
    });
  }

  toRecord(): NotificationRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      notificationId: this.notificationId,
      recipientUserId: this.recipientUserId,
      topic: this.topic,
      severity: this.severity,
      title: this.title,
      body: this.body,
      status: this.status,
      source: this.source,
      relatedRefs: this.relatedRefs,
      ...(this.deliveredAt !== undefined ? { deliveredAt: this.deliveredAt } : {}),
      ...(this.readAt !== undefined ? { readAt: this.readAt } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: NotificationRecord): Notification {
    return new Notification({
      notificationId: record.notificationId,
      tenantId: record.tenantId,
      recipientUserId: record.recipientUserId,
      topic: record.topic,
      severity: record.severity,
      title: record.title,
      body: record.body,
      status: record.status,
      source: record.source,
      relatedRefs: record.relatedRefs,
      ...(record.deliveredAt !== undefined ? { deliveredAt: record.deliveredAt } : {}),
      ...(record.readAt !== undefined ? { readAt: record.readAt } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}

/** Validates a stored notification record's contract version (fail-closed). */
export function assertNotificationRecordVersion(record: NotificationRecord): void {
  if (!isNotificationsRecordVersionCompatible(record.contractVersion)) {
    field("contractVersion", describeNotificationsVersionExpectation());
  }
}

// --- shared field parsers (keep error reason NOTIFICATION_INVALID) -------------

function parseNotificationIdField(value: string): NotificationId {
  try {
    return parseNotificationId(value);
  } catch {
    field("notificationId", "must be a canonical lowercase UUID");
  }
}

function parseTenantField(value: string): TenantId {
  try {
    return parseTenantId(value);
  } catch {
    field("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'");
  }
}

function parseUserField(value: string): UserId {
  try {
    return parseUserId(value);
  } catch {
    field("recipientUserId", "must be a canonical lowercase UUID (the notified customer)");
  }
}

function parseInstantField(value: string, label: string): UtcInstant {
  try {
    return parseUtcInstant(value);
  } catch {
    field(label, "must be a UTC instant with a zone designator");
  }
}
