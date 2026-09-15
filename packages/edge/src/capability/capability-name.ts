/**
 * Closed edge capability-name vocabulary (RL-040, spec/architecture.md §7,
 * RL-LOCK-011).
 *
 * The set is CLOSED and exactly mirrors spec/architecture.md §7 (plus the
 * eSIM split named by spec/work-items.md and spec/mobile.md). New names may
 * only be added when a spec file names them, via an additive contract change
 * (RL-LOCK-017). Anything outside this vocabulary is rejected by the parser -
 * an unknown capability name is a contract violation, never a silent pass.
 *
 * A capability NAME says nothing about availability on any given device:
 * availability is only ever declared with platform evidence in a
 * {@link ./capability-snapshot.js.EdgeCapabilitySnapshot} (RL-LOCK-011).
 */
import { ValidationError } from "@roamlink/contracts";

export const EDGE_CAPABILITY_NAMES = [
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

export type EdgeCapabilityName = (typeof EDGE_CAPABILITY_NAMES)[number];

export const EDGE_CAPABILITY_NAME_DESCRIPTIONS: Readonly<Record<EdgeCapabilityName, string>> =
  Object.freeze({
    wifi_observation:
      "Observe Wi-Fi interfaces, networks and signal/quality metrics as allowed by the OS.",
    wifi_control: "Join/forget/configure Wi-Fi networks where the platform allows.",
    cellular_data_sim_selection:
      "Select the active cellular data SIM where the platform and carrier privileges allow.",
    esim_profile_install:
      "Install an eSIM profile (user/carrier-consented, platform-gated).",
    esim_profile_remove: "Remove an installed eSIM profile.",
    esim_profile_enable: "Enable or disable an installed eSIM profile.",
    active_interface_selection:
      "Prefer or pin the active network interface where the platform allows.",
    vpn_network_extension: "Operate a VPN/network extension where the platform allows.",
    concurrent_interface_constraints:
      "Platform constraints on simultaneous interface use (e.g. dual connectivity support).",
    radio_os_telemetry:
      "Radio/OS telemetry (signal, radio technology, usage) as exposed by the platform.",
    background_execution_limits:
      "Background execution budget/limits imposed by the OS.",
  });

export function isEdgeCapabilityName(value: unknown): value is EdgeCapabilityName {
  return (
    typeof value === "string" && (EDGE_CAPABILITY_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Parses a capability name. Throws a ValidationError for anything outside the
 * closed vocabulary (the offending value is never echoed - RL-LOCK-016).
 */
export function parseEdgeCapabilityName(value: unknown): EdgeCapabilityName {
  if (!isEdgeCapabilityName(value)) {
    throw new ValidationError(
      "value is not a member of the closed edge capability vocabulary (wifi_observation, wifi_control, cellular_data_sim_selection, esim_profile_install, esim_profile_remove, esim_profile_enable, active_interface_selection, vpn_network_extension, concurrent_interface_constraints, radio_os_telemetry, background_execution_limits)",
      {
        reason: "EDGE_CAPABILITY_INVALID",
        details: [{ path: "EdgeCapabilityName", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

export function describeEdgeCapability(name: EdgeCapabilityName): string {
  return EDGE_CAPABILITY_NAME_DESCRIPTIONS[name];
}
