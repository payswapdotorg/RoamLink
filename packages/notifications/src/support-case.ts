/**
 * The SupportCase aggregate + case messages (RL-014, "support cases
 * (customer/support-staff visibility boundary)").
 *
 * A SupportCase is the customer-facing support ticket with typed event
 * correlation (`relatedRefs`: orders / subscriptions / payments / invoices /
 * refunds / connectivity references / experience intents), a closed
 * priority vocabulary and its OWN `support_case_state` vocabulary - never
 * merged with commerce or connectivity states (spec/data-model.md "State
 * separation").
 *
 * THE VISIBILITY BOUNDARY: every case message is either `customer` (visible
 * to the requesting customer AND support staff) or `internal` (support
 * staff only - NEVER exposed through customer-facing reads). The boundary
 * is structural: the customer-facing read API
 * ({@link caseMessagesCustomerView}) drops internal messages BY
 * CONSTRUCTION, and the service gates writing internal messages behind
 * the `support_case:internal` policy action.
 *
 * State machine (validated transitions only; closed, cancelled terminal;
 * resolved terminal except close):
 *
 *   open ──startProgress──> in_progress
 *     │          │
 *     │          ├──resolve──> resolved ──close──> closed
 *     ├──resolve─┘
 *     ├──cancel────────────────> cancelled
 *     └──(in_progress)─cancel──> cancelled
 */
import {
  ValidationError,
  parseActorId,
  parseTenantId,
  parseUserId,
  parseUtcInstant,
  type ActorId,
  type ContractVersion,
  type Revision,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";

import { parseSupportCaseId, parseSupportCaseMessageId, type SupportCaseId, type SupportCaseMessageId } from "./ids.js";
import {
  NOTIFICATIONS_CONTRACT_VERSION,
  describeNotificationsVersionExpectation,
  isNotificationsRecordVersionCompatible,
} from "./version.js";

/**
 * The CLOSED `support_case_state` vocabulary. Separate from every
 * commerce/connectivity state family.
 */
export const SUPPORT_CASE_STATES = [
  "open",
  "in_progress",
  "resolved",
  "closed",
  "cancelled",
] as const;

export type SupportCaseState = (typeof SUPPORT_CASE_STATES)[number];

export function isSupportCaseState(value: unknown): value is SupportCaseState {
  return typeof value === "string" && (SUPPORT_CASE_STATES as readonly string[]).includes(value);
}

/** The closed case-priority vocabulary. */
export const SUPPORT_CASE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export type SupportCasePriority = (typeof SUPPORT_CASE_PRIORITIES)[number];

export function isSupportCasePriority(value: unknown): value is SupportCasePriority {
  return (
    typeof value === "string" && (SUPPORT_CASE_PRIORITIES as readonly string[]).includes(value)
  );
}

/**
 * The typed related-reference kinds on a support case (event correlation).
 *
 * CLOSED vocabulary, additive-change tolerant (RL-LOCK-017): the customer
 * UX spec (spec/ux-architecture.md §11) asks a support case to carry the
 * DEVICE and the relevant ACTIVITY (notification) records, so `device` and
 * `notification` were appended after the original commerce/connectivity
 * kinds. Existing kinds are untouched and keep their positions; consumers
 * must treat unknown kinds as unsupported, never as errors to crash on.
 */
export const SUPPORT_CASE_RELATED_REF_KINDS = [
  "order",
  "subscription",
  "payment",
  "invoice",
  "refund",
  "connectivity_reference",
  "experience_intent",
  "device",
  "notification",
] as const;

export type SupportCaseRelatedRefKind = (typeof SUPPORT_CASE_RELATED_REF_KINDS)[number];

export function isSupportCaseRelatedRefKind(
  value: unknown,
): value is SupportCaseRelatedRefKind {
  return (
    typeof value === "string" &&
    (SUPPORT_CASE_RELATED_REF_KINDS as readonly string[]).includes(value)
  );
}

/** One typed correlation reference on a support case. */
export interface SupportCaseRelatedRef {
  readonly kind: SupportCaseRelatedRefKind;
  readonly id: string;
}

/** The typed, explicit case transitions. */
export const SUPPORT_CASE_TRANSITIONS = [
  "startProgress",
  "resolve",
  "close",
  "cancel",
] as const;

export type SupportCaseTransition = (typeof SUPPORT_CASE_TRANSITIONS)[number];

export const MAX_CASE_SUBJECT_LENGTH = 160;
export const MAX_CASE_DESCRIPTION_LENGTH = 4_000;
export const MAX_MESSAGE_BODY_LENGTH = 4_000;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose of this pattern
const PRINTABLE_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

/** Serialized (plain) form of a support case. */
export interface SupportCaseRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly supportCaseId: SupportCaseId;
  readonly requesterUserId: UserId;
  readonly subject: string;
  readonly description?: string;
  readonly priority: SupportCasePriority;
  readonly status: SupportCaseState;
  /** Support-staff assignee, when one is assigned. */
  readonly assigneeActorId?: ActorId;
  readonly relatedRefs: readonly SupportCaseRelatedRef[];
  readonly resolvedAt?: UtcInstant;
  readonly closedAt?: UtcInstant;
  readonly cancelledAt?: UtcInstant;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link SupportCase} constructor. */
export interface SupportCaseInput {
  readonly supportCaseId: string;
  readonly tenantId: string;
  readonly requesterUserId: string;
  readonly subject: string;
  readonly description?: string;
  readonly priority: string;
  readonly status: string;
  readonly assigneeActorId?: string;
  readonly relatedRefs?: unknown;
  readonly resolvedAt?: string;
  readonly closedAt?: string;
  readonly cancelledAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "supportCaseId",
  "tenantId",
  "requesterUserId",
  "subject",
  "description",
  "priority",
  "status",
  "assigneeActorId",
  "relatedRefs",
  "resolvedAt",
  "closedAt",
  "cancelledAt",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`SupportCase rejected: ${label} - ${issue}`, {
    reason: "SUPPORT_CASE_INVALID",
    details: [{ path: label, issue }],
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validates the typed related-reference list. */
export function parseSupportCaseRelatedRefs(value: unknown): readonly SupportCaseRelatedRef[] {
  if (!Array.isArray(value)) {
    field("relatedRefs", "must be an array of typed related references");
  }
  const out: SupportCaseRelatedRef[] = [];
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
    if (!isSupportCaseRelatedRefKind(record["kind"])) {
      field("relatedRefs[].kind", "must be a member of the closed related-reference kind vocabulary");
    }
    if (typeof record["id"] !== "string" || !UUID_PATTERN.test(record["id"])) {
      field("relatedRefs[].id", "must be a canonical lowercase UUID");
    }
    if (out.some((existing) => existing.kind === record["kind"] && existing.id === record["id"])) {
      field("relatedRefs[]", "duplicated related reference");
    }
    out.push(
      Object.freeze({ kind: record["kind"] as SupportCaseRelatedRefKind, id: record["id"] as string }),
    );
  }
  return Object.freeze(out);
}

/** The SupportCase aggregate. Frozen deeply; transitions bump the revision. */
export class SupportCase {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly supportCaseId: SupportCaseId;
  readonly requesterUserId: UserId;
  readonly subject: string;
  declare readonly description?: string;
  readonly priority: SupportCasePriority;
  readonly status: SupportCaseState;
  declare readonly assigneeActorId?: ActorId;
  readonly relatedRefs: readonly SupportCaseRelatedRef[];
  declare readonly resolvedAt?: UtcInstant;
  declare readonly closedAt?: UtcInstant;
  declare readonly cancelledAt?: UtcInstant;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: SupportCaseInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the support-case vocabulary is closed)");
      }
    }
    this.contractVersion = NOTIFICATIONS_CONTRACT_VERSION;
    this.supportCaseId = parseCaseIdField(input.supportCaseId);
    this.tenantId = parseTenantField(input.tenantId);
    this.requesterUserId = parseUserField(input.requesterUserId);
    if (
      typeof input.subject !== "string" ||
      !PRINTABLE_PATTERN.test(input.subject) ||
      input.subject.length === 0 ||
      input.subject.length > MAX_CASE_SUBJECT_LENGTH
    ) {
      field("subject", `must be printable text of 1..${MAX_CASE_SUBJECT_LENGTH} characters`);
    }
    this.subject = input.subject;
    if (input.description !== undefined) {
      if (
        typeof input.description !== "string" ||
        !PRINTABLE_PATTERN.test(input.description) ||
        input.description.length > MAX_CASE_DESCRIPTION_LENGTH
      ) {
        field("description", `must be printable text of at most ${MAX_CASE_DESCRIPTION_LENGTH} characters`);
      }
      this.description = input.description;
    }
    if (!isSupportCasePriority(input.priority)) {
      field("priority", "must be low, normal, high or urgent");
    }
    this.priority = input.priority;
    if (!isSupportCaseState(input.status)) {
      field("status", "must be open, in_progress, resolved, closed or cancelled (the support_case_state vocabulary is closed and separate from commerce/connectivity states)");
    }
    this.status = input.status;
    if (input.assigneeActorId !== undefined) {
      this.assigneeActorId = parseActorField(input.assigneeActorId, "assigneeActorId");
    }
    this.relatedRefs = parseSupportCaseRelatedRefs(input.relatedRefs ?? []);
    if (input.resolvedAt !== undefined) {
      this.resolvedAt = parseInstantField(input.resolvedAt, "resolvedAt");
    }
    if (input.closedAt !== undefined) {
      this.closedAt = parseInstantField(input.closedAt, "closedAt");
    }
    if (input.cancelledAt !== undefined) {
      this.cancelledAt = parseInstantField(input.cancelledAt, "cancelledAt");
    }
    if (this.status === "resolved" && this.resolvedAt === undefined) {
      field("resolvedAt", "a resolved case must record its resolution instant");
    }
    if (this.status === "closed" && this.closedAt === undefined) {
      field("closedAt", "a closed case must record its closing instant");
    }
    if (this.status === "cancelled" && this.cancelledAt === undefined) {
      field("cancelledAt", "a cancelled case must record its cancellation instant");
    }
    this.createdAt = parseInstantField(input.createdAt, "createdAt");
    this.updatedAt = parseInstantField(input.updatedAt, "updatedAt");
    if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 1) {
      field("revision", "must be a positive integer (optimistic-concurrency token)");
    }
    this.revision = input.revision as Revision;
    Object.freeze(this);
  }

  /** open -> in_progress (a support agent started working the case). */
  startProgress(at: UtcInstant, assigneeActorId?: ActorId): SupportCase {
    if (this.status !== "open") {
      field("status", "only an open case can move to in_progress");
    }
    return this.with({ status: "in_progress", updatedAt: at, ...(assigneeActorId !== undefined ? { assigneeActorId } : {}) });
  }

  /** open|in_progress -> resolved (terminal except close). */
  resolve(at: UtcInstant): SupportCase {
    if (this.status !== "open" && this.status !== "in_progress") {
      field("status", "only an open or in_progress case can be resolved");
    }
    return this.with({ status: "resolved", resolvedAt: at, updatedAt: at });
  }

  /** resolved -> closed (terminal). */
  close(at: UtcInstant): SupportCase {
    if (this.status !== "resolved") {
      field("status", "only a resolved case can be closed (close certifies the resolution)");
    }
    return this.with({ status: "closed", closedAt: at, updatedAt: at });
  }

  /** open|in_progress -> cancelled (terminal, requester withdrew). */
  cancel(at: UtcInstant): SupportCase {
    if (this.status !== "open" && this.status !== "in_progress") {
      field("status", "only an open or in_progress case can be cancelled");
    }
    return this.with({ status: "cancelled", cancelledAt: at, updatedAt: at });
  }

  /** Links an additional typed related reference (correlation). */
  linkRelatedRef(ref: SupportCaseRelatedRef, at: UtcInstant): SupportCase {
    if (this.status === "closed" || this.status === "cancelled") {
      field("status", "a closed or cancelled case no longer gains correlation references");
    }
    if (this.relatedRefs.some((existing) => existing.kind === ref.kind && existing.id === ref.id)) {
      field("relatedRefs", "the related reference is already linked");
    }
    return this.with({
      relatedRefs: Object.freeze([...this.relatedRefs, Object.freeze({ ...ref })]),
      updatedAt: at,
    });
  }

  /** The next case state after a typed transition (read-side helper). */
  static transitionFrom(status: SupportCaseState, transition: SupportCaseTransition): SupportCaseState {
    switch (transition) {
      case "startProgress":
        return status === "open" ? "in_progress" : field("status", "only an open case can move to in_progress");
      case "resolve":
        return status === "open" || status === "in_progress"
          ? "resolved"
          : field("status", "only an open or in_progress case can be resolved");
      case "close":
        return status === "resolved" ? "closed" : field("status", "only a resolved case can be closed");
      case "cancel":
        return status === "open" || status === "in_progress"
          ? "cancelled"
          : field("status", "only an open or in_progress case can be cancelled");
    }
  }

  private with(overrides: {
    status?: SupportCaseState;
    assigneeActorId?: ActorId;
    relatedRefs?: readonly SupportCaseRelatedRef[];
    resolvedAt?: UtcInstant;
    closedAt?: UtcInstant;
    cancelledAt?: UtcInstant;
    updatedAt?: UtcInstant;
  }): SupportCase {
    return new SupportCase({
      supportCaseId: this.supportCaseId,
      tenantId: this.tenantId,
      requesterUserId: this.requesterUserId,
      subject: this.subject,
      ...(this.description !== undefined ? { description: this.description } : {}),
      priority: this.priority,
      status: overrides.status ?? this.status,
      ...(overrides.assigneeActorId !== undefined
        ? { assigneeActorId: overrides.assigneeActorId }
        : this.assigneeActorId !== undefined
          ? { assigneeActorId: this.assigneeActorId }
          : {}),
      relatedRefs: overrides.relatedRefs ?? this.relatedRefs,
      ...(overrides.resolvedAt !== undefined
        ? { resolvedAt: overrides.resolvedAt }
        : this.resolvedAt !== undefined
          ? { resolvedAt: this.resolvedAt }
          : {}),
      ...(overrides.closedAt !== undefined
        ? { closedAt: overrides.closedAt }
        : this.closedAt !== undefined
          ? { closedAt: this.closedAt }
          : {}),
      ...(overrides.cancelledAt !== undefined
        ? { cancelledAt: overrides.cancelledAt }
        : this.cancelledAt !== undefined
          ? { cancelledAt: this.cancelledAt }
          : {}),
      createdAt: this.createdAt,
      updatedAt: overrides.updatedAt ?? this.updatedAt,
      revision: this.revision + 1,
    });
  }

  toRecord(): SupportCaseRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      supportCaseId: this.supportCaseId,
      requesterUserId: this.requesterUserId,
      subject: this.subject,
      ...(this.description !== undefined ? { description: this.description } : {}),
      priority: this.priority,
      status: this.status,
      ...(this.assigneeActorId !== undefined ? { assigneeActorId: this.assigneeActorId } : {}),
      relatedRefs: this.relatedRefs,
      ...(this.resolvedAt !== undefined ? { resolvedAt: this.resolvedAt } : {}),
      ...(this.closedAt !== undefined ? { closedAt: this.closedAt } : {}),
      ...(this.cancelledAt !== undefined ? { cancelledAt: this.cancelledAt } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: SupportCaseRecord): SupportCase {
    return new SupportCase({
      supportCaseId: record.supportCaseId,
      tenantId: record.tenantId,
      requesterUserId: record.requesterUserId,
      subject: record.subject,
      ...(record.description !== undefined ? { description: record.description } : {}),
      priority: record.priority,
      status: record.status,
      ...(record.assigneeActorId !== undefined ? { assigneeActorId: record.assigneeActorId } : {}),
      relatedRefs: record.relatedRefs,
      ...(record.resolvedAt !== undefined ? { resolvedAt: record.resolvedAt } : {}),
      ...(record.closedAt !== undefined ? { closedAt: record.closedAt } : {}),
      ...(record.cancelledAt !== undefined ? { cancelledAt: record.cancelledAt } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}

// ---------------------------------------------------------------------------
// Case messages (immutable; the customer/internal visibility boundary)
// ---------------------------------------------------------------------------

/** The closed message-visibility vocabulary: THE boundary. */
export const SUPPORT_CASE_MESSAGE_VISIBILITIES = ["customer", "internal"] as const;

export type SupportCaseMessageVisibility = (typeof SUPPORT_CASE_MESSAGE_VISIBILITIES)[number];

export function isSupportCaseMessageVisibility(
  value: unknown,
): value is SupportCaseMessageVisibility {
  return (
    typeof value === "string" &&
    (SUPPORT_CASE_MESSAGE_VISIBILITIES as readonly string[]).includes(value)
  );
}

/** Serialized (plain) form of a case message. */
export interface SupportCaseMessageRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly messageId: SupportCaseMessageId;
  readonly supportCaseId: SupportCaseId;
  readonly authorActorId: ActorId;
  readonly visibility: SupportCaseMessageVisibility;
  readonly body: string;
  readonly createdAt: UtcInstant;
  /** Immutable record: the revision is always 1. */
  readonly revision: Revision;
}

/**
 * The customer-facing view of a case message: internal messages are
 * structurally absent. `undefined` means "this message does not exist for
 * customers" - the boundary is enforced by TYPES, not by filtering
 * discipline at call sites.
 */
export type CustomerViewMessage = Omit<SupportCaseMessageRecord, "visibility">;

/** Maps a message to the customer view (undefined when internal). */
export function caseMessagesCustomerView(
  messages: readonly SupportCaseMessageRecord[],
): readonly CustomerViewMessage[] {
  return Object.freeze(
    messages
      .filter((message) => message.visibility === "customer")
      .map((message) =>
        Object.freeze({
          contractVersion: message.contractVersion,
          tenantId: message.tenantId,
          messageId: message.messageId,
          supportCaseId: message.supportCaseId,
          authorActorId: message.authorActorId,
          body: message.body,
          createdAt: message.createdAt,
          revision: message.revision,
        }),
      ),
  );
}

/** A validated, deeply frozen immutable case message. */
export class SupportCaseMessage {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly messageId: SupportCaseMessageId;
  readonly supportCaseId: SupportCaseId;
  readonly authorActorId: ActorId;
  readonly visibility: SupportCaseMessageVisibility;
  readonly body: string;
  readonly createdAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: {
    readonly messageId: string;
    readonly tenantId: string;
    readonly supportCaseId: string;
    readonly authorActorId: string;
    readonly visibility: string;
    readonly body: string;
    readonly createdAt: string;
  }) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (
        !["messageId", "tenantId", "supportCaseId", "authorActorId", "visibility", "body", "createdAt"].includes(key)
      ) {
        field(key, "unknown field (the case-message vocabulary is closed)");
      }
    }
    this.contractVersion = NOTIFICATIONS_CONTRACT_VERSION;
    this.messageId = parseMessageIdField(input.messageId);
    this.tenantId = parseTenantField(input.tenantId);
    this.supportCaseId = parseCaseIdField(input.supportCaseId);
    this.authorActorId = parseActorField(input.authorActorId, "authorActorId");
    if (!isSupportCaseMessageVisibility(input.visibility)) {
      field("visibility", "must be customer or internal (the visibility boundary is closed)");
    }
    this.visibility = input.visibility;
    if (
      typeof input.body !== "string" ||
      !PRINTABLE_PATTERN.test(input.body) ||
      input.body.length === 0 ||
      input.body.length > MAX_MESSAGE_BODY_LENGTH
    ) {
      field("body", `must be printable text of 1..${MAX_MESSAGE_BODY_LENGTH} characters`);
    }
    this.body = input.body;
    this.createdAt = parseInstantField(input.createdAt, "createdAt");
    this.revision = 1 as Revision;
    Object.freeze(this);
  }

  toRecord(): SupportCaseMessageRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      messageId: this.messageId,
      supportCaseId: this.supportCaseId,
      authorActorId: this.authorActorId,
      visibility: this.visibility,
      body: this.body,
      createdAt: this.createdAt,
      revision: this.revision,
    });
  }
}

/** Validates a stored case record's contract version (fail-closed). */
export function assertSupportCaseRecordVersion(record: SupportCaseRecord): void {
  if (!isNotificationsRecordVersionCompatible(record.contractVersion)) {
    field("contractVersion", describeNotificationsVersionExpectation());
  }
}

/** Validates a stored message record's contract version (fail-closed). */
export function assertSupportCaseMessageRecordVersion(record: SupportCaseMessageRecord): void {
  if (!isNotificationsRecordVersionCompatible(record.contractVersion)) {
    field("contractVersion", describeNotificationsVersionExpectation());
  }
}

// --- shared field parsers (keep error reason SUPPORT_CASE_INVALID) -------------

function parseCaseIdField(value: string): SupportCaseId {
  try {
    return parseSupportCaseId(value);
  } catch {
    field("supportCaseId", "must be a canonical lowercase UUID");
  }
}

function parseMessageIdField(value: string): SupportCaseMessageId {
  try {
    return parseSupportCaseMessageId(value);
  } catch {
    field("messageId", "must be a canonical lowercase UUID");
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
    field("requesterUserId", "must be a canonical lowercase UUID (the requesting customer)");
  }
}

function parseActorField(value: string, label: string): ActorId {
  try {
    return parseActorId(value);
  } catch {
    field(label, "must be a safe actor reference");
  }
}

function parseInstantField(value: string, label: string): UtcInstant {
  try {
    return parseUtcInstant(value);
  } catch {
    field(label, "must be a UTC instant with a zone designator");
  }
}
