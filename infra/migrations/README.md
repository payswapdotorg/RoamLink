# infra/migrations

SQL migration files for the PostgreSQL-compatible runtime baseline
(spec/repository-layout.md "Hosted product additions"). The first real
migration set ships with RL-092 and is applied by the PostgreSQL migration
runner of `@roamlink/persistence-postgres` (RL-091); the runner CONTRACT and
the applied-versions ledger PORT live in `@roamlink/persistence`
(`packages/persistence/src/migrations.ts`).

## Current migration set

| Version | Name                 | What it creates                                                                 |
| ------- | -------------------- | ------------------------------------------------------------------------------- |
| 0001    | roamlink-schema-ledger | `roamlink_schema_migrations` — the applied-versions ledger (version, applied_at, script_digest). Its `down` drops the ledger table itself. |
| 0002    | versioned-records    | `roamlink_records` — the versioned record store (RL-091 data model), partitioned by repository name, CAS on `(repository, record_id, version)`. |
| 0003    | durable-outbox       | `roamlink_outbox` — the durable delivery outbox: closed `PENDING/DELIVERING/DELIVERED/FAILED` state machine, claim index for `FOR UPDATE SKIP LOCKED` workers. |
| 0004    | durable-inbox        | `roamlink_inbox` — the append-only webhook admission log: IDENTITY sequence, partial unique index enforcing exactly one ADMITTED row per dedupe key. |

New migrations are ADDITIVE: append the next `NNNN-name` pair; never edit an
applied migration (the ledger records its SHA-256 and `manifest()` reports
drift instead of guessing).

## File layout

Every migration is a pair of plain SQL files named by its version:

```text
infra/migrations/
  0001-roamlink-schema-ledger.up.sql
  0001-roamlink-schema-ledger.down.sql
  0002-versioned-records.up.sql
  0002-versioned-records.down.sql
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
  extensions where a portable form exists;
- documentation (`.md`) may live beside the SQL; every OTHER file name fails
  the runner's loader closed (never silently ignored).

## Runner contract and reproducible workflow

- `MigrationRunner.migrateUp(target?)` - applies pending migrations in
  ascending version order (idempotent re-runs);
- `MigrationRunner.migrateDown(target?)` - rolls back applied migrations in
  descending order, keeping the target applied (and reproducibly reaching the
  empty database when omitted);
- `AppliedVersionsLedger` - records `(version, applied_at, script_digest)` in
  the same transaction that applies each migration, so bookkeeping commits
  atomically with the schema it tracks;
- the PostgreSQL implementation (`@roamlink/persistence-postgres`) executes
  the files VERBATIM through the driver's multi-statement seam: the file IS
  the statement list, never re-parsed or re-ordered.

```bash
pnpm --filter @roamlink/persistence-postgres db:migrate            # apply all pending
pnpm --filter @roamlink/persistence-postgres db:rollback           # roll everything back
pnpm --filter @roamlink/persistence-postgres db:rollback -- 0002   # roll back to (keeping) 0002
pnpm --filter @roamlink/persistence-postgres db:manifest           # print the manifest JSON
```

The full forward/rollback cycle (apply -> idempotent re-run -> partial and
full rollback -> re-apply) is verified against a real PostgreSQL engine
(pglite) in `packages/persistence-postgres/test/migrations.test.ts`.

## Conventions

- Every persisted timestamp is a UTC instant with explicit serialization
  (spec/data-model.md "Time and freshness").
- Secrets and credentials are never stored in ordinary domain tables
  (spec/security.md); they live in the runtime secret mechanism.
- Multi-tenant tables carry the tenant boundary explicitly (via the record
  repositories' tenant-scoped record ids until the identity schema lands).
- State machines (outbox delivery, inbox admission, domain lifecycles) are
  never collapsed into shared enums; each carries its own closed CHECK.
