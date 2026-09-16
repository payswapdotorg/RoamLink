/**
 * Server-side auth-session abstraction (RL-004).
 *
 * Sessions are issued, verified and revoked server-side with opaque bearer
 * tokens (token.ts). Lifetime is bounded: a session may never be issued with
 * a lifetime outside [MIN, MAX]. Validity is INCLUSIVE of the expiry instant
 * (`at <= expiresAt` is active) - the boundary instant itself still belongs
 * to the session; one millisecond later it does not.
 *
 * The record persists ONLY the token digest (RL-LOCK-016). The token itself
 * exists exactly once: at issuance, in the caller's hands.
 */
import {
  UnauthorizedError,
  ValidationError,
  addMilliseconds,
  compareUtcInstants,
  parseRevision,
  parseUserId,
  parseUtcInstant,
  tenantIdFromUser,
  type Digest,
  type Revision,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";

import { parseAuthSessionId, type AuthSessionId } from "./ids.js";
import type { AuthToken } from "./token.js";

export type { AuthSessionId };

/** Session lifetime bounds (milliseconds). */
export const MIN_SESSION_LIFETIME_MS = 60_000; // 1 minute
export const MAX_SESSION_LIFETIME_MS = 43_200_000; // 12 hours
export const DEFAULT_SESSION_LIFETIME_MS = 28_800_000; // 8 hours

export const AUTH_SESSION_STATUSES = ["active", "expired", "revoked"] as const;
export type AuthSessionStatus = (typeof AUTH_SESSION_STATUSES)[number];

/** Serialized (plain) form of an auth-session record (digest only, no token). */
export interface AuthSessionRecord {
  readonly tenantId: TenantId;
  readonly authSessionId: AuthSessionId;
  readonly userId: UserId;
  /** SHA-256 digest of the opaque token. The token itself is never stored. */
  readonly tokenDigest: Digest;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  /** Present once revoked; revocation is terminal. */
  readonly revokedAt?: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link AuthSession} constructor. */
export interface AuthSessionInput {
  readonly authSessionId: string;
  readonly userId: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | undefined;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "authSessionId",
  "userId",
  "tokenDigest",
  "issuedAt",
  "expiresAt",
  "revokedAt",
  "revision",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`AuthSession rejected: ${label} - ${issue}`, {
    reason: "AUTH_SESSION_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseField<T>(label: string, issue: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    field(label, issue);
  }
}

function parseDigestField(value: unknown, label: string): Digest {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    field(label, "must be a lowercase 64-character hex SHA-256 digest");
  }
  return value as Digest;
}

/** Result of a successful session issue: the record plus the one-time token. */
export interface IssuedSession {
  readonly record: AuthSessionRecord;
  /** The opaque token. Handed out exactly once, at issuance. */
  readonly token: AuthToken;
}

/** A verified session view (no token material). */
export interface VerifiedAuthSession {
  readonly authSessionId: AuthSessionId;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly status: "active";
  readonly expiresAt: UtcInstant;
}

/**
 * The auth-session aggregate. Deeply frozen; revoke returns a new instance.
 */
export class AuthSession {
  readonly tenantId: TenantId;
  readonly authSessionId: AuthSessionId;
  readonly userId: UserId;
  readonly tokenDigest: Digest;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  /** Present once revoked; revocation is terminal. */
  declare readonly revokedAt?: UtcInstant;
  readonly revision: Revision;

  constructor(input: AuthSessionInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (fail-closed, RL-LOCK-017)");
      }
    }
    this.authSessionId = parseField(
      "authSessionId",
      "must be a canonical lowercase UUID",
      () => parseAuthSessionId(input.authSessionId),
    );
    this.userId = parseField("userId", "must be a canonical lowercase UUID", () =>
      parseUserId(input.userId),
    );
    this.tenantId = tenantIdFromUser(this.userId);
    this.tokenDigest = parseDigestField(input.tokenDigest, "tokenDigest");
    this.issuedAt = parseField(
      "issuedAt",
      "must be a UTC instant with a zone designator",
      () => parseUtcInstant(input.issuedAt),
    );
    this.expiresAt = parseField(
      "expiresAt",
      "must be a UTC instant with a zone designator",
      () => parseUtcInstant(input.expiresAt),
    );
    if (compareUtcInstants(this.expiresAt, this.issuedAt) <= 0) {
      field("expiresAt", "must be after issuedAt");
    }
    const lifetimeMs =
      new Date(this.expiresAt).getTime() - new Date(this.issuedAt).getTime();
    if (lifetimeMs < MIN_SESSION_LIFETIME_MS || lifetimeMs > MAX_SESSION_LIFETIME_MS) {
      field(
        "expiresAt",
        `the session lifetime must stay within [${MIN_SESSION_LIFETIME_MS}, ${MAX_SESSION_LIFETIME_MS}] ms`,
      );
    }
    if (input.revokedAt !== undefined) {
      const revokedAt = parseField(
        "revokedAt",
        "must be a UTC instant with a zone designator when present",
        () => parseUtcInstant(input.revokedAt),
      );
      if (compareUtcInstants(revokedAt, this.issuedAt) < 0) {
        field("revokedAt", "must not precede issuedAt");
      }
      this.revokedAt = revokedAt;
    }
    this.revision = parseField(
      "revision",
      "must be a positive integer (optimistic-concurrency token)",
      () => parseRevision(input.revision),
    );
    Object.freeze(this);
  }

  /**
   * Issues a session for `userId` with the given token digest and a bounded
   * lifetime (defaults to {@link DEFAULT_SESSION_LIFETIME_MS}). `issuedAt`
   * must be explicit so issuance is deterministic under an injected clock.
   */
  static issue(input: {
    authSessionId: string;
    userId: string;
    tokenDigest: string;
    issuedAt: string;
    lifetimeMs?: number;
  }): AuthSession {
    const lifetimeMs = input.lifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS;
    if (
      typeof lifetimeMs !== "number" ||
      !Number.isInteger(lifetimeMs) ||
      lifetimeMs < MIN_SESSION_LIFETIME_MS ||
      lifetimeMs > MAX_SESSION_LIFETIME_MS
    ) {
      field(
        "lifetimeMs",
        `must be an integer within [${MIN_SESSION_LIFETIME_MS}, ${MAX_SESSION_LIFETIME_MS}] ms`,
      );
    }
    const issuedAt = parseUtcInstant(input.issuedAt);
    const expiresAt = addMilliseconds(issuedAt, lifetimeMs);
    return new AuthSession({
      authSessionId: input.authSessionId,
      userId: input.userId,
      tokenDigest: input.tokenDigest,
      issuedAt: input.issuedAt,
      expiresAt,
      revokedAt: undefined,
      revision: 1,
    });
  }

  /** The session status at `at` (revoked wins; then expiry; inclusive boundary). */
  status(at: UtcInstant): AuthSessionStatus {
    if (this.revokedAt !== undefined) return "revoked";
    return compareUtcInstants(at, this.expiresAt) <= 0 ? "active" : "expired";
  }

  /**
   * Verifies the session at `at`. Fail-closed: revoked and expired sessions
   * throw UnauthorizedError; the messages never contain token material.
   */
  verify(at: UtcInstant): VerifiedAuthSession {
    if (this.revokedAt !== undefined) {
      throw new UnauthorizedError("auth session was revoked; authenticate again", {
        reason: "SESSION_REVOKED",
      });
    }
    if (compareUtcInstants(at, this.expiresAt) > 0) {
      throw new UnauthorizedError("auth session expired; authenticate again", {
        reason: "SESSION_EXPIRED",
      });
    }
    return Object.freeze({
      authSessionId: this.authSessionId,
      tenantId: this.tenantId,
      userId: this.userId,
      status: "active",
      expiresAt: this.expiresAt,
    });
  }

  /** Revokes the session (idempotent: revoking a revoked session is a no-op). */
  revoke(at: UtcInstant): AuthSession {
    if (this.revokedAt !== undefined) {
      return this;
    }
    return new AuthSession({
      authSessionId: this.authSessionId,
      userId: this.userId,
      tokenDigest: this.tokenDigest,
      issuedAt: this.issuedAt,
      expiresAt: this.expiresAt,
      revokedAt: at,
      revision: parseRevision(this.revision + 1),
    });
  }

  toRecord(): AuthSessionRecord {
    return Object.freeze({
      tenantId: this.tenantId,
      authSessionId: this.authSessionId,
      userId: this.userId,
      tokenDigest: this.tokenDigest,
      issuedAt: this.issuedAt,
      expiresAt: this.expiresAt,
      ...(this.revokedAt !== undefined ? { revokedAt: this.revokedAt } : {}),
      revision: this.revision,
    });
  }

  static fromRecord(record: AuthSessionRecord): AuthSession {
    return new AuthSession({
      authSessionId: record.authSessionId,
      userId: record.userId,
      tokenDigest: record.tokenDigest,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      revokedAt: record.revokedAt,
      revision: record.revision,
    });
  }
}
