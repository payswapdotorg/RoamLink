/**
 * Health-check composition for object storage (RL-098).
 *
 * The probe performs a real GET of a probe key through the configured
 * port: ANY structured answer (object found OR null-for-absent) proves
 * the storage path is reachable, so absence is a healthy answer. Errors
 * (unreachable provider, failed signing round trip) are `down` with a
 * suppressed detail (RL-LOCK-016).
 */
import type { HealthCheck, HealthCheckOutput } from "@roamlink/observability";
import { nowUtc, ValidationError, type UtcInstant } from "@roamlink/contracts";
import type { ObjectStoragePort } from "./port.js";

export interface ObjectStorageHealthCheckOptions {
  readonly name?: string;
  readonly port: ObjectStoragePort;
  /** Probe key (default `health/probe` - need not exist). */
  readonly probeKey?: string;
  readonly clock?: { now(): UtcInstant };
}

const DEFAULT_CHECK_NAME = "object-storage";
const DEFAULT_PROBE_KEY = "health/probe";
const HEALTH_NAME_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

export function createObjectStorageHealthCheck(options: ObjectStorageHealthCheckOptions): HealthCheck {
  if (options === null || typeof options !== "object") {
    throw new ValidationError("ObjectStorageHealthCheckOptions must be an object", {
      reason: "OBJECT_HEALTH_CONFIG_INVALID",
      details: [{ path: "ObjectStorageHealthCheckOptions", issue: "not an object" }],
    });
  }
  const name = options.name ?? DEFAULT_CHECK_NAME;
  if (!HEALTH_NAME_PATTERN.test(name)) {
    throw new ValidationError(
      "health check names must be lowercase dependency labels (e.g. 'object-storage', 'object-storage.exports')",
      {
        reason: "OBJECT_HEALTH_CONFIG_INVALID",
        details: [{ path: "name", issue: "violates the dependency naming convention" }],
      },
    );
  }
  const port = options.port;
  const probeKey = options.probeKey ?? DEFAULT_PROBE_KEY;
  const clock = options.clock ?? { now: () => nowUtc() };

  return {
    name,
    run: async (): Promise<HealthCheckOutput> => {
      const checkedAt = clock.now();
      try {
        const result = await port.get(probeKey);
        return {
          name,
          state: "healthy",
          detail: result === null ? "the storage path answered (probe object absent)" : "the storage path answered (probe object present)",
          checkedAt,
        };
      } catch {
        return {
          name,
          state: "down",
          detail: "the object-storage probe failed (detail suppressed)",
          checkedAt,
        };
      }
    },
  };
}
