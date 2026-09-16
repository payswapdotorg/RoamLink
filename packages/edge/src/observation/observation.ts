/**
 * Raw edge observation contract (RL-041, spec/mobile.md "Capability
 * discovery" + "Edge desired-state loop", RL-LOCK-011).
 *
 * An {@link EdgeObservation} is ONE raw fact a platform probe (RL-043
 * adapter) or the edge agent itself produced: what was probed, what the
 * platform reported, and WHICH KIND of platform evidence backs it. The
 * observation NEVER carries an evidence CLASS of its own - the observation
 * engine assigns the class deterministically from the closed
 * {@link EDGE_OBSERVATION_EVIDENCE_CLASS_BY_KIND} map, so no caller can
 * claim a class it does not hold:
 *
 * | evidence kind            | assigned class | rationale                        |
 * |--------------------------|----------------|----------------------------------|
 * | platform-api-probe       | OBSERVED       | directly observed by the device  |
 * | user-permission-state    | OBSERVED       | read from the platform permission|
 * | os-statement             | REPORTED       | the OS reports; device records   |
 * | none                     | UNKNOWN        | absence of evidence              |
 *
 * AUTHENTICATED is UNREACHABLE through this map: a cryptographically
 * authenticated statement requires verification against the authoritative
 * source (a server-side verified enrollment), which a local observation
 * pipeline can never fabricate (RL-LOCK-011).
 *
 * Honesty rule enforced at parse time: an observation with evidence kind
 * `none` may only assert status/value `unknown` - absence of evidence is
 * recorded as absence, never as a claim.
 */
import {
  ValidationError,
  parseUtcInstant,
  type EvidenceClass,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  EDGE_PLATFORM_EVIDENCE_KINDS,
  parseEdgePlatformEvidence,
  type EdgePlatformEvidence,
  type EdgePlatformEvidenceKind,
} from "../capability/evidence.js";
import { parseEdgeCapabilityName, type EdgeCapabilityName } from "../capability/capability-name.js";
import {
  parseEdgeCapabilityStatus,
  type EdgeCapabilityStatus,
  type EdgePlatformDescriptor,
} from "../capability/capability-snapshot.js";
import { parseEdgePlatformFamily } from "../capability/capability-model.js";
import {
  parseEdgeDeviceRef,
  parseEdgeObservationId,
  type EdgeDeviceRef,
  type EdgeObservationId,
} from "../ids.js";

/** Closed raw-observation subject kinds. */
export const EDGE_OBSERVATION_SUBJECT_KINDS = ["capability-probe", "context-observation"] as const;

export type EdgeObservationSubjectKind = (typeof EDGE_OBSERVATION_SUBJECT_KINDS)[number];

/**
 * The CLOSED evidence-class assignment for raw observations. This map IS the
 * evidence discipline of the observation pipeline: classes are never
 * caller-claimed and AUTHENTICATED cannot appear (RL-LOCK-011).
 */
export const EDGE_OBSERVATION_EVIDENCE_CLASS_BY_KIND: Readonly<
  Record<EdgePlatformEvidenceKind, EvidenceClass>
> = Object.freeze({
  "platform-api-probe": "OBSERVED",
  "os-statement": "REPORTED",
  "user-permission-state": "OBSERVED",
  none: "UNKNOWN",
});

/** True iff the map assigns the given class to some evidence kind. */
export function isEvidenceClassProducibleByObservations(evidenceClass: EvidenceClass): boolean {
  return (Object.values(EDGE_OBSERVATION_EVIDENCE_CLASS_BY_KIND) as readonly EvidenceClass[]).includes(
    evidenceClass,
  );
}

/** A capability-probe subject. */
export interface EdgeCapabilityProbeSubject {
  readonly kind: "capability-probe";
  readonly capability: EdgeCapabilityName;
  readonly status: EdgeCapabilityStatus;
}

/** A context-observation subject (value validated against the per-field vocabulary). */
export interface EdgeContextObservationSubject {
  readonly kind: "context-observation";
  readonly contextField: string;
  readonly value: string;
}

/** The parsed, frozen raw observation. */
export interface EdgeObservation {
  readonly observationId: EdgeObservationId;
  readonly deviceRef: EdgeDeviceRef;
  readonly observedAt: UtcInstant;
  readonly platform: EdgePlatformDescriptor;
  readonly evidence: EdgePlatformEvidence;
  readonly subject: EdgeCapabilityProbeSubject | EdgeContextObservationSubject;
}

/** Input accepted by {@link parseEdgeObservation}. */
export interface EdgeObservationInput {
  readonly observationId: string;
  readonly deviceRef: string;
  readonly observedAt: string;
  readonly platform: { readonly family: string; readonly platformVersion: string };
  readonly evidence: { readonly kind: string; readonly source?: string; readonly detail?: string };
  readonly subject: Record<string, unknown>;
}

const ALLOWED_FIELDS = new Set([
  "observationId",
  "deviceRef",
  "observedAt",
  "platform",
  "evidence",
  "subject",
]);

const MAX_PLATFORM_VERSION_LENGTH = 64;

function isPrintable(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function field(label: string, issue: string): never {
  throw new ValidationError(`EdgeObservation rejected: ${label} - ${issue}`, {
    reason: "EDGE_OBSERVATION_INVALID",
    details: [{ path: label, issue }],
  });
}

function parseField<T>(label: string, issue: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    field(label, issue);
  }
}

function parsePlatform(value: unknown): EdgePlatformDescriptor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("platform", "must be an object with family and platformVersion");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "family" && key !== "platformVersion") {
      field(`platform.${key}`, "unknown field (exactly family + platformVersion)");
    }
  }
  const family = parseField("platform.family", "must be a closed platform-family member", () =>
    parseEdgePlatformFamily(record["family"]),
  );
  const platformVersion = record["platformVersion"];
  if (
    typeof platformVersion !== "string" ||
    platformVersion.length === 0 ||
    platformVersion.length > MAX_PLATFORM_VERSION_LENGTH ||
    platformVersion !== platformVersion.trim() ||
    !isPrintable(platformVersion)
  ) {
    field("platform.platformVersion", "must be a trimmed, printable, non-secret label of 1-64 chars");
  }
  return Object.freeze({ family, platformVersion });
}

function parseSubject(
  value: unknown,
  evidenceKind: EdgePlatformEvidenceKind,
): EdgeObservation["subject"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("subject", "must be an object with kind, capability/contextField and status/value");
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  if (kind === "capability-probe") {
    for (const key of Object.keys(record)) {
      if (key !== "kind" && key !== "capability" && key !== "status") {
        field(`subject.${key}`, "unknown field (a capability probe carries exactly kind, capability, status)");
      }
    }
    const capability = parseField("subject.capability", "must be a closed edge capability name", () =>
      parseEdgeCapabilityName(record["capability"]),
    );
    const status = parseField("subject.status", "must be a closed edge capability status", () =>
      parseEdgeCapabilityStatus(record["status"]),
    );
    if (evidenceKind === "none" && status !== "unknown") {
      field(
        "subject.status",
        "an observation without platform evidence (kind 'none') may only assert status 'unknown' - absence of evidence is never a claim (RL-LOCK-011)",
      );
    }
    return Object.freeze({ kind, capability, status });
  }
  if (kind === "context-observation") {
    for (const key of Object.keys(record)) {
      if (key !== "kind" && key !== "contextField" && key !== "value") {
        field(
          `subject.${key}`,
          "unknown field (a context observation carries exactly kind, contextField, value)",
        );
      }
    }
    const contextFieldLabel = record["contextField"];
    if (typeof contextFieldLabel !== "string") {
      field("subject.contextField", "must be a closed context-field name");
    }
    const contextFieldVocabulary = EDGE_CONTEXT_FIELD_VALUE_VOCABULARIES[contextFieldLabel as EdgeContextFieldName];
    if (contextFieldVocabulary === undefined) {
      field(
        "subject.contextField",
        "must be a member of the closed context-field vocabulary (connectivity-state, active-interface-kind, interface-metered)",
      );
    }
    const value2 = record["value"];
    if (typeof value2 !== "string" || !contextFieldVocabulary.includes(value2)) {
      field(
        "subject.value",
        `must be a member of the closed value vocabulary for ${contextFieldLabel}`,
      );
    }
    if (evidenceKind === "none" && value2 !== "unknown") {
      field(
        "subject.value",
        "an observation without platform evidence (kind 'none') may only assert value 'unknown' - absence of evidence is never a claim (RL-LOCK-011)",
      );
    }
    return Object.freeze({ kind, contextField: contextFieldLabel, value: value2 });
  }
  field("subject.kind", "must be 'capability-probe' or 'context-observation'");
}

/**
 * Parses and freezes a raw observation from an unknown (e.g. JSON-parsed)
 * value. Fail-closed on anything outside the closed vocabularies; enforces
 * the none-evidence honesty rule.
 */
export function parseEdgeObservation(value: unknown): EdgeObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      field(key, "unknown field (the observation carries exactly its contract fields)");
    }
  }
  const observationId = parseField("observationId", "must be a canonical lowercase UUID", () =>
    parseEdgeObservationId(input["observationId"]),
  );
  const deviceRef = parseField("deviceRef", "must be a non-empty safe reference string", () =>
    parseEdgeDeviceRef(input["deviceRef"]),
  );
  const observedAt = parseField(
    "observedAt",
    "must be a UTC instant with an explicit zone designator",
    () => parseUtcInstant(input["observedAt"]),
  );
  const platform = parsePlatform(input["platform"]);
  const evidence = (() => {
    try {
      return parseEdgePlatformEvidence(input["evidence"]);
    } catch (error) {
      if (error instanceof ValidationError) {
        field("evidence", error.message);
      }
      throw error;
    }
  })();
  const subject = parseSubject(input["subject"], evidence.kind);
  return Object.freeze({
    observationId,
    deviceRef,
    observedAt,
    platform,
    evidence,
    subject,
  });
}

// ---------------------------------------------------------------------------
// Closed context-field vocabulary (kept MINIMAL and privacy-preserving on
// purpose: technology kinds and metering only - NO network identifiers
// (SSIDs/BSSIDs), NO location; spec/mobile.md "Device privacy").
// ---------------------------------------------------------------------------

export const EDGE_CONTEXT_FIELDS = [
  "connectivity-state",
  "active-interface-kind",
  "interface-metered",
] as const;

export type EdgeContextFieldName = (typeof EDGE_CONTEXT_FIELDS)[number];

export const EDGE_CONTEXT_FIELD_VALUE_VOCABULARIES: Readonly<
  Record<EdgeContextFieldName, readonly string[]>
> = Object.freeze({
  "connectivity-state": Object.freeze(["online", "offline", "unknown"]),
  "active-interface-kind": Object.freeze(["wifi", "cellular", "ethernet", "none", "unknown"]),
  "interface-metered": Object.freeze(["yes", "no", "unknown"]),
});

export function isEdgeContextFieldName(value: unknown): value is EdgeContextFieldName {
  return typeof value === "string" && (EDGE_CONTEXT_FIELDS as readonly string[]).includes(value);
}

export function contextFieldValueVocabulary(name: EdgeContextFieldName): readonly string[] {
  return EDGE_CONTEXT_FIELD_VALUE_VOCABULARIES[name];
}

// Re-exported for engine consumers: the evidence kinds list (closed).
export const OBSERVATION_EVIDENCE_KINDS: readonly EdgePlatformEvidenceKind[] =
  EDGE_PLATFORM_EVIDENCE_KINDS;
