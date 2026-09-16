/**
 * The compiler-side requirement vocabulary (RL-012, spec/architecture.md §3).
 *
 * The compiler translates ExperienceIntent payloads into TECHNOLOGY-NEUTRAL
 * requirement statements. Every statement carries:
 *  - a `dimension` from the closed set below (mirrors the ADCOS-bound
 *    dimension vocabulary the integration surface normalizes on: locality,
 *    reliability, latency, cost, privacy, technology, mobility, usage — see
 *    spec/architecture.md §3 "locality, reliability, latency, cost, privacy
 *    and validity");
 *  - a `classification` — hard (refuse to trade) vs soft (preference the
 *    connectivity authority may weigh);
 *  - a `statement` — the normalized constraint/preference payload as a
 *    canonical JSON value.
 *
 * This vocabulary is a LOCAL, structure-compatible mirror of the
 * integration-side dimension list. The packages are deliberately NOT linked
 * by a dependency edge (RL-LOCK-019: the experience side never imports the
 * ADCOS integration surface); the compiler's output payload is STRUCTURALLY
 * the intent-command input the integration package documents, and the
 * pinned-field compatibility test keeps the two in sync.
 */
import { ValidationError, type CanonicalJsonValue } from "@roamlink/contracts";

/** The closed technology-neutral intent dimensions the compiler can emit. */
export const INTENT_DIMENSIONS = [
  "locality",
  "reliability",
  "latency",
  "cost",
  "privacy",
  "technology",
  "mobility",
  "usage",
] as const;

export type IntentDimension = (typeof INTENT_DIMENSIONS)[number];

export function isIntentDimension(value: unknown): value is IntentDimension {
  return typeof value === "string" && (INTENT_DIMENSIONS as readonly string[]).includes(value);
}

/** Hard = refuse-to-trade; soft = preference the authority may weigh (§4.3). */
export const REQUIREMENT_CLASSIFICATIONS = ["hard", "soft"] as const;

export type RequirementClassification = (typeof REQUIREMENT_CLASSIFICATIONS)[number];

export function isRequirementClassification(
  value: unknown,
): value is RequirementClassification {
  return (
    typeof value === "string" &&
    (REQUIREMENT_CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

/** One classified, technology-neutral requirement statement. */
export interface CompilerRequirementStatement {
  readonly dimension: IntentDimension;
  readonly classification: RequirementClassification;
  /** The normalized constraint/preference payload (canonical JSON value). */
  readonly statement: CanonicalJsonValue;
}

/**
 * Records a deterministic policy decision the compiler made while
 * normalizing the payload (stage 2): what was translated, dropped or
 * downgraded and why. The compiled model carries these so downstream
 * explainability (RL-013) and audits can reconstruct the compiler's
 * behavior WITHOUT re-running it.
 */
export type CompilerPolicyDecision =
  | {
      readonly kind: "dropped-contradictory-preference";
      /** The access-class preference that was dropped. */
      readonly accessClass: string;
      /** The hard constraint that contradicts it. */
      readonly because: "forbidRoaming" | "forbidOpenWifi";
    }
  | {
      readonly kind: "preference-translated";
      readonly dimension: IntentDimension;
      readonly source: string;
    };

function reject(label: string, issue: string): never {
  throw new ValidationError(`compiler requirement rejected: ${label} - ${issue}`, {
    reason: "INTENT_COMPILER_INVALID",
    details: [{ path: label, issue }],
  });
}

/** Parses one requirement statement (closed fields, closed vocabularies). */
export function parseCompilerRequirementStatement(
  value: unknown,
): CompilerRequirementStatement {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject("requirement", "must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["dimension", "classification", "statement"].includes(key)) {
      reject(`requirement.${key}`, "unknown field (the requirement vocabulary is closed)");
    }
  }
  if (!isIntentDimension(record["dimension"])) {
    reject("requirement.dimension", `must be one of: ${INTENT_DIMENSIONS.join(", ")}`);
  }
  if (!isRequirementClassification(record["classification"])) {
    reject("requirement.classification", "must be 'hard' or 'soft'");
  }
  if (record["statement"] === undefined) {
    reject("requirement.statement", "is required");
  }
  return Object.freeze({
    dimension: record["dimension"],
    classification: record["classification"],
    statement: record["statement"] as CanonicalJsonValue,
  });
}
