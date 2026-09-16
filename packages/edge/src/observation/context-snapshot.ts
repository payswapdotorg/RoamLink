/**
 * Edge context snapshot contract (RL-041, spec/mobile.md "Offline" /
 * "Device privacy", RL-LOCK-010/011).
 *
 * The EDGE-side local context read model: an immutable, versioned record of
 * the device's MINIMAL connectivity context (technology kinds and metering
 * only - deliberately NO network identifiers, NO location; spec/mobile.md
 * "Device privacy"). Each entry carries a Wave-0 evidence class, an observed
 * instant and the typed minimal platform evidence, mirroring the capability
 * snapshot's honesty rules:
 *
 *  - a non-`unknown` value requires real platform evidence (kind !== "none"
 *    and evidenceClass !== UNKNOWN);
 *  - the record covers exactly the closed context-field vocabulary;
 *  - deeply frozen, per-device monotonic sequence with `succeeds()` chain
 *    continuity.
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

import {
  EDGE_CONTEXT_FIELDS,
  EDGE_CONTEXT_FIELD_VALUE_VOCABULARIES,
  isEdgeContextFieldName,
  type EdgeContextFieldName,
} from "./observation.js";
import { parseEdgePlatformEvidence, type EdgePlatformEvidence } from "../capability/evidence.js";
import {
  parseEdgeContextSnapshotId,
  parseEdgeDeviceRef,
  type EdgeContextSnapshotId,
  type EdgeDeviceRef,
} from "../ids.js";
import {
  describeEdgeContractVersionExpectation,
  isEdgeRecordVersionCompatible,
} from "../version.js";
import type { EdgePlatformDescriptor } from "../capability/capability-snapshot.js";
import { parseEdgePlatformFamily } from "../capability/capability-model.js";

/** One context-field entry inside a snapshot. */
export interface EdgeContextEntry {
  /** Closed-vocabulary value for the field. */
  readonly value: string;
  readonly evidenceClass: EvidenceClass;
  readonly observedAt: UtcInstant;
  readonly evidence: EdgePlatformEvidence;
}

/** Serialized (plain) form of an edge context snapshot. */
export interface EdgeContextSnapshotPlain {
  readonly snapshotId: EdgeContextSnapshotId;
  readonly contractVersion: ContractVersion;
  readonly sequence: Revision;
  readonly deviceRef: EdgeDeviceRef;
  readonly platform: EdgePlatformDescriptor;
  readonly observedAt: UtcInstant;
  readonly freshUntil: UtcInstant | null;
  /** Entries for exactly the closed context-field vocabulary. */
  readonly entries: Readonly<Partial<Record<EdgeContextFieldName, EdgeContextEntry>>>;
}

/** Input accepted by the {@link EdgeContextSnapshot} constructor. */
export interface EdgeContextSnapshotInput {
  readonly snapshotId: string;
  readonly contractVersion: string;
  readonly sequence: number;
  readonly deviceRef: string;
  readonly platform: { readonly family: string; readonly platformVersion: string };
  readonly observedAt: string;
  readonly freshUntil: string | null;
  readonly entries: Readonly<Record<string, unknown>>;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "snapshotId",
  "contractVersion",
  "sequence",
  "deviceRef",
  "platform",
  "observedAt",
  "freshUntil",
  "entries",
]);

const MAX_PLATFORM_VERSION_LENGTH = 64;

function field(label: string, issue: string): never {
  throw new ValidationError(`EdgeContextSnapshot rejected: ${label} - ${issue}`, {
    reason: "EDGE_CONTEXT_SNAPSHOT_INVALID",
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

function isPrintable(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function parsePlatformDescriptor(value: unknown): EdgePlatformDescriptor {
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

function parseEntry(name: EdgeContextFieldName, value: unknown): EdgeContextEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field(`entries.${name}`, "must be a context entry object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["value", "evidenceClass", "observedAt", "evidence"].includes(key)) {
      field(`entries.${name}.${key}`, "unknown field (an entry carries exactly value, evidenceClass, observedAt, evidence)");
    }
  }
  const entryValue = record["value"];
  if (
    typeof entryValue !== "string" ||
    !EDGE_CONTEXT_FIELD_VALUE_VOCABULARIES[name].includes(entryValue)
  ) {
    field(`entries.${name}.value`, "must be a member of the closed value vocabulary for this field");
  }
  const evidenceClass = parseField(
    `entries.${name}.evidenceClass`,
    "must be a member of the Wave-0 evidence-class vocabulary",
    () => parseEvidenceClass(record["evidenceClass"]),
  );
  const observedAt = parseField(
    `entries.${name}.observedAt`,
    "must be a UTC instant with an explicit zone designator",
    () => parseUtcInstant(record["observedAt"]),
  );
  const evidence = (() => {
    try {
      return parseEdgePlatformEvidence(record["evidence"]);
    } catch (error) {
      if (error instanceof ValidationError) {
        field(`entries.${name}.evidence`, error.message);
      }
      throw error;
    }
  })();
  // RL-LOCK-011 honesty: a non-unknown value claim requires real evidence.
  if (entryValue !== "unknown" && (evidence.kind === "none" || evidenceClass === "UNKNOWN")) {
    field(
      `entries.${name}`,
      "a non-unknown value claim requires real platform evidence (kind !== 'none' and evidenceClass !== UNKNOWN) - record 'unknown' instead of guessing",
    );
  }
  return Object.freeze({ value: entryValue, evidenceClass, observedAt, evidence });
}

function parseEntries(value: unknown): Readonly<Partial<Record<EdgeContextFieldName, EdgeContextEntry>>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("entries", "must be a record of context entries");
  }
  const parsed: Partial<Record<EdgeContextFieldName, EdgeContextEntry>> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!isEdgeContextFieldName(key)) {
      field(
        `entries.${key}`,
        "not a member of the closed context-field vocabulary (connectivity-state, active-interface-kind, interface-metered)",
      );
    }
    const name = key as EdgeContextFieldName;
    parsed[name] = parseEntry(name, (value as Record<string, unknown>)[key]);
  }
  for (const required of EDGE_CONTEXT_FIELDS) {
    if (parsed[required] === undefined) {
      field(
        `entries.${required}`,
        "missing required context entry (record value 'unknown' when the platform provides no evidence)",
      );
    }
  }
  return Object.freeze(parsed);
}

/** Immutable, versioned edge context snapshot (validated + deeply frozen). */
export class EdgeContextSnapshot {
  readonly snapshotId: EdgeContextSnapshotId;
  readonly contractVersion: ContractVersion;
  readonly sequence: Revision;
  readonly deviceRef: EdgeDeviceRef;
  readonly platform: EdgePlatformDescriptor;
  readonly observedAt: UtcInstant;
  readonly freshUntil: UtcInstant | null;
  readonly entries: Readonly<Partial<Record<EdgeContextFieldName, EdgeContextEntry>>>;

  constructor(input: EdgeContextSnapshotInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (the snapshot carries exactly its contract fields)");
      }
    }
    const snapshotId = parseField("snapshotId", "must be a canonical lowercase UUID", () =>
      parseEdgeContextSnapshotId(input.snapshotId),
    );
    const contractVersion = parseField("contractVersion", "must be a MAJOR.MINOR contract version", () =>
      parseContractVersion(input.contractVersion),
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
    const observedAt = parseField("observedAt", "must be a UTC instant with an explicit zone designator", () =>
      parseUtcInstant(input.observedAt),
    );
    const freshUntil =
      input.freshUntil === null
        ? null
        : parseField("freshUntil", "must be null or a UTC instant", () => parseUtcInstant(input.freshUntil));
    const entries = parseEntries(input.entries);

    this.snapshotId = snapshotId;
    this.contractVersion = contractVersion;
    this.sequence = sequence;
    this.deviceRef = deviceRef;
    this.platform = platform;
    this.observedAt = observedAt;
    this.freshUntil = freshUntil;
    this.entries = entries;
    Object.freeze(this);
  }

  /** Plain, serializable form with exactly the contract fields. */
  toPlain(): EdgeContextSnapshotPlain {
    return Object.freeze({
      snapshotId: this.snapshotId,
      contractVersion: this.contractVersion,
      sequence: this.sequence,
      deviceRef: this.deviceRef,
      platform: this.platform,
      observedAt: this.observedAt,
      freshUntil: this.freshUntil,
      entries: this.entries,
    });
  }

  /** Deterministic SHA-256 digest of the canonical JSON form (Wave-0 reuse). */
  digest(): Digest {
    return canonicalJsonDigest(this.toPlain());
  }

  /** The entry for a context field (always present - totality is enforced). */
  entryFor(name: EdgeContextFieldName): EdgeContextEntry | undefined {
    return this.entries[name];
  }

  /** True when this snapshot directly succeeds `previous` (same device, +1). */
  succeeds(previous: EdgeContextSnapshot): boolean {
    return this.deviceRef === previous.deviceRef && this.sequence === previous.sequence + 1;
  }

  /** Validating round-trip from an unknown (e.g. JSON-parsed) value. */
  static fromPlain(value: unknown): EdgeContextSnapshot {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      field("$", "fromPlain expects an object");
    }
    return new EdgeContextSnapshot(value as EdgeContextSnapshotInput);
  }
}
