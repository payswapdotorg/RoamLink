/**
 * Health-check composition for the Redis accelerator (RL-096).
 *
 * IMPORTANT readiness semantics (deployment.md §7 "Redis is optional for
 * correctness"): this check reports the ACCELERATOR's availability - a
 * `down` state here must never fail the whole deployment's readiness on
 * its own. Hosts that run without Redis MUST NOT register this check;
 * hosts that run with it register it and treat `down` as a degraded
 * accelerator signal (their non-accelerated path continues to be correct).
 */
import type { HealthCheck, HealthCheckOutput } from "@roamlink/observability";
import { nowUtc, ValidationError, type UtcInstant } from "@roamlink/contracts";
import type { EphemeralCoordinationPort } from "./port.js";

export interface RedisHealthCheckOptions {
  readonly name?: string;
  readonly port: EphemeralCoordinationPort;
  readonly clock?: { now(): UtcInstant };
}

const DEFAULT_CHECK_NAME = "redis";
const HEALTH_NAME_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

export function createRedisHealthCheck(options: RedisHealthCheckOptions): HealthCheck {
  if (options === null || typeof options !== "object") {
    throw new ValidationError("RedisHealthCheckOptions must be an object", {
      reason: "REDIS_HEALTH_CONFIG_INVALID",
      details: [{ path: "RedisHealthCheckOptions", issue: "not an object" }],
    });
  }
  const name = options.name ?? DEFAULT_CHECK_NAME;
  if (!HEALTH_NAME_PATTERN.test(name)) {
    throw new ValidationError(
      "health check names must be lowercase dependency labels (e.g. 'redis', 'redis.cache')",
      {
        reason: "REDIS_HEALTH_CONFIG_INVALID",
        details: [{ path: "name", issue: "violates the dependency naming convention" }],
      },
    );
  }
  const port = options.port;
  const clock = options.clock ?? { now: () => nowUtc() };

  return {
    name,
    run: async (): Promise<HealthCheckOutput> => {
      const checkedAt = clock.now();
      try {
        const alive = await port.ping();
        return alive
          ? { name, state: "healthy", detail: "the Redis accelerator answered PING", checkedAt }
          : { name, state: "down", detail: "the Redis accelerator did not answer PING (detail suppressed)", checkedAt };
      } catch {
        return {
          name,
          state: "down",
          detail: "the Redis accelerator probe failed (detail suppressed); the non-accelerated path remains authoritative",
          checkedAt,
        };
      }
    },
  };
}
