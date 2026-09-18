/**
 * The transport translation seam of the hosted runtime (RL-089).
 *
 * Pure Web-Standard `Request`/`Response` <-> app-kit `HttpRequest`/
 * `HttpResponse` adapters. The Next.js route handlers under `src/app/` are
 * THREE-LINE forwarders into the pure handlers in `handlers.ts` - all real
 * logic lives here (framework-free, testable without any Next runtime,
 * swappable host: the same adapters serve a plain fetch server, spec/adr/0003
 * "Vercel is the host, not the authority").
 *
 * Discipline (spec/deployment.md §4): translation ONLY. No handler here
 * touches the database, decides outcomes, or invents state.
 */
import { HTTP_STATUS, type HttpRequest, type HttpResponse } from "@roamlink/app-kit";

/** The app-kit transport carries exactly GET (reads) and POST (commands). */
const CARRIED_METHODS: ReadonlySet<string> = new Set(["GET", "POST"]);

/**
 * Translates one Web-standard request into the app-kit HttpRequest.
 *
 * The body is carried as the EXACT text the client sent (webhook signature
 * verification is byte-exact - the delivery payload is never re-serialized
 * before verification, RL-LOCK-009). Headers are carried AS DELIVERED (the
 * Web Headers API lowercases names); restoring the ADCOS delivery headers'
 * canonical names is the API service's job (the ADCOS-ingress owner) - the
 * host is a pure transport and never imports the ADCOS contract package
 * (RL-LOCK-002).
 */
export async function translateRequest(request: Request): Promise<HttpRequest> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = `${url.pathname}${url.search}`;
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  if (method === "POST") {
    return { method: "POST", path, headers, body: await request.text() };
  }
  if (!CARRIED_METHODS.has(method)) {
    // The app surface's contract has no other verbs by design (every
    // mutation is a POST command, spec repository-layout "Runtime baseline").
    throw new MethodNotAllowedError(method);
  }
  return { method: "GET", path, headers };
}

/** A 405-shaped failure for verbs the app-kit contract does not carry. */
export class MethodNotAllowedError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`method ${method} is not part of the RoamLink API contract (GET reads, POST commands)`);
    this.name = "MethodNotAllowedError";
    this.method = method;
  }
}

/**
 * The status codes the fetch spec allows NO body for. Building a `Response`
 * with a body under these statuses throws (undici enforces the spec), so the
 * empty app-kit response is carried as an honest null body.
 */
const BODYLESS_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/** Translates an app-kit HttpResponse into a Web-standard Response. */
export function translateResponse(response: HttpResponse): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    headers.set(name, value);
  }
  return new Response(
    response.body === undefined || BODYLESS_STATUSES.has(response.status) ? null : response.body,
    {
      status: response.status,
      headers,
    },
  );
}

/** A JSON error response with the app-kit ApiErrorResource shape. */
export function errorResponse(status: number, reason: string, message: string): Response {
  return translateResponse({
    status,
    body: JSON.stringify({ kind: "unavailable", reason, message, retryable: false, details: [] }),
  });
}

/** The uniform server-error body (details suppressed, RL-LOCK-016). */
export function internalErrorResponse(): Response {
  return errorResponse(
    HTTP_STATUS.internalError,
    "INTERNAL_ERROR",
    "the request failed (details suppressed)",
  );
}
