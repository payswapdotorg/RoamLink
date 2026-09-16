/**
 * Device capability snapshot (RL-010, RL-LOCK-010/011).
 *
 * The EXPERIENCE-domain registry record: an immutable, versioned, per-device
 * snapshot of what the device's platform exposes, per capability, each entry
 * tagged with a Wave-0 evidence class and its own observed instant
 * (evidence and freshness are first-class, RL-LOCK-010).
 *
 * Honesty rules (RL-LOCK-011 - enforced by the constructor):
 *  - a capability may only claim a NON-unknown status with real evidence:
 *    the entry's evidence class must not be UNKNOWN;
 *  - ABSENCE of an entry is DATA, not an error: `capabilityStatus(name)`
 *    reports `unknown` for unlisted capabilities (the registry never guesses);
 *  - entry names must belong to the closed 11-name vocabulary.
 *
 * Structural compatibility: the field layout mirrors the edge package's
 * `EdgeCapabilitySnapshot` (family/platformVersion/observedAt/freshUntil/
 * capabilities{name:{status,evidenceClass,observedAt}}) so the Wave-2
 * projection from the edge snapshot is a pure structural mapping - the two
 * records are deliberately NOT merged (RL-LOCK-019 disjoint ownership).
 *
 * Chain continuity: every snapshot carries a per-device monotonic sequence;
 * `succeeds(previous)` verifies previous.sequence + 1 on the same device.
 */
import {
  ValidationError,
  canonicalJsonDigest,
  parseContractVersion,
  parseDeviceCapabilitySnapshotId,
  parseDeviceId,
  parseEvidenceClass,
  parseRevision,
  parseUtcInstant,
  type ContractVersion,
  type DeviceCapabilitySnapshotId,
  type DeviceId,
  type Digest,
  type EvidenceClass,
  type Revision,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  DEVICE_CAPABILITY_NAMES,
  isDeviceCapabilityName,
  type DeviceCapabilityName,
} from "./device-capability-name.js";
import {
  parseDevicePlatformFamily,
  parsePlatformVersionLabel,
  type DevicePlatformFamily,
} from "../device/platform.js";
import {
  DOMAIN_EXPERIENCE_CONTRACT_VERSION,
  describeDomainExperienceVersionExpectation,
  isDomainExperienceRecordVersionCompatible,
} from "../version.js";

export const DEVICE_CAPABILITY_STATUSES = [
  "available",
  "unavailable",
  "requires-permission",
  "unknown",
] as const;

export type DeviceCapabilityStatus = (typeof DEVICE_CAPABILITY_STATUSES)[number];

export function isDeviceCapabilityStatus(value: unknown): value is DeviceCapabilityStatus {
  return (
    typeof value === "string" && (DEVICE_CAPABILITY_STATUSES as readonly string[]).includes(value)
  );
}

export function parseDeviceCapabilityStatus(value: unknown): DeviceCapabilityStatus {
  if (!isDeviceCapabilityStatus(value)) {
    throw new ValidationError(
      "value is not a member of the closed device capability status vocabulary (available, unavailable, requires-permission, unknown - unknown is valid and honest, RL-LOCK-011)",
      {
        reason: "DEVICE_CAPABILITY_ENTRY_INVALID",
        details: [{ path: "DeviceCapabilityStatus", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/** One capability entry inside a snapshot: status + evidence + freshness. */
export interface DeviceCapabilityEntry {
  readonly status: DeviceCapabilityStatus;
  /** Wave-0 evidence class backing the status claim. */
  readonly evidenceClass: EvidenceClass;
  /** When this entry was observed (per-entry freshness, RL-LOCK-010). */
  readonly observedAt: UtcInstant;
}

/** Serialized (plain) form of a device capability snapshot. */
export interface DeviceCapabilitySnapshotPlain {
  readonly snapshotId: DeviceCapabilitySnapshotId;
  readonly contractVersion: ContractVersion;
  /** Per-device monotonic sequence (1-based) for snapshot ordering. */
  readonly sequence: Revision;
  readonly deviceId: DeviceId;
  readonly platform: {
    readonly family: DevicePlatformFamily;
    readonly platformVersion: string;
  };
  readonly observedAt: UtcInstant;
  /** Last instant the snapshot may be treated as fresh; null = no guarantee. */
  readonly freshUntil: UtcInstant | null;
  /** Entries for the capabilities with evidence; absent = unknown (data). */
  readonly capabilities: Readonly<Partial<Record<DeviceCapabilityName, DeviceCapabilityEntry>>>;
}

/** Input accepted by the {@link DeviceCapabilitySnapshot} constructor. */
export interface DeviceCapabilitySnapshotInput {
  readonly snapshotId: string;
  readonly contractVersion: string;
  readonly sequence: number;
  readonly deviceId: string;
  readonly platform: { readonly family: string; readonly platformVersion: string };
  readonly observedAt: string;
  readonly freshUntil: string | null;
  readonly capabilities: Readonly<Record<string, unknown>>;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "snapshotId",
  "contractVersion",
  "sequence",
  "deviceId",
  "platform",
  "observedAt",
  "freshUntil",
  "capabilities",
]);

const ALLOWED_PLATFORM_FIELDS = new Set(["family", "platformVersion"]);
const ALLOWED_ENTRY_FIELDS = new Set(["status", "evidenceClass", "observedAt"]);

function field(label: string, issue: string): never {
  throw new ValidationError(`DeviceCapabilitySnapshot rejected: ${label} - ${issue}`, {
    reason: "DEVICE_CAPABILITY_SNAPSHOT_INVALID",
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

/**
 * The immutable device capability snapshot. Deeply frozen; new observations
 * are NEW snapshots (chain-continuity via {@link succeeds}).
 */
export class DeviceCapabilitySnapshot {
  readonly snapshotId: DeviceCapabilitySnapshotId;
  readonly contractVersion: ContractVersion;
  readonly sequence: Revision;
  readonly deviceId: DeviceId;
  readonly platform: { readonly family: DevicePlatformFamily; readonly platformVersion: string };
  readonly observedAt: UtcInstant;
  readonly freshUntil: UtcInstant | null;
  readonly capabilities: Readonly<Partial<Record<DeviceCapabilityName, DeviceCapabilityEntry>>>;

  constructor(input: DeviceCapabilitySnapshotInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (fail-closed, RL-LOCK-017)");
      }
    }

    this.snapshotId = parseField(
      "snapshotId",
      "must be a canonical lowercase UUID",
      () => parseDeviceCapabilitySnapshotId(input.snapshotId),
    );
    const contractVersion = parseField(
      "contractVersion",
      "must be a MAJOR.MINOR contract version",
      () => parseContractVersion(input.contractVersion),
    );
    if (!isDomainExperienceRecordVersionCompatible(contractVersion)) {
      field("contractVersion", describeDomainExperienceVersionExpectation());
    }
    this.contractVersion = contractVersion;
    this.sequence = parseField(
      "sequence",
      "must be a positive integer (per-device monotonic sequence)",
      () => parseRevision(input.sequence),
    );
    this.deviceId = parseField("deviceId", "must be a canonical lowercase UUID", () =>
      parseDeviceId(input.deviceId),
    );

    const platform = input.platform;
    if (platform === null || typeof platform !== "object" || Array.isArray(platform)) {
      field("platform", "must be an object with family and platformVersion");
    }
    for (const key of Object.keys(platform)) {
      if (!ALLOWED_PLATFORM_FIELDS.has(key)) {
        field(`platform.${key}`, "unknown field (fail-closed, RL-LOCK-017)");
      }
    }
    this.platform = Object.freeze({
      family: parseField("platform.family", "must be a platform-family vocabulary member", () =>
        parseDevicePlatformFamily(platform.family),
      ),
      platformVersion: parsePlatformVersionLabel(platform.platformVersion),
    });

    this.observedAt = parseField(
      "observedAt",
      "must be a UTC instant with a zone designator",
      () => parseUtcInstant(input.observedAt),
    );
    if (input.freshUntil === null) {
      this.freshUntil = null;
    } else {
      this.freshUntil = parseField(
        "freshUntil",
        "must be a UTC instant with a zone designator, or null",
        () => parseUtcInstant(input.freshUntil),
      );
    }

    if (input.capabilities === null || typeof input.capabilities !== "object") {
      field("capabilities", "must be an object keyed by capability name");
    }
    const entries: Partial<Record<DeviceCapabilityName, DeviceCapabilityEntry>> = {};
    for (const [name, rawEntry] of Object.entries(input.capabilities)) {
      if (!isDeviceCapabilityName(name)) {
        field(`capabilities.${name}`, "key is outside the closed capability vocabulary");
      }
      if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        field(`capabilities.${name}`, "entry must be an object with status, evidenceClass, observedAt");
      }
      for (const key of Object.keys(rawEntry as Record<string, unknown>)) {
        if (!ALLOWED_ENTRY_FIELDS.has(key)) {
          field(`capabilities.${name}.${key}`, "unknown field (fail-closed, RL-LOCK-017)");
        }
      }
      const entry = rawEntry as Record<string, unknown>;
      const status = parseField(
        `capabilities.${name}.status`,
        "must be available, unavailable, requires-permission or unknown",
        () => parseDeviceCapabilityStatus(entry["status"]),
      );
      const evidenceClass = parseField(
        `capabilities.${name}.evidenceClass`,
        "must be a Wave-0 evidence class",
        () => parseEvidenceClass(entry["evidenceClass"]),
      );
      const observedAt = parseField(
        `capabilities.${name}.observedAt`,
        "must be a UTC instant with a zone designator",
        () => parseUtcInstant(entry["observedAt"]),
      );
      // Honesty rule (RL-LOCK-011): a non-unknown claim requires real
      // evidence; UNKNOWN evidence can only back an unknown status.
      if (status !== "unknown" && evidenceClass === "UNKNOWN") {
        field(
          `capabilities.${name}.evidenceClass`,
          "a non-unknown status requires evidence whose class is not UNKNOWN (absence of evidence is recorded as status unknown, never guessed)",
        );
      }
      entries[name] = Object.freeze({ status, evidenceClass, observedAt });
    }
    this.capabilities = Object.freeze(entries);

    Object.freeze(this);
  }

  /**
   * The status of a capability. ABSENCE IS DATA: an unlisted capability is
   * `unknown` - never an error, never a guess (RL-LOCK-011).
   */
  capabilityStatus(name: DeviceCapabilityName): DeviceCapabilityStatus {
    return this.capabilities[name]?.status ?? "unknown";
  }

  /** The entry for a capability, or undefined when absent (data, not error). */
  entryFor(name: DeviceCapabilityName): DeviceCapabilityEntry | undefined {
    return this.capabilities[name];
  }

  /** Chain continuity: this snapshot directly succeeds `previous`. */
  succeeds(previous: DeviceCapabilitySnapshot): boolean {
    return this.deviceId === previous.deviceId && this.sequence === previous.sequence + 1;
  }

  /** Deterministic digest of the plain record (content identity). */
  digest(): Digest {
    return canonicalJsonDigest(this.toPlain());
  }

  /** The full closed vocabulary with this snapshot's status per capability. */
  capabilityMatrix(): Readonly<Record<DeviceCapabilityName, DeviceCapabilityStatus>> {
    const matrix = {} as Record<DeviceCapabilityName, DeviceCapabilityStatus>;
    for (const name of DEVICE_CAPABILITY_NAMES) {
      matrix[name] = this.capabilityStatus(name);
    }
    return Object.freeze(matrix);
  }

  toPlain(): DeviceCapabilitySnapshotPlain {
    return Object.freeze({
      snapshotId: this.snapshotId,
      contractVersion: this.contractVersion,
      sequence: this.sequence,
      deviceId: this.deviceId,
      platform: this.platform,
      observedAt: this.observedAt,
      freshUntil: this.freshUntil,
      capabilities: this.capabilities,
    });
  }

  static fromPlain(plain: DeviceCapabilitySnapshotPlain): DeviceCapabilitySnapshot {
    return new DeviceCapabilitySnapshot({
      snapshotId: plain.snapshotId,
      contractVersion: plain.contractVersion,
      sequence: plain.sequence,
      deviceId: plain.deviceId,
      platform: plain.platform,
      observedAt: plain.observedAt,
      freshUntil: plain.freshUntil,
      capabilities: plain.capabilities as Readonly<Record<string, unknown>>,
    });
  }
}

/** The contract version this package implements (re-exported for records). */
export const DEVICE_CAPABILITY_SNAPSHOT_CONTRACT_VERSION = DOMAIN_EXPERIENCE_CONTRACT_VERSION;
