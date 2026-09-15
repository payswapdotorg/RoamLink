/**
 * Local desired-state record contract (RL-040 - TYPES ONLY; the sync engine
 * is RL-042, Wave 2).
 *
 * A desired-state record captures what the edge WANTS on the device (an
 * explicit capability requirement plus minimal parameters) together with the
 * last-known freshness of the observation that motivated it (RL-LOCK-010).
 * Records are immutable versions linked by a supersession chain
 * (spec/data-model.md "Versioning"); mutable local state evolves by creating
 * a successor record that supersedes its predecessor.
 */
import {
  ValidationError,
  parseContractVersion,
  parseFreshness,
  parseRevision,
  parseUtcInstant,
  type ContractVersion,
  type Freshness,
  type Revision,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  makeEdgeCapabilityRequirement,
  type EdgeCapabilityRequirement,
  type EdgeCapabilityRequirementInput,
} from "../capability/capability-gating.js";
import { parseDeviceActionParameters, type DeviceActionParameters } from "../action/device-action.js";
import {
  parseEdgeDesiredStateId,
  parseEdgeDeviceRef,
  type EdgeDesiredStateId,
  type EdgeDeviceRef,
} from "../ids.js";
import { describeEdgeContractVersionExpectation, isEdgeRecordVersionCompatible } from "../version.js";

/** Input accepted by {@link parseEdgeDesiredStateRecord}. */
export interface EdgeDesiredStateRecordInput {
  readonly desiredStateId: string;
  readonly contractVersion: string;
  readonly deviceRef: string;
  readonly capabilityRequirement: EdgeCapabilityRequirementInput;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly revision: number;
  readonly supersededBy?: string;
  readonly lastKnownFreshness:
    | Freshness
    | {
        readonly observedAt?: string | null;
        readonly receivedAt?: string | null;
        readonly freshUntil?: string | null;
        readonly freshnessState?: string;
      };
}

/** The parsed, frozen local desired-state record. */
export interface EdgeDesiredStateRecord {
  readonly desiredStateId: EdgeDesiredStateId;
  readonly contractVersion: ContractVersion;
  readonly deviceRef: EdgeDeviceRef;
  readonly capabilityRequirement: EdgeCapabilityRequirement;
  readonly parameters: DeviceActionParameters;
  readonly createdAt: UtcInstant;
  /** Optimistic-concurrency revision of the local desired state. */
  readonly revision: Revision;
  /** Successor record when this desired state has been superseded. */
  readonly supersededBy?: EdgeDesiredStateId;
  /** Last-known freshness of the motivating observation (RL-LOCK-010). */
  readonly lastKnownFreshness: Freshness;
}

const ALLOWED_FIELDS = new Set([
  "desiredStateId",
  "contractVersion",
  "deviceRef",
  "capabilityRequirement",
  "parameters",
  "createdAt",
  "revision",
  "supersededBy",
  "lastKnownFreshness",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`EdgeDesiredStateRecord rejected: ${label} - ${issue}`, {
    reason: "EDGE_DESIRED_STATE_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * Parses and freezes a local desired-state record from an unknown (e.g.
 * JSON-parsed) value. Every field is validated through the shared edge
 * contract parsers; unknown fields are rejected (no silent data loss,
 * RL-LOCK-017).
 */
export function parseEdgeDesiredStateRecord(value: unknown): EdgeDesiredStateRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      field(key, "unknown field (the record carries exactly its contract fields)");
    }
  }

  let desiredStateId: EdgeDesiredStateId;
  try {
    desiredStateId = parseEdgeDesiredStateId(input["desiredStateId"]);
  } catch {
    field("desiredStateId", "must be a canonical lowercase UUID");
  }
  let contractVersion: ContractVersion;
  try {
    contractVersion = parseContractVersion(input["contractVersion"]);
  } catch {
    field("contractVersion", "must be a MAJOR.MINOR contract version");
  }
  if (!isEdgeRecordVersionCompatible(contractVersion)) {
    field("contractVersion", describeEdgeContractVersionExpectation());
  }
  let deviceRef: EdgeDeviceRef;
  try {
    deviceRef = parseEdgeDeviceRef(input["deviceRef"]);
  } catch {
    field("deviceRef", "must be a non-empty safe reference string");
  }
  let capabilityRequirement: EdgeCapabilityRequirement;
  try {
    capabilityRequirement = makeEdgeCapabilityRequirement(input["capabilityRequirement"] as EdgeCapabilityRequirementInput);
  } catch (error) {
    if (error instanceof ValidationError) {
      field("capabilityRequirement", error.message);
    }
    throw error;
  }
  let parameters: DeviceActionParameters;
  try {
    parameters = parseDeviceActionParameters(input["parameters"]);
  } catch {
    field("parameters", "must be minimal, typed action parameters (bounded JSON primitives)");
  }
  let createdAt: UtcInstant;
  try {
    createdAt = parseUtcInstant(input["createdAt"]);
  } catch {
    field("createdAt", "must be a UTC instant with an explicit zone designator");
  }
  let revision: Revision;
  try {
    revision = parseRevision(input["revision"]);
  } catch {
    field("revision", "must be a positive integer (optimistic-concurrency revision)");
  }
  let supersededBy: EdgeDesiredStateId | undefined;
  if (input["supersededBy"] !== undefined) {
    try {
      supersededBy = parseEdgeDesiredStateId(input["supersededBy"]);
    } catch {
      field("supersededBy", "must be a canonical lowercase UUID when present");
    }
  }
  let lastKnownFreshness: Freshness;
  try {
    lastKnownFreshness = parseFreshness(input["lastKnownFreshness"]);
  } catch {
    field("lastKnownFreshness", "must be a Wave-0 freshness record");
  }

  const record: EdgeDesiredStateRecord = Object.freeze({
    desiredStateId,
    contractVersion,
    deviceRef,
    capabilityRequirement,
    parameters,
    createdAt,
    revision,
    ...(supersededBy !== undefined ? { supersededBy } : {}),
    lastKnownFreshness,
  });
  return record;
}
