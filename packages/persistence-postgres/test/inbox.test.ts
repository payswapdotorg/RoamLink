/**
 * RL-091: the durable webhook inbox against real PostgreSQL (pglite) - the
 * append-only admission log with the database-enforced "exactly one ADMITTED
 * record per dedupe key" invariant (partial unique index), DUPLICATE audit
 * rows, and rejections that never occupy the key (RL-LOCK-009).
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";

import { createMigratedRuntime, nextKey, T0, T1 } from "./helpers.js";

function arrival(overrides?: Partial<{ source: string; externalEventId: string; dedupeKey: string; receivedAt: string }>): {
  source: string;
  externalEventId: string;
  dedupeKey: string;
  receivedAt: string;
} {
  const key = nextKey("evt");
  return {
    source: "adcos",
    externalEventId: key,
    dedupeKey: key,
    receivedAt: T0,
    ...overrides,
  };
}

describe("durable inbox (Postgres adapter)", () => {
  it("admits an arrival durably with an assigned sequence", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const input = arrival();
      const result = await unitOfWork.inbox.admit(input);
      expect(result.outcome).toBe("ADMITTED");
      if (result.outcome !== "ADMITTED") throw new Error("unreachable");
      expect(result.record.sequence).toBeGreaterThanOrEqual(1);
      expect(result.record.admissionState).toBe("ADMITTED");
      await unitOfWork.commit();

      const read = await runtime.persistence.inbox.admitted(input.dedupeKey);
      expect(read).not.toBeNull();
      expect(read?.sequence).toBe(result.record.sequence);
    } finally {
      await runtime.driver.close();
    }
  });

  it("answers later arrivals for an admitted key with DUPLICATE + the original (never a second admission)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const input = arrival();
      await unitOfWork.inbox.admit(input);
      const later = await unitOfWork.inbox.admit({ ...input, receivedAt: T1 });
      expect(later.outcome).toBe("DUPLICATE");
      if (later.outcome !== "DUPLICATE") throw new Error("unreachable");
      expect(later.original.admissionState).toBe("ADMITTED");
      expect(later.record.admissionState).toBe("DUPLICATE");
      await unitOfWork.commit();

      // Exactly ONE admitted row for the key; both rows exist as the audit log.
      expect(await runtime.persistence.inbox.count("ADMITTED")).toBe(1);
      expect(await runtime.persistence.inbox.count("DUPLICATE")).toBe(1);
      const original = await runtime.persistence.inbox.admitted(input.dedupeKey);
      expect(original?.externalEventId).toBe(input.externalEventId);
    } finally {
      await runtime.driver.close();
    }
  });

  it("records REJECTED arrivals as audit rows that never occupy the dedupe key", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const input = arrival();
      await unitOfWork.inbox.recordRejection(input);
      expect(await unitOfWork.inbox.admitted(input.dedupeKey)).toBeNull();
      await unitOfWork.commit();

      // A corrected retry CAN admit: the key is still free.
      const retry = await runtime.persistence.begin();
      const admitted = await retry.inbox.admit(input);
      expect(admitted.outcome).toBe("ADMITTED");
      await retry.commit();
      expect(await runtime.persistence.inbox.count("REJECTED")).toBe(1);
      expect(await runtime.persistence.inbox.count("ADMITTED")).toBe(1);
    } finally {
      await runtime.driver.close();
    }
  });

  it("assigns monotonic sequences in admission order (ordering signal)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const first = await unitOfWork.inbox.admit(arrival());
      const second = await unitOfWork.inbox.admit(arrival());
      const third = await unitOfWork.inbox.admit(arrival());
      if (first.outcome !== "ADMITTED" || second.outcome !== "ADMITTED" || third.outcome !== "ADMITTED") {
        throw new Error("all three arrivals must admit");
      }
      expect(second.record.sequence).toBeGreaterThan(first.record.sequence);
      expect(third.record.sequence).toBeGreaterThan(second.record.sequence);
      await unitOfWork.commit();

      const listed = await runtime.persistence.inbox.list();
      const sequences = listed.map((record) => record.sequence);
      expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    } finally {
      await runtime.driver.close();
    }
  });

  it("serves filtered listings and counts by admission state", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const input = arrival();
      await unitOfWork.inbox.admit(input);
      await unitOfWork.inbox.admit({ ...input, receivedAt: T1 }); // duplicate
      await unitOfWork.inbox.recordRejection(arrival());
      await unitOfWork.commit();

      expect(await runtime.persistence.inbox.count()).toBe(3);
      expect(await runtime.persistence.inbox.count("ADMITTED")).toBe(1);
      expect(await runtime.persistence.inbox.count("DUPLICATE")).toBe(1);
      expect(await runtime.persistence.inbox.count("REJECTED")).toBe(1);
      expect((await runtime.persistence.inbox.list("REJECTED")).at(0)?.admissionState).toBe("REJECTED");
    } finally {
      await runtime.driver.close();
    }
  });

  it("rolls back admissions atomically with the rest of the unit of work", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      await unitOfWork.inbox.admit(arrival());
      await unitOfWork.records("adcos-webhook-inbox").insert(nextKey("evt"), { payload: true });
      await unitOfWork.rollback();
      expect(await runtime.persistence.inbox.count()).toBe(0);
      expect(await runtime.persistence.records("adcos-webhook-inbox").count()).toBe(0);
    } finally {
      await runtime.driver.close();
    }
  });

  it("rejects invalid arrival fields fail-closed before any SQL", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      await expect(
        unitOfWork.inbox.admit({ source: "ADCONS", externalEventId: "e-1", receivedAt: T0, dedupeKey: "k-1" }),
      ).rejects.toBeInstanceOf(ValidationError); // source must be a lowercase slug
      await expect(
        unitOfWork.inbox.admit({ source: "adcos", externalEventId: "e 1", receivedAt: T0, dedupeKey: "k-1" }),
      ).rejects.toBeInstanceOf(ValidationError); // unsafe reference charset
      await expect(
        unitOfWork.inbox.admit({ source: "adcos", externalEventId: "e-1", receivedAt: "not-an-instant", dedupeKey: "k-1" }),
      ).rejects.toBeInstanceOf(ValidationError);
      await unitOfWork.rollback();
      expect(await runtime.persistence.inbox.count()).toBe(0);
    } finally {
      await runtime.driver.close();
    }
  });

  it("reads inbox records by sequence from the committed reader (null for unknown)", async () => {
    const runtime = await createMigratedRuntime();
    try {
      const unitOfWork = await runtime.persistence.begin();
      const result = await unitOfWork.inbox.admit(arrival());
      await unitOfWork.commit();
      if (result.outcome !== "ADMITTED") throw new Error("unreachable");

      const read = await runtime.persistence.inbox.get(result.record.sequence);
      expect(read?.dedupeKey).toBe(result.record.dedupeKey);
      expect(await runtime.persistence.inbox.get(999_999)).toBeNull();
      await expect(runtime.persistence.inbox.get(0)).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await runtime.driver.close();
    }
  });
});
