/**
 * SLO composition with the RL-040 health, metrics and logging contracts
 * (RL-052).
 *
 *  - {@link sloHealthState} maps the closed {@link SloState} vocabulary onto
 *    the health vocabulary: `within-budget` -> healthy; `at-risk`,
 *    `exhausted` and `no-data` -> degraded (an exhausted error budget is a
 *    reliability signal, not a liveness failure - `down` stays reserved for
 *    broken dependencies; `no-data` is never healthy, fail-safe defaults);
 *  - {@link sloHealthCheck} turns an SLO evaluation into a registrable
 *    {@link HealthCheck} so SLOs compose with the existing health registry.
 *    A throwing evaluation or a name mismatch surfaces as a fail-closed
 *    `down` result with suppressed details (RL-LOCK-016);
 *  - {@link registerSloMetrics} + {@link emitSloEvaluationMetrics} export
 *    SLO signals through the existing (vendor-free) metrics contract;
 *  - {@link sloLogFields} + {@link logSloEvaluation} produce correlation-
 *    aware, redaction-safe log fields reusing the RL-040 logger discipline:
 *    the emitted values are the SLO's own counters/ratios - never payloads
 *    or secrets (RL-LOCK-016).
 */
import { nowUtc, type UtcInstant } from "@roamlink/contracts";

import type { HealthCheck, HealthState } from "../health/health.js";
import type { MetricRegistry, MetricsRecorder } from "../metrics/metrics.js";
import type { LeveledLogger, } from "../logging/logger.js";
import type { LogFieldValue } from "../logging/log-record.js";
import type { SloEvaluation, SloState } from "./slo.js";

/** Maps a closed SLO state onto the health vocabulary (see module doc). */
export function sloHealthState(state: SloState): HealthState {
  switch (state) {
    case "within-budget":
      return "healthy";
    case "at-risk":
    case "exhausted":
    case "no-data":
      return "degraded";
  }
}

function formatRatio(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

/** A bounded, non-secret human summary of an evaluation. */
export function describeSloEvaluation(evaluation: SloEvaluation): string {
  switch (evaluation.state) {
    case "no-data":
      return `no events in the window (never silently healthy - fail-safe default)`;
    case "within-budget":
    case "at-risk":
    case "exhausted":
      return (
        `${evaluation.bad} bad of ${evaluation.total} events, ` +
        `burn rate ${formatRatio(evaluation.burnRate)}, ` +
        `budget remaining ${formatRatio(evaluation.budgetRemainingRatio)} ` +
        `(${evaluation.state})`
      );
  }
}

/** Options for {@link sloHealthCheck}. */
export interface SloHealthCheckOptions {
  /** Injectable clock for `checkedAt` (deterministic tests; default: system). */
  readonly now?: () => UtcInstant;
}

/**
 * Builds a {@link HealthCheck} from an SLO evaluation function. The check
 * name is the SLO name (validated by the registry's naming convention, which
 * the SLO naming convention mirrors); the detail is the bounded, non-secret
 * evaluation summary. A throwing evaluation function is handled by the
 * registry's fail-closed `down` path.
 */
export function sloHealthCheck(
  sloName: string,
  evaluate: () => SloEvaluation | Promise<SloEvaluation>,
  options?: SloHealthCheckOptions,
): HealthCheck {
  return {
    name: sloName,
    run: async () => {
      const now = options?.now ?? nowUtc;
      let evaluation: SloEvaluation;
      try {
        evaluation = await evaluate();
      } catch {
        // Fail-closed without propagating third-party error text
        // (RL-LOCK-016): an evaluation that cannot be produced is `down`.
        return {
          name: sloName,
          state: "down",
          detail: "SLO evaluation threw an error (details suppressed)",
          checkedAt: now(),
        };
      }
      if (evaluation.sloName !== sloName) {
        return {
          name: sloName,
          state: "down",
          detail: "SLO evaluation was produced for a different SLO name (treated as down)",
          checkedAt: now(),
        };
      }
      return {
        name: sloName,
        state: sloHealthState(evaluation.state),
        detail: describeSloEvaluation(evaluation),
        checkedAt: now(),
      };
    },
  };
}

/** The metric names registered for SLO export (closed set). */
export const SLO_METRIC_NAMES = Object.freeze({
  eventsTotal: "roamlink_slo_events_total",
  burnRate: "roamlink_slo_burn_rate",
  budgetRemaining: "roamlink_slo_budget_remaining",
});

/**
 * Registers the SLO metrics on an existing {@link MetricRegistry}:
 * `roamlink_slo_events_total` (counter, labels slo/outcome),
 * `roamlink_slo_burn_rate` (gauge, label slo) and
 * `roamlink_slo_budget_remaining` (gauge, label slo). Idempotent per
 * registry (re-registration conflicts are swallowed for the exact same
 * definitions - a changed definition fails loudly instead).
 */
export function registerSloMetrics(registry: MetricRegistry): void {
  const definitions = [
    {
      name: SLO_METRIC_NAMES.eventsTotal,
      kind: "counter",
      help: "SLO good/bad outcome events counted at evaluation time.",
      labelNames: ["slo", "outcome"],
    },
    {
      name: SLO_METRIC_NAMES.burnRate,
      kind: "gauge",
      help: "Error-budget burn rate (fraction of budget consumed) per SLO.",
      labelNames: ["slo"],
    },
    {
      name: SLO_METRIC_NAMES.budgetRemaining,
      kind: "gauge",
      help: "Fraction of the error budget remaining per SLO (negative = overspent).",
      labelNames: ["slo"],
    },
  ] as const;
  for (const definition of definitions) {
    if (registry.has(definition.name)) continue;
    registry.register(definition);
  }
}

/**
 * Emits one evaluation's counters and gauges through an existing recorder
 * (call {@link registerSloMetrics} on its registry first). Counters carry
 * the window's totals so downstream aggregation stays meaningful; the
 * no-data case emits nothing but the gauges with the recorder's kind rules
 * (burn rate gauges are only set when a burn rate exists).
 */
export function emitSloEvaluationMetrics(
  recorder: MetricsRecorder,
  evaluation: SloEvaluation,
): void {
  if (evaluation.total > 0) {
    recorder.incrementCounter(SLO_METRIC_NAMES.eventsTotal, { slo: evaluation.sloName, outcome: "good" }, evaluation.good);
    recorder.incrementCounter(SLO_METRIC_NAMES.eventsTotal, { slo: evaluation.sloName, outcome: "bad" }, evaluation.bad);
  }
  if (evaluation.burnRate !== null) {
    recorder.setGauge(SLO_METRIC_NAMES.burnRate, evaluation.burnRate, { slo: evaluation.sloName });
  }
  if (evaluation.budgetRemainingRatio !== null) {
    recorder.setGauge(
      SLO_METRIC_NAMES.budgetRemaining,
      evaluation.budgetRemainingRatio,
      { slo: evaluation.sloName },
    );
  }
}

/**
 * Correlation-aware, redaction-safe log fields for an evaluation. Values are
 * the SLO's own counters/ratios (numbers) and closed-vocabulary labels -
 * never payloads, never secrets (RL-LOCK-016). Attach to any correlated
 * logger record; the correlation id itself comes from the logger's carrier.
 */
export function sloLogFields(evaluation: SloEvaluation): Readonly<Record<string, LogFieldValue>> {
  return Object.freeze({
    slo: evaluation.sloName,
    slo_state: evaluation.state,
    slo_total: evaluation.total,
    slo_good: evaluation.good,
    slo_bad: evaluation.bad,
    slo_burn_rate: evaluation.burnRate,
    slo_budget_remaining: evaluation.budgetRemainingRatio,
  });
}

/**
 * Emits an evaluation through a correlated logger at the level its state
 * warrants: healthy -> info, at-risk -> warn, exhausted/no-data -> error.
 */
export function logSloEvaluation(logger: LeveledLogger, evaluation: SloEvaluation): void {
  const fields = sloLogFields(evaluation);
  const summary = describeSloEvaluation(evaluation);
  switch (evaluation.state) {
    case "within-budget":
      logger.info(`slo ${evaluation.sloName}: ${summary}`, fields);
      return;
    case "at-risk":
      logger.warn(`slo ${evaluation.sloName}: ${summary}`, fields);
      return;
    case "exhausted":
    case "no-data":
      logger.error(`slo ${evaluation.sloName}: ${summary}`, fields);
      return;
  }
}
