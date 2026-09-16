/**
 * Device context snapshot (RL-010, spec/mobile.md "Device privacy").
 *
 * The immutable, privacy-classified, minimized record of what a device's
 * CONTEXT was at an instant: coarse location, (consent-gated) fine location,
 * minimized network observations and battery state. Every payload field
 * carries an explicit privacy classification; raw network identifiers are
 * never stored (only counts and bounded, non-reversible digests).
 *
 * Consent gate: fine location may be present ONLY when explicit consent is
 * recorded on the snapshot (`consent.fineLocationGranted === true`).
 *
 * Minimization: unknown payload fields are rejected (fail-closed); an EMPTY
 * payload is valid - "nothing observed" is honest data. The record carries a
 * per-device monotonic sequence for chain continuity, like the capability
 * snapshot.
 */
import {
  ValidationError,
  parseContractVersion,
  parseDeviceContextSnapshotId,
  parseDeviceId,
  parseOrganizationId,
  parseRevision,
  parseUserId,
  parseUtcInstant,
  tenantIdFromOrganization,
  tenantIdFromUser,
  type ContractVersion,
  type DeviceContextSnapshotId,
  type DeviceId,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import {
  describeDomainExperienceVersionExpectation,
  isDomainExperienceRecordVersionCompatible,
} from "../version.js";

/** The closed privacy-classification vocabulary. */
export const PRIVACY_CLASSIFICATIONS = ["public", "sensitive", "restricted"] as const;
export type PrivacyClassification = (typeof PRIVACY_CLASSIFICATIONS)[number];

export function isPrivacyClassification(value: unknown): value is PrivacyClassification {
  return (
    typeof value === "string" && (PRIVACY_CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

/**
 * The frozen field -> classification map (spec/mobile.md: location and
 * network identifiers receive stricter retention and access controls).
 */
export const CONTEXT_FIELD_PRIVACY_CLASSIFICATIONS: Readonly<
  Record<ContextPayloadField, PrivacyClassification>
> = Object.freeze({
  coarseLocation: "sensitive",
  fineLocation: "restricted",
  network: "sensitive",
  battery: "public",
});

export type ContextPayloadField = "coarseLocation" | "fineLocation" | "network" | "battery";

/** Coarse location: country-level only (never coordinates). */
export interface CoarseLocation {
  readonly countryCode: string;
}

/** Fine location: coordinates, RESTRICTED classification, consent-gated. */
export interface FineLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters?: number;
}

/** Minimized network observations: counts and bounded digests, no SSIDs. */
export interface NetworkContext {
  readonly visibleWifiNetworkCount?: number;
  readonly wifiNetworkNameDigest?: string;
  readonly cellularRadio?: string;
  readonly vpnActive?: boolean;
}

/** Battery state (public classification). */
export interface BatteryContext {
  readonly levelPercent: number;
  readonly charging?: boolean;
}

/** The minimized context payload (all fields optional; empty is valid). */
export interface DeviceContextPayload {
  readonly coarseLocation?: CoarseLocation;
  readonly fineLocation?: FineLocation;
  readonly network?: NetworkContext;
  readonly battery?: BatteryContext;
}

/** Serialized (plain) form of a device context snapshot. */
export interface DeviceContextSnapshotPlain {
  readonly snapshotId: DeviceContextSnapshotId;
  readonly contractVersion: ContractVersion;
  readonly sequence: Revision;
  readonly deviceId: DeviceId;
  readonly tenantId: TenantId;
  readonly observedAt: UtcInstant;
  readonly freshUntil: UtcInstant | null;
  /** Explicit consent record: fine location requires a true grant. */
  readonly consent: { readonly fineLocationGranted: boolean };
  readonly payload: DeviceContextPayload;
}

/** Input accepted by the {@link DeviceContextSnapshot} constructor. */
export interface DeviceContextSnapshotInput {
  readonly snapshotId: string;
  readonly contractVersion: string;
  readonly sequence: number;
  readonly deviceId: string;
  readonly ownerUserId?: string;
  readonly owningOrganizationId?: string;
  readonly observedAt: string;
  readonly freshUntil: string | null;
  readonly consent: { readonly fineLocationGranted?: boolean };
  readonly payload: Record<string, unknown>;
}

const ALLOWED_INPUT_FIELDS = new Set([
  "snapshotId",
  "contractVersion",
  "sequence",
  "deviceId",
  "ownerUserId",
  "owningOrganizationId",
  "observedAt",
  "freshUntil",
  "consent",
  "payload",
]);

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const RADIO_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DIGEST_LABEL_PATTERN = /^[0-9a-f]{16,128}$/;

function field(label: string, issue: string): never {
  throw new ValidationError(`DeviceContextSnapshot rejected: ${label} - ${issue}`, {
    reason: "DEVICE_CONTEXT_SNAPSHOT_INVALID",
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

function parseBoundedNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    field(label, `must be a finite number within [${min}, ${max}]`);
  }
  return value;
}

/** The immutable device context snapshot. */
export class DeviceContextSnapshot {
  readonly snapshotId: DeviceContextSnapshotId;
  readonly contractVersion: ContractVersion;
  readonly sequence: Revision;
  readonly deviceId: DeviceId;
  readonly tenantId: TenantId;
  readonly observedAt: UtcInstant;
  readonly freshUntil: UtcInstant | null;
  readonly consent: { readonly fineLocationGranted: boolean };
  readonly payload: DeviceContextPayload;

  constructor(input: DeviceContextSnapshotInput) {
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
      () => parseDeviceContextSnapshotId(input.snapshotId),
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

    // The tenant namespace is derived from the device ownership (mirrors the
    // Device aggregate rules: organization boundary wins when both present).
    if (input.owningOrganizationId !== undefined) {
      const organizationId = parseField(
        "owningOrganizationId",
        "must be a canonical lowercase UUID when present",
        () => parseOrganizationId(input.owningOrganizationId),
      );
      this.tenantId = tenantIdFromOrganization(organizationId);
    } else if (input.ownerUserId !== undefined) {
      const ownerUserId = parseField(
        "ownerUserId",
        "must be a canonical lowercase UUID when present",
        () => parseUserId(input.ownerUserId),
      );
      this.tenantId = tenantIdFromUser(ownerUserId);
    } else {
      field("ownerUserId/owningOrganizationId", "one ownership reference is required");
    }

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

    const consent = input.consent ?? {};
    if (consent === null || typeof consent !== "object" || Array.isArray(consent)) {
      field("consent", "must be an object with fineLocationGranted");
    }
    const fineLocationGranted = consent.fineLocationGranted === true;
    this.consent = Object.freeze({ fineLocationGranted });

    const payload = input.payload ?? {};
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      field("payload", "must be an object (empty is valid: nothing observed)");
    }
    for (const key of Object.keys(payload)) {
      if (!(key in CONTEXT_FIELD_PRIVACY_CLASSIFICATIONS)) {
        field(`payload.${key}`, "unknown field (minimization: the payload vocabulary is closed)");
      }
    }

    const parsed: {
      coarseLocation?: CoarseLocation;
      fineLocation?: FineLocation;
      network?: NetworkContext;
      battery?: BatteryContext;
    } = {};
    const coarse = payload["coarseLocation"];
    if (coarse !== undefined) {
      const record = coarse as Record<string, unknown>;
      if (record === null || typeof record !== "object" || Object.keys(record).length !== 1) {
        field("payload.coarseLocation", "must be an object with exactly countryCode");
      }
      const countryCode = record["countryCode"];
      if (typeof countryCode !== "string" || !COUNTRY_CODE_PATTERN.test(countryCode)) {
        field("payload.coarseLocation.countryCode", "must be an ISO 3166-1 alpha-2 code (uppercase)");
      }
      parsed.coarseLocation = Object.freeze({ countryCode });
    }

    const fine = payload["fineLocation"];
    if (fine !== undefined) {
      if (!fineLocationGranted) {
        field(
          "payload.fineLocation",
          "fine location is consent-gated: the snapshot must record an explicit fine-location consent grant to carry it",
        );
      }
      const record = fine as Record<string, unknown>;
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        field("payload.fineLocation", "must be an object with latitude, longitude and optional accuracyMeters");
      }
      for (const key of Object.keys(record)) {
        if (!["latitude", "longitude", "accuracyMeters"].includes(key)) {
          field(`payload.fineLocation.${key}`, "unknown field (minimization)");
        }
      }
      parsed.fineLocation = Object.freeze({
        latitude: parseBoundedNumber(record["latitude"], "payload.fineLocation.latitude", -90, 90),
        longitude: parseBoundedNumber(record["longitude"], "payload.fineLocation.longitude", -180, 180),
        ...(record["accuracyMeters"] !== undefined
          ? {
              accuracyMeters: parseBoundedNumber(
                record["accuracyMeters"],
                "payload.fineLocation.accuracyMeters",
                0.01,
                100_000,
              ),
            }
          : {}),
      });
    }

    const network = payload["network"];
    if (network !== undefined) {
      const record = network as Record<string, unknown>;
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        field("payload.network", "must be an object of minimized network observations");
      }
      for (const key of Object.keys(record)) {
        if (
          !["visibleWifiNetworkCount", "wifiNetworkNameDigest", "cellularRadio", "vpnActive"].includes(
            key,
          )
        ) {
          field(`payload.network.${key}`, "unknown field (minimization)");
        }
      }
      const wifiCount = record["visibleWifiNetworkCount"];
      if (wifiCount !== undefined && (typeof wifiCount !== "number" || !Number.isInteger(wifiCount) || wifiCount < 0)) {
        field("payload.network.visibleWifiNetworkCount", "must be a non-negative integer");
      }
      const wifiDigest = record["wifiNetworkNameDigest"];
      if (
        wifiDigest !== undefined &&
        (typeof wifiDigest !== "string" || !DIGEST_LABEL_PATTERN.test(wifiDigest))
      ) {
        field(
          "payload.network.wifiNetworkNameDigest",
          "must be a bounded lowercase hex digest (raw network identifiers are never stored)",
        );
      }
      const cellularRadio = record["cellularRadio"];
      if (cellularRadio !== undefined && (typeof cellularRadio !== "string" || !RADIO_PATTERN.test(cellularRadio))) {
        field("payload.network.cellularRadio", "must be a short lowercase radio label (e.g. 'lte', 'nr')");
      }
      const vpnActive = record["vpnActive"];
      if (vpnActive !== undefined && typeof vpnActive !== "boolean") {
        field("payload.network.vpnActive", "must be a boolean when present");
      }
      parsed.network = Object.freeze({
        ...(wifiCount !== undefined ? { visibleWifiNetworkCount: wifiCount } : {}),
        ...(wifiDigest !== undefined ? { wifiNetworkNameDigest: wifiDigest } : {}),
        ...(cellularRadio !== undefined ? { cellularRadio } : {}),
        ...(vpnActive !== undefined ? { vpnActive } : {}),
      });
    }

    const battery = payload["battery"];
    if (battery !== undefined) {
      const record = battery as Record<string, unknown>;
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        field("payload.battery", "must be an object with levelPercent and optional charging");
      }
      for (const key of Object.keys(record)) {
        if (!["levelPercent", "charging"].includes(key)) {
          field(`payload.battery.${key}`, "unknown field (minimization)");
        }
      }
      const charging = record["charging"];
      if (charging !== undefined && typeof charging !== "boolean") {
        field("payload.battery.charging", "must be a boolean when present");
      }
      parsed.battery = Object.freeze({
        levelPercent: parseBoundedNumber(record["levelPercent"], "payload.battery.levelPercent", 0, 100),
        ...(charging !== undefined ? { charging } : {}),
      });
    }

    this.payload = Object.freeze(parsed);
    Object.freeze(this);
  }

  /** Chain continuity: this snapshot directly succeeds `previous`. */
  succeeds(previous: DeviceContextSnapshot): boolean {
    return this.deviceId === previous.deviceId && this.sequence === previous.sequence + 1;
  }

  /** The classification of a payload field (frozen map). */
  classificationOf(field: ContextPayloadField): PrivacyClassification {
    return CONTEXT_FIELD_PRIVACY_CLASSIFICATIONS[field];
  }

  toPlain(): DeviceContextSnapshotPlain {
    return Object.freeze({
      snapshotId: this.snapshotId,
      contractVersion: this.contractVersion,
      sequence: this.sequence,
      deviceId: this.deviceId,
      tenantId: this.tenantId,
      observedAt: this.observedAt,
      freshUntil: this.freshUntil,
      consent: this.consent,
      payload: this.payload,
    });
  }
}
