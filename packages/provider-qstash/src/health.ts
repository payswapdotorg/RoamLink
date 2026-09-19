/**
 * Health-check composition for the QStash transport (RL-097 probe / RL-100).
 *
 * Produces a check compatible with the @roamlink/observability
 * {@link HealthRegistry} (deployment.md §7 "health/readiness is real, not
 * fake"). The probe is the package's READ-ONLY {@link TransportProbePort}
 * (no message is created - enqueue can never serve as a probe).
 *
 * Failure semantics: a rejected probe yields `down` with a SUPPRESSED
 * detail (provider error text may carry endpoint/credential hints -
 * RL-LOCK-016); `checkedAt` comes from the injectable clock so tests are
 * deterministic.
 *
 * Readiness CRITICALITY (composition decision, deployment.md §7 "Redis is
 * optional for correctness" applies to every accelerator/transport the
 * system is correct without): QStash is retryable ASYNC TRANSPORT - never
 * business-state authority (ADR-0003). Hosts that compose it register this
 * check as OPTIONAL, so a down transport degrades readiness and never
 * blocks it; hosts that run without QStash do not register the check at
 * all (an uncomposed dependency is not reported - no fake surface).
 */
import { nowUtc, ValidationError, type UtcInstant } from "@roamlink/contracts";
import type { HealthCheck, HealthCheckOutput } from "@roamlink/observability";
import type { TransportProbePort } from "./port.js";

export interface QStashHealthCheckOptions {
  /** Registry name (default `qstash`; must satisfy the naming convention). */
  readonly name?: string;
  readonly probe: TransportProbePort;
  /** Injectable clock; defaults to the system clock (production). */
  readonly clock?: { now(): UtcInstant };
}

const DEFAULT_CHECK_NAME = "qstash";
const HEALTH_NAME_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

export function createQStashHealthCheck(options: QStashHealthCheckOptions): HealthCheck {
  if (options === null || typeof options !== "object") {
    throw new ValidationError("QStashHealthCheckOptions must be an object", {
      reason: "QSTASH_HEALTH_CONFIG_INVALID",
      details: [{ path: "QStashHealthCheckOptions", issue: "not an object" }],
    });
  }
  const name = options.name ?? DEFAULT_CHECK_NAME;
  if (!HEALTH_NAME_PATTERN.test(name)) {
    throw new ValidationError(
      "health check names must be lowercase dependency labels (e.g. 'qstash', 'qstash.transport')",
      {
        reason: "QSTASH_HEALTH_CONFIG_INVALID",
        details: [{ path: "name", issue: "violates the dependency naming convention" }],
      },
    );
  }
  if (options.probe === null || typeof options.probe !== "object" || typeof options.probe.probe !== "function") {
    throw new ValidationError("QStashHealthCheckOptions.probe must be a TransportProbePort (an object with probe())", {
      reason: "QSTASH_HEALTH_CONFIG_INVALID",
      details: [{ path: "probe", issue: "not a transport probe port" }],
    });
  }
  const probe = options.probe;
  const clock = options.clock ?? { now: () => nowUtc() };

  return {
    name,
    run: async (): Promise<HealthCheckOutput> => {
      const checkedAt = clock.now();
      try {
        await probe.probe();
        return {
          name,
          state: "healthy",
          detail: "the QStash transport answered its read-only probe",
          checkedAt,
        };
      } catch {
        return {
          name,
          state: "down",
          // Suppressed on purpose: provider failures may embed endpoint or
          // credential hints (RL-LOCK-016). The non-delivered path remains
          // authoritative for correctness (QStash is transport only).
          detail: "the QStash transport probe failed (detail suppressed); async delivery is an accelerator, never durable truth",
          checkedAt,
        };
      }
    },
  };
}
