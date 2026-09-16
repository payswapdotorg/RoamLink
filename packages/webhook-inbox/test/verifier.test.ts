import { describe, expect, it } from "vitest";
import { parseUtcInstant } from "@roamlink/contracts";
import {
  StaticWebhookSigningKeyRegistry,
  HmacWebhookVerifier,
  DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES,
  signaturesMatch,
} from "../src/index.js";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeEventPayload,
  fakeHmac,
  fakeWebhookDelivery,
  type FakeWebhookEventSpec,
} from "./fake-adcos-webhooks.js";

const T0 = parseUtcInstant("2026-01-15T08:30:00.000Z");

function spec(overrides?: Partial<FakeWebhookEventSpec>): FakeWebhookEventSpec {
  return {
    eventId: "evt-1",
    eventType: "connectivity_contract.state_changed",
    resourceId: "contract-77",
    resourceKind: "connectivity_contract",
    resourceVersion: 4,
    occurredAt: T0,
    correlationId: "corr-9",
    ...overrides,
  };
}

function makeVerifier(maxPayloadBytes?: number) {
  return new HmacWebhookVerifier({
    environment: "sandbox",
    keys: new StaticWebhookSigningKeyRegistry({ [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET }),
    ...(maxPayloadBytes !== undefined ? { maxPayloadBytes } : {}),
  });
}

describe("the HMAC webhook verifier (RL-033, WebhookVerifier seam)", () => {
  it("verifies a correctly signed delivery and returns the event + dedupe key", async () => {
    const verifier = makeVerifier();
    const delivery = fakeWebhookDelivery({
      spec: spec(),
      deliveryId: "dlv-1",
      sequence: 1,
      receivedAt: T0,
    });
    const result = await verifier.verify({
      headers: delivery.headers,
      payload: delivery.payload,
      receivedAt: T0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.event_id).toBe("evt-1");
    expect(result.event.resource_version).toBe(4);
    expect(result.dedupeKey).toBe("evt-1");
    expect(result.delivery.deliveryId).toBe("dlv-1");
    expect(result.delivery.sequence).toBe(1);
  });

  it("verifies the exact HMAC known answer over the canonical message", () => {
    const message = [TEST_SIGNING_KEY_ID, T0, "dlv-1", fakeEventPayload(spec())].join("\n");
    const delivery = fakeWebhookDelivery({ spec: spec(), deliveryId: "dlv-1", sequence: 1, receivedAt: T0 });
    expect(delivery.headers["X-ADCOS-Signature"]).toBe(fakeHmac(TEST_SIGNING_SECRET, message));
  });

  it("rejects a tampered payload (signature does not verify)", async () => {
    const verifier = makeVerifier();
    const result = await verifier.verify({
      headers: fakeWebhookDelivery({ spec: spec(), deliveryId: "dlv-1", sequence: 1, receivedAt: T0 }).headers,
      payload: fakeEventPayload(spec({ resourceVersion: 5 })),
      receivedAt: T0,
    });
    expect(result).toMatchObject({ ok: false, code: "webhook-signature-invalid" });
  });

  it("rejects a tampered signature", async () => {
    const verifier = makeVerifier();
    const result = await verifier.verify({
      headers: fakeWebhookDelivery({
        spec: spec(),
        deliveryId: "dlv-1",
        sequence: 1,
        receivedAt: T0,
        overrides: { tamperSignature: true },
      }).headers,
      payload: fakeEventPayload(spec()),
      receivedAt: T0,
    });
    expect(result).toMatchObject({ ok: false, code: "webhook-signature-invalid" });
  });

  it("rejects deliveries signed with an unregistered key id", async () => {
    const verifier = makeVerifier();
    const result = await verifier.verify({
      headers: fakeWebhookDelivery({
        spec: spec(),
        deliveryId: "dlv-1",
        sequence: 1,
        receivedAt: T0,
        overrides: { unknownKeyId: "whk-unknown" },
      }).headers,
      payload: fakeEventPayload(spec()),
      receivedAt: T0,
    });
    expect(result).toMatchObject({ ok: false, code: "authentication-invalid" });
    // the failure message never echoes the key id value (RL-LOCK-016)
    if (!result.ok) {
      expect(result.message).not.toContain("whk-unknown");
    }
  });

  it("rejects stale deliveries outside the 300s replay window", async () => {
    const verifier = makeVerifier();
    const result = await verifier.verify({
      headers: fakeWebhookDelivery({
        spec: spec(),
        deliveryId: "dlv-1",
        sequence: 1,
        receivedAt: T0,
        overrides: { staleTimestamp: "2026-01-15T08:20:00.000Z" }, // 10min old
      }).headers,
      payload: fakeEventPayload(spec()),
      receivedAt: T0,
    });
    expect(result).toMatchObject({ ok: false, code: "webhook-timestamp-stale" });
  });

  it("rejects future-stamped deliveries beyond the window (skew protection)", async () => {
    const verifier = makeVerifier();
    const result = await verifier.verify({
      headers: fakeWebhookDelivery({
        spec: spec(),
        deliveryId: "dlv-1",
        sequence: 1,
        receivedAt: T0,
        overrides: { staleTimestamp: "2026-01-15T08:40:01.000Z" }, // 10min in the future
      }).headers,
      payload: fakeEventPayload(spec()),
      receivedAt: T0,
    });
    expect(result).toMatchObject({ ok: false, code: "webhook-timestamp-stale" });
  });

  it("accepts deliveries at the exact replay-window boundary (300s), rejects just outside", async () => {
    const verifier = makeVerifier();
    const boundary = "2026-01-15T08:25:00.000Z"; // exactly 300s before T0
    // a delivery SIGNED over the boundary timestamp (the timestamp is part
    // of the signed message - swapping the header alone would break the
    // signature, which the tamper tests cover)
    const resigned = fakeWebhookDelivery({
      spec: spec({ occurredAt: boundary }),
      deliveryId: "dlv-1",
      sequence: 1,
      receivedAt: T0,
    });
    const resultBoundary = await verifier.verify({
      headers: resigned.headers,
      payload: resigned.payload,
      receivedAt: T0,
    });
    expect(resultBoundary.ok).toBe(true);

    const justOutside = "2026-01-15T08:24:59.000Z"; // 301s before T0
    const resignedOutside = fakeWebhookDelivery({
      spec: spec({ occurredAt: justOutside }),
      deliveryId: "dlv-2",
      sequence: 2,
      receivedAt: T0,
    });
    const resultOutside = await verifier.verify({
      headers: resignedOutside.headers,
      payload: resignedOutside.payload,
      receivedAt: T0,
    });
    expect(resultOutside).toMatchObject({ ok: false, code: "webhook-timestamp-stale" });
  });

  it("rejects an unparseable timestamp header", async () => {
    const verifier = makeVerifier();
    const result = await verifier.verify({
      headers: fakeWebhookDelivery({
        spec: spec(),
        deliveryId: "dlv-1",
        sequence: 1,
        receivedAt: T0,
        overrides: { staleTimestamp: "not-a-timestamp" },
      }).headers,
      payload: fakeEventPayload(spec()),
      receivedAt: T0,
    });
    expect(result).toMatchObject({ ok: false, code: "webhook-timestamp-stale" });
  });

  it("rejects deliveries with missing or malformed headers", async () => {
    const verifier = makeVerifier();
    for (const dropped of ["X-ADCOS-Signature", "X-ADCOS-Key-Id", "X-ADCOS-Event-Id", "X-ADCOS-Sequence"]) {
      const result = await verifier.verify({
        headers: fakeWebhookDelivery({
          spec: spec(),
          deliveryId: "dlv-1",
          sequence: 1,
          receivedAt: T0,
          overrides: { dropHeader: dropped },
        }).headers,
        payload: fakeEventPayload(spec()),
        receivedAt: T0,
      });
      expect(result, `dropping ${dropped} must fail verification`).toMatchObject({
        ok: false,
        code: "webhook-signature-invalid",
      });
    }
  });

  it("rejects an authenticated payload that is not the closed event envelope", async () => {
    const verifier = makeVerifier();
    const garbage = JSON.stringify({ hello: "world" });
    const result = await verifier.verify({
      headers: fakeWebhookDelivery({
        spec: spec(),
        deliveryId: "dlv-1",
        sequence: 1,
        receivedAt: T0,
        overrides: { tamperPayload: garbage },
      }).headers,
      payload: garbage,
      receivedAt: T0,
    });
    expect(result).toMatchObject({ ok: false, code: "webhook-signature-invalid" });
  });

  it("rejects non-JSON authenticated payloads", async () => {
    const verifier = makeVerifier();
    const garbage = "not json at all";
    const result = await verifier.verify({
      headers: fakeWebhookDelivery({
        spec: spec(),
        deliveryId: "dlv-1",
        sequence: 1,
        receivedAt: T0,
        overrides: { tamperPayload: garbage },
      }).headers,
      payload: garbage,
      receivedAt: T0,
    });
    expect(result).toMatchObject({ ok: false, code: "webhook-signature-invalid" });
  });

  it("rejects envelopes with unknown members (closed envelope)", async () => {
    const verifier = makeVerifier();
    const result = await verifier.verify({
      headers: fakeWebhookDelivery({
        spec: spec({ extraMembers: { invented: true } }),
        deliveryId: "dlv-1",
        sequence: 1,
        receivedAt: T0,
      }).headers,
      payload: fakeEventPayload(spec({ extraMembers: { invented: true } })),
      receivedAt: T0,
    });
    expect(result).toMatchObject({ ok: false, code: "webhook-signature-invalid" });
  });

  it("fails closed on environment mismatch", async () => {
    const verifier = makeVerifier();
    const result = await verifier.verify({
      headers: fakeWebhookDelivery({
        spec: spec({ environment: "production" }),
        deliveryId: "dlv-1",
        sequence: 1,
        receivedAt: T0,
      }).headers,
      payload: fakeEventPayload(spec({ environment: "production" })),
      receivedAt: T0,
    });
    expect(result).toMatchObject({ ok: false, code: "environment-mismatch" });
  });

  it("fails closed on an unsupported api version", async () => {
    const verifier = makeVerifier();
    const result = await verifier.verify({
      headers: fakeWebhookDelivery({
        spec: spec({ apiVersion: "3.0" }),
        deliveryId: "dlv-1",
        sequence: 1,
        receivedAt: T0,
      }).headers,
      payload: fakeEventPayload(spec({ apiVersion: "3.0" })),
      receivedAt: T0,
    });
    expect(result).toMatchObject({ ok: false, code: "version-unsupported" });
  });

  it("rejects when the event id header disagrees with the signed envelope", async () => {
    const verifier = makeVerifier();
    const signed = fakeWebhookDelivery({
      spec: spec(),
      deliveryId: "dlv-1",
      sequence: 1,
      receivedAt: T0,
    });
    const result = await verifier.verify({
      headers: { ...signed.headers, "X-ADCOS-Event-Id": "evt-other" },
      payload: signed.payload,
      receivedAt: T0,
    });
    expect(result).toMatchObject({ ok: false, code: "webhook-signature-invalid" });
  });

  it("rejects oversized payloads (payload-size admission limit)", async () => {
    const verifier = makeVerifier(64);
    const oversized = fakeEventPayload(spec()) + " ".repeat(200);
    const result = await verifier.verify({
      headers: fakeWebhookDelivery({
        spec: spec(),
        deliveryId: "dlv-1",
        sequence: 1,
        receivedAt: T0,
        overrides: { tamperPayload: oversized },
      }).headers,
      payload: oversized,
      receivedAt: T0,
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    expect(DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES).toBe(262_144);
  });

  it("signature comparison is length-safe and the constant-time helper works", () => {
    expect(signaturesMatch("aa", "aa")).toBe(true);
    expect(signaturesMatch("aa", "ab")).toBe(false);
    expect(signaturesMatch("aa", "aab")).toBe(false);
  });
});
