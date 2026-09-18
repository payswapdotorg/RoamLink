/**
 * The SQL driver seam for the PostgreSQL persistence adapter (RL-091).
 *
 * The adapter implements the @roamlink/persistence ports against REAL
 * PostgreSQL SQL. To stay provider-portable (spec/deployment.md §8: the
 * PostgreSQL adapter sits behind a port; replacing Neon must not require
 * domain changes) the adapter depends on THIS minimal seam instead of a
 * vendor client:
 *
 *   - `createPgDriver(pool)`   - hosted/serverless deployments (Neon via the
 *     `pg` pool, connection pooling + explicit per-unit-of-work clients);
 *   - `createPgliteDriver(db)` - embedded real PostgreSQL (@electric-sql/
 *     pglite, the actual Postgres engine in-process) for local development
 *     and deterministic tests.
 *
 * Both drivers expose exactly the same surface: autocommit reads plus an
 * explicit `begin()` that hands out a REAL transaction spanning awaits
 * (the UnitOfWork port holds its transaction open until commit/rollback).
 * No ORM, no query builder - plain parameterized SQL throughout.
 */
import { ConflictError, DomainError } from "@roamlink/contracts";

/** The raw result shape the adapter consumes (vendor-neutral). */
export interface SqlQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  /** Affected-row count (may be null for drivers that do not report it). */
  readonly rowCount: number | null;
}

/** A single executor: parameterized SQL only. */
export interface SqlExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<SqlQueryResult>;
  /**
   * Executes a multi-statement SQL script (no parameters) as one server-side
   * round trip: the plain/simple query protocol (pg) or exec (pglite). Used
   * by the migration runner to apply migration files verbatim - the file IS
   * the statement list, never re-parsed or re-ordered here.
   */
  exec(sql: string): Promise<SqlQueryResult>;
}

/** One open, REAL database transaction spanning awaits. */
export interface SqlTransaction extends SqlExecutor {
  /** Commits the transaction; after this the handle is dead. */
  commit(): Promise<void>;
  /** Rolls the transaction back; safe to call once, after this the handle is dead. */
  rollback(): Promise<void>;
}

/** The PostgreSQL driver port the adapter is written against. */
export interface SqlDriver extends SqlExecutor {
  /** Human-readable driver label (logs/health; never a secret). */
  readonly label: string;
  /** Autocommit read outside any transaction (committed state only). */
  query(sql: string, params?: readonly unknown[]): Promise<SqlQueryResult>;
  /** Opens a real transaction that spans awaits until commit/rollback. */
  begin(): Promise<SqlTransaction>;
  /** Liveness probe (SELECT 1) for health/readiness. */
  ping(): Promise<void>;
  /** Releases connections/resources; idempotent. */
  close(): Promise<void>;
}

// --------------------------------------------------------------------------------
// SQLSTATE-aware error mapping (fail typed, never silently)
// --------------------------------------------------------------------------------

/** SQLSTATE classes the adapter maps onto typed conflicts. */
const SQLSTATE_SERIALIZATION = ["40001", "40P01"];

function sqlstateOf(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function isUniqueViolation(error: unknown): boolean {
  return sqlstateOf(error) === "23505";
}

/**
 * Maps a failed SQL statement onto the adapter's typed errors: unique
 * violations surface as the sentinel {@link SqlUniqueViolation} (the caller
 * decides the semantic), serialization/deadlock failures surface as the
 * Wave-0 ConflictError (a concurrent committer won - re-read and retry),
 * everything else propagates unchanged (fail closed, details preserved).
 *
 * BOTH drivers map errors CENTRALLY on their query/exec surfaces: the seam
 * always fails typed. Mapping is idempotent with the adapter's additional
 * `.catch(mapSqlError)` guards (a mapped error re-enters unchanged).
 */
export class SqlUniqueViolation extends Error {
  readonly constraint: string | null;
  constructor(constraint: string | null) {
    super(`unique violation${constraint === null ? "" : ` on ${constraint}`}`);
    this.name = "SqlUniqueViolation";
    this.constraint = constraint;
  }
}

export function mapSqlError(error: unknown): never {
  if (isUniqueViolation(error)) {
    const constraint =
      error !== null &&
      typeof error === "object" &&
      "constraint" in error &&
      typeof (error as { constraint?: unknown }).constraint === "string"
        ? (error as { constraint: string }).constraint
        : null;
    throw new SqlUniqueViolation(constraint);
  }
  const state = sqlstateOf(error);
  if (state !== undefined && SQLSTATE_SERIALIZATION.includes(state)) {
    throw new ConflictError(
      "concurrent database transactions conflict (serialization failure or deadlock); the transaction was rolled back - re-read and retry",
      { reason: "OPTIMISTIC_CONCURRENCY_CONFLICT" },
    );
  }
  throw error;
}

/** Wraps one driver call so it always fails typed (see {@link mapSqlError}). */
async function mapped<TResult>(run: () => Promise<TResult>): Promise<TResult> {
  try {
    return await run();
  } catch (error) {
    mapSqlError(error);
  }
}

// --------------------------------------------------------------------------------
// pg-backed driver (hosted path: Neon/any PostgreSQL over node-postgres)
// --------------------------------------------------------------------------------

/** Minimal structural type for a `pg` Pool (avoids a hard type import). */
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

export interface PgClientLike {
  query(sql: string, params?: readonly unknown[]): Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
  release(): void;
}

export interface PgDriverOptions {
  /**
   * Transaction isolation for units of work. READ COMMITTED (the Postgres
   * default) is sufficient because every precondition is enforced by a
   * conditional statement inside the transaction (CAS on version columns,
   * partial unique admission index) - see the adapter README.
   */
  readonly isolationLevel?: "read committed" | "repeatable read" | "serializable";
}

/** Wraps a node-postgres pool into the {@link SqlDriver} seam. */
export function createPgDriver(pool: PgPoolLike, options: PgDriverOptions = {}): SqlDriver {
  const isolation = options.isolationLevel ?? "read committed";
  return {
    label: "pg",
    async query(sql, params = []) {
      return mapped(async () => {
        const client = await pool.connect();
        try {
          return await client.query(sql, params);
        } finally {
          client.release();
        }
      });
    },
    async exec(sql) {
      return mapped(async () => {
        const client = await pool.connect();
        try {
          // node-postgres runs multi-statement scripts through the simple query
          // protocol when no parameters are bound - exactly what a migration
          // file needs.
          return await client.query(sql);
        } finally {
          client.release();
        }
      });
    },
    async begin(): Promise<SqlTransaction> {
      const client = await pool.connect();
      let settled = false;
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
      } catch (error) {
        client.release();
        throw error;
      }
      return {
        async query(sql, params = []) {
          return mapped(async () => client.query(sql, params));
        },
        async exec(sql) {
          return mapped(async () => client.query(sql));
        },
        async commit() {
          if (settled) return;
          settled = true;
          try {
            await client.query("COMMIT");
          } finally {
            client.release();
          }
        },
        async rollback() {
          if (settled) return;
          settled = true;
          try {
            await client.query("ROLLBACK");
          } finally {
            client.release();
          }
        },
      };
    },
    async ping() {
      const result = await this.query("SELECT 1 AS ok");
      if (result.rows.length === 0) {
        throw new DomainError("database ping returned no rows", { reason: "DATABASE_PING_FAILED" });
      }
    },
    async close() {
      await pool.end();
    },
  };
}

// --------------------------------------------------------------------------------
// pglite-backed driver (embedded real PostgreSQL for local dev + tests)
// --------------------------------------------------------------------------------

/**
 * Minimal structural type for a pglite database instance. `exec` is typed
 * `unknown` on purpose: pglite's real `exec` returns an ARRAY of per-
 * statement results for multi-statement scripts (the driver normalizes both
 * shapes - single result or array - to the last statement's outcome).
 */
export interface PgliteLike {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

/** Normalizes one pglite result (single object, or the last of an array) into the seam shape. */
function normalizePgliteResult(raw: unknown): SqlQueryResult {
  const last = Array.isArray(raw) ? raw.at(-1) : raw;
  const record = (last ?? {}) as { rows?: unknown; affectedRows?: unknown };
  return {
    rows: Array.isArray(record.rows) ? (record.rows as Record<string, unknown>[]) : [],
    rowCount: typeof record.affectedRows === "number" ? record.affectedRows : null,
  };
}

/**
 * Wraps an @electric-sql/pglite database into the {@link SqlDriver} seam.
 *
 * pglite is the REAL PostgreSQL engine compiled to WASM, running in-process:
 * every statement executes with genuine Postgres semantics (MVCC, locks,
 * SQLSTATE errors). It is single-session, so this driver enforces one open
 * SQL transaction at a time (a second concurrent `begin()` fails loudly);
 * sequential units of work are unaffected and truly concurrent units of
 * work require the pg driver (a connection pool).
 */
export function createPgliteDriver(db: PgliteLike): SqlDriver {
  // pglite is a single session: track the in-session SQL transaction so a
  // second CONCURRENT unit of work fails loudly instead of silently sharing
  // (and cross-committing) one transaction. Sequential units of work are of
  // course fine; truly concurrent units of work need the pg driver (a pool).
  let openTransaction = false;
  return {
    label: "pglite",
    async query(sql, params = []) {
      return mapped(async () => {
        if (params.length === 0 && /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
          return normalizePgliteResult(await db.exec(sql));
        }
        // pglite reads the parameter array without mutating it; the readonly
        // seam contract is safe to pass through at this single confined cast.
        return normalizePgliteResult(await db.query(sql, [...params]));
      });
    },
    async exec(sql) {
      return mapped(async () => normalizePgliteResult(await db.exec(sql)));
    },
    async begin(): Promise<SqlTransaction> {
      if (openTransaction) {
        throw new DomainError(
          "the pglite driver is single-session: a second concurrent unit of work cannot be opened while one is active (use the pg driver for concurrent units of work)",
          { reason: "PGLITE_TRANSACTION_CONCURRENT" },
        );
      }
      let settled = false;
      await db.exec("BEGIN");
      openTransaction = true;
      return {
        async query(sql, params = []) {
          return mapped(async () => {
            if (params.length === 0 && /^\s*(COMMIT|ROLLBACK)\b/i.test(sql)) {
              return normalizePgliteResult(await db.exec(sql));
            }
            return normalizePgliteResult(await db.query(sql, [...params]));
          });
        },
        async exec(sql) {
          return mapped(async () => normalizePgliteResult(await db.exec(sql)));
        },
        async commit() {
          if (settled) return;
          settled = true;
          openTransaction = false;
          await db.exec("COMMIT");
        },
        async rollback() {
          if (settled) return;
          settled = true;
          openTransaction = false;
          await db.exec("ROLLBACK");
        },
      };
    },
    async ping() {
      const result = normalizePgliteResult(await db.query("SELECT 1 AS ok"));
      if (result.rows.length === 0) {
        throw new DomainError("database ping returned no rows", { reason: "DATABASE_PING_FAILED" });
      }
    },
    async close() {
      await db.close();
    },
  };
}
