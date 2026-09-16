import { describe, expect, it } from "vitest";
import { parseUtcInstant } from "@roamlink/contracts";
import { ConflictError, DomainError } from "@roamlink/contracts";
import { createInMemoryPersistence } from "@roamlink/persistence";
import {
  ReconciliationJobStore,
  parseReconciliationJobRecord,
  applyReconciliationJobTransition,
  type ReconciliationJobRecord,
} from "../src/index.js";

const JOB_ID = "00000000-0000-4000-8000-000000000001";
const JOB_ID_2 = "00000000-0000-4000-8000-000000000002";
const T0 = parseUtcInstant("2026-01-15T08:30:00.000Z");

function pendingJob(jobId: string): ReconciliationJobRecord {
  return parseReconciliationJobRecord({
    job_id: jobId,
    correlation_id: `corr-${jobId}`,
    idempotency_key: `idem.reconcile-job.${jobId}`,
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
  });
}

describe("the reconciliation job store (RL-003 primitives, optimistic concurrency)", () => {
  it("creates and reads back a durable job record", async () => {
    const persistence = createInMemoryPersistence();
    const store = new ReconciliationJobStore(persistence, persistence);
    const job = pendingJob(JOB_ID);
    const created = await store.create(job);
    expect(created.version).toBe(1);
    const read = await store.get(JOB_ID);
    expect(read?.record).toEqual(job);
    expect(read?.version).toBe(1);
  });

  it("refuses duplicate creation with the typed conflict", async () => {
    const persistence = createInMemoryPersistence();
    const store = new ReconciliationJobStore(persistence, persistence);
    await store.create(pendingJob(JOB_ID));
    await expect(store.create(pendingJob(JOB_ID))).rejects.toThrow(ConflictError);
    try {
      await store.create(pendingJob(JOB_ID));
    } catch (error) {
      expect((error as ConflictError).reason).toBe("RECONCILIATION_JOB_EXISTS");
    }
  });

  it("applies lifecycle transitions under compare-and-swap", async () => {
    const persistence = createInMemoryPersistence();
    const store = new ReconciliationJobStore(persistence, persistence);
    const created = await store.create(pendingJob(JOB_ID));
    const running = await store.transition(JOB_ID, created.version, created.record, {
      status: "RUNNING",
      started_at: T0,
    });
    expect(running.version).toBe(2);
    expect(running.record.status).toBe("RUNNING");
    const completed = await store.transition(JOB_ID, running.version, running.record, {
      status: "COMPLETED",
      completed_at: T0,
    });
    expect(completed.record.status).toBe("COMPLETED");
    expect(completed.record.completed_at).toBe(T0);
  });

  it("a lost optimistic-concurrency race surfaces as the typed job race error", async () => {
    const persistence = createInMemoryPersistence();
    const store = new ReconciliationJobStore(persistence, persistence);
    const created = await store.create(pendingJob(JOB_ID));
    // A concurrent runner moves the job forward first.
    await store.transition(JOB_ID, created.version, created.record, {
      status: "RUNNING",
      started_at: T0,
    });
    // The stale runner now CASes at the outdated version and must lose loudly.
    await expect(
      store.transition(JOB_ID, created.version, created.record, { status: "RUNNING", started_at: T0 }),
    ).rejects.toThrow(DomainError);
    try {
      await store.transition(JOB_ID, created.version, created.record, { status: "RUNNING", started_at: T0 });
    } catch (error) {
      expect((error as DomainError).reason).toBe("RECONCILIATION_JOB_RACE");
    }
  });

  it("rejects illegal transitions before any write happens", async () => {
    const persistence = createInMemoryPersistence();
    const store = new ReconciliationJobStore(persistence, persistence);
    const created = await store.create(pendingJob(JOB_ID));
    await expect(
      store.transition(JOB_ID, created.version, created.record, { status: "COMPLETED" } as never),
    ).rejects.toThrow();
    const unchanged = await store.get(JOB_ID);
    expect(unchanged?.record.status).toBe("PENDING");
    expect(unchanged?.version).toBe(1);
  });

  it("lists jobs deterministically by job id", async () => {
    const persistence = createInMemoryPersistence();
    const store = new ReconciliationJobStore(persistence, persistence);
    await store.create(pendingJob(JOB_ID_2));
    await store.create(pendingJob(JOB_ID));
    const all = await store.list();
    expect(all.map((job) => job.record.job_id)).toEqual([JOB_ID, JOB_ID_2]);
  });

  it("illegal transitions never mutate the committed record (applyReconciliationJobTransition contract)", () => {
    const job = pendingJob(JOB_ID);
    expect(() => applyReconciliationJobTransition(job, { status: "FAILED" } as never)).toThrow();
    expect(job.status).toBe("PENDING");
  });
});
