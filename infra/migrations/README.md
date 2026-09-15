# infra/migrations

SQL migration files for the PostgreSQL-compatible runtime baseline
(spec/repository-layout.md). **No migration exists yet** - the first one lands
with the first service schema (Wave 1+ domain work: RL-004/RL-010/RL-020+).
This folder is scaffolded now so the layout is pinned before the first
migration is written.

## File layout

Every migration is a pair of plain SQL files named by its version:

```text
infra/migrations/
  0001-create-tenant-users.up.sql
  0001-create-tenant-users.down.sql
  0002-add-experience-intents.up.sql
  0002-add-experience-intents.down.sql
  ...
```

Rules:

- `NNNN` is a zero-padded 4-digit version (`0001`..`9999`), exactly matching
  `MigrationVersion` in `@roamlink/persistence` (lexicographic file order ==
  application order, deterministically);
- one version per migration; `.up.sql` applies it, `.down.sql` reverts it;
- `up` migrations must be idempotent-safe under the runner's applied-versions
  ledger (the runner never applies the same version twice, but re-runs after
  partial rollbacks must stay deterministic);
- `down` must revert `up` completely - rollback semantics are part of the
  definition of done (spec/definition-of-done.md "Migration/rollback behavior
  documented when state changes");
- migrations are driver-agnostic SQL, no vendor-specific procedural
  extensions where a portable form exists.

## Runner contract

The versioned migration runner CONTRACT and the applied-versions ledger PORT
live in `@roamlink/persistence` (`packages/persistence/src/migrations.ts`):

- `MigrationRunner.migrateUp(target?)` - applies pending migrations in
  ascending version order (idempotent re-runs);
- `MigrationRunner.migrateDown(target?)` - rolls back in descending order,
  keeping the target applied;
- `AppliedVersionsLedger` - records `(version, applied_at)`; a driver-backed
  implementation persists this (e.g. a `schema_migrations` table with
  `version` primary key and `applied_at` UTC-instant column).

This work item ships the interface plus a driver-free in-memory fake ONLY -
no vendor driver is coupled yet. The service that first needs a real
database (Wave 2+) implements the same interfaces with a PostgreSQL-compatible
driver reading the files above.

## Conventions

- Every persisted timestamp is a UTC instant with explicit serialization
  (spec/data-model.md "Time and freshness").
- Secrets and credentials are never stored in ordinary domain tables
  (spec/security.md); they live in the runtime secret mechanism.
- Multi-tenant tables carry the tenant boundary explicitly.
- State machines (outbox delivery, inbox admission, domain lifecycles) are
  never collapsed into shared enums.
