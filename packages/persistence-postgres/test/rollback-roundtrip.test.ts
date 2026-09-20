/**
 * RL-112 — the DEPLOYMENT ROLLBACK VERIFICATION: the REAL-SQL round-trip
 * that proves DOWN actually works over the real `infra/migrations` files,
 * under the ledger discipline (RL-090/092), through the PUBLIC runner and
 * persistence seams only.
 *
 * What is pinned here:
 *
 *  RT-1 FULL ROUND-TRIP (pglite, the real PostgreSQL engine — always on):
 *      migrateUp from empty -> representative data written through the
 *      PUBLIC persistence seams -> migrateDown() to BASE (every version
 *      rolled back, descending, 0001's down drops the ledger itself) ->
 *      migrateUp() again -> the ledger is consistent end to end (exactly
 *      the migration set, digest-current, ascending) and the manifest is
 *      drift-free.
 *  RT-2 FORWARD-COMPAT WRITES — the HONEST NON-SURVIVABLE CASES: every
 *      current down migration is a DROP TABLE (the schema is baseline),
 *      so table data written before the round-trip does NOT survive a
 *      deliberate down-up cycle. This is asserted (not hidden) and is the
 *      encoded reason the deployment runbook's rollback rule NEVER
 *      auto-runs migrateDown: a rollback is a forward-fix (redeploy the
 *      previous application SHA against the additive schema), and a
 *      down-migration is a deliberate, operator-commanded maintenance
 *      action that destroys the data in the rolled-back tables.
 *  RT-3 PARTIAL ROLLBACK (to a target): migrateDown("0002") rolls back
 *      0004 then 0003 (descending), KEEPS 0002 applied, and a subsequent
 *      migrateUp re-applies cleanly; the ledger tracks every step.
 *  RT-4 the REAL-POOL leg (DATABASE_URL-gated, honest skip otherwise):
 *      RT-1's scenario over a real pooled PostgreSQL.
 */
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { parseMigrationVersion } from "@roamlink/persistence";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import {
  createPgDriver,
  createPgliteDriver,
  createPostgresMigrationRunner,
  createPostgresPersistence,
  setMigrationFileAccess,
  setMigrationPathResolver,
  type PostgresMigrationRunner,
  type PostgresPersistence,
} from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));
const MIGRATIONS_DIR = join(REPO_ROOT, "infra", "migrations");
const T0 = "2026-10-01T00:00:00.000Z";

function wireMigrations(): void {
  setMigrationFileAccess({
    listDir: (dir) => readdirSync(dir),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
  setMigrationPathResolver(() => MIGRATIONS_DIR);
}

/** Writes representative data through the PUBLIC persistence seams. */
async function writeRepresentativeData(persistence: PostgresPersistence): Promise<void> {
  const unit = await persistence.begin();
  await unit.records("rollback-verification").insert("rt-record-1", { scenario: "round-trip", revision: 1 });
  await unit.outbox.enqueue({
    idempotencyKey: "rt-outbox-1",
    payload: { scenario: "round-trip" },
    createdAt: T0,
  });
  await unit.inbox.admit({
    source: "rl112-battery",
    externalEventId: "rt-event-1",
    receivedAt: T0,
    dedupeKey: "rt-dedupe-1",
  });
  await unit.commit();
}

/** The ledger-consistency law: exactly the migration set, digest-current, ascending. */
async function assertLedgerConsistent(runner: PostgresMigrationRunner): Promise<void> {
  const manifest = await runner.manifest();
  expect(manifest.pending).toEqual([]); // everything applied
  expect(manifest.applied.map((entry) => entry.version)).toEqual(
    runner.files.map((file) => file.version),
  );
  expect(manifest.applied.every((entry) => entry.drift === "current")).toBe(true);
  expect(manifest.applied.every((entry) => entry.appliedAt !== null)).toBe(true);
  expect(manifest.applied.every((entry) => entry.recordedScriptDigest === entry.scriptDigest)).toBe(true);
}

describe("RL-112 RT-1/RT-2: the full migrate DOWN-to-base and UP round-trip (real SQL, pglite engine)", () => {
  it("up -> data -> down to base -> up: the ledger is consistent and the non-survivable cases are honest", async () => {
    wireMigrations();
    const db = new PGlite();
    try {
      const driver = createPgliteDriver(db);
      const runner = createPostgresMigrationRunner({ driver });
      const persistence = createPostgresPersistence(driver);

      // UP from empty: the full set applies in ascending order.
      const applied = await runner.migrateUp();
      expect(applied.map((migration) => migration.version)).toEqual(runner.files.map((file) => file.version));
      await assertLedgerConsistent(runner);

      // Representative data through the PUBLIC seams (records/outbox/inbox).
      await writeRepresentativeData(persistence);
      expect((await persistence.records("rollback-verification").list()).length).toBe(1);
      expect((await persistence.outbox.list()).length).toBe(1);
      expect((await persistence.inbox.list()).length).toBe(1);

      // DOWN to BASE (no target = everything rolled back, descending).
      const rolledBack = await runner.migrateDown();
      expect(rolledBack).toEqual([...runner.files.map((file) => file.version)].reverse());
      // 0001's down dropped the LEDGER itself: the database is back to the
      // bootstrap state ("nothing applied"), honestly.
      const manifestAfterDown = await runner.manifest();
      expect(manifestAfterDown.applied).toEqual([]);
      expect(manifestAfterDown.pending.map((entry) => entry.version)).toEqual(
        runner.files.map((file) => file.version),
      );

      // UP again: a clean forward re-application from the empty state.
      const reapplied = await runner.migrateUp();
      expect(reapplied.map((migration) => migration.version)).toEqual(runner.files.map((file) => file.version));
      await assertLedgerConsistent(runner);

      // RT-2 — the honest non-survivable case: the baseline down migrations
      // DROP the data tables, so pre-round-trip table data does NOT survive.
      // (This assertion ENCODES the runbook rule: a rollback NEVER
      // auto-runs migrateDown — the destructive step is deliberate,
      // operator-commanded, and pairs with a restore-from-backup.)
      expect(await persistence.records("rollback-verification").list()).toEqual([]);
      expect(await persistence.outbox.list()).toEqual([]);
      expect(await persistence.inbox.list()).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

describe("RL-112 RT-3: the partial rollback to a target keeps the target applied and re-applies cleanly", () => {
  it("down to 0002 (0004 then 0003 rolled back), up again, ledger consistent at every step", async () => {
    wireMigrations();
    const db = new PGlite();
    try {
      const driver = createPgliteDriver(db);
      const runner = createPostgresMigrationRunner({ driver });
      await runner.migrateUp();

      // DOWN to 0002: 0004 then 0003 rolled back; 0002 stays applied.
      const rolledBack = await runner.migrateDown(parseMigrationVersion("0002"));
      expect(rolledBack).toEqual(["0004", "0003"]);
      const afterDown = await runner.manifest();
      expect(afterDown.applied.map((entry) => entry.version)).toEqual(["0001", "0002"]);
      expect(afterDown.pending.map((entry) => entry.version)).toEqual(["0003", "0004"]);

      // UP again: the same two re-apply cleanly (forward-compatible).
      const reapplied = await runner.migrateUp();
      expect(reapplied.map((migration) => migration.version)).toEqual(["0003", "0004"]);
      await assertLedgerConsistent(runner);

      // Idempotency across the round-trip: a further up applies nothing.
      const fixedPoint = await runner.migrateUp();
      expect(fixedPoint).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

// --------------------------------------------------------------------------------
// RT-4: the REAL-pool leg (DATABASE_URL-gated, honest skip otherwise).
// --------------------------------------------------------------------------------

const RAW_DATABASE_URL = process.env["DATABASE_URL"]?.trim() || undefined;
const DATABASE_URL =
  RAW_DATABASE_URL !== undefined &&
  (RAW_DATABASE_URL.startsWith("postgres://") || RAW_DATABASE_URL.startsWith("postgresql://"))
    ? RAW_DATABASE_URL
    : undefined;

const realDatabase = DATABASE_URL !== undefined ? describe : describe.skip;
if (DATABASE_URL === undefined) {
  console.log(
    "[RL-112] SKIPPING the real-pool rollback round-trip: no PostgreSQL DATABASE_URL is configured " +
      "(postgres:// or postgresql:// required). The pglite legs above run the SAME scenario on the " +
      "real PostgreSQL engine (WASM); the real-pool leg re-proves the ledger discipline on a hosted " +
      "database in the operator phase — this skip is named, never a silent pass.",
  );
}

realDatabase("RL-112 RT-4: the round-trip over a REAL pooled PostgreSQL", () => {
  it("up -> data -> down to base -> up with the ledger consistent end to end", async () => {
    wireMigrations();
    const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    const driver = createPgDriver(pool);
    try {
      const runner = createPostgresMigrationRunner({ driver });
      const persistence = createPostgresPersistence(driver);

      await runner.migrateUp();
      await assertLedgerConsistent(runner);
      await writeRepresentativeData(persistence);
      expect((await persistence.records("rollback-verification").list()).length).toBe(1);

      // DOWN to base, then UP: the ledger converges (exactly the migration
      // set, digest-current); the pre-round-trip table data is the honest
      // non-survivable case (RT-2 — the down migrations DROP the tables).
      await runner.migrateDown();
      await runner.migrateUp();
      await assertLedgerConsistent(runner);
      expect(await persistence.records("rollback-verification").list()).toEqual([]);
    } finally {
      await pool.end();
    }
  }, 120_000);
});
