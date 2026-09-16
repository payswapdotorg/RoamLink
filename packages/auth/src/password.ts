/**
 * Password hashing port (RL-004).
 *
 * A PORT, not an implementation: production deployments bind a real KDF
 * (scrypt/argon2) in the composition layer (Wave 2+), keeping this package
 * free of any vendor/algorithm lock-in. The test double provided here is
 * INSECURE BY DESIGN and exists only so the auth flows are testable without
 * a production KDF - it is named loudly to make accidental production use
 * obvious.
 *
 * Hygiene (RL-LOCK-016): PasswordSecret values are never persisted, never
 * logged and never included in errors. Only the hash digest is stored, in a
 * SEPARATE credential record (see ports.ts CredentialRepository) - not on the
 * User aggregate - so account reads can never leak credential material.
 */
import { ValidationError, type Branded } from "@roamlink/contracts";

/** A user-supplied password secret. Never persisted, never logged. */
export type PasswordSecret = Branded<"PasswordSecret">;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

/** Parses (does not strength-check beyond bounds) a password secret. */
export function parsePasswordSecret(value: unknown): PasswordSecret {
  if (
    typeof value !== "string" ||
    value.length < MIN_PASSWORD_LENGTH ||
    value.length > MAX_PASSWORD_LENGTH
  ) {
    throw new ValidationError(
      `password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
      {
        reason: "PASSWORD_INVALID",
        details: [{ path: "password", issue: "length outside the accepted bounds" }],
      },
    );
  }
  return value as PasswordSecret;
}

/** A stored password hash: algorithm label + digest. Secret-free by design. */
export interface PasswordHash {
  /** Bounded, safe algorithm label (e.g. 'scrypt', 'insecure-test-sha256'). */
  readonly algorithm: string;
  /** The stored digest (format defined by the algorithm; never the secret). */
  readonly digest: string;
}

const ALGORITHM_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_PASSWORD_DIGEST_LENGTH = 512;

/** Parses a stored password hash (bounded, safe shapes only). */
export function parsePasswordHash(value: unknown): PasswordHash {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("PasswordHash must be an object with algorithm and digest", {
      reason: "PASSWORD_HASH_INVALID",
      details: [{ path: "PasswordHash", issue: "not an object" }],
    });
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "algorithm,digest") {
    throw new ValidationError("PasswordHash carries exactly the fields algorithm and digest", {
      reason: "PASSWORD_HASH_INVALID",
      details: [{ path: "PasswordHash", issue: "unknown or missing field" }],
    });
  }
  const algorithm = record["algorithm"];
  const digest = record["digest"];
  if (typeof algorithm !== "string" || !ALGORITHM_PATTERN.test(algorithm)) {
    throw new ValidationError(
      "PasswordHash.algorithm must be a short lowercase safe label (e.g. 'scrypt')",
      {
        reason: "PASSWORD_HASH_INVALID",
        details: [{ path: "PasswordHash.algorithm", issue: "not a safe algorithm label" }],
      },
    );
  }
  if (
    typeof digest !== "string" ||
    digest.length === 0 ||
    digest.length > MAX_PASSWORD_DIGEST_LENGTH
  ) {
    throw new ValidationError("PasswordHash.digest must be a bounded non-empty string", {
      reason: "PASSWORD_HASH_INVALID",
      details: [{ path: "PasswordHash.digest", issue: "not a bounded non-empty string" }],
    });
  }
  return Object.freeze({ algorithm, digest });
}

/**
 * The password-hashing port. Implementations must be deterministic per
 * (algorithm, secret) pair for `verify` and must never leak timing beyond
 * what the KDF itself implies.
 */
export interface PasswordHasher {
  hash(password: PasswordSecret): Promise<PasswordHash>;
  verify(password: PasswordSecret, hash: PasswordHash): Promise<boolean>;
}

const INSECURE_TEST_ALGORITHM = "insecure-test-sha256";

/**
 * INSECURE TEST DOUBLE - never bind in production.
 *
 * Plain salted-less SHA-256 over the secret. It exists so tests exercise the
 * real port contract (hash -> store digest -> verify) without a KDF. The
 * algorithm label makes accidental production binding auditable: a stored
 * credential carrying 'insecure-test-sha256' is a red flag by construction.
 */
export class InsecureTestPasswordHasher implements PasswordHasher {
  async hash(password: PasswordSecret): Promise<PasswordHash> {
    const digest = await this.digestOf(password);
    return Object.freeze({ algorithm: INSECURE_TEST_ALGORITHM, digest });
  }

  async verify(password: PasswordSecret, hash: PasswordHash): Promise<boolean> {
    if (hash.algorithm !== INSECURE_TEST_ALGORITHM) {
      // Fail closed on foreign algorithms instead of guessing.
      return false;
    }
    const digest = await this.digestOf(password);
    return timingSafeEqualString(digest, hash.digest);
  }

  private async digestOf(password: PasswordSecret): Promise<string> {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(`roamlink-insecure-test:${password}`, "utf8").digest("hex");
  }
}

/** Constant-time-ish string comparison for test double verification. */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
