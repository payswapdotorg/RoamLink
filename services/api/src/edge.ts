/**
 * The hardened API edge (RL-105): the composition wrapper AROUND the /v1
 * dispatch that adds, in order:
 *
 *   1. ADMISSION CONTROL - the bounded per-bucket rate limit (Redis-backed
 *      distributed limiter when bound; honest in-memory fallback in
 *      non-production modes only; refused in production - see rate-limit.ts).
 *      A declined admission answers the typed 429 (kind `rate-limited`,
 *      `retryAfterMs` in the body, `retry-after` header) through the SAME
 *      errorToResponse mapping as every other edge failure.
 *   2. REQUEST BODY SIZE CAP - every ingress body over the edge cap is
 *      refused with the typed 413 PAYLOAD_TOO_LARGE BEFORE any handler runs
 *      (the webhook policy keeps its own, stricter bound inside; this is the
 *      generalized host-edge cap for ALL routes).
 *   3. CORRELATION + STRUCTURED REQUEST LOGGING - every request carries a
 *      correlation id (the envelope's `x-roamlink-correlation-id` header when
 *      it is a valid foreign-reference, generated at the edge otherwise),
 *      established as the observability correlation context for the whole
 *      dispatch, echoed on EVERY response as `x-roamlink-correlation-id`, and
 *      logged per request through the @roamlink/observability redacting
 *      structured logger (RL-LOCK-016: field values are primitives only;
 *      headers, bodies and credentials never enter a record).
 *
 * The wrapper is strictly additive: it changes NO envelope, idempotency,
 * authorization or route semantics - the existing dispatch (and its tests)
 * is the regression fence.
 */
import { ValidationError, isCorrelationId, type UtcInstant } from "@roamlink/contracts";
import type { HttpRequest, HttpResponse } from "@roamlink/app-kit";
import {
  createAsyncCorrelationCarrier,
  createCorrelatedLogger,
  makeCorrelationContext,
  serializeStructuredLogRecord,
  type CorrelationContextCarrier,
  type LeveledLogger,
  type StructuredLogRecord,
  type StructuredLogSink,
} from "@roamlink/observability";

import { errorToResponse } from "./http.js";
import {
  RateLimitRejection,
  rateLimitBucketKeyOf,
  type ApiRateLimiter,
} from "./rate-limit.js";

/** The default edge cap for ALL ingress bodies (1 MiB). */
export const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;

/** The response/request correlation header name (the envelope's contract name). */
export const CORRELATION_HEADER = "x-roamlink-correlation-id";

/** One structured JSON line per record to the console (production default sink). */
export function createConsoleStructuredLogSink(
  write: (line: string) => void = (line) => console.log(line),
): StructuredLogSink {
  return (record: StructuredLogRecord) => {
    write(JSON.stringify(serializeStructuredLogRecord(record)));
  };
}

export interface ApiEdgeOptions {
  /** The limiter binding; absent -> resolveRateLimitBinding's honest default. */
  readonly rateLimiter?: ApiRateLimiter;
  /** Bounded window budget for the composed in-memory fallback. */
  readonly rateLimitWindowMs?: number;
  readonly rateLimitMaxCost?: number;
  /** The ingress body cap in bytes (default {@link DEFAULT_BODY_LIMIT_BYTES}). */
  readonly bodyLimitBytes?: number;
  /** The structured log sink (default: JSON lines on console). */
  readonly logSink?: StructuredLogSink;
  /** Minimum log level (default "info"). */
  readonly logLevel?: string;
  /** Supplies edge-generated correlation ids (defaults to the service newId). */
  readonly newCorrelationId?: () => string;
}

export interface ApiEdgeRuntime {
  readonly limiter: ApiRateLimiter | undefined;
  readonly bodyLimitBytes: number;
  readonly carrier: CorrelationContextCarrier;
  readonly logger: LeveledLogger;
  readonly sink: StructuredLogSink;
}

/** Builds the edge runtime (once per composition; the dispatch wrapper uses it). */
export function createApiEdgeRuntime(options: ApiEdgeOptions | undefined): ApiEdgeRuntime {
  const edge = options ?? {};
  const carrier = createAsyncCorrelationCarrier();
  const sink = edge.logSink ?? createConsoleStructuredLogSink();
  const logger = createCorrelatedLogger({
    sink,
    carrier,
    ...(edge.logLevel !== undefined ? { minLevel: edge.logLevel } : {}),
  });
  return {
    limiter: edge.rateLimiter,
    bodyLimitBytes: edge.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    carrier,
    logger,
    sink,
  };
}

/**
 * The edge body-cap failure: a client-facing validation rejection the http
 * mapping answers with the typed 413 (reason PAYLOAD_TOO_LARGE) - value-free
 * (the cap size is a policy number, not a secret).
 */
export function payloadTooLargeError(limitBytes: number): ValidationError {
  return new ValidationError(
    "the request body exceeds the API edge size cap (the request was refused before any handler ran)",
    {
      reason: "PAYLOAD_TOO_LARGE",
      retryable: false,
      details: [{ path: "$", issue: `body exceeds the ${limitBytes}-byte edge cap` }],
    },
  );
}

const MAX_LOGGED_PATH_LENGTH = 512;

function truncateForLog(value: string): string {
  return value.length > MAX_LOGGED_PATH_LENGTH ? value.slice(0, MAX_LOGGED_PATH_LENGTH) : value;
}

/**
 * Resolves the request's correlation id: the envelope header when it is a
 * valid foreign-reference, a freshly generated id otherwise (a malformed
 * client-supplied id is never echoed anywhere).
 */
export function correlationIdOf(request: HttpRequest, newCorrelationId: () => string): string {
  const raw = request.headers[CORRELATION_HEADER];
  if (typeof raw === "string" && raw.length > 0 && isCorrelationId(raw)) {
    return raw;
  }
  return newCorrelationId();
}

/** Wraps the inner dispatch with the hardened edge (see the module doc). */
export function createApiEdgeWrapper(
  inner: (request: HttpRequest) => Promise<HttpResponse>,
  options: {
    readonly runtime: ApiEdgeRuntime;
    readonly limiter: ApiRateLimiter | undefined;
    readonly now: () => UtcInstant;
    readonly newCorrelationId: () => string;
  },
): (request: HttpRequest) => Promise<HttpResponse> {
  const { runtime, now, newCorrelationId } = options;

  const logRequest = (
    startedAt: UtcInstant,
    request: HttpRequest,
    status: number,
    level: "info" | "warn" = "info",
  ): void => {
    const fields: Record<string, string | number> = {
      method: request.method,
      path: truncateForLog(stripQuery(request.path)),
      status,
      durationMs: Math.max(0, Date.parse(now()) - Date.parse(startedAt)),
    };
    try {
      runtime.logger[level]("http_request", fields);
    } catch {
      // A logging failure must never break the response path: the edge
      // drops the record (the structured logger validates fail-closed) and
      // the request outcome stands.
    }
  };

  const withCorrelation = (response: HttpResponse, correlationId: string): HttpResponse => ({
    ...response,
    headers: { ...(response.headers ?? {}), [CORRELATION_HEADER]: correlationId },
  });

  return async (request: HttpRequest): Promise<HttpResponse> => {
    const startedAt = now();
    const correlationId = correlationIdOf(request, newCorrelationId);
    return runtime.carrier.run(
      makeCorrelationContext({ correlationId }),
      async (): Promise<HttpResponse> => {
        const path = stripQuery(request.path);
        try {
          // --- 1. admission control (readiness stays exempt: load balancers
          //        and the smoke suite probe it unauthenticated, never at the
          //        request budget's mercy) --------------------------------
          if (options.limiter !== undefined && !(request.method === "GET" && path === "/v1/readiness")) {
            const decision = await options.limiter.tryTake(
              rateLimitBucketKeyOf(request.method, path, request.headers),
              1,
              startedAt,
            );
            if (!decision.allowed) {
              const rejection = new RateLimitRejection(decision.retryAfterMs);
              logRequest(startedAt, request, 429, "warn");
              return withCorrelation(errorToResponse(rejection), correlationId);
            }
          }

          // --- 2. the ingress body cap (all routes, before any handler) ---
          if (
            request.body !== undefined &&
            Buffer.byteLength(request.body, "utf8") > runtime.bodyLimitBytes
          ) {
            logRequest(startedAt, request, 413, "warn");
            return withCorrelation(
              errorToResponse(payloadTooLargeError(runtime.bodyLimitBytes)),
              correlationId,
            );
          }

          // --- 3. the unmodified inner dispatch ---------------------------
          const response = await inner(request);
          if (response.status >= 500) logRequest(startedAt, request, response.status, "warn");
          else logRequest(startedAt, request, response.status);
          return withCorrelation(response, correlationId);
        } catch (error) {
          const response = errorToResponse(error);
          if (response.status >= 500) logRequest(startedAt, request, response.status, "warn");
          else logRequest(startedAt, request, response.status);
          return withCorrelation(response, correlationId);
        }
      },
    );
  };
}

function stripQuery(path: string): string {
  const queryIndex = path.indexOf("?");
  return queryIndex === -1 ? path : path.slice(0, queryIndex);
}
