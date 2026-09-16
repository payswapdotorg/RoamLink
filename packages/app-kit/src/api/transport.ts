/**
 * The HTTP transport port (RL-060/061 app boundary).
 *
 * Apps never know where the API lives: production binds a `fetch`-backed
 * transport (same origin, credentials via cookies/session - never secrets in
 * app code), tests bind the deterministic in-memory fake. The port carries
 * only method/path/headers/body - no URLs, no client-side credentials, no
 * provider details (RL-LOCK-013/016).
 *
 * Mutations are POSTs (command semantics); reads are GETs. There is no PUT/
 * PATCH/DELETE on purpose: every mutation is a command with an idempotency
 * key, not a resource patch.
 */
export type HttpRequestMethod = "GET" | "POST";

export interface HttpRequest {
  readonly method: HttpRequestMethod;
  /** Request path, always starting with `/v1/`. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  /** JSON-encoded request body (mutations only). */
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON-encoded response body, when present. */
  readonly body?: string;
}

/** The injectable transport seam. */
export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
}

/** Well-known HTTP statuses the client maps onto the error taxonomy. */
export const HTTP_STATUS = Object.freeze({
  ok: 200,
  accepted: 202,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  tooManyRequests: 429,
  internalError: 500,
} as const);
