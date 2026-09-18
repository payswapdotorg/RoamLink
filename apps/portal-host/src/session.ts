/**
 * The host session layer (RL-089).
 *
 * The API/BFF (RL-090) hands the opaque session token out exactly once, in
 * the login response; THIS layer is the sanctioned host-side binding that
 * turns it into an httpOnly cookie (services/api README "the host turns it
 * into an httpOnly cookie"). The cookie value is the opaque token: hashing,
 * lookup-by-digest and verification stay inside the @roamlink/auth boundary
 * - the host never sees the digest and never stores the token anywhere else
 * (RL-LOCK-016: no credential material in logs, telemetry or projections).
 *
 * The surfaces (apps/web, apps/admin) are pure view+command layers over the
 * typed API client; this module also binds their in-process transport so a
 * rendered page speaks to the REAL API service without an HTTP loopback
 * (same process, same calls, same authorization - the client cannot tell
 * and holds no authority either way).
 */
import type { HttpTransport, HttpRequest, HttpResponse } from "@roamlink/app-kit";
import type { ApiService } from "@roamlink/api-service";

/** The single host-managed session cookie (httpOnly; never document.cookie). */
export const SESSION_COOKIE = "roamlink_session";

/** One successful login's recorded outcome (the /v1/auth/session response). */
export interface LoginOutcome {
  readonly authSessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly token: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SessionCookieOptions {
  /** "production" adds `Secure` (cookies are never Secure on localhost). */
  readonly mode: "production" | "development";
  readonly now: () => number;
}

/** Builds the Set-Cookie value for one login outcome (bounded by its expiry). */
export function sessionCookieOf(outcome: LoginOutcome, options: SessionCookieOptions): string {
  const expiresInSeconds = Math.max(
    0,
    Math.floor((Date.parse(outcome.expiresAt) - options.now()) / 1000),
  );
  const attributes = [
    `${SESSION_COOKIE}=${outcome.token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${expiresInSeconds}`,
  ];
  if (options.mode === "production") attributes.push("Secure");
  return attributes.join("; ");
}

/** The cookie-clearing value (ends the host binding; expiry is the server-side lifecycle). */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Reads the presented session token from the request's Cookie header. */
export function sessionTokenOf(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== SESSION_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * The in-process surface transport: one `HttpTransport` that injects the
 * session bearer token and dispatches straight into the composed API
 * service. Surfaces carry the app-kit contract only - they never see the
 * token (it is injected here, at the host seam) and never touch persistence.
 */
export function createSessionTransport(
  api: Pick<ApiService, "handle">,
  token: string,
): HttpTransport {
  return {
    async request(request: HttpRequest): Promise<HttpResponse> {
      return api.handle({
        method: request.method,
        path: request.path,
        headers: { ...request.headers, authorization: `Bearer ${token}` },
        ...(request.body !== undefined ? { body: request.body } : {}),
      });
    },
  };
}
