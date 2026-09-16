import { describe, expect, it } from "vitest";
import { parseUtcInstant } from "@roamlink/contracts";
import { ValidationError } from "@roamlink/contracts";
import {
  parseReconciliationActionRecord,
  parseReconciliationJobRecord,
  applyReconciliationJobTransition,
  reconciliationJobIdempotencyKey,
  summarizeReconciliationActions,
  type ReconciliationActionRecord,
  type ReconciliationJobRecord,
} from "../src/job-record.js";

const JOB_ID = "00000000-0000-4000-8000-000000000001";
const T0 = parseUtcInstant("2026-01-15T08:30:00.000Z");

function baseJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: JOB_ID,
    correlation_id: "corr-reconcile-1",
    idempotency_key: `idem.reconcile-job.${JOB_ID}`,
    actor_id: "actor:reconciliation-engine",
    tenant_id: "org:00000000-0000-4000-8000-000000000001",
    created_at: T0,
    retry: { attempt: 1 },
    trigger_reason: "scheduled",
    status: "PENDING",
    started_at: null,
    completed_at: null,
    actions: [],
    summary: null,
    ...overrides,
  };
}

function completedAction(outcome: ReconciliationActionRecord["outcome"]): ReconciliationActionRecord {
  return {
    action_id: `${JOB_ID}#1`,
    action_type: "CANONICAL_REFRESH",
    outcome,
    resource_type: "connectivity_contract",
    resource_id: "contract-1",
    detail: "TEST_ACTION",
    attempted_at: T0,
    attempts: 1,
  };
}

describe("the reconciliation job record (RL-035, §5 command identity)", () => {
  it("parses a valid PENDING job with the full §5 metadata set", () => {
    const record = parseReconciliationJobRecord(baseJob());
    expect(record.job_id).toBe(JOB_ID);
    expect(record.idempotency_key).toBe(`idem.reconcile-job.${JOB_ID}`);
    expect(record.retry).toEqual({ attempt: 1 });
    expect(record.status).toBe("PENDING");
    expect(record.started_at).toBeNull();
    expect(record.actions).toEqual([]);
    expect(record.summary).toBeNull();
  });

  it("rejects unknown fields (the record vocabulary is closed)", () => {
    expect(() => parseReconciliationJobRecord(baseJob({ invented: true }))).toThrow(ValidationError);
  });

  it("rejects a non-UUID job id (the §5 command id is a canonical UUID)", () => {
    expect(() => parseReconciliationJobRecord(baseJob({ job_id: "not-a-uuid" }))).toThrow(ValidationError);
  });

  it("rejects a malformed tenant id and malformed retry metadata", () => {
    expect(() => parseReconciliationJobRecord(baseJob({ tenant_id: "tenant-1" }))).toThrow(ValidationError);
    expect(() => parseReconciliationJobRecord(baseJob({ retry: { attempt: 0 } }))).toThrow(ValidationError);
    expect(() =>
      parseReconciliationJobRecord(baseJob({ retry: { attempt: 2, lastError: { reason: "bad reason", kind: "domain", occurredAt: T0 } } })),
    ).toThrow(ValidationError);
  });

  it("rejects unknown statuses, trigger reasons and action vocabularies", () => {
    expect(() => parseReconciliationJobRecord(baseJob({ status: "RUNNNG" }))).toThrow(ValidationError);
    expect(() => parseReconciliationJobRecord(baseJob({ trigger_reason: "whim" }))).toThrow(ValidationError);
    expect(() =>
      parseReconciliationJobRecord(baseJob({ actions: [{ ...completedAction("REPAIRED"), outcome: "FIXED" }] })),
    ).toThrow(ValidationError);
    expect(() =>
      parseReconciliationJobRecord(baseJob({ actions: [{ ...completedAction("REPAIRED"), action_type: "MAGIC" }] })),
    ).toThrow(ValidationError);
  });

  it("rejects actions whose action_id is not rooted at the owning job", () => {
    const alien = { ...completedAction("REPAIRED"), action_id: "00000000-0000-4000-8000-00000000000f#1" };
    expect(() => parseReconciliationJobRecord(baseJob({ actions: [alien] }))).toThrow(ValidationError);
  });

  it("rejects a summary with unknown fields or negative counts", () => {
    const summary = { scanned: 1, repaired: 1, alreadyConsistent: 0, degradedStale: 0, degradedUnknown: 0, canonicalAbsent: 0, deferred: 0, failed: 0 };
    expect(() => parseReconciliationJobRecord(baseJob({ summary }))).toBeDefined();
    expect(() => parseReconciliationJobRecord(baseJob({ summary: { ...summary, invented: 1 } }))).toThrow(ValidationError);
    expect(() => parseReconciliationJobRecord(baseJob({ summary: { ...summary, repaired: -1 } }))).toThrow(ValidationError);
  });
});

describe("the job state machine", () => {
  it("walks PENDING -> RUNNING -> COMPLETED legally", () => {
    const pending = parseReconciliationJobRecord(baseJob());
    const running = applyReconciliationJobTransition(pending, { status: "RUNNING", started_at: T0 });
    expect(running.status).toBe("RUNNING");
    expect(running.started_at).toBe(T0);
    const completed = applyReconciliationJobTransition(running, {
      status: "COMPLETED",
      completed_at: T0,
      actions: [completedAction("REPAIRED")],
      summary: summarizeReconciliationActions([completedAction("REPAIRED")], 1),
    });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.actions).toHaveLength(1);
    expect(completed.summary?.repaired).toBe(1);
  });

  it("COMPLETED is terminal and PENDING cannot jump to COMPLETED", () => {
    const pending = parseReconciliationJobRecord(baseJob());
    expect(() => applyReconciliationJobTransition(pending, { status: "COMPLETED" } as never)).toThrow(ValidationError);
    const completed = applyReconciliationJobTransition(
      applyReconciliationJobTransition(pending, { status: "RUNNING", started_at: T0 }),
      { status: "COMPLETED", completed_at: T0 },
    );
    expect(() => applyReconciliationJobTransition(completed, { status: "RUNNING" })).toThrow(ValidationError);
  });

  it("FAILED -> RUNNING is the legal retry, clearing the failure reason", () => {
    const pending = parseReconciliationJobRecord(baseJob());
    const running = applyReconciliationJobTransition(pending, { status: "RUNNING", started_at: T0 });
    const failed = applyReconciliationJobTransition(running, {
      status: "FAILED",
      failure_reason: "DISCOVERY_FAILED",
      retry: { attempt: 1, lastError: { reason: "DISCOVERY_FAILED", kind: "domain", occurredAt: T0 } },
    });
    expect(failed.failure_reason).toBe("DISCOVERY_FAILED");
    const retried = applyReconciliationJobTransition(failed, {
      status: "RUNNING",
      trigger_reason: "crash-recovery",
      retry: { attempt: 2 },
    });
    expect(retried.status).toBe("RUNNING");
    expect(retried.failure_reason).toBeUndefined();
    expect(retried.retry.attempt).toBe(2);
  });

  it("protects the immutable §5 identity fields on every transition", () => {
    const pending = parseReconciliationJobRecord(baseJob());
    expect(() =>
      applyReconciliationJobTransition(pending, { status: "RUNNING", started_at: T0 } as never),
    ).toBeDefined();
    expect(() =>
      applyReconciliationJobTransition(pending, {
        status: "RUNNING",
        started_at: T0,
        ...{ actor_id: "actor:someone-else" },
      } as never),
    ).toThrow(ValidationError);
  });

  it("the trigger reason may only change on a FAILED re-run", () => {
    const running = applyReconciliationJobTransition(parseReconciliationJobRecord(baseJob()), {
      status: "RUNNING",
      started_at: T0,
    });
    expect(() =>
      applyReconciliationJobTransition(running, { status: "COMPLETED", completed_at: T0, trigger_reason: "manual" }),
    ).toThrow(ValidationError);
  });
});

describe("summaries and keys", () => {
  it("summarizes action outcomes deterministically", () => {
    const actions: ReconciliationActionRecord[] = [
      completedAction("REPAIRED"),
      { ...completedAction("REPAIRED"), action_id: `${JOB_ID}#2` },
      { ...completedAction("ALREADY_CONSISTENT"), action_id: `${JOB_ID}#3` },
      { ...completedAction("DEGRADED_STALE"), action_id: `${JOB_ID}#4` },
      { ...completedAction("DEGRADED_UNKNOWN"), action_id: `${JOB_ID}#5` },
      { ...completedAction("CANONICAL_ABSENT"), action_id: `${JOB_ID}#6` },
      { ...completedAction("DEFERRED"), action_id: `${JOB_ID}#7` },
    ];
    const summary = summarizeReconciliationActions(actions, 7);
    expect(summary).toEqual({
      scanned: 7,
      repaired: 2,
      alreadyConsistent: 1,
      degradedStale: 1,
      degradedUnknown: 1,
      canonicalAbsent: 1,
      deferred: 1,
      failed: 0,
    });
  });

  it("derives the deterministic idempotency key from the job id", () => {
    expect(reconciliationJobIdempotencyKey(JOB_ID as never)).toBe(`idem.reconcile-job.${JOB_ID}`);
  });

  it("validates standalone action records against the owning job", () => {
    const action = parseReconciliationActionRecord(completedAction("REPAIRED"), JOB_ID as never);
    expect(action.outcome).toBe("REPAIRED");
    expect(() => parseReconciliationActionRecord({ ...completedAction("REPAIRED"), detail: "" }, JOB_ID as never)).toThrow(
      ValidationError,
    );
    expect(() =>
      parseReconciliationActionRecord({ ...completedAction("REPAIRED"), attempts: 0 }, JOB_ID as never),
    ).toThrow(ValidationError);
  });
});

describe("a serialized job round-trips (persistence shape)", () => {
  it("survives a JSON round-trip without losing validation", () => {
    const pending = parseReconciliationJobRecord(baseJob());
    const running = applyReconciliationJobTransition(pending, { status: "RUNNING", started_at: T0 });
    const completed = applyReconciliationJobTransition(running, {
      status: "COMPLETED",
      completed_at: T0,
      actions: [completedAction("REPAIRED")],
      summary: summarizeReconciliationActions([completedAction("REPAIRED")], 1),
    });
    const roundTripped = parseReconciliationJobRecord(JSON.parse(JSON.stringify(completed)));
    expect(roundTripped).toEqual(completed);
    expect((roundTripped as ReconciliationJobRecord).summary?.scanned).toBe(1);
  });
});
