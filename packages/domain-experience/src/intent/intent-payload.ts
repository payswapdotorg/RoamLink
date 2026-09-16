/**
 * ExperienceIntentPayload (RL-011): WHAT the customer wants from
 * connectivity - never network facts and never ADCOS types (RL-LOCK-007).
 *
 * Structure:
 *  - travelWindow: bounded UTC window (start < end, duration <= 366 days);
 *  - usageProfile: closed usage-profile vocabulary;
 *  - preferences: the {@link PreferenceProfile} sub-model (reliability,
 *    latency, cost + privacy SENSITIVITIES, ranked access-class PREFERENCES);
 *  - hardConstraints: exactly three booleans - requirements the customer
 *    refuses to trade away. Everything else in the payload is a preference
 *    (soft) that the Wave-2 compiler (RL-012) may weigh, translate and
 *    explain - it may NOT invent network facts.
 *
 * NO MONEY anywhere in the payload (structural guarantee, tested): cost is a
 * sensitivity preference; amounts/currencies/budgets belong to commerce.
 */
import {
  ValidationError,
  compareUtcInstants,
  parseUtcInstant,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  parsePreferenceProfile,
  type PreferenceProfile,
} from "./preference-profile.js";

export const USAGE_PROFILES = [
  "general",
  "work_critical",
  "travel_international",
  "backup_failover",
  "iot_telemetry",
  "media_streaming",
] as const;

export type UsageProfileName = (typeof USAGE_PROFILES)[number];

export function isUsageProfileName(value: unknown): value is UsageProfileName {
  return typeof value === "string" && (USAGE_PROFILES as readonly string[]).includes(value);
}

/** Hard constraints: refuse-to-trade requirements (booleans only). */
export interface HardConstraints {
  /** All transport must be encrypted (e.g. never join open Wi-Fi for data). */
  readonly requireEncryptedTransport: boolean;
  /** Never roam on cellular (a hard refusal, unlike avoiding roaming cost). */
  readonly forbidRoaming: boolean;
  /** Never use open (unencrypted) Wi-Fi. */
  readonly forbidOpenWifi: boolean;
}

/** The travel window: a bounded UTC interval. */
export interface TravelWindow {
  readonly start: UtcInstant;
  readonly end: UtcInstant;
}

/** Maximum travel-window duration (366 days covers a leap-year trip). */
export const MAX_TRAVEL_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

/** The full intent payload: travel window + usage + preferences + hard rules. */
export interface ExperienceIntentPayload {
  readonly travelWindow: TravelWindow;
  readonly usageProfile: UsageProfileName;
  readonly preferences: PreferenceProfile;
  readonly hardConstraints: HardConstraints;
}

const ALLOWED_FIELDS = new Set([
  "travelWindow",
  "usageProfile",
  "preferences",
  "hardConstraints",
]);

const ALLOWED_WINDOW_FIELDS = new Set(["start", "end"]);
const ALLOWED_CONSTRAINT_FIELDS = new Set([
  "requireEncryptedTransport",
  "forbidRoaming",
  "forbidOpenWifi",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`ExperienceIntentPayload rejected: ${label} - ${issue}`, {
    reason: "INTENT_PAYLOAD_INVALID",
    details: [{ path: label, issue }],
  });
}

/** Parses and freezes an intent payload (fail-closed, no unknown fields). */
export function parseExperienceIntentPayload(value: unknown): ExperienceIntentPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      field(key, "unknown field (the payload vocabulary is closed; no money, no network facts)");
    }
  }

  const window = record["travelWindow"];
  if (window === null || typeof window !== "object" || Array.isArray(window)) {
    field("travelWindow", "must be an object with start and end UTC instants");
  }
  for (const key of Object.keys(window as Record<string, unknown>)) {
    if (!ALLOWED_WINDOW_FIELDS.has(key)) {
      field(`travelWindow.${key}`, "unknown field (fail-closed, RL-LOCK-017)");
    }
  }
  const windowRecord = window as Record<string, unknown>;
  let start: UtcInstant;
  let end: UtcInstant;
  try {
    start = parseUtcInstant(windowRecord["start"]);
    end = parseUtcInstant(windowRecord["end"]);
  } catch {
    field("travelWindow", "start and end must be UTC instants with explicit zone designators");
  }
  if (compareUtcInstants(start, end) >= 0) {
    field("travelWindow", "start must be strictly before end");
  }
  const durationMs =
    new Date(end).getTime() - new Date(start).getTime();
  if (durationMs > MAX_TRAVEL_WINDOW_MS) {
    field("travelWindow", `the window duration must not exceed ${MAX_TRAVEL_WINDOW_MS} ms (366 days)`);
  }

  if (!isUsageProfileName(record["usageProfile"])) {
    field(
      "usageProfile",
      "must be one of general, work_critical, travel_international, backup_failover, iot_telemetry, media_streaming",
    );
  }

  let preferences: PreferenceProfile;
  try {
    preferences = parsePreferenceProfile(record["preferences"]);
  } catch {
    field("preferences", "must be a valid preference profile");
  }

  const constraints = record["hardConstraints"];
  if (constraints === null || typeof constraints !== "object" || Array.isArray(constraints)) {
    field("hardConstraints", "must be an object of boolean constraints");
  }
  const constraintsRecord = constraints as Record<string, unknown>;
  for (const key of Object.keys(constraintsRecord)) {
    if (!ALLOWED_CONSTRAINT_FIELDS.has(key)) {
      field(`hardConstraints.${key}`, "unknown field (the hard-constraint vocabulary is closed)");
    }
  }
  for (const key of ALLOWED_CONSTRAINT_FIELDS) {
    if (typeof constraintsRecord[key] !== "boolean") {
      field(`hardConstraints.${key}`, "must be a boolean (hard constraints are never partial)");
    }
  }

  return Object.freeze({
    travelWindow: Object.freeze({ start, end }),
    usageProfile: record["usageProfile"],
    preferences,
    hardConstraints: Object.freeze({
      requireEncryptedTransport: constraintsRecord["requireEncryptedTransport"] === true,
      forbidRoaming: constraintsRecord["forbidRoaming"] === true,
      forbidOpenWifi: constraintsRecord["forbidOpenWifi"] === true,
    }),
  });
}
