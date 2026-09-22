/**
 * Organization policy read record (PA-007, closes RL-115-F7; spec/
 * architecture.md §8 "organization-level policies", spec/ux-architecture.md
 * §12 "policy summary").
 *
 * READ-ONLY BY CONSTRUCTION (RL-LOCK-003/004/005): this package deliberately
 * owns NO policy command, transition map or write path. Organization policy
 * is enterprise/organization-level CONFIGURATION managed upstream — the
 * record surfaces the CURRENT observed policy state as a read model, the
 * same way the workspace read surfaces the enrollment/connector journey.
 * RoamLink never duplicates connectivity policy authority: nothing here can
 * create, edit or enforce a policy; a parsed record is a frozen observation.
 *
 * HONEST-ABSENCE DISCIPLINE (the F7 closure contract): the read keeps the
 * absence states SEPARATE and explicit —
 *
 *  - `configured`     — the upstream organization administration has a
 *                       policy in effect (carries source, version, summary,
 *                       effectiveAt and a real observation);
 *  - `not-configured` — an observation verified that NO policy is set
 *                       upstream (a real state, never a guess);
 *  - `unknown`        — no verified observation exists yet (absence of
 *                       evidence, never failure).
 *
 * The distinction between "not available" (a workspace surface that composes
 * no policy section at all — represented by a null section in the
 * application contract, not here) and these record states is part of the
 * contract: an absent section is not a policy assertion, and a policy
 * assertion is never manufactured for an absent section.
 *
 * Freshness is first-class (RL-LOCK-010): every assertion state
 * (`configured`/`not-configured`) MUST rest on a complete observation
 * (observed + received + a freshness guarantee); an incomplete observation
 * forces the honest `unknown` state. The freshness vocabulary is used
 * DIRECTLY from @roamlink/contracts — never redefined here.
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

import { parseEnterprisePolicyId, type EnterprisePolicyId } from "./ids.js";
import {
  describeEnterpriseContractVersionExpectation,
  isEnterpriseRecordVersionCompatible,
} from "./version.js";

/** Identity of the organization policy read record (alias for readability). */
export type { EnterprisePolicyId };

/**
 * The closed organization-policy read state vocabulary (assertion states
 * ONLY — "not available" is a null-section concept in the application
 * contract, never a record state: a record that exists asserts something).
 */
export const ORGANIZATION_POLICY_STATES = [
  "configured",
  "not-configured",
  "unknown",
] as const;

export type OrganizationPolicyState = (typeof ORGANIZATION_POLICY_STATES)[number];

export function isOrganizationPolicyState(value: unknown): value is OrganizationPolicyState {
  return (
    typeof value === "string" &&
    (ORGANIZATION_POLICY_STATES as readonly string[]).includes(value)
  );
}

/**
 * The closed policy-source vocabulary: where organization policy is managed
 * upstream. SINGLE-MEMBER today (the organization's own administration) —
 * additive within the major (RL-LOCK-017); a second source (e.g. a managed
 * upstream policy system) would be an additive vocabulary member, never a
 * free-form label (the source is semantic, not presentation metadata).
 */
export const ORGANIZATION_POLICY_SOURCES = ["organization-administration"] as const;

export type OrganizationPolicySource = (typeof ORGANIZATION_POLICY_SOURCES)[number];

export function isOrganizationPolicySource(value: unknown): value is OrganizationPolicySource {
  return (
    typeof value === "string" &&
    (ORGANIZATION_POLICY_SOURCES as readonly string[]).includes(value)
  );
}

/** Bounded, printable policy version label (upstream's own version naming). */
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

const MAX_POLICY_SUMMARY_LENGTH = 280;

/** Serialized (plain) form of an organization policy read record. */
export interface OrganizationPolicyRecord {
  readonly policyId: EnterprisePolicyId;
  readonly contractVersion: ContractVersion;
  /** The organization boundary (a foreign reference; identity stays auth-owned). */
  readonly tenantId: TenantId;
  readonly state: OrganizationPolicyState;
  /** Where the policy is managed upstream (closed vocabulary). */
  readonly source: OrganizationPolicySource;
  /** The upstream policy's own version label; present only when configured. */
  readonly policyVersion?: string;
  /** Human summary of the in-effect policy; present only when configured. */
  readonly summary?: string;
  /** When the current policy version took effect; present only when configured. */
  readonly effectiveAt?: UtcInstant;
  /** The observation facts the assertion rests on (first-class, RL-LOCK-010). */
  readonly freshness: Freshness;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  /** Monotonic revision of the read record (publication ordering). */
  readonly revision: Revision;
}

/** Input accepted by {@link parseOrganizationPolicyRecord}. */
export interface OrganizationPolicyInput {
  readonly policyId: string;
  readonly contractVersion: string;
  readonly tenantId: string;
  readonly state: string;
  readonly source: string;
  readonly policyVersion?: string;
  readonly summary?: string;
  readonly effectiveAt?: string;
  readonly freshness: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_FIELDS = new Set([
  "policyId",
  "contractVersion",
  "tenantId",
  "state",
  "source",
  "policyVersion",
  "summary",
  "effectiveAt",
  "freshness",
  "createdAt",
  "updatedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`OrganizationPolicyRecord rejected: ${label} - ${issue}`, {
    reason: "ORGANIZATION_POLICY_INVALID",
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
 * Parses and freezes an organization policy read record. Fail-closed on
 * unknown fields; the state invariants keep the honest-absence states
 * separate (a configured assertion requires its facts, an unknown record
 * asserts nothing, and an observation-backed state requires a complete
 * freshness record — never a guess, never a collapse).
 */
export function parseOrganizationPolicyRecord(value: unknown): OrganizationPolicyRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      field(key, "unknown field (the policy read record carries exactly its contract fields)");
    }
  }

  let policyId: EnterprisePolicyId;
  try {
    policyId = parseEnterprisePolicyId(input["policyId"]);
  } catch {
    field("policyId", "must be a canonical lowercase UUID");
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

  const state = input["state"];
  if (!isOrganizationPolicyState(state)) {
    field("state", "must be a member of the closed organization-policy read vocabulary");
  }

  const source = input["source"];
  if (!isOrganizationPolicySource(source)) {
    field("source", "must be a member of the closed policy-source vocabulary (where policy is managed upstream)");
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

  // State invariants — the honest-absence contract:
  //  1. `configured` carries its facts (version + summary + effectiveAt).
  //  2. `not-configured`/`unknown` assert nothing about policy content and
  //     MUST NOT carry configured-only fields (a doctored record fails closed).
  //  3. An assertion state (`configured`/`not-configured`) rests on a
  //     COMPLETE observation (observed + received + guarantee); an incomplete
  //     observation forces `unknown` (absence of evidence, never a guess).
  //  4. A complete observation never records UNKNOWN freshness; an
  //     incomplete one never records FRESH/STALE (evaluateFreshnessState
  //     semantics — enforced here so a doctored record fails closed).
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
      "an 'unknown' policy record carries no verified observation and must record the UNKNOWN freshness state",
    );
  }

  let policyVersion: string | undefined;
  if (input["policyVersion"] !== undefined) {
    if (typeof input["policyVersion"] !== "string" || !POLICY_VERSION_PATTERN.test(input["policyVersion"])) {
      field("policyVersion", "must be a bounded, printable version label (the upstream policy's own version)");
    }
    policyVersion = input["policyVersion"] as string;
  }
  let summary: string | undefined;
  if (input["summary"] !== undefined) {
    if (
      typeof input["summary"] !== "string" ||
      input["summary"].length === 0 ||
      input["summary"].length > MAX_POLICY_SUMMARY_LENGTH ||
      input["summary"] !== input["summary"].trim() ||
      hasControlCharacter(input["summary"])
    ) {
      field("summary", "must be a trimmed, printable, non-secret summary of 1-280 chars");
    }
    summary = input["summary"] as string;
  }
  let effectiveAt: UtcInstant | undefined;
  if (input["effectiveAt"] !== undefined) {
    try {
      effectiveAt = parseUtcInstant(input["effectiveAt"]);
    } catch {
      field("effectiveAt", "must be a UTC instant with an explicit zone designator");
    }
  }
  if (state === "configured") {
    if (policyVersion === undefined) {
      field("policyVersion", "a configured policy carries the upstream policy's version label");
    }
    if (summary === undefined) {
      field("summary", "a configured policy carries its human summary");
    }
    if (effectiveAt === undefined) {
      field("effectiveAt", "a configured policy carries the instant its current version took effect");
    }
  } else {
    if (policyVersion !== undefined) {
      field("policyVersion", `only a configured policy carries a version label (this record is '${state}')`);
    }
    if (summary !== undefined) {
      field("summary", `only a configured policy carries a summary (this record is '${state}')`);
    }
    if (effectiveAt !== undefined) {
      field("effectiveAt", `only a configured policy carries an effective instant (this record is '${state}')`);
    }
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
    policyId,
    contractVersion,
    tenantId,
    state,
    source,
    freshness,
    ...(policyVersion !== undefined ? { policyVersion } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(effectiveAt !== undefined ? { effectiveAt } : {}),
    createdAt,
    updatedAt,
    revision,
  });
}
