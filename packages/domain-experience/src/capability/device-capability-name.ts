/**
 * Closed device capability-name vocabulary for the EXPERIENCE domain
 * (RL-010, spec/architecture.md §7, RL-LOCK-011).
 *
 * DEFINED INSIDE domain-experience on purpose: the edge package owns the
 * edge-side vocabulary (@roamlink/edge, RL-040) and the dependency graph
 * forbids experience -> edge imports; `packages/contracts` is frozen for the
 * foundation. The two vocabularies carry the SAME eleven names so a Wave-2
 * projection from edge's `EdgeCapabilitySnapshot` to the registry's
 * `DeviceCapabilitySnapshot` is a PURE STRUCTURAL MAPPING (field-for-field,
 * no semantic translation).
 *
 * The set is CLOSED and mirrors spec/architecture.md §7 (plus the eSIM split
 * named by spec/work-items.md and spec/mobile.md). Anything outside the
 * vocabulary is rejected by the parser - never a silent pass. A capability
 * NAME says nothing about availability: availability is only ever declared
 * with evidence in a DeviceCapabilitySnapshot (RL-LOCK-011).
 *
 * A spec-verbatim drift-guard test (test/capability-vocabulary.test.ts)
 * cross-checks this list against spec/architecture.md §7 AND against the
 * edge source file text, so drift on either side fails CI.
 */
import { ValidationError } from "@roamlink/contracts";

export const DEVICE_CAPABILITY_NAMES = [
  "wifi_observation",
  "wifi_control",
  "cellular_data_sim_selection",
  "esim_profile_install",
  "esim_profile_remove",
  "esim_profile_enable",
  "active_interface_selection",
  "vpn_network_extension",
  "concurrent_interface_constraints",
  "radio_os_telemetry",
  "background_execution_limits",
] as const;

export type DeviceCapabilityName = (typeof DEVICE_CAPABILITY_NAMES)[number];

export const DEVICE_CAPABILITY_NAME_DESCRIPTIONS: Readonly<Record<DeviceCapabilityName, string>> =
  Object.freeze({
    wifi_observation:
      "Observe Wi-Fi interfaces, networks and signal/quality metrics as allowed by the OS.",
    wifi_control: "Join/forget/configure Wi-Fi networks where the platform allows.",
    cellular_data_sim_selection:
      "Select the active cellular data SIM where the platform and carrier privileges allow.",
    esim_profile_install: "Install an eSIM profile (user/carrier-consented, platform-gated).",
    esim_profile_remove: "Remove an installed eSIM profile.",
    esim_profile_enable: "Enable or disable an installed eSIM profile.",
    active_interface_selection:
      "Prefer or pin the active network interface where the platform allows.",
    vpn_network_extension: "Operate a VPN/network extension where the platform allows.",
    concurrent_interface_constraints:
      "Platform constraints on simultaneous interface use (e.g. dual connectivity support).",
    radio_os_telemetry:
      "Radio/OS telemetry (signal, radio technology, usage) as exposed by the platform.",
    background_execution_limits: "Background execution budget/limits imposed by the OS.",
  });

export function isDeviceCapabilityName(value: unknown): value is DeviceCapabilityName {
  return (
    typeof value === "string" && (DEVICE_CAPABILITY_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Parses a capability name. Throws a ValidationError for anything outside the
 * closed vocabulary (the offending value is never echoed - RL-LOCK-016).
 */
export function parseDeviceCapabilityName(value: unknown): DeviceCapabilityName {
  if (!isDeviceCapabilityName(value)) {
    throw new ValidationError(
      "value is not a member of the closed device capability vocabulary (wifi_observation, wifi_control, cellular_data_sim_selection, esim_profile_install, esim_profile_remove, esim_profile_enable, active_interface_selection, vpn_network_extension, concurrent_interface_constraints, radio_os_telemetry, background_execution_limits)",
      {
        reason: "DEVICE_CAPABILITY_INVALID",
        details: [{ path: "DeviceCapabilityName", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

export function describeDeviceCapability(name: DeviceCapabilityName): string {
  return DEVICE_CAPABILITY_NAME_DESCRIPTIONS[name];
}
