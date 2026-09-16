/**
 * The HMAC webhook verifier (RL-033, implementing the WebhookVerifier seam
 * from @roamlink/adcos).
 *
 * Verifies an inbound ADCOS webhook delivery against the pinned v2 webhook
 * contract, failing CLOSED with the closed ADCOS error codes:
 *
 *  1. delivery headers: all 7 documented headers must parse
 *     (buildAdcosWebhookDelivery) - malformed -> `webhook-signature-invalid`;
 *  2. signing key: the key id must resolve in the server-side registry -
 *     unknown key -> `authentication-invalid`;
 *  3. timestamp: must parse as a UTC instant and fall within the 300s replay
 *     window (in BOTH directions - a future-stamped delivery is as suspect
 *     as a stale one) -> `webhook-timestamp-stale`;
 *  4. signature: HMAC-SHA256 over the canonical signature message
 *     (keyId \\n timestamp \\n deliveryId \\n payload), compared in constant
 *     time; the signature VALUE is hex - this package's single-site decision
 *     on the encoding the verified facts leave open (flagged for RL-036) ->
 *     `webhook-signature-invalid`;
 *  5. payload: the signed body must parse as the CLOSED 9-member v2 event
 *     envelope -> `webhook-signature-invalid` (authenticated-but-malformed);
 *  6. environment: the envelope environment must equal the verifier's scope
 *     -> `environment-mismatch`;
 *  7. version: the envelope api_version must equal the pinned 2.0 ->
 *     `version-unsupported`;
 *  8. consistency: the delivery's event id header must equal the envelope's
 *     event_id -> `webhook-signature-invalid`.
 *
 * The dedupe key is the event id (verified events only). Secrets (the HMAC
 * keys) never appear in failures (RL-LOCK-016).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { epochMsOf, parseUtcInstant, type UtcInstant } from "@roamlink/contracts";
import {
  ADCOS_API_VERSION,
  ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES,
  ADCOS_WEBHOOK_REPLAY_WINDOW_MS,
  buildAdcosWebhookDelivery,
  buildAdcosWebhookSignatureMessage,
  parseAdcosWebhookEvent,
  type AdcosErrorCode,
  type AdcosWebhookEvent,
  type AdcosWebhookDelivery,
  type AdcosWebhookVerifyInput,
  type AdcosWebhookVerification,
  type AdcosWebhookVerificationFailure,
  type WebhookVerifier,
} from "@roamlink/adcos";
import type { AdcosEnvironment } from "@roamlink/adcos";

// --------------------------------------------------------------------------------
// Signing key registry (server-side secrets, never logged)
// --------------------------------------------------------------------------------

/**
 * Resolves the server-side HMAC secret for a webhook key id. Secrets are
 * injected by the runtime secret mechanism (RL-050) and never appear in
 * errors, logs or persisted records (RL-LOCK-016).
 */
export interface WebhookSigningKeyRegistry {
  /** The secret for `keyId`, or null when the key id is unknown. */
  secretForKeyId(keyId: string): string | null;
}

/** A static in-memory key registry (tests and simple deployments). */
export class StaticWebhookSigningKeyRegistry implements WebhookSigningKeyRegistry {
  readonly #keys: ReadonlyMap<string, string>;

  constructor(keys: Readonly<Record<string, string>> | ReadonlyMap<string, string>) {
    this.#keys = keys instanceof Map ? new Map(keys) : new Map(Object.entries(keys));
  }

  secretForKeyId(keyId: string): string | null {
    return this.#keys.get(keyId) ?? null;
  }
}

// --------------------------------------------------------------------------------
// The verifier
// --------------------------------------------------------------------------------

export interface HmacWebhookVerifierOptions {
  /** The environment this verifier is scoped to (fail-closed on mismatch). */
  readonly environment: AdcosEnvironment;
  readonly keys: WebhookSigningKeyRegistry;
  /** Payload-size admission limit in bytes (default 256 KiB). */
  readonly maxPayloadBytes?: number;
}

/** The default webhook payload admission limit (256 KiB). */
export const DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES = 262_144;

/** Computes the HMAC-SHA256 hex signature over the canonical message. */
export function signWebhookDelivery(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

/** Constant-time equality of two hex signatures. */
export function signaturesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function fail(code: AdcosErrorCode, message: string): AdcosWebhookVerificationFailure {
  return { ok: false, code, message };
}

/**
 * The HMAC-SHA256 webhook verifier bound to one environment + key registry.
 * `verify` NEVER throws: failures return the typed closed-code result
 * (callers persist rejection audit rows and answer non-2xx).
 */
export class HmacWebhookVerifier implements WebhookVerifier {
  readonly environment: AdcosEnvironment;
  readonly #keys: WebhookSigningKeyRegistry;
  readonly #maxPayloadBytes: number;

  constructor(options: HmacWebhookVerifierOptions) {
    this.environment = options.environment;
    this.#keys = options.keys;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES;
    if (!Number.isInteger(this.#maxPayloadBytes) || this.#maxPayloadBytes < 1) {
      throw new RangeError("HmacWebhookVerifier maxPayloadBytes must be a positive integer");
    }
  }

  async verify(input: AdcosWebhookVerifyInput): Promise<AdcosWebhookVerification> {
    const result = this.verifySync(input);
    return result;
  }

  /** Synchronous verification core (the async surface keeps the seam shape). */
  verifySync(input: AdcosWebhookVerifyInput): AdcosWebhookVerification {
    if (input === null || typeof input !== "object" || typeof input.payload !== "string") {
      return fail("webhook-signature-invalid", "the delivery input must carry the byte-exact payload string");
    }
    const payloadBytes = Buffer.from(input.payload, "utf8");
    if (payloadBytes.length > this.#maxPayloadBytes) {
      return fail(
        "invalid-input",
        `the delivered payload exceeds the admission limit of ${this.#maxPayloadBytes} bytes (payload-size policy, spec/security.md)`,
      );
    }

    const headers = input.headers ?? {};
    const header = (name: string): string | undefined => {
      const value = headers[name];
      return typeof value === "string" ? value : undefined;
    };

    let delivery: AdcosWebhookDelivery;
    try {
      delivery = buildAdcosWebhookDelivery({
        signature: header(ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.signature) ?? "",
        timestamp: header(ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.timestamp) ?? "",
        keyId: header(ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.keyId) ?? "",
        eventId: header(ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.eventId) ?? "",
        deliveryId: header(ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.deliveryId) ?? "",
        sequence: parseSequenceHeader(header(ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.sequence)),
        algorithm: header(ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES.algorithm) ?? "",
      });
    } catch {
      return fail(
        "webhook-signature-invalid",
        "the delivery headers do not satisfy the pinned v2 webhook delivery contract (missing/malformed headers, or an unsupported signature algorithm)",
      );
    }

    // 2. resolve the signing key (unknown key id -> authentication failure)
    const secret = this.#keys.secretForKeyId(delivery.keyId);
    if (secret === null) {
      return fail(
        "authentication-invalid",
        "the delivery's signing key id is not registered for this verifier; failing closed (values are never echoed)",
      );
    }

    // 3. timestamp within the replay window (both directions)
    let timestamp: UtcInstant;
    try {
      timestamp = parseUtcInstant(delivery.timestamp);
    } catch {
      return fail(
        "webhook-timestamp-stale",
        "the delivery timestamp header could not be parsed as a UTC instant with an explicit zone designator",
      );
    }
    const receivedAt = parseUtcInstant(input.receivedAt);
    const skewMs = Math.abs(epochMsOf(timestamp) - epochMsOf(receivedAt));
    if (skewMs > ADCOS_WEBHOOK_REPLAY_WINDOW_MS) {
      return fail(
        "webhook-timestamp-stale",
        `the delivery timestamp falls outside the ${ADCOS_WEBHOOK_REPLAY_WINDOW_MS}ms replay window (replay protection, spec/security.md)`,
      );
    }

    // 4. signature: HMAC-SHA256 over the canonical message, constant-time
    const message = buildAdcosWebhookSignatureMessage({
      keyId: delivery.keyId,
      timestamp: delivery.timestamp,
      deliveryId: delivery.deliveryId,
      payload: input.payload,
    });
    const expected = signWebhookDelivery(secret, message);
    if (!signaturesMatch(expected, delivery.signature)) {
      return fail(
        "webhook-signature-invalid",
        "the delivery signature does not verify against the canonical signed message (HMAC-SHA256, hex encoding)",
      );
    }

    // 5. payload must parse as the closed event envelope
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.payload);
    } catch {
      return fail(
        "webhook-signature-invalid",
        "the authenticated payload is not valid JSON and therefore not a v2 event envelope",
      );
    }
    // Version check BEFORE the closed-envelope parse: the boundary parser
    // fails closed on any non-2.0 envelope, and the honest diagnosable code
    // for a versioned envelope from another line is `version-unsupported`.
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const envelopeVersion = (parsed as Record<string, unknown>)["api_version"];
      if (envelopeVersion !== undefined && envelopeVersion !== ADCOS_API_VERSION) {
        return {
          ok: false,
          code: "version-unsupported",
          message: "the event envelope api_version is not the pinned supported ADCOS version line",
        };
      }
    }
    let event: AdcosWebhookEvent;
    try {
      event = parseAdcosWebhookEvent(parsed);
    } catch {
      return fail(
        "webhook-signature-invalid",
        "the authenticated payload does not satisfy the closed v2 event envelope (9 documented members)",
      );
    }

    // 6. environment must match the verifier's scope
    if (event.environment !== this.environment) {
      return {
        ok: false,
        code: "environment-mismatch",
        message:
          "the event envelope environment does not match the environment this verifier is scoped to; failing closed (values are never echoed)",
      };
    }

    // 7. API version must be the pinned line
    if (event.api_version !== ADCOS_API_VERSION) {
      return {
        ok: false,
        code: "version-unsupported",
        message: "the event envelope api_version is not the pinned supported ADCOS version line",
      };
    }

    // 8. delivery metadata must agree with the signed envelope
    if (delivery.eventId !== event.event_id) {
      return fail(
        "webhook-signature-invalid",
        "the delivery's event id header disagrees with the signed event envelope's event id",
      );
    }

    return {
      ok: true,
      event,
      delivery,
      dedupeKey: event.event_id,
    };
  }
}

function parseSequenceHeader(value: string | undefined): number {
  if (value === undefined || value.length === 0) {
    throw new RangeError("the sequence header is required");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RangeError("the sequence header must be a non-negative integer");
  }
  return parsed;
}
