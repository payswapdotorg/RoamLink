/**
 * The composed readiness surface (RL-100).
 *
 * spec/deployment.md §7: "health/readiness is real, not fake" and
 * "Redis is optional for correctness". This module is the deployment's
 * observable truth layer for the API service: it aggregates the REAL state
 * of each composed dependency through the checks the composition binds -
 * every check probes through its provider port (the @roamlink/provider-*
 * health-check factories over the driver/adapter ports), so the surface is
 * testable with the in-memory fakes and works UNCHANGED against real
 * env-configured clients. Readiness NEVER infers from business events
 * (an order/payment/webhook success is not infrastructure truth) and never
 * hard-codes "ready": with no checks registered the answer is honestly
 * NOT ready.
 *
 * The wire vocabulary is the frozen honest triad:
 *
 *   ready                      all composed dependencies answered healthy
 *   degraded:<dependency,...>  servable, but at least one dependency is
 *                              unhealthy (an optional accelerator being
 *                              down lands here - NEVER a not-ready)
 *   not-ready:<reason,...>     a REQUIRED dependency (correctness owner)
 *                              is down - the deployment must not serve
 *
 * `<dependency>`/`<reason>` are the validated dependency names themselves
 * (lowercase safe labels per the observability naming convention), sorted
 * deterministically, value-free (RL-LOCK-016: no secrets, no provider
 * error text - per-check details are the suppression-safe explanations).
 *
 * Classification law:
 *   - a check is REQUIRED when its dependency owns correctness (the
 *     PostgreSQL source of truth, the migration ledger); its `down` state
 *     makes the whole surface not-ready;
 *   - a check is OPTIONAL when its dependency is an accelerator/transport
 *     the system is correct without (Redis, QStash, R2); ANY unhealthy
 *     state on it only ever degrades the surface.
 * Per-check states use the @roamlink/observability closed vocabulary
 * healthy | degraded | down; probe throws and garbage results are `down`
 * with SUPPRESSED detail (the registry's own semantics - RL-LOCK-016).
 */
import { nowUtc, type UtcInstant } from "@roamlink/contracts";
import type { HttpResponse } from "@roamlink/app-kit";
import {
  HealthRegistry,
  runHealthChecks,
  type HealthCheck,
  type HealthCheckResult,
} from "@roamlink/observability";

import { jsonResponse } from "./http.js";

/** How a composed dependency classifies for readiness (see module doc). */
export type ReadinessCriticality = "required" | "optional";

/**
 * One composed dependency: the REAL probe (a HealthCheck over a provider
 * port - fake in tests, real client in deployment) plus its criticality.
 */
export interface ReadinessCheckBinding {
  readonly check: HealthCheck;
  readonly criticality: ReadinessCriticality;
}

/**
 * The honest readiness status vocabulary: `ready | degraded:<deps> |
 * not-ready:<reasons>`. Dependency/reason lists are sorted, comma-joined
 * safe labels. The pattern is the closed contract the smoke suite asserts.
 */
export const READINESS_STATUS_PATTERN =
  /^(ready|degraded:[a-z0-9][a-z0-9.,-]*|not-ready:[a-z0-9][a-z0-9.,-]*)$/;

/** The composed readiness report (JSON-wire shape). */
export interface ComposedReadinessReport {
  /** The honest vocabulary string (see {@link READINESS_STATUS_PATTERN}). */
  readonly status: string;
  /**
   * Servability truth: true for ready AND degraded:<...> (the deployment
   * answers), false ONLY for not-ready:<...>. Never inferred from business
   * events - the aggregate of the real per-dependency probes.
   */
  readonly ready: boolean;
  /** The per-dependency real probe results (details are value-free). */
  readonly checks: readonly HealthCheckResult[];
  readonly evaluatedAt: UtcInstant;
}

/** The composed readiness surface (one instance per composition). */
export interface ComposedReadiness {
  /** Re-runs EVERY probe (live aggregation - never a boot-time snapshot). */
  readonly report: () => Promise<ComposedReadinessReport>;
}

/** Deterministically sorted, de-duplicated check names. */
function sortedNamesOf(
  results: readonly HealthCheckResult[],
  predicate: (result: HealthCheckResult) => boolean,
): string[] {
  const names = results.filter(predicate).map((result) => result.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...new Set(names)];
}

const NOT_READY_COMPOSITION_DETAIL =
  "no readiness checks are registered (readiness without probed evidence is never ready)";

/**
 * Composes the readiness surface over the bound dependency checks. Empty
 * bindings compose the honest refusal: `not-ready:composition` (never a
 * fake-ready answer when nothing is probed).
 */
export function composeReadiness(options: {
  readonly checks?: readonly ReadinessCheckBinding[];
  /** Injectable clock for the evaluation instant (tests); defaults to now. */
  readonly now?: () => UtcInstant;
}): ComposedReadiness {
  const bindings = options.checks ?? [];
  const now = options.now ?? nowUtc;

  if (bindings.length === 0) {
    return {
      report: async () => ({
        status: "not-ready:composition",
        ready: false,
        checks: [
          Object.freeze({
            name: "composition",
            state: "down" as const,
            detail: NOT_READY_COMPOSITION_DETAIL,
            checkedAt: now(),
          }),
        ],
        evaluatedAt: now(),
      }),
    };
  }

  const criticalityByName = new Map<string, ReadinessCriticality>(
    bindings.map((binding) => [binding.check.name, binding.criticality]),
  );
  // The observability registry owns validation (safe dependency labels,
  // duplicate rejection at composition time - fail loud at boot) and
  // runHealthChecks owns the real run semantics (concurrent probes,
  // throwing/garbage results become `down` with SUPPRESSED detail,
  // result-name mismatch is down).
  const registry = new HealthRegistry();
  for (const binding of bindings) {
    registry.register(binding.check);
  }

  return {
    report: async (): Promise<ComposedReadinessReport> => {
      const evaluated = await runHealthChecks(registry, { now });
      const isRequired = (result: HealthCheckResult): boolean =>
        criticalityByName.get(result.name) === "required";

      const requiredDown = sortedNamesOf(evaluated.checks, (result) => result.state === "down" && isRequired(result));
      if (requiredDown.length > 0) {
        return {
          status: `not-ready:${requiredDown.join(",")}`,
          ready: false,
          checks: evaluated.checks,
          evaluatedAt: evaluated.evaluatedAt,
        };
      }
      const unhealthy = sortedNamesOf(evaluated.checks, (result) => result.state !== "healthy");
      if (unhealthy.length > 0) {
        return {
          status: `degraded:${unhealthy.join(",")}`,
          ready: true,
          checks: evaluated.checks,
          evaluatedAt: evaluated.evaluatedAt,
        };
      }
      return {
        status: "ready",
        ready: true,
        checks: evaluated.checks,
        evaluatedAt: evaluated.evaluatedAt,
      };
    },
  };
}

/**
 * Maps the composed report onto the HTTP response: ready/degraded are
 * SERVABLE (200 - the vocabulary carries the degradation honestly);
 * not-ready is 503. The body IS the report (checks included) so operators
 * and the smoke suite see the per-dependency truth.
 */
export function readinessToResponse(report: ComposedReadinessReport): HttpResponse {
  return jsonResponse(report.ready ? 200 : 503, report);
}
