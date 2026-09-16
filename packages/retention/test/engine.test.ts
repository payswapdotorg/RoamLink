/**
 * RL-054 engine tests: the enforcement layer end-to-end over the RL-003
 * persistence primitives - admission + atomic audit, expiry sweeps with both
 * erasure semantics, explicit erasure, audited access control, concurrent
 * sweep races and the audit trail of retention decisions
 * (RL-LOCK-014/018; spec/data-model.md "Privacy").
 */
import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "@roamlink/contracts";
import { SequenceIdGenerator, fixtureTenantId, fixtureUtcInstant } from "@roamlink/testkit";
import { createInMemoryPersistence } from "@roamlink/persistence";

import {
  DEFAULT_RETENTION_POLICY,
  PersistenceRetentionAuditStore,
  PersistenceRetentionRecordStore,
  RetentionEnforcementEngine,
  parseClassifiedRecord,
} from "../src/index.js";

const T0 = fixtureUtcInstant();
const TENANT = fixtureTenantId();
const DAY = 24 * 60 * 60 * 1000;

function recordInput(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    recordId: "retention-record-1",
    tenantId: TENANT,
    deviceId: "device-enrollment-ref-1",
    dataCategory: "location",
    purposes: ["connectivity-experience"],
    collectedAt: T0,
    consent: true,
    payload: { latitude: 50.1, longitude: 8.7 },
    ...overrides,
  };
}

function makeEngine(): {
  engine: RetentionEnforcementEngine;
  recordStore: PersistenceRetentionRecordStore;
  auditStore: PersistenceRetentionAuditStore;
} {
  const persistence = createInMemoryPersistence();
  const recordStore = new PersistenceRetentionRecordStore(
    persistence,
    persistence,
    DEFAULT_RETENTION_POLICY,
  );
  const auditStore = new PersistenceRetentionAuditStore(persistence, persistence);
  const decisionIds = new SequenceIdGenerator({ prefix: "decision-", start: 1 });
  const engine = new RetentionEnforcementEngine({
    persistence,
    policy: DEFAULT_RETENTION_POLICY,
    recordStore,
    decisionIdGenerator: () => decisionIds.next(),
  });
  return { engine, recordStore, auditStore };
}

describe("RetentionEnforcementEngine.admit", () => {
  it("admits a valid record, persists it, and audits the retention atomically", async () => {
    const { engine, recordStore, auditStore } = makeEngine();
    const admitted = await engine.admit(recordInput(), T0, "user:actor-1");
    expect(admitted.dataCategory).toBe("location");
    expect(admitted.expiresAt).toBe(fixtureUtcInstant(DAY));

    const stored = await recordStore.get("retention-record-1");
    expect(stored?.record.dataCategory).toBe("location");

    const audit = await auditStore.byRecordId("retention-record-1");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.decision).toBe("retained");
    expect(audit[0]?.actor).toBe("user:actor-1");
  });

  it("rejects secret material, refuses the write, and audits the rejection", async () => {
    const { engine, recordStore, auditStore } = makeEngine();
    await expect(
      engine.admit(recordInput({ payload: { vpnPassword: "hunter2" } }), T0, "user:actor-1"),
    ).rejects.toMatchObject({ reason: "RETENTION_SECRET_MATERIAL_DETECTED" });
    expect(await recordStore.get("retention-record-1")).toBeNull(); // never persisted

    const audit = await auditStore.byRecordId("retention-record-1");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.decision).toBe("rejected-secret-material");
    expect(audit[0]?.refusalReason).toBe("secret-material-detected");
  });

  it("rejects invalid classifications, refuses the write, and audits the rejection", async () => {
    const { engine, recordStore, auditStore } = makeEngine();
    await expect(
      engine.admit(recordInput({ purposes: ["diagnostics"] }), T0),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await recordStore.get("retention-record-1")).toBeNull();

    const audit = await auditStore.byRecordId("retention-record-1");
    expect(audit[0]?.decision).toBe("rejected-invalid-record");
    expect(audit[0]?.refusalReason).toBe("invalid-classification");
  });

  it("a rejected record id remains reusable (the rejection left no record behind)", async () => {
    const { engine } = makeEngine();
    await expect(
      engine.admit(recordInput({ payload: { token: "x".repeat(40) } }), T0),
    ).rejects.toThrowError();
    const admitted = await engine.admit(recordInput(), T0);
    expect(admitted.recordId).toBe("retention-record-1");
  });
});

describe("RetentionEnforcementEngine.sweepExpired", () => {
  it("sweeps an expired location record into a privacy tombstone with its audit row", async () => {
    const { engine, recordStore, auditStore } = makeEngine();
    await engine.admit(recordInput(), T0);

    // Before expiry: nothing swept.
    const early = await engine.sweepExpired(fixtureUtcInstant(DAY - 1));
    expect(early.swept).toHaveLength(0);

    // At/after expiry (location window: 24h): tombstoned.
    const report = await engine.sweepExpired(fixtureUtcInstant(DAY));
    expect(report.inspected).toBe(1);
    expect(report.swept).toEqual([
      { recordId: "retention-record-1", dataCategory: "location", action: "tombstoned" },
    ]);

    const stored = await recordStore.get("retention-record-1");
    expect(stored?.record.payload).toBeNull(); // data erased
    expect(stored?.record.tombstonedAt).toBe(fixtureUtcInstant(DAY)); // metadata kept
    expect(stored?.record.dataCategory).toBe("location");

    const audit = await auditStore.byRecordId("retention-record-1");
    expect(audit.map((row) => row.decision)).toEqual(["retained", "expired-tombstoned"]);
  });

  it("hard-deletes an expired diagnostics record (the data is gone entirely)", async () => {
    const { engine, recordStore, auditStore } = makeEngine();
    await engine.admit(
      recordInput({
        recordId: "retention-record-2",
        dataCategory: "diagnostics",
        purposes: ["diagnostics"],
        consent: false,
        payload: { radio: "lte", signalDbm: -70 },
      }),
      T0,
    );
    const report = await engine.sweepExpired(fixtureUtcInstant(90 * DAY));
    expect(report.swept).toEqual([
      { recordId: "retention-record-2", dataCategory: "diagnostics", action: "hard-deleted" },
    ]);
    expect(await recordStore.get("retention-record-2")).toBeNull();
    const audit = await auditStore.byRecordId("retention-record-2");
    expect(audit.map((row) => row.decision)).toEqual(["retained", "expired-hard-deleted"]);
  });

  it("respects the bounded sweep limit (bounded work per run)", async () => {
    const { engine } = makeEngine();
    for (let index = 1; index <= 3; index += 1) {
      await engine.admit(
        recordInput({
          recordId: `retention-record-${index}`,
          collectedAt: fixtureUtcInstant(-10 * DAY),
        }),
        T0,
      );
    }
    const first = await engine.sweepExpired(T0, 2);
    expect(first.swept).toHaveLength(2);
    const second = await engine.sweepExpired(T0, 2);
    expect(second.swept).toHaveLength(1);
    // Tombstones remain as auditable history, so all three records are still
    // inspected - but only the one live record is due.
    expect(second.inspected).toBe(3);
  });

  it("sweeps are idempotent: tombstones are not re-swept", async () => {
    const { engine, recordStore } = makeEngine();
    await engine.admit(recordInput(), T0);
    await engine.sweepExpired(fixtureUtcInstant(DAY));
    const again = await engine.sweepExpired(fixtureUtcInstant(2 * DAY));
    expect(again.swept).toHaveLength(0);
    expect(again.inspected).toBe(1); // the tombstone itself is listed but never due
    const stored = await recordStore.get("retention-record-1");
    expect(stored?.record.tombstonedAt).toBe(fixtureUtcInstant(DAY)); // untouched
  });

  it("rejects out-of-bounds sweep limits (typed)", async () => {
    const { engine } = makeEngine();
    await expect(engine.sweepExpired(T0, 0)).rejects.toMatchObject({
      reason: "RETENTION_SWEEP_INVALID",
    });
    await expect(engine.sweepExpired(T0, 1001)).rejects.toMatchObject({
      reason: "RETENTION_SWEEP_INVALID",
    });
  });

  it("a concurrent sweep race loses typed, never double-erasing", async () => {
    const { engine } = makeEngine();
    await engine.admit(recordInput({ collectedAt: fixtureUtcInstant(-2 * DAY) }), T0);
    const results = await Promise.allSettled([
      engine.sweepExpired(T0),
      engine.sweepExpired(T0),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      reason: "RETENTION_ERASE_RACE",
    });
  });
});

describe("RetentionEnforcementEngine.requestErasure", () => {
  it("erases immediately on request, with the requesting actor audited", async () => {
    const { engine, recordStore, auditStore } = makeEngine();
    await engine.admit(recordInput(), T0);
    const outcome = await engine.requestErasure(
      "retention-record-1",
      fixtureUtcInstant(1000),
      "user:actor-9",
    );
    expect(outcome.action).toBe("tombstoned");
    const stored = await recordStore.get("retention-record-1");
    expect(stored?.record.payload).toBeNull();

    const audit = await auditStore.byRecordId("retention-record-1");
    expect(audit.map((row) => row.decision)).toEqual(["retained", "erasure-applied"]);
    expect(audit[1]?.actor).toBe("user:actor-9");
  });

  it("hard-deletes on request for hard-delete categories", async () => {
    const { engine, recordStore } = makeEngine();
    await engine.admit(
      recordInput({
        recordId: "retention-record-3",
        dataCategory: "usage",
        purposes: ["connectivity-experience"],
        consent: false,
        payload: { megabytes: 1024 },
      }),
      T0,
    );
    const outcome = await engine.requestErasure("retention-record-3", T0);
    expect(outcome.action).toBe("hard-deleted");
    expect(await recordStore.get("retention-record-3")).toBeNull();
  });

  it("erasure of an unknown record is a typed not-found", async () => {
    const { engine } = makeEngine();
    await expect(engine.requestErasure("no-such-record", T0)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("erasing an already-tombstoned record is an honest no-op (no double audit)", async () => {
    const { engine, auditStore } = makeEngine();
    await engine.admit(recordInput(), T0);
    await engine.requestErasure("retention-record-1", fixtureUtcInstant(1000), "user:a");
    const outcome = await engine.requestErasure("retention-record-1", fixtureUtcInstant(2000), "user:b");
    expect(outcome.action).toBe("already-tombstoned");
    const audit = await auditStore.byRecordId("retention-record-1");
    expect(audit.map((row) => row.decision)).toEqual(["retained", "erasure-applied"]);
  });
});

describe("RetentionEnforcementEngine.authorizeAccess", () => {
  it("grants access for a declared purpose while live and unexpired", async () => {
    const { engine } = makeEngine();
    await engine.admit(recordInput(), T0);
    const decision = await engine.authorizeAccess(
      "retention-record-1",
      "connectivity-experience",
      fixtureUtcInstant(1000),
      "service:experience",
    );
    expect(decision).toEqual({ allowed: true });
  });

  it("denies undeclared purposes (purpose-limited access, typed + audited)", async () => {
    const { engine, auditStore } = makeEngine();
    await engine.admit(recordInput(), T0);
    const decision = await engine.authorizeAccess(
      "retention-record-1",
      "support",
      fixtureUtcInstant(1000),
      "service:support",
    );
    expect(decision).toEqual({ allowed: false, refusalReason: "purpose-not-declared" });
    const audit = await auditStore.byRecordId("retention-record-1");
    expect(audit[audit.length - 1]?.decision).toBe("access-denied");
    expect(audit[audit.length - 1]?.refusalReason).toBe("purpose-not-declared");
  });

  it("denies expired-but-unswept records (never serve past the window)", async () => {
    const { engine } = makeEngine();
    await engine.admit(recordInput(), T0);
    const decision = await engine.authorizeAccess(
      "retention-record-1",
      "connectivity-experience",
      fixtureUtcInstant(DAY),
    );
    expect(decision).toEqual({ allowed: false, refusalReason: "record-expired" });
  });

  it("denies tombstoned records (the data is erased)", async () => {
    const { engine } = makeEngine();
    await engine.admit(recordInput(), T0);
    await engine.sweepExpired(fixtureUtcInstant(DAY));
    const decision = await engine.authorizeAccess(
      "retention-record-1",
      "connectivity-experience",
      fixtureUtcInstant(DAY + 1000),
    );
    expect(decision).toEqual({ allowed: false, refusalReason: "record-tombstoned" });
  });

  it("denies stricter-category records that somehow lack consent (defense in depth)", async () => {
    const { engine, recordStore } = makeEngine();
    // A stored location record without consent cannot pass admission - but if
    // one ever reaches storage anyway (a legacy row, a direct store write),
    // access control still denies it.
    const valid = parseClassifiedRecord(DEFAULT_RETENTION_POLICY, recordInput());
    await recordStore.insert({
      ...valid,
      recordId: "retention-record-4",
      consent: false,
      tombstonedAt: null,
    });
    const stored = await recordStore.get("retention-record-4");
    expect(stored?.record.consent).toBe(false); // readable history, but...
    const decision = await engine.authorizeAccess(
      "retention-record-4",
      "connectivity-experience",
      fixtureUtcInstant(1000),
    );
    expect(decision).toEqual({ allowed: false, refusalReason: "consent-required" });
  });

  it("access decisions are audited (grants and denials)", async () => {
    const { engine, auditStore } = makeEngine();
    await engine.admit(recordInput(), T0);
    await engine.authorizeAccess("retention-record-1", "connectivity-experience", T0, "svc:x");
    await engine.authorizeAccess("retention-record-1", "support", T0, "svc:y");
    const audit = await auditStore.byRecordId("retention-record-1");
    expect(audit.map((row) => row.decision)).toEqual([
      "retained",
      "access-granted",
      "access-denied",
    ]);
  });

  it("unknown records are a typed not-found (hard-deleted data no longer exists)", async () => {
    const { engine } = makeEngine();
    await expect(
      engine.authorizeAccess("gone-record", "support", T0),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("out-of-vocabulary purposes are a typed validation error", async () => {
    const { engine } = makeEngine();
    await engine.admit(recordInput(), T0);
    await expect(
      engine.authorizeAccess("retention-record-1", "marketing", T0),
    ).rejects.toThrowError(/purpose vocabulary/);
  });
});

describe("the audit trail of retention decisions (append-only)", () => {
  it("every engine decision appears in the trail, deterministically ordered", async () => {
    const { engine, auditStore } = makeEngine();
    await engine.admit(recordInput(), T0, "user:a");
    await engine.sweepExpired(fixtureUtcInstant(DAY));
    const trail = await auditStore.list();
    expect(trail.map((row) => row.decision)).toEqual(["retained", "expired-tombstoned"]);
    expect(new Set(trail.map((row) => row.decisionId)).size).toBe(2);
  });
});
