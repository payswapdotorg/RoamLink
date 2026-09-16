/**
 * The audit event record (RL-051, spec/security.md "Audit").
 *
 * An {@link AuditEvent} is an APPEND-ONLY, UTC-instanced, tamper-evident
 * record of one security-relevant action. Every event carries:
 *
 *  - ACTOR + TENANT correlation (who, in which tenant boundary);
 *  - COMMAND correlation (correlationId REQUIRED; commandId when the action
 *    rode a Wave-0 command envelope - RL-LOCK-014);
 *  - a closed event TAXONOMY (auth, secret-access, authority-decision,
 *    admin-override) plus a bounded safe-label action;
 *  - an optional TARGET resource reference;
 *  - a closed OUTCOME vocabulary (allowed, denied, degraded, failed) - the
 *    authorization decision and its result;
 *  - `occurredAt` as an explicit UTC instant;
 *  - a digest CHAIN: per-log monotonic `sequence`, `prevDigest` (null only
 *    for the genesis event) and `digest` = SHA-256 over the canonical JSON
 *    of the event body. Tampering with any recorded field breaks the chain
 *    at the first modified event (verification recomputes digests).
 *
 * Records are DEEPLY FROZEN and there is no mutation path - neither on the
 * class nor on any store that holds them. Bounded `detail` strings are
 * printable and non-secret (RL-LOCK-016); secret VALUES never appear.
 */
import {
  ValidationError,
  canonicalizeJson,
  isCanonicalUuid,
  parseActorId,
  parseCorrelationId,
  parseCommandId,
  parseDigest,
  parseRevision,
  parseTenantId,
  parseUtcInstant,
  sha256Hex,
  type ActorId,
  type CommandId,
  type CorrelationId,
  type Digest,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";
import type { Branded } from "@roamlink/contracts";

/** Identity of an audit event (canonical UUID, branded). */
export type AuditEventId = Branded<"AuditEventId">;

/** Closed security-relevant event taxonomy (spec/security.md "Audit"). */
export const AUDIT_EVENT_CATEGORIES = [
  "auth",
  "secret-access",
  "authority-decision",
  "admin-override",
] as const;

export type AuditEventCategory = (typeof AUDIT_EVENT_CATEGORIES)[number];

/** Closed outcome vocabulary: the authorization decision's result. */
export const AUDIT_EVENT_OUTCOMES = ["allowed", "denied", "degraded", "failed"] as const;

export type AuditEventOutcome = (typeof AUDIT_EVENT_OUTCOMES)[number];

/** Safe-label grammar for action names (e.g. `session.create`). */
export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

/** Target resource references use the conservative foreign-ref charset. */
export const AUDIT_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;

const MAX_DETAIL_LENGTH = 256;

export function isAuditEventCategory(value: unknown): value is AuditEventCategory {
  return (
    typeof value === "string" && (AUDIT_EVENT_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isAuditEventOutcome(value: unknown): value is AuditEventOutcome {
  return typeof value === "string" && (AUDIT_EVENT_OUTCOMES as readonly string[]).includes(value);
}

function parseAuditAction(value: unknown): string {
  if (typeof value !== "string" || !AUDIT_ACTION_PATTERN.test(value)) {
    throw new ValidationError(
      "AuditEvent.action must be a safe label (1-64 chars, starts lowercase alphanumeric, then [a-z0-9.-] only)",
      {
        reason: "AUDIT_EVENT_INVALID",
        details: [{ path: "action", issue: "not a safe action label" }],
      },
    );
  }
  return value;
}

function parseAuditTarget(value: unknown): string {
  if (typeof value !== "string" || !AUDIT_TARGET_PATTERN.test(value)) {
    throw new ValidationError(
      "AuditEvent.target must be a safe resource reference (1-255 chars, [A-Za-z0-9._:@-] only)",
      {
        reason: "AUDIT_EVENT_INVALID",
        details: [{ path: "target", issue: "not a safe resource reference" }],
      },
    );
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The chain-carrying plain form of an audit event (exactly these fields). */
export interface AuditEventPlain {
  readonly eventId: AuditEventId;
  readonly sequence: Revision;
  readonly category: AuditEventCategory;
  readonly action: string;
  readonly outcome: AuditEventOutcome;
  readonly actorId: ActorId;
  readonly tenantId?: TenantId;
  readonly correlationId: CorrelationId;
  readonly commandId?: CommandId;
  readonly target?: string;
  readonly occurredAt: UtcInstant;
  readonly detail?: string;
  /** Digest of the predecessor event; null exactly for the genesis event. */
  readonly prevDigest: Digest | null;
  /** SHA-256 over the canonical JSON of this record WITHOUT the digest field. */
  readonly digest: Digest;
}

/** Input accepted by an audit log's append (chain fields are computed). */
export interface AuditEventInput {
  readonly category: string;
  readonly action: string;
  readonly outcome: string;
  readonly actorId: string;
  readonly tenantId?: string;
  readonly correlationId: string;
  readonly commandId?: string;
  readonly target?: string;
  readonly occurredAt: string;
  readonly detail?: string;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "category",
  "action",
  "outcome",
  "actorId",
  "tenantId",
  "correlationId",
  "commandId",
  "target",
  "occurredAt",
  "detail",
]);

/** Every field a chain-carrying plain record may carry (for strict verification). */
export const ALLOWED_AUDIT_PLAIN_FIELDS: ReadonlySet<string> = new Set([
  ...ALLOWED_INPUT_FIELDS,
  "eventId",
  "sequence",
  "prevDigest",
  "digest",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`AuditEvent rejected: ${label} - ${issue}`, {
    reason: "AUDIT_EVENT_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseField<T>(label: string, issue: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    field(label, issue);
  }
}

interface BodyFields {
  readonly category: AuditEventCategory;
  readonly action: string;
  readonly outcome: AuditEventOutcome;
  readonly actorId: ActorId;
  readonly tenantId?: TenantId;
  readonly correlationId: CorrelationId;
  readonly commandId?: CommandId;
  readonly target?: string;
  readonly occurredAt: UtcInstant;
  readonly detail?: string;
}

function parseBody(input: Record<string, unknown>): BodyFields {
  const categoryValue = input["category"];
  if (!isAuditEventCategory(categoryValue)) {
    field(
      "category",
      "must be one of the closed audit taxonomy (auth, secret-access, authority-decision, admin-override)",
    );
  }
  const outcomeValue = input["outcome"];
  if (!isAuditEventOutcome(outcomeValue)) {
    field("outcome", "must be one of allowed, denied, degraded, failed");
  }
  const action = parseAuditAction(input["action"]);
  const actorId = parseField("actorId", "must be a safe actor reference", () =>
    parseActorId(input["actorId"]),
  );
  const correlationId = parseField(
    "correlationId",
    "must be a safe correlation reference (REQUIRED - every audit event is correlatable)",
    () => parseCorrelationId(input["correlationId"]),
  );
  const occurredAt = parseField(
    "occurredAt",
    "must be a UTC instant with an explicit zone designator",
    () => parseUtcInstant(input["occurredAt"]),
  );
  const tenantId =
    input["tenantId"] === undefined
      ? undefined
      : parseField("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'", () =>
          parseTenantId(input["tenantId"]),
        );
  const commandId =
    input["commandId"] === undefined
      ? undefined
      : parseField("commandId", "must be a canonical lowercase UUID", () =>
          parseCommandId(input["commandId"]),
        );
  const target =
    input["target"] === undefined ? undefined : parseAuditTarget(input["target"]);
  const detailValue = input["detail"];
  if (
    detailValue !== undefined &&
    (typeof detailValue !== "string" ||
      detailValue.length === 0 ||
      detailValue.length > MAX_DETAIL_LENGTH ||
      hasControlCharacter(detailValue))
  ) {
    field("detail", `must be a printable, non-secret string of 1-${MAX_DETAIL_LENGTH} chars`);
  }
  const body: BodyFields = {
    category: categoryValue,
    action,
    outcome: outcomeValue,
    actorId,
    correlationId,
    occurredAt,
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(commandId !== undefined ? { commandId } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(detailValue !== undefined ? { detail: detailValue as string } : {}),
  };
  return body;
}

/**
 * Computes the digest of an event body: SHA-256 over the canonical JSON of
 * every field EXCEPT `digest` (chain fields `sequence` and `prevDigest`
 * included - the chain covers order and linkage).
 */
export function auditEventDigest(
  body: Omit<AuditEventPlain, "digest">,
): Digest {
  const { eventId, sequence, category, action, outcome, actorId, tenantId, correlationId, commandId, target, occurredAt, detail, prevDigest } = body;
  const canonicalBody = {
    eventId,
    sequence,
    category,
    action,
    outcome,
    actorId,
    ...(tenantId !== undefined ? { tenantId } : {}),
    correlationId,
    ...(commandId !== undefined ? { commandId } : {}),
    ...(target !== undefined ? { target } : {}),
    occurredAt,
    ...(detail !== undefined ? { detail } : {}),
    prevDigest,
  };
  return sha256Hex(canonicalizeJson(canonicalBody));
}

/**
 * The immutable audit event. Constructed through {@link auditEventFromPlain}
 * (full validation + digest recomputation) or by an audit log computing the
 * chain fields for a fresh {@link AuditEventInput}.
 */
export class AuditEvent {
  readonly eventId: AuditEventId;
  readonly sequence: Revision;
  readonly category: AuditEventCategory;
  readonly action: string;
  readonly outcome: AuditEventOutcome;
  readonly actorId: ActorId;
  declare readonly tenantId?: TenantId;
  readonly correlationId: CorrelationId;
  declare readonly commandId?: CommandId;
  declare readonly target?: string;
  readonly occurredAt: UtcInstant;
  declare readonly detail?: string;
  readonly prevDigest: Digest | null;
  readonly digest: Digest;

  /** Internal use: builds the frozen record from pre-validated pieces. */
  constructor(input: {
    readonly eventId: string;
    readonly body: BodyFields;
    readonly sequence: Revision;
    readonly prevDigest: Digest | null;
    readonly digest: Digest;
  }) {
    this.eventId = input.eventId as AuditEventId;
    this.sequence = input.sequence;
    this.category = input.body.category;
    this.action = input.body.action;
    this.outcome = input.body.outcome;
    this.actorId = input.body.actorId;
    if (input.body.tenantId !== undefined) this.tenantId = input.body.tenantId;
    this.correlationId = input.body.correlationId;
    if (input.body.commandId !== undefined) this.commandId = input.body.commandId;
    if (input.body.target !== undefined) this.target = input.body.target;
    this.occurredAt = input.body.occurredAt;
    if (input.body.detail !== undefined) this.detail = input.body.detail;
    this.prevDigest = input.prevDigest;
    this.digest = input.digest;
    Object.freeze(this);
  }

  /** Plain, serializable form with exactly the contract fields. */
  toPlain(): AuditEventPlain {
    return Object.freeze({
      eventId: this.eventId,
      sequence: this.sequence,
      category: this.category,
      action: this.action,
      outcome: this.outcome,
      actorId: this.actorId,
      ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
      correlationId: this.correlationId,
      ...(this.commandId !== undefined ? { commandId: this.commandId } : {}),
      ...(this.target !== undefined ? { target: this.target } : {}),
      occurredAt: this.occurredAt,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      prevDigest: this.prevDigest,
      digest: this.digest,
    });
  }

  /** Validating round-trip from an unknown (e.g. JSON-parsed) value. */
  static fromPlain(value: unknown): AuditEvent {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      field("$", "fromPlain expects an object");
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!ALLOWED_AUDIT_PLAIN_FIELDS.has(key)) {
        field(key, "unknown field (the audit event carries exactly its contract fields)");
      }
    }
    const body = parseBody(record);
    const sequence = parseField("sequence", "must be a positive integer (per-log monotonic)", () =>
      parseRevision(record["sequence"]),
    );
    const prevDigest =
      record["prevDigest"] === null
        ? null
        : parseField("prevDigest", "must be null or a lowercase 64-char hex digest", () =>
            parseDigest(record["prevDigest"]),
          );
    const digest = parseField("digest", "must be a lowercase 64-char hex digest", () =>
      parseDigest(record["digest"]),
    );
    const eventId = record["eventId"];
    if (!isCanonicalUuid(eventId)) {
      field("eventId", "must be a canonical lowercase UUID");
    }
    const event = new AuditEvent({ eventId, body, sequence, prevDigest, digest });
    // Fail closed when the recorded digest does not match the recomputed one:
    // a mismatched digest means the record was tampered with or corrupted.
    if (event.digest !== auditEventDigest(event.toPlain())) {
      field("digest", "does not match the recomputed digest over the event body (tamper or corruption)");
    }
    return event;
  }
}

/**
 * Builds a GENESIS-or-successor event from a validated input plus computed
 * chain fields (used by audit log implementations).
 */
export function buildAuditEvent(input: {
  readonly eventId: string;
  readonly body: AuditEventInput | Record<string, unknown>;
  readonly sequence: number;
  readonly prevDigest: Digest | null;
}): AuditEvent {
  const body = input.body as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!ALLOWED_INPUT_FIELDS.has(key)) {
      field(key, "unknown field (the audit event carries exactly its contract fields)");
    }
  }
  if (!isCanonicalUuid(input.eventId)) {
    field("eventId", "must be a canonical lowercase UUID");
  }
  const parsed = parseBody(body);
  const sequence = parseRevision(input.sequence);
  const draft = new AuditEvent({
    eventId: input.eventId,
    body: parsed,
    sequence,
    prevDigest: input.prevDigest,
    digest: "0".repeat(64) as Digest,
  });
  const digest = auditEventDigest(draft.toPlain());
  return new AuditEvent({ eventId: input.eventId, body: parsed, sequence, prevDigest: input.prevDigest, digest });
}
