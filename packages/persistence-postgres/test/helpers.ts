/**
 * Shared test runtime for the PostgreSQL persistence adapter tests.
 *
 * Every runtime is backed by @electric-sql/pglite - the REAL PostgreSQL
 * engine compiled to WASM, running in-process - so every statement executes
 * with genuine Postgres semantics (MVCC, locks, SQLSTATE errors, partial
 * unique indexes). Each test starts from a FRESH database migrated with the
 * REAL `infra/migrations` files (RL-092 verified end to end by these tests,
 * not by a schema double).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

import { createPgliteDriver, createPostgresPersistence, createPostgresMigrationRunner, setMigrationFileAccess, setMigrationPathResolver, type PostgresPersistence, type SqlDriver } from "../src/index.js";

/** The repository root (this file lives at packages/persistence-postgres/test/). */
export const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));

/** The REAL migration set of this repository. */
export const REPO_MIGRATIONS_DIR = join(REPO_ROOT, "infra", "migrations");

let fsWired = false;

/**
 * Wires the migration loader to the real Node fs. The loader's fs wiring is
 * process-global mutable state: tests that override it with in-memory
 * directories MUST call this again (force) afterwards, or later tests would
 * read the overridden directory.
 */
export function wireMigrationFileAccess(force = false): void {
  if (fsWired && !force) return;
  setMigrationFileAccess({
    listDir: (dir) => readdirSync(dir),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
  setMigrationPathResolver(() => REPO_MIGRATIONS_DIR);
  fsWired = true;
}

export interface MigratedRuntime {
  readonly db: PGlite;
  readonly driver: SqlDriver;
  readonly persistence: PostgresPersistence;
}

/**
 * A fresh in-process PostgreSQL (pglite) with the real infra/migrations
 * applied. Callers must `await runtime.driver.close()` when done.
 */
export async function createMigratedRuntime(): Promise<MigratedRuntime> {
  wireMigrationFileAccess();
  const db = new PGlite();
  const driver = createPgliteDriver(db);
  const runner = createPostgresMigrationRunner({ driver, migrationsDir: REPO_MIGRATIONS_DIR });
  await runner.migrateUp();
  return { db, driver, persistence: createPostgresPersistence(driver) };
}

// --------------------------------------------------------------------------------
// Deterministic inputs
// --------------------------------------------------------------------------------

export const T0 = "2026-10-01T00:00:00.000Z";
export const T1 = "2026-10-01T00:00:01.000Z";
export const T2 = "2026-10-01T00:00:02.000Z";

/** A counter so every test gets unique ids even when sharing a runtime. */
let counter = 0;

export function nextKey(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, "0")}`;
}

/** Drains the pending outbox by claiming + marking everything delivered. */
export async function drainOutboxDelivered(
  persistence: PostgresPersistence,
  at: string,
): Promise<number> {
  let delivered = 0;
  for (;;) {
    const unitOfWork = await persistence.begin();
    try {
      const claimed = await unitOfWork.outbox.claimDue(at, 10);
      if (claimed.length === 0) {
        await unitOfWork.rollback();
        break;
      }
      for (const record of claimed) {
        await unitOfWork.outbox.markDelivered(record.idempotencyKey, at);
        delivered += 1;
      }
      await unitOfWork.commit();
    } catch (error) {
      await unitOfWork.rollback();
      throw error;
    }
  }
  return delivered;
}
