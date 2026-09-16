/**
 * The ConnectivityReference aggregate (RL-023, "order does not imply
 * delivery").
 *
 * One reference per commercial subject (an Order or a Subscription),
 * carrying that subject's LINKED DELIVERY EVIDENCE as an explicit,
 * evidence-bearing reference layer between commerce and the ADCOS-derived
 * projections. This is the ONLY way the commerce surface reads
 * connectivity status: through the reference, which exposes the subject's
 * own commercial state PLUS the linked evidence with its freshness -
 * never an invented opaque combined status (RL-LOCK-008/010).
 *
 * The reference NEVER writes connectivity (RL-LOCK-005): it links
 * observations produced by the projection engine (RL-034) and presents
 * them. Relinking captures a NEW immutable evidence snapshot; the event
 * chain retains every observation (audit).
 *
 * State machine (validated transitions only; `retired` is terminal):
 *
 *   [create] -> active ──retire──> retired (terminal)
 *                    │
 *                    └──link/replace evidence (stays active; revision bumps)
 *
 * `delivery_evidence_state` (UNEVIDENCED | EVIDENCED) rides on the
 * reference and is its own vocabulary - separate from the reference's own
 * lifecycle status (active | retired) and from every commerce/ADCOS state.
 */
import {
  ValidationError,
  parseContractVersion,
  parseTenantId,
  parseUtcInstant,
  type ContractVersion,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  DELIVERY_EVIDENCE_STATES,
  isDeliveryEvidenceState,
  parseDeliveryEvidence,
  type DeliveryEvidence,
  type DeliveryEvidenceState,
} from "./delivery-evidence.js";
import { parseConnectivityReferenceId, type ConnectivityReferenceId } from "./ids.js";
import {
  COMMERCE_CONNECTIVITY_CONTRACT_VERSION,
  describeCommerceConnectivityVersionExpectation,
  isCommerceConnectivityRecordVersionCompatible,
} from "./version.js";

/** The commercial subjects a reference can explain. */
export const REFERENCE_SUBJECT_TYPES = ["order", "subscription"] as const;

export type ReferenceSubjectType = (typeof REFERENCE_SUBJECT_TYPES)[number];

export function isReferenceSubjectType(value: unknown): value is ReferenceSubjectType {
  return (
    typeof value === "string" && (REFERENCE_SUBJECT_TYPES as readonly string[]).includes(value)
  );
}

/** The reference's own lifecycle (NOT the delivery-evidence state). */
export const REFERENCE_STATUSES = ["active", "retired"] as const;

export type ReferenceStatus = (typeof REFERENCE_STATUSES)[number];

export function isReferenceStatus(value: unknown): value is ReferenceStatus {
  return typeof value === "string" && (REFERENCE_STATUSES as readonly string[]).includes(value);
}

/** The typed, explicit reference transitions. */
export const CONNECTIVITY_REFERENCE_TRANSITIONS = ["link", "retire"] as const;

export type ConnectivityReferenceTransition = (typeof CONNECTIVITY_REFERENCE_TRANSITIONS)[number];

/** Serialized (plain) form of a connectivity reference. */
export interface ConnectivityReferenceRecord {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly referenceId: ConnectivityReferenceId;
  readonly subjectType: ReferenceSubjectType;
  /** OrderId or SubscriptionId (validated shape by the service). */
  readonly subjectId: string;
  readonly status: ReferenceStatus;
  readonly deliveryEvidenceState: DeliveryEvidenceState;
  /** Present iff deliveryEvidenceState is EVIDENCED. */
  readonly evidence?: DeliveryEvidence;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link ConnectivityReference} constructor. */
export interface ConnectivityReferenceInput {
  readonly referenceId: string;
  readonly tenantId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly status: string;
  readonly deliveryEvidenceState: string;
  readonly evidence?: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "referenceId",
  "tenantId",
  "subjectType",
  "subjectId",
  "status",
  "deliveryEvidenceState",
  "evidence",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`ConnectivityReference rejected: ${label} - ${issue}`, {
    reason: "CONNECTIVITY_REFERENCE_INVALID",
    details: [{ path: label, issue }],
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The ConnectivityReference aggregate. Frozen deeply; transitions return
 * new instances with the revision bumped (persisted via compare-and-swap,
 * RL-LOCK-017).
 */
export class ConnectivityReference {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly referenceId: ConnectivityReferenceId;
  readonly subjectType: ReferenceSubjectType;
  readonly subjectId: string;
  readonly status: ReferenceStatus;
  readonly deliveryEvidenceState: DeliveryEvidenceState;
  declare readonly evidence?: DeliveryEvidence;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: ConnectivityReferenceInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the reference vocabulary is closed)");
      }
    }
    this.contractVersion = COMMERCE_CONNECTIVITY_CONTRACT_VERSION;
    this.referenceId = parseReferenceIdField(input.referenceId);
    this.tenantId = parseTenantField(input.tenantId);
    if (!isReferenceSubjectType(input.subjectType)) {
      field("subjectType", "must be order or subscription (the explainable commercial subjects)");
    }
    this.subjectType = input.subjectType;
    if (typeof input.subjectId !== "string" || !UUID_PATTERN.test(input.subjectId)) {
      field("subjectId", "must be a canonical lowercase UUID (the referenced order/subscription)");
    }
    this.subjectId = input.subjectId;
    if (!isReferenceStatus(input.status)) {
      field("status", "must be active or retired (the reference lifecycle)");
    }
    this.status = input.status;
    if (!isDeliveryEvidenceState(input.deliveryEvidenceState)) {
      field("deliveryEvidenceState", "must be UNEVIDENCED or EVIDENCED (its own vocabulary, never merged with commerce/ADCOS state)");
    }
    this.deliveryEvidenceState = input.deliveryEvidenceState;
    if (input.evidence !== undefined) {
      this.evidence = parseDeliveryEvidence(input.evidence);
    }
    if (this.deliveryEvidenceState === "EVIDENCED" && this.evidence === undefined) {
      field("evidence", "an EVIDENCED reference must carry its evidence snapshot");
    }
    if (this.deliveryEvidenceState === "UNEVIDENCED" && this.evidence !== undefined) {
      field("evidence", "an UNEVIDENCED reference carries no evidence (absence is a valid state, RL-LOCK-010)");
    }
    if (this.status === "retired" && this.deliveryEvidenceState === "UNEVIDENCED") {
      // allowed: a subject may retire without ever having evidence; the
      // historical chain (events) remains the audit trail.
    }
    this.createdAt = parseInstantField(input.createdAt, "createdAt");
    this.updatedAt = parseInstantField(input.updatedAt, "updatedAt");
    if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 1) {
      field("revision", "must be a positive integer (optimistic-concurrency token)");
    }
    this.revision = input.revision as Revision;
    Object.freeze(this);
  }

  /**
   * active -> active with NEW linked evidence (UNEVIDENCED -> EVIDENCED, or
   * EVIDENCED -> EVIDENCED replacing the snapshot). The previous snapshot
   * stays in the event chain; nothing is silently edited.
   */
  link(evidence: DeliveryEvidence, at: UtcInstant): ConnectivityReference {
    if (this.status !== "active") {
      field("status", "only an active reference can link evidence (retired is terminal)");
    }
    return this.with({
      deliveryEvidenceState: "EVIDENCED",
      evidence,
      updatedAt: at,
    });
  }

  /** active -> retired (terminal). The evidence snapshot stays as history. */
  retire(at: UtcInstant): ConnectivityReference {
    if (this.status !== "active") {
      field("status", "only an active reference can be retired (retired is terminal)");
    }
    return this.with({ status: "retired", updatedAt: at });
  }

  /** The next reference state after a typed transition (read-side helper). */
  static evidenceStateAfter(
    current: DeliveryEvidenceState,
    transition: ConnectivityReferenceTransition,
  ): DeliveryEvidenceState {
    switch (transition) {
      case "link":
        return "EVIDENCED";
      case "retire":
        return current; // retiring changes the lifecycle, not the evidence
    }
  }

  private with(overrides: {
    status?: ReferenceStatus;
    deliveryEvidenceState?: DeliveryEvidenceState;
    evidence?: DeliveryEvidence;
    updatedAt?: UtcInstant;
  }): ConnectivityReference {
    return new ConnectivityReference({
      referenceId: this.referenceId,
      tenantId: this.tenantId,
      subjectType: this.subjectType,
      subjectId: this.subjectId,
      status: overrides.status ?? this.status,
      deliveryEvidenceState: overrides.deliveryEvidenceState ?? this.deliveryEvidenceState,
      ...(overrides.evidence !== undefined
        ? { evidence: overrides.evidence }
        : this.evidence !== undefined
          ? { evidence: this.evidence }
          : {}),
      createdAt: this.createdAt,
      updatedAt: overrides.updatedAt ?? this.updatedAt,
      revision: this.revision + 1,
    });
  }

  toRecord(): ConnectivityReferenceRecord {
    return Object.freeze({
      contractVersion: this.contractVersion,
      tenantId: this.tenantId,
      referenceId: this.referenceId,
      subjectType: this.subjectType,
      subjectId: this.subjectId,
      status: this.status,
      deliveryEvidenceState: this.deliveryEvidenceState,
      ...(this.evidence !== undefined ? { evidence: this.evidence } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: ConnectivityReferenceRecord): ConnectivityReference {
    return new ConnectivityReference({
      referenceId: record.referenceId,
      tenantId: record.tenantId,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      status: record.status,
      deliveryEvidenceState: record.deliveryEvidenceState,
      ...(record.evidence !== undefined ? { evidence: record.evidence } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}

/** Validates a stored reference record's contract version (fail-closed). */
export function assertConnectivityReferenceRecordVersion(
  record: ConnectivityReferenceRecord,
): void {
  if (!isCommerceConnectivityRecordVersionCompatible(parseContractVersion(record.contractVersion))) {
    field("contractVersion", describeCommerceConnectivityVersionExpectation());
  }
}

/** The full never-merged state vocabulary list (drift-guard helper). */
export const DELIVERY_EVIDENCE_STATE_VOCABULARY = DELIVERY_EVIDENCE_STATES;

// --- shared field parsers (keep error reason CONNECTIVITY_REFERENCE_INVALID) ---

function parseReferenceIdField(value: string): ConnectivityReferenceId {
  try {
    return parseConnectivityReferenceId(value);
  } catch {
    field("referenceId", "must be a canonical lowercase UUID");
  }
}

function parseTenantField(value: string): TenantId {
  try {
    return parseTenantId(value);
  } catch {
    field("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>'");
  }
}

function parseInstantField(value: string, label: string): UtcInstant {
  try {
    return parseUtcInstant(value);
  } catch {
    field(label, "must be a UTC instant with a zone designator");
  }
}
