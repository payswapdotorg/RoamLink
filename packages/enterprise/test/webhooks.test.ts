/**
 * Customer webhook contract tests (RL-063, RL-LOCK-009 + spec/security.md
 * "Webhooks").
 *
 * Proves:
 *  - emissions originate ONLY from validated RoamLink durable state
 *    transitions - a raw ADCOS payload has NO shape that passes (negative
 *    proof), and the required durable event id is the emission receipt;
 *  - signature verification: correct signatures pass; tampered payloads,
 *    wrong keys, unknown key ids, missing headers, algorithm downgrades and
 *    event-id mismatches all fail closed with the exact code;
 *  - replay protection: the bounded timestamp window in BOTH directions;
 *  - delivery discipline: per-endpoint event dedup (already-delivered is
 *    never re-delivered), bounded retries with dead-lettering, endpoint
 *    health transitions, and the per-endpoint monotonic sequence.
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import { InMemorySecrets } from "@roamlink/secrets";
import { fixtureTenantId } from "@roamlink/testkit";

import {
  buildCustomerWebhookSignatureMessage,
  CUSTOMER_WEBHOOK_HEADER_NAMES,
  CUSTOMER_WEBHOOK_REPLAY_WINDOW_MS,
  CustomerWebhookDispatcher,
  parseDurableStateTransition,
  parseWebhookEndpointRecord,
  signCustomerWebhookDelivery,
  verifyCustomerWebhookDelivery,
  webhookEndpointSecretName,
  type CustomerWebhookSink,
  type WebhookEmissionOutcome,
} from "../src/webhooks.js";
import {
  InMemorySecretRegistrarAdapter,
  InMemoryWebhookDeliveryStore,
  InMemoryWebhookEndpointStore,
} from "../src/stores.js";

const AT = "2026-02-01T10:00:00.000Z";
const TENANT = fixtureTenantId();
const EVENT_ID = "40000000-0000-4000-8000-000000000001";
const AGGREGATE_ID = "40000000-0000-4000-8000-000000000002";
const ENDPOINT_ID = "40000000-0000-4000-8000-000000000003";

function transitionInput(): Record<string, unknown> {
  return {
    origin: "roamlink_state_transition",
    aggregateType: "order",
    aggregateId: AGGREGATE_ID,
    transition: "order.placed",
    eventId: EVENT_ID,
    occurredAt: AT,
  };
}

function endpointRecord(secretName: string) {
  return parseWebhookEndpointRecord({
    endpointId: ENDPOINT_ID,
    contractVersion: "0.1",
    tenantId: TENANT,
    url: "https://hooks.customer.example/roamlink",
    eventTypes: [],
    signingKeyRef: { name: secretName, version: null },
    status: "pending",
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
  });
}

function registryWith(secretName: string, secret: string) {
  return {
    secretForKeyId(keyId: string): string | null {
      return keyId === secretName ? secret : null;
    },
  };
}

describe("emissions originate ONLY from durable RoamLink transitions (RL-LOCK-009)", () => {
  it("parses a valid durable state transition", () => {
    const transition = parseDurableStateTransition(transitionInput());
    expect(transition.origin).toBe("roamlink_state_transition");
    expect(transition.eventId).toBe(EVENT_ID);
    expect(Object.isFrozen(transition)).toBe(true);
  });

  it("a raw ADCOS payload has no shape that passes (negative proof)", () => {
    const adcospPayloads: readonly unknown[] = [
      // an ADCOS event envelope with adcos origin
      { origin: "adcos_event", aggregateType: "order", aggregateId: AGGREGATE_ID, transition: "reservation.leased", eventId: EVENT_ID, occurredAt: AT },
      // ADCOS-native aggregate types are outside the closed vocabulary
      { origin: "roamlink_state_transition", aggregateType: "adcos_reservation", aggregateId: AGGREGATE_ID, transition: "order.placed", eventId: EVENT_ID, occurredAt: AT },
      { origin: "roamlink_state_transition", aggregateType: "adcos_session", aggregateId: AGGREGATE_ID, transition: "session.opened", eventId: EVENT_ID, occurredAt: AT },
      // no durable event id = no receipt = no emission
      { origin: "roamlink_state_transition", aggregateType: "order", aggregateId: AGGREGATE_ID, transition: "order.placed", occurredAt: AT },
      // non-UUID event/aggregate ids
      { origin: "roamlink_state_transition", aggregateType: "order", aggregateId: "order-1", transition: "order.placed", eventId: EVENT_ID, occurredAt: AT },
      { origin: "roamlink_state_transition", aggregateType: "order", aggregateId: AGGREGATE_ID, transition: "order.placed", eventId: "evt-1", occurredAt: AT },
      // smuggled ADCOS fields
      { ...transitionInput(), adcosEvent: { type: "reservation.leased" } },
    ];
    for (const payload of adcospPayloads) {
      expect(() => parseDurableStateTransition(payload), `${JSON.stringify(payload)}`).toThrowError(
        ValidationError,
      );
    }
  });
});

describe("webhook signature verification (authentication + replay protection)", () => {
  const secret = "whsec_" + "a".repeat(48);
  const secretName = webhookEndpointSecretName(ENDPOINT_ID);
  const keys = registryWith(secretName, secret);

  function signedDelivery(overrides?: {
    readonly payload?: string;
    readonly headers?: Readonly<Record<string, string>>;
  }): { readonly payload: string; readonly headers: Readonly<Record<string, string>> } {
    const payload =
      overrides?.payload ??
      JSON.stringify({
        contractVersion: "0.1",
        tenantId: TENANT,
        eventId: EVENT_ID,
        eventType: "order.placed",
        aggregateType: "order",
        aggregateId: AGGREGATE_ID,
        occurredAt: AT,
        emittedAt: AT,
      });
    const deliveryId = "50000000-0000-4000-8000-000000000001";
    const timestamp = AT;
    const headers: Record<string, string> = {
      [CUSTOMER_WEBHOOK_HEADER_NAMES.timestamp]: timestamp,
      [CUSTOMER_WEBHOOK_HEADER_NAMES.keyId]: secretName,
      [CUSTOMER_WEBHOOK_HEADER_NAMES.eventId]: EVENT_ID,
      [CUSTOMER_WEBHOOK_HEADER_NAMES.deliveryId]: deliveryId,
      [CUSTOMER_WEBHOOK_HEADER_NAMES.sequence]: "1",
      [CUSTOMER_WEBHOOK_HEADER_NAMES.algorithm]: "hmac-sha256",
      ...(overrides?.headers ?? {}),
    };
    // The signature is computed over the FINAL header values, so a header
    // override changes the signature with it (mimics a real sender).
    const headerEventId = headers[CUSTOMER_WEBHOOK_HEADER_NAMES.eventId] as string;
    headers[CUSTOMER_WEBHOOK_HEADER_NAMES.signature] = signCustomerWebhookDelivery(
      secret,
      buildCustomerWebhookSignatureMessage(secretName, timestamp, deliveryId, headerEventId, payload),
    );
    return { payload, headers };
  }

  it("verifies a correctly signed delivery", () => {
    const result = verifyCustomerWebhookDelivery(signedDelivery(), keys, AT);
    expect(result).toMatchObject({ ok: true, eventId: EVENT_ID, sequence: 1 });
  });

  it("rejects a tampered payload (signature covers the byte-exact body)", () => {
    const delivery = signedDelivery();
    const result = verifyCustomerWebhookDelivery(
      { payload: `${delivery.payload} `, headers: delivery.headers },
      keys,
      AT,
    );
    expect(result).toMatchObject({ ok: false, code: "signature-invalid" });
  });

  it("rejects an unknown signing key id", () => {
    const delivery = signedDelivery({
      headers: { [CUSTOMER_WEBHOOK_HEADER_NAMES.keyId]: "enterprise.webhook-endpoint.other" },
    });
    expect(verifyCustomerWebhookDelivery(delivery, keys, AT)).toMatchObject({
      ok: false,
      code: "key-unknown",
    });
  });

  it("rejects stale timestamps (replay window, both directions)", () => {
    const delivery = signedDelivery();
    const inside = verifyCustomerWebhookDelivery(
      delivery,
      keys,
      new Date(Date.parse(AT) + CUSTOMER_WEBHOOK_REPLAY_WINDOW_MS - 1_000).toISOString(),
    );
    expect(inside).toMatchObject({ ok: true });
    const stale = verifyCustomerWebhookDelivery(
      delivery,
      keys,
      new Date(Date.parse(AT) + CUSTOMER_WEBHOOK_REPLAY_WINDOW_MS + 1_000).toISOString(),
    );
    expect(stale).toMatchObject({ ok: false, code: "timestamp-stale" });
    const future = verifyCustomerWebhookDelivery(
      delivery,
      keys,
      new Date(Date.parse(AT) - CUSTOMER_WEBHOOK_REPLAY_WINDOW_MS - 1_000).toISOString(),
    );
    expect(future).toMatchObject({ ok: false, code: "timestamp-stale" });
  });

  it("rejects missing headers, wrong algorithms and oversized payloads", () => {
    const base = signedDelivery();
    const missing: Record<string, string> = { ...base.headers };
    delete missing[CUSTOMER_WEBHOOK_HEADER_NAMES.signature];
    expect(
      verifyCustomerWebhookDelivery({ payload: base.payload, headers: missing }, keys, AT),
    ).toMatchObject({ ok: false, code: "headers-invalid" });

    const downgraded = signedDelivery({
      headers: { [CUSTOMER_WEBHOOK_HEADER_NAMES.algorithm]: "sha1" },
    });
    expect(verifyCustomerWebhookDelivery(downgraded, keys, AT)).toMatchObject({
      ok: false,
      code: "algorithm-unsupported",
    });

    const bigPayload = "x".repeat(262_145);
    const big = signedDelivery({ payload: bigPayload });
    expect(verifyCustomerWebhookDelivery(big, keys, AT, { maxPayloadBytes: 262_144 })).toMatchObject(
      { ok: false, code: "payload-too-large" },
    );
  });

  it("rejects a payload whose event id does not match the header", () => {
    // The signature is computed over the OVERRIDDEN header event id (so the
    // signature itself is valid) while the PAYLOAD carries a different id.
    const mismatch = signedDelivery({
      headers: { [CUSTOMER_WEBHOOK_HEADER_NAMES.eventId]: "50000000-0000-4000-8000-000000000009" },
    });
    expect(verifyCustomerWebhookDelivery(mismatch, keys, AT)).toMatchObject({
      ok: false,
      code: "event-id-mismatch",
    });
  });
});

describe("the dispatcher (dedupe, retries, dead-letter, health)", () => {
  function harness(sink: CustomerWebhookSink) {
    const secrets = new InMemorySecrets();
    const secretName = webhookEndpointSecretName(ENDPOINT_ID);
    secrets.register(secretName, "whsec_dispatcher");
    const endpoints = new InMemoryWebhookEndpointStore();
    const deliveries = new InMemoryWebhookDeliveryStore();
    let counter = 0;
    const dispatcher = new CustomerWebhookDispatcher({
      endpoints,
      deliveries,
      sink,
      secrets,
      deliveryIdGenerator: () => {
        counter += 1;
        return `60000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      },
      maxAttempts: 3,
    });
    return { secrets, endpoints, deliveries, dispatcher };
  }

  type RecordingSink = CustomerWebhookSink & {
    calls: Array<{ readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly payload: string }>;
  };
  function recordingSink(): RecordingSink {
    const sink: RecordingSink = {
      calls: [],
      async deliver(input) {
        sink.calls.push(input);
        return { outcome: "delivered" };
      },
    };
    return sink;
  }

  it("delivers a transition, signs it and flips the endpoint active", async () => {
    const sink = recordingSink();
    const { endpoints, dispatcher } = harness(sink);
    await endpoints.save(endpointRecord(webhookEndpointSecretName(ENDPOINT_ID)));

    const outcomes = await dispatcher.emit(TENANT, transitionInput(), AT);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe("delivered");

    const delivered = sink.calls[0];
    expect(delivered).toBeDefined();
    // The delivered payload carries RoamLink state only - no ADCOS internals.
    const payload = delivered?.payload ?? "";
    const parsed = JSON.parse(payload) as { readonly eventType: string };
    expect(parsed.eventType).toBe("order.placed");
    // The signature verifies through the contract verifier.
    const verification = verifyCustomerWebhookDelivery(
      { payload, headers: delivered?.headers ?? {} },
      registryWith(webhookEndpointSecretName(ENDPOINT_ID), "whsec_dispatcher"),
      AT,
    );
    expect(verification).toMatchObject({ ok: true, eventId: EVENT_ID });

    const endpoint = await endpoints.get(ENDPOINT_ID);
    expect(endpoint?.status).toBe("active");
    expect(endpoint?.lastSuccessAt).toBe(AT);
  });

  it("never re-delivers an already-delivered durable event (idempotent emission)", async () => {
    const sink = recordingSink();
    const { endpoints, dispatcher } = harness(sink);
    await endpoints.save(endpointRecord(webhookEndpointSecretName(ENDPOINT_ID)));
    await dispatcher.emit(TENANT, transitionInput(), AT);
    const second = (await dispatcher.emit(TENANT, transitionInput(), AT)) as readonly WebhookEmissionOutcome[];
    expect(second[0]?.outcome).toBe("already-delivered");
    expect(sink.calls).toHaveLength(1);
  });

  it("dead-letters after exhausting the bounded retries and marks the endpoint failing", async () => {
    let calls = 0;
    const failingSink: CustomerWebhookSink = {
      async deliver() {
        calls += 1;
        return { outcome: "retryable-failure", summary: "503 from receiver" };
      },
    };
    const { endpoints, deliveries, dispatcher } = harness(failingSink);
    await endpoints.save(endpointRecord(webhookEndpointSecretName(ENDPOINT_ID)));

    const first = await dispatcher.emit(TENANT, transitionInput(), AT);
    expect(first[0]?.outcome).toBe("failed");
    const retry1 = await dispatcher.retryFailed(TENANT, "2026-02-01T10:05:00.000Z");
    expect(retry1[0]?.outcome).toBe("failed");
    const retry2 = await dispatcher.retryFailed(TENANT, "2026-02-01T10:10:00.000Z");
    expect(retry2[0]?.outcome).toBe("dead-lettered");
    expect(calls).toBe(3);

    const endpoint = await endpoints.get(ENDPOINT_ID);
    expect(endpoint?.status).toBe("failing");

    // A dead-lettered event is never re-attempted.
    const retry3 = await dispatcher.retryFailed(TENANT, "2026-02-01T10:15:00.000Z");
    expect(retry3).toHaveLength(0);

    const attempts = await deliveries.listByEvent(ENDPOINT_ID, EVENT_ID);
    expect(attempts).toHaveLength(3);
    expect(attempts.map((attempt) => attempt.sequence)).toEqual([1, 2, 3]);
    expect(attempts[2]?.responseSummary).toBe("503 from receiver");
  });

  it("skips revoked endpoints and honors the event-type filter", async () => {
    const sink = recordingSink();
    const { endpoints, dispatcher } = harness(sink);
    await endpoints.save(
      parseWebhookEndpointRecord({
        ...endpointRecord(webhookEndpointSecretName(ENDPOINT_ID)),
        status: "revoked",
        revision: 2,
      }),
    );
    expect(await dispatcher.emit(TENANT, transitionInput(), AT)).toHaveLength(0);

    await endpoints.save(
      parseWebhookEndpointRecord({
        ...endpointRecord(webhookEndpointSecretName(ENDPOINT_ID)),
        status: "active",
        eventTypes: ["subscription.activated"],
        revision: 3,
      }),
    );
    // order.placed is filtered out
    expect(await dispatcher.emit(TENANT, transitionInput(), AT)).toHaveLength(0);
    // a matching event type delivers
    const outcomes = await dispatcher.emit(
      TENANT,
      {
        ...transitionInput(),
        aggregateType: "subscription",
        transition: "subscription.activated",
      },
      AT,
    );
    expect(outcomes[0]?.outcome).toBe("delivered");
  });

  it("refuses to emit when the transition does not parse (raw ADCOS payloads)", async () => {
    const sink = recordingSink();
    const { endpoints, dispatcher } = harness(sink);
    await endpoints.save(endpointRecord(webhookEndpointSecretName(ENDPOINT_ID)));
    await expect(
      dispatcher.emit(TENANT, { origin: "adcos_event", type: "reservation.leased" }, AT),
    ).rejects.toThrowError(ValidationError);
    expect(sink.calls).toHaveLength(0);
  });

  it("registers the endpoint signing secret through the secrets boundary", async () => {
    const secrets = new InMemorySecrets();
    const registrar = new InMemorySecretRegistrarAdapter(secrets);
    const secret = "whsec_endpoint_" + "b".repeat(40);
    await registrar.register(webhookEndpointSecretName(ENDPOINT_ID), secret);
    expect(secrets.activeVersionOf(webhookEndpointSecretName(ENDPOINT_ID))).toBe(1);
    expect(() =>
      parseWebhookEndpointRecord({
        ...endpointRecord(webhookEndpointSecretName(ENDPOINT_ID)),
        signingKeyRef: { name: "x", version: null },
        signingSecret: secret,
      }),
    ).toThrowError(ValidationError);
  });
});
