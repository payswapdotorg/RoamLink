/**
 * @roamlink/observability - platform observability contracts (RL-040
 * scaffolding that depends only on Wave-0 @roamlink/contracts).
 *
 * Correlation-ID context propagation (Wave-0 command envelope ->
 * async chains), the redacting structured log record contract, the
 * counter/gauge/histogram metrics naming + label contract (no vendor SDK)
 * and the health/readiness aggregation contract. No domain logic, no
 * business authority, no secret leakage (RL-LOCK-016).
 */
export * from "./correlation/correlation-context.js";
export * from "./logging/log-record.js";
export * from "./logging/logger.js";
export * from "./metrics/metrics.js";
export * from "./health/health.js";
