/**
 * The §7 repair classes (RL-035, spec/adcos-integration.md §7) exercised
 * end-to-end through the boundary with deterministic outcomes:
 *
 *   missed webhooks / duplicate webhooks / out-of-order events /
 *   stale projections / partially applied projections / transient failures.
 *
 * Every scenario drives the REAL pipeline (fake ADCOS -> signed webhook
 * deliveries -> durable inbox -> boundary projector -> projection engine ->
 * canonical scan) with the DeterministicClock, so outcomes are byte-stable.
 */
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest, parseRevision, parseUtcInstant } from "@roamlink/contracts";
import { parseAdcosIntentRequest } from "@roamlink/adcos";
import { createInMemoryPersistence } from "@roamlink/persistence";
import { AdcosProjectionEngine, InMemoryProjectionStore } from "@roamlink/projections";
import {
  AdcosWebhookInboxService,
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
  parseAdmittedWebhookRecord,
  ADCOS_WEBHOOK_INBOX_REPOSITORY,
  type AdcosWebhookProjector,
  type AdmittedWebhookEventView,
  type AdcosWebhookProjectionOutcome,
} from "@roamlink/webhook-inbox";
import { DeterministicClock } from "@roamlink/testkit";
import { BoundaryWebhookProjector, ReconciliationJobStore, AdcosReconciliationEngine } from "../src/index.js";
import {
  makeHarness,
  mustGetProjection,
  createIntentOnFake,
  TEST_INTENT_REQUEST,
  type Harness,
} from "./helpers.js";
import { FakeAdcos } from "../../integration/test/fake-adcos.js";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeWebhookDelivery,
} from "../../webhook-inbox/test/fake-adcos-webhooks.js";

function actionOf(
  job: { actions: readonly { action_type: string; resource_id?: string; outcome?: string; detail?: string; attempts?: number }[] },
  resourceId: string,
) {
  const found = job.actions.find(
    (action) => action.action_type === "CANONICAL_REFRESH" && action.resource_id === resourceId,
  );
  if (found === undefined) {
    throw new Error(`test expected a CANONICAL_REFRESH action for ${resourceId}`);
  }
  return found;
}

async function acceptOffersOnFake(harness: Harness, intentId: string, idempotencyKey: string): Promise<string> {
  const document = await harness.fake.acceptOffers(
    intentId,
    { offers: [{ offer: "offer-1" }], recorded_at: parseUtcInstant("2026-01-15T08:30:00.000Z") },
    { idempotencyKey: idempotencyKey as never },
  );
  return (document as { id: string }).id;
}

describe("§7 repair: missed webhooks", () => {
  it("a SILENT canonical-state change (no event) is repaired by canonical refresh", async () => {
    const harness = makeHarness();
    const intentId = await createIntentOnFake(harness, "idem-repair-missed-intent");
    const contractId = await acceptOffersOnFake(harness, intentId, "idem-repair-missed-offers");
    await harness.admit(harness.fake.deliveries());

    const job1 = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    expect(job1.status).toBe("COMPLETED");
    const contractAfterJob1 = await mustGetProjection(harness, "connectivity_contract", contractId);
    expect(contractAfterJob1.source_version).toBe(1);
    expect(contractAfterJob1.freshness_state).toBe("FRESH");

    // The authority moves on WITHOUT emitting any event (missed webhook).
    harness.fake.silentStateChange(contractId, "CONTRACT_ACTIVE");
    harness.clock.advanceBy(61_000); // TTL expiry: the miss becomes visible

    const job2 = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    expect(job2.status).toBe("COMPLETED");
    const sweep = job2.actions.find((action) => action.action_type === "FRESHNESS_SWEEP");
    expect(sweep?.outcome).toBe("REPAIRED");

    const repair = actionOf(job2, contractId);
    expect(repair.outcome).toBe("REPAIRED");
    expect(repair.detail).toContain("CANONICAL_READ_APPLIED");
    expect(repair.detail).toContain("source_version=2");

    const contract = await mustGetProjection(harness, "connectivity_contract", contractId);
    expect(contract.source_version).toBe(2);
    expect(contract.freshness_state).toBe("FRESH");
    expect(contract.evidence_class).toBe("AUTHENTICATED");
    expect((contract.payload as Record<string, unknown>)["state"]).toBe("CONTRACT_ACTIVE");
  });

  it("a NEVER-OBSERVED resource is discovered, fetched and projected (fully dropped first event)", async () => {
    const harness = makeHarness();
    const intentId = await createIntentOnFake(harness, "idem-repair-never-seen");
    await acceptOffersOnFake(harness, intentId, "idem-repair-never-seen-offers");
    // Admit NOTHING: every delivery was dropped before RoamLink existed.

    const job = await harness.boundary.reconciler.runJob({ reason: "startup" });
    expect(job.status).toBe("COMPLETED");

    const intentRepair = actionOf(job, intentId);
    expect(intentRepair.outcome).toBe("REPAIRED");
    expect(intentRepair.detail).toContain("CANONICAL_READ_APPLIED");

    const intent = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(intent.freshness_state).toBe("FRESH");
    expect(intent.evidence_class).toBe("AUTHENTICATED");
    // The canonical document (not an event envelope) is the projected truth.
    expect((intent.payload as Record<string, unknown>)["state"]).toBe("OFFER_SELECTED");
    expect((intent.payload as Record<string, unknown>)["id"]).toBe(intentId);
    expect(intent.received_at).toBe(harness.clock.now());
  });
});

describe("§7 repair: duplicate webhooks", () => {
  it("redelivered events never duplicate effects (dedupe + same-version skip)", async () => {
    const harness = makeHarness();
    const intentId = await createIntentOnFake(harness, "idem-repair-dupes");

    const first = await harness.admit(harness.fake.deliveries());
    expect(first).toEqual(["ADMITTED"]);
    const second = await harness.admit(harness.fake.deliveries()); // same event, new delivery
    expect(second).toEqual(["DUPLICATE"]);

    const job1 = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const drain1 = job1.actions.find((action) => action.action_type === "INBOX_DRAIN");
    expect(drain1?.outcome).toBe("REPAIRED");
    expect((drain1?.metrics as Record<string, number>)["applied"]).toBe(1);
    expect((drain1?.metrics as Record<string, number>)["considered"]).toBe(1);

    const intent = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(intent.projection_version).toBe(1); // exactly one apply, ever
    expect(intent.event_id).toBe("evt-1");

    // A second job re-verifies against canonical truth: still consistent.
    const job2 = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const drain2 = job2.actions.find((action) => action.action_type === "INBOX_DRAIN");
    expect((drain2?.metrics as Record<string, number>)["alreadyProjected"]).toBe(1);
    const still = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(still.projection_version).toBe(1); // no duplicate effect across jobs
  });
});

describe("§7 repair: out-of-order events", () => {
  it("reversed delivery order converges to the newest version (no regression)", async () => {
    const harness = makeHarness();
    const intentId = await createIntentOnFake(harness, "idem-repair-ooo");
    const contractId = await acceptOffersOnFake(harness, intentId, "idem-repair-ooo-offers");
    await harness.fake.activateContract(
      intentId,
      {
        activated_at: parseUtcInstant("2026-01-15T09:00:00.000Z"),
        signature_refs: ["sig-1" as never],
      },
      { idempotencyKey: "idem-repair-ooo-activate" as never },
    );

    harness.fake.webhookDelivery = { ...harness.fake.webhookDelivery, reorder: "reverse" };
    await harness.admit(harness.fake.deliveries()); // contract v2, contract v1, intent v1

    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    expect(job.status).toBe("COMPLETED");

    const contract = await mustGetProjection(harness, "connectivity_contract", contractId);
    expect(contract.source_version).toBe(2); // the newest version won
    expect(contract.projection_version).toBe(1); // v2 applied, v1 skipped: one write
    expect((contract.payload as Record<string, unknown>)["event_id"]).toBe("evt-3");

    const drain = job.actions.find((action) => action.action_type === "INBOX_DRAIN");
    expect((drain?.metrics as Record<string, number>)["applied"]).toBe(2); // contract v2 + intent v1
    expect((drain?.metrics as Record<string, number>)["skipped"]).toBe(1); // late v1 skipped
  });
});

describe("§7 repair: stale projections", () => {
  it("an expired guarantee is swept to STALE, then RENEWED by canonical re-observation", async () => {
    const harness = makeHarness({ policy: { discoveryEnabled: false } });
    const intentId = await createIntentOnFake(harness, "idem-repair-stale");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });

    const before = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(before.freshness_state).toBe("FRESH");
    const freshUntil = before.fresh_until;

    harness.clock.advanceBy(61_000); // guarantee expires
    const midSweep = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const renewal = actionOf(midSweep, intentId);
    expect(renewal.outcome).toBe("REPAIRED");
    expect(renewal.detail).toContain("FRESHNESS_RENEWED");

    const after = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(after.freshness_state).toBe("FRESH");
    expect(after.evidence_class).toBe("AUTHENTICATED");
    expect(after.fresh_until).not.toBe(freshUntil); // the guarantee was renewed
    expect(after.source_version).toBeNull(); // honest lineage after renewal
    // The projected truth is the canonical document of the same resource.
    expect((after.payload as Record<string, unknown>)["id"]).toBe(intentId);
    expect((after.payload as Record<string, unknown>)["state"]).toBe("INTENT");
  });
});

describe("§7 repair: partially applied projections", () => {
  it("a torn write (payload no longer digests to payload_digest) is replaced authoritatively", async () => {
    const harness = makeHarness({ policy: { discoveryEnabled: false } });
    const intentId = await createIntentOnFake(harness, "idem-repair-partial");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });

    // Simulate the torn write: the payload survived, the digest did not.
    const tornSource = await mustGetProjection(harness, "connectivity_intent", intentId);
    const torn = {
      ...tornSource,
      payload_digest: canonicalJsonDigest({ torn: true }),
      projection_version: parseRevision(tornSource.projection_version + 1),
    };
    await harness.store.apply(torn, tornSource.projection_version);
    const corrupted = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(canonicalJsonDigest(corrupted.payload)).not.toBe(corrupted.payload_digest);

    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const repair = actionOf(job, intentId);
    expect(repair.outcome).toBe("REPAIRED");
    expect(repair.detail).toContain("PARTIAL_APPLICATION_REPAIRED");

    const repaired = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(canonicalJsonDigest(repaired.payload)).toBe(repaired.payload_digest); // consistent again
    expect(repaired.freshness_state).toBe("FRESH");
    expect(repaired.source_version).toBeNull(); // authoritative replacement resets lineage
    expect((repaired.payload as Record<string, unknown>)["state"]).toBe("INTENT");
  });

  it("a crashed projector (projection applied, inbox status lagging) converges on the next job", async () => {
    // Manual composition: an inbox whose projector applies the projection and
    // THEN reports failure - the crash-between-projection-and-status scenario.
    const clock = new DeterministicClock("2026-01-15T08:30:00.000Z");
    const fake = new FakeAdcos({ seedProbe: false, now: () => clock.now() });
    const persistence = createInMemoryPersistence();
    const projectionStore = new InMemoryProjectionStore();
    const projectionEngine = new AdcosProjectionEngine({
      writer: projectionStore,
      reader: projectionStore,
      clock,
    });
    const realProjector = new BoundaryWebhookProjector(projectionEngine);
    let crashPending = true;
    const crashingProjector: AdcosWebhookProjector = {
      project: async (admission: AdmittedWebhookEventView): Promise<AdcosWebhookProjectionOutcome> => {
        const outcome = await realProjector.project(admission);
        if (crashPending) {
          crashPending = false;
          // The projection WAS applied; the crash loses the status update.
          return { outcome: "FAILED", reason: "SIMULATED_CRASH_AFTER_PROJECTION" };
        }
        return outcome;
      },
    };
    const verifierOptions = {
      environment: "sandbox" as const,
      keys: new StaticWebhookSigningKeyRegistry({ [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET }),
    };
    const inbox = new AdcosWebhookInboxService({
      verifier: new HmacWebhookVerifier(verifierOptions),
      persistence,
      reader: persistence,
      clock,
      projector: crashingProjector,
    });
    const engine = new AdcosReconciliationEngine({
      client: fake,
      projectionEngine,
      projectionReader: projectionStore,
      jobs: new ReconciliationJobStore(persistence, persistence),
      inbox,
      clock,
      tenantId: "org:00000000-0000-4000-8000-000000000001" as never,
      policy: { maxCanonicalReadAttempts: 1, inboxBatchLimit: 10, refreshMarginMs: 0, discoveryEnabled: false },
    });

    const intentDocument = await fake.createIntent(parseAdcosIntentRequest(TEST_INTENT_REQUEST), {
      idempotencyKey: "idem-crash-proj" as never,
    });
    const intentId = (intentDocument as { id: string }).id;
    const event = fake.emittedEvents()[0];
    if (event === undefined) throw new Error("test expected the fake to emit an event");
    const signed = fakeWebhookDelivery({
      spec: {
        eventId: event.event.event_id,
        eventType: event.event.event_type,
        resourceId: event.event.resource_id,
        resourceKind: event.event.resource_kind,
        resourceVersion: event.event.resource_version,
        occurredAt: event.event.occurred_at,
        correlationId: event.event.correlation_id,
        environment: "sandbox",
      },
      deliveryId: "dlv-crash-1",
      sequence: 1,
      receivedAt: clock.now(),
    });
    const admission = await inbox.admitDelivery({
      headers: signed.headers,
      payload: signed.payload,
      receivedAt: clock.now(),
    });
    expect(admission.outcome).toBe("ADMITTED");

    // The pre-crash drain: projection applied, then the crash loses the status.
    await inbox.processPending();
    const stored = await persistence
      .records(ADCOS_WEBHOOK_INBOX_REPOSITORY)
      .get(event.event.event_id);
    const crashedRecord = parseAdmittedWebhookRecord(stored?.value);
    expect(crashedRecord.processing.status).toBe("FAILED");
    expect(crashedRecord.processing.attempts).toBe(1);
    const projected = await projectionStore.get("connectivity_intent", intentId);
    expect(projected).not.toBeNull(); // the projection itself survived

    // The reconciler's drain retries the FAILED record and converges.
    const job = await engine.runJob({ reason: "crash-recovery" });
    expect(job.status).toBe("COMPLETED");
    const after = parseAdmittedWebhookRecord(
      (await persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).get(event.event.event_id))?.value,
    );
    expect(after.processing.status).toBe("PROJECTED");
    expect(after.processing.attempts).toBe(2);
    expect(after.processing.last_reason).toContain("SKIPPED");
    const converged = await projectionStore.get("connectivity_intent", intentId);
    expect(converged?.projection_version).toBe(1); // no duplicate apply
  });
});

describe("§7 repair: transient ADCOS/API failures", () => {
  it("exhausted transient retries degrade a FRESH record to STALE; the next job recovers", async () => {
    const harness = makeHarness({
      policy: { maxCanonicalReadAttempts: 2, refreshMarginMs: 120_000, discoveryEnabled: false },
    });
    const intentId = await createIntentOnFake(harness, "idem-repair-transient");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" }); // projected FRESH

    harness.fake.failNext({ kind: "adcos-error", code: "rate-limited" }, { count: 2 });
    const degradedJob = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    expect(degradedJob.status).toBe("COMPLETED"); // transient failures never fail the job
    const degradation = actionOf(degradedJob, intentId);
    expect(degradation.outcome).toBe("DEGRADED_STALE");
    expect(degradation.detail).toContain("rate-limited");
    expect(degradation.detail).toContain("cause=PROBE_FAILED");
    expect(degradation.attempts).toBe(2);

    const degraded = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(degraded.freshness_state).toBe("STALE");
    expect(degraded.evidence_class).toBe("STALE");
    // Never a guess: the prior payload is retained as known prior state.
    expect((degraded.payload as Record<string, unknown>)["event_id"]).toBe("evt-1");

    // Truth returns: the next job repairs and renews.
    const recoveryJob = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const recovery = actionOf(recoveryJob, intentId);
    expect(recovery.outcome).toBe("REPAIRED");
    expect(recovery.detail).toContain("FRESHNESS_RENEWED");
    const recovered = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(recovered.freshness_state).toBe("FRESH");
  });

  it("a transport timeout degrades with the TIMEOUT_OUTCOME_UNKNOWN cause", async () => {
    const harness = makeHarness({
      policy: { maxCanonicalReadAttempts: 1, refreshMarginMs: 120_000, discoveryEnabled: false },
    });
    const intentId = await createIntentOnFake(harness, "idem-repair-timeout");
    await harness.admit(harness.fake.deliveries());
    await harness.boundary.reconciler.runJob({ reason: "scheduled" });

    harness.fake.failNext({ kind: "transport", outcome: "unknown" }, { count: 1 });
    const job = await harness.boundary.reconciler.runJob({ reason: "scheduled" });
    const degradation = actionOf(job, intentId);
    expect(degradation.outcome).toBe("DEGRADED_STALE");
    expect(degradation.detail).toContain("transport-unknown");
    expect(degradation.detail).toContain("cause=TIMEOUT_OUTCOME_UNKNOWN");
    const degraded = await mustGetProjection(harness, "connectivity_intent", intentId);
    expect(degraded.freshness_state).toBe("STALE");
  });
});
