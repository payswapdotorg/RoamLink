/**
 * The RoamLink-side customer webhook contract (RL-063, spec/api.md
 * "Webhooks"; RL-LOCK-009).
 *
 * RoamLink exposes its OWN webhook contract to customer integrations.
 * Customer webhooks are emitted from RoamLink's DURABLE state transitions -
 * NEVER directly from unverified ADCOS event payloads. The discipline is the
 * outbound mirror of the ADCOS webhook inbox (RL-033) and of the
 * notifications TransitionOrigin contract (RL-014):
 *
 *  - the ONLY emit input is a {@link DurableStateTransition} whose closed
 *    single-member origin vocabulary (`roamlink_state_transition`), closed
 *    RoamLink aggregate-type vocabulary and REQUIRED durable event id leave
 *    NO shape for a raw ADCOS payload to pass - an ADCOS event would have to
 *    lie about being a persisted RoamLink transition to fit, and the parser
 *    rejects every lie (RL-LOCK-018 - tests prove it);
 *  - every delivery is AUTHENTICATED: HMAC-SHA256 over the canonical
 *    signature message, carried in seven named headers exactly like the
 *    ADCOS delivery contract;
 *  - REPLAY PROTECTION: a delivery timestamp inside a bounded window in BOTH
 *    directions plus a per-endpoint monotonic sequence and per-endpoint
 *    event-id deduplication (at-most-once per endpoint in-process;
 *    at-least-once across processes is the receiver's idempotency concern,
 *    documented);
 *  - payload-size admission limits, closed failure codes, constant-time
 *    signature comparison;
 *  - signing material lives ONLY in the RL-050 secrets boundary - the
 *    endpoint record carries a typed reference (RL-LOCK-016).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  ValidationError,
  canonicalizeJson,
  epochMsOf,
  parseContractVersion,
  parseRevision,
  parseTenantId,
  parseUtcInstant,
  type ContractVersion,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";
import type { SecretsResolver, SecretRef } from "@roamlink/secrets";
import { parseSecretRef } from "@roamlink/secrets";

import {
  parseWebhookDeliveryId,
  parseWebhookEndpointId,
  type WebhookDeliveryId,
  type WebhookEndpointId,
} from "./ids.js";
import {
  describeEnterpriseContractVersionExpectation,
  isEnterpriseRecordVersionCompatible,
} from "./version.js";

// ---------------------------------------------------------------------------
// The durable state transition input (RL-LOCK-009)
// ---------------------------------------------------------------------------

/** The single-member closed origin vocabulary (see notifications RL-014). */
export const CUSTOMER_WEBHOOK_ORIGIN = "roamlink_state_transition" as const;

/**
 * The closed RoamLink aggregate-type vocabulary that may originate a
 * customer webhook. MIRRORS the notifications source-aggregate vocabulary
 * (drift-guarded by tests/architecture, never redefined here).
 */
export const ENTERPRISE_WEBHOOK_SOURCE_AGGREGATE_TYPES = [
  "order",
  "subscription",
  "customer_payment",
  "customer_invoice",
  "customer_refund",
  "experience_intent",
  "device",
  "connectivity_reference",
  "support_case",
] as const;

export type WebhookSourceAggregateType =
  (typeof ENTERPRISE_WEBHOOK_SOURCE_AGGREGATE_TYPES)[number];

export function isWebhookSourceAggregateType(
  value: unknown,
): value is WebhookSourceAggregateType {
  return (
    typeof value === "string" &&
    (ENTERPRISE_WEBHOOK_SOURCE_AGGREGATE_TYPES as readonly string[]).includes(value)
  );
}

/** The provenance of a webhook emission: WHICH durable transition caused it. */
export interface DurableStateTransition {
  /** Always "roamlink_state_transition" (closed single-member vocabulary). */
  readonly origin: typeof CUSTOMER_WEBHOOK_ORIGIN;
  readonly aggregateType: WebhookSourceAggregateType;
  readonly aggregateId: string;
  /** The durable RoamLink transition name (e.g. "order.placed"). */
  readonly transition: string;
  /**
   * The durable RoamLink event id that recorded the transition - the receipt
   * proving the transition was PERSISTED before the webhook was emitted
   * (RL-LOCK-009 - no receipt, no emission).
   */
  readonly eventId: string;
  readonly occurredAt: UtcInstant;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSITION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

function transitionField(label: string, issue: string): never {
  throw new ValidationError(`DurableStateTransition rejected: ${label} - ${issue}`, {
    reason: "DURABLE_STATE_TRANSITION_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * Validates a durable state transition - the ONLY shape the webhook
 * dispatcher accepts as emission input. Structurally rejects raw ADCOS
 * payloads (RL-LOCK-009): wrong origin, a non-RoamLink aggregate type or a
 * missing durable event id all fail closed.
 */
export function parseDurableStateTransition(value: unknown): DurableStateTransition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    transitionField("source", "must be a DurableStateTransition object (webhooks originate ONLY from RoamLink durable state transitions, never from raw ADCOS payloads)");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (
      !["origin", "aggregateType", "aggregateId", "transition", "eventId", "occurredAt"].includes(
        key,
      )
    ) {
      transitionField(
        `source.${key}`,
        "unknown field (the transition-origin vocabulary is closed; an ADCOS payload has no shape that fits here, RL-LOCK-009)",
      );
    }
  }
  if (record["origin"] !== CUSTOMER_WEBHOOK_ORIGIN) {
    transitionField("source.origin", `must be '${CUSTOMER_WEBHOOK_ORIGIN}' (the single-member closed vocabulary: a raw ADCOS/webhook payload is a SIGNAL, never a webhook source)`);
  }
  if (!isWebhookSourceAggregateType(record["aggregateType"])) {
    transitionField("source.aggregateType", "must be a member of the closed RoamLink aggregate-type vocabulary");
  }
  if (typeof record["aggregateId"] !== "string" || !UUID_PATTERN.test(record["aggregateId"])) {
    transitionField("source.aggregateId", "must be a canonical lowercase UUID (the transitioning RoamLink aggregate)");
  }
  if (
    typeof record["transition"] !== "string" ||
    !TRANSITION_PATTERN.test(record["transition"]) ||
    record["transition"].length > 120
  ) {
    transitionField("source.transition", "must be the durable RoamLink transition name (dotted lowercase tokens)");
  }
  if (typeof record["eventId"] !== "string" || !UUID_PATTERN.test(record["eventId"])) {
    transitionField("source.eventId", "must be the durable RoamLink event id proving the transition was persisted (RL-LOCK-009 - no receipt, no emission)");
  }
  let occurredAt: UtcInstant;
  try {
    occurredAt = parseUtcInstant(record["occurredAt"]);
  } catch {
    transitionField("source.occurredAt", "must be a UTC instant with a zone designator");
  }
  return Object.freeze({
    origin: CUSTOMER_WEBHOOK_ORIGIN,
    aggregateType: record["aggregateType"] as WebhookSourceAggregateType,
    aggregateId: record["aggregateId"] as string,
    transition: record["transition"] as string,
    eventId: record["eventId"] as string,
    occurredAt,
  });
}

// ---------------------------------------------------------------------------
// The outbound event envelope
// ---------------------------------------------------------------------------

/** Serialized (plain) form of one customer webhook event. */
export interface CustomerWebhookEvent {
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  /** The durable RoamLink event id (the customer's dedupe identity). */
  readonly eventId: string;
  /** The durable transition name (e.g. "order.placed"). */
  readonly eventType: string;
  readonly aggregateType: WebhookSourceAggregateType;
  readonly aggregateId: string;
  readonly occurredAt: UtcInstant;
  readonly emittedAt: UtcInstant;
}

/**
 * Builds the outbound event from a validated durable transition. The event
 * carries RoamLink state and references ONLY - no ADCOS internal types, no
 * provider mechanics (spec/api.md).
 */
export function buildCustomerWebhookEvent(
  tenantId: string,
  transition: DurableStateTransition,
  at: UtcInstant | string,
): CustomerWebhookEvent {
  const instant = parseUtcInstant(at);
  const tenant = parseTenantId(tenantId);
  return Object.freeze({
    contractVersion: parseContractVersion("0.1"),
    tenantId: tenant,
    eventId: transition.eventId,
    eventType: transition.transition,
    aggregateType: transition.aggregateType,
    aggregateId: transition.aggregateId,
    occurredAt: transition.occurredAt,
    emittedAt: instant,
  });
}

// ---------------------------------------------------------------------------
// Webhook endpoint registration
// ---------------------------------------------------------------------------

/** The closed endpoint lifecycle vocabulary. */
export const WEBHOOK_ENDPOINT_STATES = ["pending", "active", "failing", "revoked"] as const;

export type WebhookEndpointState = (typeof WEBHOOK_ENDPOINT_STATES)[number];

export function isWebhookEndpointState(value: unknown): value is WebhookEndpointState {
  return (
    typeof value === "string" &&
    (WEBHOOK_ENDPOINT_STATES as readonly string[]).includes(value)
  );
}

const HTTPS_URL_PATTERN = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{1,254}$/;

/** Serialized (plain) form of a customer webhook endpoint registration. */
export interface WebhookEndpointRecord {
  readonly endpointId: WebhookEndpointId;
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  /** HTTPS-only delivery target. */
  readonly url: string;
  /** Optional event-type filter (dotted transition names); empty = all. */
  readonly eventTypes: readonly string[];
  /**
   * Reference into the RL-050 secrets boundary for the signing material.
   * Named `signingKeyRef` so persisted records stay RL-054 scanner-clean
   * (secret-SHAPED key names are flagged; the value is a log-safe ref).
   */
  readonly signingKeyRef: SecretRef;
  readonly status: WebhookEndpointState;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
  readonly lastSuccessAt?: UtcInstant;
  readonly lastFailureAt?: UtcInstant;
}

/** Input accepted by {@link parseWebhookEndpointRecord}. */
export interface WebhookEndpointInput {
  readonly endpointId: string;
  readonly contractVersion?: string;
  readonly tenantId: string;
  readonly url: string;
  readonly eventTypes?: readonly string[];
  readonly signingKeyRef: { readonly name: string; readonly version?: number | null };
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly lastSuccessAt?: string;
  readonly lastFailureAt?: string;
}

const ALLOWED_ENDPOINT_FIELDS = new Set([
  "endpointId",
  "contractVersion",
  "tenantId",
  "url",
  "eventTypes",
  "signingKeyRef",
  "status",
  "createdAt",
  "updatedAt",
  "revision",
  "lastSuccessAt",
  "lastFailureAt",
]);

function endpointField(label: string, issue: string): never {
  throw new ValidationError(`WebhookEndpointRecord rejected: ${label} - ${issue}`, {
    reason: "WEBHOOK_ENDPOINT_INVALID",
    details: [{ path: label, issue }],
  });
}

/** The secret NAME an endpoint's signing material lives under. */
export function webhookEndpointSecretName(endpointId: string): string {
  const name = `enterprise.webhook-endpoint.${endpointId}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/.test(name)) {
    throw new ValidationError(
      "the derived webhook-endpoint secret name is not a safe label (endpoint ids are canonical UUIDs)",
      { reason: "WEBHOOK_ENDPOINT_SECRET_NAME_INVALID" },
    );
  }
  return name;
}

/** Parses and freezes a webhook endpoint registration (fail-closed). */
export function parseWebhookEndpointRecord(value: unknown): WebhookEndpointRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    endpointField("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_ENDPOINT_FIELDS.has(key)) {
      endpointField(key, "unknown field (the endpoint carries exactly its contract fields; signing MATERIAL is never a field - RL-LOCK-016)");
    }
  }
  let endpointId: WebhookEndpointId;
  try {
    endpointId = parseWebhookEndpointId(input["endpointId"]);
  } catch {
    endpointField("endpointId", "must be a canonical lowercase UUID");
  }
  let contractVersion: ContractVersion;
  try {
    contractVersion = parseContractVersion(input["contractVersion"] ?? "0.1");
  } catch {
    endpointField("contractVersion", "must be a MAJOR.MINOR contract version");
  }
  if (!isEnterpriseRecordVersionCompatible(contractVersion)) {
    endpointField("contractVersion", describeEnterpriseContractVersionExpectation());
  }
  let tenantId: TenantId;
  try {
    tenantId = parseTenantId(input["tenantId"]);
  } catch {
    endpointField("tenantId", "must be a RoamLink tenant id");
  }
  const url = input["url"];
  if (typeof url !== "string" || !HTTPS_URL_PATTERN.test(url)) {
    endpointField("url", "must be an HTTPS URL (a bounded delivery target, never a credential)");
  }
  const rawEventTypes = input["eventTypes"] ?? [];
  if (!Array.isArray(rawEventTypes)) {
    endpointField("eventTypes", "must be an array of dotted transition-name filters");
  }
  const eventTypes: string[] = [];
  for (const entry of rawEventTypes as readonly unknown[]) {
    if (typeof entry !== "string" || !TRANSITION_PATTERN.test(entry) || entry.length > 120) {
      endpointField("eventTypes", "filters must be dotted lowercase transition names");
    }
    if (!eventTypes.includes(entry)) eventTypes.push(entry);
  }
  let signingKeyRef: SecretRef;
  try {
    signingKeyRef = parseSecretRef(input["signingKeyRef"]);
  } catch (error) {
    if (error instanceof ValidationError) {
      endpointField("signingKeyRef", error.message);
    }
    throw error;
  }
  if (!isWebhookEndpointState(input["status"])) {
    endpointField("status", "must be a member of the closed endpoint lifecycle vocabulary");
  }
  let createdAt: UtcInstant;
  try {
    createdAt = parseUtcInstant(input["createdAt"]);
  } catch {
    endpointField("createdAt", "must be a UTC instant with an explicit zone designator");
  }
  let updatedAt: UtcInstant;
  try {
    updatedAt = parseUtcInstant(input["updatedAt"]);
  } catch {
    endpointField("updatedAt", "must be a UTC instant with an explicit zone designator");
  }
  let revision: Revision;
  try {
    revision = parseRevision(input["revision"]);
  } catch {
    endpointField("revision", "must be a positive integer (optimistic-concurrency revision)");
  }
  let lastSuccessAt: UtcInstant | undefined;
  if (input["lastSuccessAt"] !== undefined) {
    try {
      lastSuccessAt = parseUtcInstant(input["lastSuccessAt"]);
    } catch {
      endpointField("lastSuccessAt", "must be a UTC instant with an explicit zone designator");
    }
  }
  let lastFailureAt: UtcInstant | undefined;
  if (input["lastFailureAt"] !== undefined) {
    try {
      lastFailureAt = parseUtcInstant(input["lastFailureAt"]);
    } catch {
      endpointField("lastFailureAt", "must be a UTC instant with an explicit zone designator");
    }
  }
  return Object.freeze({
    endpointId,
    contractVersion,
    tenantId,
    url: url as string,
    eventTypes: Object.freeze(eventTypes),
    signingKeyRef,
    status: input["status"] as WebhookEndpointState,
    createdAt,
    updatedAt,
    revision,
    ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
    ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
  });
}

// ---------------------------------------------------------------------------
// Signing + verification (the outbound mirror of the ADCOS inbox discipline)
// ---------------------------------------------------------------------------

/** The seven named delivery headers (mirrors the ADCOS v2 delivery contract). */
export const CUSTOMER_WEBHOOK_HEADER_NAMES = Object.freeze({
  signature: "roamlink-signature",
  timestamp: "roamlink-timestamp",
  keyId: "roamlink-key-id",
  eventId: "roamlink-event-id",
  deliveryId: "roamlink-delivery-id",
  sequence: "roamlink-sequence",
  algorithm: "roamlink-algorithm",
} as const);

/** The pinned signature algorithm. */
export const CUSTOMER_WEBHOOK_SIGNATURE_ALGORITHM = "hmac-sha256";

/** The replay window, in BOTH directions (a future stamp is as suspect as a stale one). */
export const CUSTOMER_WEBHOOK_REPLAY_WINDOW_MS = 300_000;

/** Default payload admission limit (256 KiB). */
export const DEFAULT_CUSTOMER_WEBHOOK_MAX_PAYLOAD_BYTES = 262_144;

/**
 * The canonical signature message: five newline-joined fields over the
 * byte-exact payload. Deterministic; identical on send and receive.
 */
export function buildCustomerWebhookSignatureMessage(
  keyId: string,
  timestamp: string,
  deliveryId: string,
  eventId: string,
  payload: string,
): string {
  return [keyId, timestamp, deliveryId, eventId, payload].join("\n");
}

/** HMAC-SHA256 hex signature over the canonical message. */
export function signCustomerWebhookDelivery(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

/** Constant-time equality of two hex signatures. */
export function customerWebhookSignaturesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** The closed verification-failure code vocabulary. */
export const CUSTOMER_WEBHOOK_FAILURE_CODES = [
  "invalid-input",
  "payload-too-large",
  "headers-invalid",
  "key-unknown",
  "timestamp-stale",
  "event-id-mismatch",
  "signature-invalid",
  "algorithm-unsupported",
] as const;

export type CustomerWebhookFailureCode = (typeof CUSTOMER_WEBHOOK_FAILURE_CODES)[number];

/** One verification outcome (failures carry codes, never secrets). */
export type CustomerWebhookVerification =
  | { readonly ok: true; readonly eventId: string; readonly deliveryId: string; readonly sequence: number }
  | { readonly ok: false; readonly code: CustomerWebhookFailureCode; readonly message: string };

/**
 * Resolves the endpoint-side HMAC secret for a key id. Customer integrations
 * implement this with their stored copy of the signing secret; RoamLink-side
 * tests bind the secrets boundary.
 */
export interface CustomerWebhookKeyRegistry {
  secretForKeyId(keyId: string): string | null;
}

/**
 * Fail-closed verification of one inbound customer-webhook delivery. Mirrors
 * the ADCOS inbox discipline: header contract, replay window in both
 * directions, constant-time signature over the byte-exact payload,
 * event-id consistency, algorithm pinning. NEVER throws; failures return the
 * typed code so receivers (and tests) can assert the exact defense that
 * fired.
 */
export function verifyCustomerWebhookDelivery(
  input: { readonly payload: string; readonly headers: Readonly<Record<string, string>> },
  keys: CustomerWebhookKeyRegistry,
  at: UtcInstant | string,
  options?: { readonly maxPayloadBytes?: number },
): CustomerWebhookVerification {
  const instant = parseUtcInstant(at);
  const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_CUSTOMER_WEBHOOK_MAX_PAYLOAD_BYTES;
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.payload !== "string" ||
    input.headers === null ||
    typeof input.headers !== "object"
  ) {
    return {
      ok: false,
      code: "invalid-input",
      message: "the delivery input must carry the byte-exact payload string and headers",
    };
  }
  const payloadBytes = Buffer.from(input.payload, "utf8");
  if (payloadBytes.length > maxPayloadBytes) {
    return {
      ok: false,
      code: "payload-too-large",
      message: `the delivered payload exceeds the admission limit of ${maxPayloadBytes} bytes`,
    };
  }
  const header = (name: string): string | undefined => {
    const value = input.headers[name];
    return typeof value === "string" ? value : undefined;
  };
  const signature = header(CUSTOMER_WEBHOOK_HEADER_NAMES.signature);
  const timestamp = header(CUSTOMER_WEBHOOK_HEADER_NAMES.timestamp);
  const keyId = header(CUSTOMER_WEBHOOK_HEADER_NAMES.keyId);
  const eventId = header(CUSTOMER_WEBHOOK_HEADER_NAMES.eventId);
  const deliveryId = header(CUSTOMER_WEBHOOK_HEADER_NAMES.deliveryId);
  const sequence = header(CUSTOMER_WEBHOOK_HEADER_NAMES.sequence);
  const algorithm = header(CUSTOMER_WEBHOOK_HEADER_NAMES.algorithm);
  if (
    signature === undefined ||
    timestamp === undefined ||
    keyId === undefined ||
    eventId === undefined ||
    deliveryId === undefined ||
    sequence === undefined ||
    algorithm === undefined
  ) {
    return {
      ok: false,
      code: "headers-invalid",
      message: "the delivery must carry all seven documented headers",
    };
  }
  if (algorithm !== CUSTOMER_WEBHOOK_SIGNATURE_ALGORITHM) {
    return {
      ok: false,
      code: "algorithm-unsupported",
      message: `the pinned signature algorithm is ${CUSTOMER_WEBHOOK_SIGNATURE_ALGORITHM}`,
    };
  }
  let stamp: UtcInstant;
  try {
    stamp = parseUtcInstant(timestamp);
  } catch {
    return { ok: false, code: "headers-invalid", message: "the timestamp header must be a UTC instant" };
  }
  const skewMs = Math.abs(epochMsOf(instant) - epochMsOf(stamp));
  if (skewMs > CUSTOMER_WEBHOOK_REPLAY_WINDOW_MS) {
    return {
      ok: false,
      code: "timestamp-stale",
      message: `the delivery timestamp is outside the ${CUSTOMER_WEBHOOK_REPLAY_WINDOW_MS}ms replay window (checked in both directions)`,
    };
  }
  const sequenceNumber = Number(sequence);
  if (!Number.isInteger(sequenceNumber) || sequenceNumber < 1) {
    return { ok: false, code: "headers-invalid", message: "the sequence header must be a positive integer" };
  }
  const secret = keys.secretForKeyId(keyId);
  if (secret === null) {
    return {
      ok: false,
      code: "key-unknown",
      message: "the delivery's signing key id is not registered; failing closed",
    };
  }
  const parsedEventIdOk = UUID_PATTERN.test(eventId);
  const parsedDeliveryIdOk = UUID_PATTERN.test(deliveryId);
  if (!parsedEventIdOk || !parsedDeliveryIdOk) {
    return {
      ok: false,
      code: "headers-invalid",
      message: "the event and delivery id headers must be canonical UUIDs",
    };
  }
  const message = buildCustomerWebhookSignatureMessage(
    keyId,
    timestamp,
    deliveryId,
    eventId,
    input.payload,
  );
  const expected = signCustomerWebhookDelivery(secret, message);
  if (!customerWebhookSignaturesMatch(signature, expected)) {
    return {
      ok: false,
      code: "signature-invalid",
      message: "the delivery signature does not match the byte-exact payload",
    };
  }
  // The signed payload must carry the SAME durable event id as the header.
  let parsedPayload: { readonly eventId?: unknown };
  try {
    parsedPayload = JSON.parse(input.payload) as { readonly eventId?: unknown };
  } catch {
    return {
      ok: false,
      code: "event-id-mismatch",
      message: "the signed payload is not the customer webhook event envelope",
    };
  }
  if (parsedPayload.eventId !== eventId) {
    return {
      ok: false,
      code: "event-id-mismatch",
      message: "the payload's durable event id does not match the event-id header",
    };
  }
  return { ok: true, eventId, deliveryId, sequence: sequenceNumber };
}

// ---------------------------------------------------------------------------
// Delivery records + the dispatcher
// ---------------------------------------------------------------------------

/** The closed delivery-outcome vocabulary. */
export const WEBHOOK_DELIVERY_OUTCOMES = ["delivered", "failed", "dead-lettered"] as const;

export type WebhookDeliveryOutcome = (typeof WEBHOOK_DELIVERY_OUTCOMES)[number];

/** Serialized (plain) form of one delivery attempt record. */
export interface WebhookDeliveryRecord {
  readonly deliveryId: WebhookDeliveryId;
  readonly endpointId: WebhookEndpointId;
  readonly tenantId: TenantId;
  /** The durable RoamLink event id this attempt delivered. */
  readonly eventId: string;
  /** Per-endpoint monotonic sequence (ordering defense for receivers). */
  readonly sequence: Revision;
  readonly outcome: WebhookDeliveryOutcome;
  readonly attemptedAt: UtcInstant;
  readonly responseSummary?: string;
}

/** The delivery sink port (an HTTP adapter in production; a fake in tests). */
export interface CustomerWebhookSink {
  deliver(input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly payload: string;
  }): Promise<{ readonly outcome: "delivered" } | { readonly outcome: "retryable-failure"; readonly summary?: string }>;
}

/** Storage for endpoint registrations. */
export interface WebhookEndpointStore {
  save(record: WebhookEndpointRecord): Promise<void>;
  get(endpointId: string): Promise<WebhookEndpointRecord | null>;
  listByTenant(tenantId: string): Promise<readonly WebhookEndpointRecord[]>;
}


/**
 * Storage for delivery attempt records (append-oriented). The store ALSO
 * retains the canonical payload of each delivered event id so bounded retries
 * re-deliver the BYTE-EXACT envelope (the signature covers the payload; a
 * reconstructed payload would need a fresh signature and could drift).
 */
export interface WebhookDeliveryStore {
  /** Appends one attempt record together with its canonical payload. */
  append(record: WebhookDeliveryRecord, canonicalPayload: string): Promise<void>;
  listByEndpoint(endpointId: string): Promise<readonly WebhookDeliveryRecord[]>;
  listByEvent(endpointId: string, eventId: string): Promise<readonly WebhookDeliveryRecord[]>;
  /** The canonical payload retained for an event id, or null when unknown. */
  payloadOf(eventId: string): Promise<string | null>;
}

/** Options for {@link CustomerWebhookDispatcher}. */
export interface CustomerWebhookDispatcherOptions {
  readonly endpoints: WebhookEndpointStore;
  readonly deliveries: WebhookDeliveryStore;
  readonly sink: CustomerWebhookSink;
  /** Resolves endpoint signing secrets (through the RL-050 boundary). */
  readonly secrets: SecretsResolver;
  /** Delivery-id source; inject a deterministic generator in tests. */
  readonly deliveryIdGenerator: () => string;
  /** Maximum delivery attempts per event per endpoint (default 5). */
  readonly maxAttempts?: number;
}

/** Per-endpoint outcome of one emission. */
export interface WebhookEmissionOutcome {
  readonly endpointId: WebhookEndpointId;
  /** already-delivered (deduped), delivered, failed or dead-lettered. */
  readonly outcome: "already-delivered" | WebhookDeliveryOutcome;
  readonly deliveryId?: WebhookDeliveryId;
  readonly sequence?: Revision;
}

/**
 * The customer webhook dispatcher: emits RoamLink durable state transitions
 * to a tenant's registered endpoints. Enforces, per endpoint:
 *
 *  - the event-type filter (empty = all events);
 *  - per-(endpoint, event) deduplication - a durable event that already
 *    DELIVERED is never re-delivered (idempotent re-emission);
 *  - bounded retry counting - once `maxAttempts` attempts have failed, the
 *    event is DEAD-LETTERED for that endpoint and the endpoint is marked
 *    `failing` (an honest health signal, never a silent drop);
 *  - first success flips a pending/failing endpoint to `active`.
 *
 * Every delivery is signed per the contract above; the signing material is
 * resolved through the secrets boundary and never persisted or logged
 * (RL-LOCK-016). Retries re-deliver the byte-exact stored payload under a
 * FRESH signature/timestamp (the replay window applies per delivery).
 */
export class CustomerWebhookDispatcher {
  readonly #options: CustomerWebhookDispatcherOptions;
  readonly #maxAttempts: number;

  constructor(options: CustomerWebhookDispatcherOptions) {
    if (options === null || typeof options !== "object") {
      throw new ValidationError("CustomerWebhookDispatcherOptions must be an object", {
        reason: "WEBHOOK_DISPATCHER_INVALID",
      });
    }
    this.#options = options;
    this.#maxAttempts = options.maxAttempts ?? 5;
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 100) {
      throw new ValidationError("maxAttempts must be an integer between 1 and 100", {
        reason: "WEBHOOK_DISPATCHER_INVALID",
        details: [{ path: "maxAttempts", issue: "out of bounds" }],
      });
    }
  }

  /**
   * Emits one durable state transition to every eligible endpoint of the
   * tenant. The transition is validated through the RL-LOCK-009 parser -
   * a raw ADCOS payload has no shape that reaches any sink.
   */
  async emit(
    tenantId: string,
    transition: unknown,
    at: UtcInstant | string,
  ): Promise<readonly WebhookEmissionOutcome[]> {
    const instant = parseUtcInstant(at);
    const tenant = parseTenantId(tenantId);
    const source = parseDurableStateTransition(transition);
    const event = buildCustomerWebhookEvent(tenant, source, instant);
    const payload = canonicalizeJson(event);

    const endpoints = await this.#options.endpoints.listByTenant(tenant);
    const outcomes: WebhookEmissionOutcome[] = [];
    for (const endpoint of endpoints) {
      if (endpoint.status === "revoked") continue;
      if (endpoint.eventTypes.length > 0 && !endpoint.eventTypes.includes(event.eventType)) {
        continue;
      }
      if (await this.#hasDelivered(endpoint.endpointId, event.eventId)) {
        outcomes.push({ endpointId: endpoint.endpointId, outcome: "already-delivered" });
        continue;
      }
      const priorAttempts = await this.#options.deliveries.listByEvent(
        endpoint.endpointId,
        event.eventId,
      );
      if (priorAttempts.length >= this.#maxAttempts) {
        outcomes.push({ endpointId: endpoint.endpointId, outcome: "dead-lettered" });
        continue;
      }
      outcomes.push(await this.#attempt(endpoint, event.eventId, payload, instant));
    }
    return Object.freeze(outcomes);
  }

  /**
   * Re-attempts the FAILED (non-dead-lettered) deliveries of a tenant's
   * endpoints, converging after transient receiver outages. Already-delivered
   * events are never re-delivered; exhausted events stay dead-lettered.
   */
  async retryFailed(
    tenantId: string,
    at: UtcInstant | string,
  ): Promise<readonly WebhookEmissionOutcome[]> {
    const instant = parseUtcInstant(at);
    const tenant = parseTenantId(tenantId);
    const endpoints = await this.#options.endpoints.listByTenant(tenant);
    const outcomes: WebhookEmissionOutcome[] = [];
    for (const endpoint of endpoints) {
      if (endpoint.status === "revoked") continue;
      const failed = (await this.#options.deliveries.listByEndpoint(endpoint.endpointId)).filter(
        (attempt) => attempt.outcome === "failed",
      );
      const seen = new Set<string>();
      for (const attempt of failed) {
        if (seen.has(attempt.eventId)) continue;
        seen.add(attempt.eventId);
        if (await this.#hasDelivered(endpoint.endpointId, attempt.eventId)) continue;
        const payload = await this.#options.deliveries.payloadOf(attempt.eventId);
        if (payload === null) continue; // nothing retained to re-deliver honestly
        const attempts = await this.#options.deliveries.listByEvent(
          endpoint.endpointId,
          attempt.eventId,
        );
        if (attempts.length >= this.#maxAttempts) continue; // stays dead-lettered
        outcomes.push(await this.#attempt(endpoint, attempt.eventId, payload, instant));
      }
    }
    return Object.freeze(outcomes);
  }

  async #hasDelivered(endpointId: string, eventId: string): Promise<boolean> {
    const attempts = await this.#options.deliveries.listByEvent(endpointId, eventId);
    return attempts.some((attempt) => attempt.outcome === "delivered");
  }

  async #attempt(
    endpoint: WebhookEndpointRecord,
    eventId: string,
    payload: string,
    at: UtcInstant,
  ): Promise<WebhookEmissionOutcome> {
    const instant = parseUtcInstant(at);
    const deliveryId = parseWebhookDeliveryId(this.#options.deliveryIdGenerator());
    const prior = await this.#options.deliveries.listByEvent(endpoint.endpointId, eventId);
    const sequence = parseRevision(prior.length + 1);

    const resolved = await this.#options.secrets.resolve(endpoint.signingKeyRef);
    const keyId = endpoint.signingKeyRef.name;
    const signature = signCustomerWebhookDelivery(
      resolved.material.value,
      buildCustomerWebhookSignatureMessage(keyId, instant, deliveryId, eventId, payload),
    );
    const headers: Readonly<Record<string, string>> = Object.freeze({
      [CUSTOMER_WEBHOOK_HEADER_NAMES.signature]: signature,
      [CUSTOMER_WEBHOOK_HEADER_NAMES.timestamp]: instant,
      [CUSTOMER_WEBHOOK_HEADER_NAMES.keyId]: keyId,
      [CUSTOMER_WEBHOOK_HEADER_NAMES.eventId]: eventId,
      [CUSTOMER_WEBHOOK_HEADER_NAMES.deliveryId]: deliveryId,
      [CUSTOMER_WEBHOOK_HEADER_NAMES.sequence]: String(sequence),
      [CUSTOMER_WEBHOOK_HEADER_NAMES.algorithm]: CUSTOMER_WEBHOOK_SIGNATURE_ALGORITHM,
    });

    let outcome: WebhookDeliveryOutcome;
    let responseSummary: string | undefined;
    try {
      const result = await this.#options.sink.deliver({ url: endpoint.url, headers, payload });
      if (result.outcome === "delivered") {
        outcome = "delivered";
      } else {
        outcome = prior.length + 1 >= this.#maxAttempts ? "dead-lettered" : "failed";
        responseSummary =
          result.summary === undefined ? undefined : result.summary.slice(0, 120);
      }
    } catch {
      // Third-party error text may carry secrets; suppressed (RL-LOCK-016).
      outcome = prior.length + 1 >= this.#maxAttempts ? "dead-lettered" : "failed";
      responseSummary = "the sink threw an unexpected error (details suppressed)";
    }

    const record: WebhookDeliveryRecord = Object.freeze({
      deliveryId,
      endpointId: endpoint.endpointId,
      tenantId: endpoint.tenantId,
      eventId,
      sequence,
      outcome,
      attemptedAt: instant,
      ...(responseSummary !== undefined ? { responseSummary } : {}),
    });
    await this.#options.deliveries.append(record, payload);
    await this.#updateEndpointHealth(endpoint, outcome, instant);
    return { endpointId: endpoint.endpointId, outcome, deliveryId, sequence };
  }

  async #updateEndpointHealth(
    endpoint: WebhookEndpointRecord,
    outcome: WebhookDeliveryOutcome,
    at: UtcInstant,
  ): Promise<void> {
    if (endpoint.status === "revoked") return;
    const nextStatus: WebhookEndpointState =
      outcome === "delivered" ? "active" : outcome === "dead-lettered" ? "failing" : endpoint.status;
    const updated = parseWebhookEndpointRecord({
      ...endpoint,
      status: nextStatus,
      updatedAt: at,
      revision: endpoint.revision + 1,
      ...(outcome === "delivered" ? { lastSuccessAt: at } : { lastFailureAt: at }),
    });
    await this.#options.endpoints.save(updated);
  }
}
