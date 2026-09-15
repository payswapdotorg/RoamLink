/**
 * The typed webhook verifier seam (RL-030) - TYPES ONLY.
 *
 * Covers the three verification concerns of inbound ADCOS webhooks:
 *  1. SIGNATURE: HMAC-SHA256 over the canonical envelope
 *     (key id + timestamp + delivery id + payload - see ./webhooks.ts);
 *  2. TIMESTAMP WINDOW: reject deliveries older than the 300s replay window
 *     (`webhook-timestamp-stale`);
 *  3. DEDUPE KEY EXTRACTION: the dedupe key is the event id.
 *
 * A verifying implementation must ALSO fail closed on envelope environment
 * mismatches (`environment-mismatch`) and unsupported API versions
 * (`version-unsupported`). RL-033 implements this interface together with
 * durable inbox admission (the outbox/inbox primitives live in
 * @roamlink/persistence, RL-003).
 */
import type { AdcosDeliveryId, AdcosEventId, UtcInstant } from "@roamlink/contracts";
import type { AdcosErrorCode } from "./errors.js";
import type { AdcosWebhookDelivery, AdcosWebhookEvent } from "./webhooks.js";

/** What a verifier receives: the raw delivery, untouched. */
export interface AdcosWebhookVerifyInput {
  /** The raw delivery headers (by exact header name). */
  readonly headers: Readonly<Record<string, string>>;
  /** The raw delivered body, byte-exact (never re-serialized before verification). */
  readonly payload: string;
  /** The instant RoamLink received the delivery (replay-window evaluation). */
  readonly receivedAt: UtcInstant;
}

/** A verified, parsed delivery: the signal is authenticated and dedupe-able. */
export interface AdcosWebhookVerificationOk {
  readonly ok: true;
  readonly event: AdcosWebhookEvent;
  readonly delivery: AdcosWebhookDelivery;
  /** The dedupe key: the ADCOS event id (dedupe by event id). */
  readonly dedupeKey: AdcosEventId;
}

/** A failed verification with the closed ADCOS error code that explains it. */
export interface AdcosWebhookVerificationFailure {
  readonly ok: false;
  readonly code: AdcosErrorCode;
  /** Log-safe failure description (field names, never values - RL-LOCK-016). */
  readonly message: string;
}

export type AdcosWebhookVerification =
  | AdcosWebhookVerificationOk
  | AdcosWebhookVerificationFailure;

/**
 * Verifies inbound ADCOS webhook deliveries. Implementations are bound to
 * one environment + API version + signing keys and fail closed on mismatch.
 */
export interface WebhookVerifier {
  verify(input: AdcosWebhookVerifyInput): Promise<AdcosWebhookVerification>;
}

/** Re-exported for implementers: delivery ids identify deliveries, not events. */
export type { AdcosDeliveryId };
