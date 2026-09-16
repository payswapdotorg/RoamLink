/**
 * Device registry service (RL-010): envelope-gated, idempotent, CAS-aware
 * use cases for the device lifecycle and the capability/context snapshots.
 *
 * Every mutation:
 *  1. admits the Wave-0 command envelope through the idempotency ledger
 *     (replays return the recorded outcome; key reuse with a different
 *     digest is a ConflictError - RL-LOCK-014);
 *  2. checks the {@link ExperienceAccessPolicy} (fail-closed actor -> tenant
 *     authorization at the RoamLink boundary);
 *  3. validates the envelope tenant against the record's tenant namespace
 *     (cross-tenant commands are rejected before touching state);
 *  4. writes through the tenant-scoped, chain-continuity-enforcing ports.
 */
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type CanonicalJsonValue,
  type CommandEnvelope,
  type DeviceId,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import { DeviceCapabilitySnapshot } from "./capability/device-capability-snapshot.js";
import { Device, tenantOfDeviceOwnership, type DeviceOwnership } from "./device/device.js";
import { DeviceContextSnapshot } from "./device/device-context-snapshot.js";
import type { DevicePlatformDescriptor } from "./device/platform.js";
import { admitCommand, commitCommand, type IdempotencyLedger } from "./idempotency.js";
import type {
  DeviceCapabilitySnapshotRepository,
  DeviceContextSnapshotRepository,
  DeviceRepository,
  ExperienceAccessPolicy,
} from "./ports.js";

export interface DeviceRegistryDeps {
  readonly devices: DeviceRepository;
  readonly capabilitySnapshots: DeviceCapabilitySnapshotRepository;
  readonly contextSnapshots: DeviceContextSnapshotRepository;
  readonly policy: ExperienceAccessPolicy;
  readonly ledger: IdempotencyLedger;
  readonly now: () => UtcInstant;
  /** Supplies fresh snapshot ids. */
  readonly generateSnapshotId: () => string;
}

function commandInvalid(issue: string): never {
  throw new ValidationError(`device command rejected: ${issue}`, {
    reason: "DEVICE_COMMAND_INVALID",
    details: [{ path: "envelope", issue }],
  });
}

/** Device lifecycle + snapshot use cases (all envelope-gated, idempotent). */
export class DeviceRegistryService {
  private readonly deps: DeviceRegistryDeps;

  constructor(deps: DeviceRegistryDeps) {
    this.deps = deps;
  }

  /** Enrolls a device (status `enrolled`) under the given ownership. */
  async enrollDevice(
    envelope: CommandEnvelope,
    input: {
      readonly deviceId: string;
      readonly ownership: DeviceOwnership;
      readonly platform: {
        readonly family: string;
        readonly platformVersion: string;
        readonly model?: string;
      };
    },
  ): Promise<{ readonly deviceId: string; readonly tenantId: string; readonly status: string }> {
    type Outcome = { readonly deviceId: string; readonly tenantId: string; readonly status: string };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    const tenantId = tenantOfDeviceOwnership(input.ownership);
    if (envelope.tenantId !== tenantId) {
      commandInvalid("the envelope tenant must match the device's ownership tenant");
    }
    await this.deps.policy.authorize(envelope.actorId, tenantId, "device:enroll", this.deps.now());

    const existing = await this.deps.devices.findById(tenantId, input.deviceId as DeviceId);
    if (existing !== undefined) {
      throw new ConflictError("the device id is already enrolled in this tenant", {
        reason: "DEVICE_ALREADY_ENROLLED",
      });
    }

    const at = this.deps.now();
    const device = new Device({
      deviceId: input.deviceId,
      ...(input.ownership.owningUserId !== undefined
        ? { owningUserId: input.ownership.owningUserId }
        : {}),
      ...(input.ownership.owningOrganizationId !== undefined
        ? { owningOrganizationId: input.ownership.owningOrganizationId }
        : {}),
      platform: input.platform,
      status: "enrolled",
      enrolledAt: at,
      updatedAt: at,
      revision: 1,
    });
    await this.deps.devices.save(device.toRecord());

    const outcome: CanonicalJsonValue = Object.freeze({
      deviceId: device.deviceId,
      tenantId,
      status: device.status,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  /** Applies a validated lifecycle transition (activate/suspend/reactivate/retire). */
  async transitionDevice(
    envelope: CommandEnvelope,
    input: {
      readonly deviceId: string;
      readonly transition: "activate" | "suspend" | "reactivate" | "retire";
    },
  ): Promise<{ readonly deviceId: string; readonly status: string }> {
    type Outcome = { readonly deviceId: string; readonly status: string };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    const device = await this.findDevice(envelope.tenantId, input.deviceId);
    await this.deps.policy.authorize(
      envelope.actorId,
      envelope.tenantId,
      input.transition === "retire" ? "device:retire" : "device:update",
      this.deps.now(),
    );
    const at = this.deps.now();
    const next =
      input.transition === "activate"
        ? device.activate(at)
        : input.transition === "suspend"
          ? device.suspend(at)
          : input.transition === "reactivate"
            ? device.reactivate(at)
            : device.retire(at);
    await this.deps.devices.save(next.toRecord());
    const outcome: CanonicalJsonValue = Object.freeze({
      deviceId: next.deviceId,
      status: next.status,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  /** Records an immutable capability snapshot (chain continuity enforced by the port). */
  async recordCapabilitySnapshot(
    envelope: CommandEnvelope,
    input: {
      readonly deviceId: string;
      readonly platform: { readonly family: string; readonly platformVersion: string };
      readonly observedAt: string;
      readonly freshUntil: string | null;
      readonly capabilities: Readonly<Record<string, unknown>>;
    },
  ): Promise<{ readonly snapshotId: string; readonly sequence: number }> {
    type Outcome = { readonly snapshotId: string; readonly sequence: number };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    const device = await this.findDevice(envelope.tenantId, input.deviceId);
    if (device.status === "retired") {
      throw new ConflictError("a retired device accepts no new snapshots", {
        reason: "DEVICE_RETIRED",
      });
    }
    await this.deps.policy.authorize(
      envelope.actorId,
      envelope.tenantId,
      "snapshot:record",
      this.deps.now(),
    );

    const latest = await this.deps.capabilitySnapshots.latestForDevice(
      envelope.tenantId,
      device.deviceId,
    );
    const snapshot = new DeviceCapabilitySnapshot({
      snapshotId: this.deps.generateSnapshotId(),
      contractVersion: "0.1",
      sequence: (latest?.sequence ?? 0) + 1,
      deviceId: device.deviceId,
      platform: input.platform,
      observedAt: input.observedAt,
      freshUntil: input.freshUntil,
      capabilities: input.capabilities,
    });
    await this.deps.capabilitySnapshots.save({
      ...snapshot.toPlain(),
      tenantId: envelope.tenantId,
    });

    const outcome: CanonicalJsonValue = Object.freeze({
      snapshotId: snapshot.snapshotId,
      sequence: snapshot.sequence,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  /** Records an immutable, privacy-classified context snapshot. */
  async recordContextSnapshot(
    envelope: CommandEnvelope,
    input: {
      readonly deviceId: string;
      readonly ownerUserId?: string;
      readonly owningOrganizationId?: string;
      readonly observedAt: string;
      readonly freshUntil: string | null;
      readonly consent: { readonly fineLocationGranted?: boolean };
      readonly payload: Record<string, unknown>;
    },
  ): Promise<{ readonly snapshotId: string; readonly sequence: number }> {
    type Outcome = { readonly snapshotId: string; readonly sequence: number };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    const device = await this.findDevice(envelope.tenantId, input.deviceId);
    if (device.status === "retired") {
      throw new ConflictError("a retired device accepts no new snapshots", {
        reason: "DEVICE_RETIRED",
      });
    }
    await this.deps.policy.authorize(
      envelope.actorId,
      envelope.tenantId,
      "snapshot:record",
      this.deps.now(),
    );

    const latest = await this.deps.contextSnapshots.latestForDevice(
      envelope.tenantId,
      device.deviceId,
    );
    const snapshot = new DeviceContextSnapshot({
      snapshotId: this.deps.generateSnapshotId(),
      contractVersion: "0.1",
      sequence: (latest?.sequence ?? 0) + 1,
      deviceId: device.deviceId,
      ...(input.owningOrganizationId !== undefined
        ? { owningOrganizationId: input.owningOrganizationId }
        : {}),
      ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
      observedAt: input.observedAt,
      freshUntil: input.freshUntil,
      consent: input.consent,
      payload: input.payload,
    });
    await this.deps.contextSnapshots.save(snapshot.toPlain());

    const outcome: CanonicalJsonValue = Object.freeze({
      snapshotId: snapshot.snapshotId,
      sequence: snapshot.sequence,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  // --- reads (tenant-scoped; the API layer resolves the actor) ---------------

  async getDevice(tenantId: TenantId, deviceId: string): Promise<ReturnType<Device["toRecord"]>> {
    const record = await this.deps.devices.findById(tenantId, deviceId as DeviceId);
    if (record === undefined) {
      throw new NotFoundError("device not found in the requested tenant", {
        reason: "DEVICE_NOT_FOUND",
      });
    }
    return record;
  }

  async latestCapabilitySnapshot(tenantId: TenantId, deviceId: string) {
    return this.deps.capabilitySnapshots.latestForDevice(tenantId, deviceId as DeviceId);
  }

  async latestContextSnapshot(tenantId: TenantId, deviceId: string) {
    return this.deps.contextSnapshots.latestForDevice(tenantId, deviceId as DeviceId);
  }

  private async findDevice(tenantId: TenantId, deviceId: string): Promise<Device> {
    const record = await this.deps.devices.findById(tenantId, deviceId as DeviceId);
    if (record === undefined) {
      throw new NotFoundError("device not found in the command tenant", {
        reason: "DEVICE_NOT_FOUND",
      });
    }
    return Device.fromRecord(record);
  }
}

export type { DevicePlatformDescriptor };
