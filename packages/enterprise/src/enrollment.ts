/**
 * Organization enrollment journey record (RL-063, spec/api.md; the
 * enterprise customer journey).
 *
 * AUTHORITY DISCIPLINE (RL-LOCK-003/019): this record owns ONLY the
 * enterprise onboarding JOURNEY state. Organization/User/Membership
 * aggregates remain owned by the auth domain (@roamlink/auth); this record
 * REFERENCES the provisioned tenant/organization through explicitly named
 * foreign-reference fields and never redefines them. Enrollment state is its
 * own closed vocabulary - it is deliberately NOT the organization status
 * vocabulary (`active`/`suspended`, spec/data-model.md "State separation").
 *
 * The journey state machine:
 *
 * ```text
 *   draft ──submit──> submitted ──verify──> verified ──activate──> active
 *     │                  │                    │
 *     │                  └──reject────> rejected (terminal)
 *     │                                       │
 *     └────────── cancel ─────────────────────┴──> cancelled (terminal)
 * ```
 *
 * A record may only reach `verified` once the tenant is BOUND (the
 * organization was provisioned through the registrar port); activation
 * requires verification. All transitions are pure functions over immutable
 * records with monotonic revisions (optimistic concurrency).
 */
import {
  ConflictError,
  ValidationError,
  parseActorId,
  parseRevision,
  parseTenantId,
  parseUtcInstant,
  type ActorId,
  type ContractVersion,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import { parseEnterpriseEnrollmentId, type EnterpriseEnrollmentId } from "./ids.js";
import {
  describeEnterpriseContractVersionExpectation,
  isEnterpriseRecordVersionCompatible,
} from "./version.js";
import { parseContractVersion } from "@roamlink/contracts";

/** Identity of the enrollment journey (alias for readability at call sites). */
export type { EnterpriseEnrollmentId };

/** The closed enrollment journey state vocabulary (journey state ONLY). */
export const ENTERPRISE_ENROLLMENT_STATES = [
  "draft",
  "submitted",
  "verified",
  "active",
  "rejected",
  "cancelled",
] as const;

export type EnterpriseEnrollmentState = (typeof ENTERPRISE_ENROLLMENT_STATES)[number];

export function isEnterpriseEnrollmentState(value: unknown): value is EnterpriseEnrollmentState {
  return (
    typeof value === "string" &&
    (ENTERPRISE_ENROLLMENT_STATES as readonly string[]).includes(value)
  );
}

/** Closed reasons an enrollment was rejected (bounded, printable). */
export const ENTERPRISE_ENROLLMENT_REJECTION_REASONS = [
  "requirements-unmet",
  "verification-failed",
  "duplicate-organization",
] as const;

export type EnterpriseEnrollmentRejectionReason =
  (typeof ENTERPRISE_ENROLLMENT_REJECTION_REASONS)[number];

/** The closed enrollment-command vocabulary. */
export const ENTERPRISE_ENROLLMENT_COMMANDS = [
  "submit",
  "verify",
  "activate",
  "reject",
  "cancel",
] as const;

export type EnterpriseEnrollmentCommand = (typeof ENTERPRISE_ENROLLMENT_COMMANDS)[number];

/** Legal state transitions (from -> to), as a frozen map. */
const TRANSITION_MAP: Readonly<
  Record<EnterpriseEnrollmentState, readonly EnterpriseEnrollmentState[]>
> = Object.freeze({
  draft: Object.freeze(["submitted", "cancelled"] as const),
  submitted: Object.freeze(["verified", "rejected", "cancelled"] as const),
  verified: Object.freeze(["active", "cancelled"] as const),
  active: Object.freeze([] as const),
  rejected: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
});

export const ENTERPRISE_ENROLLMENT_TRANSITIONS = TRANSITION_MAP;

/** Typed actor reference for command correlation. */
export interface EnrollmentActorContext {
  readonly actorId: ActorId;
  readonly tenantId?: TenantId;
}

/** Serialized (plain) form of an enterprise enrollment journey record. */
export interface EnterpriseEnrollmentRecord {
  readonly enrollmentId: EnterpriseEnrollmentId;
  readonly contractVersion: ContractVersion;
  /** The requested organization display name (intent, not authority). */
  readonly organizationName: string;
  /** The provisioned tenant boundary; null until the registrar binds it. */
  readonly tenantId: TenantId | null;
  /** The actor who requested the enrollment. */
  readonly requestedBy: ActorId;
  readonly state: EnterpriseEnrollmentState;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  /** Monotonic revision (optimistic-concurrency token). */
  readonly revision: Revision;
  readonly verifiedAt?: UtcInstant;
  readonly rejectionReason?: EnterpriseEnrollmentRejectionReason;
  readonly cancelledAt?: UtcInstant;
  readonly activatedAt?: UtcInstant;
}

/** Input accepted by {@link parseEnterpriseEnrollmentRecord}. */
export interface EnterpriseEnrollmentInput {
  readonly enrollmentId: string;
  readonly contractVersion: string;
  readonly organizationName: string;
  readonly tenantId?: string | null;
  readonly requestedBy: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly verifiedAt?: string;
  readonly rejectionReason?: string;
  readonly cancelledAt?: string;
  readonly activatedAt?: string;
}

const ALLOWED_FIELDS = new Set([
  "enrollmentId",
  "contractVersion",
  "organizationName",
  "tenantId",
  "requestedBy",
  "state",
  "createdAt",
  "updatedAt",
  "revision",
  "verifiedAt",
  "rejectionReason",
  "cancelledAt",
  "activatedAt",
]);

const MAX_ORGANIZATION_NAME_LENGTH = 120;

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function field(label: string, issue: string): never {
  throw new ValidationError(`EnterpriseEnrollmentRecord rejected: ${label} - ${issue}`, {
    reason: "ENTERPRISE_ENROLLMENT_INVALID",
    details: [{ path: label, issue }],
  });
}

/** Validated enrollment-state invariants beyond the transition map. */
function assertStateInvariants(
  state: EnterpriseEnrollmentState,
  input: EnterpriseEnrollmentInput,
): void {
  if (state === "verified" || state === "active") {
    if (input.verifiedAt === undefined) {
      field("verifiedAt", "a verified/active enrollment must carry its verification instant");
    }
    if (input.tenantId === null || input.tenantId === undefined) {
      field("tenantId", "an enrollment may only reach verified/active with a bound tenant (provisioned through the registrar port - never here)");
    }
  }
  if (state === "rejected" && input.rejectionReason === undefined) {
    field("rejectionReason", "a rejected enrollment must carry its closed-vocabulary reason");
  }
  if (state !== "rejected" && input.rejectionReason !== undefined) {
    field("rejectionReason", "only a rejected enrollment carries a rejection reason");
  }
  if (state !== "cancelled" && input.cancelledAt !== undefined) {
    field("cancelledAt", "only a cancelled enrollment carries a cancellation instant");
  }
  if (state !== "active" && input.activatedAt !== undefined) {
    field("activatedAt", "only an active enrollment carries an activation instant");
  }
  if (state !== "verified" && state !== "active" && input.verifiedAt !== undefined) {
    field("verifiedAt", "only a verified/active enrollment carries a verification instant");
  }
}

/**
 * Parses and freezes an enterprise enrollment journey record. Fail-closed on
 * unknown fields (additive tolerance is governed by the CONTRACT VERSION,
 * never by silently dropping fields - RL-LOCK-017).
 */
export function parseEnterpriseEnrollmentRecord(value: unknown): EnterpriseEnrollmentRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      field(key, "unknown field (the enrollment record carries exactly its contract fields)");
    }
  }

  let enrollmentId: EnterpriseEnrollmentId;
  try {
    enrollmentId = parseEnterpriseEnrollmentId(input["enrollmentId"]);
  } catch {
    field("enrollmentId", "must be a canonical lowercase UUID");
  }
  let contractVersion: ContractVersion;
  try {
    contractVersion = parseContractVersion(input["contractVersion"]);
  } catch {
    field("contractVersion", "must be a MAJOR.MINOR contract version");
  }
  if (!isEnterpriseRecordVersionCompatible(contractVersion)) {
    field("contractVersion", describeEnterpriseContractVersionExpectation());
  }

  const organizationName = input["organizationName"];
  if (
    typeof organizationName !== "string" ||
    organizationName.length === 0 ||
    organizationName.length > MAX_ORGANIZATION_NAME_LENGTH ||
    organizationName !== organizationName.trim() ||
    hasControlCharacter(organizationName)
  ) {
    field("organizationName", "must be a trimmed, printable, non-secret label of 1-120 chars");
  }

  let tenantId: TenantId | null = null;
  if (input["tenantId"] !== null && input["tenantId"] !== undefined) {
    try {
      tenantId = parseTenantId(input["tenantId"]);
    } catch {
      field("tenantId", "must be null or a RoamLink tenant id (a foreign reference to the auth-owned organization boundary)");
    }
  }

  let requestedBy: ActorId;
  try {
    requestedBy = parseActorId(input["requestedBy"]);
  } catch {
    field("requestedBy", "must be an actor id");
  }

  const state = input["state"];
  if (!isEnterpriseEnrollmentState(state)) {
    field("state", "must be a member of the closed enrollment journey vocabulary");
  }

  let createdAt: UtcInstant;
  try {
    createdAt = parseUtcInstant(input["createdAt"]);
  } catch {
    field("createdAt", "must be a UTC instant with an explicit zone designator");
  }
  let updatedAt: UtcInstant;
  try {
    updatedAt = parseUtcInstant(input["updatedAt"]);
  } catch {
    field("updatedAt", "must be a UTC instant with an explicit zone designator");
  }
  let revision: Revision;
  try {
    revision = parseRevision(input["revision"]);
  } catch {
    field("revision", "must be a positive integer (optimistic-concurrency revision)");
  }

  let verifiedAt: UtcInstant | undefined;
  if (input["verifiedAt"] !== undefined) {
    try {
      verifiedAt = parseUtcInstant(input["verifiedAt"]);
    } catch {
      field("verifiedAt", "must be a UTC instant with an explicit zone designator");
    }
  }
  let rejectionReason: EnterpriseEnrollmentRejectionReason | undefined;
  if (input["rejectionReason"] !== undefined) {
    if (
      typeof input["rejectionReason"] !== "string" ||
      !(ENTERPRISE_ENROLLMENT_REJECTION_REASONS as readonly string[]).includes(
        input["rejectionReason"],
      )
    ) {
      field("rejectionReason", "must be a member of the closed rejection-reason vocabulary");
    }
    rejectionReason = input["rejectionReason"] as EnterpriseEnrollmentRejectionReason;
  }
  let cancelledAt: UtcInstant | undefined;
  if (input["cancelledAt"] !== undefined) {
    try {
      cancelledAt = parseUtcInstant(input["cancelledAt"]);
    } catch {
      field("cancelledAt", "must be a UTC instant with an explicit zone designator");
    }
  }
  let activatedAt: UtcInstant | undefined;
  if (input["activatedAt"] !== undefined) {
    try {
      activatedAt = parseUtcInstant(input["activatedAt"]);
    } catch {
      field("activatedAt", "must be a UTC instant with an explicit zone designator");
    }
  }

  assertStateInvariants(state, {
    ...(input as unknown as EnterpriseEnrollmentInput),
    state,
  });

  return Object.freeze({
    enrollmentId,
    contractVersion,
    organizationName,
    tenantId,
    requestedBy,
    state,
    createdAt,
    updatedAt,
    revision,
    ...(verifiedAt !== undefined ? { verifiedAt } : {}),
    ...(rejectionReason !== undefined ? { rejectionReason } : {}),
    ...(cancelledAt !== undefined ? { cancelledAt } : {}),
    ...(activatedAt !== undefined ? { activatedAt } : {}),
  });
}

/** Result descriptor of one applied enrollment command. */
export interface EnterpriseEnrollmentTransitionResult {
  readonly record: EnterpriseEnrollmentRecord;
  readonly command: EnterpriseEnrollmentCommand;
  /** True when this call applied the transition; false when already there. */
  readonly applied: boolean;
}

/**
 * Pure state-machine application of one enrollment command. `verify` binds
 * the tenant provisioned through the registrar port (the tenant NEVER
 * originates here). Commands are idempotent per state: re-submitting a
 * submitted record is a no-op returning the same record; illegal transitions
 * fail closed with typed errors.
 */
export function applyEnterpriseEnrollmentCommand(
  record: EnterpriseEnrollmentRecord,
  command: EnterpriseEnrollmentCommand,
  at: UtcInstant | string,
  options?: { readonly tenantId?: string | null; readonly rejectionReason?: string },
): EnterpriseEnrollmentTransitionResult {
  const instant = parseUtcInstant(at);
  const from = record.state;
  const legal = ENTERPRISE_ENROLLMENT_TRANSITIONS[from];

  const next = (() => {
    switch (command) {
      case "submit":
        return "submitted" as const;
      case "verify":
        return "verified" as const;
      case "activate":
        return "active" as const;
      case "reject":
        return "rejected" as const;
      case "cancel":
        return "cancelled" as const;
    }
  })();

  if (from === next) {
    // Idempotent replay: the journey is already in the commanded state.
    return { record, command, applied: false };
  }
  if (!legal.includes(next)) {
    throw new ConflictError(
      `the enrollment journey cannot move from '${from}' via '${command}' (closed state machine; terminal states are immutable)`,
      {
        reason: "ENTERPRISE_ENROLLMENT_TRANSITION_INVALID",
        details: [{ path: "state", issue: `${from} -> ${next} is not a legal transition` }],
      },
    );
  }

  let tenantId = record.tenantId;
  if (command === "verify") {
    const bound = options?.tenantId ?? null;
    if (bound === null) {
      if (record.tenantId === null) {
        throw new ConflictError(
          "verification requires the tenant provisioned through the registrar port (the enrollment never creates the organization boundary itself)",
          {
            reason: "ENTERPRISE_ENROLLMENT_TENANT_UNBOUND",
            details: [{ path: "tenantId", issue: "no provisioned tenant was supplied" }],
          },
        );
      }
    } else {
      tenantId = parseTenantId(bound);
    }
    if (tenantId === null) {
      throw new ConflictError(
        "verification requires a bound tenant (provisioned through the registrar port)",
        { reason: "ENTERPRISE_ENROLLMENT_TENANT_UNBOUND" },
      );
    }
  }
  if (command === "reject") {
    if (
      options?.rejectionReason === undefined ||
      !(ENTERPRISE_ENROLLMENT_REJECTION_REASONS as readonly string[]).includes(
        options.rejectionReason,
      )
    ) {
      throw new ConflictError(
        "rejection requires a closed-vocabulary rejection reason",
        { reason: "ENTERPRISE_ENROLLMENT_REJECTION_REASON_REQUIRED" },
      );
    }
  }

  const nextRecord: EnterpriseEnrollmentRecord = parseEnterpriseEnrollmentRecord({
    ...record,
    state: next,
    tenantId,
    updatedAt: instant,
    revision: record.revision + 1,
    ...(command === "verify" ? { verifiedAt: instant } : {}),
    ...(command === "activate" ? { activatedAt: instant } : {}),
    ...(command === "reject" ? { rejectionReason: options?.rejectionReason } : {}),
    ...(command === "cancel" ? { cancelledAt: instant } : {}),
  });
  return { record: nextRecord, command, applied: true };
}
