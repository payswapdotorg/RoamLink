/**
 * In-memory adapters for the experience-domain ports (RL-010/RL-011).
 *
 * TEST/LOCAL-DEVELOPMENT DOUBLES with the semantics a durable
 * implementation (RL-003 persistence) must provide:
 *  - tenant-scoped reads fail closed across tenants (no existence oracle);
 *  - writes are compare-and-swap on the record revision;
 *  - snapshot repositories enforce per-device CHAIN CONTINUITY
 *    (sequence must be latest + 1 for the device);
 *  - intent-version repository is insert-only (immutable records);
 *  - stored records are deep-frozen plain copies.
 *
 * The tenant-boundary proofs in the test suite run against THESE adapters
 * (RL-LOCK-018): a durable adapter must pass the same proofs before ship.
 */
import {
  ConflictError,
  type DeviceCapabilitySnapshotId,
  type DeviceContextSnapshotId,
  type DeviceId,
  type ExperienceIntentId,
  type ExperienceIntentVersionId,
  type TenantId,
  type UserId,
} from "@roamlink/contracts";

import type { DeviceCapabilitySnapshotPlain } from "./capability/device-capability-snapshot.js";
import type { DeviceContextSnapshotPlain } from "./device/device-context-snapshot.js";
import type { DeviceRecord } from "./device/device.js";
import type {
  ExperienceIntentRecord,
  ExperienceIntentVersionRecord,
} from "./intent/experience-intent.js";
import type {
  DeviceCapabilitySnapshotRepository,
  DeviceContextSnapshotRepository,
  DeviceRepository,
  ExperienceIntentRepository,
  ExperienceIntentVersionRepository,
} from "./ports.js";

function revisionConflict(): ConflictError {
  return new ConflictError(
    "optimistic-concurrency conflict: the stored revision does not match the expected predecessor (the record changed concurrently, or already exists); re-read and retry - never overwrite silently",
    { reason: "REVISION_CONFLICT" },
  );
}

function chainConflict(): ConflictError {
  return new ConflictError(
    "snapshot chain continuity violation: the per-device sequence must be exactly latest + 1 (snapshots are immutable; a replayed or out-of-order snapshot is rejected, never silently applied)",
    { reason: "SNAPSHOT_CHAIN_CONFLICT" },
  );
}

function frozenCopy<T>(record: T): T {
  return Object.freeze(structuredClone(record));
}

function assertCas<T extends { readonly revision: number; readonly tenantId: TenantId }>(
  stored: T | undefined,
  next: T,
): void {
  if (stored === undefined) {
    if (next.revision !== 1) throw revisionConflict();
    return;
  }
  if (stored.revision !== next.revision - 1 || stored.tenantId !== next.tenantId) {
    throw revisionConflict();
  }
}

type TenantScopedCapabilitySnapshot = DeviceCapabilitySnapshotPlain & { readonly tenantId: TenantId };

/** In-memory device repository (tenant-scoped, fail-closed, CAS). */
export class InMemoryDeviceRepository implements DeviceRepository {
  readonly #byId = new Map<string, DeviceRecord>();

  async save(record: DeviceRecord): Promise<void> {
    const stored = this.#byId.get(record.deviceId);
    assertCas(stored, record);
    this.#byId.set(record.deviceId, frozenCopy(record));
  }

  async findById(tenantId: TenantId, deviceId: DeviceId): Promise<DeviceRecord | undefined> {
    const record = this.#byId.get(deviceId);
    return record !== undefined && record.tenantId === tenantId ? record : undefined;
  }

  async listByTenant(tenantId: TenantId): Promise<readonly DeviceRecord[]> {
    return Object.freeze([...this.#byId.values()].filter((r) => r.tenantId === tenantId));
  }
}

/** In-memory capability-snapshot repository (chain continuity + CAS). */
export class InMemoryDeviceCapabilitySnapshotRepository
  implements DeviceCapabilitySnapshotRepository
{
  readonly #byId = new Map<string, TenantScopedCapabilitySnapshot>();
  readonly #byDevice = new Map<string, TenantScopedCapabilitySnapshot[]>();

  async save(record: TenantScopedCapabilitySnapshot): Promise<void> {
    const stored = this.#byId.get(record.snapshotId);
    if (stored !== undefined) {
      // Immutable records: re-inserting the same id is a conflict.
      throw revisionConflict();
    }
    const chain = this.#chainOf(record.tenantId, record.deviceId);
    const latest = chain[chain.length - 1];
    if (record.sequence !== (latest?.sequence ?? 0) + 1) {
      throw chainConflict();
    }
    const copy = frozenCopy(record);
    this.#byId.set(record.snapshotId, copy);
    chain.push(copy);
  }

  async findById(
    tenantId: TenantId,
    snapshotId: DeviceCapabilitySnapshotId,
  ): Promise<TenantScopedCapabilitySnapshot | undefined> {
    const record = this.#byId.get(snapshotId);
    return record !== undefined && record.tenantId === tenantId ? record : undefined;
  }

  async listForDevice(
    tenantId: TenantId,
    deviceId: DeviceId,
  ): Promise<readonly TenantScopedCapabilitySnapshot[]> {
    return Object.freeze([...this.#chainOf(tenantId, deviceId)]);
  }

  async latestForDevice(
    tenantId: TenantId,
    deviceId: DeviceId,
  ): Promise<TenantScopedCapabilitySnapshot | undefined> {
    const chain = this.#chainOf(tenantId, deviceId);
    return chain[chain.length - 1];
  }

  #chainOf(tenantId: TenantId, deviceId: DeviceId): TenantScopedCapabilitySnapshot[] {
    const key = `${tenantId}/${deviceId}`;
    let chain = this.#byDevice.get(key);
    if (chain === undefined) {
      chain = [];
      this.#byDevice.set(key, chain);
    }
    return chain;
  }
}

/** In-memory context-snapshot repository (chain continuity + immutability). */
export class InMemoryDeviceContextSnapshotRepository implements DeviceContextSnapshotRepository {
  readonly #byId = new Map<string, DeviceContextSnapshotPlain>();
  readonly #byDevice = new Map<string, DeviceContextSnapshotPlain[]>();

  async save(record: DeviceContextSnapshotPlain): Promise<void> {
    const stored = this.#byId.get(record.snapshotId);
    if (stored !== undefined) {
      throw revisionConflict();
    }
    const chain = this.#chainOf(record.tenantId, record.deviceId);
    const latest = chain[chain.length - 1];
    if (record.sequence !== (latest?.sequence ?? 0) + 1) {
      throw chainConflict();
    }
    const copy = frozenCopy(record);
    this.#byId.set(record.snapshotId, copy);
    chain.push(copy);
  }

  async findById(
    tenantId: TenantId,
    snapshotId: DeviceContextSnapshotId,
  ): Promise<DeviceContextSnapshotPlain | undefined> {
    const record = this.#byId.get(snapshotId);
    return record !== undefined && record.tenantId === tenantId ? record : undefined;
  }

  async listForDevice(
    tenantId: TenantId,
    deviceId: DeviceId,
  ): Promise<readonly DeviceContextSnapshotPlain[]> {
    return Object.freeze([...this.#chainOf(tenantId, deviceId)]);
  }

  async latestForDevice(
    tenantId: TenantId,
    deviceId: DeviceId,
  ): Promise<DeviceContextSnapshotPlain | undefined> {
    const chain = this.#chainOf(tenantId, deviceId);
    return chain[chain.length - 1];
  }

  #chainOf(tenantId: TenantId, deviceId: DeviceId): DeviceContextSnapshotPlain[] {
    const key = `${tenantId}/${deviceId}`;
    let chain = this.#byDevice.get(key);
    if (chain === undefined) {
      chain = [];
      this.#byDevice.set(key, chain);
    }
    return chain;
  }
}

/** In-memory intent header repository (tenant-scoped, fail-closed, CAS). */
export class InMemoryExperienceIntentRepository implements ExperienceIntentRepository {
  readonly #byId = new Map<string, ExperienceIntentRecord>();

  async save(record: ExperienceIntentRecord): Promise<void> {
    const stored = this.#byId.get(record.intentId);
    assertCas(stored, record);
    this.#byId.set(record.intentId, frozenCopy(record));
  }

  async findById(
    tenantId: TenantId,
    intentId: ExperienceIntentId,
  ): Promise<ExperienceIntentRecord | undefined> {
    const record = this.#byId.get(intentId);
    return record !== undefined && record.tenantId === tenantId ? record : undefined;
  }

  async listByOwner(
    tenantId: TenantId,
    ownerUserId: UserId,
  ): Promise<readonly ExperienceIntentRecord[]> {
    return Object.freeze(
      [...this.#byId.values()].filter(
        (r) => r.tenantId === tenantId && r.ownerUserId === ownerUserId,
      ),
    );
  }
}

/** In-memory immutable intent-version repository (insert-only). */
export class InMemoryExperienceIntentVersionRepository implements ExperienceIntentVersionRepository {
  readonly #byId = new Map<string, ExperienceIntentVersionRecord>();
  readonly #byIntent = new Map<string, ExperienceIntentVersionRecord[]>();

  async save(record: ExperienceIntentVersionRecord): Promise<void> {
    if (this.#byId.has(record.intentVersionId)) {
      throw revisionConflict();
    }
    const chain = this.#chainOf(record.tenantId, record.intentId);
    const latest = chain[chain.length - 1];
    if (record.versionNumber !== (latest?.versionNumber ?? 0) + 1) {
      throw chainConflict();
    }
    const copy = frozenCopy(record);
    this.#byId.set(record.intentVersionId, copy);
    chain.push(copy);
  }

  async findById(
    tenantId: TenantId,
    intentVersionId: ExperienceIntentVersionId,
  ): Promise<ExperienceIntentVersionRecord | undefined> {
    const record = this.#byId.get(intentVersionId);
    return record !== undefined && record.tenantId === tenantId ? record : undefined;
  }

  async listForIntent(
    tenantId: TenantId,
    intentId: ExperienceIntentId,
  ): Promise<readonly ExperienceIntentVersionRecord[]> {
    return Object.freeze([...this.#chainOf(tenantId, intentId)]);
  }

  #chainOf(tenantId: TenantId, intentId: ExperienceIntentId): ExperienceIntentVersionRecord[] {
    const key = `${tenantId}/${intentId}`;
    let chain = this.#byIntent.get(key);
    if (chain === undefined) {
      chain = [];
      this.#byIntent.set(key, chain);
    }
    return chain;
  }
}
