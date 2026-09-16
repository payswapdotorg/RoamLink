/**
 * Enterprise API keys + scoped service authorization (RL-063, spec/security.md
 * "Credential rules"; RL-LOCK-016 - no secret leakage).
 *
 * An {@link EnterpriseApiKeyRecord} is the CUSTOMER-FACING key handle: a
 * name, a closed-vocabulary scope set, lifecycle status and rotation
 * metadata. The KEY MATERIAL never appears in the record, in errors, in
 * audit events or in any persisted view: the record carries a typed
 * {@link SecretRef} into the RL-050 secrets boundary, exactly like the edge
 * credential grants (RL-044). Material is generated ONCE at issuance (or
 * rotation), registered through the boundary's provisioning port, shown to
 * the customer ONCE wrapped in {@link SecretMaterial}, and thereafter only
 * ever compared in constant time during verification.
 *
 * Scoping is fail-closed: `authorizeServiceRequest` denies a request whose
 * required scope is not granted, whose key is revoked, or whose secret
 * cannot be resolved - never a silent pass. Rotation appends a secret
 * VERSION through the boundary (pinned consumers keep working until the old
 * version is retired); revocation fails the record check before any secret
 * is even resolved.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  ConflictError,
  UnauthorizedError,
  ValidationError,
  parseRevision,
  parseTenantId,
  parseUtcInstant,
  type ContractVersion,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";
import { SecretMaterial } from "@roamlink/secrets";
import type { SecretsResolver, SecretRef } from "@roamlink/secrets";

import { parseEnterpriseApiKeyId, type EnterpriseApiKeyId } from "./ids.js";
import { parseContractVersion } from "@roamlink/contracts";
import {
  describeEnterpriseContractVersionExpectation,
  isEnterpriseRecordVersionCompatible,
} from "./version.js";
import { parseSecretRef } from "@roamlink/secrets";

/** The closed service-authorization scope vocabulary. */
export const ENTERPRISE_API_KEY_SCOPES = [
  "organization:read",
  "devices:read",
  "devices:write",
  "connectivity:read",
  "experience-intents:read",
  "experience-intents:write",
  "orders:read",
  "enrollments:manage",
  "webhooks:manage",
  "api-keys:manage",
] as const;

export type EnterpriseApiScope = (typeof ENTERPRISE_API_KEY_SCOPES)[number];

export function isEnterpriseApiScope(value: unknown): value is EnterpriseApiScope {
  return (
    typeof value === "string" &&
    (ENTERPRISE_API_KEY_SCOPES as readonly string[]).includes(value)
  );
}

/** The closed API-key lifecycle vocabulary. */
export const ENTERPRISE_API_KEY_STATUSES = ["active", "revoked"] as const;

export type EnterpriseApiKeyStatus = (typeof ENTERPRISE_API_KEY_STATUSES)[number];

export function isEnterpriseApiKeyStatus(value: unknown): value is EnterpriseApiKeyStatus {
  return (
    typeof value === "string" &&
    (ENTERPRISE_API_KEY_STATUSES as readonly string[]).includes(value)
  );
}

/** Prefix for generated key material (recognizable, never secret-shaped key names in records). */
export const ENTERPRISE_API_KEY_MATERIAL_PREFIX = "rlk_live_";

/** The material grammar: prefix + key id (32 hex, no dashes) + "." + secret hex. */
const MATERIAL_PATTERN = /^rlk_live_([0-9a-f]{32})\.([0-9a-f]{64,128})$/;

/**
 * Generates fresh key material for a key id: `rlk_live_<keyId-hex>.<secret>`.
 * The embedded key id makes authentication self-describing (the record is
 * locatable from the presented material); the secret tail is 32 random
 * bytes hex. The MATERIAL is only ever shown once at issuance/rotation.
 */
export function generateEnterpriseApiKeyMaterial(keyId: string): string {
  const compact = keyId.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new ValidationError(
      "key material can only be generated for a canonical lowercase UUID key id",
      { reason: "ENTERPRISE_API_KEY_MATERIAL_INVALID" },
    );
  }
  return `${ENTERPRISE_API_KEY_MATERIAL_PREFIX}${compact}.${randomBytes(32).toString("hex")}`;
}

/** Extracts the key id (dashes restored) embedded in presented material. */
export function enterpriseApiKeyIdFromMaterial(material: string): string {
  const match = MATERIAL_PATTERN.exec(material);
  if (match === null || match[1] === undefined) {
    throw new UnauthorizedError(
      "the presented material is not a RoamLink enterprise API key",
      {
        reason: "ENTERPRISE_API_KEY_DENIED",
        details: [{ path: "material", issue: "material-mismatch" }],
      },
    );
  }
  const compact = match[1];
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20, 32),
  ].join("-");
}

/** Serialized (plain) form of an enterprise API key record. */
export interface EnterpriseApiKeyRecord {
  readonly keyId: EnterpriseApiKeyId;
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  /** Human-readable, non-secret label for the key. */
  readonly name: string;
  /** Non-empty subset of the closed scope vocabulary (least privilege). */
  readonly scopes: readonly EnterpriseApiScope[];
  /**
   * Reference into the RL-050 secrets boundary - NEVER key material. Named
   * `keyRef` so persisted records stay RL-054 scanner-clean (the scanner
   * flags secret-SHAPED key names; the value here is a log-safe reference).
   */
  readonly keyRef: SecretRef;
  readonly status: EnterpriseApiKeyStatus;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
  readonly lastRotatedAt?: UtcInstant;
  readonly revokedAt?: UtcInstant;
}

/** Input accepted by {@link parseEnterpriseApiKeyRecord}. */
export interface EnterpriseApiKeyInput {
  readonly keyId: string;
  readonly contractVersion: string;
  readonly tenantId: string;
  readonly name: string;
  readonly scopes: readonly unknown[];
  readonly keyRef: { readonly name: string; readonly version?: number | null };
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly lastRotatedAt?: string;
  readonly revokedAt?: string;
}

const ALLOWED_FIELDS = new Set([
  "keyId",
  "contractVersion",
  "tenantId",
  "name",
  "scopes",
  "keyRef",
  "status",
  "createdAt",
  "updatedAt",
  "revision",
  "lastRotatedAt",
  "revokedAt",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`EnterpriseApiKeyRecord rejected: ${label} - ${issue}`, {
    reason: "ENTERPRISE_API_KEY_INVALID",
    details: [{ path: label, issue }],
  });
}

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The provisioning seam of the secrets boundary: registers/rotates the
 * material behind a typed name. Production binds a vault adapter; tests bind
 * the in-memory fake. Values pass through here ONCE (mirrors provisioning).
 */
export interface EnterpriseSecretRegistrar {
  /** Registers the first version of a secret; returns the version. */
  register(name: string, material: string): Promise<number>;
  /** Appends the next version and makes it active; returns the version. */
  rotate(name: string, material: string): Promise<number>;
}

/** Generates fresh key material (bounded, printable, high entropy). */
export type EnterpriseApiKeyMaterialGenerator = () => string;

/** The secret NAME an API key's material lives under (safe label by shape). */
export function enterpriseApiKeySecretName(keyId: string): string {
  const name = `enterprise.api-key.${keyId}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/.test(name)) {
    throw new ValidationError(
      "the derived API-key secret name is not a safe label (key ids are canonical UUIDs)",
      { reason: "ENTERPRISE_API_KEY_SECRET_NAME_INVALID" },
    );
  }
  return name;
}

/**
 * Parses and freezes an enterprise API key record. Fail-closed on unknown
 * fields, non-closed-vocabulary scopes, empty scope sets (ambient authority
 * is forbidden) and unknown secret references.
 */
export function parseEnterpriseApiKeyRecord(value: unknown): EnterpriseApiKeyRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      field(key, "unknown field (the key record carries exactly its contract fields; key MATERIAL is never a field - RL-LOCK-016)");
    }
  }

  let keyId: EnterpriseApiKeyId;
  try {
    keyId = parseEnterpriseApiKeyId(input["keyId"]);
  } catch {
    field("keyId", "must be a canonical lowercase UUID");
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
  const name = input["name"];
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 64 ||
    name !== name.trim() ||
    hasControlCharacter(name)
  ) {
    field("name", "must be a trimmed, printable, non-secret label of 1-64 chars");
  }
  if (!Array.isArray(input["scopes"]) || (input["scopes"] as unknown[]).length === 0) {
    field("scopes", "must be a non-empty array of closed-vocabulary scopes (never ambient)");
  }
  const scopes: EnterpriseApiScope[] = [];
  const seen = new Set<EnterpriseApiScope>();
  for (const scope of input["scopes"] as readonly unknown[]) {
    if (!isEnterpriseApiScope(scope)) {
      field("scopes", "every scope must be a member of the closed service-authorization vocabulary");
    }
    if (!seen.has(scope)) {
      seen.add(scope);
      scopes.push(scope);
    }
  }
  let keyRef: SecretRef;
  try {
    keyRef = parseSecretRef(input["keyRef"]);
  } catch (error) {
    if (error instanceof ValidationError) {
      field("keyRef", error.message);
    }
    throw error;
  }
  if (!isEnterpriseApiKeyStatus(input["status"])) {
    field("status", "must be a member of the closed API-key lifecycle vocabulary");
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
  let lastRotatedAt: UtcInstant | undefined;
  if (input["lastRotatedAt"] !== undefined) {
    try {
      lastRotatedAt = parseUtcInstant(input["lastRotatedAt"]);
    } catch {
      field("lastRotatedAt", "must be a UTC instant with an explicit zone designator");
    }
  }
  let revokedAt: UtcInstant | undefined;
  if (input["revokedAt"] !== undefined) {
    try {
      revokedAt = parseUtcInstant(input["revokedAt"]);
    } catch {
      field("revokedAt", "must be a UTC instant with an explicit zone designator");
    }
  }
  if (input["status"] === "revoked" && revokedAt === undefined) {
    field("revokedAt", "a revoked key must carry its revocation instant");
  }
  if (input["status"] === "active" && revokedAt !== undefined) {
    field("revokedAt", "only a revoked key carries a revocation instant");
  }

  return Object.freeze({
    keyId,
    contractVersion,
    tenantId,
    name: name as string,
    scopes: Object.freeze(scopes),
    keyRef,
    status: input["status"] as EnterpriseApiKeyStatus,
    createdAt,
    updatedAt,
    revision,
    ...(lastRotatedAt !== undefined ? { lastRotatedAt } : {}),
    ...(revokedAt !== undefined ? { revokedAt } : {}),
  });
}

/** What an issuance or rotation returns: the record + the material ONCE. */
export interface EnterpriseApiKeyIssuance {
  readonly record: EnterpriseApiKeyRecord;
  /** Shown to the customer exactly once; serializes to "[REDACTED]". */
  readonly material: SecretMaterial;
}

/**
 * Issues a new enterprise API key: material is generated, registered through
 * the secrets-boundary provisioning port, and the record keeps only the
 * typed reference. `verifyEnterpriseApiKey` is the only later reader.
 */
export async function issueEnterpriseApiKey(
  input: {
    readonly keyId: string;
    readonly tenantId: string;
    readonly name: string;
    readonly scopes: readonly string[];
    readonly contractVersion?: string;
  },
  registrar: EnterpriseSecretRegistrar,
  at: UtcInstant | string,
  materialGenerator?: EnterpriseApiKeyMaterialGenerator,
): Promise<EnterpriseApiKeyIssuance> {
  const instant = parseUtcInstant(at);
  const generate = materialGenerator ?? (() => generateEnterpriseApiKeyMaterial(input.keyId));
  const record = parseEnterpriseApiKeyRecord({
    keyId: input.keyId,
    contractVersion: input.contractVersion ?? "0.1",
    tenantId: input.tenantId,
    name: input.name,
    scopes: input.scopes,
    keyRef: { name: enterpriseApiKeySecretName(input.keyId), version: null },
    status: "active",
    createdAt: instant,
    updatedAt: instant,
    revision: 1,
  });
  const material = generate();
  if (typeof material !== "string" || material.length < 32 || material.length > 256) {
    throw new ValidationError(
      "generated API-key material must be a bounded high-entropy string (32-256 chars)",
      { reason: "ENTERPRISE_API_KEY_MATERIAL_INVALID" },
    );
  }
  await registrar.register(record.keyRef.name, material);
  return { record, material: new SecretMaterial(material) };
}

/**
 * Rotates an ACTIVE key: appends the next secret version through the
 * boundary and moves the record's reference to the new active version. The
 * previously issued material stops verifying once the boundary retires the
 * old version; pinned resolution elsewhere keeps working until then.
 */
export async function rotateEnterpriseApiKey(
  record: EnterpriseApiKeyRecord,
  registrar: EnterpriseSecretRegistrar,
  at: UtcInstant | string,
  materialGenerator?: EnterpriseApiKeyMaterialGenerator,
): Promise<EnterpriseApiKeyIssuance> {
  const instant = parseUtcInstant(at);
  if (record.status !== "active") {
    throw new ConflictError("only an active API key may be rotated", {
      reason: "ENTERPRISE_API_KEY_ROTATE_INVALID",
    });
  }
  const generate = materialGenerator ?? (() => generateEnterpriseApiKeyMaterial(record.keyId));
  const material = generate();
  if (typeof material !== "string" || material.length < 32 || material.length > 256) {
    throw new ValidationError(
      "generated API-key material must be a bounded high-entropy string (32-256 chars)",
      { reason: "ENTERPRISE_API_KEY_MATERIAL_INVALID" },
    );
  }
  const version = await registrar.rotate(record.keyRef.name, material);
  const nextRecord = parseEnterpriseApiKeyRecord({
    ...record,
    keyRef: { name: record.keyRef.name, version },
    updatedAt: instant,
    revision: record.revision + 1,
    lastRotatedAt: instant,
  });
  return { record: nextRecord, material: new SecretMaterial(material) };
}

/** Revokes a key (idempotent). The record check fails closed thereafter. */
export function revokeEnterpriseApiKey(
  record: EnterpriseApiKeyRecord,
  at: UtcInstant | string,
): EnterpriseApiKeyRecord {
  const instant = parseUtcInstant(at);
  if (record.status === "revoked") return record;
  return parseEnterpriseApiKeyRecord({
    ...record,
    status: "revoked",
    revokedAt: instant,
    updatedAt: instant,
    revision: record.revision + 1,
  });
}

/** Closed reasons a presented key was denied (fail-closed service auth). */
export const ENTERPRISE_API_KEY_DENY_REASONS = [
  "key-revoked",
  "scope-not-granted",
  "secret-unresolvable",
  "material-mismatch",
] as const;

export type EnterpriseApiKeyDenyReason = (typeof ENTERPRISE_API_KEY_DENY_REASONS)[number];

/** The outcome of one service-authorization decision. */
export type ServiceAuthorizationDecision =
  | { readonly decision: "allow"; readonly keyId: EnterpriseApiKeyId; readonly scope: EnterpriseApiScope }
  | { readonly decision: "deny"; readonly reason: EnterpriseApiKeyDenyReason };

/**
 * Scoped service authorization over an API key RECORD: the closed-vocabulary
 * check that runs before any enterprise API handler touches state. Pure and
 * fail-closed - the ONLY allow path is an active key whose granted scopes
 * contain the required scope.
 */
export function authorizeServiceRequest(
  record: EnterpriseApiKeyRecord,
  requiredScope: EnterpriseApiScope,
): ServiceAuthorizationDecision {
  if (record.status !== "active") {
    return { decision: "deny", reason: "key-revoked" };
  }
  if (!record.scopes.includes(requiredScope)) {
    return { decision: "deny", reason: "scope-not-granted" };
  }
  return { decision: "allow", keyId: record.keyId, scope: requiredScope };
}

/** HMAC key over which presented material is compared (never stored). */
function hmacOf(material: string): Uint8Array {
  const mac = createHmac("sha256", "roamlink-enterprise-api-key-verification")
    .update(material, "utf8")
    .digest();
  return new Uint8Array(mac);
}

/** Constant-time equality of two HMAC digests of presented material. */
export function enterpriseApiKeyMaterialMatches(
  presented: string,
  resolved: string,
): boolean {
  const a = hmacOf(presented);
  const b = hmacOf(resolved);
  return timingSafeEqual(a, b);
}

/**
 * Verifies presented key material against a record: resolves the secret
 * through the RL-050 boundary (pinned or active per the record's reference)
 * and compares in constant time. ANY failure is a typed UnauthorizedError
 * whose message names ONLY the deny reason - never the material
 * (RL-LOCK-016). A revoked record fails before any secret is resolved.
 */
export async function verifyEnterpriseApiKeyMaterial(
  record: EnterpriseApiKeyRecord,
  presentedMaterial: string,
  resolver: SecretsResolver,
): Promise<void> {
  if (record.status !== "active") {
    throw new UnauthorizedError("the enterprise API key has been revoked", {
      reason: "ENTERPRISE_API_KEY_DENIED",
      details: [{ path: "status", issue: "key-revoked" }],
    });
  }
  if (typeof presentedMaterial !== "string" || presentedMaterial.length === 0) {
    throw new UnauthorizedError("an enterprise API key material is required", {
      reason: "ENTERPRISE_API_KEY_DENIED",
      details: [{ path: "material", issue: "material-mismatch" }],
    });
  }
  let resolvedMaterial: string;
  try {
    const resolved = await resolver.resolve(record.keyRef);
    resolvedMaterial = resolved.material.value;
  } catch {
    throw new UnauthorizedError(
      "the enterprise API key material could not be resolved through the secrets boundary",
      {
        reason: "ENTERPRISE_API_KEY_DENIED",
        details: [{ path: "secretRef", issue: "secret-unresolvable" }],
      },
    );
  }
  if (!enterpriseApiKeyMaterialMatches(presentedMaterial, resolvedMaterial)) {
    throw new UnauthorizedError("the presented enterprise API key material does not match", {
      reason: "ENTERPRISE_API_KEY_DENIED",
      details: [{ path: "material", issue: "material-mismatch" }],
    });
  }
}
