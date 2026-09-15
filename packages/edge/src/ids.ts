/**
 * Edge-owned opaque reference types (RL-040).
 *
 * These reuse the Wave-0 ID machinery from @roamlink/contracts verbatim -
 * `parseCanonicalUuidAs` for locally generated UUID identities and
 * `parseForeignRefAs` for opaque references that travel across the edge<->cloud
 * sync boundary. No parallel identity grammar is invented (RL-LOCK-003: the
 * RoamLink device registry, RL-010, owns the canonical DeviceId aggregate;
 * the edge refers to the device by an opaque enrollment reference).
 */
import type { Branded } from "@roamlink/contracts";
import {
  isCanonicalUuid,
  isForeignRefShaped,
  parseCanonicalUuidAs,
  parseForeignRefAs,
} from "@roamlink/contracts";

/**
 * Opaque reference to the RoamLink-enrolled device an edge record belongs to.
 * Foreign-reference shaped because it crosses the sync boundary as an opaque
 * string; it is never an ADCOS identity (RL-LOCK-003).
 */
export type EdgeDeviceRef = Branded<"EdgeDeviceRef">;

/** Identity of an edge capability snapshot (locally generated UUID). */
export type EdgeCapabilitySnapshotId = Branded<"EdgeCapabilitySnapshotId">;

/** Identity of a device action (locally generated UUID). */
export type DeviceActionId = Branded<"DeviceActionId">;

/** Identity of a local desired-state record (locally generated UUID). */
export type EdgeDesiredStateId = Branded<"EdgeDesiredStateId">;

/** Identity of an outbox record (locally generated UUID). */
export type EdgeOutboxRecordId = Branded<"EdgeOutboxRecordId">;

export function parseEdgeDeviceRef(value: unknown): EdgeDeviceRef {
  return parseForeignRefAs<EdgeDeviceRef>(value, "EdgeDeviceRef");
}

export function isEdgeDeviceRef(value: unknown): value is EdgeDeviceRef {
  return isForeignRefShaped(value);
}

export function parseEdgeCapabilitySnapshotId(value: unknown): EdgeCapabilitySnapshotId {
  return parseCanonicalUuidAs<EdgeCapabilitySnapshotId>(value, "EdgeCapabilitySnapshotId");
}

export function isEdgeCapabilitySnapshotId(value: unknown): value is EdgeCapabilitySnapshotId {
  return isCanonicalUuid(value);
}

export function parseDeviceActionId(value: unknown): DeviceActionId {
  return parseCanonicalUuidAs<DeviceActionId>(value, "DeviceActionId");
}

export function isDeviceActionId(value: unknown): value is DeviceActionId {
  return isCanonicalUuid(value);
}

export function parseEdgeDesiredStateId(value: unknown): EdgeDesiredStateId {
  return parseCanonicalUuidAs<EdgeDesiredStateId>(value, "EdgeDesiredStateId");
}

export function isEdgeDesiredStateId(value: unknown): value is EdgeDesiredStateId {
  return isCanonicalUuid(value);
}

export function parseEdgeOutboxRecordId(value: unknown): EdgeOutboxRecordId {
  return parseCanonicalUuidAs<EdgeOutboxRecordId>(value, "EdgeOutboxRecordId");
}

export function isEdgeOutboxRecordId(value: unknown): value is EdgeOutboxRecordId {
  return isCanonicalUuid(value);
}
