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
