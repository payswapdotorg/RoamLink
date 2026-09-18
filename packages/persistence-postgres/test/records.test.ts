/**
 * RL-091: the versioned record store (optimistic concurrency, compare-and-
 * swap) against real PostgreSQL (pglite) - one UnitOfWork is ONE real
 * database transaction, so atomicity/rollback/read-your-own-writes are the
 * database's own semantics, not simulated ones.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@roamlink/contracts";

import { createMigratedRuntime, nextKey } from "./helpers.js";

describe("versioned records (Postgres adapter)", () => {
  it("inserts at version 1 and reads back the canonical value", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const records = unitOfWork.records("devices");
      const id = nextKey("dev");
      const inserted = await records.insert(id, { name: "RoamLink One", tags: ["a", "b"] });
      expect(inserted.version).toBe(1);
      await unitOfWork.commit();

      const read = await runtime.persistence.records("devices").get(id);
      expect(read).not.toBeNull();
      expect(read?.version).toBe(1);
      expect(read?.value).toEqual({ name: "RoamLink One", tags: ["a", "b"] });
    } finally {
      await runtime.driver.close();
    }
  });

  it("compares-and-swaps only when the expected version matches", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const records = unitOfWork.records("devices");
      const id = nextKey("dev");
      await records.insert(id, { name: "v1" });
      const swapped = await records.compareAndSwap(id, 1, { name: "v2" });
      expect(swapped.version).toBe(2);
      await unitOfWork.commit();

      const read = await runtime.persistence.records("devices").get(id);
      expect(read?.value).toEqual({ name: "v2" });
      expect(read?.version).toBe(2);
    } finally {
      await runtime.driver.close();
    }
  });

  it("rejects a CAS against a stale version with the typed conflict (nothing written)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const records = unitOfWork.records("devices");
      const id = nextKey("dev");
      await records.insert(id, { name: "v1" });
      await records.compareAndSwap(id, 1, { name: "v2" });
      await expect(records.compareAndSwap(id, 1, { name: "stale" })).rejects.toMatchObject({
        reason: "OPTIMISTIC_CONCURRENCY_CONFLICT",
      });
      // The failed CAS changed nothing.
      expect(await records.get(id)).toMatchObject({ version: 2, value: { name: "v2" } });
      await unitOfWork.rollback();
    } finally {
      await runtime.driver.close();
    }
  });

  it("rejects a CAS against a missing record (never invents state)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      await expect(
        unitOfWork.records("devices").compareAndSwap(nextKey("missing"), 1, { name: "x" }),
      ).rejects.toBeInstanceOf(ConflictError);
      await unitOfWork.rollback();
    } finally {
      await runtime.driver.close();
    }
  });

  it("rejects a duplicate insert with the typed conflict", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const records = unitOfWork.records("devices");
      const id = nextKey("dev");
      await records.insert(id, { name: "first" });
      await expect(records.insert(id, { name: "second" })).rejects.toMatchObject({
        reason: "RECORD_ALREADY_EXISTS",
      });
      await unitOfWork.rollback();
    } finally {
      await runtime.driver.close();
    }
  });

  it("compares-and-swap deletes only at the expected version", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const records = unitOfWork.records("devices");
      const id = nextKey("dev");
      await records.insert(id, { name: "doomed" });
      await expect(records.delete(id, 7)).rejects.toBeInstanceOf(ConflictError);
      await records.delete(id, 1);
      expect(await records.get(id)).toBeNull();
      await unitOfWork.commit();
      expect(await runtime.persistence.records("devices").get(id)).toBeNull();
    } finally {
      await runtime.driver.close();
    }
  });

  it("keeps repositories isolated by name", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const id = nextKey("shared");
      await unitOfWork.records("devices").insert(id, { kind: "device" });
      await unitOfWork.records("intents").insert(id, { kind: "intent" });
      await unitOfWork.commit();
      expect(await runtime.persistence.records("devices").get(id)).toMatchObject({
        value: { kind: "device" },
      });
      expect(await runtime.persistence.records("intents").get(id)).toMatchObject({
        value: { kind: "intent" },
      });
      expect(await runtime.persistence.records("devices").count()).toBe(1);
      expect(await runtime.persistence.records("intents").count()).toBe(1);
    } finally {
      await runtime.driver.close();
    }
  });

  it("commits multiple repositories atomically (all or nothing)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      await unitOfWork.records("devices").insert(nextKey("dev"), { ok: true });
      await unitOfWork.records("intents").insert(nextKey("intent"), { ok: true });
      await unitOfWork.commit();
      expect(await runtime.persistence.records("devices").count()).toBe(1);
      expect(await runtime.persistence.records("intents").count()).toBe(1);

      const failing = await runtime.persistence.begin();
      await failing.records("devices").insert(nextKey("dev"), { ok: true });
      await failing.records("intents").insert(nextKey("intent"), { ok: true });
      await failing.rollback(); // discards BOTH writes
      expect(await runtime.persistence.records("devices").count()).toBe(1);
      expect(await runtime.persistence.records("intents").count()).toBe(1);
    } finally {
      await runtime.driver.close();
    }
  });

  it("rolls back uncommitted writes (committed readers never see them)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const records = unitOfWork.records("devices");
      const id = nextKey("dev");
      await records.insert(id, { name: "uncommitted" });
      // Read-your-own-writes INSIDE the unit of work:
      expect(await records.get(id)).not.toBeNull();
      await unitOfWork.rollback();
      // Committed state never saw it.
      expect(await runtime.persistence.records("devices").get(id)).toBeNull();
      expect(await runtime.persistence.records("devices").count()).toBe(0);
    } finally {
      await runtime.driver.close();
    }
  });

  it("refuses writes through a settled unit of work (programming errors are loud)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      await unitOfWork.records("devices").insert(nextKey("dev"), { ok: true });
      await unitOfWork.commit();
      await expect(unitOfWork.records("devices").insert(nextKey("dev"), { ok: true })).rejects.toMatchObject({
        reason: "UNIT_OF_WORK_SETTLED",
      });
      await expect(unitOfWork.commit()).rejects.toMatchObject({ reason: "UNIT_OF_WORK_SETTLED" });
      await unitOfWork.rollback(); // no-op after commit (safe cleanup)
    } finally {
      await runtime.driver.close();
    }
  });

  it("lists deterministically by recordId and counts", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const records = unitOfWork.records("devices");
      const ids = [nextKey("dev"), nextKey("dev"), nextKey("dev")].sort();
      for (const id of ids) await records.insert(id, { index: id });
      await unitOfWork.commit();
      const listed = await runtime.persistence.records("devices").list();
      expect(listed.map((record) => record.recordId)).toEqual(ids);
    } finally {
      await runtime.driver.close();
    }
  });

  it("fails closed on invalid input before any SQL runs", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const records = unitOfWork.records("devices");
      await expect(records.insert("../bad id", { ok: true })).rejects.toBeInstanceOf(ValidationError);
      await expect(records.compareAndSwap(nextKey("dev"), 0, { ok: true })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await unitOfWork.rollback();
    } finally {
      await runtime.driver.close();
    }
  });
});
