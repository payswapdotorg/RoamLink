import { describe, expect, it } from "vitest";
import {
  ConflictError,
  DomainError,
  ValidationError,
  canonicalizeJson,
  parseUtcInstant,
  sha256Hex,
  type CanonicalJsonValue,
} from "@roamlink/contracts";
import {
  OUTBOX_DELIVERY_STATES,
  OUTBOX_DELIVERY_TRANSITIONS,
  canTransitionOutboxDelivery,
  claimOutboxRecord,
  completeOutboxDelivery,
  createInMemoryPersistence,
  failOutboxAttempt,
  isOutboxDeliveryState,
  parseOutboxDeliveryState,
  recoverStuckOutboxRecord,
  type OutboxDeliveryState,
  type OutboxRecord,
} from "../src/index.js";

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-01T00:00:01.000Z";

/** Compile-time exhaustiveness: adding a state without updating the switch fails typecheck. */
function exhaustiveDeliveryStateSwitch(state: OutboxDeliveryState): string {
  switch (state) {
    case "PENDING":
      return "awaiting delivery";
    case "DELIVERING":
      return "claimed";
    case "DELIVERED":
      return "done";
    case "FAILED":
      return "given up";
  }
}

function record(overrides?: Partial<OutboxRecord>): OutboxRecord {
  return {
    idempotencyKey: "cmd-1" as OutboxRecord["idempotencyKey"],
    payloadBytes: new TextEncoder().encode('{"a":1}'),
    payloadDigest: sha256Hex('{"a":1}'),
    createdAt: T0 as OutboxRecord["createdAt"],
    deliveryState: "PENDING",
    retryCount: 0,
    nextAttemptAt: T0 as OutboxRecord["nextAttemptAt"],
    deliveredAt: null,
    lastErrorReason: null,
    retryPolicy: { maxAttempts: 3, backoffScheduleMs: [1_000, 10_000, 60_000] },
    ...overrides,
  };
}

describe("outbox delivery state machine (RL-003)", () => {
  it("is closed: parse rejects unknown values, guards agree", () => {
    expect(OUTBOX_DELIVERY_STATES).toEqual(["PENDING", "DELIVERING", "DELIVERED", "FAILED"]);
    for (const state of OUTBOX_DELIVERY_STATES) {
      expect(isOutboxDeliveryState(state)).toBe(true);
      expect(parseOutboxDeliveryState(state)).toBe(state);
      expect(exhaustiveDeliveryStateSwitch(state)).toBeTypeOf("string");
    }
    expect(isOutboxDeliveryState("PAUSED")).toBe(false);
    expect(() => parseOutboxDeliveryState("PAUSED")).toThrow(ValidationError);
    expect(() => parseOutboxDeliveryState(null)).toThrow(ValidationError);
  });

  it("transition table: pending->delivering; delivering->{delivered|pending|failed}; terminals empty", () => {
    expect(OUTBOX_DELIVERY_TRANSITIONS.PENDING).toEqual(["DELIVERING"]);
    expect([...OUTBOX_DELIVERY_TRANSITIONS.DELIVERING].sort()).toEqual([
      "DELIVERED",
      "FAILED",
      "PENDING",
    ]);
    expect(OUTBOX_DELIVERY_TRANSITIONS.DELIVERED).toEqual([]);
    expect(OUTBOX_DELIVERY_TRANSITIONS.FAILED).toEqual([]);
    expect(canTransitionOutboxDelivery("PENDING", "DELIVERING")).toBe(true);
    expect(canTransitionOutboxDelivery("PENDING", "DELIVERED")).toBe(false);
    expect(canTransitionOutboxDelivery("DELIVERING", "PENDING")).toBe(true);
    expect(canTransitionOutboxDelivery("DELIVERED", "PENDING")).toBe(false);
    expect(canTransitionOutboxDelivery("FAILED", "DELIVERING")).toBe(false);
  });

  it("pure transitions reject illegal from-states and not-due claims", () => {
    const t0 = parseUtcInstant(T0);
    const t1 = parseUtcInstant(T1);
    expect(() => claimOutboxRecord(record({ deliveryState: "DELIVERING" }), t0)).toThrow(
      DomainError,
    );
    expect(() => claimOutboxRecord(record({ nextAttemptAt: t1 }), t0)).toThrow(DomainError);
    expect(() => claimOutboxRecord(record({ nextAttemptAt: null }), t0)).toThrow(DomainError);
    expect(() => completeOutboxDelivery(record({ deliveryState: "PENDING" }), t1)).toThrow(
      DomainError,
    );
    expect(() => failOutboxAttempt(record({ deliveryState: "DELIVERED" }), t1)).toThrow(
      DomainError,
    );
  });
});

describe("outbox enqueue (RL-003, RL-LOCK-014)", () => {
  it("creates a PENDING record with canonical payload bytes/digest and due-at-create next attempt", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await uow.outbox.enqueue({ idempotencyKey: "cmd-1", payload: { b: [2], a: 1 }, createdAt: T0 });
    await uow.commit();

    const stored = await p.outbox.get("cmd-1");
    expect(stored).not.toBeNull();
    const canonical = canonicalizeJson({ b: [2], a: 1 });
    expect(canonical).toBe('{"a":1,"b":[2]}');
    expect(new TextDecoder().decode(stored?.payloadBytes ?? new Uint8Array())).toBe(canonical);
    expect(stored?.payloadDigest).toBe(sha256Hex(canonical));
    expect(stored?.deliveryState).toBe("PENDING");
    expect(stored?.retryCount).toBe(0);
    expect(stored?.nextAttemptAt).toBe(T0);
    expect(stored?.deliveredAt).toBeNull();
    expect(stored?.lastErrorReason).toBeNull();
  });

  it("duplicate enqueue with the same idempotency key creates NO second record", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    const first = await uow.outbox.enqueue({
      idempotencyKey: "cmd-1",
      payload: { a: 1 },
      createdAt: T0,
    });
    const second = await uow.outbox.enqueue({
      idempotencyKey: "cmd-1",
      payload: { a: 1 },
      createdAt: T1,
    });
    await uow.commit();

    expect(first.outcome).toBe("ENQUEUED");
    expect(second.outcome).toBe("ALREADY_ENQUEUED");
    expect(await p.outbox.count()).toBe(1);
    // and again in a second unit of work
    const uow2 = await p.begin();
    const third = await uow2.outbox.enqueue({
      idempotencyKey: "cmd-1",
      payload: { a: 1 },
      createdAt: T1,
    });
    await uow2.commit();
    expect(third.outcome).toBe("ALREADY_ENQUEUED");
    expect(await p.outbox.count()).toBe(1);
  });

  it("same idempotency key with a different payload digest is a typed conflict, never an overwrite", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await uow.outbox.enqueue({ idempotencyKey: "cmd-1", payload: { a: 1 }, createdAt: T0 });
    await uow.commit();

    const uow2 = await p.begin();
    await expect(
      uow2.outbox.enqueue({ idempotencyKey: "cmd-1", payload: { a: 2 }, createdAt: T1 }),
    ).rejects.toBeInstanceOf(ConflictError);
    await uow2.rollback();
    expect(await p.outbox.count()).toBe(1);
  });

  it("validates idempotency key, instant and retry policy", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await expect(
      uow.outbox.enqueue({ idempotencyKey: "", payload: { a: 1 }, createdAt: T0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      uow.outbox.enqueue({ idempotencyKey: "cmd-1", payload: { a: 1 }, createdAt: "2026-10-01" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      uow.outbox.enqueue({
        idempotencyKey: "cmd-1",
        payload: { a: 1 },
        createdAt: T0,
        retryPolicy: { maxAttempts: 0 },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      uow.outbox.enqueue({
        idempotencyKey: "cmd-1",
        payload: { a: 1 },
        createdAt: T0,
        retryPolicy: { backoffScheduleMs: [] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    // non-JSON payloads are rejected by canonical serialization
    await expect(
      uow.outbox.enqueue({
        idempotencyKey: "cmd-1",
        payload: undefined as unknown as CanonicalJsonValue,
        createdAt: T0,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await uow.rollback();
  });
});

describe("outbox claim/deliver/retry transitions (RL-003)", () => {
  it("claims only due PENDING records up to the limit; claimed become DELIVERING", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await uow.outbox.enqueue({ idempotencyKey: "cmd-1", payload: { a: 1 }, createdAt: T0 });
    await uow.outbox.enqueue({
      idempotencyKey: "cmd-2",
      payload: { a: 2 },
      createdAt: T1,
      retryPolicy: { backoffScheduleMs: [60_000] },
    });
    await uow.commit();

    const claim = await p.begin();
    // nothing is due strictly before T0
    expect(await claim.outbox.claimDue("2026-09-30T23:59:59.999Z", 10)).toHaveLength(0);
    // at T0 only cmd-1 is due (cmd-2 was created at T1)
    const claimed = await claim.outbox.claimDue(T0, 10);
    expect(claimed.map((r) => r.idempotencyKey)).toEqual(["cmd-1"]);
    await claim.commit();
    expect((await p.outbox.get("cmd-1"))?.deliveryState).toBe("DELIVERING");
    expect((await p.outbox.get("cmd-2"))?.deliveryState).toBe("PENDING");
  });

  it("marks delivered (terminal) with deliveredAt and null next attempt", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await uow.outbox.enqueue({ idempotencyKey: "cmd-1", payload: { a: 1 }, createdAt: T0 });
    await uow.commit();
    const c = await p.begin();
    await c.outbox.claimDue(T0, 10);
    await c.commit();
    const d = await p.begin();
    await d.outbox.markDelivered("cmd-1", T1);
    await d.commit();

    const stored = await p.outbox.get("cmd-1");
    expect(stored?.deliveryState).toBe("DELIVERED");
    expect(stored?.deliveredAt).toBe(T1);
    expect(stored?.nextAttemptAt).toBeNull();
    // delivered records are not claimable again
    const c2 = await p.begin();
    expect(await c2.outbox.claimDue(T1, 10)).toHaveLength(0);
    await c2.rollback();
    // marking delivered twice is an illegal transition
    const d2 = await p.begin();
    await expect(d2.outbox.markDelivered("cmd-1", T1)).rejects.toBeInstanceOf(DomainError);
    await d2.rollback();
  });

  it("failed attempt retries: DELIVERING -> PENDING with retryCount+1 and backoff-scheduled next attempt", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await uow.outbox.enqueue({
      idempotencyKey: "cmd-1",
      payload: { a: 1 },
      createdAt: T0,
      retryPolicy: { maxAttempts: 3, backoffScheduleMs: [5_000, 50_000] },
    });
    await uow.commit();
    const c = await p.begin();
    await c.outbox.claimDue(T0, 10);
    await c.commit();

    const f = await p.begin();
    const after = await f.outbox.markAttemptFailed("cmd-1", T1, "UPSTREAM_UNAVAILABLE");
    await f.commit();
    expect(after.deliveryState).toBe("PENDING");
    expect(after.retryCount).toBe(1);
    expect(after.lastErrorReason).toBe("UPSTREAM_UNAVAILABLE");
    expect(after.nextAttemptAt).toBe("2026-10-01T00:00:06.000Z"); // T1 + 5s backoff

    // not due before the backoff elapses; due after
    const c2 = await p.begin();
    expect(await c2.outbox.claimDue("2026-10-01T00:00:05.999Z", 10)).toHaveLength(0);
    expect(await c2.outbox.claimDue("2026-10-01T00:00:06.000Z", 10)).toHaveLength(1);
    await c2.commit();
  });

  it("attempt budget exhaustion: DELIVERING -> FAILED terminal", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await uow.outbox.enqueue({
      idempotencyKey: "cmd-1",
      payload: { a: 1 },
      createdAt: T0,
      retryPolicy: { maxAttempts: 2, backoffScheduleMs: [1_000] },
    });
    await uow.commit();

    // attempt 1 fails -> retry scheduled
    const c1 = await p.begin();
    await c1.outbox.claimDue(T0, 10);
    await c1.commit();
    const f1 = await p.begin();
    await f1.outbox.markAttemptFailed("cmd-1", T1, "TIMEOUT");
    await f1.commit();
    expect((await p.outbox.get("cmd-1"))?.deliveryState).toBe("PENDING");

    // attempt 2 (the last) fails -> FAILED terminal
    const c2 = await p.begin();
    await c2.outbox.claimDue("2026-10-01T00:00:02.000Z", 10);
    await c2.commit();
    const f2 = await p.begin();
    const failed = await f2.outbox.markAttemptFailed("cmd-1", "2026-10-01T00:00:02.000Z", "TIMEOUT");
    await f2.commit();

    expect(failed.deliveryState).toBe("FAILED");
    expect(failed.retryCount).toBe(2);
    expect(failed.nextAttemptAt).toBeNull();
    const c3 = await p.begin();
    expect(await c3.outbox.claimDue("2026-10-01T01:00:00.000Z", 10)).toHaveLength(0);
    await c3.rollback();
  });

  it("failure reasons must be UPPER_SNAKE reason codes (no value leakage)", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await uow.outbox.enqueue({ idempotencyKey: "cmd-1", payload: { a: 1 }, createdAt: T0 });
    await uow.commit();
    const c = await p.begin();
    await c.outbox.claimDue(T0, 10);
    await c.commit();
    const f = await p.begin();
    await expect(f.outbox.markAttemptFailed("cmd-1", T1, "something broke")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await f.rollback();
  });

  it("claim limit must be a positive integer", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await expect(uow.outbox.claimDue(T0, 0)).rejects.toBeInstanceOf(DomainError);
    await expect(uow.outbox.claimDue(T0, 1.5)).rejects.toBeInstanceOf(DomainError);
    await uow.rollback();
  });
});

describe("outbox stuck-claim recovery sweep (AR-007 / RL-093)", () => {
  it("recoverStuckOutboxRecord: DELIVERING -> PENDING due at the recovery instant, retry budget untouched", () => {
    const t2 = parseUtcInstant("2026-10-01T00:00:30.000Z");
    const stranded = record({
      deliveryState: "DELIVERING",
      retryCount: 2,
      lastErrorReason: "UPSTREAM_UNAVAILABLE",
      nextAttemptAt: T0 as OutboxRecord["nextAttemptAt"],
    });
    const recovered = recoverStuckOutboxRecord(stranded, t2);
    expect(recovered.deliveryState).toBe("PENDING");
    expect(recovered.nextAttemptAt).toBe("2026-10-01T00:00:30.000Z"); // due at the recovery instant
    expect(recovered.retryCount).toBe(2); // crash recovery is NOT a failed attempt
    expect(recovered.lastErrorReason).toBe("UPSTREAM_UNAVAILABLE");
    expect(recovered.deliveredAt).toBeNull();
    // payload identity is untouched (idempotent replay verifies the digest)
    expect(new TextDecoder().decode(recovered.payloadBytes)).toBe('{"a":1}');
    expect(recovered.payloadDigest).toBe(stranded.payloadDigest);
  });

  it("recoverStuckOutboxRecord: terminal states stay terminal, PENDING cannot be recovered", () => {
    const t2 = parseUtcInstant("2026-10-01T00:00:30.000Z");
    expect(() => recoverStuckOutboxRecord(record({ deliveryState: "DELIVERED" }), t2)).toThrow(
      DomainError,
    );
    expect(() => recoverStuckOutboxRecord(record({ deliveryState: "FAILED" }), t2)).toThrow(
      DomainError,
    );
    expect(() => recoverStuckOutboxRecord(record({ deliveryState: "PENDING" }), t2)).toThrow(
      DomainError,
    );
  });

  it("AR-007 crash window: claim commits -> crash -> restart calls the sweep -> the obligation continues and completes", async () => {
    const p = createInMemoryPersistence();
    // The production delivery shape: business write + outbox enqueue in ONE
    // unit of work.
    const unitOfWork = await p.begin();
    await unitOfWork.records("orders").insert("order-1", { status: "placed" });
    await unitOfWork.outbox.enqueue({
      idempotencyKey: "cmd-crash-1",
      payload: { effect: "notify-order" },
      createdAt: T0,
    });
    await unitOfWork.outbox.enqueue({
      idempotencyKey: "cmd-crash-2",
      payload: { effect: "notify-order-2" },
      createdAt: T0,
    });
    await unitOfWork.commit();

    // The worker claims BOTH due records; this commit is durable...
    const claimUnit = await p.begin();
    const claimed = await claimUnit.outbox.claimDue(T0, 10);
    expect(claimed).toHaveLength(2);
    await claimUnit.commit();
    // ...and the process CRASHES before recording any outcome.
    expect(await p.outbox.count("DELIVERING")).toBe(2);

    // THE RESTART: the restarted worker calls the public stuck-claim sweep
    // (the path that did not exist before AR-007 was closed).
    const restarted = await p.begin();
    const recovered = await restarted.outbox.recoverInFlight(T1);
    await restarted.commit();
    expect(recovered.map((r) => r.idempotencyKey)).toEqual(["cmd-crash-1", "cmd-crash-2"]);
    expect(recovered.every((r) => r.deliveryState === "PENDING")).toBe(true);
    expect(recovered.every((r) => r.nextAttemptAt === T1)).toBe(true);
    expect(await p.outbox.count("DELIVERING")).toBe(0);

    // The obligation CONTINUES through the normal public path: claim ->
    // deliver. Exactly the recovered set is re-claimable at the recovery
    // instant.
    const claimAgain = await p.begin();
    const reclaimed = await claimAgain.outbox.claimDue(T1, 10);
    expect(reclaimed.map((r) => r.idempotencyKey)).toEqual(["cmd-crash-1", "cmd-crash-2"]);
    await claimAgain.commit();

    // ...and COMPLETES: both records reach their terminal DELIVERED state.
    const outcome = await p.begin();
    await outcome.outbox.markDelivered("cmd-crash-1", T1);
    await outcome.outbox.markDelivered("cmd-crash-2", T1);
    await outcome.commit();
    expect((await p.outbox.get("cmd-crash-1"))?.deliveryState).toBe("DELIVERED");
    expect((await p.outbox.get("cmd-crash-2"))?.deliveryState).toBe("DELIVERED");
    expect(await p.outbox.count("DELIVERED")).toBe(2);
  });

  it("the sweep never double-delivers: nothing in flight -> empty result; delivered records are not resurrected", async () => {
    const p = createInMemoryPersistence();
    const unitOfWork = await p.begin();
    await unitOfWork.outbox.enqueue({
      idempotencyKey: "cmd-done-1",
      payload: { a: 1 },
      createdAt: T0,
    });
    await unitOfWork.commit();
    const claim = await p.begin();
    await claim.outbox.claimDue(T0, 10);
    await claim.commit();
    const outcome = await p.begin();
    await outcome.outbox.markDelivered("cmd-done-1", T1);
    await outcome.commit();

    // A sweep with NOTHING stranded in DELIVERING re-owns nothing and
    // touches the delivered (terminal) record.
    const sweep = await p.begin();
    const recovered = await sweep.outbox.recoverInFlight(T1);
    await sweep.commit();
    expect(recovered).toEqual([]);
    expect((await p.outbox.get("cmd-done-1"))?.deliveryState).toBe("DELIVERED");
    expect((await p.outbox.get("cmd-done-1"))?.deliveredAt).toBe(T1);

    // A later sweep still returns nothing - the terminal record stays
    // terminal (never resurrected into the delivery path).
    const sweepAgain = await p.begin();
    expect(await sweepAgain.outbox.recoverInFlight("2026-10-01T00:05:00.000Z")).toEqual([]);
    await sweepAgain.commit();
    expect((await p.outbox.get("cmd-done-1"))?.deliveryState).toBe("DELIVERED");
  });

  it("a FAILED record is never resurrected by the sweep", async () => {
    const p = createInMemoryPersistence();
    const unitOfWork = await p.begin();
    await unitOfWork.outbox.enqueue({
      idempotencyKey: "cmd-dead-1",
      payload: { a: 1 },
      createdAt: T0,
      retryPolicy: { maxAttempts: 1, backoffScheduleMs: [1_000] },
    });
    await unitOfWork.commit();
    const claim = await p.begin();
    await claim.outbox.claimDue(T0, 10);
    await claim.commit();
    const fail = await p.begin();
    await fail.outbox.markAttemptFailed("cmd-dead-1", T1, "BUDGET_EXHAUSTED");
    await fail.commit();
    expect((await p.outbox.get("cmd-dead-1"))?.deliveryState).toBe("FAILED");

    const sweep = await p.begin();
    expect(await sweep.outbox.recoverInFlight(T1)).toEqual([]);
    await sweep.commit();
    expect((await p.outbox.get("cmd-dead-1"))?.deliveryState).toBe("FAILED");
  });

  it("recovery does not consume the retry budget: a previously-failed record keeps its attempts", async () => {
    const p = createInMemoryPersistence();
    const unitOfWork = await p.begin();
    await unitOfWork.outbox.enqueue({
      idempotencyKey: "cmd-mixed-1",
      payload: { a: 1 },
      createdAt: T0,
      retryPolicy: { maxAttempts: 3, backoffScheduleMs: [1_000, 10_000, 60_000] },
    });
    await unitOfWork.outbox.enqueue({
      idempotencyKey: "cmd-mixed-2",
      payload: { a: 2 },
      createdAt: T0,
    });
    await unitOfWork.commit();
    // cmd-mixed-1: one REAL failed attempt (retryCount 1), then claimed
    // again and stranded by a crash. cmd-mixed-2: stranded on its first
    // claim.
    const claim1 = await p.begin();
    await claim1.outbox.claimDue(T0, 10);
    await claim1.commit();
    const fail1 = await p.begin();
    await fail1.outbox.markAttemptFailed("cmd-mixed-1", T1, "TIMEOUT");
    await fail1.commit();
    const claim2 = await p.begin();
    await claim2.outbox.claimDue("2026-10-01T00:00:02.000Z", 10);
    await claim2.commit();

    const sweep = await p.begin();
    const recovered = await sweep.outbox.recoverInFlight("2026-10-01T00:00:30.000Z");
    await sweep.commit();
    expect(recovered.map((r) => r.idempotencyKey)).toEqual(["cmd-mixed-1", "cmd-mixed-2"]);
    expect(recovered.find((r) => r.idempotencyKey === "cmd-mixed-1")?.retryCount).toBe(1);
    expect(recovered.find((r) => r.idempotencyKey === "cmd-mixed-2")?.retryCount).toBe(0);
    // The full attempt budget is still available: both records can fail
    // twice more before exhausting maxAttempts=3 (recovery spent nothing).
    expect(
      (await p.outbox.get("cmd-mixed-1"))?.retryPolicy.maxAttempts,
    ).toBe(3);
  });

  it("the sweep is transactional: a concurrent delivered outcome wins the race as a typed commit conflict", async () => {
    const p = createInMemoryPersistence();
    const unitOfWork = await p.begin();
    await unitOfWork.outbox.enqueue({
      idempotencyKey: "cmd-race-1",
      payload: { a: 1 },
      createdAt: T0,
    });
    await unitOfWork.commit();
    const claim = await p.begin();
    await claim.outbox.claimDue(T0, 10);
    await claim.commit();

    // Worker A (the restarted process) opens a unit of work and sweeps.
    const sweepUnit = await p.begin();
    await sweepUnit.outbox.recoverInFlight(T1);
    // Worker B (the ORIGINAL owner, still alive) records the outcome first.
    const outcomeUnit = await p.begin();
    await outcomeUnit.outbox.markDelivered("cmd-race-1", T1);
    await outcomeUnit.commit();
    // Worker A's sweep commit must NOT overwrite the delivered outcome.
    await expect(sweepUnit.commit()).rejects.toBeInstanceOf(ConflictError);
    expect((await p.outbox.get("cmd-race-1"))?.deliveryState).toBe("DELIVERED");
  });
});
