/**
 * ADCOS v2 HTTP transport (RL-031, spec/adcos-integration.md §1/§3).
 *
 * The transport is the ONLY module in @roamlink/integration that performs
 * network I/O. It speaks EXACTLY the pinned v2 wire contract from
 * @roamlink/adcos: the four request headers, the version pin, JSON bodies.
 *
 * Failure semantics (RL-031: retries must be safe after timeout, connection
 * loss or duplicate delivery):
 *  - a transport failure is surfaced as {@link AdcosTransportError} with the
 *    request OUTCOME:
 *      - `"not-sent"`  - the request never left (connection refused/DNS): the
 *        mutation was definitely NOT applied;
 *      - `"unknown"`   - the request was dispatched but no response arrived
 *        (timeout): the mutation MAY have been applied. Retrying is SAFE
 *        because every mutation carries an idempotency key (RL-LOCK-014); the
 *        RoamLink-side classification is `unknown-state`.
 *  - ADCOS error responses surface as `AdcosApiError` carrying the closed v2
 *    error code; a response outside the pinned contract (unknown error code,
 *    non-JSON body, malformed page envelope) fails CLOSED with
 *    `version-unsupported` - it is a contract incompatibility signal, never a
 *    guess (spec/security.md "Fail-safe defaults").
 *
 * Secret hygiene (RL-LOCK-016): the credential is held server-side only and
 * never appears in errors, logs, or thrown messages - transport errors name
 * the failure phase, never header values or URLs.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ValidationError,
  parseIdempotencyKey,
  type IdempotencyKey,
} from "@roamlink/contracts";
import {
  ADCOS_API_VERSION,
  ADCOS_REQUEST_HEADER_NAMES,
  AdcosApiError,
  isAdcosErrorCode,
  type AdcosEnvironment,
} from "@roamlink/adcos";

// --------------------------------------------------------------------------------
// Transport port + typed transport failure
// --------------------------------------------------------------------------------

/** The RoamLink-side view of what happened to a failed transport attempt. */
export type AdcosTransportOutcome = "not-sent" | "unknown";

/**
 * A transport-level failure (no ADCOS response was obtained). This is the
 * transport-error wrapper the client seam anticipates; it deliberately
 * carries NO ADCOS error code (there was no ADCOS answer to classify).
 */
export class AdcosTransportError extends Error {
  readonly outcome: AdcosTransportOutcome;

  constructor(outcome: AdcosTransportOutcome, message: string) {
    super(message);
    this.outcome = outcome;
    this.name = "AdcosTransportError";
    Object.freeze(this);
  }
}

/** One wire request. `mutation` requests MUST carry an idempotency key. */
export interface AdcosTransportRequest {
  readonly method: "GET" | "POST";
  /** Resolved route path, e.g. "intents" or "intents/{id}" with ids substituted. */
  readonly path: string;
  /** Flattened query parameters (pagination/filters). */
  readonly query?: Readonly<Record<string, string>>;
  /** Canonical JSON body for POST requests. */
  readonly body?: string;
  readonly mutation: boolean;
  /** REQUIRED when `mutation` is true (RL-LOCK-014). */
  readonly idempotencyKey?: IdempotencyKey;
}

/** A wire response with the parsed JSON body (unknown until validated). */
export interface AdcosTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

/** The transport port. Tests stub it; production uses the HTTP transport. */
export interface AdcosTransport {
  request(request: AdcosTransportRequest): Promise<AdcosTransportResponse>;
}

// --------------------------------------------------------------------------------
// Error-body parsing (closed taxonomy)
// --------------------------------------------------------------------------------

const ADCOS_ERROR_BODY_FIELDS = ["code", "message"] as const;

/**
 * Parses an ADCOS error response body. The body must be an object with a
 * `code` member inside the closed 18-code taxonomy; anything else is a
 * contract violation and fails closed as `version-unsupported`.
 */
export function parseAdcosErrorBody(status: number, body: unknown): AdcosApiError {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return new AdcosApiError(
      "version-unsupported",
      "ADCOS response violated the pinned v2 contract: the error response body is not a JSON object (failing closed as a version incompatibility signal)",
    );
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(ADCOS_ERROR_BODY_FIELDS as readonly string[]).includes(key)) {
      return new AdcosApiError(
        "version-unsupported",
        "ADCOS response violated the pinned v2 contract: the error response body carries unknown members (failing closed as a version incompatibility signal)",
      );
    }
  }
  const code = record["code"];
  if (!isAdcosErrorCode(code)) {
    return new AdcosApiError(
      "version-unsupported",
      "ADCOS response carried an error code outside the pinned v2 taxonomy (failing closed as a version incompatibility signal)",
    );
  }
  const message =
    typeof record["message"] === "string" && record["message"].length > 0
      ? record["message"]
      : `ADCOS v2 request failed with error code '${code}' (HTTP ${status})`;
  return new AdcosApiError(code, message);
}

// --------------------------------------------------------------------------------
// The fetch-based HTTP transport
// --------------------------------------------------------------------------------

/** Default request timeout (10s). A timeout yields outcome `"unknown"`. */
export const ADCOS_DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface AdcosHttpTransportConfig {
  /** The environment the transport is scoped to (must match the client). */
  readonly environment: AdcosEnvironment;
  /** Base URL of the environment-scoped ADCOS v2 API, no trailing slash. */
  readonly baseUrl: string;
  /** The RoamLink application identity (X-ADCOS-Application value). */
  readonly application: string;
  /**
   * The server-side ADCOS credential (X-ADCOS-Credential value). NEVER logged,
   * never projected, never included in errors (RL-LOCK-016).
   */
  readonly credential: string;
  /** Request timeout in milliseconds; defaults to 10s. */
  readonly timeoutMs?: number;
  /** Injectable fetch for tests; defaults to the global fetch (Node >= 22). */
  readonly fetchLike?: typeof fetch;
}

function buildUrl(baseUrl: string, path: string, query?: Readonly<Record<string, string>>): string {
  if (baseUrl.length === 0) {
    throw new ValidationError("AdcosHttpTransportConfig.baseUrl must not be empty", {
      reason: "ADCOS_TRANSPORT_CONFIG_INVALID",
      details: [{ path: "baseUrl", issue: "must be the environment-scoped API base URL" }],
    });
  }
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const url = `${normalizedBase}/${path}`;
  if (query === undefined || Object.keys(query).length === 0) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.append(key, value);
  }
  return `${url}?${params.toString()}`;
}

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", Accept: "application/json" };
}

/**
 * Creates the production HTTP transport. The transport owns exactly one
 * concern: turning typed requests into wire requests and wire responses into
 * typed responses/failures. Routing, schemas and idempotency policy live in
 * the client implementation, not here.
 */
export function createAdcosHttpTransport(config: AdcosHttpTransportConfig): AdcosTransport {
  if (typeof config.application !== "string" || config.application.length === 0) {
    throw new ValidationError("AdcosHttpTransportConfig.application must be a non-empty string", {
      reason: "ADCOS_TRANSPORT_CONFIG_INVALID",
      details: [{ path: "application", issue: "must name the RoamLink application identity" }],
    });
  }
  if (typeof config.credential !== "string" || config.credential.length === 0) {
    throw new ValidationError("AdcosHttpTransportConfig.credential must be a non-empty string", {
      reason: "ADCOS_TRANSPORT_CONFIG_INVALID",
      details: [{ path: "credential", issue: "must provide the server-side ADCOS credential" }],
    });
  }
  const timeoutMs =
    config.timeoutMs !== undefined
      ? config.timeoutMs
      : ADCOS_DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new ValidationError("AdcosHttpTransportConfig.timeoutMs must be a positive integer", {
      reason: "ADCOS_TRANSPORT_CONFIG_INVALID",
      details: [{ path: "timeoutMs", issue: "must be a positive integer" }],
    });
  }
  const doFetch = config.fetchLike ?? fetch;

  return {
    async request(request: AdcosTransportRequest): Promise<AdcosTransportResponse> {
      if (request.mutation) {
        if (request.idempotencyKey === undefined) {
          throw new AdcosApiError(
            "idempotency-key-required",
            "every ADCOS mutation requires an idempotency key (RL-LOCK-014); the transport refuses to send an unkeyed mutation",
          );
        }
        parseIdempotencyKey(request.idempotencyKey);
      }
      const headers: Record<string, string> = {
        ...jsonHeaders(),
        [ADCOS_REQUEST_HEADER_NAMES.apiVersion]: ADCOS_API_VERSION,
        [ADCOS_REQUEST_HEADER_NAMES.application]: config.application,
        [ADCOS_REQUEST_HEADER_NAMES.credential]: config.credential,
      };
      if (request.idempotencyKey !== undefined) {
        headers[ADCOS_REQUEST_HEADER_NAMES.idempotencyKey] = request.idempotencyKey;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(buildUrl(config.baseUrl, request.path, request.query), {
          method: request.method,
          headers,
          ...(request.body !== undefined ? { body: request.body } : {}),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          // Dispatched but unanswered: the outcome is UNKNOWN (may have applied).
          throw new AdcosTransportError(
            "unknown",
            "ADCOS request timed out before a response arrived; the mutation outcome is unknown and a retry is safe only because every mutation is idempotency-keyed (RL-LOCK-014)",
          );
        }
        // Network-level failure (connection refused, DNS, TLS): the request did
        // not produce an ADCOS response. Treated as not-sent; values are never
        // echoed (RL-LOCK-016).
        throw new AdcosTransportError(
          "not-sent",
          "ADCOS request failed at the network layer before a response was obtained (connection loss); the request outcome is not-sent for this attempt",
        );
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      let body: unknown;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new AdcosApiError(
            "version-unsupported",
            "ADCOS response violated the pinned v2 contract: the response body is not JSON (failing closed as a version incompatibility signal)",
          );
        }
      } else {
        body = null;
      }

      // The transport returns the raw parsed response for EVERY status;
      // error classification (closed taxonomy) is the CLIENT's single
      // responsibility - see client-impl.ts.
      return { status: response.status, body };
    },
  };
}

// --------------------------------------------------------------------------------
// HMAC helper (compatibility-gate webhook-semantics self-test)
// --------------------------------------------------------------------------------

/**
 * Computes the HMAC-SHA256 hex signature over the canonical webhook signature
 * message (the compatibility gate uses this to self-test the signature
 * scheme; production verification lives in @roamlink/webhook-inbox).
 */
export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

/** Constant-time equality of two hex strings (length-safe). */
export function constantTimeHexEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
