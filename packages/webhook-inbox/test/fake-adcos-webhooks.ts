/**
 * The fake ADCOS webhook source (RL-033 test double, spec §10).
 *
 * Signs deliveries exactly per the pinned v2 webhook contract (HMAC-SHA256
 * over the canonical signature message with a test key) so the inbox and
 * verifier run against realistic wire input. Fault knobs: duplicate
 * deliveries, reordering, tampered payloads/signatures, stale timestamps,
 * unknown key ids, wrong environments, wrong api versions, oversized
 * payloads and malformed envelopes. No ADCOS internals are used.
 */
import { canonicalizeJson } from "@roamlink/contracts";
import type { UtcInstant } from "@roamlink/contracts";
import {
  ADCOS_REQUEST_HEADER_NAMES,
  ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES,
  ADCOS_WEBHOOK_SIGNATURE_MESSAGE_SEPARATOR,
  buildAdcosWebhookSignatureMessage,
  type AdcosWebhookEvent,
  type AdcosWebhookEventType,
  type AdcosWebhookResourceKind,
} from "@roamlink/adcos";
import { createHmac } from "node:crypto";
import { signWebhookDelivery } from "../src/verifier.js";

export const TEST_SIGNING_KEY_ID = "whk-test-1";
export const TEST_SIGNING_SECRET = "test-signing-secret-never-in-prod";

export interface FakeWebhookEventSpec {
  readonly eventId: string;
  readonly eventType: AdcosWebhookEventType;
  readonly resourceId: string;
  readonly resourceKind: AdcosWebhookResourceKind;
  readonly resourceVersion: number;
  readonly occurredAt: UtcInstant | string;
  readonly correlationId?: string;
  readonly environment?: "sandbox" | "production";
  readonly apiVersion?: string;
  /** Extra envelope members to inject (closed-envelope violation knob). */
  readonly extraMembers?: Record<string, unknown>;
}

export interface FakeWebhookDeliveryOverrides {
  /** Replace the signature with garbage (tamper knob). */
  readonly tamperSignature?: boolean;
  /** Sign a DIFFERENT payload than the one delivered (tamper knob). */
  readonly tamperPayload?: string;
  /** Override the timestamp header AFTER signing (stale knob). */
  readonly staleTimestamp?: string;
  /** Use an unregistered key id (unknown-key knob). */
  readonly unknownKeyId?: string;
  /** Omit a header entirely (malformed knob). */
  readonly dropHeader?: string;
}

export interface FakeWebhookDeliveryInput {
  readonly spec: FakeWebhookEventSpec;
  readonly deliveryId: string;
  readonly sequence: number;
  readonly receivedAt: UtcInstant | string;
  readonly overrides?: FakeWebhookDeliveryOverrides;
  /** The signing key id + secret (defaults to the test key). */
  readonly keyId?: string;
  readonly secret?: string;
}

/** Builds the canonical event envelope JSON for a spec. */
export function fakeEventPayload(spec: FakeWebhookEventSpec): string {
  const event: Record<string, unknown> = {
    event_id: spec.eventId,
    event_type: spec.eventType,
    resource_id: spec.resourceId,
    resource_kind: spec.resourceKind,
    resource_version: spec.resourceVersion,
    occurred_at: spec.occurredAt,
    api_version: spec.apiVersion ?? "2.0",
    environment: spec.environment ?? "sandbox",
    correlation_id: spec.correlationId ?? `corr-${spec.eventId}`,
  };
  if (spec.extraMembers !== undefined) {
    Object.assign(event, spec.extraMembers);
  }
  return canonicalizeJson(event);
}

function sign(secret: string, keyId: string, timestamp: string, deliveryId: string, payload: string): string {
  const message = buildAdcosWebhookSignatureMessage({
    keyId,
    timestamp,
    deliveryId,
    payload,
  });
  return signWebhookDelivery(secret, message);
}

/**
 * Builds one signed delivery exactly as ADCOS would deliver it (headers by
 * exact name + the byte-exact payload), honoring the fault knobs.
 */
export function fakeWebhookDelivery(input: FakeWebhookDeliveryInput): {
  readonly headers: Record<string, string>;
  readonly payload: string;
} {
  const keyId = input.overrides?.unknownKeyId ?? input.keyId ?? TEST_SIGNING_KEY_ID;
  const secret = input.secret ?? TEST_SIGNING_SECRET;
  const payload = input.overrides?.tamperPayload ?? fakeEventPayload(input.spec);
  const timestamp = (typeof input.spec.occurredAt === "string"
    ? input.spec.occurredAt
    : input.spec.occurredAt) as string;
  let signature = sign(secret, keyId, timestamp, input.deliveryId, payload);
  if (input.overrides?.tamperSignature) {
    signature = `00${signature.slice(2)}`;
  }
  const headers: Record<string, string> = {
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.signature]: signature,
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.timestamp]:
      input.overrides?.staleTimestamp ?? timestamp,
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.keyId]: keyId,
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.eventId]: input.spec.eventId,
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.deliveryId]: input.deliveryId,
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.sequence]: String(input.sequence),
    [ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.algorithm]: "hmac-sha256",
  };
  if (input.overrides?.dropHeader !== undefined) {
    delete headers[input.overrides.dropHeader];
  }
  return { headers, payload };
}

/** Convenience: the header name constants for assertions. */
export const FAKE_HEADER_NAMES = ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES;
export const FAKE_SIGNATURE_SEPARATOR = ADCOS_WEBHOOK_SIGNATURE_MESSAGE_SEPARATOR;
export const FAKE_REQUEST_HEADER_NAMES = ADCOS_REQUEST_HEADER_NAMES;

/** Re-export for the HMAC known-answer check in tests. */
export function fakeHmac(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

export type { AdcosWebhookEvent };
