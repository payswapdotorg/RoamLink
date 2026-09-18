/**
 * @roamlink/persistence-postgres - the REAL PostgreSQL persistence adapter
 * (RL-091) plus the SQL migration runner over `infra/migrations` (RL-092).
 *
 * Layout:
 *  - `driver.ts`     the vendor seam (`SqlDriver`): pg (hosted) + pglite
 *                    (embedded real PostgreSQL for local dev/tests), and the
 *                    SQLSTATE-aware error mapping;
 *  - `adapter.ts`    the @roamlink/persistence port implementation over the
 *                    seam (UnitOfWork = real transaction, optimistic
 *                    concurrency, durable inbox/outbox) + the health check;
 *  - `sql-state.ts`  row <-> record mapping re-validated through the port
 *                    constructors (fail closed against corrupted rows);
 *  - `migrations.ts` the SQL applied-versions ledger + runner over the
 *                    `infra/migrations` file layout, with the drift-aware
 *                    manifest.
 *
 * The in-memory adapter in @roamlink/persistence remains the semantic
 * reference; this adapter preserves its observable contract (see
 * packages/persistence-postgres/README.md for the documented deltas).
 */
export * from "./driver.js";
export * from "./adapter.js";
export * from "./migrations.js";
