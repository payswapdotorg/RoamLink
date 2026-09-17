# @roamlink/observability

Platform observability contracts (RL-040 scaffolding that depends only on the
Wave-0 `@roamlink/contracts` package). No vendor SDK, no domain logic, no
business authority.

## Surface

| Module | Provides |
|---|---|
| `correlation/correlation-context` | `CorrelationContext` + carriers: AsyncLocalStorage-backed (crosses `await`, concurrent scopes isolated) and manual save/restore; `correlationContextFromCommandEnvelope` propagates the Wave-0 envelope's correlationId/tenant/command/actor (RL-LOCK-014) |
| `logging/log-record` | closed log-level vocabulary, the structured log record contract, and the **redaction seam**: `secretLogValue()` wraps secret-bearing values in a `RedactedLogValue` that can only ever serialize as `[REDACTED]` (RL-LOCK-016) |
| `logging/logger` | `createCorrelatedLogger` (leveled, threshold-filtered, context-filling) + in-memory sink |
| `metrics/metrics` | counter/gauge/histogram **naming convention** (`roamlink_<component>_<name>`), label contract with forbidden secret-suggestive label names, `MetricRegistry` + fail-closed in-memory recorder |
| `health/health` | closed healthy/degraded/down vocabulary, `HealthRegistry` with dependency naming, `aggregateHealthStates` (any down -> down; else any degraded -> degraded; else healthy), `runHealthChecks` with suppressed-detail failure handling |
| `slo/slo` | typed frozen `ServiceLevelObjective` (safe-label name, target ratio, window, at-risk burn threshold), `SloEventRecorder` (good/bad events at explicit instants, pure window evaluation, honest `no-data`), error-budget **burn rate** + multi-window burn rates |
| `slo/slo-health` | SLO ↔ health/metrics/logging composition: `sloHealthCheck` (burning SLOs degrade, never silently healthy), `registerSloMetrics` + `emitSloEvaluationMetrics` (vendor-free export), `logSloEvaluation` (correlated, redaction-safe) |
| `slo/slo-metrics` | the **§11 SLO instrumentation surface**: the nine product SLOs of spec/architecture.md §11 as named metric definitions (`PRODUCT_SLO_IDS`, the `*_METRIC` constants, `registerProductSloMetrics`) + the typed `createProductSloRecorder` whose nine record* methods emit measurements through the metrics/SLO-event ports, `makeProductSloObjective`/`evaluateProductSlo` for budget evaluation, and OPTIONAL `ProductSloBudgetThresholds` (no invented defaults) |

## Key design decisions

- **Secrets are unrepresentable, not just filtered.** The only way to attach
  a secret-bearing value to a log record is `secretLogValue()`; the wrapper
  keeps the raw string in a true private field with no accessor, and
  `JSON.stringify` / `util.inspect` / `String()` all yield `[REDACTED]`.
  Non-primitive field values are rejected outright so nothing can smuggle a
  secret-bearing object graph.
- **Correlation identity flows from the command envelope.** The envelope is
  the canonical source (RL-LOCK-014); carriers propagate it, they never
  invent it.
- **Metrics names and labels are contracts.** Names follow
  `roamlink_<component>_<name>`; each metric pins its kind and its EXACT
  label set; unknown/missing labels, kind mismatches and secret-suggestive
  label names fail closed.
- **Health is honest.** A throwing or garbage-returning check is `down` with
  a suppressed detail (third-party error text may carry secrets); a result
  under a different name than its registration is treated as down; an empty
  registry is healthy (no declared dependency failed).
- **The §11 SLOs are named, typed measurements — never name-dropping.** The
  nine spec/architecture.md §11 SLOs are a closed id vocabulary
  (`PRODUCT_SLO_IDS`); each carries a named metric (`roamlink_slo_<slug>…`)
  with a closed, secret-free label set, and the recorder emits through the
  SAME metrics/SLO-event ports everything else uses. Good/bad budget
  classification thresholds are OPTIONAL and validated — a quantity
  without a configured threshold is MEASURED (metric sample) but never
  silently classified, and "where available" units (cost per useful
  hour/GB) are recorded only when the evidence exists. The recorder owns no
  domain semantics: satisfaction/recovery/usability outcomes are computed
  by the product packages and harnesses (the RL-013 `intentSatisfactionOf`
  mapping, the reconciliation engine's durable-action `sloObserver`, the
  composed dogfood/load worlds) and HANDED to the recorder at explicit
  instants.

## Scope guard

This package must not gain vendor SDKs, domain metrics/health semantics
owned by services, or any business authority. SLO instrumentation built on
these contracts is RL-052: the §11 surface defines the closed spec-derived
vocabulary and the typed emission ports, and the product packages keep the
measurement semantics (the observability package records numbers and
outcomes it is handed — it never computes satisfaction, recovery or
usability, and it never reads domain state).
