/**
 * Contact and display-text primitives for RoamLink accounts (RL-004).
 *
 * All values are bounded, printable and secret-free: they may appear in
 * records and logs. Validation errors name the field and expected shape and
 * NEVER echo the offending value (RL-LOCK-016 - a malformed address could
 * itself carry sensitive content).
 */
import { ValidationError, type Branded } from "@roamlink/contracts";

/** A validated email address (bounded, printable). */
export type EmailAddress = Branded<"EmailAddress">;

const EMAIL_LOCAL_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/;
const EMAIL_DOMAIN_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export const MAX_EMAIL_LENGTH = 254;

export function isEmailAddress(value: unknown): value is EmailAddress {
  return typeof value === "string" && isValidEmail(value);
}

function isValidEmail(value: string): boolean {
  if (value.length < 3 || value.length > MAX_EMAIL_LENGTH) return false;
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return EMAIL_LOCAL_PATTERN.test(local) && EMAIL_DOMAIN_PATTERN.test(domain) && domain.length <= 253;
}

/** Parses an email address without echoing the value on failure. */
export function parseEmailAddress(value: unknown): EmailAddress {
  if (typeof value !== "string" || !isValidEmail(value)) {
    throw new ValidationError(
      `EmailAddress must be a valid, bounded (<= ${MAX_EMAIL_LENGTH} chars) email address of the form local@domain`,
      {
        reason: "EMAIL_INVALID",
        details: [{ path: "EmailAddress", issue: "not a well-formed, bounded email address" }],
      },
    );
  }
  return value as EmailAddress;
}

/**
 * A bounded, printable, non-secret display label (person or organization
 * names, service labels). Control characters are rejected so the value is
 * always safe to render and to log.
 */
export type SafeLabel = Branded<"SafeLabel">;

export const MAX_SAFE_LABEL_LENGTH = 64;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose of this pattern
const SAFE_LABEL_PATTERN = /^[^\u0000-\u001f\u007f]{1,64}$/;

export function isSafeLabel(value: unknown): value is SafeLabel {
  return typeof value === "string" && SAFE_LABEL_PATTERN.test(value);
}

/** Parses a bounded display label without echoing the value on failure. */
export function parseSafeLabel(value: unknown, label: string): SafeLabel {
  if (typeof value !== "string" || !SAFE_LABEL_PATTERN.test(value) || value.trim().length === 0) {
    throw new ValidationError(
      `${label} must be a non-empty, printable display label of at most ${MAX_SAFE_LABEL_LENGTH} characters (control characters are rejected)`,
      {
        reason: "LABEL_INVALID",
        details: [{ path: label, issue: "not a non-empty printable bounded label" }],
      },
    );
  }
  return value as SafeLabel;
}
