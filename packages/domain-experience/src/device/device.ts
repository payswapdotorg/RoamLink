/**
 * Device aggregate (RL-010, spec/data-model.md).
 *
 * Lifecycle: enrolled -> active <-> suspended -> retired (retired is
 * terminal; a device may retire from enrolled or suspended without ever
 * being active). Ownership is by a user and/or an organization - at least
 * one must be present; when both are present the ORGANIZATION tenant is the
 * governing boundary (enterprise devices, spec/architecture.md §8).
 *
 * No ADCOS field exists on this aggregate (RL-LOCK-003/007): the device is
 * a RoamLink experience-domain entity; ADCOS never sees it directly.
 *
 * Immutable record semantics: transitions return NEW frozen instances with
 * the revision bumped for optimistic concurrency.
 */
import {
  ValidationError,
  parseDeviceId,
  parseOrganizationId,
  parseRevision,
  parseUserId,
  parseUtcInstant,
  tenantIdFromOrganization,
  tenantIdFromUser,
  type DeviceId,
  type OrganizationId,
  type Revision,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";

import {
  parseDeviceModelLabel,
  parseDevicePlatformFamily,
  parsePlatformVersionLabel,
  type DevicePlatformDescriptor,
} from "./platform.js";

export const DEVICE_STATUSES = ["enrolled", "active", "suspended", "retired"] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export function isDeviceStatus(value: unknown): value is DeviceStatus {
  return typeof value === "string" && (DEVICE_STATUSES as readonly string[]).includes(value);
}

/** Ownership: by a user and/or an organization (at least one required). */
export interface DeviceOwnership {
  readonly owningUserId?: UserId;
  readonly owningOrganizationId?: OrganizationId;
}

/** Serialized (plain) form of a device record. */
export interface DeviceRecord {
  readonly tenantId: TenantId;
  readonly deviceId: DeviceId;
  readonly owningUserId?: UserId;
  readonly owningOrganizationId?: OrganizationId;
  readonly platform: DevicePlatformDescriptor;
  readonly status: DeviceStatus;
  readonly enrolledAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
}

/** Input accepted by the {@link Device} constructor. */
export interface DeviceInput {
  readonly deviceId: string;
  readonly owningUserId?: string;
  readonly owningOrganizationId?: string;
  readonly platform: {
    readonly family: string;
    readonly platformVersion: string;
    readonly model?: string;
  };
  readonly status: string;
  readonly enrolledAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "deviceId",
  "owningUserId",
  "owningOrganizationId",
  "platform",
  "status",
  "enrolledAt",
  "updatedAt",
  "revision",
]);

const ALLOWED_PLATFORM_FIELDS = new Set(["family", "platformVersion", "model"]);

function field(label: string, issue: string): never {
  throw new ValidationError(`Device rejected: ${label} - ${issue}`, {
    reason: "DEVICE_INVALID",
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

/** The tenant of a device: organization boundary when org-owned, else user. */
export function tenantOfDeviceOwnership(ownership: DeviceOwnership): TenantId {
  return ownership.owningOrganizationId !== undefined
    ? tenantIdFromOrganization(ownership.owningOrganizationId)
    : tenantIdFromUser(ownership.owningUserId as UserId);
}

/**
 * The Device aggregate. Deeply frozen; transitions return new instances.
 */
export class Device {
  readonly tenantId: TenantId;
  readonly deviceId: DeviceId;
  declare readonly owningUserId?: UserId;
  declare readonly owningOrganizationId?: OrganizationId;
  readonly platform: DevicePlatformDescriptor;
  readonly status: DeviceStatus;
  readonly enrolledAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;

  constructor(input: DeviceInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      field("$", "input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        field(key, "unknown field (fail-closed, RL-LOCK-017)");
      }
    }
    this.deviceId = parseField("deviceId", "must be a canonical lowercase UUID", () =>
      parseDeviceId(input.deviceId),
    );

    const hasUser = input.owningUserId !== undefined;
    const hasOrg = input.owningOrganizationId !== undefined;
    if (!hasUser && !hasOrg) {
      field("owningUserId/owningOrganizationId", "at least one owner is required");
    }
    if (hasUser) {
      this.owningUserId = parseField(
        "owningUserId",
        "must be a canonical lowercase UUID when present",
        () => parseUserId(input.owningUserId),
      );
    }
    if (hasOrg) {
      this.owningOrganizationId = parseField(
        "owningOrganizationId",
        "must be a canonical lowercase UUID when present",
        () => parseOrganizationId(input.owningOrganizationId),
      );
    }
    this.tenantId = tenantOfDeviceOwnership({
      ...(this.owningUserId !== undefined ? { owningUserId: this.owningUserId } : {}),
      ...(this.owningOrganizationId !== undefined
        ? { owningOrganizationId: this.owningOrganizationId }
        : {}),
    });

    const platform = input.platform;
    if (platform === null || typeof platform !== "object" || Array.isArray(platform)) {
      field("platform", "must be an object with family, platformVersion and optional model");
    }
    for (const key of Object.keys(platform)) {
      if (!ALLOWED_PLATFORM_FIELDS.has(key)) {
        field(`platform.${key}`, "unknown field (fail-closed, RL-LOCK-017)");
      }
    }
    this.platform = Object.freeze({
      family: parseField("platform.family", "must be a member of the platform-family vocabulary", () =>
        parseDevicePlatformFamily(platform.family),
      ),
      platformVersion: parsePlatformVersionLabel(platform.platformVersion),
      ...(platform.model !== undefined ? { model: parseDeviceModelLabel(platform.model) } : {}),
    });

    if (!isDeviceStatus(input.status)) {
      field("status", "must be enrolled, active, suspended or retired");
    }
    this.status = input.status;
    this.enrolledAt = parseField(
      "enrolledAt",
      "must be a UTC instant with a zone designator",
      () => parseUtcInstant(input.enrolledAt),
    );
    this.updatedAt = parseField(
      "updatedAt",
      "must be a UTC instant with a zone designator",
      () => parseUtcInstant(input.updatedAt),
    );
    this.revision = parseField(
      "revision",
      "must be a positive integer (optimistic-concurrency token)",
      () => parseRevision(input.revision),
    );
    Object.freeze(this);
  }

  /** enrolled -> active. */
  activate(at: UtcInstant): Device {
    if (this.status !== "enrolled") {
      field("status", "only an enrolled device can be activated");
    }
    return this.with({ status: "active", updatedAt: at });
  }

  /** active -> suspended (an enrolled device must activate first). */
  suspend(at: UtcInstant): Device {
    if (this.status !== "active") {
      field("status", "only an active device can be suspended");
    }
    return this.with({ status: "suspended", updatedAt: at });
  }

  /** suspended -> active. */
  reactivate(at: UtcInstant): Device {
    if (this.status !== "suspended") {
      field("status", "only a suspended device can be reactivated");
    }
    return this.with({ status: "active", updatedAt: at });
  }

  /** enrolled/active/suspended -> retired (terminal). */
  retire(at: UtcInstant): Device {
    if (this.status === "retired") {
      field("status", "a retired device is terminal and cannot transition");
    }
    return this.with({ status: "retired", updatedAt: at });
  }

  private with(overrides: { status?: DeviceStatus; updatedAt?: UtcInstant }): Device {
    return new Device({
      deviceId: this.deviceId,
      ...(this.owningUserId !== undefined ? { owningUserId: this.owningUserId } : {}),
      ...(this.owningOrganizationId !== undefined
        ? { owningOrganizationId: this.owningOrganizationId }
        : {}),
      platform: this.platform,
      status: overrides.status ?? this.status,
      enrolledAt: this.enrolledAt,
      updatedAt: overrides.updatedAt ?? this.updatedAt,
      revision: parseRevision(this.revision + 1),
    });
  }

  toRecord(): DeviceRecord {
    return Object.freeze({
      tenantId: this.tenantId,
      deviceId: this.deviceId,
      ...(this.owningUserId !== undefined ? { owningUserId: this.owningUserId } : {}),
      ...(this.owningOrganizationId !== undefined
        ? { owningOrganizationId: this.owningOrganizationId }
        : {}),
      platform: this.platform,
      status: this.status,
      enrolledAt: this.enrolledAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
    });
  }

  static fromRecord(record: DeviceRecord): Device {
    return new Device({
      deviceId: record.deviceId,
      ...(record.owningUserId !== undefined ? { owningUserId: record.owningUserId } : {}),
      ...(record.owningOrganizationId !== undefined
        ? { owningOrganizationId: record.owningOrganizationId }
        : {}),
      platform: record.platform,
      status: record.status,
      enrolledAt: record.enrolledAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    });
  }
}
