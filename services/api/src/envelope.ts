/**
 * The server-side command envelope (RL-LOCK-014) + the authentication gate.
 *
 * Every request carries the actor/tenant headers (transport context, NEVER
 * an authorization grant); every MUTATION additionally carries the request/
 * correlation/idempotency header set and an optimistic version when the
 * caller pinned one (spec/api.md "Command semantics", app-kit context.ts).
 *
 * Authentication is bearer-token session verification through the
 * @roamlink/auth boundary (`AuthenticationService.verifySession`): the
 * presented token is hashed and looked up by DIGEST only (RL-LOCK-016).
 * Every authentication failure - unknown token, expired, revoked - answers
 * the SAME 401 AUTHENTICATION_FAILED (no account/session existence oracle).
 * The authenticated principal, not the header, is the actor of record: a
 * forged actor header that disagrees with the session is rejected.
 */
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  parseIdempotencyKey,
  parseUtcInstant,
  type ActorId,
  type UtcInstant,
} from "@roamlink/contracts";
import { MUTATION_HEADERS, type HttpRequest } from "@roamlink/app-kit";
import { actorIdForUser, type VerifiedAuthSession } from "@roamlink/auth";

// --------------------------------------------------------------------------------
// Header access
// --------------------------------------------------------------------------------

function headerOf(request: HttpRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The actor/tenant context headers (present on every request). */
export interface RequestContextHeaders {
  readonly actorId: string | undefined;
  readonly tenantId: string | undefined;
}

/** Reads the actor/tenant context headers WITHOUT validating them. */
export function readContextHeaders(request: HttpRequest): RequestContextHeaders {
  return {
    actorId: headerOf(request, MUTATION_HEADERS.actorId),
    tenantId: headerOf(request, MUTATION_HEADERS.tenantId),
  };
}

/** The full mutation envelope read from the headers (fail-closed). */
export interface MutationEnvelopeHeaders {
  readonly requestId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly tenantId: string;
  readonly expectedVersion: number | null;
}

/**
 * Reads + validates the mutation header set. Missing or malformed headers
 * throw the typed ValidationError BEFORE any state is touched.
 */
export function readMutationEnvelope(request: HttpRequest): MutationEnvelopeHeaders {
  const requestId = headerOf(request, MUTATION_HEADERS.requestId);
  const correlationId = headerOf(request, MUTATION_HEADERS.correlationId);
  const idempotencyKey = headerOf(request, MUTATION_HEADERS.idempotencyKey);
  const actorId = headerOf(request, MUTATION_HEADERS.actorId);
  const tenantId = headerOf(request, MUTATION_HEADERS.tenantId);
  const issues: string[] = [];
  if (requestId === undefined) issues.push(MUTATION_HEADERS.requestId);
  if (correlationId === undefined) issues.push(MUTATION_HEADERS.correlationId);
  if (idempotencyKey === undefined) issues.push(MUTATION_HEADERS.idempotencyKey);
  if (actorId === undefined) issues.push(MUTATION_HEADERS.actorId);
  if (tenantId === undefined) issues.push(MUTATION_HEADERS.tenantId);
  if (issues.length > 0) {
    throw new ValidationError(
      "the mutation header envelope is incomplete (request id, correlation id, idempotency key, actor id and tenant id are required; values are never echoed)",
      {
        reason: "COMMAND_ENVELOPE_INCOMPLETE",
        details: issues.map((name) => ({ path: name, issue: "required header missing or empty" })),
      },
    );
  }
  try {
    parseIdempotencyKey(idempotencyKey as string);
  } catch {
    throw new ValidationError("the idempotency key is not a safe reference string (RL-LOCK-014)", {
      reason: "IDEMPOTENCY_KEY_INVALID",
      details: [{ path: MUTATION_HEADERS.idempotencyKey, issue: "not a safe reference string" }],
    });
  }
  const expectedVersionRaw = headerOf(request, MUTATION_HEADERS.expectedVersion);
  let expectedVersion: number | null = null;
  if (expectedVersionRaw !== undefined) {
    const parsed = Number(expectedVersionRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new ValidationError("the optimistic version header must be a positive integer", {
        reason: "OPTIMISTIC_VERSION_INVALID",
        details: [{ path: MUTATION_HEADERS.expectedVersion, issue: "not a positive integer" }],
      });
    }
    expectedVersion = parsed;
  }
  return {
    requestId: requestId as string,
    correlationId: correlationId as string,
    idempotencyKey: idempotencyKey as string,
    actorId: actorId as string,
    tenantId: tenantId as string,
    expectedVersion,
  };
}

// --------------------------------------------------------------------------------
// The authentication gate
// --------------------------------------------------------------------------------

/** Extracts the bearer token from the Authorization header (rfc6750 shape). */
export function bearerTokenOf(request: HttpRequest): string | undefined {
  const raw = headerOf(request, "authorization");
  if (raw === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  return match?.[1]?.trim() || undefined;
}

function authenticationFailed(): never {
  throw new UnauthorizedError("authentication failed (credentials rejected)", {
    reason: "AUTHENTICATION_FAILED",
  });
}

/** The authenticated principal an authorized request acts as. */
export interface AuthenticatedPrincipal {
  readonly session: VerifiedAuthSession;
  /** The canonical actor id (`usr:<uuid>`), derived from the session. */
  readonly actorId: ActorId;
}

/** Delegates to the auth package's verifySession; every failure is the SAME 401. */
export async function authenticate(
  request: HttpRequest,
  verifySession: (token: string, at: UtcInstant) => Promise<VerifiedAuthSession>,
  now: () => UtcInstant,
): Promise<AuthenticatedPrincipal> {
  const token = bearerTokenOf(request);
  if (token === undefined) {
    authenticationFailed();
  }
  let session: VerifiedAuthSession;
  try {
    session = await verifySession(token as string, parseUtcInstant(now()));
  } catch (error) {
    if (
      error instanceof NotFoundError ||
      error instanceof UnauthorizedError ||
      // A malformed presented token is a rejected CREDENTIAL, not a client
      // validation bug: it answers the SAME 401 (no credential oracle).
      error instanceof ValidationError
    ) {
      authenticationFailed(); // no existence oracle for unknown/revoked/expired/malformed
    }
    throw error;
  }
  return { session, actorId: actorIdForUser(session.userId) };
}
