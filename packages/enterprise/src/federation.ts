/**
 * Tenant federation setup (RL-063) - REFERENCE-ONLY identity (RL-LOCK-003).
 *
 * RoamLink may own customer/user/org identity for the experience domain, but
 * it must NOT redefine ADCOS NodeID, credentials or cryptographic identity
 * semantics - and the enterprise identity story is the same shape of rule:
 * an enterprise tenant's identity lives in ITS identity provider; RoamLink
 * keeps only REFERENCES. A {@link TenantFederationRecord} therefore carries:
 *
 *  - WHICH protocol the tenant federates through (closed vocabulary);
 *  - WHERE the tenant's identity authority lives (a bounded issuer
 *    reference - an opaque locator string, not a credential);
 *  - lifecycle status.
 *
 * It structurally CANNOT carry: user accounts, credentials, assertions,
 * tokens, ADCOS NodeIDs, session ids or anything that could authenticate or
 * authorize anyone. There is no `verifyAssertion` here either - validating a
 * federated assertion is the auth boundary's concern (a later wave binds the
 * verifier); this record is configuration metadata ONLY. The parser's closed
 * field set is the negative proof: an attempt to smuggle identity material
 * is rejected as an unknown field (RL-LOCK-018 - tests prove architecture).
 */
import {
  ValidationError,
  parseContractVersion,
  parseRevision,
  parseTenantId,
  parseUtcInstant,
  type ContractVersion,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import { parseTenantFederationId, type TenantFederationId } from "./ids.js";
import {
  describeEnterpriseContractVersionExpectation,
  isEnterpriseRecordVersionCompatible,
} from "./version.js";

/** The closed federation-protocol vocabulary. */
export const TENANT_FEDERATION_PROTOCOLS = ["saml", "oidc", "scim"] as const;

export type TenantFederationProtocol = (typeof TENANT_FEDERATION_PROTOCOLS)[number];

export function isTenantFederationProtocol(value: unknown): value is TenantFederationProtocol {
  return (
    typeof value === "string" &&
    (TENANT_FEDERATION_PROTOCOLS as readonly string[]).includes(value)
  );
}

/** The closed federation-link lifecycle vocabulary. */
export const TENANT_FEDERATION_STATES = ["configured", "disabled"] as const;

export type TenantFederationState = (typeof TENANT_FEDERATION_STATES)[number];

export function isTenantFederationState(value: unknown): value is TenantFederationState {
  return (
    typeof value === "string" &&
    (TENANT_FEDERATION_STATES as readonly string[]).includes(value)
  );
}

const ISSUER_REFERENCE_PATTERN = /^(https:\/\/|urn:)[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{1,253}$/;
const MAX_TENANT_LABEL_LENGTH = 64;

/** Serialized (plain) form of a tenant federation link. */
export interface TenantFederationRecord {
  readonly federationId: TenantFederationId;
  readonly contractVersion: ContractVersion;
  /** The tenant whose identity federation this record configures. */
  readonly tenantId: TenantId;
  readonly protocol: TenantFederationProtocol;
  /**
   * Opaque locator reference for the tenant's identity authority (e.g. an
   * issuer/entity-id URL). A REFERENCE ONLY - never a credential, never a
   * key, never an endpoint secret.
   */
  readonly issuerReference: string;
  readonly state: TenantFederationState;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by {@link parseTenantFederationRecord}. */
export interface TenantFederationInput {
  readonly federationId: string;
  readonly contractVersion: string;
  readonly tenantId: string;
  readonly protocol: string;
  readonly issuerReference: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_FIELDS = new Set([
  "federationId",
  "contractVersion",
  "tenantId",
  "protocol",
  "issuerReference",
  "state",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`TenantFederationRecord rejected: ${label} - ${issue}`, {
    reason: "TENANT_FEDERATION_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * Parses and freezes a tenant federation link. The field set is CLOSED and
 * deliberately minimal: any attempt to attach identity material (credentials,
 * tokens, user directories, ADCOS node ids, session material...) is rejected
 * as an unknown field - the structural reference-only proof.
 */
export function parseTenantFederationRecord(value: unknown): TenantFederationRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      field(
        key,
        "unknown field (a federation link is REFERENCE-ONLY configuration: protocol + issuer reference + lifecycle; identity material is structurally rejected, RL-LOCK-003)",
      );
    }
  }

  let federationId: TenantFederationId;
  try {
    federationId = parseTenantFederationId(input["federationId"]);
  } catch {
    field("federationId", "must be a canonical lowercase UUID");
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
  let tenantId: TenantId;
  try {
    tenantId = parseTenantId(input["tenantId"]);
  } catch {
    field("tenantId", "must be a RoamLink tenant id");
  }
  if (!isTenantFederationProtocol(input["protocol"])) {
    field("protocol", "must be a member of the closed federation-protocol vocabulary (saml, oidc, scim)");
  }
  const issuerReference = input["issuerReference"];
  if (
    typeof issuerReference !== "string" ||
    issuerReference.length > MAX_TENANT_LABEL_LENGTH * 4 ||
    !ISSUER_REFERENCE_PATTERN.test(issuerReference)
  ) {
    field("issuerReference", "must be a bounded URI-formatted locator reference (a reference, never a credential)");
  }
  if (!isTenantFederationState(input["state"])) {
    field("state", "must be a member of the closed federation-state vocabulary");
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

  return Object.freeze({
    federationId,
    contractVersion,
    tenantId,
    protocol: input["protocol"] as TenantFederationProtocol,
    issuerReference,
    state: input["state"] as TenantFederationState,
    createdAt,
    updatedAt,
    revision,
  });
}

/**
 * A display-safe reference view of a federation link. Exists to make the
 * reference-only guarantee explicit for API surfaces: everything a customer
 * may see about their federation is HERE, and none of it can authenticate
 * anyone.
 */
export interface FederationReferenceView {
  readonly federationId: TenantFederationId;
  readonly tenantId: TenantId;
  readonly protocol: TenantFederationProtocol;
  readonly issuerReference: string;
  readonly state: TenantFederationState;
}

export function federationReferenceView(record: TenantFederationRecord): FederationReferenceView {
  return Object.freeze({
    federationId: record.federationId,
    tenantId: record.tenantId,
    protocol: record.protocol,
    issuerReference: record.issuerReference,
    state: record.state,
  });
}

/**
 * Pure lifecycle toggle: configured <-> disabled. Any other "transition" is
 * rejected - federation links have no richer state machine because they are
 * configuration records, not identity sessions.
 */
export function setTenantFederationState(
  record: TenantFederationRecord,
  state: TenantFederationState,
  at: UtcInstant | string,
): TenantFederationRecord {
  const instant = parseUtcInstant(at);
  if (record.state === state) return record;
  return parseTenantFederationRecord({
    ...record,
    state,
    updatedAt: instant,
    revision: record.revision + 1,
  });
}
