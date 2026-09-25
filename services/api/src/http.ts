/**
 * RoamLinkError -> HTTP response mapping (services/api boundary).
 *
 * Mirrors the app-kit fake API's status mapping exactly (the deterministic
 * fake is the contract reference for the /v1 surface): validation -> 400,
 * authentication failures -> 401, in-boundary authorization failures ->
 * 403, not-found -> 404 (cross-tenant access is ALSO 404 - no existence
 * oracle), conflict/stale-state -> 409, rate-limited -> 429, unavailable ->
 * 503. Error bodies are the app-kit ApiErrorResource shape: kind/reason/
 * message/retryable/details. Unknown (non-RoamLink) failures fail closed as
 * a generic internal error - underlying third-party text never reaches the
 * wire (RL-LOCK-016).
 */
import { isRoamLinkError, type RoamLinkError } from "@roamlink/contracts";
import { HTTP_STATUS, type HttpResponse } from "@roamlink/app-kit";

/**
 * UnauthorizedError reasons that mean "authenticated but not allowed here":
 * answered with 403 (the fake API's in-tenant permission mapping) instead of
 * 401, so clients can distinguish re-authentication from missing grants.
 */
const AUTHZ_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "PERMISSION_DENIED",
  "ORGANIZATION_SUSPENDED",
  "ACTOR_NOT_A_MEMBER",
  "TENANT_ACTOR_MISMATCH",
  "ACTOR_UNAUTHORIZED",
]);

function statusFor(error: RoamLinkError): number {
  // The edge body cap (RL-105) rides the closed taxonomy as a validation
  // rejection with its own reason; the mapping answers the HTTP-correct 413.
  if (error.reason === "PAYLOAD_TOO_LARGE") {
    return 413;
  }
  switch (error.kind) {
    case "validation":
      return HTTP_STATUS.badRequest;
    case "unauthorized":
      return AUTHZ_FAILURE_REASONS.has(error.reason)
        ? HTTP_STATUS.forbidden
        : HTTP_STATUS.unauthorized;
    case "not-found":
      return HTTP_STATUS.notFound;
    case "conflict":
    case "stale-state":
      return HTTP_STATUS.conflict;
    case "rate-limited":
      return HTTP_STATUS.tooManyRequests;
    case "unavailable":
      return 503;
    default:
      return HTTP_STATUS.internalError;
  }
}

function bodyOf(error: RoamLinkError): string {
  return JSON.stringify({
    kind: error.kind,
    reason: error.reason,
    message: error.message,
    retryable: error.retryable,
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    details: error.details,
  });
}

const INTERNAL_ERROR_BODY = JSON.stringify({
  kind: "unknown-state",
  reason: "INTERNAL_ERROR",
  message: "the request failed (details suppressed)",
  retryable: false,
  details: [],
});

/** Maps any thrown failure onto the contract's HTTP error response. */
export function errorToResponse(error: unknown): HttpResponse {
  if (isRoamLinkError(error)) {
    const headers = headersOf(error);
    return {
      status: statusFor(error),
      body: bodyOf(error),
      ...(headers !== undefined ? { headers } : {}),
    };
  }
  return { status: HTTP_STATUS.internalError, body: INTERNAL_ERROR_BODY };
}

/**
 * Error-response headers (RL-105): a rate-limited answer carries the
 * standard `retry-after` hint (whole seconds, derived from the typed
 * `retryAfterMs`) next to the typed body's `retryAfterMs` field.
 */
function headersOf(error: RoamLinkError): Record<string, string> | undefined {
  if (error.kind === "rate-limited" && error.retryAfterMs !== undefined) {
    return { "retry-after": String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) };
  }
  return undefined;
}

/** A named, honest reason a read model is not composed on the real runtime. */
export interface ReadModelNotComposedReason {
  /** Diagnosable UPPER_SNAKE code (log-safe, value-free). */
  readonly code: string;
  /** The one-line explanation (what real source is missing). */
  readonly explanation: string;
}

/**
 * A typed "read model not composed" response (501 - honest, never fake data).
 * PA-019: every kept-501 route names its reason (the real source that does
 * not exist in this service's bound persistence); the typed reason stays
 * READ_MODEL_NOT_COMPOSED so clients keep their one honest refusal shape.
 */
export function readModelNotComposed(
  path: string,
  named?: ReadModelNotComposedReason,
): HttpResponse {
  return {
    status: 501,
    body: JSON.stringify({
      kind: "unavailable",
      reason: "READ_MODEL_NOT_COMPOSED",
      message:
        named === undefined
          ? "this read model is not composed on the real persistence runtime yet (the deterministic fake API remains the contract reference); no data is invented here"
          : `this read model has no composed source on the real runtime (${named.code}: ${named.explanation}); no data is invented here`,
      retryable: false,
      details: [
        {
          path,
          issue:
            named === undefined
              ? "read model not composed in this wave"
              : `read model not composed (${named.code}: ${named.explanation})`,
        },
      ],
    }),
  };
}

/** JSON success response with a status code (200/202). */
export function jsonResponse(status: number, value: unknown): HttpResponse {
  return { status, body: JSON.stringify(value) };
}
