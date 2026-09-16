/**
 * Reconciler idempotency (RL-035, RL-LOCK-014): re-running a repair job
 * after a crash produces the SAME OUTCOME, not duplicates.
 *
 *  - a COMPLETED job re-run returns the recorded outcome with zero new
 *    effects;
 *  - a FAILED job (crash mid-run) re-runs with all effects converging;
 *  - a RUNNING job refuses takeover without `resume` (the live runner wins);
 *  - the durable record carries the full §5 idempotency metadata set.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, DomainError, parseUtcInstant } from "@roamlink/contracts";
import { createInMemoryPersistence } from "@roamlink/persistence";
import { AdcosProjectionEngine, InMemoryProjectionStore } from "@roamlink/projections";
import {
  AdcosWebhookInboxService,
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
} from "@roamlink/webhook-inbox";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";
import { FakeAdcos } from "../../integration/test/fake-adcos.js";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeWebhookDelivery,
} from "../../webhook-inbox/test/fake-adcos-webhooks.js";
import {
  AdcosReconciliationEngine,
  BoundaryWebhookProjector,
  ReconciliationJobStore,
  parseReconciliationJobRecord,
  type ReconciliationJobRecord,
} from "../src/index.js";
import { makeHarness, mustGetProjection, createIntentOnFake, PLATFORM_TENANT, TEST_INTENT_REQUEST } from "./helpers.js";

const EMPTY_DRAIN = {
  processPending: async () => ({
    considered: 0,
    alreadyProjected: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    conflicts: 0,
  }),
};

function manualEngine(clock: DeterministicClock, fake: FakeAdcos): {
  engine: AdcosReconciliationEngine;
  jobs: ReconciliationJobStore;
  store: InMemoryProjectionStore;
} {
  const persistence = createInMemoryPersistence();
  const store = new InMemoryProjectionStore();
  const projectionEngine = new AdcosProjectionEngine({ writer: store, reader: store, clock });
  const jobs = new ReconciliationJobStore(persistence, persistence);
  const engine = new AdcosReconciliationEngine({
    client: fake,
    projectionEngine,
    projectionReader: store,
    jobs,
    inbox: EMPTY_DRAIN,
    clock,
    tenantId: PLATFORM_TENANT as never,
    policy: { maxCanonicalReadAttempts: 1, inboxBatchLimit: 10, refreshMarginMs: 0, discoveryEnabled: false },
  });
  return { engine, jobs, store };
}

function pendingJobRecord(jobId: string): ReconciliationJobRecord {
  return parseReconciliationJobRecord({
    job_id: jobId,
    correlation_id: `corr-${jobId}`,
    idempotency_key: `idem.reconcile-job.${jobId}`,
    actor_id: "actor:reconciliation-engine",
    tenant_id: PLATFORM_TENANT,
    created_at: "2026-01-15T08:30:00.000Z",
    retry: { attempt: 1 },
    trigger_reason: "scheduled",
    status: "PENDING",
    started_at: null,
    completed_at: null,
    actions: [],
    summary: null,
  });
}

describe("reconciler idempotency (RL-LOCK-014)", () => {
  it("re-running a COMPLETED job returns the recorded outcome with ZERO new effects", async () => {
    const harness = makeHarness();
    const intentId = await createIntentOnFake(harness, "idem-idem-complete");
    await harness.admit(harness.fake.deliveries());

    const first = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    expect(first.status).toBe("COMPLETED");
    const recordAfterFirst = await mustGetProjection(harness, "connectivity_intent", intentId);
    const jobCountAfterFirst = (await harness.boundary.reconciler.listJobs()).length;

    const second = await harness.boundary.reconciler.runJob({
      jobId: first.job_id,
      reason: "manual",
    });
    expect(second).toEqual(first); // the recorded outcome stands, byte for byte

    const recordAfterSecond = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(recordAfterSecond).toEqual(recordAfterFirst); // no projection writes
    expect((await harness.boundary.reconciler.listJobs()).length).toBe(jobCountAfterFirst); // no new jobs
    expect(recordAfterSecond.projection_version).toBe(1); // still exactly one apply
  });

  it("a crashed (FAILED) job re-runs and converges without duplicating effects", async () => {
    // Manual composition: the inbox drain applies its projections and THEN
    // the runner crashes - durable effects exist, the job record says FAILED.
    const clock = new DeterministicClock("2026-01-15T08:30:00.000Z");
    const fake = new FakeAdcos({ seedProbe: false, now: () => clock.now() });
    const persistence = createInMemoryPersistence();
    const projectionStore = new InMemoryProjectionStore();
    const projectionEngine = new AdcosProjectionEngine({
      writer: projectionStore,
      reader: projectionStore,
      clock,
    });
    const realInbox = new AdcosWebhookInboxService({
      verifier: new HmacWebhookVerifier({
        environment: "sandbox",
        keys: new StaticWebhookSigningKeyRegistry({ [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET }),
      }),
      persistence,
      reader: persistence,
      clock,
      projector: new BoundaryWebhookProjector(projectionEngine),
    });
    let crashPending = true;
    const crashingInbox = {
      processPending: async (limit?: number) => {
        const report = await realInbox.processPending(limit);
        if (crashPending) {
          crashPending = false;
          throw new DomainError("simulated runner crash after the durable drain", {
            reason: "POST_DRAIN_CRASH",
            retryable: false,
          });
        }
        return report;
      },
    };
    const engine = new AdcosReconciliationEngine({
      client: fake,
      projectionEngine,
      projectionReader: projectionStore,
      jobs: new ReconciliationJobStore(persistence, persistence),
      inbox: crashingInbox,
      clock,
      tenantId: PLATFORM_TENANT as never,
      jobIdGenerator: new DeterministicUuidGenerator(1),
      policy: {
        maxCanonicalReadAttempts: 1,
        inboxBatchLimit: 10,
        refreshMarginMs: 0,
        discoveryEnabled: false,
      },
    });

    const intentDocument = await fake.createIntent(TEST_INTENT_REQUEST, {
      idempotencyKey: "idem-idem-crash" as never,
    });
    const intentId = (intentDocument as { id: string }).id;
    const emitted = fake.emittedEvents()[0];
    if (emitted === undefined) throw new Error("test expected an emitted event");
    const signed = fakeWebhookDelivery({
      spec: {
        eventId: emitted.event.event_id,
        eventType: emitted.event.event_type,
        resourceId: emitted.event.resource_id,
        resourceKind: emitted.event.resource_kind,
        resourceVersion: emitted.event.resource_version,
        occurredAt: emitted.event.occurred_at,
        correlationId: emitted.event.correlation_id,
        environment: "sandbox",
      },
      deliveryId: "dlv-idem-1",
      sequence: 1,
      receivedAt: clock.now(),
    });
    const admission = await realInbox.admitDelivery({
      headers: signed.headers,
      payload: signed.payload,
      receivedAt: clock.now(),
    });
    expect(admission.outcome).toBe("ADMITTED");

    // Run 1: the drain applies the projection, then the runner crashes.
    const first = await engine.runJob({ reason: "scheduled" }).catch((error) => error);
    expect(first).toBeInstanceOf(DomainError);
    expect((first as DomainError).reason).toBe("POST_DRAIN_CRASH");

    const failedJobs = await engine.listJobs();
    expect(failedJobs).toHaveLength(1);
    expect(failedJobs[0]?.status).toBe("FAILED");
    expect(failedJobs[0]?.failure_reason).toBe("POST_DRAIN_CRASH");
    expect(failedJobs[0]?.retry.attempt).toBe(1);
    // The durable effect of the crashed run survived:
    const survived = await projectionStore.get("connectivity_intent", intentId);
    expect(survived).not.toBeNull();
    expect(survived?.projection_version).toBe(1);

    // Run 2 (crash recovery, SAME job id): converges, never duplicates.
    const failedJob = failedJobs[0];
    if (failedJob === undefined) throw new Error("test expected the failed job record");
    const second = await engine.runJob({
      jobId: failedJob.job_id,
      reason: "crash-recovery",
    });
    expect(second.status).toBe("COMPLETED");
    expect(second.retry.attempt).toBe(2);
    expect(second.failure_reason).toBeUndefined();
    expect(second.trigger_reason).toBe("crash-recovery");

    const allJobs = await engine.listJobs();
    expect(allJobs).toHaveLength(1); // one job record, retried - not duplicated
    const record = await projectionStore.get("connectivity_intent", intentId);
    expect(record?.projection_version).toBe(1); // still exactly one apply
    expect(record?.event_id).toBe(emitted.event.event_id);
    const refresh = second.actions.find(
      (action) => action.action_type === "CANONICAL_REFRESH" && action.resource_id === intentId,
    );
    expect(refresh?.outcome).toBe("ALREADY_CONSISTENT"); // FRESH within its guarantee
  });

  it("a RUNNING job refuses takeover without resume and completes with it", async () => {
    const clock = new DeterministicClock("2026-01-15T08:30:00.000Z");
    const fake = new FakeAdcos({ seedProbe: false, now: () => clock.now() });
    const { engine, jobs } = manualEngine(clock, fake);
    const jobId = "00000000-0000-4000-8000-00000000c0de";

    // Simulate a crashed runner: the record is stuck in RUNNING.
    const job = pendingJobRecord(jobId);
    await jobs.create(job);
    await jobs.transition(jobId, 1, job, {
      status: "RUNNING",
      started_at: parseUtcInstant("2026-01-15T08:30:00.000Z"),
    });

    await expect(engine.runJob({ jobId, reason: "manual" })).rejects.toThrow(ConflictError);
    try {
      await engine.runJob({ jobId, reason: "manual" });
    } catch (error) {
      expect((error as ConflictError).reason).toBe("RECONCILIATION_JOB_ALREADY_RUNNING");
    }

    const resumed = await engine.runJob({ jobId, reason: "crash-recovery", resume: true });
    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.job_id).toBe(jobId);
    expect(resumed.retry.attempt).toBe(2); // the crashed attempt was attempt 1
  });

  it("the durable job record carries the full §5 idempotency metadata set", async () => {
    const harness = makeHarness();
    await createIntentOnFake(harness, "idem-idem-envelope");
    await harness.admit(harness.fake.deliveries());
    const job = await harness.boundary.reconciler.runJob({
      reason: "scheduled",
      correlationId: "corr-my-reconciliation",
      actorId: "actor:ops-oncall",
    });

    expect(job.job_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(job.correlation_id).toBe("corr-my-reconciliation");
    expect(job.idempotency_key).toBe(`idem.reconcile-job.${job.job_id}`);
    expect(job.actor_id).toBe("actor:ops-oncall");
    expect(job.tenant_id).toBe(PLATFORM_TENANT);
    expect(job.created_at).toBe(job.started_at);
    expect(job.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // explicit UTC instant
    expect(job.retry.attempt).toBe(1);
    expect(job.summary).not.toBeNull();
    // Action ids are deterministic and rooted at the job id.
    for (const action of job.actions) {
      expect(action.action_id.startsWith(`${job.job_id}#`)).toBe(true);
    }
  });
});
