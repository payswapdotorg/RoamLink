/**
 * RL-091: the durable outbox against real PostgreSQL (pglite) - transactional
 * outbox by construction (business write + enqueue commit or roll back as one
 * database transaction), idempotency-key dedupe, the closed delivery state
 * machine and deterministic due-claiming.
 */
import { describe, expect, it } from "vitest";
import { DomainError, ValidationError, sha256Hex } from "@roamlink/contracts";

import { createMigratedRuntime, drainOutboxDelivered, nextKey, T0, T1, T2 } from "./helpers.js";

describe("durable outbox (Postgres adapter)", () => {
  it("enqueues with a deterministic canonical payload + digest", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const key = nextKey("cmd");
      const enqueued = await unitOfWork.outbox.enqueue({
        idempotencyKey: key,
        payload: { b: 2, a: 1 },
        createdAt: T0,
      });
      expect(enqueued.outcome).toBe("ENQUEUED");
      expect(enqueued.record.deliveryState).toBe("PENDING");
      expect(enqueued.record.payloadDigest).toBe(sha256Hex('{"a":1,"b":2}'));
      expect(new TextDecoder().decode(enqueued.record.payloadBytes)).toBe('{"a":1,"b":2}');
      expect(enqueued.record.nextAttemptAt).toBe(T0); // due immediately
      await unitOfWork.commit();
    } finally {
      await runtime.driver.close();
    }
  });

  it("replays ALREADY_ENQUEUED for the same key + digest (no second record)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const key = nextKey("cmd");
      const first = await unitOfWork.outbox.enqueue({
        idempotencyKey: key,
        payload: { a: 1 },
        createdAt: T0,
      });
      const replay = await unitOfWork.outbox.enqueue({
        idempotencyKey: key,
        payload: { a: 1 },
        createdAt: T1, // even with a different timestamp
      });
      expect(replay.outcome).toBe("ALREADY_ENQUEUED");
      expect(replay.record.createdAt).toBe(first.record.createdAt);
      expect(await unitOfWork.outbox.count()).toBe(1);
      await unitOfWork.commit();
      expect(await runtime.persistence.outbox.count()).toBe(1);
    } finally {
      await runtime.driver.close();
    }
  });

  it("rejects the same key with a DIFFERENT payload digest (never a silent overwrite)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const key = nextKey("cmd");
      await unitOfWork.outbox.enqueue({ idempotencyKey: key, payload: { a: 1 }, createdAt: T0 });
      await expect(
        unitOfWork.outbox.enqueue({ idempotencyKey: key, payload: { a: 2 }, createdAt: T1 }),
      ).rejects.toMatchObject({ reason: "OUTBOX_IDEMPOTENCY_CONFLICT" });
      await unitOfWork.rollback();
      expect(await runtime.persistence.outbox.count()).toBe(0);
    } finally {
      await runtime.driver.close();
    }
  });

  it("commits business write + enqueue atomically (transactional outbox by construction)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      // Committed together: both visible.
      const committed = await runtime.persistence.begin();
      await committed.records("orders").insert(nextKey("order"), { status: "placed" });
      await committed.outbox.enqueue({ idempotencyKey: nextKey("cmd"), payload: { x: 1 }, createdAt: T0 });
      await committed.commit();
      expect(await runtime.persistence.records("orders").count()).toBe(1);
      expect(await runtime.persistence.outbox.count()).toBe(1);

      // Rolled back together: neither exists.
      const discarded = await runtime.persistence.begin();
      await discarded.records("orders").insert(nextKey("order"), { status: "placed" });
      await discarded.outbox.enqueue({ idempotencyKey: nextKey("cmd"), payload: { x: 1 }, createdAt: T0 });
      await discarded.rollback();
      expect(await runtime.persistence.records("orders").count()).toBe(1);
      expect(await runtime.persistence.outbox.count()).toBe(1);
    } finally {
      await runtime.driver.close();
    }
  });

  it("claims due PENDING records in deterministic order and moves them to DELIVERING", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      for (const [key, at] of [
        [nextKey("cmd"), T0],
        [nextKey("cmd"), T1],
      ] as const) {
        await unitOfWork.outbox.enqueue({ idempotencyKey: key, payload: { at }, createdAt: at });
      }
      // A future-dated record is NOT due at T2.
      await unitOfWork.outbox.enqueue({
        idempotencyKey: nextKey("cmd"),
        payload: { future: true },
        createdAt: "2026-10-01T00:10:00.000Z",
      });
      const futureRecord = (await unitOfWork.outbox.list("PENDING")).find(
        (record) => record.createdAt === "2026-10-01T00:10:00.000Z",
      );
      if (futureRecord === undefined) throw new Error("future record missing");
      await unitOfWork.commit();

      const claimUnitOfWork = await runtime.persistence.begin();
      const claimed = await claimUnitOfWork.outbox.claimDue(T2, 10);
      expect(claimed).toHaveLength(2); // the two due records
      expect(claimed.every((record) => record.deliveryState === "DELIVERING")).toBe(true);
      expect(claimed.map((record) => record.idempotencyKey)).not.toContain(futureRecord.idempotencyKey);
      await claimUnitOfWork.commit();

      // Claiming again at the same instant finds nothing (the future record is
      // still not due at T2, and claiming is not re-entrant on DELIVERING).
      const again = await runtime.persistence.begin();
      const secondClaim = await again.outbox.claimDue(T2, 10);
      expect(secondClaim).toEqual([]);
      await again.rollback();
    } finally {
      await runtime.driver.close();
    }
  });

  it("respects the claim limit and drains the rest later (batch progression)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const setup = await runtime.persistence.begin();
      for (let index = 0; index < 5; index += 1) {
        await setup.outbox.enqueue({
          idempotencyKey: nextKey("cmd"),
          payload: { index },
          createdAt: T0,
        });
      }
      await setup.commit();

      const first = await runtime.persistence.begin();
      const claimedFirst = await first.outbox.claimDue(T1, 2);
      expect(claimedFirst).toHaveLength(2);
      await first.commit();
      // The committed claims stay DELIVERING (recovery of stranded claims is
      // RL-093's visibility-timeout work, deliberately out of scope here);
      // the remaining PENDING backlog still drains in later batches.
      expect(await drainOutboxDelivered(runtime.persistence, T2)).toBe(3);
      expect(await runtime.persistence.outbox.count("PENDING")).toBe(0);
      expect(await runtime.persistence.outbox.count("DELIVERED")).toBe(3);
      expect(await runtime.persistence.outbox.count("DELIVERING")).toBe(2);
    } finally {
      await runtime.driver.close();
    }
  });

  it("moves DELIVERING -> DELIVERED terminally (deliveredAt set, nextAttemptAt null)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const key = nextKey("cmd");
      await unitOfWork.outbox.enqueue({ idempotencyKey: key, payload: { a: 1 }, createdAt: T0 });
      await unitOfWork.outbox.claimDue(T0, 10);
      const delivered = await unitOfWork.outbox.markDelivered(key, T1);
      expect(delivered.deliveryState).toBe("DELIVERED");
      expect(delivered.deliveredAt).toBe(T1);
      expect(delivered.nextAttemptAt).toBeNull();
      await unitOfWork.commit();

      // Terminal: no further claim, and the transition functions reject reuse.
      const terminal = await runtime.persistence.begin();
      expect(await terminal.outbox.claimDue(T2, 10)).toEqual([]);
      await expect(terminal.outbox.markDelivered(key, T2)).rejects.toBeInstanceOf(DomainError);
      await terminal.rollback();
    } finally {
      await runtime.driver.close();
    }
  });

  it("schedules retries with backoff on failure and goes FAILED when the budget is exhausted", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const key = nextKey("cmd");
      await unitOfWork.outbox.enqueue({
        idempotencyKey: key,
        payload: { a: 1 },
        createdAt: T0,
        retryPolicy: { maxAttempts: 2, backoffScheduleMs: [5000] },
      });
      await unitOfWork.outbox.claimDue(T0, 10);
      const failed = await unitOfWork.outbox.markAttemptFailed(key, T0, "DELIVERY_TIMEOUT");
      expect(failed.deliveryState).toBe("PENDING"); // budget remains -> retry
      expect(failed.retryCount).toBe(1);
      expect(failed.nextAttemptAt).toBe("2026-10-01T00:00:05.000Z");
      expect(failed.lastErrorReason).toBe("DELIVERY_TIMEOUT");
      await unitOfWork.commit();

      // Not due until the backoff elapses.
      const early = await runtime.persistence.begin();
      expect(await early.outbox.claimDue("2026-10-01T00:00:04.000Z", 10)).toEqual([]);
      await early.rollback();

      // Second failure exhausts the budget -> terminal FAILED.
      const second = await runtime.persistence.begin();
      await second.outbox.claimDue("2026-10-01T00:00:05.000Z", 10);
      const terminal = await second.outbox.markAttemptFailed(key, "2026-10-01T00:00:05.000Z", "DELIVERY_TIMEOUT");
      expect(terminal.deliveryState).toBe("FAILED");
      expect(terminal.nextAttemptAt).toBeNull();
      await second.commit();

      const after = await runtime.persistence.begin();
      expect(await after.outbox.claimDue("2026-10-01T01:00:00.000Z", 10)).toEqual([]);
      await after.rollback();
    } finally {
      await runtime.driver.close();
    }
  });

  it("rejects an invalid failure reason (UPPER_SNAKE reason codes only)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const key = nextKey("cmd");
      await unitOfWork.outbox.enqueue({ idempotencyKey: key, payload: { a: 1 }, createdAt: T0 });
      await unitOfWork.outbox.claimDue(T0, 10);
      await expect(
        unitOfWork.outbox.markAttemptFailed(key, T0, "some free-form message with values"),
      ).rejects.toBeInstanceOf(ValidationError);
      await unitOfWork.rollback();
    } finally {
      await runtime.driver.close();
    }
  });

  it("rejects an invalid claim limit before any SQL", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      await expect(unitOfWork.outbox.claimDue(T0, 0)).rejects.toMatchObject({
        reason: "OUTBOX_CLAIM_LIMIT_INVALID",
      });
      await unitOfWork.rollback();
    } finally {
      await runtime.driver.close();
    }
  });

  it("discards uncommitted enqueues on rollback (read-your-own-writes inside the unit of work)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const key = nextKey("cmd");
      await unitOfWork.outbox.enqueue({ idempotencyKey: key, payload: { a: 1 }, createdAt: T0 });
      expect(await unitOfWork.outbox.get(key)).not.toBeNull(); // read-your-own-writes
      await unitOfWork.rollback();
      // After the rollback the record is gone (pglite caveat: while the
      // transaction is OPEN, autocommit reads share the same session and see
      // it; the isolation boundary is the pg pool driver's, verified on real
      // pooled PostgreSQL in RL-106).
      expect(await runtime.persistence.outbox.get(key)).toBeNull();
      expect(await runtime.persistence.outbox.count()).toBe(0);
    } finally {
      await runtime.driver.close();
    }
  });

  it("serves ordered, filtered listings from the committed reader", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const setup = await runtime.persistence.begin();
      const keys = [nextKey("cmd"), nextKey("cmd")].sort();
      await setup.outbox.enqueue({ idempotencyKey: keys[0] as string, payload: { i: 0 }, createdAt: T0 });
      await setup.outbox.enqueue({ idempotencyKey: keys[1] as string, payload: { i: 1 }, createdAt: T1 });
      await setup.commit();

      const listed = await runtime.persistence.outbox.list();
      expect(listed.map((record) => record.idempotencyKey)).toEqual(keys);
      const pending = await runtime.persistence.outbox.list("PENDING");
      expect(pending).toHaveLength(2);
      const delivered = await runtime.persistence.outbox.list("DELIVERED");
      expect(delivered).toEqual([]);
      expect(await runtime.persistence.outbox.count("PENDING")).toBe(2);
    } finally {
      await runtime.driver.close();
    }
  });
});
