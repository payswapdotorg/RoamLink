/**
 * Neon connection health check helper (RL-095).
 *
 * Produces a check compatible with the @roamlink/observability
 * {@link HealthRegistry} (deployment.md §7 "health/readiness is real, not
 * fake"): the REAL probe is injected by the driver path - a
 * {@link PostgresProbePort} that executes a trivial query (`SELECT 1`-class)
 * through the actual PostgreSQL driver configured from DATABASE_URL.
 *
 * Failure semantics: a probe that rejects yields `down` with a SUPPRESSED
 * detail (driver error text may embed connection strings - RL-LOCK-016);
 * `checkedAt` comes from the injectable clock so tests are deterministic.
 * The probe port contract requires implementations to bound their own
 * latency (serverless hosts kill requests at ~10-60s) - this helper imposes
 * NO ambient timers, keeping behavior deterministic.
 */
import { nowUtc, ValidationError, type UtcInstant } from "@roamlink/contracts";
import type { HealthCheck, HealthCheckOutput } from "@roamlink/observability";

/**
 * The probe port the PostgreSQL driver path implements. Keep it ONE method:
 * the health surface must never grow into a query surface (that would
 * smuggle persistence authority into the provider adapter).
 */
export interface PostgresProbePort {
  /** Executes the probe query; resolves on success, rejects on failure. */
  probe(): Promise<void>;
}

export interface NeonHealthCheckOptions {
  /** Registry name (default `database`; must satisfy the health naming convention). */
  readonly name?: string;
  readonly probe: PostgresProbePort;
  /** Injectable clock; defaults to the system clock (production). */
  readonly clock?: { now(): UtcInstant };
}

const DEFAULT_CHECK_NAME = "database";
const HEALTH_NAME_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

/**
 * Builds the Neon/PostgreSQL health check for registration against a
 * `HealthRegistry`. States: healthy (probe resolved), down (probe rejected
 * or returned garbage) - there is deliberately no `degraded` variant: a
 * probe either completes against the durable source of truth or it does not.
 */
export function createNeonHealthCheck(options: NeonHealthCheckOptions): HealthCheck {
  if (options === null || typeof options !== "object") {
    throw new ValidationError("NeonHealthCheckOptions must be an object", {
      reason: "NEON_HEALTH_CONFIG_INVALID",
      details: [{ path: "NeonHealthCheckOptions", issue: "not an object" }],
    });
  }
  const name = options.name ?? DEFAULT_CHECK_NAME;
  if (!HEALTH_NAME_PATTERN.test(name)) {
    throw new ValidationError(
      "health check names must be lowercase dependency labels (e.g. 'database', 'database.neon-pooler')",
      {
        reason: "NEON_HEALTH_CONFIG_INVALID",
        details: [{ path: "name", issue: "violates the dependency naming convention" }],
      },
    );
  }
  if (options.probe === null || typeof options.probe !== "object" || typeof options.probe.probe !== "function") {
    throw new ValidationError("NeonHealthCheckOptions.probe must be a PostgresProbePort (an object with probe())", {
      reason: "NEON_HEALTH_CONFIG_INVALID",
      details: [{ path: "probe", issue: "not a probe port" }],
    });
  }
  const clock = options.clock ?? { now: () => nowUtc() };

  return {
    name,
    run: async (): Promise<HealthCheckOutput> => {
      const checkedAt = clock.now();
      try {
        await options.probe.probe();
        return {
          name,
          state: "healthy",
          detail: "the PostgreSQL probe query completed against the configured DATABASE_URL",
          checkedAt,
        };
      } catch {
        return {
          name,
          state: "down",
          // Suppressed on purpose: driver errors may embed the connection
          // string (RL-LOCK-016). Operators consult the runbook, not this text.
          detail: "the PostgreSQL probe query failed; the driver error text is suppressed",
          checkedAt,
        };
      }
    },
  };
}
