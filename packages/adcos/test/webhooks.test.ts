import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import {
  ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES,
  ADCOS_WEBHOOK_MAX_DELIVERY_ATTEMPTS,
  ADCOS_WEBHOOK_REPLAY_WINDOW_MS,
  ADCOS_WEBHOOK_RETRY_BACKOFF_SCHEDULE_MS,
  ADCOS_WEBHOOK_SIGNATURE_ALGORITHM,
  ADCOS_WEBHOOK_SIGNATURE_MESSAGE_SEPARATOR,
  buildAdcosWebhookDelivery,
  buildAdcosWebhookSignatureMessage,
  parseAdcosWebhookEvent,
} from "../src/index.js";

const T0 = "2026-10-01T00:00:00.000Z";

function validEvent(): Record<string, unknown> {
  return {
    event_id: "evt-1",
    event_type: "connectivity_contract.activated",
    resource_id: "contract-77",
    resource_kind: "connectivity_contract",
    resource_version: 4,
    occurred_at: T0,
    api_version: "2.0",
    environment: "production",
    correlation_id: "corr-9",
  };
}

describe("webhook event envelope (RL-030, RL-LOCK-009)", () => {
  it("parses the documented members exactly", () => {
    const event = parseAdcosWebhookEvent(validEvent());
    expect(event.event_id).toBe("evt-1");
    expect(event.event_type).toBe("connectivity_contract.activated");
    expect(event.resource_kind).toBe("connectivity_contract");
    expect(event.resource_version).toBe(4);
    expect(event.occurred_at).toBe(T0);
    expect(event.environment).toBe("production");
    expect(Object.keys(event).sort()).toEqual([
      "api_version",
      "correlation_id",
      "environment",
      "event_id",
      "event_type",
      "occurred_at",
      "resource_id",
      "resource_kind",
      "resource_version",
    ]);
  });

  it("rejects missing members, unknown members and invalid values", () => {
    for (const member of Object.keys(validEvent())) {
      const input = validEvent();
      delete input[member];
      expect(() => parseAdcosWebhookEvent(input)).toThrow(ValidationError);
    }
    expect(() => parseAdcosWebhookEvent({ ...validEvent(), extra: true })).toThrow(ValidationError);
    expect(() =>
      parseAdcosWebhookEvent({ ...validEvent(), event_type: "connectivity_session.created" }),
    ).toThrow(ValidationError);
    expect(() => parseAdcosWebhookEvent({ ...validEvent(), environment: "staging" })).toThrow(
      ValidationError,
    );
    expect(() => parseAdcosWebhookEvent({ ...validEvent(), api_version: "1.0" })).toThrow(
      ValidationError,
    );
    expect(() => parseAdcosWebhookEvent({ ...validEvent(), resource_version: 0 })).toThrow(
      ValidationError,
    );
  });
});

describe("webhook delivery metadata and scheme constants (RL-030)", () => {
  it("delivery header names are exactly the 7 documented headers", () => {
    expect(Object.values(ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES).sort()).toEqual([
      "X-ADCOS-Algorithm",
      "X-ADCOS-Delivery-Id",
      "X-ADCOS-Event-Id",
      "X-ADCOS-Key-Id",
      "X-ADCOS-Sequence",
      "X-ADCOS-Signature",
      "X-ADCOS-Timestamp",
    ]);
  });

  it("replay window is 300s; backoff is 60/300/1800/7200/21600s; max 6 attempts", () => {
    expect(ADCOS_WEBHOOK_REPLAY_WINDOW_MS).toBe(300_000);
    expect(ADCOS_WEBHOOK_RETRY_BACKOFF_SCHEDULE_MS).toEqual([
      60_000,
      300_000,
      1_800_000,
      7_200_000,
      21_600_000,
    ]);
    expect(ADCOS_WEBHOOK_MAX_DELIVERY_ATTEMPTS).toBe(6);
  });

  it("builds a validated delivery view and rejects malformed metadata", () => {
    const delivery = buildAdcosWebhookDelivery({
      signature: "sig-value",
      timestamp: "1761283200",
      keyId: "key-1",
      eventId: "evt-1",
      deliveryId: "dlv-1",
      sequence: 42,
      algorithm: "hmac-sha256",
    });
    expect(delivery.eventId).toBe("evt-1");
    expect(delivery.sequence).toBe(42);
    expect(delivery.algorithm).toBe(ADCOS_WEBHOOK_SIGNATURE_ALGORITHM);
    expect(() =>
      buildAdcosWebhookDelivery({
        signature: "",
        timestamp: "1761283200",
        keyId: "key-1",
        eventId: "evt-1",
        deliveryId: "dlv-1",
        sequence: 42,
        algorithm: "hmac-sha256",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      buildAdcosWebhookDelivery({
        signature: "s",
        timestamp: "1761283200",
        keyId: "key-1",
        eventId: "evt-1",
        deliveryId: "dlv-1",
        sequence: 1.5,
        algorithm: "hmac-sha256",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      buildAdcosWebhookDelivery({
        signature: "s",
        timestamp: "1761283200",
        keyId: "key-1",
        eventId: "evt-1",
        deliveryId: "dlv-1",
        sequence: 42,
        algorithm: "sha1",
      }),
    ).toThrow(ValidationError);
  });

  it("the signature message deterministically joins keyId, timestamp, deliveryId, payload", () => {
    expect(ADCOS_WEBHOOK_SIGNATURE_MESSAGE_SEPARATOR).toBe("\n");
    const message = buildAdcosWebhookSignatureMessage({
      keyId: "key-1",
      timestamp: "1761283200",
      deliveryId: "dlv-1",
      payload: '{"event_id":"evt-1"}',
    });
    expect(message).toBe('key-1\n1761283200\ndlv-1\n{"event_id":"evt-1"}');
    // deterministic
    expect(
      buildAdcosWebhookSignatureMessage({
        keyId: "key-1",
        timestamp: "1761283200",
        deliveryId: "dlv-1",
        payload: '{"event_id":"evt-1"}',
      }),
    ).toBe(message);
    // components containing the separator are rejected (ambiguous input)
    expect(() =>
      buildAdcosWebhookSignatureMessage({
        keyId: "bad\nkey",
        timestamp: "1761283200",
        deliveryId: "dlv-1",
        payload: "{}",
      }),
    ).toThrow(ValidationError);
  });
});
