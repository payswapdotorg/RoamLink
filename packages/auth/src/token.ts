/**
 * Opaque session tokens (RL-004, RL-LOCK-016).
 *
 * Auth-session tokens are opaque 256-bit random values: `rlt_` followed by
 * 43 base64url characters (32 bytes, no padding). They carry NO identity
 * information (nothing enumerable), are handed out EXACTLY ONCE at issuance,
 * and only their SHA-256 digest is ever persisted (the AuthSessionRecord
 * stores `tokenDigest`, never the token). Verification hashes the presented
 * token and compares digests.
 *
 * Errors never echo the token value.
 */
import { randomBytes } from "node:crypto";

import { ValidationError, sha256Hex, type Branded, type Digest } from "@roamlink/contracts";

/** An opaque bearer token for an auth session (secret - never persist). */
export type AuthToken = Branded<"AuthToken">;

export const AUTH_TOKEN_PREFIX = "rlt_";
/** 32 bytes -> 43 base64url characters without padding. */
export const AUTH_TOKEN_BODY_LENGTH = 43;

const AUTH_TOKEN_PATTERN = /^rlt_[A-Za-z0-9_-]{43}$/;

/** Shape check only; safe to call on untrusted input. */
export function isAuthToken(value: unknown): value is AuthToken {
  return typeof value === "string" && AUTH_TOKEN_PATTERN.test(value);
}

/** Parses a token without echoing the value on failure. */
export function parseAuthToken(value: unknown): AuthToken {
  if (!isAuthToken(value)) {
    throw new ValidationError(
      `AuthToken must be '${AUTH_TOKEN_PREFIX}' followed by ${AUTH_TOKEN_BODY_LENGTH} base64url characters`,
      {
        reason: "AUTH_TOKEN_INVALID",
        details: [{ path: "AuthToken", issue: "not an opaque rlt_ token" }],
      },
    );
  }
  return value;
}

/**
 * Generates a fresh cryptographically random token. Non-deterministic by
 * design; tests assert shape/uniqueness, never specific values.
 */
export function generateAuthToken(): AuthToken {
  return `${AUTH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}` as AuthToken;
}

/** The persisted form of a token: its SHA-256 digest (never the token). */
export function tokenDigestOf(token: AuthToken): Digest {
  return sha256Hex(token);
}
