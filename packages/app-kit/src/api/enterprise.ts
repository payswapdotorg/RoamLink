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
 *  - organization policy read   <- packages/enterprise/src/policy.ts
 *    states                        (ORGANIZATION_POLICY_STATES)
 *  - organization policy source <- packages/enterprise/src/policy.ts
 *                                  (ORGANIZATION_POLICY_SOURCES)
 *  - enterprise integration     <- packages/enterprise/src/integrations.ts
 *    kinds                         (ENTERPRISE_INTEGRATION_KINDS)
 *  - enterprise integration     <- packages/enterprise/src/integrations.ts
 *    states                        (ENTERPRISE_INTEGRATION_STATES)
 *
 * PA-007 (closes RL-115-F7): the workspace read gains the READ-ONLY
 * organization policy section. The section is ADDITIVE on the wire
 * (RL-LOCK-017): an older payload without it parses to the honest null
 * section ("not available" - the workspace surface composes no policy
 * read), which stays DISTINCT from the explicit in-section absence states
 * (`not-configured` - an observation verified no policy upstream - and
 * `unknown` - no verified observation). RoamLink never duplicates
 * connectivity policy authority: the policy is enterprise/organization-
 * level configuration surfaced as a read model, so this mirror carries NO
 * policy command (the connector provision command remains the surface's
 * only mutation).
 *
 * PA-008 (closes RL-115-F5): the workspace read also gains the READ-ONLY
 * enterprise integrations section - one status view per §8 integration
 * kind (SSO / SCIM / MDM), each distinguishing EXACTLY four states
 * (configured / not-configured / unavailable / unknown). `unavailable` is
 * the honest missing-backend-contract state: the enterprise integration
 * API exposes no status read for that kind yet, so the view declares it
 * (carrying no observation) instead of fabricating a status or a
 * configuration control. The section is ADDITIVE on the wire
 * (RL-LOCK-017): an older payload without it parses to the honest null
 * section, and the customer surface degrades honestly from there (every
 * kind renders `unavailable` - never a guessed status, never a fake
 * control). The mirror carries NO integration command, OAuth dance, SCIM
 * endpoint field or MDM enrollment form: enterprise integrations are
 * organization-level configuration surfaced as a read model only.
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
import { parseFreshnessView, type FreshnessView } from "./resources.js";

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

export const ENTERPRISE_POLICY_RESOURCE_STATES = [
  "configured",
  "not-configured",
  "unknown",
] as const;

export type EnterprisePolicyResourceState = (typeof ENTERPRISE_POLICY_RESOURCE_STATES)[number];

export const ENTERPRISE_POLICY_RESOURCE_SOURCES = [
  "organization-administration",
] as const;

export type EnterprisePolicyResourceSource =
  (typeof ENTERPRISE_POLICY_RESOURCE_SOURCES)[number];

export const ENTERPRISE_INTEGRATION_RESOURCE_KINDS = ["sso", "scim", "mdm"] as const;

export type EnterpriseIntegrationResourceKind =
  (typeof ENTERPRISE_INTEGRATION_RESOURCE_KINDS)[number];

/**
 * The four honest integration states (the F5 closure contract): exactly
 * Configured | Not configured | Unavailable | Unknown, mirrored from the
 * owning domain vocabulary. `unavailable` declares that the enterprise
 * integration API exposes no status read for the kind yet (the honest
 * missing-backend-contract state).
 */
export const ENTERPRISE_INTEGRATION_RESOURCE_STATES = [
  "configured",
  "not-configured",
  "unavailable",
  "unknown",
] as const;

export type EnterpriseIntegrationResourceState =
  (typeof ENTERPRISE_INTEGRATION_RESOURCE_STATES)[number];

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
 * The READ-ONLY organization policy read (PA-007, closes RL-115-F7):
 * the current policy record with source, version, freshness and the
 * honest-absence states. `policyVersion`/`summary`/`effectiveAt` ride only
 * with a `configured` record (the owning domain record enforces this
 * fail-closed; the mirror parses the wire shape and the closed
 * vocabularies). Freshness is the SAME FreshnessView contract every other
 * read carries (never redefined here).
 */
export interface EnterprisePolicyView {
  readonly policyId: string;
  readonly state: EnterprisePolicyResourceState;
  /** Where the policy is managed upstream (closed vocabulary). */
  readonly source: EnterprisePolicyResourceSource;
  readonly policyVersion?: string;
  readonly summary?: string;
  readonly effectiveAt?: string;
  readonly freshness: FreshnessView;
}

/**
 * The READ-ONLY enterprise integration status view (PA-008, closes
 * RL-115-F5): one row per §8 integration kind. `summary` rides only with a
 * `configured` view (the owning domain record enforces this fail-closed;
 * the mirror parses the wire shape and the closed vocabularies). Freshness
 * is the SAME FreshnessView contract every other read carries (never
 * redefined here); an `unavailable` or `unknown` view carries no verified
 * observation.
 */
export interface EnterpriseIntegrationView {
  /** Which §8 integration this view speaks for (closed kind vocabulary). */
  readonly kind: EnterpriseIntegrationResourceKind;
  /** The observed status (closed four-state vocabulary). */
  readonly state: EnterpriseIntegrationResourceState;
  /** Human summary of the in-effect integration; present only when configured. */
  readonly summary?: string;
  readonly freshness: FreshnessView;
}

/**
 * The customer workspace read: identity + enrollment journey + connector
 * status + the READ-ONLY organization policy read + the READ-ONLY
 * enterprise integrations section, side by side, each section honestly
 * present or absent. This resource carries NO connectivity facts - the
 * workspace page renders those from the SAME ConnectivityOverviewResource
 * every other page uses (enterprise UX creates no second connectivity
 * authority).
 *
 * PA-007: `policy` is the additive RL-115-F7 closure section. A null
 * section (or an older payload without the field) is the honest
 * not-available state: the workspace surface composes no policy read -
 * never a guessed policy, never a collapsed absence.
 *
 * PA-008: `integrations` is the additive RL-115-F5 closure section. A null
 * section (or an older payload without the field) is the honest no-section
 * state: the workspace surface composes no integration status read, and
 * the page degrades honestly from there (each §8 kind renders the honest
 * `unavailable` state) - never a guessed status, never a fabricated
 * configuration control.
 */
export interface EnterpriseWorkspaceResource {
  readonly presentedAt: string;
  readonly organization: EnterpriseWorkspaceOrganization | null;
  readonly enrollment: EnterpriseEnrollmentView | null;
  readonly connector: EnterpriseConnectorView | null;
  readonly policy: EnterprisePolicyView | null;
  readonly integrations: readonly EnterpriseIntegrationView[] | null;
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

function parsePolicySection(label: string, value: unknown): EnterprisePolicyView | null {
  if (value === null || value === undefined) return null;
  const record = asObject(label, value);
  rejectUnknownFields(label, record, [
    "policyId",
    "state",
    "source",
    "policyVersion",
    "summary",
    "effectiveAt",
    "freshness",
  ]);
  requireFields(label, record, ["policyId", "state", "source", "freshness"]);
  return Object.freeze({
    policyId: asString(`${label}.policyId`, record["policyId"]),
    state: asEnum(`${label}.state`, ENTERPRISE_POLICY_RESOURCE_STATES, record["state"]),
    source: asEnum(`${label}.source`, ENTERPRISE_POLICY_RESOURCE_SOURCES, record["source"]),
    ...(asOptionalString(`${label}.policyVersion`, record["policyVersion"]) !== undefined
      ? { policyVersion: asOptionalString(`${label}.policyVersion`, record["policyVersion"]) as string }
      : {}),
    ...(asOptionalString(`${label}.summary`, record["summary"]) !== undefined
      ? { summary: asOptionalString(`${label}.summary`, record["summary"]) as string }
      : {}),
    ...(asOptionalString(`${label}.effectiveAt`, record["effectiveAt"]) !== undefined
      ? { effectiveAt: asOptionalString(`${label}.effectiveAt`, record["effectiveAt"]) as string }
      : {}),
    freshness: parseFreshnessView(`${label}.freshness`, record["freshness"]),
  });
}

function parseIntegrationsSection(
  label: string,
  value: unknown,
): readonly EnterpriseIntegrationView[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    workspaceField(label, "must be an array of integration status views (or null)");
  }
  const views: EnterpriseIntegrationView[] = [];
  const seenKinds = new Set<string>();
  value.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    const record = asObject(entryLabel, entry);
    rejectUnknownFields(entryLabel, record, ["kind", "state", "summary", "freshness"]);
    requireFields(entryLabel, record, ["kind", "state", "freshness"]);
    const kind = asEnum(
      `${entryLabel}.kind`,
      ENTERPRISE_INTEGRATION_RESOURCE_KINDS,
      record["kind"],
    );
    if (seenKinds.has(kind)) {
      workspaceField(entryLabel, `duplicate kind '${kind}' (exactly one status view per integration kind)`);
    }
    seenKinds.add(kind);
    views.push(
      Object.freeze({
        kind,
        state: asEnum(
          `${entryLabel}.state`,
          ENTERPRISE_INTEGRATION_RESOURCE_STATES,
          record["state"],
        ),
        ...(asOptionalString(`${entryLabel}.summary`, record["summary"]) !== undefined
          ? { summary: asOptionalString(`${entryLabel}.summary`, record["summary"]) as string }
          : {}),
        freshness: parseFreshnessView(`${entryLabel}.freshness`, record["freshness"]),
      }),
    );
  });
  return Object.freeze(views);
}

/**
 * Fail-closed parser for the workspace read: unknown fields reject, state
 * vocabularies must be members of the mirrored closed sets, sections may
 * be explicitly null (honest not-started) but never malformed. The policy
 * and integrations sections are additive (RL-LOCK-017): an older payload
 * without either parses to the honest null section.
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
    "policy",
    "integrations",
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
      policy: parsePolicySection("EnterpriseWorkspaceResource.policy", record["policy"]),
      integrations: parseIntegrationsSection(
        "EnterpriseWorkspaceResource.integrations",
        record["integrations"],
      ),
    });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    workspaceField("$", (error as Error).message);
  }
  return parsed;
}
