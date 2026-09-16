/**
 * Authentication service (RL-004): password login, session verify, revoke.
 *
 * Login is idempotent under the Wave-0 command envelope (RL-LOCK-014): the
 * envelope carries the identity triplet (commandId, correlationId,
 * idempotencyKey) and its canonical digest. A replayed envelope (same key,
 * same digest) returns the RECORDED outcome - the SAME session and the SAME
 * token, handed out again only to the retrying caller; the effect (one
 * session) is applied exactly once. A key reused by a different envelope is
 * a ConflictError.
 *
 * Failure hygiene: unknown email, wrong password and suspended account all
 * raise the SAME UnauthorizedError(AUTHENTICATION_FAILED) - no account
 * existence oracle (RL-LOCK-016). The raw token appears exactly once, in the
 * LoginResult; persisted state stores only its digest.
 */
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  tenantIdFromUser,
  type CanonicalJsonValue,
  type CommandEnvelope,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import { admitCommand, commitCommand, type IdempotencyLedger } from "./idempotency.js";
import { actorIdForUser, parseAuthSessionId } from "./ids.js";
import { parseEmailAddress, type EmailAddress } from "./contact.js";
import { parsePasswordSecret, type PasswordHasher, type PasswordSecret } from "./password.js";
import type {
  AuthSessionRepository,
  CredentialRepository,
  UserDirectory,
  UserRepository,
} from "./ports.js";
import { AuthSession, type VerifiedAuthSession } from "./session.js";
import { generateAuthToken, parseAuthToken, tokenDigestOf, type AuthToken } from "./token.js";

/** Result of a successful (or replayed) password login. */
export interface LoginResult {
  readonly authSessionId: string;
  readonly userId: string;
  readonly tenantId: TenantId;
  /** The opaque bearer token. Present in the idempotent outcome so a retried login can return it. */
  readonly token: AuthToken;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export interface AuthenticationServiceDeps {
  readonly users: UserRepository;
  readonly directory: UserDirectory;
  readonly credentials: CredentialRepository;
  readonly sessions: AuthSessionRepository;
  readonly hasher: PasswordHasher;
  readonly ledger: IdempotencyLedger;
  /** Supplies the current instant (inject a deterministic clock in tests). */
  readonly now: () => UtcInstant;
  /** Supplies fresh auth-session ids. */
  readonly generateSessionId: () => string;
}

function authenticationFailed(): never {
  throw new UnauthorizedError("authentication failed (credentials rejected)", {
    reason: "AUTHENTICATION_FAILED",
  });
}

function envelopeInvalid(issue: string): never {
  throw new ValidationError(`login command rejected: ${issue}`, {
    reason: "LOGIN_COMMAND_INVALID",
    details: [{ path: "envelope", issue }],
  });
}

/** Password authentication + session lifecycle use cases. */
export class AuthenticationService {
  private readonly deps: AuthenticationServiceDeps;

  constructor(deps: AuthenticationServiceDeps) {
    this.deps = deps;
  }

  /**
   * Password login. The envelope's tenant must be the authenticating user's
   * personal tenant - resolved via the email directory first, then verified
   * against the envelope (fail-closed on mismatch). The actor on the
   * envelope must be the same user principal.
   */
  async loginWithPassword(
    envelope: CommandEnvelope,
    input: { readonly email: string; readonly password: string },
  ): Promise<LoginResult> {
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as LoginResult;
    }

    const email: EmailAddress = parseEmailAddress(input.email);
    const password: PasswordSecret = parsePasswordSecret(input.password);

    const userId = await this.deps.directory.resolveUserIdByEmail(email);
    if (userId === undefined) authenticationFailed();

    const tenantId = tenantIdFromUser(userId);
    if (envelope.tenantId !== tenantId) {
      envelopeInvalid(
        "the envelope tenant must be the authenticating user's personal tenant (resolve the email first)",
      );
    }
    if (envelope.actorId !== (actorIdForUser(userId) as string)) {
      envelopeInvalid("the envelope actor must be the authenticating user principal");
    }

    const user = await this.deps.users.findById(tenantId, userId);
    if (user === undefined || user.status !== "active") authenticationFailed();

    const credential = await this.deps.credentials.findByUserId(tenantId, userId);
    if (credential === undefined) authenticationFailed();
    const ok = await this.deps.hasher.verify(password, {
      algorithm: credential.algorithm,
      digest: credential.digest,
    });
    if (!ok) authenticationFailed();

    const issuedAt = this.deps.now();
    const token = generateAuthToken();
    const session = AuthSession.issue({
      authSessionId: this.deps.generateSessionId(),
      userId,
      tokenDigest: tokenDigestOf(token),
      issuedAt,
    });
    await this.deps.sessions.save(session.toRecord());

    const outcome: CanonicalJsonValue = Object.freeze({
      authSessionId: session.authSessionId,
      userId,
      tenantId,
      token,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as LoginResult;
  }

  /**
   * Verifies a bearer token. Fail-closed: unknown token digests, revoked and
   * expired sessions all throw (never a false success). Returns session
   * metadata WITHOUT the token.
   */
  async verifySession(token: string, at: UtcInstant): Promise<VerifiedAuthSession> {
    const parsed = parseAuthToken(token);
    const record = await this.deps.sessions.findByTokenDigest(tokenDigestOf(parsed));
    if (record === undefined) {
      throw new NotFoundError("auth session not found for the presented token", {
        reason: "SESSION_NOT_FOUND",
      });
    }
    return AuthSession.fromRecord(record).verify(at);
  }

  /**
   * Revokes a session by id, in the envelope's tenant (the session owner's
   * personal tenant). Envelope-gated and idempotent; only the session owner
   * may revoke their own session.
   */
  async revokeSession(
    envelope: CommandEnvelope,
    input: { readonly authSessionId: string },
  ): Promise<{ readonly authSessionId: string; readonly revoked: boolean }> {
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as { authSessionId: string; revoked: boolean };
    }

    const record = await this.deps.sessions.findById(
      envelope.tenantId,
      parseAuthSessionId(input.authSessionId),
    );
    if (record === undefined) {
      throw new NotFoundError("auth session not found in the command tenant", {
        reason: "SESSION_NOT_FOUND",
      });
    }
    if (envelope.actorId !== (actorIdForUser(record.userId) as string)) {
      throw new UnauthorizedError("only the session owner may revoke the session", {
        reason: "SESSION_OWNER_MISMATCH",
      });
    }

    const revoked = AuthSession.fromRecord(record).revoke(this.deps.now());
    await this.deps.sessions.save(revoked.toRecord());
    const result = Object.freeze({
      authSessionId: revoked.authSessionId,
      revoked: revoked.revokedAt !== undefined,
    });
    await commitCommand(this.deps.ledger, envelope, result, this.deps.now());
    return result;
  }
}
