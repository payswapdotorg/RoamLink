/**
 * RL-092 verification: the REAL `infra/migrations` set applies to (and rolls
 * back from) a real PostgreSQL database (pglite), with ledger bookkeeping,
 * idempotent re-runs, drift detection and forward/rollback reproducibility.
 */
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { NotFoundError, ValidationError } from "@roamlink/contracts";
import { parseMigrationVersion } from "@roamlink/persistence";

import {
  createPgliteDriver,
  createPostgresAppliedVersionsLedger,
  createPostgresMigrationRunner,
  loadMigrationFiles,
  setMigrationFileAccess,
  type LoadedMigrationFile,
} from "../src/index.js";
import { REPO_MIGRATIONS_DIR, createMigratedRuntime, wireMigrationFileAccess } from "./helpers.js";

const version = (value: string) => parseMigrationVersion(value);

describe("migration files (infra/migrations layout)", () => {
  it("loads the real migration set as complete up/down pairs", () => {
    wireMigrationFileAccess();
    const files = loadMigrationFiles(REPO_MIGRATIONS_DIR);
    expect(files.map((file) => file.version)).toEqual(["0001", "0002", "0003", "0004"]);
    for (const file of files) {
      expect(file.upSql.length).toBeGreaterThan(0);
      expect(file.downSql.length).toBeGreaterThan(0);
      expect(file.scriptDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(file.description).not.toContain("-");
    }
  });

  it("fails closed when a .up.sql has no .down.sql counterpart", () => {
    try {
      setMigrationFileAccess({
        listDir: () => ["0001-orphan.up.sql"],
        readTextFile: () => "CREATE TABLE x ();",
      });
      expect(() => loadMigrationFiles("/in-memory")).toThrow(ValidationError);
    } finally {
      wireMigrationFileAccess(true); // restore the real fs for later tests
    }
  });

  it("fails closed on file names outside the NNNN-name.up/down.sql layout", () => {
    try {
      setMigrationFileAccess({
        listDir: () => ["migrate.sql"],
        readTextFile: () => "",
      });
      expect(() => loadMigrationFiles("/in-memory")).toThrow(ValidationError);
    } finally {
      wireMigrationFileAccess(true);
    }
  });

  it("skips the folder's README (documentation is not a migration) but not stray SQL", () => {
    try {
      setMigrationFileAccess({
        listDir: () => ["README.md", "0001-pair.up.sql", "0001-pair.down.sql"],
        readTextFile: () => "SELECT 1;",
      });
      const files = loadMigrationFiles("/in-memory");
      expect(files.map((file) => file.version)).toEqual(["0001"]);
      setMigrationFileAccess({
        listDir: () => ["notes.txt", "0001-pair.up.sql", "0001-pair.down.sql"],
        readTextFile: () => "SELECT 1;",
      });
      expect(() => loadMigrationFiles("/in-memory")).toThrow(ValidationError);
    } finally {
      wireMigrationFileAccess(true);
    }
  });
});

describe("the real migration set on a real PostgreSQL (pglite)", () => {
  it("applies every migration from the empty database with ledger bookkeeping", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const ledger = createPostgresAppliedVersionsLedger(runtime.driver);
      const applied = await ledger.listApplied();
      expect(applied.map((entry) => entry.version)).toEqual(["0001", "0002", "0003", "0004"]);
      // The runner's schema objects all exist and answer queries.
      await runtime.driver.query("SELECT 1 FROM roamlink_records LIMIT 1");
      await runtime.driver.query("SELECT 1 FROM roamlink_outbox LIMIT 1");
      await runtime.driver.query("SELECT 1 FROM roamlink_inbox LIMIT 1");
    } finally {
      await runtime.driver.close();
    }
  });

  it("re-runs migrateUp idempotently (already-applied versions are skipped)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const runner = createPostgresMigrationRunner({ driver: runtime.driver, migrationsDir: REPO_MIGRATIONS_DIR });
      const secondRun = await runner.migrateUp();
      expect(secondRun).toEqual([]); // nothing pending
      const manifest = await runner.manifest();
      expect(manifest.pending).toEqual([]);
      expect(manifest.applied).toHaveLength(4);
      for (const entry of manifest.applied) {
        expect(entry.state).toBe("applied");
        expect(entry.drift).toBe("current");
      }
    } finally {
      await runtime.driver.close();
    }
  });

  it("migrates forward only up to a target version, keeping later ones pending", async () => {
    wireMigrationFileAccess();
    const db = new PGlite();
    const driver = createPgliteDriver(db);
    try {
      const runner = createPostgresMigrationRunner({ driver, migrationsDir: REPO_MIGRATIONS_DIR });
      const applied = await runner.migrateUp(version("0002"));
      expect(applied.map((entry) => entry.version)).toEqual(["0001", "0002"]);
      const manifest = await runner.manifest();
      expect(manifest.applied.map((entry) => entry.version)).toEqual(["0001", "0002"]);
      expect(manifest.pending.map((entry) => entry.version)).toEqual(["0003", "0004"]);
    } finally {
      await driver.close();
    }
  });

  it("rolls back in descending order and removes the ledger rows (down == inverse of up)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const runner = createPostgresMigrationRunner({ driver: runtime.driver, migrationsDir: REPO_MIGRATIONS_DIR });
      const rolledBack = await runner.migrateDown(version("0002"));
      expect(rolledBack).toEqual(["0004", "0003"]);
      const manifest = await runner.manifest();
      expect(manifest.applied.map((entry) => entry.version)).toEqual(["0001", "0002"]);
      expect(manifest.pending.map((entry) => entry.version)).toEqual(["0003", "0004"]);
      // The dropped tables are really gone (undefined table -> empty read).
      await expect(
        runtime.driver.query("SELECT 1 FROM roamlink_outbox LIMIT 1"),
      ).rejects.toMatchObject({ code: "42P01" });
      // Re-applying forward from here is deterministic (reproducible cycle).
      const reapplied = await runner.migrateUp();
      expect(reapplied.map((entry) => entry.version)).toEqual(["0003", "0004"]);
    } finally {
      await runtime.driver.close();
    }
  });

  it("rolls all the way back to the empty database and forward again", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const runner = createPostgresMigrationRunner({ driver: runtime.driver, migrationsDir: REPO_MIGRATIONS_DIR });
      const rolledBack = await runner.migrateDown();
      expect(rolledBack).toEqual(["0004", "0003", "0002", "0001"]);
      const ledger = createPostgresAppliedVersionsLedger(runtime.driver);
      expect(await ledger.listApplied()).toEqual([]);
      await expect(
        runtime.driver.query("SELECT 1 FROM roamlink_records LIMIT 1"),
      ).rejects.toMatchObject({ code: "42P01" });
      // The bootstrap state reads as "nothing applied" (undefined table), so a
      // full forward re-run from the rolled-back state is reproducible.
      const reapplied = await runner.migrateUp();
      expect(reapplied.map((entry) => entry.version)).toEqual(["0001", "0002", "0003", "0004"]);
    } finally {
      await runtime.driver.close();
    }
  });

  it("flags drift when an applied migration's file changes after the fact", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const real = loadMigrationFiles(REPO_MIGRATIONS_DIR);
      const tampered: LoadedMigrationFile[] = real.map((file) =>
        file.version === "0002"
          ? { ...file, upSql: `${file.upSql}\n-- tampered after apply`, scriptDigest: "f".repeat(64) }
          : file,
      );
      const runner = createPostgresMigrationRunner({ driver: runtime.driver, migrations: tampered });
      const manifest = await runner.manifest();
      const entry = manifest.applied.find((candidate) => candidate.version === "0002");
      expect(entry?.drift).toBe("file-changed");
      // Untampered files stay current.
      expect(manifest.applied.find((candidate) => candidate.version === "0003")?.drift).toBe("current");
    } finally {
      await runtime.driver.close();
    }
  });

  it("applies each migration and its ledger row atomically (failed up leaves nothing behind)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const real = loadMigrationFiles(REPO_MIGRATIONS_DIR);
      const broken: LoadedMigrationFile[] = [
        ...real,
        {
          version: parseMigrationVersion("0005"),
          description: "broken migration",
          upSql: "CREATE TABLE roamlink_should_never_exist (id int);\nTHIS IS NOT SQL;",
          downSql: "DROP TABLE roamlink_should_never_exist;",
          scriptDigest: "a".repeat(64),
        },
      ];
      const runner = createPostgresMigrationRunner({ driver: runtime.driver, migrations: broken });
      await expect(runner.migrateUp()).rejects.toThrow();
      // Neither the schema nor the ledger row of the failed migration exists.
      const ledger = createPostgresAppliedVersionsLedger(runtime.driver);
      expect((await ledger.listApplied()).map((entry) => entry.version)).toEqual([
        "0001",
        "0002",
        "0003",
        "0004",
      ]);
      await expect(
        runtime.driver.query("SELECT 1 FROM roamlink_should_never_exist LIMIT 1"),
      ).rejects.toMatchObject({ code: "42P01" });
    } finally {
      await runtime.driver.close();
    }
  });

  it("rejects an unknown rollback target (fail closed, NotFoundError)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const runner = createPostgresMigrationRunner({ driver: runtime.driver, migrationsDir: REPO_MIGRATIONS_DIR });
      await expect(runner.migrateDown(parseMigrationVersion("0009"))).rejects.toThrow(NotFoundError);
    } finally {
      await runtime.driver.close();
    }
  });
});
