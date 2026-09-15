/**
 * Edge capability model: platform scope + evidence requirement per capability
 * (RL-040, spec/architecture.md §7, spec/mobile.md "Capability discovery").
 *
 * Each capability in the closed vocabulary carries:
 *  - a PLATFORM SCOPE: the platform families where the capability is DEFINED,
 *    i.e. where the question "is this available?" is even meaningful. Scope
 *    is a static contract map - it NEVER asserts availability on any device
 *    (that is exclusively evidence-based, RL-LOCK-011). The `other` family
 *    defers to evidence for every capability because the platform is unknown.
 *  - an EVIDENCE REQUIREMENT: the minimum Wave-0 evidence class that may
 *    support an `available` status, and whether the capability's availability
 *    story additionally involves an explicit user/MDM permission grant.
 */
import { ValidationError } from "@roamlink/contracts";

import { EDGE_CAPABILITY_NAMES, type EdgeCapabilityName } from "./capability-name.js";

export const EDGE_PLATFORM_FAMILIES = [
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
  "embedded",
  "other",
] as const;

export type EdgePlatformFamily = (typeof EDGE_PLATFORM_FAMILIES)[number];

export function isEdgePlatformFamily(value: unknown): value is EdgePlatformFamily {
  return (
    typeof value === "string" && (EDGE_PLATFORM_FAMILIES as readonly string[]).includes(value)
  );
}

export function parseEdgePlatformFamily(value: unknown): EdgePlatformFamily {
  if (!isEdgePlatformFamily(value)) {
    throw new ValidationError(
      "value is not a member of the closed edge platform-family vocabulary (ios, android, macos, windows, linux, embedded, other)",
      {
        reason: "EDGE_PLATFORM_FAMILY_INVALID",
        details: [{ path: "EdgePlatformFamily", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

/**
 * Evidence classes that may act as a MINIMUM for gating an `available`
 * capability. INFERRED, STALE and UNKNOWN are excluded categorically:
 * heuristic or absent evidence can never authorize an action (RL-LOCK-011;
 * RL-LOCK-012 keeps such interpretation advisory at most).
 */
export const CAPABILITY_EVIDENCE_MINIMUM_CLASSES = [
  "AUTHENTICATED",
  "OBSERVED",
  "REPORTED",
  "DERIVED",
] as const;

export type CapabilityEvidenceMinimumClass = (typeof CAPABILITY_EVIDENCE_MINIMUM_CLASSES)[number];

export function isCapabilityEvidenceMinimumClass(
  value: unknown,
): value is CapabilityEvidenceMinimumClass {
  return (
    typeof value === "string" &&
    (CAPABILITY_EVIDENCE_MINIMUM_CLASSES as readonly string[]).includes(value)
  );
}

export function parseCapabilityEvidenceMinimumClass(
  value: unknown,
): CapabilityEvidenceMinimumClass {
  if (!isCapabilityEvidenceMinimumClass(value)) {
    throw new ValidationError(
      "minimumEvidenceClass must be one of AUTHENTICATED, OBSERVED, REPORTED or DERIVED (INFERRED, STALE and UNKNOWN can never gate an action - RL-LOCK-011)",
      {
        reason: "EDGE_CAPABILITY_REQUIREMENT_INVALID",
        details: [
          { path: "minimumEvidenceClass", issue: "not a gating-capable evidence class" },
        ],
      },
    );
  }
  return value;
}

/** Per-capability evidence requirement. */
export interface EdgeCapabilityEvidenceRequirement {
  /** Minimum Wave-0 evidence class that may support status `available`. */
  readonly minimumClassForAvailable: CapabilityEvidenceMinimumClass;
  /**
   * True when the capability's availability story additionally requires an
   * explicit user/MDM permission grant (platforms report this as the
   * `requires-permission` snapshot status).
   */
  readonly permissionGrantRequired: boolean;
}

/** Static, frozen definition of one edge capability. */
export interface EdgeCapabilityDefinition {
  readonly name: EdgeCapabilityName;
  /** Platform families where the capability is DEFINED (never lists `other`). */
  readonly platformScope: readonly EdgePlatformFamily[];
  readonly evidenceRequirement: EdgeCapabilityEvidenceRequirement;
  readonly description: string;
}

function definition(
  name: EdgeCapabilityName,
  platformScope: readonly EdgePlatformFamily[],
  evidenceRequirement: EdgeCapabilityEvidenceRequirement,
  description: string,
): EdgeCapabilityDefinition {
  return Object.freeze({
    name,
    platformScope: Object.freeze([...platformScope]),
    evidenceRequirement: Object.freeze(evidenceRequirement),
    description,
  });
}

/**
 * The frozen capability definition registry - exactly one definition per
 * closed-vocabulary name. Values are contract metadata, NOT availability
 * claims (RL-LOCK-011).
 */
export const EDGE_CAPABILITY_DEFINITIONS: Readonly<
  Record<EdgeCapabilityName, EdgeCapabilityDefinition>
> = Object.freeze({
  wifi_observation: definition(
    "wifi_observation",
    ["ios", "android", "macos", "windows", "linux", "embedded"],
    { minimumClassForAvailable: "OBSERVED", permissionGrantRequired: true },
    "Observe Wi-Fi interfaces, networks and signal/quality metrics as allowed by the OS.",
  ),
  wifi_control: definition(
    "wifi_control",
    ["ios", "android", "macos", "windows", "linux", "embedded"],
    { minimumClassForAvailable: "OBSERVED", permissionGrantRequired: true },
    "Join/forget/configure Wi-Fi networks where the platform allows.",
  ),
  cellular_data_sim_selection: definition(
    "cellular_data_sim_selection",
    ["ios", "android", "windows", "embedded"],
    { minimumClassForAvailable: "OBSERVED", permissionGrantRequired: true },
    "Select the active cellular data SIM where the platform and carrier privileges allow.",
  ),
  esim_profile_install: definition(
    "esim_profile_install",
    ["ios", "android", "windows", "embedded"],
    { minimumClassForAvailable: "OBSERVED", permissionGrantRequired: true },
    "Install an eSIM profile (user/carrier-consented, platform-gated).",
  ),
  esim_profile_remove: definition(
    "esim_profile_remove",
    ["ios", "android", "windows", "embedded"],
    { minimumClassForAvailable: "OBSERVED", permissionGrantRequired: true },
    "Remove an installed eSIM profile.",
  ),
  esim_profile_enable: definition(
    "esim_profile_enable",
    ["ios", "android", "windows", "embedded"],
    { minimumClassForAvailable: "OBSERVED", permissionGrantRequired: true },
    "Enable or disable an installed eSIM profile.",
  ),
  active_interface_selection: definition(
    "active_interface_selection",
    ["ios", "android", "macos", "windows", "linux", "embedded"],
    { minimumClassForAvailable: "OBSERVED", permissionGrantRequired: true },
    "Prefer or pin the active network interface where the platform allows.",
  ),
  vpn_network_extension: definition(
    "vpn_network_extension",
    ["ios", "android", "macos", "windows", "linux"],
    { minimumClassForAvailable: "OBSERVED", permissionGrantRequired: true },
    "Operate a VPN/network extension where the platform allows.",
  ),
  concurrent_interface_constraints: definition(
    "concurrent_interface_constraints",
    ["ios", "android", "embedded"],
    { minimumClassForAvailable: "REPORTED", permissionGrantRequired: false },
    "Platform constraints on simultaneous interface use (e.g. dual connectivity support).",
  ),
  radio_os_telemetry: definition(
    "radio_os_telemetry",
    ["ios", "android", "embedded"],
    { minimumClassForAvailable: "OBSERVED", permissionGrantRequired: false },
    "Radio/OS telemetry (signal, radio technology, usage) as exposed by the platform.",
  ),
  background_execution_limits: definition(
    "background_execution_limits",
    ["ios", "android", "macos", "windows", "linux"],
    { minimumClassForAvailable: "OBSERVED", permissionGrantRequired: false },
    "Background execution budget/limits imposed by the OS.",
  ),
});

export function edgeCapabilityDefinition(name: EdgeCapabilityName): EdgeCapabilityDefinition {
  return EDGE_CAPABILITY_DEFINITIONS[name];
}

/**
 * Whether a capability is IN SCOPE for a platform family (i.e. the capability
 * question is defined there). The `other` family defers entirely to evidence:
 * every capability is in scope because nothing may be assumed about an
 * unknown platform (RL-LOCK-011).
 */
export function isEdgeCapabilityInScope(
  name: EdgeCapabilityName,
  family: EdgePlatformFamily,
): boolean {
  if (family === "other") return true;
  return EDGE_CAPABILITY_DEFINITIONS[name].platformScope.includes(family);
}

/** All capability names in scope for a platform family (closed-vocabulary order). */
export function edgeCapabilitiesInScope(
  family: EdgePlatformFamily,
): readonly EdgeCapabilityName[] {
  return EDGE_CAPABILITY_NAMES.filter((name) => isEdgeCapabilityInScope(name, family));
}
