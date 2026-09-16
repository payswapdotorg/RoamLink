/**
 * Tenant-scoped repository ports + the experience access policy
 * (RL-010/RL-011).
 *
 * MULTI-TENANCY BY CONSTRUCTION (same discipline as @roamlink/auth): every
 * record carries its Wave-0 TenantId and every port read takes the tenant
 * namespace FIRST; a read through the wrong tenant returns undefined/empty -
 * no existence oracle, cross-tenant access fails closed. The in-memory
 * adapters PROVE this in tests (RL-LOCK-018).
 *
 * The {@link ExperienceAccessPolicy} port is the authorization seam: the
 * composition layer (Wave 2+) binds an adapter over @roamlink/auth's
 * AuthorizationService; this package never imports auth internals
 * (RL-LOCK-019 disjoint ownership).
 *
 * All writes are compare-and-swap on the record revision (RL-003-compatible
 * optimistic concurrency); snapshot repositories additionally enforce
 * per-device chain continuity (sequence + 1).
 */
import type {
  ActorId,
  DeviceCapabilitySnapshotId,
  DeviceContextSnapshotId,
  DeviceId,
  ExperienceIntentId,
  ExperienceIntentVersionId,
  TenantId,
  UtcInstant,
  UserId,
} from "@roamlink/contracts";

import type { DeviceCapabilitySnapshotPlain } from "./capability/device-capability-snapshot.js";
import type { DeviceContextSnapshotPlain } from "./device/device-context-snapshot.js";
import type { DeviceRecord } from "./device/device.js";
import type {
  ExperienceIntentRecord,
  ExperienceIntentVersionRecord,
} from "./intent/experience-intent.js";

/** Marker: every persisted experience record is tenant-scoped. */
export interface TenantScopedRecord {
  readonly tenantId: TenantId;
}

// ---------------------------------------------------------------------------
// Experience access policy (authorization seam)
// ---------------------------------------------------------------------------

/** The closed experience-action vocabulary checked by the policy port. */
export const EXPERIENCE_ACTIONS = [
  "device:enroll",
  "device:update",
  "device:retire",
  "snapshot:record",
  "intent:read",
  "intent:write",
] as const;

export type ExperienceAction = (typeof EXPERIENCE_ACTIONS)[number];

export function isExperienceAction(value: unknown): value is ExperienceAction {
  return typeof value === "string" && (EXPERIENCE_ACTIONS as readonly string[]).includes(value);
}

/**
 * The experience access policy port. `authorize` resolves asynchronously and
 * throws UnauthorizedError on denial (fail closed); the production adapter
 * delegates to @roamlink/auth (composition layer, Wave 2+).
 */
export interface ExperienceAccessPolicy {
  authorize(
    actorId: ActorId,
    tenantId: TenantId,
    action: ExperienceAction,
    at: UtcInstant,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Device registry ports (RL-010)
// ---------------------------------------------------------------------------

/** Tenant-scoped device repository. */
export interface DeviceRepository {
  /** CAS insert/update; throws ConflictError on revision mismatch. */
  save(record: DeviceRecord): Promise<void>;
  findById(tenantId: TenantId, deviceId: DeviceId): Promise<DeviceRecord | undefined>;
  listByTenant(tenantId: TenantId): Promise<readonly DeviceRecord[]>;
}

/** Tenant-scoped capability-snapshot repository with chain continuity. */
export interface DeviceCapabilitySnapshotRepository {
  /**
   * CAS insert enforcing per-device chain continuity: the stored latest
   * sequence for the device must be exactly `record.sequence - 1` (or none
   * when sequence is 1); otherwise a typed ConflictError.
   */
  save(record: DeviceCapabilitySnapshotPlain & { readonly tenantId: TenantId }): Promise<void>;
  findById(
    tenantId: TenantId,
    snapshotId: DeviceCapabilitySnapshotId,
  ): Promise<(DeviceCapabilitySnapshotPlain & { readonly tenantId: TenantId }) | undefined>;
  listForDevice(
    tenantId: TenantId,
    deviceId: DeviceId,
  ): Promise<readonly (DeviceCapabilitySnapshotPlain & { readonly tenantId: TenantId })[]>;
  latestForDevice(
    tenantId: TenantId,
    deviceId: DeviceId,
  ): Promise<(DeviceCapabilitySnapshotPlain & { readonly tenantId: TenantId }) | undefined>;
}

/** Tenant-scoped context-snapshot repository with chain continuity. */
export interface DeviceContextSnapshotRepository {
  /** Chain-continuity-enforced insert (same rules as capability snapshots). */
  save(record: DeviceContextSnapshotPlain): Promise<void>;
  findById(
    tenantId: TenantId,
    snapshotId: DeviceContextSnapshotId,
  ): Promise<DeviceContextSnapshotPlain | undefined>;
  listForDevice(
    tenantId: TenantId,
    deviceId: DeviceId,
  ): Promise<readonly DeviceContextSnapshotPlain[]>;
  latestForDevice(
    tenantId: TenantId,
    deviceId: DeviceId,
  ): Promise<DeviceContextSnapshotPlain | undefined>;
}

// ---------------------------------------------------------------------------
// ExperienceIntent ports (RL-011)
// ---------------------------------------------------------------------------

/** Tenant-scoped intent header repository. */
export interface ExperienceIntentRepository {
  /** CAS insert/update; throws ConflictError on revision mismatch. */
  save(record: ExperienceIntentRecord): Promise<void>;
  findById(
    tenantId: TenantId,
    intentId: ExperienceIntentId,
  ): Promise<ExperienceIntentRecord | undefined>;
  listByOwner(tenantId: TenantId, ownerUserId: UserId): Promise<readonly ExperienceIntentRecord[]>;
}

/** Tenant-scoped immutable intent-version repository. */
export interface ExperienceIntentVersionRepository {
  /** Insert-only (immutable records); re-inserting the same id is a ConflictError. */
  save(record: ExperienceIntentVersionRecord): Promise<void>;
  findById(
    tenantId: TenantId,
    intentVersionId: ExperienceIntentVersionId,
  ): Promise<ExperienceIntentVersionRecord | undefined>;
  listForIntent(
    tenantId: TenantId,
    intentId: ExperienceIntentId,
  ): Promise<readonly ExperienceIntentVersionRecord[]>;
}
