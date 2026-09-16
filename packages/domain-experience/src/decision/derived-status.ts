/**
 * Derived experience status vocabulary (RL-013, spec/data-model.md
 * "State separation": "A derived customer status may combine them only as a
 * read model and must expose the underlying states/evidence").
 *
 * This is a DERIVED, READ-SIDE status for the customer's experience surface.
 * It is NOT the intent's authoritative status (that stays on the
 * ExperienceIntent aggregate, referenced by every decision), and it is NOT a
 * connectivity state (ADCOS owns connectivity; RoamLink decisions reference
 * and explain, they never authorize paths - RL-LOCK-004/005).
 *
 * Vocabulary (closed):
 *  - experience_pending    : the intent is still a draft (not yet active)
 *  - experience_supported  : active intent + usable, fresh device evidence
 *  - experience_degraded   : active intent + stale evidence OR device
 *                            capability limits on preferred access classes
 *  - experience_unresolved : active intent + missing/unknown device evidence
 *  - experience_closed     : the intent is terminal (superseded/archived/
 *                            canceled)
 */
import { ValidationError } from "@roamlink/contracts";

export const DERIVED_EXPERIENCE_STATUSES = [
  "experience_pending",
  "experience_supported",
  "experience_degraded",
  "experience_unresolved",
  "experience_closed",
] as const;

export type DerivedExperienceStatus = (typeof DERIVED_EXPERIENCE_STATUSES)[number];

export function isDerivedExperienceStatus(value: unknown): value is DerivedExperienceStatus {
  return (
    typeof value === "string" &&
    (DERIVED_EXPERIENCE_STATUSES as readonly string[]).includes(value)
  );
}

export function parseDerivedExperienceStatus(value: unknown): DerivedExperienceStatus {
  if (!isDerivedExperienceStatus(value)) {
    throw new ValidationError(
      "value is not a member of the closed derived-experience status vocabulary (experience_pending, experience_supported, experience_degraded, experience_unresolved, experience_closed - derived read-side only, never authoritative)",
      {
        reason: "DERIVED_STATUS_INVALID",
        details: [{ path: "DerivedExperienceStatus", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}
