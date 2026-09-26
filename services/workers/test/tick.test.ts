/**
 * PA-025 — the bounded single-tick worker composition over the REAL
 * persistence (pglite + the real infra/migrations): the sweep-before-claim
 * discipline, the capped claim batch (honest partial progress), the
 * max-duration guard's stop-after-the-current-item law, the closed outcome
 * vocabulary with outcome errors counted never hidden, the optional
 * inbox/reconciliation legs, and the fail-closed env binding.
 */
import { describe, expect, it } from "vitest";
import type { OutboxRecord } from "@roamlink/persistence";
import { ConflictError } from "@roamlink/contracts";
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

import { createBoundedWorkerTick, WorkerCompositionError, type OutboxDeliveryPort } from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));
const T0 = "2026-10-01T00:00:00.000Z";
const T_LATE = "2026-10-01T00:10:00.000Z";

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
function scriptedPort(
  script: (record: OutboxRecord, index: number) => Promise<"delivered" | "retryable" | "permanent" | { readonly invalidReason: true }>,
  hooks?: { readonly onDelivery?: () => void },
): {
  readonly port: OutboxDeliveryPort;
  readonly delivered: OutboxRecord[];
} {
  const delivered: OutboxRecord[] = [];
  let index = 0;
  return {
    delivered,
    port: {
      async deliver(record) {
        hooks?.onDelivery?.();
        const outcome = await script(record, index);
        index += 1;
        if (outcome === "delivered") {
          delivered.push(record);
          return { outcome: "DELIVERED" };
        }
        if (outcome === "retryable") return { outcome: "RETRYABLE_FAILURE", reason: "TARGET_UNAVAILABLE" };
        if (outcome === "permanent") return { outcome: "PERMANENT_FAILURE", reason: "TARGET_REJECTED" };
        // A contract-violating reason code: the outcome commit's
        // deliveryReason guard refuses it (the honest outcomeError path).
        return { outcome: "RETRYABLE_FAILURE", reason: "not a reason code" };
      },
    },
  };
}

describe("PA-025 the bounded single-tick composition", () => {
  it("runs the sweep BEFORE the claim and continues a stranded claim without consuming budget", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      await seed.outbox.enqueue({ idempotencyKey: "tick-sweep-1", payload: { a: 1 }, createdAt: T0 });
      await seed.commit();
      // A previous invocation committed its claim and "died" before the outcome.
      const crashed = await runtime.persistence.begin();
      await crashed.outbox.claimDue(T0, 10);
      await crashed.commit();
      expect(await runtime.persistence.outbox.count("DELIVERING")).toBe(1);

      const { port, delivered } = scriptedPort(async () => "delivered");
      const tick = createBoundedWorkerTick(
        { mode: "development", databaseUrl: undefined },
        { persistence: runtime.persistence, delivery: port, now: () => runtime.clock.now() },
      );
      const report = await tick.execute();

      expect(report.sweep.recovered).toBe(1); // the stranded claim re-owned first
      expect(report.outbox.claimed).toBe(1);
      expect(report.outbox.executed).toBe(1);
      expect(report.outbox.delivered).toBe(1);
      expect(delivered.length).toBe(1);
      expect((await runtime.persistence.outbox.get("tick-sweep-1"))?.deliveryState).toBe("DELIVERED");
      expect((await runtime.persistence.outbox.get("tick-sweep-1"))?.retryCount).toBe(0); // budget untouched
      expect(report.outbox.remainingPending).toBe(0);
      // The honest skips: no inbox/reconciliation seam composed in this tick.
      expect(report.inbox).toMatchObject({ drained: false });
      expect(report.reconciliation).toMatchObject({ ran: false });
    } finally {
      await runtime.driver.close();
    }
  });

  it("advances EXACTLY the capped batch: a backlog larger than the cap leaves the remainder PENDING (honest partial progress)", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      for (const key of ["tick-cap-1", "tick-cap-2", "tick-cap-3", "tick-cap-4", "tick-cap-5"]) {
        await seed.outbox.enqueue({ idempotencyKey: key, payload: { key }, createdAt: T0 });
      }
      await seed.commit();

      const { port, delivered } = scriptedPort(async () => "delivered");
      const tick = createBoundedWorkerTick(
        { mode: "development", databaseUrl: undefined, outboxBatchSize: 2 },
        { persistence: runtime.persistence, delivery: port, now: () => runtime.clock.now() },
      );

      const first = await tick.execute();
      expect(first.outbox.claimed).toBe(2);
      expect(first.outbox.delivered).toBe(2);
      expect(first.outbox.remainingPending).toBe(3); // the honest backlog

      const second = await tick.execute();
      expect(second.outbox.claimed).toBe(2);
      expect(second.outbox.remainingPending).toBe(1);

      const third = await tick.execute();
      expect(third.outbox.claimed).toBe(1);
      expect(third.outbox.remainingPending).toBe(0);

      // A further tick claims nothing (idempotent re-invocation advances nothing).
      const fourth = await tick.execute();
      expect(fourth.outbox.claimed).toBe(0);
      expect(fourth.outbox.delivered).toBe(0);
      expect(delivered.length).toBe(5);
      expect(await runtime.persistence.outbox.count("DELIVERED")).toBe(5);
    } finally {
      await runtime.driver.close();
    }
  });

  it("the max-duration guard stops AFTER the current item; the un-attempted remainder is re-owned by the NEXT tick's sweep and completes", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      for (const key of ["tick-dl-1", "tick-dl-2", "tick-dl-3"]) {
        await seed.outbox.enqueue({ idempotencyKey: key, payload: { key }, createdAt: T0 });
      }
      await seed.commit();

      // The port advances the deterministic clock PAST the guard on every
      // delivery: item 1 completes, item 2's pre-attempt check stops the batch.
      const slowPort: OutboxDeliveryPort = {
        async deliver() {
          runtime.clock.advanceTo(T_LATE);
          return { outcome: "DELIVERED" };
        },
      };
      const tick = createBoundedWorkerTick(
        { mode: "development", databaseUrl: undefined, outboxBatchSize: 3, maxDurationMs: 5_000 },
        { persistence: runtime.persistence, delivery: slowPort, now: () => runtime.clock.now() },
      );
      const partial = await tick.execute();
      expect(partial.outbox.claimed).toBe(3);
      expect(partial.outbox.executed).toBe(1); // the current item finished
      expect(partial.outbox.delivered).toBe(1);
      expect(partial.outbox.deadlineAbandoned).toBe(2); // the un-attempted remainder
      expect(await runtime.persistence.outbox.count("DELIVERING")).toBe(2); // stranded, not lost
      expect(await runtime.persistence.outbox.count("PENDING")).toBe(0);

      // The NEXT scheduled delivery continues: the sweep re-owns the stranded
      // claims (budget untouched) and the batch completes.
      const { port, delivered } = scriptedPort(async () => "delivered");
      const continuing = createBoundedWorkerTick(
        { mode: "development", databaseUrl: undefined, outboxBatchSize: 3, maxDurationMs: 5_000 },
        { persistence: runtime.persistence, delivery: port, now: () => runtime.clock.now() },
      );
      const next = await continuing.execute();
      expect(next.sweep.recovered).toBe(2);
      expect(next.outbox.claimed).toBe(2);
      expect(next.outbox.delivered).toBe(2);
      expect(delivered.length).toBe(2);
      expect(await runtime.persistence.outbox.count("DELIVERED")).toBe(3);
    } finally {
      await runtime.driver.close();
    }
  });

  it("commits the closed outcome vocabulary: retryable failures reschedule with backoff, terminal failures land diagnosable", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      await seed.outbox.enqueue({
        idempotencyKey: "tick-retry-1",
        payload: { a: 1 },
        createdAt: T0,
        retryPolicy: { maxAttempts: 1, backoffScheduleMs: [5_000] },
      });
      await seed.outbox.enqueue({
        idempotencyKey: "tick-perm-1",
        payload: { b: 2 },
        createdAt: T0,
        retryPolicy: { maxAttempts: 1, backoffScheduleMs: [5_000] },
      });
      await seed.commit();

      const { port } = scriptedPort(async (record) =>
        record.idempotencyKey === "tick-retry-1" ? "retryable" : "permanent",
      );
      const tick = createBoundedWorkerTick(
        { mode: "development", databaseUrl: undefined },
        { persistence: runtime.persistence, delivery: port, now: () => runtime.clock.now() },
      );
      const report = await tick.execute();
      expect(report.outbox.retryableFailures).toBe(1);
      expect(report.outbox.permanentFailures).toBe(1);
      expect((await runtime.persistence.outbox.get("tick-retry-1"))?.deliveryState).toBe("FAILED"); // budget exhausted -> terminal
      expect((await runtime.persistence.outbox.get("tick-retry-1"))?.lastErrorReason).toBe("TARGET_UNAVAILABLE");
      expect((await runtime.persistence.outbox.get("tick-perm-1"))?.deliveryState).toBe("FAILED");
      expect((await runtime.persistence.outbox.get("tick-perm-1"))?.lastErrorReason).toBe("TARGET_REJECTED");
      expect(report.outbox.remainingPending).toBe(0);
    } finally {
      await runtime.driver.close();
    }
  });

  it("counts outcome-commit failures honestly (the claim stays owned; the next sweep re-owns it)", async () => {
    const runtime = await createRuntime();
    try {
      const seed = await runtime.persistence.begin();
      await seed.outbox.enqueue({ idempotencyKey: "tick-oerr-1", payload: { a: 1 }, createdAt: T0 });
      await seed.commit();

      // A contract-violating reason code: the outcome commit's deliveryReason
      // guard refuses it inside the outcome unit of work -> outcomeError.
      const { port } = scriptedPort(async () => ({ invalidReason: true }));
      const tick = createBoundedWorkerTick(
        { mode: "development", databaseUrl: undefined },
        { persistence: runtime.persistence, delivery: port, now: () => runtime.clock.now() },
      );
      const report = await tick.execute();
      expect(report.outbox.outcomeErrors).toBe(1);
      expect(report.outbox.delivered).toBe(0);
      expect(await runtime.persistence.outbox.count("DELIVERING")).toBe(1); // stranded, never lost

      // The next tick's sweep re-owns it and a healthy port completes it.
      const { port: healthy } = scriptedPort(async () => "delivered");
      const next = createBoundedWorkerTick(
        { mode: "development", databaseUrl: undefined },
        { persistence: runtime.persistence, delivery: healthy, now: () => runtime.clock.now() },
      );
      const followUp = await next.execute();
      expect(followUp.sweep.recovered).toBe(1);
      expect(followUp.outbox.delivered).toBe(1);
      expect((await runtime.persistence.outbox.get("tick-oerr-1"))?.retryCount).toBe(0); // sweep consumes no budget
    } finally {
      await runtime.driver.close();
    }
  });

  it("drains ONE bounded inbox batch when the source is composed, and reports the honest skip otherwise", async () => {
    const runtime = await createRuntime();
    try {
      const calls: number[] = [];
      const inbox = {
        async processPending(limit?: number) {
          calls.push(limit ?? -1);
          return {
            considered: 3,
            applied: 2,
            failed: 1,
            conflicts: 0,
            alreadyProjected: 0,
            skipped: 0,
          } as const;
        },
      };
      let reconciled = 0;
      const tick = createBoundedWorkerTick(
        { mode: "development", databaseUrl: undefined, inboxBatchLimit: 25 },
        {
          persistence: runtime.persistence,
          delivery: scriptedPort(async () => "delivered").port,
          now: () => runtime.clock.now(),
          inbox,
          reconcile: async () => {
            reconciled += 1;
          },
        },
      );
      const report = await tick.execute();
      expect(calls).toEqual([25]); // exactly ONE bounded batch
      expect(report.inbox).toEqual({ drained: true, applied: 2, failed: 1, conflicts: 0 });
      expect(report.reconciliation).toEqual({ ran: true, outcome: "completed" });
      expect(reconciled).toBe(1);

      // Without the seams: the honest skips, never a silent claim of work.
      const bare = createBoundedWorkerTick(
        { mode: "development", databaseUrl: undefined },
        {
          persistence: runtime.persistence,
          delivery: scriptedPort(async () => "delivered").port,
          now: () => runtime.clock.now(),
        },
      );
      const bareReport = await bare.execute();
      expect(bareReport.inbox).toEqual({
        drained: false,
        reason: "no webhook inbox with a composed projector is bound in this tick",
      });
      expect(bareReport.reconciliation).toEqual({
        ran: false,
        reason: "no reconciliation tick is composed in this tick",
      });
      // A FAILING reconcile seam is reported honestly, never thrown past the tick.
      const failing = createBoundedWorkerTick(
        { mode: "development", databaseUrl: undefined },
        {
          persistence: runtime.persistence,
          delivery: scriptedPort(async () => "delivered").port,
          now: () => runtime.clock.now(),
          reconcile: async () => {
            throw new ConflictError("simulated reconciliation failure");
          },
        },
      );
      const failingReport = await failing.execute();
      expect(failingReport.reconciliation).toEqual({ ran: true, outcome: "failed", reason: "RoamLinkConflictError" });
    } finally {
      await runtime.driver.close();
    }
  });

  it("refuses fail-closed when no persistence seam is bound and DATABASE_URL is absent (never a fake)", async () => {
    const tick = createBoundedWorkerTick(
      { mode: "development", databaseUrl: undefined },
      { delivery: scriptedPort(async () => "delivered").port },
    );
    await expect(tick.execute()).rejects.toThrow(WorkerCompositionError);
    await tick.dispose(); // disposing an unresolved tick is a no-op
  });

  it("rejects non-positive batch/duration bounds at composition time (fail-closed, never a silent default)", () => {
    const persistence = undefined;
    const delivery = scriptedPort(async () => "delivered").port;
    expect(() =>
      createBoundedWorkerTick(
        { mode: "development", databaseUrl: undefined, outboxBatchSize: 0 },
        { delivery },
      ),
    ).toThrow(/outboxBatchSize/);
    expect(() =>
      createBoundedWorkerTick({ mode: "development", databaseUrl: undefined, maxDurationMs: 0 }, { delivery }),
    ).toThrow(/maxDurationMs/);
    void persistence;
  });
});
