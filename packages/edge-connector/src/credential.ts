/**
 * Enterprise edge credential isolation contract (RL-044, spec/security.md
 * "Credential rules": edge credentials are SHORT-LIVED, DEVICE-BOUND,
 * NARROWLY SCOPED and REVOCABLE; RL-LOCK-016: no secret leakage).
 *
 * An {@link EdgeCredentialGrant} is the ONLY shape a credential may take on
 * the edge: a typed grant record carrying WHO (device binding), WHAT (closed
 * scope vocabulary), HOW LONG (bounded lifetime with a REQUIRED expiry), and
 * a SECRET REFERENCE - never the secret value. Key material enters a running
 * component only through the secrets boundary (RL-050); this contract is
 * deliberately incapable of transporting it.
 *
 * Enforcement (all typed, all fail-closed):
 *  - {@link parseEdgeCredentialGrant}: shape validation, non-empty scopes,
 *    required expiry STRICTLY after issuance, lifetime bounded by
 *    {@link MAX_EDGE_CREDENTIAL_TTL_MS};
 *  - {@link evaluateEdgeCredentialGrant}: the runtime check - expiry,
 *    revocation, device binding and scope membership all fail closed with
 *    typed reasons (never a silent pass).
 */
import {
  UnauthorizedError,
  ValidationError,
  compareUtcInstants,
  parseCanonicalUuidAs,
  parseUtcInstant,
  type Branded,
  type ContractVersion,
  type Revision,
  type UtcInstant,
} from "@roamlink/contracts";
import { parseEdgeDeviceRef, type EdgeDeviceRef } from "@roamlink/edge";

import {
  describeEdgeConnectorContractVersionExpectation,
  isEdgeConnectorRecordVersionCompatible,
} from "./version.js";
import { parseContractVersion } from "@roamlink/contracts";

/** Identity of a credential grant (locally generated UUID). */
export type EdgeCredentialGrantId = Branded<"EdgeCredentialGrantId">;

export function parseEdgeCredentialGrantId(value: unknown): EdgeCredentialGrantId {
  return parseCanonicalUuidAs<EdgeCredentialGrantId>(value, "EdgeCredentialGrantId");
}

/**
 * The closed credential-scope vocabulary. Scopes are deliberately narrow so
 * a compromised edge credential cannot, e.g., submit actions when it was
 * issued to upload observations (least privilege, spec/security.md).
 */
export const EDGE_CREDENTIAL_SCOPES = [
  "observation-upload",
  "action-submit",
  "configuration-read",
  "diagnostics-upload",
] as const;

export type EdgeCredentialScope = (typeof EDGE_CREDENTIAL_SCOPES)[number];

export function isEdgeCredentialScope(value: unknown): value is EdgeCredentialScope {
  return (
    typeof value === "string" && (EDGE_CREDENTIAL_SCOPES as readonly string[]).includes(value)
  );
}

export function parseEdgeCredentialScope(value: unknown): EdgeCredentialScope {
  if (!isEdgeCredentialScope(value)) {
    throw new ValidationError(
      "value is not a member of the closed edge-credential scope vocabulary (observation-upload, action-submit, configuration-read, diagnostics-upload)",
      {
        reason: "EDGE_CREDENTIAL_SCOPE_INVALID",
        details: [{ path: "EdgeCredentialScope", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/**
 * The maximum allowed credential lifetime (24h). Short-lived by contract:
 * a longer TTL is a validation error, never a warning.
 */
export const MAX_EDGE_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;

/** The minimum allowed lifetime (1s - a grant must actually be usable). */
export const MIN_EDGE_CREDENTIAL_TTL_MS = 1_000;

/**
 * A typed reference to the secret material backing a grant: a safe-label
 * NAME plus an optional PINNED VERSION (null = active version). Mirrors the
 * RL-050 `SecretRef` shape without importing the secrets package (the
 * connector contract depends only on contracts + edge). The reference is
 * log-safe; the material itself is resolvable ONLY through the secrets
 * boundary (RL-LOCK-016).
 */
export interface EdgeCredentialSecretRef {
  readonly name: string;
  readonly version: Revision | null;
}

const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

export function parseEdgeCredentialSecretRef(value: unknown): EdgeCredentialSecretRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("EdgeCredentialSecretRef must be an object with name and version", {
      reason: "EDGE_CREDENTIAL_SECRET_REF_INVALID",
      details: [{ path: "EdgeCredentialSecretRef", issue: "not an object" }],
    });
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "name" && key !== "version") {
      throw new ValidationError("EdgeCredentialSecretRef rejected an unknown field", {
        reason: "EDGE_CREDENTIAL_SECRET_REF_INVALID",
        details: [{ path: key, issue: "unknown field" }],
      });
    }
  }
  const name = record["name"];
  if (typeof name !== "string" || !SECRET_NAME_PATTERN.test(name)) {
    throw new ValidationError(
      "EdgeCredentialSecretRef.name must be a safe label (1-64 chars) - key material is never a field (RL-LOCK-016)",
      {
        reason: "EDGE_CREDENTIAL_SECRET_REF_INVALID",
        details: [{ path: "name", issue: "not a safe label" }],
      },
    );
  }
  let version: Revision | null = null;
  if (record["version"] !== null && record["version"] !== undefined) {
    if (typeof record["version"] !== "number" || !Number.isInteger(record["version"]) || record["version"] < 1) {
      throw new ValidationError("EdgeCredentialSecretRef.version must be a positive integer or null", {
        reason: "EDGE_CREDENTIAL_SECRET_REF_INVALID",
        details: [{ path: "version", issue: "not a positive integer" }],
      });
    }
    version = record["version"] as Revision;
  }
  return Object.freeze({ name, version });
}

/** Input accepted by {@link parseEdgeCredentialGrant}. */
export interface EdgeCredentialGrantInput {
  readonly grantId: string;
  readonly contractVersion: string;
  /** The device the grant is bound to (device binding, spec/security.md). */
  readonly deviceRef: string;
  readonly scopes: readonly unknown[];
  readonly issuedAt: string;
  /** REQUIRED expiry, strictly after issuance, bounded by the max TTL. */
  readonly expiresAt: string;
  /** Instant the grant was revoked, when it was; absent = active. */
  readonly revokedAt?: string | null;
  readonly secretRef: { readonly name: string; readonly version?: number | null };
}

/** The parsed, frozen credential grant. */
export interface EdgeCredentialGrant {
  readonly grantId: EdgeCredentialGrantId;
  readonly contractVersion: ContractVersion;
  readonly deviceRef: EdgeDeviceRef;
  readonly scopes: readonly EdgeCredentialScope[];
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly revokedAt: UtcInstant | null;
  readonly secretRef: EdgeCredentialSecretRef;
}

function field(label: string, issue: string): never {
  throw new ValidationError(`EdgeCredentialGrant rejected: ${label} - ${issue}`, {
    reason: "EDGE_CREDENTIAL_GRANT_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * Parses and freezes a credential grant. Enforces the contract invariants:
 * non-empty closed-vocabulary scopes, required expiry strictly after issuance
 * with a lifetime bounded by {@link MAX_EDGE_CREDENTIAL_TTL_MS}, a typed
 * secret REFERENCE (never material), and revocation timestamps not before
 * issuance.
 */
export function parseEdgeCredentialGrant(value: unknown): EdgeCredentialGrant {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (
      ![
        "grantId",
        "contractVersion",
        "deviceRef",
        "scopes",
        "issuedAt",
        "expiresAt",
        "revokedAt",
        "secretRef",
      ].includes(key)
    ) {
      field(key, "unknown field (the grant carries exactly its contract fields)");
    }
  }

  let grantId: EdgeCredentialGrantId;
  try {
    grantId = parseEdgeCredentialGrantId(input["grantId"]);
  } catch {
    field("grantId", "must be a canonical lowercase UUID");
  }
  let contractVersion: ContractVersion;
  try {
    contractVersion = parseContractVersion(input["contractVersion"]);
  } catch {
    field("contractVersion", "must be a MAJOR.MINOR contract version");
  }
  if (!isEdgeConnectorRecordVersionCompatible(contractVersion)) {
    field("contractVersion", describeEdgeConnectorContractVersionExpectation());
  }
  let deviceRef: EdgeDeviceRef;
  try {
    deviceRef = parseEdgeDeviceRef(input["deviceRef"]);
  } catch {
    field("deviceRef", "must be a non-empty safe device reference (device binding)");
  }
  if (!Array.isArray(input["scopes"])) {
    field("scopes", "must be an array of closed-vocabulary scopes");
  }
  const scopes = input["scopes"] as unknown[];
  if (scopes.length === 0) {
    field("scopes", "must carry at least one scope (narrowly scoped, never ambient)");
  }
  const seenScopes = new Set<EdgeCredentialScope>();
  for (const scope of scopes) {
    if (!isEdgeCredentialScope(scope)) {
      field("scopes", "every scope must be a member of the closed credential-scope vocabulary");
    }
    seenScopes.add(scope);
  }
  let issuedAt: UtcInstant;
  try {
    issuedAt = parseUtcInstant(input["issuedAt"]);
  } catch {
    field("issuedAt", "must be a UTC instant with an explicit zone designator");
  }
  let expiresAt: UtcInstant;
  try {
    expiresAt = parseUtcInstant(input["expiresAt"]);
  } catch {
    field("expiresAt", "must be a UTC instant (expiry is REQUIRED - short-lived by contract)");
  }
  if (compareUtcInstants(expiresAt, issuedAt) <= 0) {
    field("expiresAt", "must be strictly after issuedAt");
  }
  const ttlMs =
    Date.parse(expiresAt) - Date.parse(issuedAt);
  if (ttlMs < MIN_EDGE_CREDENTIAL_TTL_MS || ttlMs > MAX_EDGE_CREDENTIAL_TTL_MS) {
    field(
      "expiresAt",
      `the credential lifetime must be between 1s and ${MAX_EDGE_CREDENTIAL_TTL_MS}ms (short-lived, spec/security.md)`,
    );
  }
  let revokedAt: UtcInstant | null = null;
  if (input["revokedAt"] !== null && input["revokedAt"] !== undefined) {
    try {
      revokedAt = parseUtcInstant(input["revokedAt"]);
    } catch {
      field("revokedAt", "must be null or a UTC instant");
    }
    if (compareUtcInstants(revokedAt, issuedAt) < 0) {
      field("revokedAt", "must not precede issuance");
    }
  }
  let secretRef: EdgeCredentialSecretRef;
  try {
    secretRef = parseEdgeCredentialSecretRef(input["secretRef"]);
  } catch (error) {
    if (error instanceof ValidationError) {
      field("secretRef", error.message);
    }
    throw error;
  }

  return Object.freeze({
    grantId,
    contractVersion,
    deviceRef,
    scopes: Object.freeze([...seenScopes]),
    issuedAt,
    expiresAt,
    revokedAt,
    secretRef,
  });
}

/** Typed reasons a credential usage was refused (fail-closed). */
export const EDGE_CREDENTIAL_DENY_REASONS = [
  "grant-expired",
  "grant-revoked",
  "grant-not-yet-valid",
  "device-binding-mismatch",
  "scope-not-granted",
] as const;

export type EdgeCredentialDenyReason = (typeof EDGE_CREDENTIAL_DENY_REASONS)[number];

/** A validated credential usage (the pass result). */
export interface EdgeCredentialUsage {
  readonly grantId: EdgeCredentialGrantId;
  readonly scope: EdgeCredentialScope;
  readonly deviceRef: EdgeDeviceRef;
  readonly usedAt: UtcInstant;
}

/**
 * The runtime credential check. Validates the grant for `scope` on behalf of
 * `deviceRef` as of `at`: expiry, revocation, not-yet-valid issuance, device
 * binding and scope membership - each failing closed with a TYPED
 * UnauthorizedError carrying the closed-vocabulary deny reason. Never a
 * silent pass; never leaks grant internals in the error (RL-LOCK-016).
 */
export function evaluateEdgeCredentialGrant(
  grant: EdgeCredentialGrant,
  scope: EdgeCredentialScope,
  deviceRef: EdgeDeviceRef | string,
  at: UtcInstant | string,
): EdgeCredentialUsage {
  const instant = parseUtcInstant(at);
  const boundDevice = parseEdgeDeviceRef(deviceRef);
  const parsedScope = parseEdgeCredentialScope(scope);

  if (compareUtcInstants(instant, grant.issuedAt) < 0) {
    throw new UnauthorizedError("the credential grant is not yet valid", {
      reason: "EDGE_CREDENTIAL_DENIED",
      details: [{ path: "grant", issue: "grant-not-yet-valid" }],
    });
  }
  if (compareUtcInstants(instant, grant.expiresAt) >= 0) {
    throw new UnauthorizedError("the credential grant has expired (short-lived by contract)", {
      reason: "EDGE_CREDENTIAL_DENIED",
      details: [{ path: "grant", issue: "grant-expired" }],
    });
  }
  if (grant.revokedAt !== null && compareUtcInstants(instant, grant.revokedAt) >= 0) {
    throw new UnauthorizedError("the credential grant has been revoked", {
      reason: "EDGE_CREDENTIAL_DENIED",
      details: [{ path: "grant", issue: "grant-revoked" }],
    });
  }
  if (grant.deviceRef !== boundDevice) {
    throw new UnauthorizedError(
      "the credential grant is bound to a different device (device binding, spec/security.md)",
      {
        reason: "EDGE_CREDENTIAL_DENIED",
        details: [{ path: "grant.deviceRef", issue: "device-binding-mismatch" }],
      },
    );
  }
  if (!grant.scopes.includes(parsedScope)) {
    throw new UnauthorizedError(
      "the requested scope was not granted to this credential (least privilege)",
      {
        reason: "EDGE_CREDENTIAL_DENIED",
        details: [{ path: "grant.scopes", issue: "scope-not-granted" }],
      },
    );
  }
  return Object.freeze({
    grantId: grant.grantId,
    scope: parsedScope,
    deviceRef: boundDevice,
    usedAt: instant,
  });
}
