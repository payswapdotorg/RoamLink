/**
 * The retention decision audit trail (RL-054; spec/security.md "Audit":
 * record security-relevant mutations with actor, tenant, target, decision,
 * timestamp and outcome - never secrets or payloads).
 *
 * Every retention decision the engine makes is appended as an immutable
 * {@link RetentionDecisionRecord}: admissions (retained), expiry sweeps
 * (hard-deleted / tombstoned), explicit erasures, rejected secret material
 * and access decisions. The audit store is APPEND-ONLY by construction -
 * the persistence-backed implementation exposes no mutation path for audit
 * rows, and every record is bounded, value-free and deterministically
 * serializable (RL-LOCK-016: no payloads, no secrets).
 */
import {
  ValidationError,
  parseForeignRefAs,
  parseTenantId,
  parseUtcInstant,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import { isRetentionDataCategory, type RetentionDataCategory } from "./classification.js";

/** The closed retention-decision vocabulary. */
export const RETENTION_DECISIONS = [
  "retained",
  "expired-hard-deleted",
  "expired-tombstoned",
  "erasure-applied",
  "rejected-secret-material",
  "rejected-invalid-record",
  "access-granted",
  "access-denied",
] as const;

export type RetentionDecision = (typeof RETENTION_DECISIONS)[number];

export function isRetentionDecision(value: unknown): value is RetentionDecision {
  return typeof value === "string" && (RETENTION_DECISIONS as readonly string[]).includes(value);
}

/** The typed reasons an access request or admission was refused. */
export const RETENTION_REFUSAL_REASONS = [
  "purpose-not-declared",
  "record-expired",
  "record-tombstoned",
  "consent-required",
  "secret-material-detected",
  "invalid-classification",
] as const;

export type RetentionRefusalReason = (typeof RETENTION_REFUSAL_REASONS)[number];

/** The immutable audit record for one retention decision. */
export interface RetentionDecisionRecord {
  readonly decisionId: string;
  readonly decidedAt: UtcInstant;
  readonly decision: RetentionDecision;
  /** The record the decision concerns ("-" for non-record decisions). */
  readonly recordId: string;
  readonly tenantId: TenantId;
  readonly dataCategory: RetentionDataCategory | null;
  /** Typed refusal reason when the decision is a refusal; absent otherwise. */
  readonly refusalReason?: RetentionRefusalReason;
  /** Bounded, non-secret actor label (e.g. "system:sweep", "user:..."). */
  readonly actor: string | null;
}

/** Input accepted by {@link parseRetentionDecisionRecord}. */
export interface RetentionDecisionRecordInput {
  readonly decisionId: string;
  readonly decidedAt: string;
  readonly decision: string;
  readonly recordId: string;
  readonly tenantId: string;
  readonly dataCategory?: string | null;
  readonly refusalReason?: string;
  readonly actor?: string | null;
}

const ACTOR_PATTERN = /^[a-z]([a-z0-9:_.-]{0,127})$/;
const NO_RECORD = "-";

function field(label: string, issue: string): never {
  throw new ValidationError(`RetentionDecisionRecord rejected: ${label} - ${issue}`, {
    reason: "RETENTION_DECISION_INVALID",
    details: [{ path: label, issue }],
  });
}

/** Parses and freezes one audit record (fail-closed on every field). */
export function parseRetentionDecisionRecord(value: unknown): RetentionDecisionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (
      ![
        "decisionId",
        "decidedAt",
        "decision",
        "recordId",
        "tenantId",
        "dataCategory",
        "refusalReason",
        "actor",
      ].includes(key)
    ) {
      field(key, "unknown field (the audit record carries exactly its contract fields)");
    }
  }
  let decisionId: string;
  try {
    decisionId = parseForeignRefAs(input["decisionId"], "RetentionDecisionId");
  } catch {
    field("decisionId", "must be a safe reference string");
  }
  let decidedAt: UtcInstant;
  try {
    decidedAt = parseUtcInstant(input["decidedAt"]);
  } catch {
    field("decidedAt", "must be a UTC instant with an explicit zone designator");
  }
  const decision = input["decision"];
  if (!isRetentionDecision(decision)) {
    field("decision", "must be a member of the closed retention-decision vocabulary");
  }
  let recordId: string;
  if (input["recordId"] === NO_RECORD) {
    recordId = NO_RECORD;
  } else {
    try {
      recordId = parseForeignRefAs(input["recordId"], "RetentionRecordId");
    } catch {
      field("recordId", `must be a safe reference string or '${NO_RECORD}'`);
    }
  }
  let tenantId: TenantId;
  try {
    tenantId = parseTenantId(input["tenantId"]);
  } catch {
    field("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'");
  }
  let dataCategory: RetentionDataCategory | null = null;
  if (input["dataCategory"] !== null && input["dataCategory"] !== undefined) {
    if (!isRetentionDataCategory(input["dataCategory"])) {
      field("dataCategory", "must be null or a closed-vocabulary category");
    }
    dataCategory = input["dataCategory"];
  }
  let refusalReason: RetentionRefusalReason | undefined;
  if (input["refusalReason"] !== undefined && input["refusalReason"] !== null) {
    if (
      typeof input["refusalReason"] !== "string" ||
      !(RETENTION_REFUSAL_REASONS as readonly string[]).includes(input["refusalReason"])
    ) {
      field("refusalReason", "must be a member of the closed refusal-reason vocabulary");
    }
    refusalReason = input["refusalReason"] as RetentionRefusalReason;
  }
  let actor: string | null = null;
  if (input["actor"] !== null && input["actor"] !== undefined) {
    if (typeof input["actor"] !== "string" || !ACTOR_PATTERN.test(input["actor"])) {
      field("actor", "must be a bounded lowercase actor label (never a secret)");
    }
    actor = input["actor"];
  }

  const record: RetentionDecisionRecord = Object.freeze({
    decisionId,
    decidedAt,
    decision,
    recordId,
    tenantId,
    dataCategory,
    ...(refusalReason === undefined ? {} : { refusalReason }),
    actor,
  });
  return record;
}

/** The append-only audit store port. */
export interface RetentionAuditStore {
  /** Appends one immutable decision record (insert-only, no update path). */
  append(record: RetentionDecisionRecord): Promise<void>;
  /** All decisions for one record, in decision order. */
  byRecordId(recordId: string): Promise<readonly RetentionDecisionRecord[]>;
  /** All decisions, deterministically ordered by decision id. */
  list(): Promise<readonly RetentionDecisionRecord[]>;
}

/** Deterministic in-memory audit store (tests/local dev). */
export class InMemoryRetentionAuditStore implements RetentionAuditStore {
  readonly #records: RetentionDecisionRecord[] = [];

  async append(record: RetentionDecisionRecord): Promise<void> {
    const validated = parseRetentionDecisionRecord(record);
    if (this.#records.some((existing) => existing.decisionId === validated.decisionId)) {
      throw new ValidationError(
        "an audit record with this decisionId already exists (the audit trail is append-only with unique ids)",
        {
          reason: "RETENTION_DECISION_INVALID",
          details: [{ path: "decisionId", issue: "duplicate" }],
        },
      );
    }
    this.#records.push(validated);
  }

  async byRecordId(recordId: string): Promise<readonly RetentionDecisionRecord[]> {
    const id = parseForeignRefAs(recordId, "RetentionRecordId");
    return Object.freeze(this.#records.filter((record) => record.recordId === id));
  }

  async list(): Promise<readonly RetentionDecisionRecord[]> {
    return Object.freeze(
      [...this.#records].sort((a, b) =>
        a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0,
      ),
    );
  }
}
