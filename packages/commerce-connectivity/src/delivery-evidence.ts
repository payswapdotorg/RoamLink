/**
 * Delivery evidence (RL-023, spec/data-model.md "State separation" +
 * RL-LOCK-010 "evidence and freshness are first-class").
 *
 * `delivery_evidence_state` is its OWN closed vocabulary - it is never
 * merged with `order_state`, `customer_subscription_state`,
 * `customer_payment_state` or any ADCOS state. It answers exactly one
 * question: does this commercial subject carry LINKED DELIVERY EVIDENCE?
 *
 *   UNEVIDENCED - no delivery evidence is linked. Absence of evidence is a
 *                 valid state (RL-LOCK-010): a paid order with no linked
 *                 evidence is presented as exactly that - paid AND
 *                 unevidenced - never as "delivered" or "not delivered".
 *   EVIDENCED   - delivery evidence is linked. The evidence's QUALITY is
 *                 carried separately and first-class: observedAt /
 *                 receivedAt / freshUntil / freshnessState (FRESH | STALE |
 *                 UNKNOWN) + evidenceClass + the canonical resource
 *                 reference + payload digest.
 *
 * The evidence record mirrors the ADCOS projection §8 field semantics
 * (provenance, authority, timestamps, freshness) but lives on the COMMERCE
 * side as an immutable snapshot: relinking captures a NEW observation, it
 * never edits the old one (the event chain keeps every observation).
 *
 * IMPORTANT (RL-LOCK-008 "payment is not delivery"): evidence NEVER asserts
 * commercial or billable-final state, and payment state NEVER implies
 * evidence. `EVIDENCED` means "an ADCOS-derived projection is linked";
 * whether that projection proves usable delivery is a READER judgment made
 * with the freshness/evidence-class facts in hand - never a hidden
 * inference here.
 */
import {
  ValidationError,
  isEvidenceClass,
  isFreshnessState,
  parseDigest,
  parseUtcInstant,
  type CanonicalJsonValue,
  type EvidenceClass,
  type FreshnessState,
  type Revision,
  type UtcInstant,
} from "@roamlink/contracts";

/**
 * The CLOSED `delivery_evidence_state` vocabulary (spec/data-model.md
 * "State separation" lists it among the never-merged enums).
 */
export const DELIVERY_EVIDENCE_STATES = ["UNEVIDENCED", "EVIDENCED"] as const;

export type DeliveryEvidenceState = (typeof DELIVERY_EVIDENCE_STATES)[number];

export function isDeliveryEvidenceState(value: unknown): value is DeliveryEvidenceState {
  return (
    typeof value === "string" && (DELIVERY_EVIDENCE_STATES as readonly string[]).includes(value)
  );
}

/**
 * The closed canonical-resource vocabulary this reference model may link
 * against - exactly the ADCOS projection §8 canonical resource types. The
 * vocabulary is mirrored LOCALLY (this package must not import the
 * projection engine's internals, only its read surface through the port);
 * a conformance test pins the mirror against the real vocabulary so the
 * two can never drift silently.
 */
export const LINKABLE_CANONICAL_RESOURCE_TYPES = [
  "connectivity_intent",
  "connectivity_contract",
  "connectivity_lease",
  "contract_usage",
  "contract_assurance",
  "webhook_endpoint",
] as const;

export type LinkableCanonicalResourceType = (typeof LINKABLE_CANONICAL_RESOURCE_TYPES)[number];

export function isLinkableCanonicalResourceType(
  value: unknown,
): value is LinkableCanonicalResourceType {
  return (
    typeof value === "string" &&
    (LINKABLE_CANONICAL_RESOURCE_TYPES as readonly string[]).includes(value)
  );
}

function field(label: string, issue: string): never {
  throw new ValidationError(`DeliveryEvidence rejected: ${label} - ${issue}`, {
    reason: "DELIVERY_EVIDENCE_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * One immutable delivery-evidence snapshot (the §8 projection facts,
 * commerce-side). Frozen deeply on parse.
 */
export interface DeliveryEvidence {
  /** Provenance class of the linked observation (frozen Wave-0 vocabulary). */
  readonly evidenceClass: EvidenceClass;
  /** When the source was observed (null = never observed; UNKNOWN quality). */
  readonly observedAt: UtcInstant | null;
  /** When RoamLink received the observation (null = nothing ever arrived). */
  readonly receivedAt: UtcInstant | null;
  /** The last instant the observation may be treated as FRESH. */
  readonly freshUntil: UtcInstant | null;
  /** The state as recorded by the projection surface at observation time. */
  readonly freshnessState: FreshnessState;
  /** The ADCOS canonical resource type the evidence is about. */
  readonly canonicalResourceType: LinkableCanonicalResourceType;
  /** The ADCOS canonical resource id (opaque foreign reference). */
  readonly canonicalResourceId: string;
  /** The source's own version identity, when available. */
  readonly sourceVersion: Revision | null;
  /** The source event identity, when available. */
  readonly eventId: string | null;
  /** SHA-256 digest of the observed payload (integrity anchor). */
  readonly payloadDigest: string;
  /** The observed canonical snapshot (immutable; never re-interpreted here). */
  readonly payload: CanonicalJsonValue;
}

const EVIDENCE_FIELDS = [
  "evidenceClass",
  "observedAt",
  "receivedAt",
  "freshUntil",
  "freshnessState",
  "canonicalResourceType",
  "canonicalResourceId",
  "sourceVersion",
  "eventId",
  "payloadDigest",
  "payload",
] as const;

function parseNullableInstant(value: unknown, label: string): UtcInstant | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    field(label, "must be a UTC instant string or null");
  }
  try {
    return parseUtcInstant(value);
  } catch {
    field(label, "must be a UTC instant string or null");
  }
}

function parseNullableRevision(value: unknown, label: string): Revision | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    field(label, "must be a positive integer revision or null");
  }
  return value as Revision;
}

function parseNullableEventId(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    field(label, "must be a non-empty reference string or null");
  }
  return value;
}

/** Validates and freezes a delivery-evidence snapshot from an unknown value. */
export function parseDeliveryEvidence(value: unknown): DeliveryEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(EVIDENCE_FIELDS as readonly string[]).includes(key)) {
      field(key, "unknown field (the delivery-evidence vocabulary is closed)");
    }
  }
  for (const required of EVIDENCE_FIELDS) {
    if (record[required] === undefined) {
      field(required, "is required");
    }
  }
  if (!isEvidenceClass(record["evidenceClass"])) {
    field("evidenceClass", "must be a member of the frozen evidence-class vocabulary");
  }
  if (!isFreshnessState(record["freshnessState"])) {
    field("freshnessState", "must be FRESH, STALE or UNKNOWN");
  }
  if (!isLinkableCanonicalResourceType(record["canonicalResourceType"])) {
    field("canonicalResourceType", "must be one of the linkable canonical resource types");
  }
  if (
    typeof record["canonicalResourceId"] !== "string" ||
    record["canonicalResourceId"].length === 0 ||
    record["canonicalResourceId"].length > 255
  ) {
    field("canonicalResourceId", "must be a non-empty canonical resource reference");
  }
  let payloadDigest: string;
  try {
    payloadDigest = parseDigest(record["payloadDigest"]);
  } catch {
    field("payloadDigest", "must be a lowercase 64-char hex SHA-256 digest");
  }
  const payload = record["payload"];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    field("payload", "must be a JSON object (the observed canonical snapshot)");
  }
  return Object.freeze({
    evidenceClass: record["evidenceClass"] as EvidenceClass,
    observedAt: parseNullableInstant(record["observedAt"], "observedAt"),
    receivedAt: parseNullableInstant(record["receivedAt"], "receivedAt"),
    freshUntil: parseNullableInstant(record["freshUntil"], "freshUntil"),
    freshnessState: record["freshnessState"] as FreshnessState,
    canonicalResourceType: record["canonicalResourceType"] as LinkableCanonicalResourceType,
    canonicalResourceId: record["canonicalResourceId"] as string,
    sourceVersion: parseNullableRevision(record["sourceVersion"], "sourceVersion"),
    eventId: parseNullableEventId(record["eventId"], "eventId"),
    payloadDigest,
    payload: Object.freeze(structuredClone(payload)) as CanonicalJsonValue,
  });
}
