# @roamlink/persistence-postgres

The REAL PostgreSQL persistence adapter (RL-091) plus the SQL migration
runner over `infra/migrations` (RL-092). It implements the frozen ports of
`@roamlink/persistence` (`UnitOfWorkFactory`, `PersistenceReader`,
`AppliedVersionsLedger`, `MigrationRunner`) against real SQL — the
deterministic in-memory adapter in `@roamlink/persistence` remains the
semantic reference; this adapter preserves its observable contract.

## Layout

```text
src/driver.ts      the vendor seam (SqlDriver): pg (hosted pool) + pglite
                   (embedded real PostgreSQL), SQLSTATE-aware error mapping
src/adapter.ts     the port implementation (UnitOfWork = one real
                   transaction, optimistic concurrency via CAS statements,
                   durable inbox/outbox) + the database health check
src/sql-state.ts   row <-> record mapping, re-validated through the port
                   constructors (fail closed against corrupted rows)
src/migrations.ts  the SQL applied-versions ledger + the runner over the
                   infra/migrations file layout, with drift-aware manifest
scripts/migrate.ts the CLI: up / down / manifest over DATABASE_URL
```

No ORM, no query builder — plain parameterized SQL through the driver seam.

## Drivers

- `createPgDriver(pool)` — hosted/serverless deployments (Neon or any
  PostgreSQL over `node-postgres`). Pooled connections; every unit of work
  holds one explicit client (`BEGIN` .. `COMMIT/ROLLBACK`).
- `createPgliteDriver(db)` — `@electric-sql/pglite`, the REAL PostgreSQL
  engine compiled to WASM running in-process: local development and the
  deterministic test database used by this package's test suite.

Both drivers fail typed: unique violations surface as `SqlUniqueViolation`
(constraint name included), serialization failures/deadlocks (SQLSTATE
40001/40P01) surface as the Wave-0 `ConflictError`; everything else
propagates unchanged.

## Guarantees (stronger or equal to the in-memory reference)

1. **One `UnitOfWork` = one real database transaction.** Every write through
   its views (records, outbox, inbox) executes inside that transaction, so
   "business write + outbox enqueue" commits atomically or not at all
   (transactional outbox by construction).
2. **Optimistic concurrency is enforced by conditional SQL.** Every mutation
   is a CAS statement on the stored version/state; a lost race — or a missing
   row — throws the typed `ConflictError`. Nothing is ever silently
   overwritten. READ COMMITTED isolation is sufficient because every
   precondition is a conditional statement inside the transaction, and raced
   inserts are fenced with SAVEPOINTs so a unique-index loss never aborts the
   surrounding unit of work.
3. **The inbox's "exactly one ADMITTED record per dedupe key" is enforced by
   the database** — a partial unique index on the ADMITTED rows. Later
   arrivals become DUPLICATE audit rows; rejected arrivals never occupy the
   key (RL-LOCK-009).
4. **The outbox delivery state machine is the shared, pure transition logic
   of `@roamlink/persistence`** (`claimOutboxRecord`,
   `completeOutboxDelivery`, `failOutboxAttempt`) — the SQL adapter cannot
   drift from the closed state machine. Concurrent delivery workers claim
   disjoint sets via `FOR UPDATE SKIP LOCKED` (never the same record twice —
   strictly stronger than the in-memory replay's conflict semantics).
5. **Rows are parsed fail-closed.** Every row -> record conversion
   re-validates through the port's constructors/parsers; a corrupted or
   hand-edited row throws instead of guessing.
6. **Migrations and their ledger rows commit in ONE transaction** (a failed
   `up` leaves neither schema nor bookkeeping behind), the ledger stores the
   SHA-256 of each applied `.up.sql`, and `manifest()` reports drift instead
   of guessing. `migrateUp` is idempotent; `migrateDown` rolls back in
   descending order and reproducibly reaches the empty database.

## Honest deltas and gaps (never weakenings, never faked)

- **pglite is a single PostgreSQL session.** While a unit of work is open,
  autocommit reads on the same session execute inside that transaction, so
  the "committed readers never see uncommitted writes" isolation invariant
  cannot be expressed on pglite; it is enforced by connection boundaries on
  the pg driver and must be verified against a real pooled database (RL-106).
  A second concurrent `begin()` on the pglite driver fails loudly
  (`PGLITE_TRANSACTION_CONCURRENT`) instead of silently sharing.
- **Inbox sequences come from a real IDENTITY column**: monotonic in commit
  order, but a rolled-back transaction burns its value (gaps are possible).
  Consumers get the documented ordering signal, not 1-based contiguity.
- **Claimed records stay DELIVERING if a worker dies after commit** — the
  known Wave-5 finding; recovery is RL-093's visibility-timeout work and is
  deliberately not improvised here.
- **Multi-connection race paths** (concurrent enqueue/admit CAS via
  SAVEPOINT + re-read) are verified by construction and unit tests of the
  mapping, but a true two-connection race can only be exercised on a real
  pool — same RL-106 verification debt, pinned here rather than faked.
- **Backup/restore** is a deployment-level capability (RL-111): this package
  guarantees the schema is fully captured by `infra/migrations` + data
  dumps; it does not ship backup tooling itself.

## Usage

```bash
pnpm --filter @roamlink/persistence-postgres db:migrate     # apply pending
pnpm --filter @roamlink/persistence-postgres db:rollback    # roll all back
pnpm --filter @roamlink/persistence-postgres db:rollback -- 0002  # roll back TO (keeping) 0002
pnpm --filter @roamlink/persistence-postgres db:manifest    # print the manifest JSON
```

The CLI reads `DATABASE_URL` (env-driven configuration; this package
contains zero secrets) and prints its result as JSON. The adapter itself
never creates tables implicitly: apply `infra/migrations` first — a missing
schema fails loudly.

The schema owned by `infra/migrations` (RL-092): `roamlink_records` (the
versioned record store, partitioned by repository name),
`roamlink_outbox` (the durable delivery outbox),
`roamlink_inbox` (the append-only webhook admission log) and
`roamlink_schema_migrations` (the applied-versions ledger).
