/**
 * The ADCOS projection record (RL-034, spec/adcos-integration.md §8 -
 * EXACTLY the documented record shape plus the projected payload itself):
 *
 *   projection_id, source_authority, canonical_resource_type,
 *   canonical_resource_id, source_version, event_id, payload_digest,
 *   observed_at, received_at, fresh_until, freshness_state, evidence_class,
 *   projection_version + payload
 *
 * Only the integration boundary (this engine, driven by webhook projection
 * and canonical refresh) writes ADCOS-derived projections; everything else
 * consumes the read surface (RL-LOCK-010: evidence and freshness are
 * first-class; UNKNOWN is a valid state - the system never guesses).
 *
 * The canonical-resource vocabulary is CLOSED to the v2 public surface.
 * There is deliberately NO session or NetworkPath resource type (RL-LOCK-
 * 004/005): session/path-ish read models are derived LATER from lifecycle,
 * usage and assurance reads - they are not canonical resources here.
 */
import {
  ValidationError,
  canonicalizeJson,
  parseEvidenceClass,
  parseRevision,
  parseUtcInstant,
  isFreshnessState,
  type CanonicalJsonValue,
  type Digest,
  type EvidenceClass,
  type FreshnessState,
  type Revision,
  type UtcInstant,
} from "@roamlink/contracts";

// --------------------------------------------------------------------------------
// Closed vocabularies
// --------------------------------------------------------------------------------

/**
 * The canonical resource kinds the v2 public surface exposes (the webhook
 * resource kinds) plus the contract sub-resource read surfaces (usage,
 * assurance). Sessions/paths are intentionally absent (RL-LOCK-004/005).
 */
export const ADCOS_PROJECTION_RESOURCE_TYPES = [
  "connectivity_intent",
  "connectivity_contract",
  "connectivity_lease",
  "contract_usage",
  "contract_assurance",
  "webhook_endpoint",
] as const;

export type AdcosProjectionResourceType = (typeof ADCOS_PROJECTION_RESOURCE_TYPES)[number];

export function isAdcosProjectionResourceType(value: unknown): value is AdcosProjectionResourceType {
  return (
    typeof value === "string" &&
    (ADCOS_PROJECTION_RESOURCE_TYPES as readonly string[]).includes(value)
  );
}

/** Parses a resource type; anything outside the closed set is rejected. */
export function parseAdcosProjectionResourceType(value: unknown): AdcosProjectionResourceType {
  if (!isAdcosProjectionResourceType(value)) {
    throw new ValidationError(
      "AdcosProjectionResourceType must be one of the closed v2 canonical resource types",
      {
        reason: "ADCOS_PROJECTION_RESOURCE_TYPE_INVALID",
        details: [{ path: "AdcosProjectionResourceType", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/** The source authority that owns the projected state (spec §8). */
export const PROJECTION_SOURCE_AUTHORITIES = ["adcos", "roamlink"] as const;

export type ProjectionSourceAuthority = (typeof PROJECTION_SOURCE_AUTHORITIES)[number];

export function isProjectionSourceAuthority(value: unknown): value is ProjectionSourceAuthority {
  return (
    typeof value === "string" &&
    (PROJECTION_SOURCE_AUTHORITIES as readonly string[]).includes(value)
  );
}

// --------------------------------------------------------------------------------
// The projection record (§8 exact fields + payload)
// --------------------------------------------------------------------------------

/**
 * One canonical-resource projection. `source_version`/`event_id` carry the
 * source version/event identifier when available (architecture.md §5);
 * `payload` is the projected canonical snapshot; `projection_version` is the
 * monotonic per-record revision (optimistic-concurrency token).
 */
export interface AdcosProjectionRecord {
  readonly projection_id: string;
  readonly source_authority: ProjectionSourceAuthority;
  readonly canonical_resource_type: AdcosProjectionResourceType;
  readonly canonical_resource_id: string;
  readonly source_version: Revision | null;
  readonly event_id: string | null;
  readonly payload_digest: Digest;
  readonly observed_at: UtcInstant | null;
  readonly received_at: UtcInstant | null;
  readonly fresh_until: UtcInstant | null;
  readonly freshness_state: FreshnessState;
  readonly evidence_class: EvidenceClass;
  readonly projection_version: Revision;
  readonly payload: CanonicalJsonValue;
}

const PROJECTION_FIELDS = [
  "projection_id",
  "source_authority",
  "canonical_resource_type",
  "canonical_resource_id",
  "source_version",
  "event_id",
  "payload_digest",
  "observed_at",
  "received_at",
  "fresh_until",
  "freshness_state",
  "evidence_class",
  "projection_version",
  "payload",
] as const;

const PROJECTION_ID_PATTERN = /^prj\.[a-z_]+\.[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;

function field(label: string, issue: string): never {
  throw new ValidationError(`AdcosProjectionRecord rejected: ${label} - ${issue}`, {
    reason: "ADCOS_PROJECTION_RECORD_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseNullableInstant(value: unknown, label: string): UtcInstant | null {
  if (value === null) return null;
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

function parseNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    field(label, "must be a non-empty reference string or null");
  }
  return value;
}

/**
 * The deterministic projection identity: `prj.<type>.<canonical id>` - one
 * projection record per canonical resource.
 */
export function projectionIdFor(
  resourceType: AdcosProjectionResourceType,
  resourceId: string,
): string {
  const id = `prj.${resourceType}.${resourceId}`;
  if (!PROJECTION_ID_PATTERN.test(id)) {
    throw new ValidationError("the canonical resource id must match the safe reference charset", {
      reason: "ADCOS_PROJECTION_RECORD_INVALID",
      details: [{ path: "canonical_resource_id", issue: "not a safe reference string" }],
    });
  }
  return id;
}

/** Validates and freezes a projection record from an unknown value. */
export function parseAdcosProjectionRecord(value: unknown): AdcosProjectionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(PROJECTION_FIELDS as readonly string[]).includes(key)) {
      field(key, "unknown field (the §8 projection record shape is closed)");
    }
  }
  for (const required of PROJECTION_FIELDS) {
    if (record[required] === undefined) {
      field(required, "is required");
    }
  }
  if (typeof record["projection_id"] !== "string" || !PROJECTION_ID_PATTERN.test(record["projection_id"])) {
    field("projection_id", "must be the deterministic projection identity prj.<type>.<id>");
  }
  if (!isProjectionSourceAuthority(record["source_authority"])) {
    field("source_authority", "must be 'adcos' or 'roamlink'");
  }
  if (!isAdcosProjectionResourceType(record["canonical_resource_type"])) {
    field("canonical_resource_type", "must be one of the closed v2 canonical resource types");
  }
  if (typeof record["canonical_resource_id"] !== "string" || record["canonical_resource_id"].length === 0) {
    field("canonical_resource_id", "must be the canonical resource reference");
  }
  if (record["projection_id"] !== projectionIdFor(record["canonical_resource_type"] as AdcosProjectionResourceType, record["canonical_resource_id"])) {
    field("projection_id", "must equal the deterministic identity for the resource type + id");
  }
  if (typeof record["payload_digest"] !== "string" || !/^[0-9a-f]{64}$/.test(record["payload_digest"])) {
    field("payload_digest", "must be a lowercase 64-char hex SHA-256 digest");
  }
  if (!isFreshnessState(record["freshness_state"])) {
    field("freshness_state", "must be FRESH, STALE or UNKNOWN");
  }
  let evidenceClass: EvidenceClass;
  try {
    evidenceClass = parseEvidenceClass(record["evidence_class"]);
  } catch {
    field("evidence_class", "must be a member of the frozen evidence-class vocabulary");
  }
  try {
    canonicalizeJson(record["payload"]);
  } catch {
    field("payload", "must be a canonicalizable JSON value");
  }
  const payload = record["payload"] as CanonicalJsonValue;
  return Object.freeze({
    projection_id: record["projection_id"] as string,
    source_authority: record["source_authority"] as ProjectionSourceAuthority,
    canonical_resource_type: record["canonical_resource_type"] as AdcosProjectionResourceType,
    canonical_resource_id: record["canonical_resource_id"] as string,
    source_version: parseNullableRevision(record["source_version"], "source_version"),
    event_id: parseNullableString(record["event_id"], "event_id"),
    payload_digest: record["payload_digest"] as Digest,
    observed_at: parseNullableInstant(record["observed_at"], "observed_at"),
    received_at: parseNullableInstant(record["received_at"], "received_at"),
    fresh_until: parseNullableInstant(record["fresh_until"], "fresh_until"),
    freshness_state: record["freshness_state"] as FreshnessState,
    evidence_class: evidenceClass,
    projection_version: parseRevision(record["projection_version"]),
    payload,
  });
}

/**
 * Honest consistency check: the recorded freshness_state must match what the
 * recorded timestamps would evaluate to at the recorded state's evaluation
 * semantics (never a guessed FRESH).
 */
export function projectionFreshnessIsConsistent(
  record: AdcosProjectionRecord,
  at: UtcInstant,
): boolean {
  if (record.observed_at === null || record.received_at === null || record.fresh_until === null) {
    return record.freshness_state === "UNKNOWN";
  }
  const expected = new Date(at).getTime() <= new Date(record.fresh_until).getTime() ? "FRESH" : "STALE";
  return record.freshness_state === expected;
}
