/**
 * Capability requirement gating (RL-040, RL-LOCK-011, spec/security.md
 * "Fail-safe defaults").
 *
 * `assertCapability(snapshot, requirement)` is a PURE decision contract:
 * device actions are gated by EXPLICIT capability evidence. Absence of
 * evidence denies or degrades - it never assumes. The truth table:
 *
 * | entry status        | outcome                                            |
 * |---------------------|----------------------------------------------------|
 * | available           | allow, iff evidence class meets the minimum and    |
 * |                     | the evidence is fresh as of the evaluation instant |
 * | unavailable         | deny (or degrade when onInsufficient = "degrade")  |
 * | unknown / missing   | deny (or degrade) - never assumed (RL-LOCK-011)    |
 * | requires-permission | ALWAYS degrade with reason (unsupported control    |
 * |                     | degrades to observation/manual guidance,           |
 * |                     | spec/security.md)                                  |
 *
 * Evidence classes are ranked for gating: AUTHENTICATED > OBSERVED >
 * REPORTED > DERIVED > {INFERRED, STALE, UNKNOWN = never sufficient}. An
 * `available` claim backed only by INFERRED evidence can never allow an
 * action (RL-LOCK-011; RL-LOCK-012 keeps AI/heuristic input advisory).
 *
 * No AI, no platform adapter, no side effects: the same inputs always yield
 * the same decision (RL-LOCK-012 - deterministic policy only).
 */
import {
  ValidationError,
  compareUtcInstants,
  nowUtc,
  type EvidenceClass,
  type UtcInstant,
} from "@roamlink/contracts";

import type { EdgeCapabilityName } from "./capability-name.js";
import { parseEdgeCapabilityName } from "./capability-name.js";
import {
  edgeCapabilityDefinition,
  parseCapabilityEvidenceMinimumClass,
  type CapabilityEvidenceMinimumClass,
} from "./capability-model.js";
import type { EdgeCapabilityEntry, EdgeCapabilitySnapshotPlain } from "./capability-snapshot.js";
import { EdgeCapabilitySnapshot } from "./capability-snapshot.js";
import type { EdgePlatformEvidence } from "./evidence.js";

/**
 * Explicit gating rank over the Wave-0 evidence classes. The four
 * gating-capable classes are strictly ordered; INFERRED, STALE and UNKNOWN
 * rank 0 and can never support an allow.
 */
export const CAPABILITY_EVIDENCE_CLASS_RANKS: Readonly<Record<EvidenceClass, number>> =
  Object.freeze({
    AUTHENTICATED: 4,
    OBSERVED: 3,
    REPORTED: 2,
    DERIVED: 1,
    INFERRED: 0,
    STALE: 0,
    UNKNOWN: 0,
  });

/** What to do when a capability cannot be allowed. */
export type CapabilityInsufficientPolicy = "deny" | "degrade";

/** A resolved, validated capability requirement. */
export interface EdgeCapabilityRequirement {
  readonly capability: EdgeCapabilityName;
  /**
   * Minimum evidence class that may support an allow. Defaults to the
   * capability definition's `minimumClassForAvailable`.
   */
  readonly minimumEvidenceClass: CapabilityEvidenceMinimumClass;
  /** Default "deny"; "degrade" turns denies into degrades with reason. */
  readonly onInsufficient: CapabilityInsufficientPolicy;
  /** Optional maximum age of the entry's observation as of the evaluation instant. */
  readonly maxAgeMs: number | null;
}

/** Input accepted by {@link makeEdgeCapabilityRequirement} (and gate callers). */
export interface EdgeCapabilityRequirementInput {
  readonly capability: string;
  readonly minimumEvidenceClass?: string;
  readonly onInsufficient?: string;
  /** Positive integer, or null/undefined for "no age bound". */
  readonly maxAgeMs?: number | null;
}

export function makeEdgeCapabilityRequirement(
  input: EdgeCapabilityRequirementInput | EdgeCapabilityRequirement,
): EdgeCapabilityRequirement {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("EdgeCapabilityRequirement must be an object", {
      reason: "EDGE_CAPABILITY_REQUIREMENT_INVALID",
      details: [{ path: "EdgeCapabilityRequirement", issue: "not an object" }],
    });
  }
  const capability = parseEdgeCapabilityName(input.capability);
  const definition = edgeCapabilityDefinition(capability);

  let minimumEvidenceClass: CapabilityEvidenceMinimumClass;
  if (input.minimumEvidenceClass === undefined) {
    minimumEvidenceClass = definition.evidenceRequirement.minimumClassForAvailable;
  } else {
    minimumEvidenceClass = parseCapabilityEvidenceMinimumClass(input.minimumEvidenceClass);
  }

  let onInsufficient: CapabilityInsufficientPolicy = "deny";
  if (input.onInsufficient !== undefined) {
    if (input.onInsufficient !== "deny" && input.onInsufficient !== "degrade") {
      throw new ValidationError("onInsufficient must be 'deny' or 'degrade'", {
        reason: "EDGE_CAPABILITY_REQUIREMENT_INVALID",
        details: [{ path: "onInsufficient", issue: "outside the closed policy" }],
      });
    }
    onInsufficient = input.onInsufficient;
  }

  let maxAgeMs: number | null = null;
  if (input.maxAgeMs !== undefined && input.maxAgeMs !== null) {
    if (typeof input.maxAgeMs !== "number" || !Number.isInteger(input.maxAgeMs) || input.maxAgeMs < 1) {
      throw new ValidationError("maxAgeMs must be a positive integer number of milliseconds", {
        reason: "EDGE_CAPABILITY_REQUIREMENT_INVALID",
        details: [{ path: "maxAgeMs", issue: "not a positive integer" }],
      });
    }
    maxAgeMs = input.maxAgeMs;
  }

  return Object.freeze({ capability, minimumEvidenceClass, onInsufficient, maxAgeMs });
}

export const CAPABILITY_DENY_REASONS = [
  "capability-unavailable",
  "capability-unknown",
  "evidence-class-insufficient",
  "evidence-stale",
] as const;

export type CapabilityDenyReason = (typeof CAPABILITY_DENY_REASONS)[number];

export const CAPABILITY_DEGRADE_REASONS = [
  "capability-requires-permission",
  "capability-unavailable",
  "capability-unknown",
  "evidence-class-insufficient",
  "evidence-stale",
] as const;

export type CapabilityDegradeReason = (typeof CAPABILITY_DEGRADE_REASONS)[number];

export interface CapabilityGateAllow {
  readonly decision: "allow";
  readonly capability: EdgeCapabilityName;
  readonly evidenceClass: EvidenceClass;
  readonly observedAt: UtcInstant;
  readonly evidence: EdgePlatformEvidence;
}

export interface CapabilityGateDeny {
  readonly decision: "deny";
  readonly capability: EdgeCapabilityName;
  readonly reason: CapabilityDenyReason;
  /** Static, non-secret explanation (never embeds payloads - RL-LOCK-016). */
  readonly detail: string;
  readonly evidenceClass: EvidenceClass | null;
  readonly observedAt: UtcInstant | null;
}

export interface CapabilityGateDegrade {
  readonly decision: "degrade";
  readonly capability: EdgeCapabilityName;
  readonly reason: CapabilityDegradeReason;
  readonly detail: string;
  readonly evidenceClass: EvidenceClass | null;
  readonly observedAt: UtcInstant | null;
}

export type CapabilityGateDecision =
  | CapabilityGateAllow
  | CapabilityGateDeny
  | CapabilityGateDegrade;

function denyDecision(
  requirement: EdgeCapabilityRequirement,
  reason: CapabilityDenyReason,
  detail: string,
  entry: EdgeCapabilityEntry | undefined,
): CapabilityGateDeny {
  return Object.freeze({
    decision: "deny",
    capability: requirement.capability,
    reason,
    detail,
    evidenceClass: entry?.evidenceClass ?? null,
    observedAt: entry?.observedAt ?? null,
  });
}

function degradeDecision(
  requirement: EdgeCapabilityRequirement,
  reason: CapabilityDegradeReason,
  detail: string,
  entry: EdgeCapabilityEntry | undefined,
): CapabilityGateDegrade {
  return Object.freeze({
    decision: "degrade",
    capability: requirement.capability,
    reason,
    detail,
    evidenceClass: entry?.evidenceClass ?? null,
    observedAt: entry?.observedAt ?? null,
  });
}

/**
 * Pure capability gate. Evaluates `requirement` against the snapshot as of
 * `asOf` (defaults to now; pass an explicit instant for determinism) and
 * returns allow / deny-with-reason / degrade. Never throws for capability
 * reasons - only for an invalid requirement (fail-closed validation).
 */
export function assertCapability(
  snapshot: EdgeCapabilitySnapshot | EdgeCapabilitySnapshotPlain,
  requirement: EdgeCapabilityRequirement | EdgeCapabilityRequirementInput,
  asOf: UtcInstant = nowUtc(),
): CapabilityGateDecision {
  const resolved = makeEdgeCapabilityRequirement(requirement);
  const plain =
    snapshot instanceof EdgeCapabilitySnapshot ? snapshot.toPlain() : snapshot;
  const entry = plain.capabilities[resolved.capability];
  const onInsufficient = resolved.onInsufficient;

  if (entry === undefined) {
    return onInsufficient === "degrade"
      ? degradeDecision(
          resolved,
          "capability-unknown",
          "the snapshot carries no entry for the capability (absence of evidence never assumes availability - RL-LOCK-011)",
          undefined,
        )
      : denyDecision(
          resolved,
          "capability-unknown",
          "the snapshot carries no entry for the capability (absence of evidence never assumes availability - RL-LOCK-011)",
          undefined,
        );
  }

  switch (entry.status) {
    case "unavailable": {
      const detail = "platform evidence records the capability as unavailable on this device";
      return onInsufficient === "degrade"
        ? degradeDecision(resolved, "capability-unavailable", detail, entry)
        : denyDecision(resolved, "capability-unavailable", detail, entry);
    }
    case "unknown": {
      const detail =
        "the platform reports insufficient evidence to determine the capability (unknown is honest, never a success - RL-LOCK-011)";
      return onInsufficient === "degrade"
        ? degradeDecision(resolved, "capability-unknown", detail, entry)
        : denyDecision(resolved, "capability-unknown", detail, entry);
    }
    case "requires-permission": {
      // ALWAYS degrade with reason: unsupported/unauthorized control degrades
      // to observation and manual guidance (spec/security.md fail-safe
      // defaults), regardless of the onInsufficient policy.
      return degradeDecision(
        resolved,
        "capability-requires-permission",
        "the platform requires an explicit user/MDM permission grant before this capability is usable; degrade to observation/manual guidance",
        entry,
      );
    }
    case "available": {
      if (
        CAPABILITY_EVIDENCE_CLASS_RANKS[entry.evidenceClass] <
        CAPABILITY_EVIDENCE_CLASS_RANKS[resolved.minimumEvidenceClass]
      ) {
        const detail =
          "the recorded evidence class is below the minimum required to allow this action (heuristic or absent evidence never allows - RL-LOCK-011)";
        return onInsufficient === "degrade"
          ? degradeDecision(resolved, "evidence-class-insufficient", detail, entry)
          : denyDecision(resolved, "evidence-class-insufficient", detail, entry);
      }
      let stale = false;
      if (plain.freshUntil !== null && compareUtcInstants(asOf, plain.freshUntil) > 0) {
        stale = true;
      }
      if (
        !stale &&
        resolved.maxAgeMs !== null &&
        compareUtcInstants(asOf, entry.observedAt) > resolved.maxAgeMs
      ) {
        stale = true;
      }
      if (stale) {
        const detail =
          "the capability evidence is stale as of the evaluation instant (RL-LOCK-010 - freshness is first-class)";
        return onInsufficient === "degrade"
          ? degradeDecision(resolved, "evidence-stale", detail, entry)
          : denyDecision(resolved, "evidence-stale", detail, entry);
      }
      return Object.freeze({
        decision: "allow",
        capability: resolved.capability,
        evidenceClass: entry.evidenceClass,
        observedAt: entry.observedAt,
        evidence: entry.evidence,
      });
    }
  }
}
