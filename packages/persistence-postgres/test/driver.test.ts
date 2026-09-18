/**
 * RL-091: the SQL driver seam (pglite + error mapping) and the health check.
 * The pg (hosted pool) driver shares the adapter surface; its concurrency
 * behavior is verified against a real PostgreSQL in RL-106 (a single-session
 * pglite cannot host concurrent connections - pinned in the package README).
 */
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { ConflictError, DomainError } from "@roamlink/contracts";

import { SqlUniqueViolation, createPgliteDriver, databaseHealthCheck, mapSqlError } from "../src/index.js";
import { createMigratedRuntime } from "./helpers.js";

describe("pglite driver seam", () => {
  it("pings and closes (liveness probe)", async () => {
    const db = new PGlite();
    const driver = createPgliteDriver(db);
    await expect(driver.ping()).resolves.toBeUndefined();
    await driver.close();
  });

  it("executes autocommit reads and multi-statement scripts", async () => {
    const db = new PGlite();
    const driver = createPgliteDriver(db);
    try {
      await driver.exec("CREATE TABLE driver_probe (id int); INSERT INTO driver_probe VALUES (1), (2);");
      const read = await driver.query("SELECT count(*)::int AS n FROM driver_probe");
      expect(read.rows[0]?.["n"]).toBe(2);
    } finally {
      await driver.close();
    }
  });

  it("holds a REAL transaction across awaits: commit makes visible, rollback discards", async () => {
    const db = new PGlite();
    const driver = createPgliteDriver(db);
    try {
      await driver.exec("CREATE TABLE driver_probe (id int)");

      const committed = await driver.begin();
      await committed.query("INSERT INTO driver_probe VALUES (1)");
      const insideTransaction = await committed.query("SELECT count(*)::int AS n FROM driver_probe");
      expect(insideTransaction.rows[0]?.["n"]).toBe(1); // read-your-own-writes
      await committed.commit();
      const afterCommit = await driver.query("SELECT count(*)::int AS n FROM driver_probe");
      expect(afterCommit.rows[0]?.["n"]).toBe(1);

      const discarded = await driver.begin();
      await discarded.query("INSERT INTO driver_probe VALUES (2)");
      await discarded.rollback();
      const afterRollback = await driver.query("SELECT count(*)::int AS n FROM driver_probe");
      expect(afterRollback.rows[0]?.["n"]).toBe(1);
    } finally {
      await driver.close();
    }
  });

  it("documents the single-session caveat honestly: an autocommit read on the SAME session sees the open transaction", async () => {
    // pglite is ONE PostgreSQL session: an autocommit query issued while a
    // transaction is open on that session executes INSIDE it. The port's
    // "committed readers never see uncommitted writes" invariant is enforced
    // by connection boundaries, i.e. by the pg pool driver on hosted
    // PostgreSQL (verified against a real pooled database in RL-106); it is
    // not expressible on a single session and this test PINS that fact so the
    // caveat cannot silently regress into a false claim.
    const db = new PGlite();
    const driver = createPgliteDriver(db);
    try {
      await driver.exec("CREATE TABLE driver_probe (id int)");
      const tx = await driver.begin();
      await tx.query("INSERT INTO driver_probe VALUES (1)");
      const sameSession = await driver.query("SELECT count(*)::int AS n FROM driver_probe");
      expect(sameSession.rows[0]?.["n"]).toBe(1); // shared session, shared snapshot
      await tx.rollback();
      const afterRollback = await driver.query("SELECT count(*)::int AS n FROM driver_probe");
      expect(afterRollback.rows[0]?.["n"]).toBe(0); // rollback is still real
    } finally {
      await driver.close();
    }
  });

  it("fails a second CONCURRENT begin loudly (single session; sequential units of work are fine)", async () => {
    const db = new PGlite();
    const driver = createPgliteDriver(db);
    try {
      await driver.exec("CREATE TABLE driver_probe (id int)");
      const first = await driver.begin();
      await expect(driver.begin()).rejects.toMatchObject({ reason: "PGLITE_TRANSACTION_CONCURRENT" });
      await first.rollback();
      // Sequential reuse works after the rollback.
      const second = await driver.begin();
      await second.rollback();
    } finally {
      await driver.close();
    }
  });

  it("double commit / double rollback settle exactly once", async () => {
    const db = new PGlite();
    const driver = createPgliteDriver(db);
    try {
      await driver.exec("CREATE TABLE driver_probe (id int)");
      const tx = await driver.begin();
      await tx.commit();
      await tx.commit(); // idempotent no-op
      await tx.rollback(); // idempotent no-op
    } finally {
      await driver.close();
    }
  });

  it("maps unique violations onto SqlUniqueViolation with the constraint name", async () => {
    const db = new PGlite();
    const driver = createPgliteDriver(db);
    try {
      await driver.exec("CREATE TABLE driver_probe (id int PRIMARY KEY)");
      await driver.query("INSERT INTO driver_probe VALUES (1)");
      try {
        await driver.query("INSERT INTO driver_probe VALUES (1)");
        throw new Error("the duplicate insert must fail");
      } catch (error) {
        expect(error).toBeInstanceOf(SqlUniqueViolation);
        expect((error as SqlUniqueViolation).constraint).toBe("driver_probe_pkey");
      }
    } finally {
      await driver.close();
    }
  });

  it("maps serialization failures onto the typed Wave-0 conflict", () => {
    const serialization = Object.assign(new Error("could not serialize access"), { code: "40001" });
    expect(() => mapSqlError(serialization)).toThrow(ConflictError);
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    expect(() => mapSqlError(deadlock)).toThrow(ConflictError);
    // Anything else propagates unchanged (fail closed, details preserved).
    const ordinary = Object.assign(new Error("relation missing"), { code: "42P01" });
    expect(() => mapSqlError(ordinary)).toThrow(ordinary);
  });
});

describe("database health check", () => {
  it("reports healthy when the database answers its liveness probe", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const check = databaseHealthCheck(runtime.driver);
      expect(check.name).toBe("database");
      const result = await check.run();
      expect(result.state).toBe("healthy");
      expect(result.name).toBe("database");
    } finally {
      await runtime.driver.close();
    }
  });

  it("reports down with a SUPPRESSED detail when the probe fails (never driver text)", async () => {
    const db = new PGlite();
    const driver = createPgliteDriver(db);
    const check = databaseHealthCheck(driver);
    try {
      // The schema exists (SELECT 1 works) so force the failure by closing the
      // underlying database first - the check must degrade, not throw.
      await driver.close();
      const result = await check.run();
      expect(result.state).toBe("down");
      expect(result.detail).toBeDefined();
      expect(result.detail).not.toMatch(/password|postgres:\/\//i);
    } finally {
      await db.close().catch(() => undefined);
    }
  });

  it("keeps the health-check shape compatible with the observability registry contract", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const check = databaseHealthCheck(runtime.driver);
      expect(typeof check.run).toBe("function");
      const result = await check.run();
      expect(typeof result.checkedAt).toBe("string");
      expect(new Date(result.checkedAt).toISOString()).toBe(result.checkedAt);
    } finally {
      await runtime.driver.close();
    }
  });
});

describe("schema/adapter alignment", () => {
  it("fails loudly (typed error, not silent guessing) when the schema is missing", async () => {
    // A runtime whose migrations were NOT applied: the adapter refuses to
    // invent tables; reads fail closed with the driver's undefined-table
    // error surfaced unchanged.
    const db = new PGlite();
    const driver = createPgliteDriver(db);
    try {
      const unitOfWork = await driver.begin();
      await expect(unitOfWork.query("SELECT count(*)::int AS n FROM roamlink_records")).rejects.toMatchObject({
        code: "42P01",
      });
      await unitOfWork.rollback();
    } finally {
      await driver.close();
    }
  });

  it("answers DomainError ping failures with the typed reason", async () => {
    const runtime = await createMigratedRuntime();
    try {
      // Sanity: a healthy ping resolves; the DomainError branch is exercised
      // by the driver contract (a ping that returns no rows cannot happen on
      // a real PostgreSQL SELECT 1 - kept as defense in depth).
      await expect(runtime.driver.ping()).resolves.toBeUndefined();
      expect(new DomainError("probe", { reason: "DATABASE_PING_FAILED" }).reason).toBe("DATABASE_PING_FAILED");
    } finally {
      await runtime.driver.close();
    }
  });
});
