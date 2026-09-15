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

## Scope guard

This package must not gain vendor SDKs, domain metrics/health semantics
owned by services, or any business authority. SLO instrumentation built on
these contracts is RL-052.
