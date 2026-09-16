/**
 * The append-only audit event stream (RL-051).
 *
 * {@link AuditLog} is the port; {@link InMemoryAuditLog} is the deterministic
 * reference implementation. The store is APPEND-ONLY BY CONSTRUCTION:
 *
 *  - the only write is `append`, which computes the chain fields (per-log
 *    monotonic `sequence`, `prevDigest` = predecessor's digest) and stores a
 *    deeply frozen {@link AuditEvent};
 *  - there is no update, no delete, no truncate - the methods do not exist
 *    on the port, so no caller (and no future adapter) can mutate history;
 *  - reads return frozen snapshots; retention/compaction is RL-054's concern
 *    and must operate on ARCHIVED COPIES, never by rewriting the chain.
 *
 * {@link verifyAuditChain} / `verify()` walk the chain and recompute every
 * digest: any tampering with a recorded field, any reordering, any splice
 * breaks verification at the first affected event.
 */
import { randomUUID } from "node:crypto";
import {
  ValidationError,
  parseActorId,
  parseCorrelationId,
  parseTenantId,
  parseUtcInstant,
  type ActorId,
  type CorrelationId,
  type Digest,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  ALLOWED_AUDIT_PLAIN_FIELDS,
  auditEventDigest,
  buildAuditEvent,
  isAuditEventCategory,
  type AuditEvent,
  type AuditEventInput,
  type AuditEventPlain,
} from "./audit-event.js";

/** Why chain verification failed. */
export const AUDIT_CHAIN_FAILURE_REASONS = [
  "digest-mismatch",
  "chain-broken",
  "sequence-invalid",
] as const;

export type AuditChainFailureReason = (typeof AUDIT_CHAIN_FAILURE_REASONS)[number];

export type AuditChainVerification =
  | { readonly ok: true; readonly verifiedCount: number }
  | {
      readonly ok: false;
      readonly reason: AuditChainFailureReason;
      /** The 1-based sequence of the first event where verification broke. */
      readonly firstBrokenSequence: number;
    };

/** Query filters (all specified filters are ANDed). */
export interface AuditQuery {
  readonly correlationId?: CorrelationId;
  readonly actorId?: ActorId;
  readonly tenantId?: TenantId;
  readonly category?: string;
  /** Inclusive lower bound on `occurredAt`. */
  readonly from?: UtcInstant;
  /** Inclusive upper bound on `occurredAt`. */
  readonly to?: UtcInstant;
}

/** The append-only audit log port. NO mutation methods exist by design. */
export interface AuditLog {
  /** Appends one event; chain fields are computed here, never by callers. */
  append(input: AuditEventInput): Promise<AuditEvent>;
  /** Frozen snapshot of the full stream in append order. */
  events(): Promise<readonly AuditEvent[]>;
  /** Verifies the digest chain end-to-end. */
  verify(): Promise<AuditChainVerification>;
  /** Queries by correlation/actor/tenant/category/time-range. */
  query(query: AuditQuery): Promise<readonly AuditEvent[]>;
}

/** Options for {@link InMemoryAuditLog}. */
export interface InMemoryAuditLogOptions {
  /** Injectable event-id generator (deterministic tests); defaults to randomUUID. */
  readonly eventIdGenerator?: () => string;
}

/**
 * Pure chain verification over a list of plain (serialized or in-memory)
 * event records. Accepts {@link AuditEvent} instances and plain records
 * alike, so tampering can be detected on JSON round-tripped copies.
 */
export function verifyAuditChain(
  events: readonly unknown[],
): AuditChainVerification {
  let previousDigest: Digest | null = null;
  let index = 0;
  for (const candidate of events) {
    index += 1;
    if (candidate === null || typeof candidate !== "object") {
      return { ok: false, reason: "sequence-invalid", firstBrokenSequence: index };
    }
    const record = candidate as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!ALLOWED_AUDIT_PLAIN_FIELDS.has(key)) {
        return { ok: false, reason: "digest-mismatch", firstBrokenSequence: index };
      }
    }
    const sequence = record["sequence"];
    if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence !== index) {
      return { ok: false, reason: "sequence-invalid", firstBrokenSequence: index };
    }
    const prevDigest = record["prevDigest"];
    const digest = record["digest"];
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      return { ok: false, reason: "digest-mismatch", firstBrokenSequence: index };
    }
    if (previousDigest === null) {
      if (prevDigest !== null) {
        return { ok: false, reason: "chain-broken", firstBrokenSequence: index };
      }
    } else if (prevDigest !== previousDigest) {
      return { ok: false, reason: "chain-broken", firstBrokenSequence: index };
    }
    // Recompute the digest over everything except the digest field itself.
    const { digest: _omit, ...body } = record;
    const recomputed = auditEventDigest(body as Omit<AuditEventPlain, "digest">);
    if (recomputed !== digest) {
      return { ok: false, reason: "digest-mismatch", firstBrokenSequence: index };
    }
    previousDigest = digest as Digest;
  }
  return { ok: true, verifiedCount: events.length };
}

/** Deterministic in-memory append-only audit log. */
export class InMemoryAuditLog implements AuditLog {
  readonly #events: AuditEvent[] = [];
  readonly #eventIdGenerator: () => string;

  constructor(options?: InMemoryAuditLogOptions) {
    this.#eventIdGenerator = options?.eventIdGenerator ?? randomUUID;
  }

  async append(input: AuditEventInput): Promise<AuditEvent> {
    const last = this.#events[this.#events.length - 1];
    const event = buildChained({
      eventId: this.#eventIdGenerator(),
      input,
      sequence: last === undefined ? 1 : last.sequence + 1,
      prevDigest: last === undefined ? null : last.digest,
    });
    this.#events.push(event);
    return event;
  }

  async events(): Promise<readonly AuditEvent[]> {
    return Object.freeze([...this.#events]);
  }

  async verify(): Promise<AuditChainVerification> {
    return verifyAuditChain(this.#events.map((event) => event.toPlain()));
  }

  async query(query: AuditQuery): Promise<readonly AuditEvent[]> {
    const correlationId =
      query.correlationId === undefined ? undefined : parseCorrelationId(query.correlationId);
    const actorId = query.actorId === undefined ? undefined : parseActorId(query.actorId);
    const tenantId = query.tenantId === undefined ? undefined : parseTenantId(query.tenantId);
    const category = query.category === undefined ? undefined : validatedCategory(query.category);
    const from = query.from === undefined ? undefined : parseUtcInstant(query.from);
    const to = query.to === undefined ? undefined : parseUtcInstant(query.to);
    return Object.freeze(
      this.#events.filter((event) => {
        if (correlationId !== undefined && event.correlationId !== correlationId) return false;
        if (actorId !== undefined && event.actorId !== actorId) return false;
        if (tenantId !== undefined && event.tenantId !== tenantId) return false;
        if (category !== undefined && event.category !== category) return false;
        if (from !== undefined && event.occurredAt < from) return false;
        if (to !== undefined && event.occurredAt > to) return false;
        return true;
      }),
    );
  }

  get size(): number {
    return this.#events.length;
  }
}

function validatedCategory(value: string): string {
  if (!isAuditEventCategory(value)) {
    throw new ValidationError(
      "AuditQuery.category must be one of the closed audit taxonomy (auth, secret-access, authority-decision, admin-override)",
      {
        reason: "AUDIT_QUERY_INVALID",
        details: [{ path: "category", issue: "outside the closed taxonomy" }],
      },
    );
  }
  return value;
}

function buildChained(input: {
  readonly eventId: string;
  readonly input: AuditEventInput;
  readonly sequence: number;
  readonly prevDigest: Digest | null;
}): AuditEvent {
  return buildAuditEvent({
    eventId: input.eventId,
    body: input.input as unknown as Record<string, unknown>,
    sequence: input.sequence,
    prevDigest: input.prevDigest,
  });
}
