/**
 * The distributed fixed-window limiter over the bounded ephemeral port
 * (RL-096) - the genuine "wiring point" with @roamlink/resilience.
 *
 * packages/resilience's limiters are single-process in-memory; hosted
 * deployments need per-tenant admission that agrees ACROSS instances.
 * This limiter keeps the resilience `LimiterDecision` shape and key
 * discipline but backs the counters with the Redis accelerator's
 * `incrementWithTtl` (bounded: the window key always carries a TTL equal
 * to the window length, so state self-destructs - never durable).
 *
 * Determinism: the window bucket is derived PURELY from the caller's
 * explicit instant (floor(epochMs / windowMs)), so behavior is a pure
 * function of (key, cost, at) - testkit-clock reproducible.
 *
 * Failure semantics: a Redis failure propagates as the port's typed
 * error - callers degrade to their non-accelerated admission path (e.g.
 * the in-process resilience limiter) rather than guessing.
 */
import { ValidationError, epochMsOf, parseUtcInstant, type UtcInstant } from "@roamlink/contracts";
import type { LimiterDecision } from "@roamlink/resilience";
import { LIMITER_KEY_PATTERN } from "@roamlink/resilience";
import type { EphemeralCoordinationPort } from "./port.js";

export interface DistributedFixedWindowOptions {
  /** Window length in milliseconds (>= 1000; Redis windows are coarse). */
  readonly windowMs: number;
  /** Maximum total cost admissible within any window (>= 1). */
  readonly maxCost: number;
  /** Key namespace prefix (safe label; the window bucket is appended). */
  readonly keyPrefix: string;
}

export class DistributedFixedWindowLimiter {
  readonly #windowMs: number;
  readonly #maxCost: number;
  readonly #keyPrefix: string;
  readonly #port: EphemeralCoordinationPort;

  constructor(options: DistributedFixedWindowOptions, port: EphemeralCoordinationPort) {
    if (options === null || typeof options !== "object") {
      throw new ValidationError("DistributedFixedWindowOptions must be an object", {
        reason: "DISTRIBUTED_LIMITER_CONFIG_INVALID",
        details: [{ path: "DistributedFixedWindowOptions", issue: "not an object" }],
      });
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1_000 || options.windowMs > 3_600_000) {
      throw new ValidationError("windowMs must be an integer between 1000 and 3600000", {
        reason: "DISTRIBUTED_LIMITER_CONFIG_INVALID",
        details: [{ path: "windowMs", issue: "out of bounds" }],
      });
    }
    if (!Number.isInteger(options.maxCost) || options.maxCost < 1 || options.maxCost > 1_000_000_000) {
      throw new ValidationError("maxCost must be an integer between 1 and 1000000000", {
        reason: "DISTRIBUTED_LIMITER_CONFIG_INVALID",
        details: [{ path: "maxCost", issue: "out of bounds" }],
      });
    }
    if (typeof options.keyPrefix !== "string" || !LIMITER_KEY_PATTERN.test(options.keyPrefix)) {
      throw new ValidationError("keyPrefix must be a safe label (resilience limiter-key discipline)", {
        reason: "DISTRIBUTED_LIMITER_CONFIG_INVALID",
        details: [{ path: "keyPrefix", issue: "not a safe label" }],
      });
    }
    this.#windowMs = options.windowMs;
    this.#maxCost = options.maxCost;
    this.#keyPrefix = options.keyPrefix;
    this.#port = port;
  }

  get windowMs(): number {
    return this.#windowMs;
  }

  get maxCost(): number {
    return this.#maxCost;
  }

  /** Tries to admit `cost` for `key` as of `at` (integer cost >= 1). */
  async tryTake(key: string, cost: number, at: UtcInstant | string): Promise<LimiterDecision> {
    if (typeof key !== "string" || !LIMITER_KEY_PATTERN.test(key)) {
      throw new ValidationError("limiter keys must be safe labels (resilience discipline)", {
        reason: "DISTRIBUTED_LIMITER_KEY_INVALID",
        details: [{ path: "key", issue: "not a safe label" }],
      });
    }
    if (!Number.isInteger(cost) || cost < 1 || cost > this.#maxCost) {
      throw new ValidationError(`cost must be an integer between 1 and ${this.#maxCost}`, {
        reason: "DISTRIBUTED_LIMITER_COST_INVALID",
        details: [{ path: "cost", issue: "out of bounds" }],
      });
    }
    const instant = parseUtcInstant(at);
    const nowMs = epochMsOf(instant);
    const bucket = Math.floor(nowMs / this.#windowMs);
    const windowKey = `${this.#keyPrefix}:${key}:${bucket}`;
    const { count } = await this.#port.incrementWithTtl(windowKey, this.#windowMs, cost);
    if (count <= this.#maxCost) {
      return { allowed: true, remaining: Math.max(0, this.#maxCost - count) };
    }
    // Bucket boundaries are epoch-aligned: the next window opens at
    // (bucket + 1) * windowMs.
    const retryAfterMs = Math.max(1, (bucket + 1) * this.#windowMs - nowMs);
    return { allowed: false, remaining: 0, retryAfterMs };
  }
}
