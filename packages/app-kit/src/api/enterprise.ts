/**
 * The enterprise workspace read contract (RL-104, additive to the
 * application API surface; RL-LOCK-017 additive-change tolerance).
 *
 * apps/web may import ONLY this package - the enterprise READ contract is
 * mirrored here so the customer workspace surface never imports
 * @roamlink/enterprise (tests/architecture wave4-a boundary fence). Every
 * state vocabulary below is a CONTRACT MIRROR of the owning domain
 * package, drift-guarded by tests/architecture:
 *
 *  - enrollment states          <- packages/enterprise/src/enrollment.ts
 *                                  (ENTERPRISE_ENROLLMENT_STATES)
 *  - enrollment rejection       <- packages/enterprise/src/enrollment.ts
 *    reasons                      (ENTERPRISE_ENROLLMENT_REJECTION_REASONS)
 *  - connector provisioning     <- packages/enterprise/src/connectors.ts
 *    states                       (CONNECTOR_PROVISIONING_STATES)
 *  - connector provisioning     <- packages/enterprise/src/connectors.ts
 *    failure reasons              (CONNECTOR_PROVISIONING_FAILURE_REASONS)
 *
 * HONESTY RULES:
 *  - this is a READ contract only: the customer surface derives ZERO
 *    enterprise authority from it. Organization identity stays owned by
 *    the auth domain; enrollment/connector journey state stays owned by
 *    the enterprise domain; connectivity facts stay owned by the SAME
 *    connectivity read models (no second authority, RL-LOCK-003/005);
 *  - null sections are real states: a workspace without an enrollment
 *    record or a connector renders the honest not-started state, never a
 *    guessed one;
 *  - the enterprise surface never exposes provider/API-key secrets
 *    (RL-LOCK-016).
 */

import { ValidationError } from "@roamlink/contracts";

import {
  asInstant,
  asEnum,
  asNullableString,
  asObject,
  asOptionalString,
  asString,
  rejectUnknownFields,
  requireFields,
} from "./parse-kit.js";

export const ENTERPRISE_ENROLLMENT_RESOURCE_STATES = [
  "draft",
  "submitted",
  "verified",
  "active",
  "rejected",
  "cancelled",
] as const;

export type EnterpriseEnrollmentResourceState =
  (typeof ENTERPRISE_ENROLLMENT_RESOURCE_STATES)[number];

export const ENTERPRISE_ENROLLMENT_REJECTION_RESOURCE_REASONS = [
  "requirements-unmet",
  "verification-failed",
  "duplicate-organization",
] as const;

export type EnterpriseEnrollmentRejectionResourceReason =
  (typeof ENTERPRISE_ENROLLMENT_REJECTION_RESOURCE_REASONS)[number];

export const ENTERPRISE_CONNECTOR_RESOURCE_STATES = [
  "provisioning",
  "provisioned",
  "failed",
  "revoked",
] as const;

export type EnterpriseConnectorResourceState =
  (typeof ENTERPRISE_CONNECTOR_RESOURCE_STATES)[number];

export const ENTERPRISE_CONNECTOR_FAILURE_RESOURCE_REASONS = [
  "connector-unavailable",
  "capability-negotiation-empty",
  "configuration-delivery-failed",
] as const;

export type EnterpriseConnectorFailureResourceReason =
  (typeof ENTERPRISE_CONNECTOR_FAILURE_RESOURCE_REASONS)[number];

/** The workspace identity section (from the acting tenant's organization). */
export interface EnterpriseWorkspaceOrganization {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly status: "active" | "suspended";
}

/** The enrollment journey record (mirrored state vocabulary). */
export interface EnterpriseEnrollmentView {
  readonly enrollmentId: string;
  readonly organizationName: string;
  readonly state: EnterpriseEnrollmentResourceState;
  readonly tenantId: string | null;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verifiedAt?: string;
  readonly activatedAt?: string;
  readonly rejectionReason?: EnterpriseEnrollmentRejectionResourceReason;
  readonly cancelledAt?: string;
}

/** The connector provisioning record (mirrored state vocabulary). */
export interface EnterpriseConnectorView {
  readonly provisioningId: string;
  readonly state: EnterpriseConnectorResourceState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly provisionedAt?: string;
  readonly failureReason?: EnterpriseConnectorFailureResourceReason;
  readonly revokedAt?: string;
}

/**
 * The customer workspace read: identity + enrollment journey + connector
 * status, side by side, each section honestly present or absent. This
 * resource carries NO connectivity facts - the workspace page renders
 * those from the SAME ConnectivityOverviewResource every other page uses
 * (enterprise UX creates no second connectivity authority).
 */
export interface EnterpriseWorkspaceResource {
  readonly presentedAt: string;
  readonly organization: EnterpriseWorkspaceOrganization | null;
  readonly enrollment: EnterpriseEnrollmentView | null;
  readonly connector: EnterpriseConnectorView | null;
}

function workspaceField(label: string, issue: string): never {
  throw new ValidationError(`EnterpriseWorkspaceResource rejected: ${label} - ${issue}`, {
    reason: "ENTERPRISE_WORKSPACE_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseOrganizationSection(label: string, value: unknown): EnterpriseWorkspaceOrganization | null {
  if (value === null || value === undefined) return null;
  const record = asObject(label, value);
  rejectUnknownFields(label, record, ["tenantId", "organizationId", "name", "status"]);
  requireFields(label, record, ["tenantId", "organizationId", "name", "status"]);
  return Object.freeze({
    tenantId: asString(`${label}.tenantId`, record["tenantId"]),
    organizationId: asString(`${label}.organizationId`, record["organizationId"]),
    name: asString(`${label}.name`, record["name"]),
    status: asEnum(`${label}.status`, ["active", "suspended"], record["status"]),
  });
}

function parseEnrollmentSection(label: string, value: unknown): EnterpriseEnrollmentView | null {
  if (value === null || value === undefined) return null;
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "enrollmentId",
    "organizationName",
    "state",
    "tenantId",
    "requestedBy",
    "createdAt",
    "updatedAt",
    "verifiedAt",
    "activatedAt",
    "rejectionReason",
    "cancelledAt",
  ]);
  requireFields(label, record, [
    "enrollmentId",
    "organizationName",
    "state",
    "requestedBy",
    "createdAt",
    "updatedAt",
  ]);
  const state = asEnum(
    `${label}.state`,
    ENTERPRISE_ENROLLMENT_RESOURCE_STATES,
    record["state"],
  );
  const rejectionReason =
    record["rejectionReason"] === null || record["rejectionReason"] === undefined
      ? undefined
      : (asEnum(
          `${label}.rejectionReason`,
          ENTERPRISE_ENROLLMENT_REJECTION_RESOURCE_REASONS,
          record["rejectionReason"],
        ) as EnterpriseEnrollmentRejectionResourceReason);
  return Object.freeze({
    enrollmentId: asString(`${label}.enrollmentId`, record["enrollmentId"]),
    organizationName: asString(`${label}.organizationName`, record["organizationName"]),
    state,
    tenantId: asNullableString(`${label}.tenantId`, record["tenantId"]),
    requestedBy: asString(`${label}.requestedBy`, record["requestedBy"]),
    createdAt: asInstant(`${label}.createdAt`, record["createdAt"]),
    updatedAt: asInstant(`${label}.updatedAt`, record["updatedAt"]),
    ...(asOptionalString(`${label}.verifiedAt`, record["verifiedAt"]) !== undefined
      ? { verifiedAt: asOptionalString(`${label}.verifiedAt`, record["verifiedAt"]) as string }
      : {}),
    ...(asOptionalString(`${label}.activatedAt`, record["activatedAt"]) !== undefined
      ? { activatedAt: asOptionalString(`${label}.activatedAt`, record["activatedAt"]) as string }
      : {}),
    ...(rejectionReason !== undefined ? { rejectionReason } : {}),
    ...(asOptionalString(`${label}.cancelledAt`, record["cancelledAt"]) !== undefined
      ? { cancelledAt: asOptionalString(`${label}.cancelledAt`, record["cancelledAt"]) as string }
      : {}),
  });
}

function parseConnectorSection(label: string, value: unknown): EnterpriseConnectorView | null {
  if (value === null || value === undefined) return null;
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "provisioningId",
    "state",
    "createdAt",
    "updatedAt",
    "provisionedAt",
    "failureReason",
    "revokedAt",
  ]);
  requireFields(label, record, ["provisioningId", "state", "createdAt", "updatedAt"]);
  const state = asEnum(
    `${label}.state`,
    ENTERPRISE_CONNECTOR_RESOURCE_STATES,
    record["state"],
  );
  const failureReason =
    record["failureReason"] === null || record["failureReason"] === undefined
      ? undefined
      : (asEnum(
          `${label}.failureReason`,
          ENTERPRISE_CONNECTOR_FAILURE_RESOURCE_REASONS,
          record["failureReason"],
        ) as EnterpriseConnectorFailureResourceReason);
  return Object.freeze({
    provisioningId: asString(`${label}.provisioningId`, record["provisioningId"]),
    state,
    createdAt: asInstant(`${label}.createdAt`, record["createdAt"]),
    updatedAt: asInstant(`${label}.updatedAt`, record["updatedAt"]),
    ...(asOptionalString(`${label}.provisionedAt`, record["provisionedAt"]) !== undefined
      ? { provisionedAt: asOptionalString(`${label}.provisionedAt`, record["provisionedAt"]) as string }
      : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
    ...(asOptionalString(`${label}.revokedAt`, record["revokedAt"]) !== undefined
      ? { revokedAt: asOptionalString(`${label}.revokedAt`, record["revokedAt"]) as string }
      : {}),
  });
}

/**
 * Fail-closed parser for the workspace read: unknown fields reject, state
 * vocabularies must be members of the mirrored closed sets, sections may
 * be explicitly null (honest not-started) but never malformed.
 */
export function parseEnterpriseWorkspaceResource(value: unknown): EnterpriseWorkspaceResource {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    workspaceField("$", "must be an object");
  }
  const record = value as Record<string, unknown>;
  rejectUnknownFields("EnterpriseWorkspaceResource", record, [
    "presentedAt",
    "organization",
    "enrollment",
    "connector",
  ]);
  requireFields("EnterpriseWorkspaceResource", record, [
    "presentedAt",
    "organization",
    "enrollment",
    "connector",
  ]);
  let parsed: EnterpriseWorkspaceResource;
  try {
    parsed = Object.freeze({
      presentedAt: asInstant("EnterpriseWorkspaceResource.presentedAt", record["presentedAt"]),
      organization: parseOrganizationSection(
        "EnterpriseWorkspaceResource.organization",
        record["organization"],
      ),
      enrollment: parseEnrollmentSection(
        "EnterpriseWorkspaceResource.enrollment",
        record["enrollment"],
      ),
      connector: parseConnectorSection(
        "EnterpriseWorkspaceResource.connector",
        record["connector"],
      ),
    });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    workspaceField("$", (error as Error).message);
  }
  return parsed;
}
