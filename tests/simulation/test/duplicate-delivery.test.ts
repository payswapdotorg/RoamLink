/**
 * RL-071 scenario: DUPLICATE command delivery at EVERY boundary.
 *
 * The same logical command arrives twice (transport retry, webhook
 * redelivery, client retry). The architectural invariant: NO DUPLICATE
 * EFFECTS - exactly one aggregate, one event, one projection write, one
 * notification, one job execution - and honest duplicate acknowledgements
 * (the duplicate caller learns the original outcome).
 *
 * Boundaries simulated:
 *  1. the intent adapter (RoamLink -> ADCOS): timeout with UNKNOWN
 *     outcome, then re-issue with the same idempotency key;
 *  2. the webhook inbox (ADCOS -> RoamLink): duplicateFactor=2 deliveries;
 *  3. the commerce commands (order + payment): the same §5 envelope twice;
 *  4. the reconciliation engine: the same job id re-run after completion;
 *  5. the edge outbox: the same command re-enqueued while offline.
 */
import { describe, expect, it } from "vitest";
import {
  AdcosCompatibilityState,
  AdcosIntentAdapter,
  type IntentCommandInput,
} from "@roamlink/integration";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";
import { parseUtcInstant } from "@roamlink/contracts";
import {
  EdgeOfflineOutbox,
  InMemoryEdgeOutboxStore,
  makeEdgeOutboxRetryPolicy,
} from "@roamlink/edge";
import { DeviceActionRequest } from "@roamlink/edge";
import { makeFreshness } from "@roamlink/contracts";
import {
  ORDER_ID,
  PAYMENT_ID,
  T0,
  USER_TENANT,
  makeSimulation,
  seedPlacedOrder,
} from "../src/harness.js";
import { FakeAdcos } from "../../../packages/integration/test/fake-adcos.js";

const INTENT_INPUT: IntentCommandInput = {
  sourceIntentId: "00000000-0000-4000-8000-0000000000b1",
  sourceIntentVersionId: "00000000-0000-4000-8000-0000000000b2",
  sourceIntentVersionNumber: 1,
  actorId: "actor-sim",
  tenantId: "usr:00000000-0000-4000-8000-000000000002",
  requirements: [
    { dimension: "privacy", classification: "hard", statement: { transport: "encrypted" } },
  ],
  validity: { start: parseUtcInstant(T0), end: parseUtcInstant("2026-01-29T08:30:00.000Z") },
  termination: { actor: "customer", onExpiry: "release" },
};

describe("RL-071 duplicate delivery at every boundary (no duplicate effects)", () => {
  it("intent adapter: a timeout with UNKNOWN outcome, then re-issue with the same key -> ONE intent, original document", async () => {
    const fake = new FakeAdcos({ seedProbe: true });
    const adapter = new AdcosIntentAdapter({
      client: fake,
      clock: new DeterministicClock(T0),
      commandIds: new DeterministicUuidGenerator(41),
      compatibility: new AdcosCompatibilityState(),
    });
    await adapter.runCompatibilityCheck(fake.probeRefs ?? undefined, T0);
    const baseline = fake.intentCount(); // seed + compatibility probes

    // The command was dispatched; the response was LOST (post-fault). The
    // fake APPLIED it, then the transport "timed out".
    fake.failNext({ kind: "transport", outcome: "unknown" }, { phase: "post" });
    await expect(adapter.submit(INTENT_INPUT)).rejects.toMatchObject({
      reason: "ADCOS_TIMEOUT_OUTCOME_UNKNOWN",
    });

    // The re-issue carries the SAME idempotency key (derived from the source
    // intent version + digest): the fake replays the ORIGINAL response - no
    // second intent exists.
    const submission = await adapter.submit(INTENT_INPUT);
    expect(fake.intentCount()).toBe(baseline + 1);
    const document = submission.document as Record<string, unknown>;
    const directRead = await fake.getIntent(document["id"] as never);
    expect((directRead as Record<string, unknown>)["id"]).toBe(document["id"]);

    // A third delivery of the same command: still one intent.
    await adapter.submit(INTENT_INPUT);
    expect(fake.intentCount()).toBe(baseline + 1);
  });

  it("webhook inbox: duplicate deliveries admit once, project once, advance the projection version once", async () => {
    const simulation = makeSimulation();
    simulation.fake.webhookDelivery = { duplicateFactor: 2, reorder: "none", dropCount: 0, delayCount: 0 };
    await simulation.fake.createIntent(
      { requirements: [{ dimension: "usage", classification: "soft", statement: { profile: "sim" } }], validity: { start: parseUtcInstant(T0), end: parseUtcInstant("2026-01-16T08:30:00.000Z") }, termination: { actor: "roamlink", on_expiry: "release" }, recorded_at: parseUtcInstant(T0) },
      { idempotencyKey: "idem-dup-intent" as never },
    );

    const deliveries = simulation.fake.deliveries();
    expect(deliveries.length).toBe(2); // the same event, delivered twice
    const outcomes = await simulation.admitAll();
    expect(outcomes).toEqual(["ADMITTED", "DUPLICATE"]);

    // The async projection step: the duplicate was never admitted, so the
    // report processes exactly ONE record.
    const report = await simulation.boundary.inbox.processPending();
    expect(report.considered).toBe(1);
    expect(report.applied).toBe(1);

    // Re-running the drain is idempotent (already PROJECTED).
    const again = await simulation.boundary.inbox.processPending();
    expect(again.considered).toBe(1);
    expect(again.alreadyProjected).toBe(1);

    const intentId = (deliveries[0]?.event.resource_id ?? "") as string;
    const projection = await simulation.boundary.projections.get("connectivity_intent", intentId);
    expect(projection).not.toBeNull();
    expect(projection?.projection_version).toBe(1); // advanced exactly once
    expect(projection?.source_version).toBe(1);
  });

  it("commerce commands: the same envelope twice -> one order placed once, one payment recorded once", async () => {
    const simulation = makeSimulation();
    await seedPlacedOrder(simulation);

    // The order exists exactly once; the event chain holds exactly one
    // order.placed (proven by the seed's own discipline). Now the payment,
    // delivered twice with the SAME envelope:
    const envelope = simulation.envelope({ key: "idem-pay-dup" });
    const input = {
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: { amountMinorUnits: 999, currency: "USD" },
    };
    const first = await simulation.commerce.payments.recordPayment(envelope, input);
    const second = await simulation.commerce.payments.recordPayment(envelope, input);
    expect(second).toEqual(first);

    const payments = await simulation.commerce.store.read.payments.listForOrder(
      USER_TENANT,
      ORDER_ID as never,
    );
    expect(payments.length).toBe(1);

    // The succeed TRANSITION is its own command: a different envelope,
    // also delivered twice - one transition, the original outcome replayed.
    const transitionEnvelope = simulation.envelope({ key: "idem-pay-succeed" });
    const transitionInput = { paymentId: PAYMENT_ID, expectedRevision: 1, transition: "succeed" as const };
    const succeeded = await simulation.commerce.payments.transitionPayment(transitionEnvelope, transitionInput);
    const reTransition = await simulation.commerce.payments.transitionPayment(transitionEnvelope, transitionInput);
    expect(reTransition).toEqual(succeeded);

    const finalPayment = await simulation.commerce.store.read.payments.findById(USER_TENANT, PAYMENT_ID as never);
    expect(finalPayment?.status).toBe("succeeded");
    expect(finalPayment?.revision).toBe(2); // recorded + succeeded, exactly once each
  });

  it("reconciliation engine: re-running a COMPLETED job returns the recorded outcome with NO new effects", async () => {
    const simulation = makeSimulation();
    const first = await simulation.boundary.reconciler.runJob({ reason: "manual" });
    expect(first.status).toBe("COMPLETED");

    const second = await simulation.boundary.reconciler.runJob({
      jobId: first.job_id,
      reason: "manual",
    });
    expect(second.status).toBe("COMPLETED");
    expect(second.actions).toEqual(first.actions); // nothing re-executed
    expect(second.job_id).toBe(first.job_id);

    // Exactly one durable job record exists.
    const jobs = await simulation.boundary.reconciler.listJobs();
    expect(jobs.length).toBe(1);
  });

  it("edge outbox: the same command re-enqueued while offline is a no-op (ALREADY_ENQUEUED)", async () => {
    const outbox = makeOutbox();
    const request = makeActionRequest(11);
    const first = await outbox.enqueue(request, context(), T0);
    expect(first.outcome).toBe("ENQUEUED");
    const second = await outbox.enqueue(request, context(), T0);
    expect(second.outcome).toBe("ALREADY_ENQUEUED");

    // A DIFFERENT command under the same idempotency key is a typed conflict
    // (never a second effect).
    const clash = new DeviceActionRequest({
      actionId: "00000000-0000-4000-8000-000000000077",
      capabilityRequirement: { capability: "wifi_control", minimumEvidenceClass: "OBSERVED" },
      parameters: { network: "other-network" },
      command: {
        commandId: "00000000-0000-4000-8000-000000000078",
        correlationId: "corr-edge-clash",
        idempotencyKey: "idem-edge-11", // the SAME key as the first command
        actorId: "actor-edge",
        tenantId: "usr:00000000-0000-4000-8000-000000000002",
        createdAt: T0,
        retry: { attempt: 1 },
      },
      dedupeKey: "action-11-clash",
    });
    await expect(outbox.enqueue(clash, context(), T0)).rejects.toMatchObject({
      reason: "EDGE_OUTBOX_IDEMPOTENCY_CONFLICT",
    });
  });
});

// --- edge fixtures -------------------------------------------------------------

function makeOutbox(): EdgeOfflineOutbox {
  const ids = new DeterministicUuidGenerator(51);
  return new EdgeOfflineOutbox({
    store: new InMemoryEdgeOutboxStore(),
    cipher: new TestCipher(),
    keyId: "edge-key-1",
    idGenerator: () => ids.next(),
    defaultRetryPolicy: makeEdgeOutboxRetryPolicy({
      maxAttempts: 5,
      initialBackoffMs: 1_000,
      backoffMultiplier: 2,
      maxBackoffMs: 60_000,
    }),
  });
}

class TestCipher {
  readonly algorithm = "test-cipher";
  async encrypt(_keyId: string, plaintext: string): Promise<string> {
    return Buffer.from(plaintext, "utf8").toString("base64url");
  }
  async decrypt(_keyId: string, ciphertext: string): Promise<string> {
    return Buffer.from(ciphertext, "base64url").toString("utf8");
  }
}

function context() {
  return {
    deviceRef: "dev:00000000-0000-4000-8000-0000000000c1",
    desiredStateId: "00000000-0000-4000-8000-0000000000c2",
    lastKnownFreshness: makeFreshness(
      {
        observedAt: parseUtcInstant(T0),
        receivedAt: parseUtcInstant(T0),
        freshUntil: parseUtcInstant("2026-01-15T08:31:00.000Z"),
      },
      parseUtcInstant(T0),
    ),
  };
}

function makeActionRequest(seed: number, parameters?: Record<string, unknown>) {
  return new DeviceActionRequest({
    actionId: `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`,
    capabilityRequirement: { capability: "wifi_control", minimumEvidenceClass: "OBSERVED" },
    parameters: parameters ?? { network: `net-${seed}` },
    command: {
      commandId: `00000000-0000-4000-8000-${(seed + 100).toString(16).padStart(12, "0")}`,
      correlationId: `corr-edge-${seed}`,
      idempotencyKey: `idem-edge-${seed}`,
      actorId: "actor-edge",
      tenantId: "usr:00000000-0000-4000-8000-000000000002",
      createdAt: T0,
      retry: { attempt: 1 },
    },
    dedupeKey: `action-${seed}`,
  });
}
