/**
 * @roamlink/provider-neon - the Neon PostgreSQL configuration/health
 * adapter surface (RL-095).
 *
 * Layer: platform provider adapter (leaf). Per spec/deployment.md §8 every
 * provider sits behind a replaceable port; Neon is the SELECTED early
 * provider for the durable PostgreSQL source of truth - it is an adapter,
 * never an architecture authority.
 *
 * What lives here (RL-095 scope - deployment.md §6 discipline):
 *  - connection-string parsing/validation for the PostgreSQL driver path
 *    (TLS enforced, pooled/direct endpoint classification, value-free
 *    fail-closed errors - RL-LOCK-016);
 *  - conservative pool-configuration GUIDANCE defaults (deployment.md §5;
 *    quotas are documented, never correctness logic);
 *  - a connection health check helper composing with the
 *    @roamlink/observability HealthRegistry (§7 "health/readiness is real,
 *    not fake") - the actual probe is injected by the real driver path
 *    (RL-090 territory: real PostgreSQL driver + migrations + UnitOfWork);
 *  - connection-string redaction for logs/diagnostics.
 *
 * What deliberately does NOT live here: SQL, migrations, UnitOfWork, any
 * domain logic. The real PostgreSQL driver belongs to
 * packages/persistence's ports (RL-090); this package only makes the Neon
 * configuration surface safe and observable.
 *
 * Operator-facing provisioning: infra/deployment/runbooks/neon-provisioning.md
 * and infra/deployment/providers/neon.env.example.
 */
export * from "./config.js";
export * from "./env.js";
export * from "./health.js";
