/**
 * Device platform metadata vocabulary (RL-010).
 *
 * The platform-family vocabulary mirrors the edge platform families
 * (RL-040) so Wave-2 projections stay pure; it is DEFINED HERE (no edge
 * import - the dependency direction forbids it). Labels are bounded and
 * printable; platform metadata is descriptive only and never asserts
 * capability availability (RL-LOCK-011).
 */
import { ValidationError } from "@roamlink/contracts";

export const DEVICE_PLATFORM_FAMILIES = [
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
  "embedded",
  "other",
] as const;

export type DevicePlatformFamily = (typeof DEVICE_PLATFORM_FAMILIES)[number];

export function isDevicePlatformFamily(value: unknown): value is DevicePlatformFamily {
  return (
    typeof value === "string" && (DEVICE_PLATFORM_FAMILIES as readonly string[]).includes(value)
  );
}

/** Parses a platform family (closed vocabulary, no echo of the value). */
export function parseDevicePlatformFamily(value: unknown): DevicePlatformFamily {
  if (!isDevicePlatformFamily(value)) {
    throw new ValidationError(
      "value is not a member of the closed device platform-family vocabulary (ios, android, macos, windows, linux, embedded, other)",
      {
        reason: "DEVICE_PLATFORM_FAMILY_INVALID",
        details: [{ path: "DevicePlatformFamily", issue: "outside the closed vocabulary" },
        ],
      },
    );
  }
  return value;
}

export const MAX_PLATFORM_VERSION_LENGTH = 64;
export const MAX_DEVICE_MODEL_LENGTH = 64;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose of this pattern
const PRINTABLE_BOUNDED_PATTERN = /^[^\u0000-\u001f\u007f]{1,64}$/;

function parseBoundedLabel(value: unknown, label: string, reason: string): string {
  if (typeof value !== "string" || !PRINTABLE_BOUNDED_PATTERN.test(value) || value.trim().length === 0) {
    throw new ValidationError(
      `${label} must be a non-empty printable label of at most 64 characters (control characters are rejected)`,
      {
        reason,
        details: [{ path: label, issue: "not a non-empty printable bounded label" }],
      },
    );
  }
  return value;
}

/** Platform version label (bounded, printable, non-secret). */
export function parsePlatformVersionLabel(value: unknown): string {
  return parseBoundedLabel(value, "Device.platform.platformVersion", "DEVICE_PLATFORM_INVALID");
}

/** Device model label (bounded, printable, non-secret). */
export function parseDeviceModelLabel(value: unknown): string {
  return parseBoundedLabel(value, "Device.platform.model", "DEVICE_PLATFORM_INVALID");
}

/** Platform descriptor carried by devices and snapshots. */
export interface DevicePlatformDescriptor {
  readonly family: DevicePlatformFamily;
  readonly platformVersion: string;
  readonly model?: string;
}
