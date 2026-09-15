import { describe, expect, it } from "vitest";
import {
  ConflictError,
  ValidationError,
  parseRevision,
  type CanonicalJsonValue,
} from "@roamlink/contracts";
import {
  assertExpectedVersion,
  createInMemoryPersistence,
  nextRevision,
  parseRepositoryName,
} from "../src/index.js";

describe("optimistic concurrency / versioned records (RL-003)", () => {
  it("inserts at version 1; duplicate insert is a typed conflict", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    const inserted = await uow.records("orders").insert("order-1", { status: "requested" });
    await expect(uow.records("orders").insert("order-1", { status: "again" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await uow.commit();

    expect(inserted.version).toBe(1);
    expect((await p.records("orders").get("order-1"))?.version).toBe(1);
  });

  it("compare-and-swap succeeds with the current version and bumps it", async () => {
    const p = createInMemoryPersistence();
    const seed = await p.begin();
    await seed.records("orders").insert("order-1", { status: "requested" });
    await seed.commit();

    const uow = await p.begin();
    const swapped = await uow
      .records("orders")
      .compareAndSwap("order-1", parseRevision(1), { status: "accepted" });
    await uow.commit();

    expect(swapped.version).toBe(2);
    expect(await p.records("orders").get("order-1")).toMatchObject({
      version: 2,
      value: { status: "accepted" },
    });
  });

  it("a stale compare-and-swap is a typed conflict and NEVER a silent overwrite", async () => {
    const p = createInMemoryPersistence();
    const seed = await p.begin();
    await seed.records("orders").insert("order-1", { status: "requested" });
    await seed.commit();

    const bump = await p.begin();
    await bump.records("orders").compareAndSwap("order-1", parseRevision(1), { status: "accepted" });
    await bump.commit(); // now at version 2

    const stale = await p.begin();
    await expect(
      stale.records("orders").compareAndSwap("order-1", parseRevision(1), { status: "hijacked" }),
    ).rejects.toBeInstanceOf(ConflictError);
    await stale.rollback();

    const stored = await p.records("orders").get("order-1");
    expect(stored).toMatchObject({ version: 2, value: { status: "accepted" } });
  });

  it("compare-and-swap on an absent record is a typed conflict", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await expect(
      uow.records("orders").compareAndSwap("order-404", parseRevision(1), { status: "x" }),
    ).rejects.toBeInstanceOf(ConflictError);
    await uow.rollback();
  });

  it("compare-and-swap delete works with the current version and conflicts otherwise", async () => {
    const p = createInMemoryPersistence();
    const seed = await p.begin();
    await seed.records("orders").insert("order-1", { status: "requested" });
    await seed.commit();

    const wrong = await p.begin();
    await expect(wrong.records("orders").delete("order-1", parseRevision(7))).rejects.toBeInstanceOf(
      ConflictError,
    );
    await wrong.rollback();

    const right = await p.begin();
    await right.records("orders").delete("order-1", parseRevision(1));
    await right.commit();
    expect(await p.records("orders").get("order-1")).toBeNull();
    expect(await p.records("orders").count()).toBe(0);
  });

  it("named repositories are isolated (multi-repo)", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await uow.records("orders").insert("shared-id", { where: "orders" });
    await uow.records("invoices").insert("shared-id", { where: "invoices" });
    await uow.commit();

    expect(await p.records("orders").get("other")).toBeNull();
    expect(await p.records("orders").count()).toBe(1);
    expect(await p.records("invoices").count()).toBe(1);
    expect(await p.records("orders").get("shared-id")).toMatchObject({ value: { where: "orders" } });
    expect(await p.records("invoices").get("shared-id")).toMatchObject({
      value: { where: "invoices" },
    });
    // deterministic ordering by recordId
    await expect(p.records("orders").list()).resolves.toHaveLength(1);
  });

  it("assertExpectedVersion throws the typed conflict on mismatch or absence", () => {
    const v1 = parseRevision(1);
    expect(() => assertExpectedVersion(v1, parseRevision(1))).not.toThrow();
    expect(() => assertExpectedVersion(v1, parseRevision(2))).toThrow(ConflictError);
    expect(() => assertExpectedVersion(v1, null)).toThrow(ConflictError);
    const conflict = (() => {
      try {
        assertExpectedVersion(v1, parseRevision(2));
        return null;
      } catch (error) {
        return error as ConflictError;
      }
    })();
    expect(conflict?.kind).toBe("conflict");
    expect(conflict?.reason).toBe("OPTIMISTIC_CONCURRENCY_CONFLICT");
  });

  it("nextRevision is monotonic", () => {
    expect(nextRevision(parseRevision(1))).toBe(2);
    expect(nextRevision(parseRevision(41))).toBe(42);
  });

  it("validates repository names and record ids fail-closed", async () => {
    const p = createInMemoryPersistence();
    expect(() => parseRepositoryName("Orders")).toThrow(ValidationError);
    expect(() => parseRepositoryName("")).toThrow(ValidationError);
    const uow = await p.begin();
    await expect(uow.records("orders").insert("bad id", {})).rejects.toBeInstanceOf(ValidationError);
    await expect(
      uow.records("orders").insert("order-1", undefined as unknown as CanonicalJsonValue),
    ).rejects.toBeInstanceOf(ValidationError);
    await uow.rollback();
  });
});
