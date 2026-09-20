/**
 * RL-107 — the outbox drain loop over the REAL persistence (pglite with the
 * real infra/migrations): the startup sweep before the first claim, bounded
 * batches, terminal-state handling, graceful stop and the crash/restart
 * re-own discipline.
 */
import { describe, expect, it } from "vitest";
import type { OutboxRecord } from "@roamlink/persistence";
import { createInMemoryLogSink, makeStructuredLogRecord, type LeveledLogger, type LogFieldValue } from "@roamlink/observability";
import { DeterministicClock } from "@roamlink/testkit";
import {
  createPgliteDriver,
  createPostgresMigrationRunner,
  createPostgresPersistence,
  setMigrationFileAccess,
  setMigrationPathResolver,
} from "@roamlink/persistence-postgres";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createOutboxDrain, commandLedgerDeliveryPort, ManualWorkerTimer, type OutboxDeliveryPort } from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));

const T0 = "2026-10-01T00:00:00.000Z";

async function createRuntime() {
  setMigrationFileAccess({
    listDir: (dir) => readdirSync(dir),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
  setMigrationPathResolver(() => join(REPO_ROOT, "infra", "migrations"));
  const db = new (await import("@electric-sql/pglite")).PGlite();
  const driver = createPgliteDriver(db);
  await createPostgresMigrationRunner({ driver }).migrateUp();
  const persistence = createPostgresPersistence(driver);
  const clock = new DeterministicClock(T0);
  return { driver, persistence, clock };
}

/** A delivery port that records deliveries and answers a scripted outcome. */
function scriptedPort(script: (record: OutboxRecord, index: number) => Promise<"delivered" | "retryable" | "permanent">): {
  readonly port: OutboxDeliveryPort;
  readonly delivered: OutboxRecord[];
} {
  const delivered: OutboxRecord[] = [];
  let index = 0;
  return {
    delivered,
    port: {
      async deliver(record) {
        const outcome = await script(record, index);
        index += 1;
        if (outcome === "delivered") {
          delivered.push(record);
          return { outcome: "DELIVERED" };
        }
        if (outcome === "retryable") return { outcome: "RETRYABLE_FAILURE", reason: "TARGET_UNAVAILABLE" };
        return { outcome: "PERMANENT_FAILURE", reason: "TARGET_REJECTED" };
      },
    },
  };
}

/** A minimal structural LeveledLogger over an in-memory sink. */
function testLogger(): ReturnType<typeof createInMemoryLogSink> & { logger: LeveledLogger } {
  const sink = createInMemoryLogSink();
  const emit = (level: "info" | "warn" | "error" | "fatal", message: string, fields?: Record<string, LogFieldValue>) => {
    try {
      sink.sink(makeStructuredLogRecord({ level, message, at: T0, ...(fields !== undefined ? { fields } : {}) }));
    } catch {
      // logging never breaks the loop under test
    }
  };
  const logger: LeveledLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    fatal: (message, fields) => emit("fatal", message, fields),
  };
  return { ...sink, logger };
}

describe("RL-107 the outbox drain loop", () => {
  it("runs the startup sweep BEFORE the first claim and re-owns stranded claims without consuming budget", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      await seed.outbox.enqueue({ idempotencyKey: "wk-sweep-1", payload: { a: 1 }, createdAt: T0 });
      await seed.commit();
      // The previous process committed its claim and "crashed" before the outcome.
      const crashedClaim = await runtime.persistence.begin();
      const claimed = await crashedClaim.outbox.claimDue(T0, 10);
      expect(claimed.length).toBe(1);
      await crashedClaim.commit();
      expect(await runtime.persistence.outbox.count("DELIVERING")).toBe(1);

      const { port, delivered } = scriptedPort(async () => "delivered");
      const drain = createOutboxDrain({
        persistence: runtime.persistence,
        delivery: port,
        now: () => runtime.clock.now(),
        timer: new ManualWorkerTimer(),
      });
      drain.start();
      await drain.whenStartupSettled();
      await drain.tickOnce();

      expect(drain.snapshot().recoveredOnStart).toBe(1); // the stranded claim was re-owned
      expect(delivered.length).toBe(1); // the obligation CONTINUED (at-least-once)
      expect((await runtime.persistence.outbox.get("wk-sweep-1"))?.deliveryState).toBe("DELIVERED");
      expect((await runtime.persistence.outbox.get("wk-sweep-1"))?.retryCount).toBe(0); // budget untouched
    } finally {
      await runtime.driver.close();
    }
  });

  it("drains bounded batches with terminal outcomes and stops when the queue is empty", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      for (const key of ["wk-batch-1", "wk-batch-2", "wk-batch-3"]) {
        await seed.outbox.enqueue({ idempotencyKey: key, payload: { key }, createdAt: T0 });
      }
      await seed.commit();

      const { port, delivered } = scriptedPort(async () => "delivered");
      const drain = createOutboxDrain({
        persistence: runtime.persistence,
        delivery: port,
        now: () => runtime.clock.now(),
        timer: new ManualWorkerTimer(),
        batchSize: 2,
      });
      const first = await drain.tickOnce();
      expect(first.claimed).toBe(2);
      expect(first.delivered).toBe(2);
      const second = await drain.tickOnce();
      expect(second.claimed).toBe(1);
      const third = await drain.tickOnce();
      expect(third.claimed).toBe(0);
      expect(delivered.length).toBe(3);
      expect(await runtime.persistence.outbox.count("DELIVERED")).toBe(3);
      expect(drain.snapshot()).toMatchObject({ ticks: 3, delivered: 3 });
    } finally {
      await runtime.driver.close();
    }
  });

  it("reschedules retryable failures with backoff and lands the budget-exhausted terminal FAILED", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      await seed.outbox.enqueue({
        idempotencyKey: "wk-retry-1",
        payload: { a: 1 },
        createdAt: T0,
        retryPolicy: { maxAttempts: 2, backoffScheduleMs: [5_000] },
      });
      await seed.commit();

      const { port } = scriptedPort(async () => "retryable");
      const drain = createOutboxDrain({
        persistence: runtime.persistence,
        delivery: port,
        now: () => runtime.clock.now(),
        timer: new ManualWorkerTimer(),
      });
      await drain.tickOnce();
      const afterFirst = await runtime.persistence.outbox.get("wk-retry-1");
      expect(afterFirst?.deliveryState).toBe("PENDING"); // rescheduled, not terminal
      expect(afterFirst?.retryCount).toBe(1);
      expect(afterFirst?.nextAttemptAt).toBe("2026-10-01T00:00:05.000Z"); // at + backoff

      // Before the backoff elapses the record is NOT due.
      const notDue = await runtime.persistence.begin();
      expect(await notDue.outbox.claimDue("2026-10-01T00:00:04.999Z", 10)).toEqual([]);
      await notDue.rollback();

      runtime.clock.advanceTo("2026-10-01T00:00:05.000Z");
      await drain.tickOnce();
      const afterSecond = await runtime.persistence.outbox.get("wk-retry-1");
      expect(afterSecond?.deliveryState).toBe("FAILED"); // budget exhausted, terminal
      expect(afterSecond?.lastErrorReason).toBe("TARGET_UNAVAILABLE");
      // Terminal states are never resurrected by the drain (or anything else).
      runtime.clock.advanceTo("2026-10-01T00:00:10.000Z");
      const third = await drain.tickOnce();
      expect(third.claimed).toBe(0);
    } finally {
      await runtime.driver.close();
    }
  });

  it("abandoned mid-batch claims (the crash simulation) re-own on restart and complete", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      for (const key of ["wk-stop-1", "wk-stop-2"]) {
        await seed.outbox.enqueue({ idempotencyKey: key, payload: { key }, createdAt: T0 });
      }
      await seed.commit();

      // A port that HANGS: the claim committed, the delivery attempt never
      // returns - the "process died mid-batch" simulation.
      let hangingStarted = false;
      const drainA = createOutboxDrain({
        persistence: runtime.persistence,
        delivery: {
          async deliver() {
            hangingStarted = true;
            return new Promise<never>(() => undefined); // never resolves
          },
        },
        now: () => runtime.clock.now(),
        timer: new ManualWorkerTimer(),
        batchSize: 10,
      });
      const tickPromise = drainA.tickOnce().catch(() => "abandoned" as const);
      for (let i = 0; i < 200 && (await runtime.persistence.outbox.count("DELIVERING")) < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(hangingStarted).toBe(true);
      expect(await runtime.persistence.outbox.count("DELIVERING")).toBe(2); // claims committed
      expect(await Promise.race([tickPromise.then(() => "settled"), Promise.resolve("in-flight")])).toBe("in-flight");

      // The RESTART: a fresh drain sweeps BEFORE its first claim...
      const logs = testLogger();
      const { port, delivered } = scriptedPort(async () => "delivered");
      const drainB = createOutboxDrain({
        persistence: runtime.persistence,
        delivery: port,
        now: () => runtime.clock.now(),
        timer: new ManualWorkerTimer(),
        logger: logs.logger,
      });
      drainB.start();
      await drainB.whenStartupSettled();
      expect(drainB.snapshot().recoveredOnStart).toBe(2); // both abandoned claims re-owned
      expect(await runtime.persistence.outbox.count("DELIVERING")).toBe(0); // swept back to PENDING first
      await drainB.tickOnce();
      expect(await runtime.persistence.outbox.count("DELIVERED")).toBe(2); // obligations completed
      expect(delivered.length).toBe(2);
      const startupLog = logs.records().find((record) => record.message === "outbox_startup_sweep");
      expect(startupLog?.fields["recovered"]).toBe(2); // every tick observable
    } finally {
      await runtime.driver.close();
    }
  });

  it("the command-ledger delivery port executes obligations and records the executed stage", async () => {
    const runtime = await createRuntime();
    try {
      const command = {
        commandId: "cmd-wk-1",
        requestId: "req-wk-1",
        correlationId: "corr-wk-1",
        idempotencyKey: "wk-cmd-1",
        kind: "device.enroll",
        route: "/v1/devices",
        tenantId: "usr:00000000-0000-4000-8000-00000000000a",
        actorId: "usr:00000000-0000-4000-8000-00000000000a",
        expectedVersion: null,
        payloadDigest: "digest",
        payload: { deviceId: "dev-1" },
        acceptedAt: T0,
        executedAt: null,
        deliveredAt: null,
        billableFinalAt: null,
        resource: null,
      };
      const seed = await runtime.persistence.begin();
      await seed.records("api-commands").insert("cmd-wk-1", command as never);
      await seed.outbox.enqueue({
        idempotencyKey: "wk-cmd-1",
        payload: { commandId: "cmd-wk-1", kind: "device.enroll", tenantId: command.tenantId, actorId: command.actorId, payload: command.payload },
        createdAt: T0,
      });
      await seed.commit();

      const executed: string[] = [];
      const port = commandLedgerDeliveryPort({
        executors: {
          "device.enroll": async (_record, payload) => {
            executed.push(payload.commandId);
          },
        },
        ledger: {
          markExecuted: async (commandId, at) => {
            const unitOfWork = await runtime.persistence.begin();
            try {
              const stored = await unitOfWork.records("api-commands").get(commandId);
              if (stored === null) throw new Error("command missing");
              const value = stored.value as typeof command;
              if (value.executedAt !== null) {
                await unitOfWork.rollback();
                return;
              }
              await unitOfWork
                .records("api-commands")
                .compareAndSwap(commandId, stored.version, { ...value, executedAt: at } as never);
              await unitOfWork.commit();
            } catch (error) {
              await unitOfWork.rollback();
              throw error;
            }
          },
        },
        now: () => runtime.clock.now(),
      });
      const drain = createOutboxDrain({
        persistence: runtime.persistence,
        delivery: port,
        now: () => runtime.clock.now(),
        timer: new ManualWorkerTimer(),
      });
      const report = await drain.tickOnce();
      expect(report.delivered).toBe(1);
      expect(executed).toEqual(["cmd-wk-1"]);
      const stored = await runtime.persistence.records("api-commands").get("cmd-wk-1");
      expect(((stored?.value as typeof command) ?? {}).executedAt).toBe(T0); // the stage truth advanced
    } finally {
      await runtime.driver.close();
    }
  });

  it("a kind without a composed executor is an honest retryable failure with the diagnosable reason", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      await seed.outbox.enqueue({
        idempotencyKey: "wk-noexec-1",
        payload: { commandId: "cmd-x", kind: "order.place", tenantId: "t", actorId: "a", payload: {} },
        createdAt: T0,
      });
      await seed.commit();
      const port = commandLedgerDeliveryPort({
        executors: {},
        ledger: { markExecuted: async () => undefined },
        now: () => runtime.clock.now(),
      });
      const drain = createOutboxDrain({
        persistence: runtime.persistence,
        delivery: port,
        now: () => runtime.clock.now(),
        timer: new ManualWorkerTimer(),
      });
      const report = await drain.tickOnce();
      expect(report.retryableFailures).toBe(1);
      const record = await runtime.persistence.outbox.get("wk-noexec-1");
      expect(record?.lastErrorReason).toBe("COMMAND_EXECUTOR_NOT_COMPOSED");
      expect(record?.deliveryState).toBe("PENDING"); // retried, budget intact so far
    } finally {
      await runtime.driver.close();
    }
  });
});
