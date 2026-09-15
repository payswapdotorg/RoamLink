/**
 * Edge capability snapshot contract (RL-040, spec/mobile.md "Capability
 * discovery", RL-LOCK-010/011).
 *
 * The EDGE-side capability snapshot: an immutable, versioned record of what
 * the OS and device expose, per capability, each with a Wave-0 evidence
 * class, an observed instant and a typed minimal platform-evidence payload.
 *
 * Honesty rules (RL-LOCK-011 - enforced by the constructor):
 *  - a capability may only claim a NON-unknown status (`available`,
 *    `unavailable`, `requires-permission`) with real platform evidence: the
 *    evidence kind must not be `none` and the evidence class must not be
 *    UNKNOWN. Absence of evidence is recorded as `unknown`, which is a valid
 *    and honest state, never a failure and never a success;
 *  - the entries must cover exactly the capabilities IN SCOPE for the
 *    platform family (out-of-scope entries are rejected - the closed
 *    vocabulary's platform scope is a contract, not a suggestion);
 *  - the record is deeply frozen and carries a per-device monotonic sequence
 *    for ordering; `succeeds()` verifies chain continuity.
 *
 * NOTE (RL-LOCK-019): this is the EDGE contract produced by edge agents.
 * The Experience-domain `DeviceCapabilitySnapshot` aggregate (RL-010, Worker
 * A) is a separate, disjoint record that projects this information into the
 * device registry; the two are deliberately not merged.
 */
import {
  ValidationError,
  canonicalJsonDigest,
  parseContractVersion,
  parseEvidenceClass,
  parseRevision,
  parseUtcInstant,
  type ContractVersion,
  type Digest,
  type EvidenceClass,
  type Revision,
  type UtcInstant,
} from "@roamlink/contracts";

import { EDGE_CAPABILITY_NAMES, parseEdgeCapabilityName, type EdgeCapabilityName } from "./capability-name.js";
import {
  edgeCapabilitiesInScope,
  parseEdgePlatformFamily,
  type EdgePlatformFamily,
} from "./capability-model.js";
import { parseEdgePlatformEvidence, type EdgePlatformEvidence } from "./evidence.js";
import {
  parseEdgeCapabilitySnapshotId,
  parseEdgeDeviceRef,
  type EdgeCapabilitySnapshotId,
  type EdgeDeviceRef,
} from "../ids.js";
import { describeEdgeContractVersionExpectation, isEdgeRecordVersionCompatible } from "../version.js";

export const EDGE_CAPABILITY_STATUSES = [
  "available",
  "unavailable",
  "requires-permission",
  "unknown",
] as const;

export type EdgeCapabilityStatus = (typeof EDGE_CAPABILITY_STATUSES)[number];

export function isEdgeCapabilityStatus(value: unknown): value is EdgeCapabilityStatus {
  return (
    typeof value === "string" && (EDGE_CAPABILITY_STATUSES as readonly string[]).includes(value)
  );
}

export function parseEdgeCapabilityStatus(value: unknown): EdgeCapabilityStatus {
  if (!isEdgeCapabilityStatus(value)) {
    throw new ValidationError(
      "value is not a member of the closed edge capability status vocabulary (available, unavailable, requires-permission, unknown - unknown is valid and honest, RL-LOCK-011)",
      {
        reason: "EDGE_CAPABILITY_ENTRY_INVALID",
        details: [{ path: "EdgeCapabilityStatus", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/** Platform descriptor carried by a snapshot. */
export interface EdgePlatformDescriptor {
  readonly family: EdgePlatformFamily;
  /** Bounded, printable, non-secret platform version label (e.g. an OS version). */
  readonly platformVersion: string;
}

/** One capability entry inside a snapshot. */
export interface EdgeCapabilityEntry {
  readonly status: EdgeCapabilityStatus;
  /** Wave-0 evidence class for this entry's status claim. */
  readonly evidenceClass: EvidenceClass;
  /** When this entry was observed (per-entry freshness, RL-LOCK-010). */
  readonly observedAt: UtcInstant;
  /** Typed, minimal platform evidence payload. */
  readonly evidence: EdgePlatformEvidence;
}

/** Serialized (plain) form of an edge capability snapshot. */
export interface EdgeCapabilitySnapshotPlain {
  readonly snapshotId: EdgeCapabilitySnapshotId;
  readonly contractVersion: ContractVersion;
  /** Per-device monotonic sequence (1-based) for snapshot ordering. */
  readonly sequence: Revision;
  readonly deviceRef: EdgeDeviceRef;
  readonly platform: EdgePlatformDescriptor;
  readonly observedAt: UtcInstant;
  /** Last instant the snapshot may be treated as fresh; null = no guarantee. */
  readonly freshUntil: UtcInstant | null;
  /** Entries for exactly the capabilities in scope for the platform family. */
  readonly capabilities: Readonly<Partial<Record<EdgeCapabilityName, EdgeCapabilityEntry>>>;
}

/** Input accepted by the {@link EdgeCapabilitySnapshot} constructor. */
export interface EdgeCapabilitySnapshotInput {
  readonly snapshotId: string;
  readonly contractVersion: string;
  readonly sequence: number;
  readonly deviceRef: string;
  readonly platform: { readonly family: string; readonly platformVersion: string };
  readonly observedAt: string;
  readonly freshUntil: string | null;
  readonly capabilities: Readonly<Record<string, unknown>>;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "snapshotId",
  "contractVersion",
  "sequence",
  "deviceRef",
  "platform",
  "observedAt",
  "freshUntil",
  "capabilities",
]);

const MAX_PLATFORM_VERSION_LENGTH = 64;

function field(label: string, issue: string): never {
  throw new ValidationError(`EdgeCapabilitySnapshot rejected: ${label} - ${issue}`, {
    reason: "EDGE_CAPABILITY_SNAPSHOT_INVALID",
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

function parsePlatformDescriptor(value: unknown): EdgePlatformDescriptor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("platform", "must be an object with family and platformVersion");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["family", "platformVersion"].includes(key)) {
      field(`platform.${key}`, "unknown field (the platform descriptor carries exactly family + platformVersion)");
    }
  }
  const family = parseField("platform.family", "must be a member of the closed platform-family vocabulary", () =>
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
    field(
      "platform.platformVersion",
      "must be a trimmed, printable, non-secret label of 1-64 chars",
    );
  }
  return Object.freeze({ family, platformVersion });
}

function isPrintable(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function parseEntry(name: EdgeCapabilityName, value: unknown): EdgeCapabilityEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field(`capabilities.${name}`, "must be a capability entry object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["status", "evidenceClass", "observedAt", "evidence"].includes(key)) {
      field(`capabilities.${name}.${key}`, "unknown field (an entry carries exactly status, evidenceClass, observedAt, evidence)");
    }
  }
  const status = parseField(`capabilities.${name}.status`, "must be a member of the closed capability status vocabulary", () =>
    parseEdgeCapabilityStatus(record["status"]),
  );
  const evidenceClass = parseField(
    `capabilities.${name}.evidenceClass`,
    "must be a member of the Wave-0 evidence-class vocabulary",
    () => parseEvidenceClass(record["evidenceClass"]),
  );
  const observedAt = parseField(
    `capabilities.${name}.observedAt`,
    "must be a UTC instant with an explicit zone designator",
    () => parseUtcInstant(record["observedAt"]),
  );
  const evidence = (() => {
    try {
      return parseEdgePlatformEvidence(record["evidence"]);
    } catch (error) {
      if (error instanceof ValidationError) {
        field(`capabilities.${name}.evidence`, error.message);
      }
      throw error;
    }
  })();

  // RL-LOCK-011 honesty: a non-unknown status claim requires real evidence.
  if (status !== "unknown" && (evidence.kind === "none" || evidenceClass === "UNKNOWN")) {
    field(
      `capabilities.${name}`,
      "a non-unknown status claim requires real platform evidence (kind !== 'none' and evidenceClass !== UNKNOWN) - record 'unknown' instead of guessing",
    );
  }
  return Object.freeze({ status, evidenceClass, observedAt, evidence });
}

function parseCapabilities(
  family: EdgePlatformFamily,
  value: Readonly<Record<string, unknown>>,
): Readonly<Partial<Record<EdgeCapabilityName, EdgeCapabilityEntry>>> {
  const inScope = new Set<string>(edgeCapabilitiesInScope(family));
  const parsed: Partial<Record<EdgeCapabilityName, EdgeCapabilityEntry>> = {};

  for (const key of Object.keys(value)) {
    const name = parseField(
      `capabilities.${key}`,
      "not a member of the closed edge capability vocabulary",
      () => parseEdgeCapabilityName(key),
    );
    if (!inScope.has(name)) {
      field(
        `capabilities.${name}`,
        "capability is not in scope for the snapshot's platform family (the closed vocabulary's platform scope is a contract)",
      );
    }
    parsed[name] = parseEntry(name, value[key]);
  }
  for (const required of inScope) {
    if (parsed[required as EdgeCapabilityName] === undefined) {
      field(
        `capabilities.${required}`,
        "missing required in-scope capability entry (record status 'unknown' when the platform provides no evidence)",
      );
    }
  }
  return Object.freeze(parsed);
}

/**
 * Immutable, versioned edge capability snapshot. Constructed only through
 * full validation; deeply frozen; deterministic digest over the canonical
 * JSON form (reuse of the Wave-0 serialization primitives).
 */
export class EdgeCapabilitySnapshot {
  readonly snapshotId: EdgeCapabilitySnapshotId;
  readonly contractVersion: ContractVersion;
  readonly sequence: Revision;
  readonly deviceRef: EdgeDeviceRef;
  readonly platform: EdgePlatformDescriptor;
  readonly observedAt: UtcInstant;
  readonly freshUntil: UtcInstant | null;
  readonly capabilities: Readonly<Partial<Record<EdgeCapabilityName, EdgeCapabilityEntry>>>;

  constructor(input: EdgeCapabilitySnapshotInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the snapshot carries exactly its contract fields)");
      }
    }

    const snapshotId = parseField("snapshotId", "must be a canonical lowercase UUID", () =>
      parseEdgeCapabilitySnapshotId(input.snapshotId),
    );
    const contractVersion = parseField(
      "contractVersion",
      "must be a MAJOR.MINOR contract version",
      () => parseContractVersion(input.contractVersion),
    );
    if (!isEdgeRecordVersionCompatible(contractVersion)) {
      field("contractVersion", describeEdgeContractVersionExpectation());
    }
    const sequence = parseField("sequence", "must be a positive integer (per-device monotonic sequence)", () =>
      parseRevision(input.sequence),
    );
    const deviceRef = parseField("deviceRef", "must be a non-empty safe reference string", () =>
      parseEdgeDeviceRef(input.deviceRef),
    );
    const platform = parsePlatformDescriptor(input.platform);
    const observedAt = parseField(
      "observedAt",
      "must be a UTC instant with an explicit zone designator",
      () => parseUtcInstant(input.observedAt),
    );
    const freshUntil =
      input.freshUntil === null
        ? null
        : parseField("freshUntil", "must be null or a UTC instant", () =>
            parseUtcInstant(input.freshUntil),
          );
    if (input.capabilities === null || typeof input.capabilities !== "object") {
      field("capabilities", "must be a record of capability entries");
    }
    const capabilities = parseCapabilities(platform.family, input.capabilities);

    this.snapshotId = snapshotId;
    this.contractVersion = contractVersion;
    this.sequence = sequence;
    this.deviceRef = deviceRef;
    this.platform = platform;
    this.observedAt = observedAt;
    this.freshUntil = freshUntil;
    this.capabilities = capabilities;
    Object.freeze(this);
  }

  /** Plain, serializable form with exactly the contract fields. */
  toPlain(): EdgeCapabilitySnapshotPlain {
    return Object.freeze({
      snapshotId: this.snapshotId,
      contractVersion: this.contractVersion,
      sequence: this.sequence,
      deviceRef: this.deviceRef,
      platform: this.platform,
      observedAt: this.observedAt,
      freshUntil: this.freshUntil,
      capabilities: this.capabilities,
    });
  }

  /** Deterministic SHA-256 digest of the canonical JSON form (Wave-0 reuse). */
  digest(): Digest {
    return canonicalJsonDigest(this.toPlain());
  }

  /** The entry for a capability, or undefined when out of scope for the platform. */
  entryFor(name: EdgeCapabilityName): EdgeCapabilityEntry | undefined {
    return this.capabilities[name];
  }

  /**
   * True when this snapshot directly succeeds `previous` in the device's
   * snapshot chain: same device reference, sequence exactly +1. Reordered or
   * gapped snapshots are detected (not silently accepted).
   */
  succeeds(previous: EdgeCapabilitySnapshot): boolean {
    return this.deviceRef === previous.deviceRef && this.sequence === previous.sequence + 1;
  }

  /** Validating round-trip from an unknown (e.g. JSON-parsed) value. */
  static fromPlain(value: unknown): EdgeCapabilitySnapshot {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      field("$", "fromPlain expects an object");
    }
    return new EdgeCapabilitySnapshot(value as EdgeCapabilitySnapshotInput);
  }
}

/** Exposed for tests and diagnostics: the full vocabulary, snapshot-relevant. */
export const SNAPSHOT_CAPABILITY_VOCABULARY: readonly EdgeCapabilityName[] = EDGE_CAPABILITY_NAMES;
