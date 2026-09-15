/**
 * Shared, safe shape validation for opaque identifiers (RL-002).
 *
 * Parsers validate shape and NEVER guess, repair, normalize or echo values.
 * Error messages name the expected form only - offending values are never
 * included (RL-LOCK-016).
 */
import type { Branded } from "../brand.js";
import { ValidationError } from "../errors/errors.js";

/**
 * RoamLink-owned opaque IDs are canonical lowercase RFC 9562 UUID text
 * (8-4-4-4-12, hyphenated) - the exact form produced by `crypto.randomUUID()`
 * and PostgreSQL `uuid` columns. Uppercase, braced, URN and basic forms are
 * rejected rather than repaired.
 */
export const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Foreign/canonical (e.g. ADCOS) reference shape. The exact ADCOS ID grammar
 * is pinned by the ADCOS public-client contract work (RL-030); until then we
 * only enforce a conservative transport-safe charset so references can be
 * stored, logged and correlated without injection risk.
 */
export const FOREIGN_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_PATTERN.test(value) && value !== NIL_UUID;
}

export function isForeignRefShaped(value: unknown): value is string {
  return typeof value === "string" && FOREIGN_REF_PATTERN.test(value);
}

/** Parses a canonical (non-nil) UUID and returns it branded as `T`. */
export function parseCanonicalUuidAs<T extends Branded<string>>(value: unknown, label: string): T {
  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be a string containing a canonical UUID`, {
      reason: "ID_INVALID",
      details: [{ path: label, issue: "value is not a string" }],
    });
  }
  if (value === NIL_UUID) {
    throw new ValidationError(`${label} must not be the nil UUID (all zeros)`, {
      reason: "ID_INVALID",
      details: [{ path: label, issue: "nil UUID is not a valid entity id" }],
    });
  }
  if (!CANONICAL_UUID_PATTERN.test(value)) {
    throw new ValidationError(
      `${label} must be a canonical lowercase UUID (8-4-4-4-12 hex, hyphenated); non-canonical forms are rejected, never repaired`,
      {
        reason: "ID_INVALID",
        details: [{ path: label, issue: "value does not match the canonical UUID shape" }],
      },
    );
  }
  return value as T;
}

/** Parses a foreign-reference-shaped string and returns it branded as `T`. */
export function parseForeignRefAs<T extends Branded<string>>(value: unknown, label: string): T {
  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be a string reference`, {
      reason: "ID_INVALID",
      details: [{ path: label, issue: "value is not a string" }],
    });
  }
  if (!FOREIGN_REF_PATTERN.test(value)) {
    throw new ValidationError(
      `${label} must match the foreign-reference shape (1-255 chars, starts alphanumeric, then [A-Za-z0-9._:@-] only)`,
      {
        reason: "ID_INVALID",
        details: [{ path: label, issue: "value does not match the safe foreign-reference charset" }],
      },
    );
  }
  return value as T;
}
