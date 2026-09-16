/**
 * Rate limiters (RL-053): token bucket + sliding window.
 *
 * PURE, TYPED primitives with in-memory state. Every admission decision is
 * made against an EXPLICIT caller-supplied UTC instant, so behavior is fully
 * deterministic under the @roamlink/testkit clock (spec/definition-of-done.md
 * "Deterministic test data") - no ambient timers, no randomness.
 *
 * Both limiters:
 *  - key their state by a SAFE LABEL (per-tenant / per-actor / per-route);
 *  - return a closed {@link LimiterDecision} (never throw for a "no");
 *  - expose read-only snapshots for tests and telemetry;
 *  - are single-process in-memory only; persistence-backed adapters and
 *    distributed coordination are later work (documented limitation).
 */
import {
  ValidationError,
  epochMsOf,
  parseUtcInstant,
  type UtcInstant,
} from "@roamlink/contracts";

/** Limiter state keys are safe labels (tenant ids, actor ids, routes). */
export const LIMITER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function parseLimiterKey(key: string): string {
  if (typeof key !== "string" || !LIMITER_KEY_PATTERN.test(key)) {
    throw new ValidationError(
      "limiter keys must be safe labels (1-128 chars, starts alphanumeric, then [A-Za-z0-9._:@-] only)",
      {
        reason: "LIMITER_KEY_INVALID",
        details: [{ path: "key", issue: "not a safe label" }],
      },
    );
  }
  return key;
}

function parseAt(at: UtcInstant | string): UtcInstant {
  return parseUtcInstant(at);
}

function parsePositiveInt(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ValidationError(`${label} must be an integer between 1 and ${max}`, {
      reason: "LIMITER_CONFIG_INVALID",
      details: [{ path: label, issue: "out of bounds" }],
    });
  }
  return value;
}

/** The closed admission decision. */
export type LimiterDecision =
  | {
      readonly allowed: true;
      /** Remaining budget after admitting this request. */
      readonly remaining: number;
    }
  | {
      readonly allowed: false;
      readonly remaining: number;
      /** Earliest ms AFTER `at` at which the same request might be admitted. */
      readonly retryAfterMs: number;
    };

// ---------------------------------------------------------------------------
// Token bucket
// ---------------------------------------------------------------------------

/** Options for {@link TokenBucketLimiter}. */
export interface TokenBucketOptions {
  /** Burst capacity: maximum tokens the bucket can hold (>= 1). */
  readonly capacity: number;
  /** Sustained refill rate in tokens per millisecond (positive, finite). */
  readonly refillTokensPerMs: number;
}

interface BucketState {
  tokens: number;
  lastRefillAtMs: number;
}

/**
 * Classic token bucket: the bucket starts FULL, refills continuously at
 * `refillTokensPerMs` (capped at `capacity`), and each admitted request
 * consumes tokens. Admission is a pure function of the explicit instant.
 */
export class TokenBucketLimiter {
  readonly #capacity: number;
  readonly #refillTokensPerMs: number;
  readonly #buckets = new Map<string, BucketState>();

  constructor(options: TokenBucketOptions) {
    if (options === null || typeof options !== "object") {
      throw new ValidationError("TokenBucketOptions must be an object", {
        reason: "LIMITER_CONFIG_INVALID",
        details: [{ path: "TokenBucketOptions", issue: "not an object" }],
      });
    }
    this.#capacity = parsePositiveInt(options.capacity, "capacity", 1_000_000);
    if (
      typeof options.refillTokensPerMs !== "number" ||
      !Number.isFinite(options.refillTokensPerMs) ||
      options.refillTokensPerMs <= 0
    ) {
      throw new ValidationError("refillTokensPerMs must be a positive finite number", {
        reason: "LIMITER_CONFIG_INVALID",
        details: [{ path: "refillTokensPerMs", issue: "not positive/finite" }],
      });
    }
    this.#refillTokensPerMs = options.refillTokensPerMs;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /**
   * Tries to admit a request consuming `tokens` for `key` as of `at`.
   * Fractional token costs are allowed (0 < tokens <= capacity).
   */
  tryTake(key: string, tokens: number, at: UtcInstant | string): LimiterDecision {
    const safeKey = parseLimiterKey(key);
    const instant = parseAt(at);
    if (
      typeof tokens !== "number" ||
      !Number.isFinite(tokens) ||
      tokens <= 0 ||
      tokens > this.#capacity
    ) {
      throw new ValidationError(
        `tokens must be a positive finite number no greater than the capacity (${this.#capacity})`,
        {
          reason: "LIMITER_REQUEST_INVALID",
          details: [{ path: "tokens", issue: "out of bounds" }],
        },
      );
    }
    const nowMs = epochMsOf(instant);
    const state = this.#buckets.get(safeKey);
    let current: number;
    if (state === undefined) {
      current = this.#capacity; // buckets start full
    } else {
      const elapsed = Math.max(0, nowMs - state.lastRefillAtMs);
      current = Math.min(this.#capacity, state.tokens + elapsed * this.#refillTokensPerMs);
    }
    if (tokens <= current + 1e-9) {
      const remaining = Math.max(0, current - tokens);
      this.#buckets.set(safeKey, { tokens: remaining, lastRefillAtMs: nowMs });
      return { allowed: true, remaining };
    }
    const deficit = tokens - current;
    const retryAfterMs = Math.ceil(deficit / this.#refillTokensPerMs);
    this.#buckets.set(safeKey, { tokens: current, lastRefillAtMs: nowMs });
    return { allowed: false, remaining: current, retryAfterMs };
  }

  /** Read-only snapshot of a key's bucket (never mutates/refills). */
  snapshot(key: string): { readonly tokens: number; readonly lastRefillAtMs: number } | undefined {
    const safeKey = parseLimiterKey(key);
    const state = this.#buckets.get(safeKey);
    return state === undefined ? undefined : Object.freeze({ ...state });
  }

  /** Number of tracked keys (telemetry/tests). */
  get trackedKeys(): number {
    return this.#buckets.size;
  }
}

// ---------------------------------------------------------------------------
// Sliding window (cost-based)
// ---------------------------------------------------------------------------

/** Options for {@link SlidingWindowLimiter}. */
export interface SlidingWindowOptions {
  /** Window length in milliseconds (>= 1). */
  readonly windowMs: number;
  /** Maximum total cost admissible within any window (>= 1). */
  readonly maxCost: number;
}

interface WindowEvent {
  atMs: number;
  cost: number;
}

/**
 * Exact sliding-window cost limiter: an admission is allowed when the sum of
 * costs recorded in `(at - windowMs, at]` plus the new cost stays within
 * `maxCost`. Events older than the window are pruned on every take.
 * `retryAfterMs` on a rejection is the earliest instant the OLDEST in-window
 * event slides out (a lower bound - enough budget may free up only later).
 */
export class SlidingWindowLimiter {
  readonly #windowMs: number;
  readonly #maxCost: number;
  readonly #events = new Map<string, WindowEvent[]>();

  constructor(options: SlidingWindowOptions) {
    if (options === null || typeof options !== "object") {
      throw new ValidationError("SlidingWindowOptions must be an object", {
        reason: "LIMITER_CONFIG_INVALID",
        details: [{ path: "SlidingWindowOptions", issue: "not an object" }],
      });
    }
    this.#windowMs = parsePositiveInt(options.windowMs, "windowMs", 2_147_483_647);
    this.#maxCost = parsePositiveInt(options.maxCost, "maxCost", 1_000_000_000);
  }

  get windowMs(): number {
    return this.#windowMs;
  }

  get maxCost(): number {
    return this.#maxCost;
  }

  /** Tries to admit `cost` for `key` as of `at` (integer cost >= 1). */
  tryTake(key: string, cost: number, at: UtcInstant | string): LimiterDecision {
    const safeKey = parseLimiterKey(key);
    const instant = parseAt(at);
    const units = parsePositiveInt(cost, "cost", this.#maxCost);
    const nowMs = epochMsOf(instant);
    const windowStart = nowMs - this.#windowMs;
    const events = (this.#events.get(safeKey) ?? []).filter((event) => event.atMs > windowStart);
    const activeCost = events.reduce((sum, event) => sum + event.cost, 0);
    if (activeCost + units <= this.#maxCost) {
      events.push({ atMs: nowMs, cost: units });
      this.#events.set(safeKey, events);
      return { allowed: true, remaining: this.#maxCost - activeCost - units };
    }
    this.#events.set(safeKey, events);
    const oldest = events[0];
    const retryAfterMs =
      oldest === undefined ? 1 : Math.max(1, oldest.atMs + this.#windowMs - nowMs);
    return { allowed: false, remaining: this.#maxCost - activeCost, retryAfterMs };
  }

  /** Read-only snapshot of a key's window (already pruned to nothing older). */
  snapshot(key: string): { readonly activeCost: number; readonly eventCount: number } | undefined {
    const safeKey = parseLimiterKey(key);
    const events = this.#events.get(safeKey);
    return events === undefined
      ? undefined
      : Object.freeze({
          activeCost: events.reduce((sum, event) => sum + event.cost, 0),
          eventCount: events.length,
        });
  }

  get trackedKeys(): number {
    return this.#events.size;
  }
}
