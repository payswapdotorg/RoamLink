/**
 * @roamlink/observability - platform observability contracts (RL-040
 * scaffolding + RL-052 SLO/error-budget extension; both depend only on
 * Wave-0 @roamlink/contracts).
 *
 * Correlation-ID context propagation (Wave-0 command envelope ->
 * async chains), the redacting structured log record contract, the
 * counter/gauge/histogram metrics naming + label contract (no vendor SDK),
 * the health/readiness aggregation contract, and the service-level
 * objective / error-budget primitives (typed SLOs, good/bad event
 * recording, burn-rate calculation, health/metrics/log composition). No
 * domain logic, no business authority, no secret leakage (RL-LOCK-016).
 */
export * from "./correlation/correlation-context.js";
export * from "./logging/log-record.js";
export * from "./logging/logger.js";
export * from "./metrics/metrics.js";
export * from "./health/health.js";
export * from "./slo/slo.js";
export * from "./slo/slo-health.js";
