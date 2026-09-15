/**
 * ADCOS v2 request body schemas (RL-030).
 *
 * Typed request bodies for every v2 mutation, with validating parsers whose
 * required/optional fields match the verified v2 facts EXACTLY:
 *
 *  - `intent_request`, `offer_selection`, `activation_request` and
 *    `termination_request` are CLOSED schemas: unknown fields are rejected
 *    (the fact lists are complete);
 *  - `lease_request` / `lease_renewal` pin `granted_at` but tolerate
 *    additional fields (the v2 fact list is explicitly open - "..."), which
 *    the compatibility suite (RL-036) will pin later;
 *  - `lease_revocation` and `webhook_endpoint` have NO pinned fields in the
 *    verified facts: they are open JSON objects.
 *
 * Wire type notes:
 *  - instants (recorded_at, activated_at, granted_at, ...) are v2 "text"
 *    fields; RoamLink types them as canonical UTC instants (validated);
 *  - "list"/"mapping" fields whose ELEMENT schemas are not pinned by the
 *    verified facts are typed as JSON lists/mappings without inventing
 *    element shapes;
 *  - `superseded_contract` references an ADCOS contract (foreign ref);
 *  - `termination_request` field names are taken literally from the verified
 *    fact list: {condition, recorded_reason, instant} - flagged for TL
 *    confirmation in the RL-030 report.
 */
import {
  ValidationError,
  isCanonicalJsonValue,
  parseForeignRefAs,
  parseUtcInstant,
  type AdcosContractRef,
  type Branded,
  type CanonicalJsonValue,
  type UtcInstant,
} from "@roamlink/contracts";

/** A v2 "list" field (element schemas not pinned by the verified facts). */
export type AdcosJsonList = readonly CanonicalJsonValue[];

/** A v2 "mapping" field. */
export type AdcosJsonMapping = Readonly<Record<string, CanonicalJsonValue>>;

/** Reference to a signature an activation request cites (foreign ref). */
export type AdcosSignatureRef = Branded<"AdcosSignatureRef">;

export function parseAdcosSignatureRef(value: unknown): AdcosSignatureRef {
  return parseForeignRefAs<AdcosSignatureRef>(value, "AdcosSignatureRef");
}

// --------------------------------------------------------------------------------
// shared validation helpers
// --------------------------------------------------------------------------------

function reject(label: string, issue: string): never {
  throw new ValidationError(`${label} - ${issue}`, {
    reason: "ADCOS_REQUEST_INVALID",
    details: [{ path: label, issue }],
  });
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(label, "must be an object");
  }
  return value as Record<string, unknown>;
}

function requireField(record: Record<string, unknown>, field: string, label: string): unknown {
  const value = record[field];
  if (value === undefined) {
    reject(`${label}.${field}`, "is required");
  }
  return value;
}

function closedFields(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      reject(`${label}.${key}`, "unknown field (closed v2 schema)");
    }
  }
}

function parseInstantField(value: unknown, label: string): UtcInstant {
  try {
    return parseUtcInstant(value);
  } catch {
    reject(`${label}`, "must be a UTC instant with an explicit zone designator");
  }
}

function parseListField(value: unknown, label: string): AdcosJsonList {
  if (!Array.isArray(value)) {
    reject(label, "must be a list");
  }
  for (const item of value) {
    if (!isCanonicalJsonValue(item)) {
      reject(label, "every element must be a JSON value");
    }
  }
  return value as AdcosJsonList;
}

function parseMappingField(value: unknown, label: string): AdcosJsonMapping {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(label, "must be a mapping");
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    if (!isCanonicalJsonValue(item)) {
      reject(label, "every value must be a JSON value");
    }
  }
  return value as AdcosJsonMapping;
}

function parseJsonField(value: unknown, label: string): CanonicalJsonValue {
  if (!isCanonicalJsonValue(value)) {
    reject(label, "must be a JSON value");
  }
  return value;
}

function parseNonEmptyTextField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    reject(label, "must be a non-empty text field (max 1024 chars)");
  }
  return value;
}

/** Assigns an optional field only when present (exactOptionalPropertyTypes). */
function withOptional<T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V | undefined,
): T & { [P in K]?: V } {
  if (value === undefined) return target as T & { [P in K]?: V };
  return { ...target, [key]: value } as T & { [P in K]?: V };
}

// --------------------------------------------------------------------------------
// intent_request (closed schema)
// --------------------------------------------------------------------------------

export interface AdcosIntentRequest {
  readonly requirements: AdcosJsonList;
  readonly validity: AdcosJsonMapping;
  readonly termination: AdcosJsonMapping;
  readonly recorded_at: UtcInstant;
  readonly hard_constraints?: CanonicalJsonValue;
  readonly beneficiaries?: CanonicalJsonValue;
  readonly service_properties?: CanonicalJsonValue;
  readonly usage_pricing_terms?: CanonicalJsonValue;
  readonly assurance_obligations?: CanonicalJsonValue;
  readonly execution_scope?: CanonicalJsonValue;
  readonly superseded_contract?: AdcosContractRef;
}

const INTENT_REQUEST_FIELDS = [
  "requirements",
  "validity",
  "termination",
  "recorded_at",
  "hard_constraints",
  "beneficiaries",
  "service_properties",
  "usage_pricing_terms",
  "assurance_obligations",
  "execution_scope",
  "superseded_contract",
] as const;

export function parseAdcosIntentRequest(value: unknown): AdcosIntentRequest {
  const label = "AdcosIntentRequest";
  const record = asObject(value, label);
  closedFields(record, INTENT_REQUEST_FIELDS, label);
  const base: AdcosIntentRequest = {
    requirements: parseListField(requireField(record, "requirements", label), `${label}.requirements`),
    validity: parseMappingField(requireField(record, "validity", label), `${label}.validity`),
    termination: parseMappingField(requireField(record, "termination", label), `${label}.termination`),
    recorded_at: parseInstantField(requireField(record, "recorded_at", label), `${label}.recorded_at`),
  };
  let result = base;
  result = withOptional(result, "hard_constraints", optionalJson(record, "hard_constraints", label));
  result = withOptional(result, "beneficiaries", optionalJson(record, "beneficiaries", label));
  result = withOptional(
    result,
    "service_properties",
    optionalJson(record, "service_properties", label),
  );
  result = withOptional(
    result,
    "usage_pricing_terms",
    optionalJson(record, "usage_pricing_terms", label),
  );
  result = withOptional(
    result,
    "assurance_obligations",
    optionalJson(record, "assurance_obligations", label),
  );
  result = withOptional(result, "execution_scope", optionalJson(record, "execution_scope", label));
  const superseded = record["superseded_contract"];
  if (superseded !== undefined) {
    try {
      result = withOptional(result, "superseded_contract", parseForeignRefAs<AdcosContractRef>(superseded, "AdcosContractRef"));
    } catch {
      reject(`${label}.superseded_contract`, "must be a safe ADCOS contract reference");
    }
  }
  return Object.freeze(result);
}

function optionalJson(record: Record<string, unknown>, field: string, label: string): CanonicalJsonValue | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  return parseJsonField(value, `${label}.${field}`);
}

// --------------------------------------------------------------------------------
// offer_selection (closed schema)
// --------------------------------------------------------------------------------

export interface AdcosOfferSelection {
  readonly offers: AdcosJsonList;
  readonly recorded_at: UtcInstant;
}

export function parseAdcosOfferSelection(value: unknown): AdcosOfferSelection {
  const label = "AdcosOfferSelection";
  const record = asObject(value, label);
  closedFields(record, ["offers", "recorded_at"], label);
  return Object.freeze({
    offers: parseListField(requireField(record, "offers", label), `${label}.offers`),
    recorded_at: parseInstantField(requireField(record, "recorded_at", label), `${label}.recorded_at`),
  });
}

// --------------------------------------------------------------------------------
// activation_request (closed schema)
// --------------------------------------------------------------------------------

export interface AdcosActivationRequest {
  readonly activated_at: UtcInstant;
  readonly signature_refs: readonly AdcosSignatureRef[];
}

export function parseAdcosActivationRequest(value: unknown): AdcosActivationRequest {
  const label = "AdcosActivationRequest";
  const record = asObject(value, label);
  closedFields(record, ["activated_at", "signature_refs"], label);
  const refs = parseListField(requireField(record, "signature_refs", label), `${label}.signature_refs`);
  const parsed: AdcosSignatureRef[] = [];
  for (const ref of refs) {
    if (typeof ref !== "string") {
      reject(`${label}.signature_refs`, "every element must be a signature reference string");
    }
    try {
      parsed.push(parseAdcosSignatureRef(ref));
    } catch {
      reject(`${label}.signature_refs`, "every element must match the safe reference charset");
    }
  }
  return Object.freeze({
    activated_at: parseInstantField(requireField(record, "activated_at", label), `${label}.activated_at`),
    signature_refs: Object.freeze(parsed),
  });
}

// --------------------------------------------------------------------------------
// termination_request (closed schema)
// --------------------------------------------------------------------------------

export interface AdcosTerminationRequest {
  readonly condition: string;
  readonly recorded_reason: string;
  readonly instant: UtcInstant;
}

export function parseAdcosTerminationRequest(value: unknown): AdcosTerminationRequest {
  const label = "AdcosTerminationRequest";
  const record = asObject(value, label);
  closedFields(record, ["condition", "recorded_reason", "instant"], label);
  return Object.freeze({
    condition: parseNonEmptyTextField(requireField(record, "condition", label), `${label}.condition`),
    recorded_reason: parseNonEmptyTextField(
      requireField(record, "recorded_reason", label),
      `${label}.recorded_reason`,
    ),
    instant: parseInstantField(requireField(record, "instant", label), `${label}.instant`),
  });
}

// --------------------------------------------------------------------------------
// lease_request / lease_renewal (open schema: granted_at pinned, rest open)
// --------------------------------------------------------------------------------

/**
 * Lease grant/renewal request. `granted_at` is pinned; additional v2 fields
 * are tolerated (the verified facts list is open - "granted_at, ...") and
 * will be pinned by the compatibility suite (RL-036).
 */
export interface AdcosLeaseRequest {
  readonly granted_at: UtcInstant;
  readonly [additionalField: string]: CanonicalJsonValue | UtcInstant | undefined;
}

/** The lease renewal request shares the pinned lease-request shape. */
export type AdcosLeaseRenewal = AdcosLeaseRequest;

function parseOpenLease(value: unknown, label: string): AdcosLeaseRequest {
  const record = asObject(value, label);
  const grantedAt = parseInstantField(requireField(record, "granted_at", label), `${label}.granted_at`);
  const result: Record<string, CanonicalJsonValue | UtcInstant> = { granted_at: grantedAt };
  for (const [key, fieldValue] of Object.entries(record)) {
    if (key === "granted_at") continue;
    if (!isCanonicalJsonValue(fieldValue)) {
      reject(`${label}.${key}`, "additional fields must be JSON values");
    }
    result[key] = fieldValue;
  }
  return Object.freeze(result) as AdcosLeaseRequest;
}

export function parseAdcosLeaseRequest(value: unknown): AdcosLeaseRequest {
  return parseOpenLease(value, "AdcosLeaseRequest");
}

export function parseAdcosLeaseRenewal(value: unknown): AdcosLeaseRenewal {
  return parseOpenLease(value, "AdcosLeaseRenewal");
}

// --------------------------------------------------------------------------------
// lease_revocation / webhook_endpoint (open schemas: no pinned fields)
// --------------------------------------------------------------------------------

/**
 * Lease revocation request. NO fields are pinned by the verified facts;
 * it is an open JSON object until RL-036 pins the layout.
 */
export interface AdcosLeaseRevocation {
  readonly [field: string]: CanonicalJsonValue | undefined;
}

export function parseAdcosLeaseRevocation(value: unknown): AdcosLeaseRevocation {
  const record = asObject(value, "AdcosLeaseRevocation");
  for (const [key, fieldValue] of Object.entries(record)) {
    if (!isCanonicalJsonValue(fieldValue)) {
      reject(`AdcosLeaseRevocation.${key}`, "fields must be JSON values");
    }
  }
  return Object.freeze({ ...record }) as AdcosLeaseRevocation;
}

/**
 * Webhook endpoint registration request. NO fields are pinned by the
 * verified facts; it is an open JSON object until RL-036 pins the layout.
 */
export interface AdcosWebhookEndpointRequest {
  readonly [field: string]: CanonicalJsonValue | undefined;
}

export function parseAdcosWebhookEndpointRequest(value: unknown): AdcosWebhookEndpointRequest {
  const record = asObject(value, "AdcosWebhookEndpointRequest");
  for (const [key, fieldValue] of Object.entries(record)) {
    if (!isCanonicalJsonValue(fieldValue)) {
      reject(`AdcosWebhookEndpointRequest.${key}`, "fields must be JSON values");
    }
  }
  return Object.freeze({ ...record }) as AdcosWebhookEndpointRequest;
}
