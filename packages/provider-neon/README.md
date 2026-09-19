# @roamlink/provider-neon

The **Neon PostgreSQL configuration/health adapter surface** (RL-095) — the
config half of the durable-source-of-truth provider path described in
`spec/deployment.md`.

## Why this package exists

Per `spec/deployment.md` §2/§8 and ADR-0003, **Neon Postgres is the selected
early provider for the durable relational source of truth**. Providers are
adapters, not architecture: Neon is reached only through PostgreSQL ports
owned by `@roamlink/persistence` (real driver/migrations = RL-090). This
package owns everything RL-095 mandates around that driver path:

| Surface | Export | Discipline |
|---|---|---|
| Connection-string parsing | `parseNeonConnectionString` | TLS enforced (`require`/`verify-ca`/`verify-full` only); pooled (`-pooler`) vs direct endpoint classification; value-free fail-closed errors (RL-LOCK-016) |
| Pool guidance | `resolveNeonPoolOptions`, `NEON_POOL_DEFAULTS`, `NEON_POOL_BOUNDS` | Conservative, documented defaults (deployment.md §5) — operational guidance, NEVER correctness logic |
| Health check | `createNeonHealthCheck`, `PostgresProbePort` | Composes with `@roamlink/observability` `HealthRegistry` (§7 "health/readiness is real, not fake"); probe errors are suppressed, never echoed |
| Env access | `tryParseNeonEnv` | Reads the root-owned `DATABASE_URL` key only; no parallel env keys |
| Redaction | `redactNeonConnectionString` | Safe for logs/support tickets (RL-LOCK-016) |

## What deliberately does NOT live here

- SQL, migrations, UnitOfWork, transactions — `@roamlink/persistence` ports
  (the real PostgreSQL driver is RL-090).
- Any domain logic. This is a leaf platform adapter.

## DATABASE_URL discipline

1. The connection string arrives via `DATABASE_URL` (root env schema,
   RL-001) — never in code, never committed (`infra/deployment` templates
   carry empty placeholders only).
2. Parsing fails closed on: wrong scheme, missing host/user/password/
   database, missing or weak `sslmode`, password-as-query-parameter.
3. Errors name fields, never values; `redactNeonConnectionString` is the
   only sanctioned way to render one for diagnostics.

## Scale-to-zero / conservative compute

Deployment.md §5 guidance encoded here: pooled endpoints for serverless
request paths, direct endpoints for migrations/long workers, a low default
`maxConnections` (5). A provider quota change is a RUNBOOK concern —
`infra/deployment/runbooks/neon-provisioning.md` — never a behavioral
branch (handoff §12 stop-rule).

## Tests

Deterministic (testkit clock, no network, no real Neon account): parse
matrices, redaction, health composition against the real
`HealthRegistry`/`runHealthChecks`, env failures. Real-account verification
is the operator's RL-100+ phase per the provisioning runbook.
