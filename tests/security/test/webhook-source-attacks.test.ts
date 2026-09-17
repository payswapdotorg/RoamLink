/**
 * RL-074 suite 1: WEBHOOK SOURCE ATTACKS (spec/security.md "Webhooks";
 * spec/adcos-integration.md §6 admission rules; spec/api.md "Webhooks").
 *
 * Threat priority #1 (forged/replayed ADCOS webhooks) plus the
 * customer-facing emission discipline. Every attack is a NEGATIVE PROOF:
 * the attack fixture MUST be rejected at inbox admission (or at the emit
 * boundary for customer-facing webhooks), with the durable state provably
 * untouched.
 *
 * Attack catalog (each must FAIL CLOSED):
 *   W-1  forged signature (tampered hex, and a signature computed with an
 *        attacker-controlled secret under a REGISTERED key id);
 *   W-2  unknown signing key id;
 *   W-3  replayed event id after successful admission (dedupe);
 *   W-4  timestamp outside the replay window (stale AND future-stamped);
 *   W-5  invalid schema version (api_version 3.0 envelope);
 *   W-6  oversized payload (> 256 KiB admission limit);
 *   W-7  environment mismatch (production envelope into a sandbox scope);
 *   W-8  malformed closed envelope (extra member / non-JSON);
 *   W-9  header/envelope event-id mismatch (signed payload vs headers);
 *   W-10 missing required headers.
 *
 * Emission discipline (spec/api.md: customer webhooks are emitted only
 * from verified durable RoamLink state transitions):
 *   W-11 a raw ADCOS-event-shaped payload CANNOT pass the durable-transition
 *        origin contract (notifications AND enterprise customer webhooks);
 *   W-12 a legitimate durable transition emits an HMAC-authenticated,
 *        replay-protected customer webhook delivery that VERIFIES at the
 *        receiving end; redelivery of the same event dedupes.
 */
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_WEBHOOK_HEADER_NAMES,
  verifyCustomerWebhookDelivery,
  type CustomerWebhookKeyRegistry,
} from "@roamlink/enterprise";
import { createEnterpriseApiHarness } from "@roamlink/enterprise";
import { ValidationError } from "@roamlink/contracts";
import { ADCOS_WEBHOOK_INBOX_REPOSITORY } from "@roamlink/webhook-inbox";
import {
  FAKE_HEADER_NAMES,
  fakeEventPayload,
} from "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js";
import {
  DeliveryIds,
  STEP_MS,
  T0,
  instantPlusMs,
  makeSecurityWorld,
  registerPrincipal,
  webhookEventSpec,
  type SecurityWorld,
} from "../src/harness.js";

/** Count of admitted inbox records (the durable rejection proof). */
async function admittedCount(world: SecurityWorld): Promise<number> {
  return world.persistence.inbox.count("ADMITTED");
}

/** Count of rejection audit rows the inbox wrote. */
async function rejectedCount(world: SecurityWorld): Promise<number> {
  return world.persistence.inbox.count("REJECTED");
}

/** Count of extended inbox records persisted for admitted events. */
async function extendedRecords(world: SecurityWorld): Promise<number> {
  return world.persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).count();
}

describe("RL-074 suite 1: ADCOS webhook source attacks are rejected at inbox admission", () => {
  it("W-0 positive control: a correctly signed delivery admits (the suite can pass)", async () => {
    const world = makeSecurityWorld();
    const deliveries = new DeliveryIds("ctrl");
    const delivery = world.signedDelivery({
      spec: webhookEventSpec({ eventId: "evt-control-1" }),
      deliveryId: deliveries.next(),
      sequence: 1,
    });
    const admission = await world.admit(delivery);
    expect(admission.outcome).toBe("ADMITTED");
    expect(await admittedCount(world)).toBe(1);
    expect(await extendedRecords(world)).toBe(1);
  });

  it("W-1a a tampered signature is rejected and nothing durable is written", async () => {
    const world = makeSecurityWorld();
    const deliveries = new DeliveryIds("forged");
    const spec = webhookEventSpec({ eventId: "evt-forged-1" });
    const { fakeWebhookDelivery } = await import(
      "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js"
    );
    const delivery = fakeWebhookDelivery({
      spec,
      deliveryId: deliveries.next(),
      sequence: 1,
      receivedAt: world.clock.now(),
      overrides: { tamperSignature: true },
    });
    const admission = await world.admit(delivery);
    expect(admission.outcome).toBe("REJECTED");
    if (admission.outcome === "REJECTED") {
      expect(admission.code).toBe("webhook-signature-invalid");
    }
    // NEGATIVE PROOF: no admission, no extended record, no projection.
    expect(await admittedCount(world)).toBe(0);
    expect(await extendedRecords(world)).toBe(0);
    expect(await world.projectionStore.count()).toBe(0);
    // The rejection itself is durably recorded (audit row).
    expect(await rejectedCount(world)).toBe(1);
  });

  it("W-1b a signature computed with an ATTACKER secret under a registered key id is rejected", async () => {
    const world = makeSecurityWorld();
    const deliveries = new DeliveryIds("attacker-key");
    const { fakeWebhookDelivery } = await import(
      "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js"
    );
    const delivery = fakeWebhookDelivery({
      spec: webhookEventSpec({ eventId: "evt-attacker-1" }),
      deliveryId: deliveries.next(),
      sequence: 1,
      receivedAt: world.clock.now(),
      secret: "attacker-controlled-secret-material",
    });
    const admission = await world.admit(delivery);
    expect(admission.outcome).toBe("REJECTED");
    if (admission.outcome === "REJECTED") {
      expect(admission.code).toBe("webhook-signature-invalid");
    }
    expect(await admittedCount(world)).toBe(0);
    expect(await extendedRecords(world)).toBe(0);
  });

  it("W-2 an unknown signing key id fails authentication (fail-closed, no existence oracle)", async () => {
    const world = makeSecurityWorld();
    const deliveries = new DeliveryIds("unknown-key");
    const { fakeWebhookDelivery } = await import(
      "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js"
    );
    const delivery = fakeWebhookDelivery({
      spec: webhookEventSpec({ eventId: "evt-unknown-key-1" }),
      deliveryId: deliveries.next(),
      sequence: 1,
      receivedAt: world.clock.now(),
      overrides: { unknownKeyId: "whk-attacker-unknown" },
    });
    const admission = await world.admit(delivery);
    expect(admission.outcome).toBe("REJECTED");
    if (admission.outcome === "REJECTED") {
      expect(admission.code).toBe("authentication-invalid");
    }
    expect(await admittedCount(world)).toBe(0);
  });

  it("W-3 a replayed event id is deduplicated: exactly one admission, one record, one projection effect", async () => {
    const world = makeSecurityWorld();
    const deliveries = new DeliveryIds("replay");
    const spec = webhookEventSpec({ eventId: "evt-replay-1" });
    const first = await world.admit(
      world.signedDelivery({ spec, deliveryId: deliveries.next(), sequence: 1 }),
    );
    expect(first.outcome).toBe("ADMITTED");

    // The attacker re-delivers the SAME event (fresh delivery id + signature,
    // byte-identical event envelope - the replay): the dedupe key is the
    // event id.
    const replay = await world.admit(
      world.signedDelivery({ spec, deliveryId: deliveries.next(), sequence: 2 }),
    );
    expect(replay.outcome).toBe("DUPLICATE");
    if (replay.outcome === "DUPLICATE") {
      expect(replay.eventId).toBe("evt-replay-1");
    }

    // Exactly one durable admission + one extended record + one projection.
    expect(await admittedCount(world)).toBe(1);
    expect(await extendedRecords(world)).toBe(1);
    await world.boundary.inbox.processPending();
    expect(await world.projectionStore.count()).toBe(1);
    // Re-processing the whole inbox is a no-op (idempotent projection).
    const report = await world.boundary.inbox.processPending();
    expect(report.applied).toBe(0);
    expect(report.alreadyProjected).toBe(1);
  });

  it("W-4 a delivery timestamp outside the replay window is rejected (stale AND future-stamped)", async () => {
    const world = makeSecurityWorld({ startAt: T0 });
    const deliveries = new DeliveryIds("stale");
    const { fakeWebhookDelivery } = await import(
      "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js"
    );

    // Stale: timestamp 10 minutes before receipt (window is 300s).
    const stale = await world.admit(
      fakeWebhookDelivery({
        spec: webhookEventSpec({ eventId: "evt-stale-1", occurredAt: instantPlusMs(T0, -600_000) }),
        deliveryId: deliveries.next(),
        sequence: 1,
        receivedAt: world.clock.now(),
      }),
    );
    expect(stale.outcome).toBe("REJECTED");
    if (stale.outcome === "REJECTED") {
      expect(stale.code).toBe("webhook-timestamp-stale");
    }

    // Future-stamped: timestamp 10 minutes AHEAD of receipt (both directions).
    const future = await world.admit(
      fakeWebhookDelivery({
        spec: webhookEventSpec({ eventId: "evt-future-1", occurredAt: instantPlusMs(T0, 600_000) }),
        deliveryId: deliveries.next(),
        sequence: 2,
        receivedAt: world.clock.now(),
      }),
    );
    expect(future.outcome).toBe("REJECTED");
    if (future.outcome === "REJECTED") {
      expect(future.code).toBe("webhook-timestamp-stale");
    }
    expect(await admittedCount(world)).toBe(0);
  });

  it("W-5 an envelope from an unsupported schema version line is rejected (fail-closed contract gate)", async () => {
    const world = makeSecurityWorld();
    const deliveries = new DeliveryIds("version");
    const admission = await world.admit(
      world.signedDelivery({
        spec: webhookEventSpec({ eventId: "evt-version-1", apiVersion: "3.0" }),
        deliveryId: deliveries.next(),
        sequence: 1,
      }),
    );
    expect(admission.outcome).toBe("REJECTED");
    if (admission.outcome === "REJECTED") {
      expect(admission.code).toBe("version-unsupported");
    }
    expect(await admittedCount(world)).toBe(0);
  });

  it("W-6 an oversized payload is rejected by the admission size limit", async () => {
    const world = makeSecurityWorld();
    const deliveries = new DeliveryIds("oversize");
    const { fakeWebhookDelivery } = await import(
      "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js"
    );
    // A correctly SIGNED payload of > 256 KiB: the size policy fires before
    // any parsing (spec/security.md "payload-size limits").
    const oversized =
      fakeEventPayload(webhookEventSpec({ eventId: "evt-oversize-1" })) + " ".repeat(300_000);
    const admission = await world.admit(
      fakeWebhookDelivery({
        spec: webhookEventSpec({ eventId: "evt-oversize-1" }),
        deliveryId: deliveries.next(),
        sequence: 1,
        receivedAt: world.clock.now(),
        overrides: { tamperPayload: oversized },
      }),
    );
    expect(admission.outcome).toBe("REJECTED");
    if (admission.outcome === "REJECTED") {
      expect(admission.code).toBe("invalid-input");
    }
    expect(await admittedCount(world)).toBe(0);
  });

  it("W-7 a production environment envelope into a sandbox-scoped verifier is rejected", async () => {
    const world = makeSecurityWorld();
    const deliveries = new DeliveryIds("env");
    const admission = await world.admit(
      world.signedDelivery({
        spec: webhookEventSpec({ eventId: "evt-env-1", environment: "production" }),
        deliveryId: deliveries.next(),
        sequence: 1,
      }),
    );
    expect(admission.outcome).toBe("REJECTED");
    if (admission.outcome === "REJECTED") {
      expect(admission.code).toBe("environment-mismatch");
    }
    expect(await admittedCount(world)).toBe(0);
  });

  it("W-8 a malformed envelope (extra member, non-JSON) is rejected after authentication", async () => {
    const world = makeSecurityWorld();
    const deliveries = new DeliveryIds("malformed");
    const { fakeWebhookDelivery } = await import(
      "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js"
    );

    // Extra member: the closed 9-member envelope rejects it.
    const extraMember = await world.admit(
      world.signedDelivery({
        spec: webhookEventSpec({
          eventId: "evt-extra-1",
          extraMembers: { injection: "attacker-controlled" },
        }),
        deliveryId: deliveries.next(),
        sequence: 1,
      }),
    );
    expect(extraMember.outcome).toBe("REJECTED");
    if (extraMember.outcome === "REJECTED") {
      expect(extraMember.code).toBe("webhook-signature-invalid");
    }

    // Non-JSON payload, correctly signed.
    const nonJson = await world.admit(
      fakeWebhookDelivery({
        spec: webhookEventSpec({ eventId: "evt-nonjson-1" }),
        deliveryId: deliveries.next(),
        sequence: 2,
        receivedAt: world.clock.now(),
        overrides: { tamperPayload: "not-json-attacker-bytes" },
      }),
    );
    expect(nonJson.outcome).toBe("REJECTED");
    expect(await admittedCount(world)).toBe(0);
  });

  it("W-9 headers disagreeing with the signed envelope are rejected (event-id consistency)", async () => {
    const world = makeSecurityWorld();
    const deliveries = new DeliveryIds("consistency");
    const delivery = world.signedDelivery({
      spec: webhookEventSpec({ eventId: "evt-consistency-1" }),
      deliveryId: deliveries.next(),
      sequence: 1,
    });
    // The event-id header is NOT part of the signed message; mutate it after
    // signing. The verifier's consistency check must catch the disagreement.
    const mutated: Record<string, string> = {
      ...delivery.headers,
      [FAKE_HEADER_NAMES.eventId]: "evt-consistency-OTHER",
    };
    const admission = await world.admit({ headers: mutated, payload: delivery.payload });
    expect(admission.outcome).toBe("REJECTED");
    if (admission.outcome === "REJECTED") {
      expect(admission.code).toBe("webhook-signature-invalid");
    }
    expect(await admittedCount(world)).toBe(0);
  });

  it("W-10 a delivery missing required headers is rejected", async () => {
    const world = makeSecurityWorld();
    const deliveries = new DeliveryIds("headers");
    const delivery = world.signedDelivery({
      spec: webhookEventSpec({ eventId: "evt-headers-1" }),
      deliveryId: deliveries.next(),
      sequence: 1,
    });
    const { [FAKE_HEADER_NAMES.signature]: _omit, ...withoutSignature } = delivery.headers;
    const admission = await world.admit({ headers: withoutSignature, payload: delivery.payload });
    expect(admission.outcome).toBe("REJECTED");
    if (admission.outcome === "REJECTED") {
      expect(admission.code).toBe("webhook-signature-invalid");
    }
    expect(await admittedCount(world)).toBe(0);
  });
});

describe("RL-074 suite 1b: customer-facing webhooks are emitted only from verified durable transitions", () => {
  it("W-11 a raw ADCOS event payload cannot pass the durable-transition origin contract (notifications + enterprise)", async () => {
    const world = makeSecurityWorld();
    const principal = await registerPrincipal(world, 0x10);

    // The raw ADCOS event shape an attacker would replay into the emission
    // boundary (a webhook IS a signal, never a source - RL-LOCK-009).
    const rawAdcosPayload = {
      event_id: "evt-attacker",
      event_type: "connectivity_intent.created",
      resource_id: "00000000-0000-4000-8000-000000000001",
      resource_kind: "connectivity_intent",
      resource_version: 1,
      occurred_at: T0,
      api_version: "2.0",
      environment: "sandbox",
      correlation_id: "corr-attacker",
    };

    // Notifications: the TransitionOrigin contract rejects every lie.
    await expect(
      world.notifications.emitFromTransition(world.envelope(principal), {
        notificationId: "ntf-attack-1",
        recipientUserId: principal.userId,
        topic: "connectivity",
        severity: "info",
        title: "forged",
        body: "forged",
        // @ts-expect-error - deliberately attacker-shaped (not the contract)
        source: rawAdcosPayload,
      }),
    ).rejects.toThrowError(/TransitionOrigin|source/i);

    // Enterprise customer webhooks: parseDurableStateTransition rejects
    // non-contract shapes with a typed ValidationError.
    const clockWorld = makeSecurityWorld();
    const harness = createEnterpriseApiHarness({ now: () => clockWorld.clock.now() });
    await expect(
      harness.emitTransition(
        "org:77777777-0000-4000-8000-000000000001",
        rawAdcosPayload,
        clockWorld.clock.now(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // Even a WELL-FORMED transition object with the WRONG origin vocabulary
    // member is rejected: the origin is a single-member closed vocabulary.
    await expect(
      harness.emitTransition(
        "org:77777777-0000-4000-8000-000000000001",
        {
          origin: "adcos_webhook_event",
          aggregateType: "order",
          aggregateId: "11111111-1111-4111-8111-111111111111",
          transition: "order.placed",
          eventId: "22222222-2222-4222-8222-222222222222",
          occurredAt: clockWorld.clock.now(),
        },
        clockWorld.clock.now(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // Nothing was delivered: the endpoint store is empty by construction here.
    expect(
      await harness.webhookDeliveries.listByEvent("endpoint-none", "evt-attacker"),
    ).toHaveLength(0);
  });

  it("W-12 a legitimate durable transition emits an authenticated customer webhook that verifies; redelivery dedupes", async () => {
    const world = makeSecurityWorld();
    const endpointId = "77777777-0000-4000-8000-00000000aa01" as never;
    const tenant = "org:77777777-0000-4000-8000-000000000001";

    // The receiving side: a capturing sink that records every delivery.
    const delivered: { headers: Record<string, string>; payload: string }[] = [];
    const harness = createEnterpriseApiHarness({
      now: () => world.clock.now(),
      sink: {
        async deliver(input) {
          delivered.push({ headers: { ...input.headers }, payload: input.payload });
          return { outcome: "delivered" as const };
        },
      },
    });

    // Bootstrap the signing secret through the RL-050 boundary + the endpoint
    // (a typed secret REFERENCE only - no material on the record).
    harness.secrets.register("customer-webhook-signing", "endpoint-signing-secret-value");
    await harness.webhookEndpoints.save({
      endpointId,
      contractVersion: "0.1" as never,
      tenantId: tenant as never,
      url: "https://customer.example/hooks/roamlink",
      eventTypes: [],
      signingKeyRef: { name: "customer-webhook-signing" as never, version: null },
      status: "active",
      createdAt: world.clock.now(),
      updatedAt: world.clock.now(),
      revision: 1 as never,
    });

    const transition = {
      origin: "roamlink_state_transition",
      aggregateType: "order",
      aggregateId: "11111111-1111-4111-8111-111111111111",
      transition: "order.placed",
      eventId: "22222222-2222-4222-8222-222222222222",
      occurredAt: world.clock.now(),
    } as const;

    const outcomes = await harness.emitTransition(tenant, transition, world.clock.now());
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe("delivered");

    // The delivery carries all seven headers and VERIFIES at the receiver.
    expect(delivered).toHaveLength(1);
    const delivery = delivered[0];
    if (delivery === undefined) throw new Error("expected a captured delivery");
    for (const name of Object.values(CUSTOMER_WEBHOOK_HEADER_NAMES)) {
      expect(delivery.headers[name]).toBeDefined();
    }
    const keys: CustomerWebhookKeyRegistry = {
      secretForKeyId: (keyId: string) =>
        keyId === "customer-webhook-signing" ? "endpoint-signing-secret-value" : null,
    };
    const verification = verifyCustomerWebhookDelivery(
      { payload: delivery.payload, headers: delivery.headers },
      keys,
      world.clock.now(),
    );
    expect(verification.ok).toBe(true);

    // Tampered payload at the receiver fails verification (the customer's
    // own admission defense mirrors RoamLink's).
    const tampered = verifyCustomerWebhookDelivery(
      {
        payload: delivery.payload.replace("order.placed", "order.HACKED"),
        headers: delivery.headers,
      },
      keys,
      world.clock.now(),
    );
    expect(tampered.ok).toBe(false);

    // A stale timestamp at the receiver fails the replay window.
    const staleReceive = verifyCustomerWebhookDelivery(
      { payload: delivery.payload, headers: delivery.headers },
      keys,
      instantPlusMs(world.clock.now(), 600_000),
    );
    expect(staleReceive.ok).toBe(false);

    // Re-emitting the SAME durable transition dedupes per endpoint.
    const replayOutcomes = await harness.emitTransition(
      tenant,
      transition,
      instantPlusMs(world.clock.now(), STEP_MS),
    );
    expect(replayOutcomes[0]?.outcome).toBe("already-delivered");
    expect(delivered).toHaveLength(1);
  });
});
