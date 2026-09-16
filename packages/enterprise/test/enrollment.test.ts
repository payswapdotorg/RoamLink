/**
 * Enterprise enrollment journey tests (RL-063).
 *
 * Proves: the closed state machine (happy path, illegal transitions,
 * terminal immutability), the tenant-binding discipline (verification only
 * with a provisioned tenant - never an enrollment-created organization),
 * idempotent commands, audit correlation, and the reference-only authority
 * boundary of the journey record (RL-LOCK-003/014/019).
 */
import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@roamlink/contracts";
import { InMemoryAuditLog } from "@roamlink/audit";
import { fixtureActorId } from "@roamlink/testkit";

import {
  applyEnterpriseEnrollmentCommand,
  parseEnterpriseEnrollmentRecord,
} from "../src/enrollment.js";
import { EnterpriseOnboardingService } from "../src/onboarding.js";
import {
  InMemoryEnrollmentStore,
  InMemoryOrganizationRegistrar,
} from "../src/stores.js";

const AT = "2026-02-01T10:00:00.000Z";
const LATER = "2026-02-01T11:00:00.000Z";

function draftRecord() {
  return parseEnterpriseEnrollmentRecord({
    enrollmentId: "00000000-0000-4000-8000-000000000001",
    contractVersion: "0.1",
    organizationName: "Acahat Freight Co",
    tenantId: null,
    requestedBy: fixtureActorId(1),
    state: "draft",
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
  });
}

function commandContext(seed: number) {
  return {
    commandId: `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`,
    correlationId: "corr-enrollment-1",
    idempotencyKey: `idem-enrollment-${seed}`,
    actorId: fixtureActorId(1),
  };
}

describe("the enrollment journey state machine (RL-063)", () => {
  it("walks the happy path draft -> submitted -> verified -> active", () => {
    let record = draftRecord();
    record = applyEnterpriseEnrollmentCommand(record, "submit", AT).record;
    expect(record.state).toBe("submitted");
    record = applyEnterpriseEnrollmentCommand(record, "verify", AT, {
      tenantId: "org:00000000-0000-4000-8000-0000000000aa",
    }).record;
    expect(record.state).toBe("verified");
    expect(record.tenantId).toBe("org:00000000-0000-4000-8000-0000000000aa");
    expect(record.verifiedAt).toBe(AT);
    record = applyEnterpriseEnrollmentCommand(record, "activate", LATER).record;
    expect(record.state).toBe("active");
    expect(record.activatedAt).toBe(LATER);
    expect(record.revision).toBe(4);
  });

  it("rejects illegal transitions with typed errors (closed machine)", () => {
    const record = draftRecord();
    expect(() => applyEnterpriseEnrollmentCommand(record, "activate", AT)).toThrowError(
      ConflictError,
    );
    expect(() => applyEnterpriseEnrollmentCommand(record, "verify", AT)).toThrowError(
      ConflictError,
    );
    expect(() => applyEnterpriseEnrollmentCommand(record, "reject", AT)).toThrowError(
      ConflictError,
    );
  });

  it("makes terminal states immutable", () => {
    const record = applyEnterpriseEnrollmentCommand(draftRecord(), "cancel", AT).record;
    expect(record.state).toBe("cancelled");
    expect(record.cancelledAt).toBe(AT);
    for (const command of ["submit", "verify", "activate"] as const) {
      expect(() => applyEnterpriseEnrollmentCommand(record, command, LATER)).toThrowError(
        ConflictError,
      );
    }
    // Re-cancelling is idempotent (no-throw, no state change).
    const again = applyEnterpriseEnrollmentCommand(record, "cancel", LATER);
    expect(again.applied).toBe(false);
    expect(again.record).toBe(record);
  });

  it("requires a bound tenant before verification (never creates one)", () => {
    const record = applyEnterpriseEnrollmentCommand(draftRecord(), "submit", AT).record;
    expect(() => applyEnterpriseEnrollmentCommand(record, "verify", AT)).toThrowError(
      ConflictError,
    );
  });

  it("rejections carry a closed-vocabulary reason", () => {
    const record = applyEnterpriseEnrollmentCommand(draftRecord(), "submit", AT).record;
    const rejected = applyEnterpriseEnrollmentCommand(record, "reject", LATER, {
      rejectionReason: "requirements-unmet",
    }).record;
    expect(rejected.state).toBe("rejected");
    expect(rejected.rejectionReason).toBe("requirements-unmet");
    expect(() =>
      applyEnterpriseEnrollmentCommand(record, "reject", LATER, { rejectionReason: "made-up" }),
    ).toThrowError(ConflictError);
  });

  it("re-applying the same command is idempotent (no state change)", () => {
    const record = applyEnterpriseEnrollmentCommand(draftRecord(), "submit", AT).record;
    const again = applyEnterpriseEnrollmentCommand(record, "submit", LATER);
    expect(again.applied).toBe(false);
    expect(again.record).toBe(record);
  });

  it("rejects unknown fields fail-closed (additive tolerance is versioned, never silent)", () => {
    const input = {
      ...draftRecord(),
      adcosNodeId: "node-77",
    } as Record<string, unknown>;
    expect(() => parseEnterpriseEnrollmentRecord(input)).toThrowError(ValidationError);
  });
});

describe("the onboarding service (idempotency + registrar + audit)", () => {
  function harness() {
    const enrollments = new InMemoryEnrollmentStore();
    const registrar = new InMemoryOrganizationRegistrar();
    const audit = new InMemoryAuditLog();
    let counter = 0;
    const service = new EnterpriseOnboardingService({
      enrollments,
      registrar,
      audit,
      enrollmentIdGenerator: () => {
        counter += 1;
        return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      },
    });
    return { service, enrollments, registrar, audit };
  }

  it("provisions the tenant ONLY through the registrar port at verification", async () => {
    const { service, registrar } = harness();
    const created = await service.create(
      { organizationName: "Acahat Freight Co", requestedBy: fixtureActorId(1) },
      commandContext(1),
      AT,
    );
    expect(created.record.tenantId).toBeNull();
    expect(registrar.provisionedTenantIds()).toEqual([]);

    await service.apply(created.record.enrollmentId, "submit", commandContext(2), AT);
    const verified = await service.apply(
      created.record.enrollmentId,
      "verify",
      commandContext(3),
      LATER,
    );
    expect(verified.record.tenantId).not.toBeNull();
    expect(registrar.provisionedTenantIds()).toHaveLength(1);
    expect(registrar.provisionedTenantIds()[0]).toBe(verified.record.tenantId);
  });

  it("replays the original outcome for a repeated idempotency key (RL-LOCK-014)", async () => {
    const { service } = harness();
    const first = await service.create(
      { organizationName: "Acahat Freight Co", requestedBy: fixtureActorId(1) },
      commandContext(7),
      AT,
    );
    const replay = await service.create(
      { organizationName: "Acahat Freight Co", requestedBy: fixtureActorId(1) },
      commandContext(7),
      LATER,
    );
    expect(replay.record.enrollmentId).toBe(first.record.enrollmentId);
    expect(replay.applied).toBe(false);
    expect(replay.record.updatedAt).toBe(first.record.updatedAt);
  });

  it("refuses a DIFFERENT command under a used idempotency key", async () => {
    const { service } = harness();
    const created = await service.create(
      { organizationName: "Acahat Freight Co", requestedBy: fixtureActorId(1) },
      commandContext(11),
      AT,
    );
    await expect(
      service.apply(created.record.enrollmentId, "submit", commandContext(11), LATER),
    ).rejects.toThrowError(ConflictError);
  });

  it("appends an audit event per security-relevant mutation", async () => {
    const { service, audit } = harness();
    const created = await service.create(
      { organizationName: "Acahat Freight Co", requestedBy: fixtureActorId(1) },
      commandContext(21),
      AT,
    );
    await service.apply(created.record.enrollmentId, "submit", commandContext(22), LATER);
    const events = await audit.events();
    expect(events).toHaveLength(2);
    expect(events[0]?.action).toBe("enterprise.enrollment.created");
    expect(events[1]?.action).toBe("enterprise.enrollment.submit");
    const verification = await audit.verify();
    expect(verification.ok).toBe(true);
  });
});
