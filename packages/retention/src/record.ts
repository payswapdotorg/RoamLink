/**
 * The classified retention record (RL-054, spec/data-model.md "Privacy").
 *
 * A {@link ClassifiedRecord} is the unit the retention engine governs: one
 * tenant-scoped observation/document carrying a FIRST-CLASS classification
 * (data category + declared purposes + explicit-consent flag) and a minimized
 * payload. Parsing enforces everything the spec demands UP FRONT:
 *
 *  - PURPOSE-LIMITED: the declared purposes must be a non-empty subset of
 *    the category's allowed purposes (spec/mobile.md "Device privacy");
 *  - STRICTER CONTROLS: location and network-identifiers records require an
 *    explicit consent grant (the policy rule marks them);
 *  - MINIMIZED: the canonical JSON of the payload must fit the category's
 *    byte bound;
 *  - NO SECRETS: the payload is scanned for secret-shaped material and
 *    rejected (RL-LOCK-016 - the same enforcement point other packages'
 *    persistence is tested against);
 *  - EXPIRY IS COMPUTED, NEVER CLAIMED: `expiresAt = collectedAt + window`
 *    from the policy - a record cannot negotiate its own retention.
 */
import {
  ValidationError,
  canonicalizeJson,
  parseForeignRefAs,
  parseTenantId,
  parseUtcInstant,
  addMilliseconds,
  type CanonicalJsonValue,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  parseRetentionDataCategory,
  parseRetentionPurpose,
  type RetentionDataCategory,
  type RetentionPurpose,
} from "./classification.js";
import type { RetentionPolicy } from "./policy.js";
import { retentionRuleFor } from "./policy.js";
import { assertNoSecretMaterial } from "./secret-scan.js";

/** Input accepted by {@link parseClassifiedRecord}. */
export interface ClassifiedRecordInput {
  readonly recordId: string;
  readonly tenantId: string;
  readonly deviceId?: string | null;
  readonly dataCategory: string;
  readonly purposes: readonly string[];
  readonly collectedAt: string;
  readonly consent: boolean;
  readonly payload: unknown;
}

/** The parsed, frozen, LIVE classified record. */
export interface ClassifiedRecord {
  readonly recordId: string;
  readonly tenantId: TenantId;
  readonly deviceId: string | null;
  readonly dataCategory: RetentionDataCategory;
  readonly purposes: readonly RetentionPurpose[];
  readonly collectedAt: UtcInstant;
  /** Explicit consent grant recorded at collection time. */
  readonly consent: boolean;
  readonly payload: CanonicalJsonValue;
  /** Retention expiry computed from the policy window (never caller-set). */
  readonly expiresAt: UtcInstant;
}

/** A stored record: live, or a privacy tombstone (payload erased). */
export interface StoredRetentionRecord {
  readonly recordId: string;
  readonly tenantId: TenantId;
  readonly deviceId: string | null;
  readonly dataCategory: RetentionDataCategory;
  readonly purposes: readonly RetentionPurpose[];
  readonly collectedAt: UtcInstant;
  readonly consent: boolean;
  /** Null once the record has been tombstoned (erasure semantics). */
  readonly payload: CanonicalJsonValue | null;
  readonly expiresAt: UtcInstant;
  /** When the record was tombstoned; null while live. */
  readonly tombstonedAt: UtcInstant | null;
}

function field(label: string, issue: string): never {
  throw new ValidationError(`ClassifiedRecord rejected: ${label} - ${issue}`, {
    reason: "RETENTION_RECORD_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseCommon(value: unknown): {
  recordId: string;
  tenantId: TenantId;
  deviceId: string | null;
  dataCategory: RetentionDataCategory;
  purposes: readonly RetentionPurpose[];
  collectedAt: UtcInstant;
  consent: boolean;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (
      ![
        "recordId",
        "tenantId",
        "deviceId",
        "dataCategory",
        "purposes",
        "collectedAt",
        "consent",
        "payload",
        "tombstonedAt",
      ].includes(key)
    ) {
      field(key, "unknown field (the record carries exactly its contract fields)");
    }
  }
  let recordId: string;
  try {
    recordId = parseForeignRefAs(input["recordId"], "RetentionRecordId");
  } catch {
    field("recordId", "must be a safe reference string");
  }
  let tenantId: TenantId;
  try {
    tenantId = parseTenantId(input["tenantId"]);
  } catch {
    field("tenantId", "must be 'org:<uuid>' or 'usr:<uuid>' (tenant boundary)");
  }
  let deviceId: string | null = null;
  if (input["deviceId"] !== null && input["deviceId"] !== undefined) {
    try {
      deviceId = parseForeignRefAs(input["deviceId"], "RetentionDeviceRef");
    } catch {
      field("deviceId", "must be null or a safe reference string");
    }
  }
  const dataCategory = parseRetentionDataCategory(input["dataCategory"]);
  if (!Array.isArray(input["purposes"]) || (input["purposes"] as unknown[]).length === 0) {
    field("purposes", "must be a non-empty purpose list (collection is purpose-limited)");
  }
  const purposes: RetentionPurpose[] = [];
  for (const purpose of input["purposes"] as unknown[]) {
    purposes.push(parseRetentionPurpose(purpose));
  }
  let collectedAt: UtcInstant;
  try {
    collectedAt = parseUtcInstant(input["collectedAt"]);
  } catch {
    field("collectedAt", "must be a UTC instant with an explicit zone designator");
  }
  if (typeof input["consent"] !== "boolean") {
    field("consent", "must be a boolean (the explicit consent grant state)");
  }
  return {
    recordId,
    tenantId,
    deviceId,
    dataCategory,
    purposes: Object.freeze([...new Set(purposes)]),
    collectedAt,
    consent: input["consent"],
  };
}

/**
 * Parses a LIVE classified record against the policy: validates the
 * classification, purpose limitation, consent requirement for
 * stricter-control categories, minimization byte bound and the no-secrets
 * invariant; computes the retention expiry. This is the admission point
 * every classified write must pass.
 */
export function parseClassifiedRecord(
  policy: RetentionPolicy,
  value: unknown,
): ClassifiedRecord {
  const common = parseCommon(value);
  const rule = retentionRuleFor(policy, common.dataCategory);

  const input = value as Record<string, unknown>;
  if (input["tombstonedAt"] !== undefined && input["tombstonedAt"] !== null) {
    field("tombstonedAt", "a live record must not carry a tombstone instant");
  }

  // Purpose limitation: every declared purpose must be allowed for the category.
  for (const purpose of common.purposes) {
    if (!rule.allowedPurposes.includes(purpose)) {
      field(
        "purposes",
        `the ${common.dataCategory} category may not serve this purpose (purpose-limited collection)`,
      );
    }
  }

  // Stricter controls: location/network-identifiers require explicit consent.
  if (rule.requiresExplicitConsent && !common.consent) {
    field(
      "consent",
      "this data category requires an explicit consent grant (stricter controls for location/network identifiers, spec/mobile.md)",
    );
  }

  // No secrets, ever (RL-LOCK-016).
  assertNoSecretMaterial(input["payload"], "ClassifiedRecord.payload");

  // Minimization: bounded canonical payload.
  let canonical: string;
  try {
    canonical = canonicalizeJson(input["payload"] as CanonicalJsonValue);
  } catch {
    field("payload", "must be canonicalizable JSON (finite numbers, no cycles)");
  }
  if (canonical.length > rule.maxPayloadBytes) {
    field(
      "payload",
      `exceeds the category minimization bound of ${rule.maxPayloadBytes} canonical bytes`,
    );
  }

  return Object.freeze({
    ...common,
    payload: input["payload"] as CanonicalJsonValue,
    expiresAt: addMilliseconds(common.collectedAt, rule.retentionWindowMs),
  });
}

/**
 * Parses a STORED record (live or tombstone). Structural validation only -
 * the ADMISSION rules (purpose limitation, stricter-category consent,
 * minimization) are enforced at write time by the engine; reads faithfully
 * restore what was stored, still rejecting unknown shapes and secret-shaped
 * payloads (RL-LOCK-016 defense in depth). A tombstone carries NO payload
 * (erasure semantics) and its tombstone instant; tombstoned metadata stays
 * queryable/auditable while the data is gone.
 */
export function parseStoredRetentionRecord(
  policy: RetentionPolicy,
  value: unknown,
): StoredRetentionRecord {
  const common = parseCommon(value);
  const rule = retentionRuleFor(policy, common.dataCategory);
  const input = value as Record<string, unknown>;

  let tombstonedAt: UtcInstant | null = null;
  if (input["tombstonedAt"] !== null && input["tombstonedAt"] !== undefined) {
    try {
      tombstonedAt = parseUtcInstant(input["tombstonedAt"]);
    } catch {
      field("tombstonedAt", "must be null or a UTC instant");
    }
  }

  if (tombstonedAt !== null) {
    if (input["payload"] !== null && input["payload"] !== undefined) {
      field("payload", "a tombstone must not carry a payload (erasure semantics)");
    }
    return Object.freeze({
      ...common,
      payload: null,
      expiresAt: addMilliseconds(common.collectedAt, rule.retentionWindowMs),
      tombstonedAt,
    });
  }

  // Defense in depth: persisted payloads must never carry secret material,
  // not even records that somehow bypassed admission (RL-LOCK-016).
  assertNoSecretMaterial(input["payload"], "StoredRetentionRecord.payload");
  try {
    canonicalizeJson(input["payload"] as CanonicalJsonValue);
  } catch {
    field("payload", "must be canonicalizable JSON (finite numbers, no cycles)");
  }

  return Object.freeze({
    ...common,
    payload: input["payload"] as CanonicalJsonValue,
    expiresAt: addMilliseconds(common.collectedAt, rule.retentionWindowMs),
    tombstonedAt: null,
  });
}

/** The persistence value for a stored record (recordId is the store key). */
export function storedRecordValue(record: StoredRetentionRecord): CanonicalJsonValue {
  return Object.freeze({
    tenantId: record.tenantId,
    deviceId: record.deviceId,
    dataCategory: record.dataCategory,
    purposes: [...record.purposes],
    collectedAt: record.collectedAt,
    consent: record.consent,
    payload: record.payload,
    tombstonedAt: record.tombstonedAt,
  });
}

/** Builds a tombstone from a live record: payload erased, metadata kept. */
export function tombstoneRecord(
  record: StoredRetentionRecord,
  at: UtcInstant,
): StoredRetentionRecord {
  if (record.tombstonedAt !== null) {
    throw new ValidationError("the record is already a tombstone", {
      reason: "RETENTION_RECORD_INVALID",
      details: [{ path: "tombstonedAt", issue: "already tombstoned" }],
    });
  }
  return Object.freeze({
    ...record,
    payload: null,
    tombstonedAt: at,
  });
}
