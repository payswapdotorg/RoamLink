/**
 * Bounded rationale text for intent versions (RL-011).
 *
 * A short, printable, non-secret explanation of WHY a version exists
 * ("switched to backup profile for the return flight"). Bounded and
 * control-character-free so it is always safe to render, log and persist.
 */
import { ValidationError, type Branded } from "@roamlink/contracts";

/** A bounded, printable rationale text (secret-free). */
export type SafeText = Branded<"SafeText">;

export const MAX_RATIONALE_LENGTH = 280;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose of this pattern
const RATIONALE_PATTERN = /^[^\u0000-\u001f\u007f]{1,280}$/;

/** Parses a bounded rationale without echoing the value on failure. */
export function parseRationale(value: unknown): SafeText {
  if (typeof value !== "string" || !RATIONALE_PATTERN.test(value) || value.trim().length === 0) {
    throw new ValidationError(
      `rationale must be a non-empty printable text of at most ${MAX_RATIONALE_LENGTH} characters`,
      {
        reason: "RATIONALE_INVALID",
        details: [{ path: "rationale", issue: "not a non-empty printable bounded text" }],
      },
    );
  }
  return value as SafeText;
}

export function isSafeText(value: unknown): value is SafeText {
  return typeof value === "string" && RATIONALE_PATTERN.test(value);
}
