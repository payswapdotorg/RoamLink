import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import {
  INBOX_ADMISSION_STATES,
  createInMemoryPersistence,
  isInboxAdmissionState,
  parseInboxAdmissionState,
  type InboxAdmissionState,
} from "../src/index.js";

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-01T00:00:02.000Z";

/** Compile-time exhaustiveness: adding a state without updating the switch fails typecheck. */
function exhaustiveAdmissionStateSwitch(state: InboxAdmissionState): string {
  switch (state) {
    case "ADMITTED":
      return "admitted";
    case "DUPLICATE":
      return "duplicate arrival";
    case "REJECTED":
      return "failed admission";
  }
}

describe("inbox admission (RL-003, RL-LOCK-009)", () => {
  it("admission states are closed: parse rejects unknown, guards agree", () => {
    expect(INBOX_ADMISSION_STATES).toEqual(["ADMITTED", "DUPLICATE", "REJECTED"]);
    for (const state of INBOX_ADMISSION_STATES) {
      expect(isInboxAdmissionState(state)).toBe(true);
      expect(parseInboxAdmissionState(state)).toBe(state);
      expect(exhaustiveAdmissionStateSwitch(state)).toBeTypeOf("string");
    }
    expect(isInboxAdmissionState("RETRY")).toBe(false);
    expect(() => parseInboxAdmissionState("retry")).toThrow(ValidationError);
  });

  it("admits an arrival durably with a deterministic sequence", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    const result = await uow.inbox.admit({
      source: "adcos",
      externalEventId: "evt-1",
      receivedAt: T0,
      dedupeKey: "adcos:evt-1",
    });
    await uow.commit();

    expect(result.outcome).toBe("ADMITTED");
    expect(result.record.sequence).toBe(1);
    expect(result.record.admissionState).toBe("ADMITTED");
    expect(await p.inbox.admitted("adcos:evt-1")).toMatchObject({
      sequence: 1,
      dedupeKey: "adcos:evt-1",
    });
    expect(await p.inbox.count("ADMITTED")).toBe(1);
  });

  it("a duplicate dedupe key never produces a second ADMITTED record", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await uow.inbox.admit({
      source: "adcos",
      externalEventId: "evt-1",
      receivedAt: T0,
      dedupeKey: "adcos:evt-1",
    });
    await uow.commit();

    const uow2 = await p.begin();
    const second = await uow2.inbox.admit({
      source: "adcos",
      externalEventId: "evt-1",
      receivedAt: T1,
      dedupeKey: "adcos:evt-1",
    });
    await uow2.commit();

    expect(second.outcome).toBe("DUPLICATE");
    if (second.outcome !== "DUPLICATE") {
      throw new Error("expected a duplicate admission outcome");
    }
    expect(second.record.admissionState).toBe("DUPLICATE");
    expect(second.original.sequence).toBe(1);
    // exactly one ADMITTED record for the key; the duplicate is an audit row
    expect(await p.inbox.count("ADMITTED")).toBe(1);
    expect(await p.inbox.count("DUPLICATE")).toBe(1);
    expect(await p.inbox.count()).toBe(2);
    // admitted() still returns the ORIGINAL admission
    expect((await p.inbox.admitted("adcos:evt-1"))?.sequence).toBe(1);
    expect((await p.inbox.admitted("adcos:evt-1"))?.receivedAt).toBe(T0);
  });

  it("concurrent duplicate admissions converge: one ADMITTED, one DUPLICATE", async () => {
    const p = createInMemoryPersistence();
    const u1 = await p.begin();
    const u2 = await p.begin();
    await u1.inbox.admit({
      source: "adcos",
      externalEventId: "evt-1",
      receivedAt: T0,
      dedupeKey: "adcos:evt-1",
    });
    await u2.inbox.admit({
      source: "adcos",
      externalEventId: "evt-1",
      receivedAt: T1,
      dedupeKey: "adcos:evt-1",
    });
    await u1.commit();
    await expect(u2.commit()).resolves.toBeUndefined(); // no conflict: idempotent convergence

    expect(await p.inbox.count("ADMITTED")).toBe(1);
    expect(await p.inbox.count("DUPLICATE")).toBe(1);
  });

  it("rejections are audited and do NOT occupy the dedupe key", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    const rejected = await uow.inbox.recordRejection({
      source: "adcos",
      externalEventId: "evt-1",
      receivedAt: T0,
      dedupeKey: "adcos:evt-1",
    });
    await uow.commit();

    expect(rejected.admissionState).toBe("REJECTED");
    expect(rejected.sequence).toBe(1);
    expect(await p.inbox.admitted("adcos:evt-1")).toBeNull();

    // a corrected retry with the same key may still admit
    const uow2 = await p.begin();
    const admitted = await uow2.inbox.admit({
      source: "adcos",
      externalEventId: "evt-1",
      receivedAt: T1,
      dedupeKey: "adcos:evt-1",
    });
    await uow2.commit();
    expect(admitted.outcome).toBe("ADMITTED");
    expect(await p.inbox.count("ADMITTED")).toBe(1);
    expect(await p.inbox.count("REJECTED")).toBe(1);
  });

  it("validates arrival fields fail-closed (RL-LOCK-016: never echoes values)", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await expect(
      uow.inbox.admit({
        source: "Adcos",
        externalEventId: "evt-1",
        receivedAt: T0,
        dedupeKey: "adcos:evt-1",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      uow.inbox.admit({
        source: "adcos",
        externalEventId: "evt 1",
        receivedAt: T0,
        dedupeKey: "adcos:evt-1",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      uow.inbox.admit({
        source: "adcos",
        externalEventId: "evt-1",
        receivedAt: "2026-10-01T00:00:00", // naive time: rejected
        dedupeKey: "adcos:evt-1",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await uow.rollback();
  });

  it("lists and counts by admission state; get() by sequence", async () => {
    const p = createInMemoryPersistence();
    const uow = await p.begin();
    await uow.inbox.admit({
      source: "adcos",
      externalEventId: "evt-1",
      receivedAt: T0,
      dedupeKey: "adcos:evt-1",
    });
    await uow.inbox.admit({
      source: "adcos",
      externalEventId: "evt-2",
      receivedAt: T1,
      dedupeKey: "adcos:evt-2",
    });
    await uow.inbox.recordRejection({
      source: "adcos",
      externalEventId: "evt-3",
      receivedAt: T1,
      dedupeKey: "adcos:evt-3",
    });
    await uow.commit();

    expect(await p.inbox.get(1)).not.toBeNull();
    expect(await p.inbox.get(2)).not.toBeNull();
    expect(await p.inbox.get(3)).not.toBeNull();
    expect(await p.inbox.get(4)).toBeNull();
    expect((await p.inbox.list()).map((r) => r.externalEventId)).toEqual(["evt-1", "evt-2", "evt-3"]);
    expect((await p.inbox.list("ADMITTED")).map((r) => r.externalEventId)).toEqual([
      "evt-1",
      "evt-2",
    ]);
  });
});
