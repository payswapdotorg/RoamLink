/**
 * MDM-managed configuration delivery contract (RL-044, spec/mobile.md
 * "Enterprise edge", spec/security.md "Credential rules" + RL-LOCK-016).
 *
 * An {@link EnterpriseConfiguration} is the typed, versioned, bounded payload
 * an MDM/enterprise connector delivers to the edge: a policy set of safe-
 * label keys with bounded JSON-primitive values. It is STRUCTURALLY
 * INCAPABLE of carrying secrets: secret-shaped keys (password, token,
 * credential, private key material...) are rejected by the parser, values
 * are bounded primitives, and the total size is capped. Credentials travel
 * ONLY through the credential grant contract (./credential.ts) - never
 * through configuration.
 */
import {
  ValidationError,
  parseContractVersion,
  parseForeignRefAs,
  parseRevision,
  parseUtcInstant,
  compareUtcInstants,
  type Branded,
  type ContractVersion,
  type Revision,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  describeEdgeConnectorContractVersionExpectation,
  isEdgeConnectorRecordVersionCompatible,
} from "./version.js";

/** Identity of an enterprise configuration delivery (opaque reference). */
export type EnterpriseConfigurationId = Branded<"EnterpriseConfigurationId">;

export function parseEnterpriseConfigurationId(value: unknown): EnterpriseConfigurationId {
  return parseForeignRefAs<EnterpriseConfigurationId>(value, "EnterpriseConfigurationId");
}

/** One typed policy entry: a safe-label key and a bounded primitive value. */
export interface EnterprisePolicyEntry {
  readonly key: string;
  readonly value: string | number | boolean | null;
}

/**
 * Secret-shaped key fragments: a configuration entry whose key matches one
 * of these fragments is rejected - credentials NEVER travel through managed
 * configuration (RL-LOCK-016; spec/security.md: edge credentials enter only
 * through the credential grant path).
 */
export const CONFIGURATION_SECRET_KEY_FRAGMENTS: readonly string[] = Object.freeze([
  "password",
  "passwd",
  "secret",
  "token",
  "credential",
  "privatekey",
  "private-key",
  "apikey",
  "api-key",
  "sharedkey",
  "shared-key",
]);

const POLICY_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_POLICY_ENTRIES = 32;
const MAX_POLICY_VALUE_STRING = 256;
const MAX_POLICY_VALUE_NUMBER = 1_000_000_000;

export interface EnterpriseConfigurationInput {
  readonly configurationId: string;
  readonly contractVersion: string;
  readonly revision: number;
  readonly issuedAt: string;
  /** Last instant the configuration may be applied; null = no expiry. */
  readonly expiresAt: string | null;
  readonly policies: Readonly<Record<string, unknown>>;
}

/** The parsed, frozen MDM-delivered configuration. */
export interface EnterpriseConfiguration {
  readonly configurationId: EnterpriseConfigurationId;
  readonly contractVersion: ContractVersion;
  /** Monotonic configuration revision (MDM-managed). */
  readonly revision: Revision;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant | null;
  readonly policies: Readonly<Record<string, string | number | boolean | null>>;
}

function field(label: string, issue: string): never {
  throw new ValidationError(`EnterpriseConfiguration rejected: ${label} - ${issue}`, {
    reason: "ENTERPRISE_CONFIGURATION_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * Parses and freezes an enterprise configuration. Fail-closed on unknown
 * shapes, secret-shaped keys, unbounded values and expired-on-arrival
 * configurations. Values are never echoed in errors (RL-LOCK-016).
 */
export function parseEnterpriseConfiguration(value: unknown): EnterpriseConfiguration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (
      ![
        "configurationId",
        "contractVersion",
        "revision",
        "issuedAt",
        "expiresAt",
        "policies",
      ].includes(key)
    ) {
      field(key, "unknown field (the configuration carries exactly its contract fields)");
    }
  }

  let configurationId: EnterpriseConfigurationId;
  try {
    configurationId = parseEnterpriseConfigurationId(input["configurationId"]);
  } catch {
    field("configurationId", "must be a non-empty safe reference string");
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
  let revision: Revision;
  try {
    revision = parseRevision(input["revision"]);
  } catch {
    field("revision", "must be a positive integer (MDM-managed monotonic revision)");
  }
  let issuedAt: UtcInstant;
  try {
    issuedAt = parseUtcInstant(input["issuedAt"]);
  } catch {
    field("issuedAt", "must be a UTC instant with an explicit zone designator");
  }
  let expiresAt: UtcInstant | null = null;
  if (input["expiresAt"] !== null && input["expiresAt"] !== undefined) {
    try {
      expiresAt = parseUtcInstant(input["expiresAt"]);
    } catch {
      field("expiresAt", "must be null or a UTC instant");
    }
    if (compareUtcInstants(expiresAt, issuedAt) <= 0) {
      field("expiresAt", "must be strictly after issuedAt when present");
    }
  }
  if (input["policies"] === null || typeof input["policies"] !== "object" || Array.isArray(input["policies"])) {
    field("policies", "must be a record of typed policy entries");
  }
  const policiesRecord = input["policies"] as Record<string, unknown>;
  const keys = Object.keys(policiesRecord);
  if (keys.length > MAX_POLICY_ENTRIES) {
    field("policies", `must carry at most ${MAX_POLICY_ENTRIES} entries`);
  }
  const policies: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    if (!POLICY_KEY_PATTERN.test(key)) {
      field(
        `policies.<key>`,
        "keys must be lowercase slugs (letter, then letters/digits/hyphens, max 64 chars)",
      );
    }
    const lowercased = key.toLowerCase();
    if (CONFIGURATION_SECRET_KEY_FRAGMENTS.some((fragment) => lowercased.includes(fragment))) {
      field(
        `policies.<key>`,
        "secret-shaped policy keys are rejected - credentials never travel through managed configuration (RL-LOCK-016)",
      );
    }
    const raw = policiesRecord[key];
    if (raw === null || typeof raw === "boolean") {
      policies[key] = raw;
      continue;
    }
    if (typeof raw === "number") {
      if (!Number.isFinite(raw) || Math.abs(raw) > MAX_POLICY_VALUE_NUMBER) {
        field(`policies.${key}`, "numeric values must be finite and bounded");
      }
      policies[key] = raw;
      continue;
    }
    if (typeof raw === "string") {
      if (raw.length > MAX_POLICY_VALUE_STRING) {
        field(`policies.${key}`, "string values must be at most 256 chars");
      }
      policies[key] = raw;
      continue;
    }
    field(`policies.${key}`, "values must be string, number, boolean or null (no secrets, no nesting)");
  }

  return Object.freeze({
    configurationId,
    contractVersion,
    revision,
    issuedAt,
    expiresAt,
    policies: Object.freeze(policies),
  });
}

/**
 * Whether a configuration is APPLICABLE as of `at`: issued, not expired
 * (null expiry = no expiry guarantee beyond that, still applicable).
 */
export function isEnterpriseConfigurationApplicable(
  configuration: EnterpriseConfiguration,
  at: UtcInstant,
): boolean {
  if (compareUtcInstants(at, configuration.issuedAt) < 0) {
    return false;
  }
  if (configuration.expiresAt === null) {
    return true;
  }
  return compareUtcInstants(at, configuration.expiresAt) <= 0;
}
