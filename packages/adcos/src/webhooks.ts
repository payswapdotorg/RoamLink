/**
 * The ADCOS v2 webhook contract (RL-030, RL-LOCK-009: webhooks are signals,
 * not truth - this module types the SIGNAL; admission/reconciliation are
 * RL-033/RL-035).
 *
 * Verified v2 facts encoded here:
 *  - 9 event types across 4 resource kinds;
 *  - the event envelope members (event id, event type, resource id/kind,
 *    resource_version, occurred_at, API/schema version, environment,
 *    correlation id);
 *  - the 7 delivery headers;
 *  - HMAC-SHA256 over the canonical envelope with key id + timestamp +
 *    delivery id + payload as the signed components;
 *  - replay window 300s (older deliveries are rejected with
 *    `webhook-timestamp-stale`);
 *  - dedupe by event id; ordering signal = resource_version + per-endpoint
 *    sequence;
 *  - retry backoff 60/300/1800/7200/21600s, max 6 delivery attempts.
 *
 * CAVEAT (flagged for the TL): the exact string separator of the signed
 * message (keyId + timestamp + deliveryId + payload) is NOT pinned by the
 * verified facts; this contract defines newline-joined components and the
 * builder below is the single site for that decision. RL-033 must confirm
 * it against the ADCOS repository before implementing verification.
 */
import {
  ValidationError,
  parseForeignRefAs,
  parseRevision,
  parseUtcInstant,
  type AdcosApiVersion,
  type AdcosDeliveryId,
  type AdcosEventId,
  type AdcosResourceId,
  type CorrelationId,
  type Revision,
  type UtcInstant,
} from "@roamlink/contracts";
import { type AdcosEnvironment } from "./environments.js";
import { ADCOS_API_VERSION } from "./version.js";

// --------------------------------------------------------------------------------
// Event types and resource kinds
// --------------------------------------------------------------------------------

export const ADCOS_WEBHOOK_EVENT_TYPES = [
  "connectivity_intent.created",
  "connectivity_contract.offers_selected",
  "connectivity_contract.activated",
  "connectivity_contract.terminated",
  "connectivity_contract.state_changed",
  "connectivity_lease.granted",
  "connectivity_lease.renewed",
  "connectivity_lease.revoked",
  "webhook_endpoint.registered",
] as const;

export type AdcosWebhookEventType = (typeof ADCOS_WEBHOOK_EVENT_TYPES)[number];

/**
 * The resource kinds events reference - derived from the event-type prefixes
 * of the closed event-type list (connectivity_intent, connectivity_contract,
 * connectivity_lease, webhook_endpoint).
 */
export const ADCOS_WEBHOOK_RESOURCE_KINDS = [
  "connectivity_intent",
  "connectivity_contract",
  "connectivity_lease",
  "webhook_endpoint",
] as const;

export type AdcosWebhookResourceKind = (typeof ADCOS_WEBHOOK_RESOURCE_KINDS)[number];

export function isAdcosWebhookEventType(value: unknown): value is AdcosWebhookEventType {
  return (
    typeof value === "string" && (ADCOS_WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function isAdcosWebhookResourceKind(value: unknown): value is AdcosWebhookResourceKind {
  return (
    typeof value === "string" && (ADCOS_WEBHOOK_RESOURCE_KINDS as readonly string[]).includes(value)
  );
}

/** Parses an event type; anything outside the closed set is rejected. */
export function parseAdcosWebhookEventType(value: unknown): AdcosWebhookEventType {
  if (!isAdcosWebhookEventType(value)) {
    throw new ValidationError(
      "AdcosWebhookEventType must be one of the 9 documented ADCOS v2 event types",
      {
        reason: "ADCOS_WEBHOOK_EVENT_TYPE_INVALID",
        details: [{ path: "AdcosWebhookEventType", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/** Parses a resource kind; anything outside the closed set is rejected. */
export function parseAdcosWebhookResourceKind(value: unknown): AdcosWebhookResourceKind {
  if (!isAdcosWebhookResourceKind(value)) {
    throw new ValidationError(
      "AdcosWebhookResourceKind must be one of the resource kinds derived from the event types",
      {
        reason: "ADCOS_WEBHOOK_RESOURCE_KIND_INVALID",
        details: [{ path: "AdcosWebhookResourceKind", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

// --------------------------------------------------------------------------------
// Event envelope (closed: exactly the 9 documented members)
// --------------------------------------------------------------------------------

/**
 * The webhook event envelope. Members exactly as documented: event id, event
 * type, resource id/kind, resource_version, occurred_at, API/schema version,
 * environment, correlation id.
 */
export interface AdcosWebhookEvent {
  readonly event_id: AdcosEventId;
  readonly event_type: AdcosWebhookEventType;
  readonly resource_id: AdcosResourceId;
  readonly resource_kind: AdcosWebhookResourceKind;
  readonly resource_version: Revision;
  readonly occurred_at: UtcInstant;
  readonly api_version: AdcosApiVersion;
  readonly environment: AdcosEnvironment;
  readonly correlation_id: CorrelationId;
}

const WEBHOOK_EVENT_FIELDS = [
  "event_id",
  "event_type",
  "resource_id",
  "resource_kind",
  "resource_version",
  "occurred_at",
  "api_version",
  "environment",
  "correlation_id",
] as const;

export function parseAdcosWebhookEvent(value: unknown): AdcosWebhookEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("AdcosWebhookEvent must be an object", {
      reason: "ADCOS_WEBHOOK_EVENT_INVALID",
      details: [{ path: "AdcosWebhookEvent", issue: "not an object" }],
    });
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(WEBHOOK_EVENT_FIELDS as readonly string[]).includes(key)) {
      throw new ValidationError(`AdcosWebhookEvent rejected unknown field '${key}'`, {
        reason: "ADCOS_WEBHOOK_EVENT_INVALID",
        details: [{ path: `AdcosWebhookEvent.${key}`, issue: "unknown field (closed envelope)" }],
      });
    }
  }
  const missing = WEBHOOK_EVENT_FIELDS.filter((field) => record[field] === undefined);
  if (missing.length > 0) {
    throw new ValidationError(
      `AdcosWebhookEvent is missing required member(s): ${missing.join(", ")}`,
      {
        reason: "ADCOS_WEBHOOK_EVENT_INVALID",
        details: missing.map((field) => ({
          path: `AdcosWebhookEvent.${field}`,
          issue: "required member missing",
        })),
      },
    );
  }
  const environmentValue = record["environment"];
  if (
    environmentValue !== "sandbox" &&
    environmentValue !== "production"
  ) {
    throw new ValidationError(
      "AdcosWebhookEvent.environment must be sandbox or production (fail-closed on anything else)",
      {
        reason: "ADCOS_WEBHOOK_EVENT_INVALID",
        details: [{ path: "AdcosWebhookEvent.environment", issue: "outside the closed set" }],
      },
    );
  }
  return Object.freeze({
    event_id: parseForeignRefAs<AdcosEventId>(record["event_id"], "AdcosWebhookEvent.event_id"),
    event_type: parseAdcosWebhookEventType(record["event_type"]),
    resource_id: parseForeignRefAs<AdcosResourceId>(
      record["resource_id"],
      "AdcosWebhookEvent.resource_id",
    ),
    resource_kind: parseAdcosWebhookResourceKind(record["resource_kind"]),
    resource_version: parseRevision(record["resource_version"]),
    occurred_at: parseUtcInstant(record["occurred_at"]),
    api_version: parseAdcosApiVersionMember(record["api_version"]),
    environment: environmentValue,
    correlation_id: parseForeignRefAs<CorrelationId>(
      record["correlation_id"],
      "AdcosWebhookEvent.correlation_id",
    ),
  });
}

function parseAdcosApiVersionMember(value: unknown): AdcosApiVersion {
  if (value !== ADCOS_API_VERSION) {
    throw new ValidationError(
      "AdcosWebhookEvent.api_version must be the pinned ADCOS API version line (version-unsupported otherwise)",
      {
        reason: "ADCOS_WEBHOOK_EVENT_INVALID",
        details: [{ path: "AdcosWebhookEvent.api_version", issue: "not the supported version" }],
      },
    );
  }
  return ADCOS_API_VERSION;
}

// --------------------------------------------------------------------------------
// Delivery metadata (headers) and signature scheme
// --------------------------------------------------------------------------------

/** The 7 delivery headers present on every webhook delivery. */
export const ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES = Object.freeze({
  signature: "X-ADCOS-Signature",
  timestamp: "X-ADCOS-Timestamp",
  keyId: "X-ADCOS-Key-Id",
  eventId: "X-ADCOS-Event-Id",
  deliveryId: "X-ADCOS-Delivery-Id",
  sequence: "X-ADCOS-Sequence",
  algorithm: "X-ADCOS-Algorithm",
});

/** The pinned signature algorithm (HMAC-SHA256). */
export const ADCOS_WEBHOOK_SIGNATURE_ALGORITHM = "hmac-sha256";

/** Replay window: deliveries older than 300s are rejected as stale. */
export const ADCOS_WEBHOOK_REPLAY_WINDOW_MS = 300_000;

/**
 * ADCOS retry backoff between delivery attempts, in milliseconds:
 * 60s, 300s, 1800s (30m), 7200s (2h), 21600s (6h) - 6 attempts total.
 */
export const ADCOS_WEBHOOK_RETRY_BACKOFF_SCHEDULE_MS = Object.freeze([
  60_000,
  300_000,
  1_800_000,
  7_200_000,
  21_600_000,
] as const);

/** Maximum delivery attempts per webhook (initial + 5 retries). */
export const ADCOS_WEBHOOK_MAX_DELIVERY_ATTEMPTS = 6;

/**
 * The typed delivery metadata of one inbound webhook (parsed from the
 * delivery headers). `sequence` is the per-endpoint monotonic ordering
 * signal; together with the envelope's `resource_version` it forms the
 * ordering signal for consumers.
 */
export interface AdcosWebhookDelivery {
  /** The signature value (opaque; encoding not pinned by the verified facts). */
  readonly signature: string;
  /**
   * The raw timestamp header value. The exact timestamp format is not pinned
   * by the verified facts - verification (RL-033) parses it per the real
   * format; the replay window constant above defines the policy.
   */
  readonly timestamp: string;
  readonly keyId: string;
  readonly eventId: AdcosEventId;
  readonly deliveryId: AdcosDeliveryId;
  /** Per-endpoint monotonic sequence (ordering signal). */
  readonly sequence: number;
  readonly algorithm: string;
}

/** Builds the frozen, validated delivery metadata view. */
export function buildAdcosWebhookDelivery(input: {
  readonly signature: string;
  readonly timestamp: string;
  readonly keyId: string;
  readonly eventId: string;
  readonly deliveryId: string;
  readonly sequence: number;
  readonly algorithm: string;
}): AdcosWebhookDelivery {
  if (
    typeof input.signature !== "string" ||
    input.signature.length === 0 ||
    input.signature.length > 512
  ) {
    throw new ValidationError("AdcosWebhookDelivery.signature must be a non-empty string", {
      reason: "ADCOS_WEBHOOK_DELIVERY_INVALID",
      details: [{ path: "AdcosWebhookDelivery.signature", issue: "not a non-empty string" }],
    });
  }
  if (typeof input.timestamp !== "string" || input.timestamp.length === 0) {
    throw new ValidationError("AdcosWebhookDelivery.timestamp must be a non-empty string", {
      reason: "ADCOS_WEBHOOK_DELIVERY_INVALID",
      details: [{ path: "AdcosWebhookDelivery.timestamp", issue: "not a non-empty string" }],
    });
  }
  if (typeof input.keyId !== "string" || input.keyId.length === 0 || input.keyId.length > 255) {
    throw new ValidationError("AdcosWebhookDelivery.keyId must be a non-empty string", {
      reason: "ADCOS_WEBHOOK_DELIVERY_INVALID",
      details: [{ path: "AdcosWebhookDelivery.keyId", issue: "not a non-empty string" }],
    });
  }
  if (typeof input.sequence !== "number" || !Number.isInteger(input.sequence) || input.sequence < 0) {
    throw new ValidationError(
      "AdcosWebhookDelivery.sequence must be a non-negative integer (per-endpoint ordering signal)",
      {
        reason: "ADCOS_WEBHOOK_DELIVERY_INVALID",
        details: [{ path: "AdcosWebhookDelivery.sequence", issue: "not a non-negative integer" }],
      },
    );
  }
  if (input.algorithm !== ADCOS_WEBHOOK_SIGNATURE_ALGORITHM) {
    throw new ValidationError(
      `AdcosWebhookDelivery.algorithm must be '${ADCOS_WEBHOOK_SIGNATURE_ALGORITHM}' (webhook-signature-invalid otherwise)`,
      {
        reason: "ADCOS_WEBHOOK_DELIVERY_INVALID",
        details: [{ path: "AdcosWebhookDelivery.algorithm", issue: "unsupported algorithm" }],
      },
    );
  }
  return Object.freeze({
    signature: input.signature,
    timestamp: input.timestamp,
    keyId: input.keyId,
    eventId: parseForeignRefAs<AdcosEventId>(input.eventId, "AdcosWebhookDelivery.eventId"),
    deliveryId: parseForeignRefAs<AdcosDeliveryId>(input.deliveryId, "AdcosWebhookDelivery.deliveryId"),
    sequence: input.sequence,
    algorithm: input.algorithm,
  });
}

// --------------------------------------------------------------------------------
// Signature message (canonical signing input)
// --------------------------------------------------------------------------------

/**
 * The separator joining the signed message components. NOT pinned by the
 * verified facts - see the module doc and the RL-030 report caveat.
 */
export const ADCOS_WEBHOOK_SIGNATURE_MESSAGE_SEPARATOR = "\n";

/**
 * The canonical signed message: `keyId SEP timestamp SEP deliveryId SEP
 * payload`, where `payload` is the delivered envelope (v2 signs the
 * canonical envelope form; when the delivered body is the canonical form the
 * raw bytes are the payload component). Deterministic by construction.
 */
export function buildAdcosWebhookSignatureMessage(input: {
  readonly keyId: string;
  readonly timestamp: string;
  readonly deliveryId: string;
  readonly payload: string;
}): string {
  const separator = ADCOS_WEBHOOK_SIGNATURE_MESSAGE_SEPARATOR;
  const components = [input.keyId, input.timestamp, input.deliveryId, input.payload];
  for (const [index, component] of components.entries()) {
    if (typeof component !== "string" || component.indexOf(separator) !== -1) {
      throw new ValidationError(
        `signature message component ${index} must not contain the separator (canonical signing input would be ambiguous)`,
        {
          reason: "ADCOS_WEBHOOK_SIGNATURE_INVALID",
          details: [{ path: `signatureMessage.component[${index}]`, issue: "contains separator" }],
        },
      );
    }
  }
  return components.join(separator);
}
