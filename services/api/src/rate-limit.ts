/**
 * The API edge rate-limiting seam (RL-105).
 *
 * spec/deployment.md §2/§7 + RL-LOCK discipline: admission control is a
 * bounded accelerator. The distributed primitive is the provider-redis
 * `DistributedFixedWindowLimiter` over the `EphemeralCoordinationPort`
 * (RL-096) - bound by the composition root when the Redis accelerator is
 * configured. This module defines the transport-independent seam the API
 * service composes, the honest in-memory fallback for NON-production modes,
 * and the readiness vocabulary binding:
 *
 *  - `distributed`  - Redis-backed (the production shape); readiness healthy;
 *  - `in-memory`    - single-process window, NON-production fallback ONLY,
 *                     always accompanied by an honest composition log line;
 *                     readiness degraded (it is not distributed);
 *  - `disabled`     - production mode with no distributed limiter bound:
 *                     the in-memory fallback is REFUSED (a silent single-
 *                     process limiter in production would be a quiet
 *                     downgrade), rate limiting is off, and the readiness
 *                     surface carries `degraded:rate-limit` so the gap is
 *                     visible - never ready-without-admission-control.
 *
 * Redis is optional for CORRECTNESS (deployment.md §7) - the service stays
 * servable without it - but the ABSENCE of admission control in production
 * is a degradation the readiness surface must show, never hide.
 */
import { RoamLinkError, ValidationError, type UtcInstant } from "@roamlink/contracts";
import { SlidingWindowLimiter, type LimiterDecision } from "@roamlink/resilience";
import type { HealthCheck } from "@roamlink/observability";

/**
 * The rate-limiter seam. Implementations MUST return the closed
 * {@link LimiterDecision} shape (never throw for a "no") and MUST be pure
 * functions of (key, cost, at) so behavior stays deterministic under the
 * injected clock. `DistributedFixedWindowLimiter` (provider-redis) and the
 * in-memory fallback below both satisfy it structurally.
 */
export interface ApiRateLimiter {
  tryTake(key: string, cost: number, at: UtcInstant | string): Promise<LimiterDecision>;
}

/** The default per-bucket window: one minute, epoch-aligned. */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

/** The default per-bucket cost budget (requests per window). */
export const DEFAULT_RATE_LIMIT_MAX_COST = 600;

export interface ApiRateLimitOptions {
  readonly windowMs?: number;
  readonly maxCost?: number;
}

/**
 * The honest in-memory fallback (NON-production modes only - see the module
 * doc). Wraps the resilience sliding-window limiter: single-process, exact
 * window accounting, closed decision shape, explicit-instant determinism.
 */
export function createInMemoryApiRateLimiter(options: ApiRateLimitOptions = {}): ApiRateLimiter {
  const windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const maxCost = options.maxCost ?? DEFAULT_RATE_LIMIT_MAX_COST;
  const limiter = new SlidingWindowLimiter({ windowMs, maxCost });
  return {
    async tryTake(key, cost, at) {
      return limiter.tryTake(key, cost, at);
    },
  };
}

/** The closed binding-state vocabulary the readiness surface reports. */
export type RateLimitBindingState =
  | { readonly kind: "distributed" }
  | { readonly kind: "in-memory" }
  | { readonly kind: "disabled"; readonly reason: string };

/**
 * Resolves the rate-limit binding EXACTLY as the API service does (the
 * single source of truth) so hosts can compose the matching readiness
 * check. Never silently downgrades: in production mode without a bound
 * distributed limiter the binding is honestly `disabled`.
 */
export function resolveRateLimitBinding(
  mode: "production" | "development",
  bound: ApiRateLimiter | undefined,
): { readonly state: RateLimitBindingState; readonly limiter: ApiRateLimiter | undefined } {
  if (bound !== undefined) {
    return { state: { kind: "distributed" }, limiter: bound };
  }
  if (mode === "production") {
    return {
      state: {
        kind: "disabled",
        reason:
          "production mode requires an explicitly bound distributed rate limiter (edge.rateLimiter); the in-memory fallback is refused in production",
      },
      limiter: undefined,
    };
  }
  return { state: { kind: "in-memory" }, limiter: createInMemoryApiRateLimiter() };
}

/** The readiness dependency name for the admission-control binding. */
export const RATE_LIMIT_CHECK_NAME = "rate-limit";

/**
 * The readiness check for the rate-limit binding (compose it as an OPTIONAL
 * dependency: rate limiting is an accelerator/protective layer - its absence
 * degrades the surface, it never blocks correctness it does not own).
 */
export function rateLimitReadinessCheck(state: RateLimitBindingState): HealthCheck {
  return {
    name: RATE_LIMIT_CHECK_NAME,
    run: async () => {
      const checkedAt = new Date().toISOString();
      switch (state.kind) {
        case "distributed":
          return {
            name: RATE_LIMIT_CHECK_NAME,
            state: "healthy" as const,
            detail: "distributed fixed-window admission is bound",
            checkedAt,
          };
        case "in-memory":
          return {
            name: RATE_LIMIT_CHECK_NAME,
            state: "degraded" as const,
            detail: "single-process in-memory admission window (non-production fallback; not distributed)",
            checkedAt,
          };
        case "disabled":
          return {
            name: RATE_LIMIT_CHECK_NAME,
            state: "degraded" as const,
            detail: `rate limiting is disabled: ${state.reason}`,
            checkedAt,
          };
      }
    },
  };
}

// --------------------------------------------------------------------------------
// Bucket-key discipline
// --------------------------------------------------------------------------------

/**
 * Limiter bucket keys are safe labels (the resilience limiter-key pattern);
 * any header-derived hint that does not fit falls back to `anonymous` - a
 * hostile or malformed hint can never break the key contract.
 */
function safeBucketLabel(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.length > 128) return "anonymous";
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value) ? value : "anonymous";
}

function headerValue(headers: Readonly<Record<string, string>>, lowerName: string): string | undefined {
  const direct = headers[lowerName];
  if (typeof direct === "string" && direct.length > 0) return direct;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === lowerName && typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * The per-request bucket key: per-route classes; per-principal where the
 * transport context carries a safe hint.
 *
 *  - webhook ingress -> `webhooks-adcos.<delivery key id | anonymous>`
 *  - login           -> `auth-session` (pre-authentication: no principal hint)
 *  - everything else -> `api.<actor header hint | anonymous>`
 *
 * The actor header is TRANSPORT CONTEXT, never an authorization grant (the
 * session decides the actor after dispatch); it is used here only as a
 * bucket hint so abusive authenticated traffic is contained per principal
 * without composing authorization into the limiter.
 */
export function rateLimitBucketKeyOf(
  method: string,
  path: string,
  headers: Readonly<Record<string, string>>,
): string {
  if (method === "POST" && path === "/v1/webhooks/adcos") {
    const keyId = safeBucketLabel(headerValue(headers, "x-adcos-key-id"));
    return `webhooks-adcos.${keyId}`;
  }
  if (method === "POST" && path === "/v1/auth/session") {
    return "auth-session";
  }
  const actorHint = safeBucketLabel(headerValue(headers, "x-roamlink-actor-id"));
  return `api.${actorHint}`;
}

/** The typed 429 the edge throws on a declined admission (mapped by http.ts). */
export function rateLimitExceeded(retryAfterMs: number): RateLimitRejection {
  return new RateLimitRejection(retryAfterMs);
}

/**
 * A declined admission as a typed RoamLink error. It rides the SAME closed
 * taxonomy and the SAME errorToResponse mapping as every other edge failure
 * (single mapping site): kind `rate-limited` -> 429, `retryable: true`, the
 * decision's `retryAfterMs` carried in the body and surfaced by http.ts as
 * the `retry-after` response header.
 */
export class RateLimitRejection extends RoamLinkError {
  constructor(retryAfterMs: number) {
    super(
      "rate-limited",
      "the request was not admitted: the rate-limit budget for this bucket is exhausted for the current window (retry after the indicated interval)",
      {
        reason: "RATE_LIMITED",
        retryable: true,
        retryAfterMs: Number.isInteger(retryAfterMs) && retryAfterMs >= 1 ? retryAfterMs : 1000,
        details: [{ path: "rate-limit", issue: "bucket budget exhausted for the current window" }],
      },
    );
  }
}

/** Guards the limiter config at composition (fail loud at boot, never per request). */
export function parseRateLimitOptions(options: ApiRateLimitOptions | undefined): ApiRateLimitOptions {
  if (options === undefined) return {};
  const issues: string[] = [];
  if (options.windowMs !== undefined && (!Number.isInteger(options.windowMs) || options.windowMs < 1)) {
    issues.push("windowMs");
  }
  if (options.maxCost !== undefined && (!Number.isInteger(options.maxCost) || options.maxCost < 1)) {
    issues.push("maxCost");
  }
  if (issues.length > 0) {
    throw new ValidationError(`the API rate-limit options are invalid: ${issues.join(", ")}`, {
      reason: "API_RATE_LIMIT_CONFIG_INVALID",
      details: issues.map((path) => ({ path, issue: "must be a positive integer" })),
    });
  }
  return options;
}
