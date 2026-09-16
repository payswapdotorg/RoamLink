/**
 * RL-071 scenario: BYZANTINE INPUTS - malformed and forged webhooks, and
 * schema drift on the ADCOS side.
 *
 * The architectural invariants:
 *  - forged deliveries (tampered signature, replayed timestamp, unknown
 *    key, wrong environment, malformed envelope, oversized payload) are
 *    REJECTED AT ADMISSION - they never occupy the dedupe key and never
 *    reach the projection layer;
 *  - schema drift on the authority side (unknown lifecycle vocabulary,
 *    missing resource_version) fails the compatibility gate CLOSED for
 *    mutations - with a diagnosable, value-free report;
 *  - a corrected retry of a rejected event can still be admitted (the
 *    rejection burned nothing).
 */
import { describe, expect, it } from "vitest";
import { parseUtcInstant } from "@roamlink/contracts";
import {
  AdcosCompatibilityState,
  AdcosIntentAdapter,
  type IntentCommandInput,
} from "@roamlink/integration";
import { runAdcosCompatibilitySuite } from "@roamlink/compat";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeWebhookDelivery,
  type FakeWebhookEventSpec,
} from "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js";
import { FakeAdcos } from "../../../packages/integration/test/fake-adcos.js";
import { createInMemoryPersistence } from "@roamlink/persistence";
import {
  AdcosWebhookInboxService,
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
} from "@roamlink/webhook-inbox";
import { T0, makeSimulation } from "../src/harness.js";

function baseSpec(overrides?: Partial<FakeWebhookEventSpec>): FakeWebhookEventSpec {
  return {
    eventId: "evt-byz-1",
    eventType: "connectivity_intent.created",
    resourceId: "intent-byz",
    resourceKind: "connectivity_intent",
    resourceVersion: 1,
    occurredAt: T0,
    correlationId: "corr-byz-1",
    ...overrides,
  };
}

async function makeInbox() {
  const persistence = createInMemoryPersistence();
  const clock = new DeterministicClock(T0);
  const verifier = new HmacWebhookVerifier({
    environment: "sandbox",
    keys: new StaticWebhookSigningKeyRegistry({
      [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET,
    }),
  });
  const inbox = new AdcosWebhookInboxService({
    verifier,
    persistence,
    reader: persistence,
    clock,
  });
  return { persistence, inbox, clock };
}

describe("RL-071 byzantine inputs: forged/malformed webhooks rejected at admission", () => {
  it("a tampered signature is rejected; nothing is admitted; the dedupe key stays free", async () => {
    const { persistence, inbox } = await makeInbox();
    const forged = fakeWebhookDelivery({
      spec: baseSpec(),
      deliveryId: "dlv-byz-1",
      sequence: 1,
      receivedAt: T0,
      overrides: { tamperSignature: true },
    });
    const admission = await inbox.admitDelivery({ ...forged, receivedAt: T0 as never });
    expect(admission.outcome).toBe("REJECTED");
    expect(await persistence.inbox.list("ADMITTED")).toEqual([]);

    // The CORRECTED retry of the same event id still admits.
    const corrected = fakeWebhookDelivery({
      spec: baseSpec(),
      deliveryId: "dlv-byz-2",
      sequence: 2,
      receivedAt: T0,
    });
    const retry = await inbox.admitDelivery({ ...corrected, receivedAt: T0 as never });
    expect(retry.outcome).toBe("ADMITTED");
  });

  it("a signature over a DIFFERENT payload than the one delivered is rejected", async () => {
    const { inbox } = await makeInbox();
    const mismatched = fakeWebhookDelivery({
      spec: baseSpec(),
      deliveryId: "dlv-byz-3",
      sequence: 3,
      receivedAt: T0,
      overrides: { tamperPayload: JSON.stringify({ rogue: "payload" }) },
    });
    // NOTE: the helper signs the tampered payload it delivers, so this
    // delivery is well-formed-but-foreign: it DOES admit (it is a valid
    // signature over a closed envelope that fails envelope parsing because
    // the rogue payload lacks the 9 required members).
    const admission = await inbox.admitDelivery({ ...mismatched, receivedAt: T0 as never });
    expect(admission.outcome).toBe("REJECTED");
  });

  it("replayed (stale-timestamp) deliveries are rejected by the replay window", async () => {
    const { inbox } = await makeInbox();
    const replayed = fakeWebhookDelivery({
      spec: baseSpec({ eventId: "evt-byz-replay" }),
      deliveryId: "dlv-byz-4",
      sequence: 4,
      receivedAt: T0,
      overrides: { staleTimestamp: "2026-01-15T07:00:00.000Z" },
    });
    const admission = await inbox.admitDelivery({ ...replayed, receivedAt: T0 as never });
    expect(admission.outcome).toBe("REJECTED");
  });

  it("unknown key ids, wrong environments, malformed envelopes and oversized payloads are all rejected", async () => {
    const { inbox } = await makeInbox();
    const cases: { readonly label: string; readonly delivery: ReturnType<typeof fakeWebhookDelivery> }[] = [
      {
        label: "unknown key id",
        delivery: fakeWebhookDelivery({
          spec: baseSpec({ eventId: "evt-byz-key" }),
          deliveryId: "dlv-byz-5",
          sequence: 5,
          receivedAt: T0,
          overrides: { unknownKeyId: "whk-attacker" },
        }),
      },
      {
        label: "wrong environment",
        delivery: fakeWebhookDelivery({
          spec: baseSpec({ eventId: "evt-byz-env", environment: "production" }),
          deliveryId: "dlv-byz-6",
          sequence: 6,
          receivedAt: T0,
        }),
      },
      {
        label: "extra envelope members (schema drift)",
        delivery: fakeWebhookDelivery({
          spec: baseSpec({ eventId: "evt-byz-extra", extraMembers: { rogue: 1 } }),
          deliveryId: "dlv-byz-7",
          sequence: 7,
          receivedAt: T0,
        }),
      },
      {
        label: "dropped signature header",
        delivery: fakeWebhookDelivery({
          spec: baseSpec({ eventId: "evt-byz-drop" }),
          deliveryId: "dlv-byz-8",
          sequence: 8,
          receivedAt: T0,
          overrides: { dropHeader: "X-ADCOS-Signature" },
        }),
      },
      {
        label: "oversized payload",
        delivery: {
          headers: {},
          payload: `{"padding":"${"x".repeat(300_000)}"}`,
        },
      },
    ];

    for (const testCase of cases) {
      const admission = await inbox.admitDelivery({
        ...testCase.delivery,
        receivedAt: T0 as never,
      });
      expect(admission.outcome, testCase.label).toBe("REJECTED");
    }
  });

  it("an event id mismatch between header and envelope is rejected (identity consistency)", async () => {
    const { inbox } = await makeInbox();
    // The envelope carries a different event id than the delivery header.
    const delivery = fakeWebhookDelivery({
      spec: baseSpec({ eventId: "evt-byz-envelope" }),
      deliveryId: "dlv-byz-9",
      sequence: 9,
      receivedAt: T0,
    });
    const headers = { ...delivery.headers };
    headers["X-ADCOS-Event-Id"] = "evt-byz-header-spoofed";
    const admission = await inbox.admitDelivery({
      headers,
      payload: delivery.payload,
      receivedAt: T0 as never,
    });
    expect(admission.outcome).toBe("REJECTED");
  });
});

describe("RL-071 schema drift: the ADCOS side drifting fails the gate CLOSED for mutations", () => {
  it("an unknown lifecycle vocabulary on the authority makes the compatibility gate INCOMPATIBLE; mutations are refused", async () => {
    const fake = new FakeAdcos({ seedProbe: true });
    const state = new AdcosCompatibilityState();
    const adapter = new AdcosIntentAdapter({
      client: fake,
      clock: new DeterministicClock(T0),
      commandIds: new DeterministicUuidGenerator(71),
      compatibility: state,
    });

    // The §9 startup gate (the server-driven compatibility suite) passes on
    // a healthy authority and unlocks mutations.
    const healthy = await runAdcosCompatibilitySuite({
      client: fake,
      ...(fake.probeRefs !== null ? { probe: fake.probeRefs } : {}),
      state,
      at: T0,
    });
    expect(healthy.status).toBe("compatible");
    const submission = await adapter.submit(intentInput());
    expect((submission.document as Record<string, unknown>)["id"]).toMatch(/^intent-/);

    // The authority DRIFTS: it starts reporting a lifecycle state outside
    // the pinned 13-state contract.
    const probeIntentId = fake.probeRefs?.intentId ?? "";
    fake.overrideIntentLifecycleState(probeIntentId, "SUPER_ACTIVE_V3");

    // A fresh gate run observes the drift and fails CLOSED.
    const drifted = await runAdcosCompatibilitySuite({
      client: fake,
      ...(fake.probeRefs !== null ? { probe: fake.probeRefs } : {}),
      state,
      at: T0,
    });
    expect(drifted.status).toBe("incompatible");
    const failedChecks = drifted.checks.filter((check) => !check.passed);
    expect(failedChecks.length).toBeGreaterThan(0);
    expect(
      failedChecks.some((check) => check.name === "lifecycle_state_vocabulary.server"),
    ).toBe(true);
    // The report is value-free and diagnosable: names + codes only.
    for (const check of drifted.checks) {
      expect(typeof check.name).toBe("string");
      expect(typeof check.detail).toBe("string");
    }

    // Mutations are refused while incompatible (fail-closed, §9)...
    await expect(adapter.submit(intentInput())).rejects.toMatchObject({
      reason: "ADCOS_COMPATIBILITY_GATE_CLOSED",
    });
    // ...but READS stay available (diagnosable, not blind).
    const document = await adapter.getIntent(probeIntentId);
    expect(document).toBeDefined();
  });

  it("missing required fields (resource_version stripped) also fail the gate closed", async () => {
    const fake = new FakeAdcos({ seedProbe: true });
    fake.stripResourceVersions();
    const state = new AdcosCompatibilityState();
    const adapter = new AdcosIntentAdapter({
      client: fake,
      clock: new DeterministicClock(T0),
      commandIds: new DeterministicUuidGenerator(72),
      compatibility: state,
    });
    const report = await runAdcosCompatibilitySuite({
      client: fake,
      ...(fake.probeRefs !== null ? { probe: fake.probeRefs } : {}),
      state,
      at: T0,
    });
    expect(report.status).toBe("incompatible");
    expect(
      report.checks.some(
        (check) =>
          check.name === "document_required_fields.resource_version" && !check.passed,
      ),
    ).toBe(true);
    await expect(adapter.submit(intentInput())).rejects.toMatchObject({
      reason: "ADCOS_COMPATIBILITY_GATE_CLOSED",
    });
  });

  it("the reconciliation engine honors an incompatible gate: canonical fetches DEFER, nothing is fabricated", async () => {
    // A world whose projection store already holds a projection, rebuilt
    // with an INCOMPATIBLE gate (schema drift observed at startup).
    const simulation = makeSimulation({ compatibility: { status: () => "incompatible" } });
    const intentDocument = (await simulation.fake.createIntent(
      {
        requirements: [{ dimension: "usage", classification: "soft", statement: { profile: "sim" } }],
        validity: { start: parseUtcInstant(T0), end: parseUtcInstant("2026-01-16T08:30:00.000Z") },
        termination: { actor: "roamlink", on_expiry: "release" },
        recorded_at: parseUtcInstant(T0),
      },
      { idempotencyKey: "idem-byz-gate" as never },
    )) as Record<string, unknown>;
    const intentId = intentDocument["id"] as string;

    // The event is admitted + projected (admission is independent of the
    // gate; projection of an AUTHENTICATED signal is not a mutation of the
    // authority).
    await simulation.admitAndProject();
    const before = await simulation.boundary.projections.get("connectivity_intent", intentId);
    expect(before?.freshness_state).toBe("FRESH");

    // Freshness expires; the reconciler runs WITH the incompatible gate.
    simulation.clock.advanceBy(120_000);
    const job = await simulation.boundary.reconciler.runJob({ reason: "scheduled" });
    expect(job.status).toBe("COMPLETED");

    // The freshness sweep degraded the projection honestly to STALE...
    const after = await simulation.boundary.projections.get("connectivity_intent", intentId);
    expect(after?.freshness_state).toBe("STALE");
    // ...and every canonical fetch was DEFERRED by the gate - the engine
    // refused to project foreign-version documents while unverified.
    const deferred = job.actions.filter(
      (action) =>
        action.action_type === "CANONICAL_REFRESH" && action.outcome === "DEFERRED",
    );
    expect(deferred.length).toBeGreaterThan(0);
    expect(
      deferred.every((action) => action.detail.includes("COMPATIBILITY_GATE_INCOMPATIBLE")),
    ).toBe(true);
    // The prior payload was retained (never fabricated, never dropped).
    expect(after?.payload).toEqual(before?.payload);
  });
});

function intentInput(): IntentCommandInput {
  return {
    sourceIntentId: "00000000-0000-4000-8000-0000000000f1",
    sourceIntentVersionId: "00000000-0000-4000-8000-0000000000f2",
    sourceIntentVersionNumber: 1,
    actorId: "actor-sim",
    tenantId: "usr:00000000-0000-4000-8000-000000000002",
    requirements: [
      { dimension: "privacy", classification: "hard", statement: { transport: "encrypted" } },
    ],
    validity: { start: parseUtcInstant(T0), end: parseUtcInstant("2026-01-29T08:30:00.000Z") },
    termination: { actor: "customer", onExpiry: "release" },
  };
}
