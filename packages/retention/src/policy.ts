/**
 * Retention policy (RL-054, spec/data-model.md "Privacy", spec/mobile.md
 * "Device privacy").
 *
 * A {@link RetentionPolicy} is the frozen per-category rule set: retention
 * window (after which the data MUST be erased), erasure semantics
 * (hard-delete or tombstone), purpose limitation (which purposes the
 * category may serve), a minimization bound (maximum canonical payload
 * bytes) and the explicit-consent requirement.
 *
 * STRUCTURALLY ENFORCED STRICKER CONTROLS (spec/mobile.md: "Location and
 * network identifiers receive stricter retention and access controls"):
 * the parser rejects a policy whose location/network-identifiers windows
 * are not strictly SHORTER than every other category's window, or whose
 * stricter categories do not require explicit consent. A lax policy is a
 * contract violation, never a silent default (RL-LOCK-018: tests prove it).
 */
import {
  ValidationError,
  parseContractVersion,
  type ContractVersion,
} from "@roamlink/contracts";

import {
  RETENTION_DATA_CATEGORIES,
  STRICTER_CONTROL_CATEGORIES,
  isRetentionDataCategory,
  isRetentionPurpose,
  parseRetentionDataCategory,
  type RetentionDataCategory,
  type RetentionPurpose,
} from "./classification.js";
import {
  describeRetentionContractVersionExpectation,
  isRetentionRecordVersionCompatible,
} from "./version.js";

export const ERASURE_SEMANTICS = ["hard-delete", "tombstone"] as const;
export type ErasureSemantics = (typeof ERASURE_SEMANTICS)[number];

export function isErasureSemantics(value: unknown): value is ErasureSemantics {
  return typeof value === "string" && (ERASURE_SEMANTICS as readonly string[]).includes(value);
}

/** Bounds on a retention window: between one second and ten years. */
export const MIN_RETENTION_WINDOW_MS = 1_000;
export const MAX_RETENTION_WINDOW_MS = 3650 * 24 * 60 * 60 * 1000;

/** Bounds on the minimization payload size (canonical bytes). */
export const MIN_MAX_PAYLOAD_BYTES = 64;
export const MAX_MAX_PAYLOAD_BYTES = 65_536;

/** The per-category retention rule. */
export interface RetentionRule {
  readonly category: RetentionDataCategory;
  /** How long the data is retained past collection (strictly positive). */
  readonly retentionWindowMs: number;
  /** How expiry erases the data (hard-delete or privacy tombstone). */
  readonly erasureSemantics: ErasureSemantics;
  /** Purpose limitation: the only purposes this category may serve. */
  readonly allowedPurposes: readonly RetentionPurpose[];
  /** Minimization: the maximum canonical-JSON payload size in bytes. */
  readonly maxPayloadBytes: number;
  /** Explicit user consent required before collection (stricter categories). */
  readonly requiresExplicitConsent: boolean;
}

/** The frozen policy: exactly one rule per closed-vocabulary category. */
export interface RetentionPolicy {
  readonly contractVersion: ContractVersion;
  readonly rules: Readonly<Record<RetentionDataCategory, RetentionRule>>;
}

function field(label: string, issue: string): never {
  throw new ValidationError(`RetentionPolicy rejected: ${label} - ${issue}`, {
    reason: "RETENTION_POLICY_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * Parses and freezes a retention policy. Fail-closed on:
 *  - missing/extra rules (the category map must be total and exact);
 *  - out-of-bounds windows and payload bounds;
 *  - empty or out-of-vocabulary purpose lists;
 *  - the STRICTER-CONTROL invariants: location and network-identifiers
 *    windows strictly shorter than every other category's window, and both
 *    requiring explicit consent.
 */
export function parseRetentionPolicy(value: unknown): RetentionPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object with contractVersion and rules");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== "contractVersion" && key !== "rules") {
      field(key, "unknown field (the policy carries exactly contractVersion + rules)");
    }
  }
  let contractVersion: ContractVersion;
  try {
    contractVersion = parseContractVersion(input["contractVersion"]);
  } catch {
    field("contractVersion", "must be a MAJOR.MINOR contract version");
  }
  if (!isRetentionRecordVersionCompatible(contractVersion)) {
    field("contractVersion", describeRetentionContractVersionExpectation());
  }
  if (input["rules"] === null || typeof input["rules"] !== "object" || Array.isArray(input["rules"])) {
    field("rules", "must be a record keyed by data category");
  }
  const rulesInput = input["rules"] as Record<string, unknown>;
  for (const key of Object.keys(rulesInput)) {
    if (!isRetentionDataCategory(key)) {
      field(`rules.${key}`, "unknown category (the closed category vocabulary is exact)");
    }
  }

  const rules = {} as Record<RetentionDataCategory, RetentionRule>;
  for (const category of RETENTION_DATA_CATEGORIES) {
    const ruleInput = rulesInput[category];
    if (ruleInput === undefined) {
      field(`rules.${category}`, "missing required rule (the category map must be total)");
    }
    if (ruleInput === null || typeof ruleInput !== "object" || Array.isArray(ruleInput)) {
      field(`rules.${category}`, "must be a rule object");
    }
    const record = ruleInput as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (
        ![
          "category",
          "retentionWindowMs",
          "erasureSemantics",
          "allowedPurposes",
          "maxPayloadBytes",
          "requiresExplicitConsent",
        ].includes(key)
      ) {
        field(`rules.${category}.${key}`, "unknown field (the rule carries exactly its fields)");
      }
    }
    if (record["category"] !== category) {
      field(`rules.${category}.category`, "must match the rule's key");
    }
    const retentionWindowMs = record["retentionWindowMs"];
    if (
      typeof retentionWindowMs !== "number" ||
      !Number.isInteger(retentionWindowMs) ||
      retentionWindowMs < MIN_RETENTION_WINDOW_MS ||
      retentionWindowMs > MAX_RETENTION_WINDOW_MS
    ) {
      field(`rules.${category}.retentionWindowMs`, "must be an integer between 1s and ten years");
    }
    const erasureSemantics = record["erasureSemantics"];
    if (!isErasureSemantics(erasureSemantics)) {
      field(`rules.${category}.erasureSemantics`, "must be hard-delete or tombstone");
    }
    const allowedPurposesInput = record["allowedPurposes"];
    if (!Array.isArray(allowedPurposesInput) || allowedPurposesInput.length === 0) {
      field(`rules.${category}.allowedPurposes`, "must be a non-empty purpose list (purpose-limited)");
    }
    const allowedPurposes: RetentionPurpose[] = [];
    for (const purpose of allowedPurposesInput) {
      if (!isRetentionPurpose(purpose)) {
        field(`rules.${category}.allowedPurposes`, "contains an out-of-vocabulary purpose");
      }
      allowedPurposes.push(purpose);
    }
    const maxPayloadBytes = record["maxPayloadBytes"];
    if (
      typeof maxPayloadBytes !== "number" ||
      !Number.isInteger(maxPayloadBytes) ||
      maxPayloadBytes < MIN_MAX_PAYLOAD_BYTES ||
      maxPayloadBytes > MAX_MAX_PAYLOAD_BYTES
    ) {
      field(`rules.${category}.maxPayloadBytes`, "must be an integer between 64 and 65536 bytes");
    }
    const requiresExplicitConsent = record["requiresExplicitConsent"];
    if (typeof requiresExplicitConsent !== "boolean") {
      field(`rules.${category}.requiresExplicitConsent`, "must be a boolean");
    }
    rules[category] = Object.freeze({
      category,
      retentionWindowMs,
      erasureSemantics,
      allowedPurposes: Object.freeze([...new Set(allowedPurposes)]),
      maxPayloadBytes,
      requiresExplicitConsent,
    });
  }

  // --- stricter-control invariants ---------------------------------------
  for (const stricter of STRICTER_CONTROL_CATEGORIES) {
    if (!rules[stricter].requiresExplicitConsent) {
      field(
        `rules.${stricter}.requiresExplicitConsent`,
        "location and network identifiers REQUIRE explicit consent (stricter access controls, spec/mobile.md)",
      );
    }
    for (const other of RETENTION_DATA_CATEGORIES) {
      // Stricter categories are compared against every NON-stricter category;
      // location and network-identifiers may order freely between
      // themselves (both are already strictly bounded).
      if (STRICTER_CONTROL_CATEGORIES.includes(other)) continue;
      if (rules[stricter].retentionWindowMs >= rules[other].retentionWindowMs) {
        field(
          `rules.${stricter}.retentionWindowMs`,
          `must be strictly shorter than the ${other} window (stricter retention, spec/mobile.md)`,
        );
      }
    }
  }

  return Object.freeze({ contractVersion, rules: Object.freeze(rules) });
}

/**
 * The default policy (deterministic reference): location 24h /
 * network-identifiers 7d / telemetry 30d / diagnostics 90d / usage 180d;
 * location and network-identifiers tombstoned (auditable erasure), the
 * coarse categories hard-deleted on expiry.
 */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = parseRetentionPolicy({
  contractVersion: "0.1",
  rules: {
    location: {
      category: "location",
      retentionWindowMs: 24 * 60 * 60 * 1000,
      erasureSemantics: "tombstone",
      allowedPurposes: ["connectivity-experience"],
      maxPayloadBytes: 512,
      requiresExplicitConsent: true,
    },
    "network-identifiers": {
      category: "network-identifiers",
      retentionWindowMs: 7 * 24 * 60 * 60 * 1000,
      erasureSemantics: "tombstone",
      allowedPurposes: ["connectivity-experience", "connectivity-management"],
      maxPayloadBytes: 512,
      requiresExplicitConsent: true,
    },
    telemetry: {
      category: "telemetry",
      retentionWindowMs: 30 * 24 * 60 * 60 * 1000,
      erasureSemantics: "hard-delete",
      allowedPurposes: ["connectivity-experience", "diagnostics"],
      maxPayloadBytes: 2048,
      requiresExplicitConsent: false,
    },
    diagnostics: {
      category: "diagnostics",
      retentionWindowMs: 90 * 24 * 60 * 60 * 1000,
      erasureSemantics: "hard-delete",
      allowedPurposes: ["diagnostics", "support", "security"],
      maxPayloadBytes: 4096,
      requiresExplicitConsent: false,
    },
    usage: {
      category: "usage",
      retentionWindowMs: 180 * 24 * 60 * 60 * 1000,
      erasureSemantics: "hard-delete",
      allowedPurposes: ["connectivity-experience", "connectivity-management", "support"],
      maxPayloadBytes: 4096,
      requiresExplicitConsent: false,
    },
  },
});

/** The rule for a category (typed accessor over the total map). */
export function retentionRuleFor(
  policy: RetentionPolicy,
  category: RetentionDataCategory,
): RetentionRule {
  return policy.rules[parseRetentionDataCategory(category)];
}
