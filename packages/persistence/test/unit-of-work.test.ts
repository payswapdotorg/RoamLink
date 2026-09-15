import { describe, expect, it } from "vitest";
import { ConflictError, DomainError } from "@roamlink/contracts";
import { createInMemoryPersistence } from "../src/index.js";

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-01T00:00:01.000Z";

describe("UnitOfWork transaction boundary (RL-003)", () => {
  it("commits business write + outbox enqueue atomically (visible together)", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await uow.records("orders").insert("order-1", { status: "requested" });
    await uow.outbox.enqueue({
      idempotencyKey: "cmd-1",
      payload: { type: "order.created" },
      createdAt: T0,
    });

    // uncommitted writes are invisible to committed readers...
    expect(await p.records("orders").get("order-1")).toBeNull();
    expect(await p.outbox.get("cmd-1")).toBeNull();
    // ...but visible inside the unit of work (read-your-writes)
    expect(await uow.records("orders").get("order-1")).not.toBeNull();
    expect(await uow.outbox.get("cmd-1")).not.toBeNull();

    await uow.commit();
    expect((await p.records("orders").get("order-1"))?.version).toBe(1);
    const outbox = await p.outbox.get("cmd-1");
    expect(outbox?.deliveryState).toBe("PENDING");
    expect(outbox?.retryCount).toBe(0);
  });

  it("rollback discards outbox + business writes atomically", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await uow.records("orders").insert("order-1", { status: "requested" });
    await uow.records("audit").insert("audit-9", { event: "x" });
    await uow.outbox.enqueue({
      idempotencyKey: "cmd-1",
      payload: { type: "order.created" },
      createdAt: T0,
    });
    await uow.rollback();

    expect(await p.records("orders").get("order-1")).toBeNull();
    expect(await p.records("audit").get("audit-9")).toBeNull();
    expect(await p.outbox.get("cmd-1")).toBeNull();
    expect(await p.outbox.count()).toBe(0);
    expect(await p.records("orders").count()).toBe(0);
  });

  it("a lost CAS race fails the commit loudly and applies NOTHING (atomicity)", async () => {
    const p = createInMemoryPersistence();
    const seed = await p.begin();
    await seed.records("counters").insert("c1", { n: 0 });
    await seed.commit();

    const u1 = await p.begin();
    const u2 = await p.begin();
    await u1.records("counters").compareAndSwap("c1", 1, { n: 1 });
    await u2.records("counters").compareAndSwap("c1", 1, { n: 5 });
    // u2 also does an unrelated business write that must NOT survive
    await u2.records("audit").insert("audit-1", { event: "lost-race" });

    await u1.commit();
    await expect(u2.commit()).rejects.toBeInstanceOf(ConflictError);

    // nothing from u2 was applied: no counter clobber, no orphan audit row
    expect(await p.records("counters").get("c1")).toMatchObject({ version: 2, value: { n: 1 } });
    expect(await p.records("audit").count()).toBe(0);
    // rollback after a failed commit is a no-op (already discarded)
    await expect(u2.rollback()).resolves.toBeUndefined();
  });

  it("concurrent duplicate enqueue of the same key + payload: second commit no-ops", async () => {
    const p = createInMemoryPersistence();
    const u1 = await p.begin();
    const u2 = await p.begin();
    await u1.outbox.enqueue({ idempotencyKey: "cmd-1", payload: { a: 1 }, createdAt: T0 });
    await u2.outbox.enqueue({ idempotencyKey: "cmd-1", payload: { a: 1 }, createdAt: T1 });

    await u1.commit();
    await expect(u2.commit()).resolves.toBeUndefined();
    expect(await p.outbox.count()).toBe(1); // no second record
    const record = await p.outbox.get("cmd-1");
    expect(record?.createdAt).toBe(T0); // the first enqueue won
  });

  it("concurrent enqueue of the same key with a DIFFERENT payload: second commit conflicts", async () => {
    const p = createInMemoryPersistence();
    const u1 = await p.begin();
    const u2 = await p.begin();
    await u1.outbox.enqueue({ idempotencyKey: "cmd-1", payload: { a: 1 }, createdAt: T0 });
    await u2.outbox.enqueue({ idempotencyKey: "cmd-1", payload: { a: 2 }, createdAt: T1 });

    await u1.commit();
    await expect(u2.commit()).rejects.toBeInstanceOf(ConflictError);
    expect(await p.outbox.count()).toBe(1);
    expect((await p.outbox.get("cmd-1"))?.payloadDigest).toBeDefined();
  });

  it("concurrent claim of the same due record: second commit conflicts", async () => {
    const p = createInMemoryPersistence();
    const seed = await p.begin();
    await seed.outbox.enqueue({ idempotencyKey: "cmd-1", payload: { a: 1 }, createdAt: T0 });
    await seed.commit();

    const u1 = await p.begin();
    const u2 = await p.begin();
    const c1 = await u1.outbox.claimDue(T1, 10);
    const c2 = await u2.outbox.claimDue(T1, 10);
    expect(c1).toHaveLength(1);
    expect(c2).toHaveLength(1); // provisional: both saw PENDING at begin

    await u1.commit();
    await expect(u2.commit()).rejects.toBeInstanceOf(ConflictError);
    // the record is claimed exactly once
    expect((await p.outbox.get("cmd-1"))?.deliveryState).toBe("DELIVERING");
  });

  it("settled unit of work: double commit throws; views refuse; rollback-after-commit no-ops", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await uow.records("orders").insert("order-1", { status: "requested" });
    await uow.commit();

    await expect(uow.commit()).rejects.toBeInstanceOf(DomainError);
    await expect(
      uow.records("orders").insert("order-2", { status: "requested" }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(uow.outbox.list()).rejects.toBeInstanceOf(DomainError);
    // rollback after commit is a safe no-op (finally-cleanup pattern)
    await expect(uow.rollback()).resolves.toBeUndefined();
    expect(await p.records("orders").count()).toBe(1);
  });

  it("readers are read-only: writing through them is impossible by construction", async () => {
    const p = createInMemoryPersistence();
    // The committed reader views expose only read methods; every repository
    // obtained via begin() is a transactional view.
    const uow = await p.begin();
    await uow.records("orders").insert("order-1", { status: "requested" });
    await uow.commit();
    expect(await p.records("orders").count()).toBe(1);
    const reader = p.records("orders") as unknown as Record<string, unknown>;
    expect(reader.get).toBeTypeOf("function");
    expect(reader.list).toBeTypeOf("function");
    expect(reader.count).toBeTypeOf("function");
    expect(reader.insert).toBeUndefined();
    expect(reader.compareAndSwap).toBeUndefined();
    expect(reader.delete).toBeUndefined();
    const outboxReader = p.outbox as unknown as Record<string, unknown>;
    expect(outboxReader.enqueue).toBeUndefined();
    expect(outboxReader.claimDue).toBeUndefined();
    const inboxReader = p.inbox as unknown as Record<string, unknown>;
    expect(inboxReader.admit).toBeUndefined();
    expect(inboxReader.recordRejection).toBeUndefined();
  });
});
