/**
 * Enterprise integration status read record (PA-008, closes RL-115-F5;
 * spec/architecture.md §8 "SSO/SCIM/MDM integrations", spec/ux-architecture.md
 * §12 the enterprise workspace model).
 *
 * READ-ONLY BY CONSTRUCTION (RL-LOCK-003/004/005): this package deliberately
 * owns NO integration command, OAuth/SCIM/MDM configuration flow or write
 * path. Enterprise integrations are organization-level configuration owned
 * by the organization's own identity/device infrastructure - this record
 * surfaces the CURRENT observed status of each §8 integration kind as a
 * read model, the same way the policy read surfaces the observed policy.
 * Nothing here can configure, enroll or authenticate an integration; a
 * parsed record is a frozen observation.
 *
 * HONEST-STATE DISCIPLINE (the F5 closure contract): each integration
 * distinguishes EXACTLY four states, kept SEPARATE and explicit -
 *
 *  - `configured`     — a verified observation asserts the integration is
 *                       in effect (carries its human summary and a real
 *                       observation);
 *  - `not-configured` — an observation verified that NO integration is set
 *                       up (a real state, never a guess);
 *  - `unavailable`    — the enterprise integration API exposes NO status
 *                       read for this kind yet. This is the honest
 *                       missing-backend-contract state: a contract
 *                       declaration, NOT an observation - it carries no
 *                       freshness facts and asserts nothing about the
 *                       integration itself. The customer surface renders it
 *                       as "requires the enterprise integration API",
 *                       never as a fabricated configuration control;
 *  - `unknown`        — no verified observation exists yet (absence of
 *                       evidence, never failure).
 *
 * The distinction between "unavailable" (a record declaring that the API
 * contract exposes no read for its kind) and a missing integrations section
 * altogether (represented by a null section in the application contract,
 * not here) is part of the contract: an absent section is not an
 * integration assertion, and an integration assertion is never manufactured
 * for an absent section.
 *
 * Freshness is first-class (RL-LOCK-010): the assertion states
 * (`configured`/`not-configured`) MUST rest on a complete observation
 * (observed + received + a freshness guarantee); an incomplete observation
 * forces the honest `unknown` state. `unavailable` and `unknown` carry no
 * verified observation and record the UNKNOWN freshness state. The
 * freshness vocabulary is used DIRECTLY from @roamlink/contracts - never
 * redefined here.
 */
import {
  ValidationError,
  parseContractVersion,
  parseFreshness,
  parseRevision,
  parseTenantId,
  parseUtcInstant,
  type ContractVersion,
  type Freshness,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import { parseEnterpriseIntegrationId, type EnterpriseIntegrationId } from "./ids.js";
import {
  describeEnterpriseContractVersionExpectation,
  isEnterpriseRecordVersionCompatible,
} from "./version.js";

/** Identity of the enterprise integration status read record (alias for readability). */
export type { EnterpriseIntegrationId };

/**
 * The closed enterprise-integration kind vocabulary: the §8 integrations
 * (spec/architecture.md §8 "SSO/SCIM/MDM integrations"). ADDITIVE within the
 * major only (RL-LOCK-017) - a future integration kind is a new member,
 * never a free-form label.
 */
export const ENTERPRISE_INTEGRATION_KINDS = ["sso", "scim", "mdm"] as const;

export type EnterpriseIntegrationKind = (typeof ENTERPRISE_INTEGRATION_KINDS)[number];

export function isEnterpriseIntegrationKind(value: unknown): value is EnterpriseIntegrationKind {
  return (
    typeof value === "string" &&
    (ENTERPRISE_INTEGRATION_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The closed enterprise-integration status vocabulary. The four states are
 * the F5 closure contract - exactly Configured | Not configured |
 * Unavailable | Unknown, never collapsed, never guessed (see the module
 * comment for each state's meaning).
 */
export const ENTERPRISE_INTEGRATION_STATES = [
  "configured",
  "not-configured",
  "unavailable",
  "unknown",
] as const;

export type EnterpriseIntegrationState = (typeof ENTERPRISE_INTEGRATION_STATES)[number];

export function isEnterpriseIntegrationState(value: unknown): value is EnterpriseIntegrationState {
  return (
    typeof value === "string" &&
    (ENTERPRISE_INTEGRATION_STATES as readonly string[]).includes(value)
  );
}

const MAX_INTEGRATION_SUMMARY_LENGTH = 280;

/** Serialized (plain) form of an enterprise integration status read record. */
export interface EnterpriseIntegrationStatusRecord {
  readonly integrationId: EnterpriseIntegrationId;
  readonly contractVersion: ContractVersion;
  /** The organization boundary (a foreign reference; identity stays auth-owned). */
  readonly tenantId: TenantId;
  /** Which §8 integration this record speaks for (closed vocabulary). */
  readonly kind: EnterpriseIntegrationKind;
  /** The observed status (closed four-state vocabulary). */
  readonly state: EnterpriseIntegrationState;
  /** Human summary of the in-effect integration; present only when configured. */
  readonly summary?: string;
  /** The observation facts the assertion rests on (first-class, RL-LOCK-010). */
  readonly freshness: Freshness;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  /** Monotonic revision of the read record (publication ordering). */
  readonly revision: Revision;
}

/** Input accepted by {@link parseEnterpriseIntegrationStatusRecord}. */
export interface EnterpriseIntegrationStatusInput {
  readonly integrationId: string;
  readonly contractVersion: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly state: string;
  readonly summary?: string;
  readonly freshness: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_FIELDS = new Set([
  "integrationId",
  "contractVersion",
  "tenantId",
  "kind",
  "state",
  "summary",
  "freshness",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(
    `EnterpriseIntegrationStatusRecord rejected: ${label} - ${issue}`,
    {
      reason: "ENTERPRISE_INTEGRATION_INVALID",
      details: [{ path: label, issue }],
    },
  );
}

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parses and freezes an enterprise integration status read record.
 * Fail-closed on unknown fields; the state invariants keep the four honest
 * states separate (a configured assertion requires its summary and a
 * complete observation, an unavailable record is a contract declaration
 * that carries no observation, and an unknown record asserts nothing).
 */
export function parseEnterpriseIntegrationStatusRecord(
  value: unknown,
): EnterpriseIntegrationStatusRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      field(key, "unknown field (the integration status read record carries exactly its contract fields)");
    }
  }

  let integrationId: EnterpriseIntegrationId;
  try {
    integrationId = parseEnterpriseIntegrationId(input["integrationId"]);
  } catch {
    field("integrationId", "must be a canonical lowercase UUID");
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
    field("tenantId", "must be a RoamLink tenant id (a foreign reference to the auth-owned organization boundary)");
  }

  const kind = input["kind"];
  if (!isEnterpriseIntegrationKind(kind)) {
    field("kind", "must be a member of the closed enterprise-integration kind vocabulary (sso / scim / mdm)");
  }

  const state = input["state"];
  if (!isEnterpriseIntegrationState(state)) {
    field("state", "must be a member of the closed enterprise-integration status vocabulary (configured / not-configured / unavailable / unknown)");
  }

  let freshness: Freshness;
  try {
    freshness = parseFreshness(input["freshness"]);
  } catch (error) {
    if (error instanceof ValidationError) {
      field("freshness", error.message);
    }
    throw error;
  }

  // State invariants — the honest-state contract:
  //  1. `configured` carries its human summary and rests on a COMPLETE
  //     observation (observed + received + guarantee).
  //  2. `not-configured` asserts no integration is set up and rests on a
  //     COMPLETE observation; it carries no configured-only field.
  //  3. `unavailable` is a CONTRACT DECLARATION (the enterprise integration
  //     API exposes no status read for this kind): it carries NO observation
  //     (UNKNOWN freshness) and no integration content — the missing
  //     backend contract is never dressed up as an observed state.
  //  4. `unknown` carries no verified observation (UNKNOWN freshness).
  //  A complete observation never records UNKNOWN freshness; an incomplete
  //  one never records FRESH/STALE (evaluateFreshnessState semantics —
  //  enforced here so a doctored record fails closed).
  const observationComplete =
    freshness.observedAt !== null && freshness.receivedAt !== null && freshness.freshUntil !== null;
  if (state === "configured" || state === "not-configured") {
    if (!observationComplete) {
      field(
        "freshness",
        `a '${state}' assertion rests on a complete observation (observed + received + freshness guarantee) — an incomplete observation must record the honest 'unknown' state`,
      );
    }
    if (freshness.freshnessState === "UNKNOWN") {
      field("freshness", "a complete observation never records the UNKNOWN freshness state");
    }
  } else if (freshness.freshnessState !== "UNKNOWN") {
    field(
      "freshness",
      `a '${state}' integration record carries no verified observation and must record the UNKNOWN freshness state`,
    );
  }

  let summary: string | undefined;
  if (input["summary"] !== undefined) {
    if (
      typeof input["summary"] !== "string" ||
      input["summary"].length === 0 ||
      input["summary"].length > MAX_INTEGRATION_SUMMARY_LENGTH ||
      input["summary"] !== input["summary"].trim() ||
      hasControlCharacter(input["summary"])
    ) {
      field("summary", "must be a trimmed, printable, non-secret summary of 1-280 chars");
    }
    summary = input["summary"] as string;
  }
  if (state === "configured") {
    if (summary === undefined) {
      field("summary", "a configured integration carries its human summary");
    }
  } else if (summary !== undefined) {
    field("summary", `only a configured integration carries a summary (this record is '${state}')`);
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
    field("revision", "must be a positive integer (the read record's publication revision)");
  }

  return Object.freeze({
    integrationId,
    contractVersion,
    tenantId,
    kind,
    state,
    freshness,
    ...(summary !== undefined ? { summary } : {}),
    createdAt,
    updatedAt,
    revision,
  });
}
