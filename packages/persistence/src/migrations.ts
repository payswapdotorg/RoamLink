/**
 * Versioned migration runner contract (RL-003).
 *
 * PORT ONLY in this work item: the runner interface, the applied-versions
 * ledger port, and a driver-free reference implementation ("in-memory fake")
 * that executes plain `up`/`down` thunks. No vendor driver is coupled here -
 * a PostgreSQL-compatible driver that runs the SQL files laid out under
 * `infra/migrations/` will implement the same interfaces in a later work
 * item (spec/repository-layout.md "Infrastructure choices may be swapped
 * behind contracts").
 *
 * Semantics:
 *  - versions are zero-padded 4-digit strings ("0001".."9999"); lexicographic
 *    order == application order, deterministically;
 *  - `migrateUp(target?)` applies PENDING migrations in ascending version
 *    order up to and including `target` (all when omitted). Already-applied
 *    versions are skipped: re-running is idempotent;
 *  - `migrateDown(target?)` rolls back applied migrations in DESCENDING
 *    version order, stopping with `target` still applied (all applied
 *    migrations when omitted);
 *  - the ledger records (version, appliedAt) in application order; its order
 *    is always version-ascending (down removes from the top);
 *  - a ledger entry referencing a version not present in the migration list
 *    fails closed (ValidationError) - that is state corruption, not a
 *    situation to guess through (spec/security.md "Fail-safe defaults").
 */
import {
  NotFoundError,
  ValidationError,
  nowUtc,
  type Branded,
  type UtcInstant,
} from "@roamlink/contracts";

/** A migration version: zero-padded 4-digit string, e.g. "0001". */
export type MigrationVersion = Branded<"MigrationVersion">;

const MIGRATION_VERSION_PATTERN = /^[0-9]{4}$/;

export function isMigrationVersion(value: unknown): value is MigrationVersion {
  return typeof value === "string" && MIGRATION_VERSION_PATTERN.test(value) && value !== "0000";
}

/** Parses a migration version; rejects anything but 0001-9999. */
export function parseMigrationVersion(value: unknown): MigrationVersion {
  if (
    typeof value !== "string" ||
    !MIGRATION_VERSION_PATTERN.test(value) ||
    value === "0000" // baseline is "no migrations applied"; the first real migration is 0001
  ) {
    throw new ValidationError(
      "MigrationVersion must be a zero-padded 4-digit string (\"0001\"..\"9999\") matching the infra/migrations file layout",
      {
        reason: "MIGRATION_VERSION_INVALID",
        details: [{ path: "MigrationVersion", issue: "not a 4-digit version string" }],
      },
    );
  }
  return value as MigrationVersion;
}

/** One versioned migration with up/down semantics. */
export interface Migration {
  readonly version: MigrationVersion;
  readonly description: string;
  /** Applies the migration forward. */
  readonly up: () => void | Promise<void>;
  /** Reverts the migration. */
  readonly down: () => void | Promise<void>;
}

/** A recorded application of one migration. */
export interface AppliedMigration {
  readonly version: MigrationVersion;
  readonly appliedAt: UtcInstant;
}

/**
 * The applied-versions ledger port. A driver-backed implementation persists
 * this (e.g. a `schema_migrations` table); the in-memory fake keeps a list.
 */
export interface AppliedVersionsLedger {
  /** Applied migrations in application order (version-ascending). */
  listApplied(): Promise<readonly AppliedMigration[]>;
  /** Records that `version` was applied at `appliedAt`. */
  recordApplied(version: MigrationVersion, appliedAt: UtcInstant): Promise<void>;
  /** Removes the record for `version` (used by down rollback). */
  forgetApplied(version: MigrationVersion): Promise<void>;
}

/** The migration runner port: deterministic, idempotent up; reverse down. */
export interface MigrationRunner {
  /** Applies pending migrations in ascending version order (idempotent). */
  migrateUp(target?: MigrationVersion): Promise<readonly AppliedMigration[]>;
  /** Rolls back applied migrations in descending order (target stays applied). */
  migrateDown(target?: MigrationVersion): Promise<readonly MigrationVersion[]>;
}

export interface MigrationRunnerOptions {
  readonly migrations: readonly Migration[];
  readonly ledger: AppliedVersionsLedger;
  /** Deterministic clock for `appliedAt` stamps (defaults to nowUtc). */
  readonly now?: () => UtcInstant;
}

function versionError(message: string, reason: string): never {
  throw new ValidationError(message, { reason });
}

/**
 * Driver-free reference implementation of {@link MigrationRunner} ("in-memory
 * fake"): validates the migration list once, then executes up/down against
 * any {@link AppliedVersionsLedger}. Production runners for SQL files under
 * `infra/migrations/` implement the same interface with a vendor driver.
 */
export function createMigrationRunner(options: MigrationRunnerOptions): MigrationRunner {
  const byVersion = new Map<MigrationVersion, Migration>();
  for (const migration of options.migrations) {
    if (migration === null || typeof migration !== "object") {
      versionError("migration list entries must be objects", "MIGRATION_INVALID");
    }
    const version = migration.version;
    if (!isMigrationVersion(version)) {
      versionError("migration versions must be valid 4-digit versions", "MIGRATION_VERSION_INVALID");
    }
    if (typeof migration.up !== "function" || typeof migration.down !== "function") {
      versionError("migrations must provide up and down functions", "MIGRATION_INVALID");
    }
    if (typeof migration.description !== "string" || migration.description.length === 0) {
      versionError("migrations must carry a non-empty description", "MIGRATION_INVALID");
    }
    if (byVersion.has(version)) {
      versionError("duplicate migration version in the migration list", "MIGRATION_VERSION_DUPLICATE");
    }
    byVersion.set(version, migration);
  }
  const now = options.now ?? nowUtc;

  const validateTarget = (target: MigrationVersion | undefined): void => {
    if (target !== undefined && !byVersion.has(target)) {
      throw new NotFoundError("migration target version is not present in the migration list", {
        reason: "MIGRATION_TARGET_UNKNOWN",
      });
    }
  };

  const appliedSet = async (): Promise<Set<MigrationVersion>> => {
    const applied = await options.ledger.listApplied();
    const seen = new Set<MigrationVersion>();
    for (const entry of applied) {
      if (!isMigrationVersion(entry.version)) {
        versionError("ledger contains an invalid migration version", "MIGRATION_LEDGER_CORRUPT");
      }
      if (!byVersion.has(entry.version)) {
        versionError(
          "ledger references a version that is not in the migration list (state corruption; failing closed)",
          "MIGRATION_LEDGER_CORRUPT",
        );
      }
      if (seen.has(entry.version)) {
        versionError("ledger contains a duplicate applied version", "MIGRATION_LEDGER_CORRUPT");
      }
      seen.add(entry.version);
    }
    return seen;
  };

  return {
    async migrateUp(target?: MigrationVersion): Promise<readonly AppliedMigration[]> {
      validateTarget(target);
      const applied = await appliedSet();
      const appliedThisRun: AppliedMigration[] = [];
      const versions = [...byVersion.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const version of versions) {
        if (target !== undefined && version > target) break;
        if (applied.has(version)) continue; // idempotent re-run
        const migration = byVersion.get(version);
        if (migration === undefined) {
          versionError("migration lookup invariant violated", "MIGRATION_INVALID");
        }
        await migration.up();
        const appliedAt = now();
        await options.ledger.recordApplied(version, appliedAt);
        appliedThisRun.push(Object.freeze({ version, appliedAt }));
      }
      return Object.freeze(appliedThisRun);
    },

    async migrateDown(target?: MigrationVersion): Promise<readonly MigrationVersion[]> {
      validateTarget(target);
      const applied = await options.ledger.listApplied();
      const rolledBack: MigrationVersion[] = [];
      // descending application order (== descending version order, ledger invariant)
      for (let i = applied.length - 1; i >= 0; i -= 1) {
        const entry = applied[i];
        if (entry === undefined) {
          versionError("ledger iteration invariant violated", "MIGRATION_LEDGER_CORRUPT");
        }
        if (target !== undefined && entry.version <= target) break;
        const migration = byVersion.get(entry.version);
        if (migration === undefined) {
          versionError(
            "ledger references a version that is not in the migration list (state corruption; failing closed)",
            "MIGRATION_LEDGER_CORRUPT",
          );
        }
        await migration.down();
        await options.ledger.forgetApplied(entry.version);
        rolledBack.push(entry.version);
      }
      return Object.freeze(rolledBack);
    },
  };
}

/**
 * The in-memory fake of {@link AppliedVersionsLedger}: a frozen-snapshot list
 * exposing `snapshot()` for test assertions.
 */
export function createInMemoryAppliedVersionsLedger(): AppliedVersionsLedger & {
  readonly snapshot: () => readonly AppliedMigration[];
} {
  const applied: AppliedMigration[] = [];
  const findIndex = (version: MigrationVersion): number =>
    applied.findIndex((entry) => entry.version === version);
  return {
    async listApplied(): Promise<readonly AppliedMigration[]> {
      return Object.freeze([...applied]);
    },
    async recordApplied(version: MigrationVersion, appliedAt: UtcInstant): Promise<void> {
      if (findIndex(version) !== -1) {
        versionError("ledger already records this applied version", "MIGRATION_LEDGER_CORRUPT");
      }
      applied.push(Object.freeze({ version: parseMigrationVersion(version), appliedAt }));
    },
    async forgetApplied(version: MigrationVersion): Promise<void> {
      const index = findIndex(version);
      if (index === -1) {
        throw new NotFoundError("ledger does not record this applied version", {
          reason: "MIGRATION_LEDGER_CORRUPT",
        });
      }
      applied.splice(index, 1);
    },
    snapshot(): readonly AppliedMigration[] {
      return Object.freeze([...applied]);
    },
  };
}
