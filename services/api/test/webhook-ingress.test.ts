/**
 * RL-090: webhook ingress - the route verifies the pinned v2 delivery, then
 * admits + persists through the durable inbox and answers 202; it NEVER
 * projects or processes (RL-LOCK-009). Rejections are recorded as audit rows
 * and answered with the closed ADCOS error codes.
 */
import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "@roamlink/contracts";
import { ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES, buildAdcosWebhookSignatureMessage } from "@roamlink/adcos";
import { HmacWebhookVerifier, StaticWebhookSigningKeyRegistry, signWebhookDelivery } from "@roamlink/webhook-inbox";

import { T0, createTestWorld } from "./helpers.js";

const KEY_ID = "whk-test-1";
const SECRET = "test-signing-secret-never-in-prod";

/** Builds one signed v2 delivery exactly per the pinned contract. */
function signedDelivery(input: {
  readonly eventId: string;
  readonly deliveryId: string;
  readonly sequence: number;
  readonly tamperSignature?: boolean;
  readonly staleTimestamp?: string;
}): { readonly headers: Record<string, string>; readonly payload: string } {
  const payload = canonicalizeJson({
    event_id: input.eventId,
    event_type: "connectivity_contract.state_changed",
    resource_id: "res-0001",
    resource_kind: "connectivity_contract",
    resource_version: 3,
    occurred_at: T0,
    api_version: "2.0",
    environment: "sandbox",
    correlation_id: `corr-${input.eventId}`,
  });
  const message = buildAdcosWebhookSignatureMessage({
    keyId: KEY_ID,
    timestamp: T0,
    deliveryId: input.deliveryId,
    payload,
  });
  let signature = signWebhookDelivery(SECRET, message);
  if (input.tamperSignature === true) {
    signature = `00${signature.slice(2)}`;
  }
  const headers: Record<string, string> = {
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.signature]: signature,
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.timestamp]: input.staleTimestamp ?? T0,
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.keyId]: KEY_ID,
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.eventId]: input.eventId,
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.deliveryId]: input.deliveryId,
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.sequence]: String(input.sequence),
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.algorithm]: "hmac-sha256",
  };
  return { headers, payload };
}

function worldWithRealVerifier() {
  return createTestWorld({
    webhookVerifier: new HmacWebhookVerifier({
      environment: "sandbox",
      keys: new StaticWebhookSigningKeyRegistry({ [KEY_ID]: SECRET }),
    }),
  });
}

describe("POST /v1/webhooks/adcos (durable inbox ingress)", () => {
  it("admits a signed delivery durably and answers 202 with the sequence", async () => {
    const world = worldWithRealVerifier();
    const delivery = signedDelivery({ eventId: "evt-0001", deliveryId: "del-0001", sequence: 0 });
    const response = await world.service.handle({
      method: "POST",
      path: "/v1/webhooks/adcos",
      headers: delivery.headers,
      body: delivery.payload,
    });
    expect(response.status).toBe(202);
    const body = JSON.parse(response.body as string);
    expect(body.outcome).toBe("ADMITTED");
    expect(body.eventId).toBe("evt-0001");
    expect(body.sequence).toBeGreaterThanOrEqual(1);
    // Durably admitted (in-memory adapter here; the SQL path in the integration test).
    expect(await world.persistence.inbox.count("ADMITTED")).toBe(1);
  });

  it("answers a replayed event id with 202 DUPLICATE (never a second admission)", async () => {
    const world = worldWithRealVerifier();
    const first = signedDelivery({ eventId: "evt-dup", deliveryId: "del-a", sequence: 0 });
    const second = signedDelivery({ eventId: "evt-dup", deliveryId: "del-b", sequence: 1 });
    const firstResponse = await world.service.handle({
      method: "POST",
      path: "/v1/webhooks/adcos",
      headers: first.headers,
      body: first.payload,
    });
    const replayResponse = await world.service.handle({
      method: "POST",
      path: "/v1/webhooks/adcos",
      headers: second.headers,
      body: second.payload,
    });
    expect(firstResponse.status).toBe(202);
    expect(JSON.parse(firstResponse.body as string)["outcome"]).toBe("ADMITTED");
    expect(replayResponse.status).toBe(202);
    const body = JSON.parse(replayResponse.body as string);
    expect(body.outcome).toBe("DUPLICATE");
    expect(await world.persistence.inbox.count("ADMITTED")).toBe(1);
    expect(await world.persistence.inbox.count("DUPLICATE")).toBe(1);
  });

  it("rejects a tampered signature with 401 and records the rejection (key not occupied)", async () => {
    const world = worldWithRealVerifier();
    const delivery = signedDelivery({ eventId: "evt-tamper", deliveryId: "del-t", sequence: 0, tamperSignature: true });
    const response = await world.service.handle({
      method: "POST",
      path: "/v1/webhooks/adcos",
      headers: delivery.headers,
      body: delivery.payload,
    });
    expect(response.status).toBe(401);
    const body = JSON.parse(response.body as string);
    expect(body.outcome).toBe("REJECTED");
    expect(body.code).toBe("webhook-signature-invalid");
    expect(await world.persistence.inbox.count("REJECTED")).toBe(1);
    expect(await world.persistence.inbox.admitted("evt-tamper")).toBeNull();
  });

  it("rejects a stale timestamp outside the replay window with 401", async () => {
    const world = worldWithRealVerifier();
    const delivery = signedDelivery({
      eventId: "evt-stale",
      deliveryId: "del-s",
      sequence: 0,
      staleTimestamp: "2025-01-01T00:00:00.000Z",
    });
    const response = await world.service.handle({
      method: "POST",
      path: "/v1/webhooks/adcos",
      headers: delivery.headers,
      body: delivery.payload,
    });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body as string)["code"]).toBe("webhook-timestamp-stale");
  });

  it("rejects an unknown key id with 401 (fail closed, no value echo)", async () => {
    const world = createTestWorld({
      webhookVerifier: new HmacWebhookVerifier({
        environment: "sandbox",
        keys: new StaticWebhookSigningKeyRegistry({ "another-key": SECRET }),
      }),
    });
    const delivery = signedDelivery({ eventId: "evt-unknown-key", deliveryId: "del-uk", sequence: 0 });
    const response = await world.service.handle({
      method: "POST",
      path: "/v1/webhooks/adcos",
      headers: delivery.headers,
      body: delivery.payload,
    });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body as string)["code"]).toBe("authentication-invalid");
  });

  it("requires the byte-exact payload body (missing body -> 400, nothing persisted)", async () => {
    const world = worldWithRealVerifier();
    const response = await world.service.handle({
      method: "POST",
      path: "/v1/webhooks/adcos",
      headers: {},
    });
    expect(response.status).toBe(400);
    expect(await world.persistence.inbox.count()).toBe(0);
  });

  it("does not require a user session (HMAC is the authentication)", async () => {
    const world = worldWithRealVerifier();
    const delivery = signedDelivery({ eventId: "evt-no-session", deliveryId: "del-ns", sequence: 0 });
    const response = await world.service.handle({
      method: "POST",
      path: "/v1/webhooks/adcos",
      headers: delivery.headers,
      body: delivery.payload,
    });
    expect(response.status).toBe(202);
  });
});
