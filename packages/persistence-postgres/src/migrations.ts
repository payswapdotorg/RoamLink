/**
 * The PostgreSQL applied-versions ledger + migration runner (RL-092).
 *
 * Implements the `AppliedVersionsLedger` / `MigrationRunner` ports from
 * @roamlink/persistence against REAL PostgreSQL SQL, reading the migration
 * files laid out under `infra/migrations/` (see that folder's README):
 * plain `NNNN-name.up.sql` / `NNNN-name.down.sql` pairs, lexicographic file
 * order == application order.
 *
 * Semantics (matching the driver-free reference runner, never weaker):
 *  - each migration applies inside ONE real transaction that ALSO records the
 *    ledger row, so a migration and its bookkeeping commit atomically or not
 *    at all (a failed `up` leaves neither schema nor ledger entry behind);
 *  - `migrateUp` is idempotent: applied versions are skipped, so re-runs are
 *    deterministic (the ledger lives in the database - the same bookkeeping
 *    for every caller);
 *  - `migrateDown` rolls back in descending order, keeping the target
 *    applied, and removes the ledger row in the same transaction as the
 *    rollback DDL;
 *  - the ledger additionally stores the SHA-256 of the applied `.up.sql`
 *    file, and `manifest()` reports drift (a file changed after it was
 *    applied) instead of silently guessing - reproducibility is part of the
 *    definition of done;
 *  - the bootstrap state ("ledger table does not exist yet") is recognized
 *    ONLY by the undefined-table SQLSTATE (42P01) and reads as "nothing
 *    applied"; every other ledger failure fails closed.
 *
 * This module executes migration files verbatim through the driver's
 * multi-statement `exec` seam: the file IS the statement list, never
 * re-parsed, re-ordered or re-written by this runner.
 */
import {
  ValidationError,
  nowUtc,
  parseUtcInstant,
  sha256Hex,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  createMigrationRunner,
  parseMigrationVersion,
  type AppliedMigration,
  type AppliedVersionsLedger,
  type Migration,
  type MigrationRunner,
  type MigrationVersion,
} from "@roamlink/persistence";

import { mapSqlError, type SqlDriver } from "./driver.js";

// --------------------------------------------------------------------------------
// Migration file loading (infra/migrations layout)
// --------------------------------------------------------------------------------

const MIGRATION_FILE_PATTERN = /^(\d{4})-([a-z0-9][a-z0-9-]*)\.(up|down)\.sql$/;

/** One loaded migration pair from the infra/migrations directory. */
export interface LoadedMigrationFile {
  readonly version: MigrationVersion;
  readonly description: string;
  /** Verbatim `.up.sql` content. */
  readonly upSql: string;
  /** Verbatim `.down.sql` content. */
  readonly downSql: string;
  /** SHA-256 of the `.up.sql` content (recorded in the ledger at apply time). */
  readonly scriptDigest: string;
}

/**
 * Reads and validates the migration file pairs from a directory (default:
 * the repository's `infra/migrations`). Fails closed on: missing `.down`
 * counterpart, non-standard file names, duplicate versions, or a version
 * outside `0001`..`9999`. Documentation (`.md`) is skipped - the folder
 * carries its README beside the SQL; any OTHER unexpected file (including
 * every non-conforming `.sql`) fails closed, never silently ignored.
 */
export function loadMigrationFiles(migrationsDir: string): readonly LoadedMigrationFile[] {
  const entries = listDirEntries(migrationsDir);
  const upFiles = new Map<MigrationVersion, { name: string; slug: string; sql: string; description: string }>();
  const downFiles = new Set<string>();
  for (const name of entries) {
    const match = MIGRATION_FILE_PATTERN.exec(name);
    if (match === null) {
      if (name.toLowerCase().endsWith(".md")) {
        continue; // documentation, not a migration
      }
      throw new ValidationError(
        `infra/migrations contains a file outside the NNNN-name.up/down.sql layout: ${name}`,
        { reason: "MIGRATION_FILE_LAYOUT_INVALID", details: [{ path: name, issue: "unexpected file name" }] },
      );
    }
    const [, version, slug, direction] = match;
    if (version === undefined || direction === undefined) {
      throw new ValidationError(`migration file name did not parse: ${name}`, {
        reason: "MIGRATION_FILE_LAYOUT_INVALID",
      });
    }
    const parsedVersion = parseMigrationVersion(version);
    if (direction === "up" && slug !== undefined) {
      upFiles.set(parsedVersion, {
        name,
        slug,
        sql: readTextFile(joinPath(migrationsDir, name)),
        // "0002-versioned-records" -> "versioned records"
        description: slug.replaceAll("-", " "),
      });
    } else if (direction === "down") {
      downFiles.add(parsedVersion);
    }
  }
  const versions = [...upFiles.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return versions.map((version) => {
    const up = upFiles.get(version);
    if (up === undefined) {
      throw new ValidationError(`migration ${version} has no .up.sql file`, {
        reason: "MIGRATION_FILE_LAYOUT_INVALID",
      });
    }
    if (!downFiles.has(version)) {
      throw new ValidationError(`migration ${version} has no .down.sql file (down must revert up)`, {
        reason: "MIGRATION_FILE_LAYOUT_INVALID",
      });
    }
    const downSql = readTextFile(joinPath(migrationsDir, `${version}-${up.slug}.down.sql`));
    return Object.freeze({
      version,
      description: up.description,
      upSql: up.sql,
      downSql,
      scriptDigest: sha256Hex(up.sql),
    });
  });
}

// --------------------------------------------------------------------------------
// Node-free indirections (injected so the module stays testable and the
// file-system access stays explicit at the composition boundary)
// --------------------------------------------------------------------------------

/** Directory listing used by the loader (Node fs.readdirSync by default). */
export type ListDir = (dir: string) => readonly string[];
/** Text file reader used by the loader (Node fs.readFileSync utf-8 by default). */
export type ReadTextFile = (path: string) => string;

let listDirImpl: ListDir = defaultListDir;
let readTextFileImpl: ReadTextFile = defaultReadTextFile;

/** Overrides the fs indirections (tests use in-memory directories). */
export function setMigrationFileAccess(fs: { listDir: ListDir; readTextFile: ReadTextFile }): void {
  listDirImpl = fs.listDir;
  readTextFileImpl = fs.readTextFile;
}

function listDirEntries(dir: string): readonly string[] {
  return listDirImpl(dir);
}

function readTextFile(path: string): string {
  return readTextFileImpl(path);
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

// Node defaults are wired by the CLI/host entry points (node:fs); the default
// implementations throw so a forgotten wiring fails loudly instead of
// silently producing an empty migration list.
function defaultListDir(_dir: string): readonly string[] {
  throw new Error(
    "migration file access is not wired: call setMigrationFileAccess (or use runMigrationCli) before loadMigrationFiles",
  );
}

function defaultReadTextFile(_path: string): string {
  throw new Error(
    "migration file access is not wired: call setMigrationFileAccess (or use runMigrationCli) before loadMigrationFiles",
  );
}

// --------------------------------------------------------------------------------
// The SQL applied-versions ledger
// --------------------------------------------------------------------------------

const LEDGER_TABLE = "roamlink_schema_migrations";

const UNDEFINED_TABLE_SQLSTATE = "42P01";

function sqlstateOf(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * The SQL-backed `AppliedVersionsLedger`. The ledger lives in the same
 * database as the schema it tracks, so the bookkeeping is shared by every
 * caller and every process. Rows are written by the migration transactions
 * themselves (`recordApplied` is an idempotent confirm for the port runner
 * path, which runs after `up()` has already recorded).
 */
export function createPostgresAppliedVersionsLedger(driver: SqlDriver): AppliedVersionsLedger {
  return {
    async listApplied(): Promise<readonly AppliedMigration[]> {
      const rows = await driver
        .query(`SELECT version, applied_at FROM ${LEDGER_TABLE} ORDER BY version ASC`)
        .catch((error: unknown) => {
          if (sqlstateOf(error) === UNDEFINED_TABLE_SQLSTATE) {
            // Bootstrap state: no ledger table == nothing applied yet.
            return { rows: [], rowCount: 0 };
          }
          throw mapSqlError(error);
        });
      return Object.freeze(
        rows.rows.map((row) => {
          const version = parseMigrationVersion(row["version"]);
          return Object.freeze({
            version,
            appliedAt: parseUtcInstant(instantTextOf(row["applied_at"], version)),
          });
        }),
      );
    },

    async recordApplied(version: MigrationVersion, appliedAt: UtcInstant): Promise<void> {
      // Idempotent confirm: the migration transaction already wrote the row
      // (with the script digest); a port-runner-driven second write keeps the
      // original instead of double-recording.
      await driver
        .query(
          `INSERT INTO ${LEDGER_TABLE} (version, applied_at) VALUES ($1, $2::timestamptz)
           ON CONFLICT (version) DO NOTHING`,
          [version, appliedAt],
        )
        .catch(mapSqlError);
    },

    async forgetApplied(version: MigrationVersion): Promise<void> {
      // The rollback transaction already removed the row; this is the
      // idempotent cleanup for the port-runner path. A missing ledger TABLE
      // (42P01) is the post-full-rollback bootstrap state (0001's down drops
      // the ledger itself): there is nothing left to forget - the same
      // undefined-table semantics listApplied already honors.
      await driver
        .query(`DELETE FROM ${LEDGER_TABLE} WHERE version = $1`, [version])
        .catch((error: unknown) => {
          if (sqlstateOf(error) === UNDEFINED_TABLE_SQLSTATE) return { rows: [], rowCount: 0 };
          throw mapSqlError(error);
        });
    },
  };
}

function instantTextOf(value: unknown, version: MigrationVersion): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const normalized = value.includes("T") ? value : value.replace(" ", "T").replace("+00", "Z");
    return normalized;
  }
  throw new ValidationError(
    `the applied-migrations ledger row for ${version} carries an unreadable applied_at (state corruption; failing closed)`,
    { reason: "MIGRATION_LEDGER_CORRUPT" },
  );
}

// --------------------------------------------------------------------------------
// The runner factory + manifest
// --------------------------------------------------------------------------------

/** Drift state of one applied migration: does the file still match the ledger? */
export type ManifestDrift = "current" | "file-changed" | "no-digest-recorded";

export interface ManifestEntry {
  readonly version: MigrationVersion;
  readonly description: string;
  readonly state: "applied" | "pending";
  /** Recorded in the ledger at apply time (null for pending). */
  readonly appliedAt: UtcInstant | null;
  /** The applied file's digest, as recorded (null when not recorded). */
  readonly recordedScriptDigest: string | null;
  /** The current file's digest. */
  readonly scriptDigest: string;
  readonly drift: ManifestDrift | null;
}

export interface MigrationManifest {
  readonly applied: readonly ManifestEntry[];
  readonly pending: readonly ManifestEntry[];
}

export interface PostgresMigrationRunnerOptions {
  readonly driver: SqlDriver;
  /** Directory of `NNNN-name.up/down.sql` pairs (default: repo infra/migrations). */
  readonly migrationsDir?: string;
  /** Explicit migration files (overrides `migrationsDir`; tests use this). */
  readonly migrations?: readonly LoadedMigrationFile[];
  /** Deterministic clock for `appliedAt` stamps (defaults to nowUtc). */
  readonly now?: () => UtcInstant;
}

export interface PostgresMigrationRunner extends MigrationRunner {
  /**
   * The reproducibility view: every migration with its applied/pending state,
   * recorded apply instant, and script digests (drift-flagged). This is what
   * `db:manifest` reports and what release verification reads.
   */
  manifest(): Promise<MigrationManifest>;
  /** The loaded migration files backing this runner. */
  readonly files: readonly LoadedMigrationFile[];
}

/**
 * Creates the PostgreSQL migration runner over the driver seam, driving the
 * SHARED runner logic of @roamlink/persistence (ordering, idempotency,
 * corrupt-ledger fail-closed) - this module only supplies the SQL mechanics.
 */
export function createPostgresMigrationRunner(
  options: PostgresMigrationRunnerOptions,
): PostgresMigrationRunner {
  const files =
    options.migrations ?? loadMigrationFiles(options.migrationsDir ?? defaultMigrationsDir());

  const migrations: Migration[] = files.map((file) => ({
    version: file.version,
    description: file.description,
    up: async () => {
      const tx = await options.driver.begin();
      try {
        await tx.exec(file.upSql);
        await tx
          .query(
            `INSERT INTO ${LEDGER_TABLE} (version, applied_at, script_digest) VALUES ($1, $2::timestamptz, $3)`,
            [file.version, (options.now ?? defaultNow)(), file.scriptDigest],
          )
          .catch(mapSqlError);
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw mapSqlError(error);
      }
    },
    down: async () => {
      const tx = await options.driver.begin();
      try {
        // The ledger row is removed BEFORE the down SQL runs, inside the same
        // transaction: migration 0001's down drops the ledger TABLE itself, so
        // deleting after the DDL would fail on the dropped relation. Removing
        // first keeps every rollback (including the full one to the empty
        // database) deterministic; the runner's post-down forgetApplied stays
        // an idempotent no-op either way.
        await tx
          .query(`DELETE FROM ${LEDGER_TABLE} WHERE version = $1`, [file.version])
          .catch(mapSqlError);
        await tx.exec(file.downSql);
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw mapSqlError(error);
      }
    },
  }));

  const ledger = createPostgresAppliedVersionsLedger(options.driver);
  const runner = createMigrationRunner({ migrations, ledger, ...(options.now !== undefined ? { now: options.now } : {}) });

  return {
    files: Object.freeze(files),
    async migrateUp(target?: MigrationVersion): Promise<readonly AppliedMigration[]> {
      return runner.migrateUp(target);
    },
    async migrateDown(target?: MigrationVersion): Promise<readonly MigrationVersion[]> {
      return runner.migrateDown(target);
    },
    async manifest(): Promise<MigrationManifest> {
      const appliedRows = await ledger.listApplied();
      const appliedByVersion = new Map<MigrationVersion, UtcInstant>(
        appliedRows.map((entry) => [entry.version, entry.appliedAt]),
      );
      const digests = await recordedDigests(options.driver);
      const applied: ManifestEntry[] = [];
      const pending: ManifestEntry[] = [];
      for (const file of files) {
        const appliedAt = appliedByVersion.get(file.version);
        if (appliedAt === undefined) {
          pending.push(
            Object.freeze({
              version: file.version,
              description: file.description,
              state: "pending" as const,
              appliedAt: null,
              recordedScriptDigest: null,
              scriptDigest: file.scriptDigest,
              drift: null,
            }),
          );
          continue;
        }
        const recorded = digests.get(file.version) ?? null;
        applied.push(
          Object.freeze({
            version: file.version,
            description: file.description,
            state: "applied" as const,
            appliedAt,
            recordedScriptDigest: recorded,
            scriptDigest: file.scriptDigest,
            drift:
              recorded === null
                ? ("no-digest-recorded" as const)
                : recorded === file.scriptDigest
                  ? ("current" as const)
                  : ("file-changed" as const),
          }),
        );
      }
      // A ledger entry without a matching file is corruption the shared runner
      // would fail closed on; surface it in the manifest too (never hide it).
      for (const entry of appliedRows) {
        if (!files.some((file) => file.version === entry.version)) {
          applied.push(
            Object.freeze({
              version: entry.version,
              description: "(no migration file present)",
              state: "applied" as const,
              appliedAt: entry.appliedAt,
              recordedScriptDigest: digests.get(entry.version) ?? null,
              scriptDigest: "",
              drift: "file-changed" as const,
            }),
          );
        }
      }
      return Object.freeze({ applied: Object.freeze(applied), pending: Object.freeze(pending) });
    },
  };
}

async function recordedDigests(driver: SqlDriver): Promise<Map<MigrationVersion, string>> {
  const rows = await driver
    .query(`SELECT version, script_digest FROM ${LEDGER_TABLE}`)
    .catch((error: unknown) => {
      if (sqlstateOf(error) === UNDEFINED_TABLE_SQLSTATE) return { rows: [], rowCount: 0 };
      throw mapSqlError(error);
    });
  const map = new Map<MigrationVersion, string>();
  for (const row of rows.rows) {
    const version = parseMigrationVersion(row["version"]);
    const digest = row["script_digest"];
    if (typeof digest === "string") map.set(version, digest);
  }
  return map;
}

function defaultNow(): UtcInstant {
  return nowUtc();
}

/** Resolves the repository's infra/migrations directory from this module. */
function defaultMigrationsDir(): string {
  return resolveFromModuleUrl("../../../../infra/migrations");
}

// module-relative URL resolution indirection (overridable in tests)
let resolveImpl: (relative: string) => string = defaultResolve;

export function setMigrationPathResolver(resolve: (relative: string) => string): void {
  resolveImpl = resolve;
}

function resolveFromModuleUrl(relative: string): string {
  return resolveImpl(relative);
}

function defaultResolve(_relative: string): string {
  throw new Error(
    "migration path resolution is not wired: call setMigrationPathResolver (or use runMigrationCli) before relying on the default migrationsDir",
  );
}

// --------------------------------------------------------------------------------
// CLI support (scripts/migrate.ts wires node:fs + pg and calls this)
// --------------------------------------------------------------------------------

export interface MigrationCliResult {
  readonly command: "up" | "down" | "manifest";
  readonly applied?: readonly AppliedMigration[];
  readonly rolledBack?: readonly MigrationVersion[];
  readonly manifest?: MigrationManifest;
}

/**
 * Runs one migration CLI command (`up` | `down` | `manifest`) against the
 * driver. Pure orchestration - the entry point owns process/env concerns.
 * `down` takes an optional target version (that version stays applied).
 */
export async function runMigrationCommand(
  driver: SqlDriver,
  command: "up" | "down" | "manifest",
  options: { migrationsDir?: string; target?: MigrationVersion } = {},
): Promise<MigrationCliResult> {
  const runner = createPostgresMigrationRunner({
    driver,
    ...(options.migrationsDir !== undefined ? { migrationsDir: options.migrationsDir } : {}),
  });
  if (command === "up") {
    return {
      command,
      applied: await runner.migrateUp(options.target),
    };
  }
  if (command === "down") {
    return {
      command,
      rolledBack: await runner.migrateDown(options.target),
    };
  }
  return { command, manifest: await runner.manifest() };
}
