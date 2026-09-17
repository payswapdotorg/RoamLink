/**
 * The §11 product-SLO instrumentation surface (RL-052, spec/architecture.md
 * §11 — "The product must measure, at minimum:").
 *
 * For EVERY SLO phrase of the frozen spec section this module exports:
 *
 *  - a named metric-name constant (SCREAMING_SNAKE_CASE, embedding the §11
 *    slug) registered by {@link registerProductSloMetrics} through the
 *    RL-040 metrics contract (`roamlink_slo_<slug>[_...]`, closed label
 *    sets, no secret-suggestive labels — RL-LOCK-016);
 *  - a typed recorder method on {@link createProductSloRecorder} that emits
 *    the measurement through the RL-040/RL-052 ports (metrics recorder +
 *    SLO event recorder) at EXPLICIT instants (deterministic under the
 *    testkit clock);
 *  - an SLO objective name + {@link makeProductSloObjective} factory so the
 *    good/bad event stream composes with the existing burn-rate/health
 *    machinery (SloEventRecorder + slo-health).
 *
 * Design rules (inherited from the package scope guard):
 *
 *  - NO domain authority: this module records numbers and outcomes it is
 *    HANDED; it never computes satisfaction, recovery or usability — the
 *    product packages and composed harnesses own those semantics and call
 *    the recorders from their real measurement points;
 *  - NO invented targets: good/bad classification thresholds are OPTIONAL
 *    ({@link ProductSloBudgetThresholds}); a quantity without a configured
 *    threshold is still MEASURED (metric sample) but not budgeted — never
 *    silently classified;
 *  - every recorded instant is explicit (defaults to the injected clock),
 *    every label value is bounded and secret-free.
 */
import { ValidationError, parseUtcInstant, type UtcInstant } from "@roamlink/contracts";

import type { MetricRegistry, MetricsRecorder } from "../metrics/metrics.js";
import {
  makeServiceLevelObjective,
  type ServiceLevelObjective,
  type SloEventRecorder,
} from "./slo.js";

// ---------------------------------------------------------------------------
// The closed §11 SLO vocabulary
// ---------------------------------------------------------------------------

/**
 * The §11 SLO ids (kebab-case slugs of the frozen spec phrases — the same
 * derivation the release gate uses). Closed: adding one requires a spec
 * change, not a code change.
 */
export const PRODUCT_SLO_IDS = [
  "time-to-usable-connectivity",
  "minutes-without-usable-connectivity",
  "manual-interventions-per-session-day",
  "successful-automatic-recovery-rate",
  "intent-satisfaction-rate",
  "connectivity-cost-per-useful-hour-gb-where-available",
  "stale-unknown-state-duration",
  "provider-access-failover-success",
  "support-incidents-attributable-to-connectivity-orchestration",
] as const;

export type ProductSloId = (typeof PRODUCT_SLO_IDS)[number];

export function isProductSloId(value: unknown): value is ProductSloId {
  return (
    typeof value === "string" && (PRODUCT_SLO_IDS as readonly string[]).includes(value)
  );
}

export function parseProductSloId(value: unknown): ProductSloId {
  if (!isProductSloId(value)) {
    throw new ValidationError(
      "value is not one of the nine §11 product SLO ids (spec/architecture.md §11)",
      {
        reason: "PRODUCT_SLO_INVALID",
        details: [
          { path: "ProductSloId", issue: `outside the closed §11 vocabulary: ${PRODUCT_SLO_IDS.join(", ")}` },
        ],
      },
    );
  }
  return value;
}

/**
 * The SLO objective names (health-check label convention, <= 64 chars —
 * `slo.<slug>`, the long-tail slug of the last entry shortened to its first
 * three significant tokens to fit the label bound; the FULL slug remains in
 * the metric name and the SLO id).
 */
export const PRODUCT_SLO_OBJECTIVE_NAMES = Object.freeze({
  timeToUsableConnectivity: "slo.time-to-usable-connectivity",
  minutesWithoutUsableConnectivity: "slo.minutes-without-usable-connectivity",
  manualInterventionsPerSessionDay: "slo.manual-interventions-per-session-day",
  successfulAutomaticRecoveryRate: "slo.successful-automatic-recovery-rate",
  intentSatisfactionRate: "slo.intent-satisfaction-rate",
  connectivityCostPerUsefulHourGb: "slo.connectivity-cost-per-useful-hour-gb",
  staleUnknownStateDuration: "slo.stale-unknown-state-duration",
  providerAccessFailoverSuccess: "slo.provider-access-failover-success",
  supportIncidentsAttributableToConnectivityOrchestration: "slo.support-incidents-attributable",
} as const);

export type ProductSloObjectiveName =
  (typeof PRODUCT_SLO_OBJECTIVE_NAMES)[keyof typeof PRODUCT_SLO_OBJECTIVE_NAMES];

/** Options for {@link makeProductSloObjective}. */
export interface ProductSloObjectiveOptions {
  /** Required fraction of GOOD events, in (0, 1]. */
  readonly targetRatio: number;
  /** Evaluation window in milliseconds (>= 1). */
  readonly windowMs: number;
  /** Burn rate at/beyond which the SLO is `at-risk`; (0, 1], default 0.5. */
  readonly atRiskBurnRate?: number;
  /** Optional bounded human-readable description. */
  readonly help?: string;
}

/**
 * Builds the typed {@link ServiceLevelObjective} for one §11 SLO id, pinned
 * to the objective name of the closed map above (so evaluations compose with
 * the recorder's event stream by construction).
 */
export function makeProductSloObjective(
  id: ProductSloId,
  options: ProductSloObjectiveOptions,
): ServiceLevelObjective {
  return makeServiceLevelObjective({
    name: objectiveNameOf(id),
    targetRatio: options.targetRatio,
    windowMs: options.windowMs,
    ...(options.atRiskBurnRate !== undefined
      ? { atRiskBurnRate: options.atRiskBurnRate }
      : {}),
    ...(options.help !== undefined ? { help: options.help } : {}),
  });
}

/** The closed objective-name map lookup (fails closed on foreign ids). */
export function objectiveNameOf(id: ProductSloId): ProductSloObjectiveName {
  switch (parseProductSloId(id)) {
    case "time-to-usable-connectivity":
      return PRODUCT_SLO_OBJECTIVE_NAMES.timeToUsableConnectivity;
    case "minutes-without-usable-connectivity":
      return PRODUCT_SLO_OBJECTIVE_NAMES.minutesWithoutUsableConnectivity;
    case "manual-interventions-per-session-day":
      return PRODUCT_SLO_OBJECTIVE_NAMES.manualInterventionsPerSessionDay;
    case "successful-automatic-recovery-rate":
      return PRODUCT_SLO_OBJECTIVE_NAMES.successfulAutomaticRecoveryRate;
    case "intent-satisfaction-rate":
      return PRODUCT_SLO_OBJECTIVE_NAMES.intentSatisfactionRate;
    case "connectivity-cost-per-useful-hour-gb-where-available":
      return PRODUCT_SLO_OBJECTIVE_NAMES.connectivityCostPerUsefulHourGb;
    case "stale-unknown-state-duration":
      return PRODUCT_SLO_OBJECTIVE_NAMES.staleUnknownStateDuration;
    case "provider-access-failover-success":
      return PRODUCT_SLO_OBJECTIVE_NAMES.providerAccessFailoverSuccess;
    case "support-incidents-attributable-to-connectivity-orchestration":
      return PRODUCT_SLO_OBJECTIVE_NAMES.supportIncidentsAttributableToConnectivityOrchestration;
  }
}

// ---------------------------------------------------------------------------
// Metric names — one named constant per §11 SLO (the release gate's §11
// matcher scans for exactly these slug-embedding identifiers)
// ---------------------------------------------------------------------------

/** Histogram: ms from the paid order/session start to FIRST usable connectivity. */
export const TIME_TO_USABLE_CONNECTIVITY_MS_METRIC = "roamlink_slo_time_to_usable_connectivity_ms";

/** Histogram: minutes a customer spent WITHOUT usable connectivity per outage window. */
export const MINUTES_WITHOUT_USABLE_CONNECTIVITY_METRIC =
  "roamlink_slo_minutes_without_usable_connectivity";

/** Counter: manual interventions (customer/support/operator actions) per session/day. */
export const MANUAL_INTERVENTIONS_PER_SESSION_DAY_METRIC =
  "roamlink_slo_manual_interventions_per_session_day";

/** Counter: automatic-recovery attempt outcomes (good/bad) — the rate numerator/denominator. */
export const SUCCESSFUL_AUTOMATIC_RECOVERY_RATE_METRIC =
  "roamlink_slo_successful_automatic_recovery_rate_events";

/** Counter: intent-satisfaction outcomes (good/bad) per evaluated decision. */
export const INTENT_SATISFACTION_RATE_METRIC = "roamlink_slo_intent_satisfaction_rate_events";

/** Histogram: connectivity cost (integer minor units) per useful hour / per GB, where available. */
export const CONNECTIVITY_COST_PER_USEFUL_HOUR_GB_METRIC =
  "roamlink_slo_connectivity_cost_per_useful_hour_gb";

/** Histogram: ms a projection/reference/device state spent stale or unknown. */
export const STALE_UNKNOWN_STATE_DURATION_MS_METRIC =
  "roamlink_slo_stale_unknown_state_duration_ms";

/** Counter: provider/access failover attempt outcomes (good/bad). */
export const PROVIDER_ACCESS_FAILOVER_SUCCESS_METRIC =
  "roamlink_slo_provider_access_failover_success_events";

/** Counter: support incidents attributable to connectivity orchestration. */
export const SUPPORT_INCIDENTS_ATTRIBUTABLE_TO_CONNECTIVITY_ORCHESTRATION_METRIC =
  "roamlink_slo_support_incidents_attributable_to_connectivity_orchestration_total";

/** The closed freshness-state label vocabulary for the stale/unknown duration SLO. */
export const STALE_UNKNOWN_STATE_LABELS = ["stale", "unknown"] as const;

export type StaleUnknownStateLabel = (typeof STALE_UNKNOWN_STATE_LABELS)[number];

/** The closed usage-unit label vocabulary for the cost-per-useful-unit SLO. */
export const CONNECTIVITY_COST_UNIT_LABELS = ["per_useful_hour", "per_useful_gb"] as const;

export type ConnectivityCostUnitLabel = (typeof CONNECTIVITY_COST_UNIT_LABELS)[number];

/** The closed definitions registered by {@link registerProductSloMetrics}. */
export const PRODUCT_SLO_METRICS = Object.freeze([
  {
    name: TIME_TO_USABLE_CONNECTIVITY_MS_METRIC,
    kind: "histogram",
    help: "§11 SLO: time to usable connectivity (ms from paid order/session start to first usable connectivity).",
    labelNames: ["tenant_id"],
  },
  {
    name: MINUTES_WITHOUT_USABLE_CONNECTIVITY_METRIC,
    kind: "histogram",
    help: "§11 SLO: minutes without usable connectivity per outage window.",
    labelNames: ["tenant_id"],
  },
  {
    name: MANUAL_INTERVENTIONS_PER_SESSION_DAY_METRIC,
    kind: "counter",
    help: "§11 SLO: manual interventions per session/day (customer/support/operator actions required to keep connectivity usable).",
    labelNames: ["tenant_id"],
  },
  {
    name: SUCCESSFUL_AUTOMATIC_RECOVERY_RATE_METRIC,
    kind: "counter",
    help: "§11 SLO: successful automatic recovery rate events (one sample per automatic recovery attempt outcome).",
    labelNames: ["tenant_id", "outcome"],
  },
  {
    name: INTENT_SATISFACTION_RATE_METRIC,
    kind: "counter",
    help: "§11 SLO: intent satisfaction rate events (one sample per evaluated experience decision).",
    labelNames: ["tenant_id", "outcome"],
  },
  {
    name: CONNECTIVITY_COST_PER_USEFUL_HOUR_GB_METRIC,
    kind: "histogram",
    help: "§11 SLO: connectivity cost (integer minor units) per useful hour / per GB, where available.",
    labelNames: ["tenant_id", "unit"],
  },
  {
    name: STALE_UNKNOWN_STATE_DURATION_MS_METRIC,
    kind: "histogram",
    help: "§11 SLO: stale/unknown-state duration (ms a connectivity truth state spent stale or unknown).",
    labelNames: ["tenant_id", "freshness_state"],
  },
  {
    name: PROVIDER_ACCESS_FAILOVER_SUCCESS_METRIC,
    kind: "counter",
    help: "§11 SLO: provider/access failover success events (one sample per failover attempt outcome).",
    labelNames: ["tenant_id", "outcome"],
  },
  {
    name: SUPPORT_INCIDENTS_ATTRIBUTABLE_TO_CONNECTIVITY_ORCHESTRATION_METRIC,
    kind: "counter",
    help: "§11 SLO: support incidents attributable to connectivity orchestration.",
    labelNames: ["tenant_id"],
  },
] as const);

/**
 * Registers every §11 product-SLO metric on an existing {@link MetricRegistry}.
 * Idempotent per registry (re-registration of the exact same definitions is
 * skipped; a CHANGED definition fails loudly through the registry's
 * duplicate/conflict rules instead of being silently ignored).
 */
export function registerProductSloMetrics(registry: MetricRegistry): void {
  for (const definition of PRODUCT_SLO_METRICS) {
    if (registry.has(definition.name)) continue;
    registry.register(definition);
  }
}

// ---------------------------------------------------------------------------
// The typed recorder
// ---------------------------------------------------------------------------

/** Optional good/bad classification thresholds (NO defaults: never invented). */
export interface ProductSloBudgetThresholds {
  /** Max ms from paid order/session start to first usable connectivity that still counts as good. */
  readonly timeToUsableConnectivityMs?: number;
  /** Max minutes without usable connectivity per outage window that still counts as good. */
  readonly minutesWithoutUsableConnectivity?: number;
  /** Max manual interventions per session/day that still counts as good. */
  readonly manualInterventionsPerSessionDay?: number;
  /** Max integer minor units per useful hour that still counts as good. */
  readonly connectivityCostPerUsefulHourMinorUnits?: number;
  /** Max ms a connectivity truth state may spend stale/unknown that still counts as good. */
  readonly staleUnknownStateDurationMs?: number;
  /** Max support incidents attributable to connectivity orchestration per day that still counts as good. */
  readonly supportIncidentsPerDay?: number;
}

function parseThresholds(
  thresholds: ProductSloBudgetThresholds | undefined,
): ProductSloBudgetThresholds {
  if (thresholds === undefined) return {};
  if (thresholds === null || typeof thresholds !== "object") {
    throw new ValidationError("ProductSloBudgetThresholds must be an object", {
      reason: "PRODUCT_SLO_THRESHOLDS_INVALID",
      details: [{ path: "ProductSloBudgetThresholds", issue: "not an object" }],
    });
  }
  for (const [key, value] of Object.entries(thresholds)) {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value <= 0
    ) {
      throw new ValidationError(
        `SLO budget threshold '${key}' must be a finite number > 0 (targets are never invented defaults)`,
        {
          reason: "PRODUCT_SLO_THRESHOLDS_INVALID",
          details: [{ path: key, issue: "out of bounds" }],
        },
      );
    }
  }
  return thresholds;
}

/** Ports the recorder emits through (RL-040 metrics + RL-052 SLO events). */
export interface ProductSloRecorderDeps {
  readonly metrics: MetricsRecorder;
  readonly events: SloEventRecorder;
  /** The clock every unspecified recording instant defaults to. */
  readonly now: () => UtcInstant;
}

/** The shared measurement input (tenant-scoped, explicit instant). */
export interface ProductSloMeasurementInput {
  /** The opaque tenant id the measurement is scoped to (label value). */
  readonly tenantId: string;
  /** Explicit recording instant (defaults to the recorder's clock). */
  readonly at?: UtcInstant | string;
}

/** The §11 SLO recorder surface: nine typed measurement methods. */
export interface ProductSloRecorder {
  /** §11 "time to usable connectivity": ms from paid order/session start to first usable connectivity. */
  recordTimeToUsableConnectivity(
    input: ProductSloMeasurementInput & { readonly durationMs: number },
  ): void;
  /** §11 "minutes without usable connectivity": one outage window's duration in minutes. */
  recordMinutesWithoutUsableConnectivity(
    input: ProductSloMeasurementInput & { readonly minutes: number },
  ): void;
  /** §11 "manual interventions per session/day": counts manual actions (default 1). */
  recordManualIntervention(
    input: ProductSloMeasurementInput & { readonly count?: number },
  ): void;
  /** §11 "successful automatic recovery rate": one automatic recovery attempt outcome. */
  recordSuccessfulAutomaticRecovery(
    input: ProductSloMeasurementInput & { readonly succeeded: boolean },
  ): void;
  /** §11 "intent satisfaction rate": one evaluated experience-decision outcome. */
  recordIntentSatisfaction(
    input: ProductSloMeasurementInput & { readonly satisfied: boolean },
  ): void;
  /** §11 "connectivity cost per useful hour/GB where available": records only the units actually available. */
  recordConnectivityCostPerUsefulUnit(
    input: ProductSloMeasurementInput & {
      readonly minorUnitsPerUsefulHour?: number;
      readonly minorUnitsPerUsefulGb?: number;
    },
  ): void;
  /** §11 "stale/unknown-state duration": ms one connectivity truth state spent stale or unknown. */
  recordStaleUnknownStateDuration(
    input: ProductSloMeasurementInput & {
      readonly durationMs: number;
      readonly freshnessState: StaleUnknownStateLabel;
    },
  ): void;
  /** §11 "provider/access failover success": one failover attempt outcome. */
  recordProviderAccessFailover(
    input: ProductSloMeasurementInput & { readonly succeeded: boolean },
  ): void;
  /** §11 "support incidents attributable to connectivity orchestration": counts incidents (default 1). */
  recordSupportIncidentAttributable(
    input: ProductSloMeasurementInput & { readonly count?: number },
  ): void;
  /** The underlying event recorder (evaluation/health composition). */
  readonly events: SloEventRecorder;
  /** The recorder's clock (the default instant of every measurement). */
  readonly now: () => UtcInstant;
}

function parseDurationMs(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${field} must be a finite number >= 0`, {
      reason: "PRODUCT_SLO_MEASUREMENT_INVALID",
      details: [{ path: field, issue: "out of bounds" }],
    });
  }
  return value;
}

function parseCount(value: number | undefined, field: string): number {
  const count = value ?? 1;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    throw new ValidationError(`${field} must be an integer >= 1 (counters only increase)`, {
      reason: "PRODUCT_SLO_MEASUREMENT_INVALID",
      details: [{ path: field, issue: "out of bounds" }],
    });
  }
  return count;
}

function parseOutcome(value: boolean, field: string): "good" | "bad" {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${field} must be a boolean outcome`, {
      reason: "PRODUCT_SLO_MEASUREMENT_INVALID",
      details: [{ path: field, issue: "not a boolean" }],
    });
  }
  return value ? "good" : "bad";
}

function parseTenantLabel(tenantId: string): string {
  if (typeof tenantId !== "string" || tenantId.length === 0 || tenantId.length > 128) {
    throw new ValidationError(
      "tenantId must be a non-empty string of at most 128 chars (opaque tenant label)",
      {
        reason: "PRODUCT_SLO_MEASUREMENT_INVALID",
        details: [{ path: "tenantId", issue: "out of bounds" }],
      },
    );
  }
  return tenantId;
}

function parseStaleUnknownStateLabel(value: StaleUnknownStateLabel): StaleUnknownStateLabel {
  if (
    typeof value !== "string" ||
    !(STALE_UNKNOWN_STATE_LABELS as readonly string[]).includes(value)
  ) {
    throw new ValidationError(
      "freshnessState must be 'stale' or 'unknown' (closed §11 label vocabulary)",
      {
        reason: "PRODUCT_SLO_MEASUREMENT_INVALID",
        details: [{ path: "freshnessState", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/**
 * Creates the §11 SLO recorder. Every method records the metric sample
 * through the RL-040 metrics port AND — for the three rate SLOs and for any
 * duration/count SLO with a CONFIGURED threshold — the good/bad event into
 * the RL-052 {@link SloEventRecorder} under the SLO's objective name, so
 * windows/burn-rates/health compose through the existing machinery.
 *
 * The recorder never throws on recording instants (parseUtcInstant covers
 * string|instant) and never blocks: it is pure emission over the injected
 * ports.
 */
export function createProductSloRecorder(
  deps: ProductSloRecorderDeps,
  thresholds?: ProductSloBudgetThresholds,
): ProductSloRecorder {
  if (deps === null || typeof deps !== "object") {
    throw new ValidationError("ProductSloRecorderDeps must be an object", {
      reason: "PRODUCT_SLO_RECORDER_INVALID",
      details: [{ path: "ProductSloRecorderDeps", issue: "not an object" }],
    });
  }
  if (typeof deps.metrics !== "object" || deps.metrics === null) {
    throw new ValidationError("deps.metrics must be a MetricsRecorder", {
      reason: "PRODUCT_SLO_RECORDER_INVALID",
      details: [{ path: "metrics", issue: "not a MetricsRecorder port" }],
    });
  }
  if (typeof deps.events !== "object" || deps.events === null) {
    throw new ValidationError("deps.events must be a SloEventRecorder", {
      reason: "PRODUCT_SLO_RECORDER_INVALID",
      details: [{ path: "events", issue: "not a SloEventRecorder" }],
    });
  }
  if (typeof deps.now !== "function") {
    throw new ValidationError("deps.now must be a clock function () => UtcInstant", {
      reason: "PRODUCT_SLO_RECORDER_INVALID",
      details: [{ path: "now", issue: "not a clock function" }],
    });
  }
  const budget = parseThresholds(thresholds);
  const events = deps.events;
  const metrics = deps.metrics;
  const now = deps.now;

  const instantOf = (input: ProductSloMeasurementInput): UtcInstant =>
    input.at === undefined ? now() : parseUtcInstant(input.at);

  const recordEvent = (
    objective: ProductSloObjectiveName,
    outcome: "good" | "bad",
    input: ProductSloMeasurementInput,
  ): void => {
    events.record(objective, outcome, instantOf(input));
  };

  return {
    events,
    now,

    recordTimeToUsableConnectivity(input) {
      const durationMs = parseDurationMs(input.durationMs, "durationMs");
      const tenantId = parseTenantLabel(input.tenantId);
      metrics.observeHistogram(TIME_TO_USABLE_CONNECTIVITY_MS_METRIC, durationMs, {
        tenant_id: tenantId,
      });
      if (budget.timeToUsableConnectivityMs !== undefined) {
        recordEvent(
          PRODUCT_SLO_OBJECTIVE_NAMES.timeToUsableConnectivity,
          durationMs <= budget.timeToUsableConnectivityMs ? "good" : "bad",
          input,
        );
      }
    },

    recordMinutesWithoutUsableConnectivity(input) {
      const minutes = parseDurationMs(input.minutes, "minutes");
      const tenantId = parseTenantLabel(input.tenantId);
      metrics.observeHistogram(MINUTES_WITHOUT_USABLE_CONNECTIVITY_METRIC, minutes, {
        tenant_id: tenantId,
      });
      if (budget.minutesWithoutUsableConnectivity !== undefined) {
        recordEvent(
          PRODUCT_SLO_OBJECTIVE_NAMES.minutesWithoutUsableConnectivity,
          minutes <= budget.minutesWithoutUsableConnectivity ? "good" : "bad",
          input,
        );
      }
    },

    recordManualIntervention(input) {
      const count = parseCount(input.count, "count");
      const tenantId = parseTenantLabel(input.tenantId);
      metrics.incrementCounter(MANUAL_INTERVENTIONS_PER_SESSION_DAY_METRIC, {
        tenant_id: tenantId,
      }, count);
      if (budget.manualInterventionsPerSessionDay !== undefined) {
        recordEvent(
          PRODUCT_SLO_OBJECTIVE_NAMES.manualInterventionsPerSessionDay,
          count <= budget.manualInterventionsPerSessionDay ? "good" : "bad",
          input,
        );
      }
    },

    recordSuccessfulAutomaticRecovery(input) {
      const outcome = parseOutcome(input.succeeded, "succeeded");
      const tenantId = parseTenantLabel(input.tenantId);
      metrics.incrementCounter(SUCCESSFUL_AUTOMATIC_RECOVERY_RATE_METRIC, {
        tenant_id: tenantId,
        outcome,
      });
      recordEvent(PRODUCT_SLO_OBJECTIVE_NAMES.successfulAutomaticRecoveryRate, outcome, input);
    },

    recordIntentSatisfaction(input) {
      const outcome = parseOutcome(input.satisfied, "satisfied");
      const tenantId = parseTenantLabel(input.tenantId);
      metrics.incrementCounter(INTENT_SATISFACTION_RATE_METRIC, {
        tenant_id: tenantId,
        outcome,
      });
      recordEvent(PRODUCT_SLO_OBJECTIVE_NAMES.intentSatisfactionRate, outcome, input);
    },

    recordConnectivityCostPerUsefulUnit(input) {
      const tenantId = parseTenantLabel(input.tenantId);
      if (input.minorUnitsPerUsefulHour !== undefined) {
        const perHour = parseDurationMs(input.minorUnitsPerUsefulHour, "minorUnitsPerUsefulHour");
        metrics.observeHistogram(CONNECTIVITY_COST_PER_USEFUL_HOUR_GB_METRIC, perHour, {
          tenant_id: tenantId,
          unit: "per_useful_hour",
        });
        if (budget.connectivityCostPerUsefulHourMinorUnits !== undefined) {
          recordEvent(
            PRODUCT_SLO_OBJECTIVE_NAMES.connectivityCostPerUsefulHourGb,
            perHour <= budget.connectivityCostPerUsefulHourMinorUnits ? "good" : "bad",
            input,
          );
        }
      }
      if (input.minorUnitsPerUsefulGb !== undefined) {
        const perGb = parseDurationMs(input.minorUnitsPerUsefulGb, "minorUnitsPerUsefulGb");
        metrics.observeHistogram(CONNECTIVITY_COST_PER_USEFUL_HOUR_GB_METRIC, perGb, {
          tenant_id: tenantId,
          unit: "per_useful_gb",
        });
      }
    },

    recordStaleUnknownStateDuration(input) {
      const durationMs = parseDurationMs(input.durationMs, "durationMs");
      const freshnessState = parseStaleUnknownStateLabel(input.freshnessState);
      const tenantId = parseTenantLabel(input.tenantId);
      metrics.observeHistogram(STALE_UNKNOWN_STATE_DURATION_MS_METRIC, durationMs, {
        tenant_id: tenantId,
        freshness_state: freshnessState,
      });
      if (budget.staleUnknownStateDurationMs !== undefined) {
        recordEvent(
          PRODUCT_SLO_OBJECTIVE_NAMES.staleUnknownStateDuration,
          durationMs <= budget.staleUnknownStateDurationMs ? "good" : "bad",
          input,
        );
      }
    },

    recordProviderAccessFailover(input) {
      const outcome = parseOutcome(input.succeeded, "succeeded");
      const tenantId = parseTenantLabel(input.tenantId);
      metrics.incrementCounter(PROVIDER_ACCESS_FAILOVER_SUCCESS_METRIC, {
        tenant_id: tenantId,
        outcome,
      });
      recordEvent(PRODUCT_SLO_OBJECTIVE_NAMES.providerAccessFailoverSuccess, outcome, input);
    },

    recordSupportIncidentAttributable(input) {
      const count = parseCount(input.count, "count");
      const tenantId = parseTenantLabel(input.tenantId);
      metrics.incrementCounter(
        SUPPORT_INCIDENTS_ATTRIBUTABLE_TO_CONNECTIVITY_ORCHESTRATION_METRIC,
        { tenant_id: tenantId },
        count,
      );
      if (budget.supportIncidentsPerDay !== undefined) {
        recordEvent(
          PRODUCT_SLO_OBJECTIVE_NAMES.supportIncidentsAttributableToConnectivityOrchestration,
          count <= budget.supportIncidentsPerDay ? "good" : "bad",
          input,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Evaluation convenience (composes with the existing burn-rate machinery)
// ---------------------------------------------------------------------------

/** Options for {@link evaluateProductSlo}. */
export interface EvaluateProductSloOptions extends ProductSloObjectiveOptions {
  /** Evaluation instant (defaults to the recorder's clock). */
  readonly asOf?: UtcInstant | string;
}

/** Evaluates one §11 SLO's event stream over its window (pure convenience). */
export function evaluateProductSlo(
  recorder: ProductSloRecorder,
  id: ProductSloId,
  options: EvaluateProductSloOptions,
): ReturnType<SloEventRecorder["evaluate"]> {
  const objective = makeProductSloObjective(id, options);
  const asOf = options.asOf === undefined ? recorder.now() : parseUtcInstant(options.asOf);
  return recorder.events.evaluate(objective, asOf);
}
