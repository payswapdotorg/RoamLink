/**
 * Purpose/retention classification vocabulary (RL-054, spec/data-model.md
 * "Privacy": "Device telemetry is minimized. Location, network identifiers,
 * diagnostics and usage data have explicit purpose/retention classifications";
 * spec/mobile.md "Device privacy": "Location and network identifiers receive
 * stricter retention and access controls").
 *
 * The categories and purposes are FIRST-CLASS CLOSED VOCABULARIES: a record
 * without a classification is unpersistable (fail-closed at the enforcement
 * point, ./secret-scan.ts + ./record.ts), and the two stricter-control
 * categories carry structural guarantees in the policy (./policy.ts).
 */
import { ValidationError } from "@roamlink/contracts";

/**
 * The closed data-category vocabulary. Every classified record names
 * exactly one; the retention policy carries one rule per category.
 */
export const RETENTION_DATA_CATEGORIES = [
  "location",
  "network-identifiers",
  "diagnostics",
  "usage",
  "telemetry",
] as const;

export type RetentionDataCategory = (typeof RETENTION_DATA_CATEGORIES)[number];

export function isRetentionDataCategory(value: unknown): value is RetentionDataCategory {
  return (
    typeof value === "string" &&
    (RETENTION_DATA_CATEGORIES as readonly string[]).includes(value)
  );
}

export function parseRetentionDataCategory(value: unknown): RetentionDataCategory {
  if (!isRetentionDataCategory(value)) {
    throw new ValidationError(
      "value is not a member of the closed retention data-category vocabulary (location, network-identifiers, diagnostics, usage, telemetry)",
      {
        reason: "RETENTION_CLASSIFICATION_INVALID",
        details: [{ path: "RetentionDataCategory", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/**
 * The categories that receive STRICTER retention and access controls
 * (spec/mobile.md "Device privacy"): shorter windows, explicit consent
 * requirement and narrower purpose limitation - enforced structurally by
 * the policy parser.
 */
export const STRICTER_CONTROL_CATEGORIES: readonly RetentionDataCategory[] = Object.freeze([
  "location",
  "network-identifiers",
]);

/**
 * The closed purpose vocabulary (collection is purpose-limited,
 * spec/mobile.md "Device privacy"). A record declares the purposes its
 * collection serves; the policy bounds which purposes each category may
 * serve, and access is only authorized for a declared purpose.
 */
export const RETENTION_PURPOSES = [
  "connectivity-experience",
  "connectivity-management",
  "diagnostics",
  "support",
  "security",
] as const;

export type RetentionPurpose = (typeof RETENTION_PURPOSES)[number];

export function isRetentionPurpose(value: unknown): value is RetentionPurpose {
  return (
    typeof value === "string" && (RETENTION_PURPOSES as readonly string[]).includes(value)
  );
}

export function parseRetentionPurpose(value: unknown): RetentionPurpose {
  if (!isRetentionPurpose(value)) {
    throw new ValidationError(
      "value is not a member of the closed retention purpose vocabulary (connectivity-experience, connectivity-management, diagnostics, support, security)",
      {
        reason: "RETENTION_CLASSIFICATION_INVALID",
        details: [{ path: "RetentionPurpose", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}
