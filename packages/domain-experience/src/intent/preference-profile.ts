/**
 * Preference profile (RL-011): the reusable preferences sub-model embedded in
 * every ExperienceIntentPayload.
 *
 * Dimensions: reliability target, latency sensitivity, cost sensitivity and
 * privacy sensitivity - all CLOSED vocabularies - plus a ranked list of
 * preferred access classes (PREFERENCES ONLY, RL-LOCK-007).
 *
 * NO MONEY: cost is expressed as a SENSITIVITY (how cost-averse the customer
 * is), never as an amount/currency/budget. Absolute pricing belongs to the
 * commerce domain (RL-020+); the intent says what the customer wants, not
 * what they will pay.
 */
import { ValidationError } from "@roamlink/contracts";

import { parseAccessClassName, type AccessClassName } from "./access-class.js";

export const RELIABILITY_LEVELS = ["best_effort", "standard", "high", "mission_critical"] as const;
export type ReliabilityLevel = (typeof RELIABILITY_LEVELS)[number];

export function isReliabilityLevel(value: unknown): value is ReliabilityLevel {
  return typeof value === "string" && (RELIABILITY_LEVELS as readonly string[]).includes(value);
}

export const LATENCY_SENSITIVITIES = ["insensitive", "interactive", "real_time"] as const;
export type LatencySensitivity = (typeof LATENCY_SENSITIVITIES)[number];

export function isLatencySensitivity(value: unknown): value is LatencySensitivity {
  return typeof value === "string" && (LATENCY_SENSITIVITIES as readonly string[]).includes(value);
}

export const SENSITIVITIES = ["low", "medium", "high"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export function isSensitivity(value: unknown): value is Sensitivity {
  return typeof value === "string" && (SENSITIVITIES as readonly string[]).includes(value);
}

/** The frozen preferences value object. */
export interface PreferenceProfile {
  readonly reliability: ReliabilityLevel;
  readonly latency: LatencySensitivity;
  readonly costSensitivity: Sensitivity;
  readonly privacySensitivity: Sensitivity;
  /** Ranked access-class preferences (may be empty; no duplicates). */
  readonly preferredAccessClasses: readonly AccessClassName[];
}

const ALLOWED_FIELDS = new Set([
  "reliability",
  "latency",
  "costSensitivity",
  "privacySensitivity",
  "preferredAccessClasses",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`PreferenceProfile rejected: ${label} - ${issue}`, {
    reason: "PREFERENCE_PROFILE_INVALID",
    details: [{ path: label, issue }],
  });
}

/** Parses and freezes a preference profile (fail-closed, no unknown fields). */
export function parsePreferenceProfile(value: unknown): PreferenceProfile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      field(key, "unknown field (fail-closed, RL-LOCK-017)");
    }
  }
  if (!isReliabilityLevel(record["reliability"])) {
    field("reliability", "must be best_effort, standard, high or mission_critical");
  }
  if (!isLatencySensitivity(record["latency"])) {
    field("latency", "must be insensitive, interactive or real_time");
  }
  if (!isSensitivity(record["costSensitivity"])) {
    field("costSensitivity", "must be low, medium or high (a sensitivity, never an amount)");
  }
  if (!isSensitivity(record["privacySensitivity"])) {
    field("privacySensitivity", "must be low, medium or high");
  }
  const rawClasses = record["preferredAccessClasses"];
  if (rawClasses === undefined) {
    field("preferredAccessClasses", "must be an array of access-class preferences (may be empty)");
  }
  if (!Array.isArray(rawClasses)) {
    field("preferredAccessClasses", "must be an array of access-class preferences");
  }
  const seen = new Set<string>();
  const preferredAccessClasses: AccessClassName[] = [];
  for (const item of rawClasses) {
    const name = parseAccessClassName(item);
    if (seen.has(name)) {
      field("preferredAccessClasses", "duplicate preference (the ranking has no duplicates)");
    }
    seen.add(name);
    preferredAccessClasses.push(name);
  }
  return Object.freeze({
    reliability: record["reliability"],
    latency: record["latency"],
    costSensitivity: record["costSensitivity"],
    privacySensitivity: record["privacySensitivity"],
    preferredAccessClasses: Object.freeze(preferredAccessClasses),
  });
}
