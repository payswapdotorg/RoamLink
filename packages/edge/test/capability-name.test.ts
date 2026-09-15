import { describe, expect, it } from "vitest";
import {
  EDGE_CAPABILITY_NAME_DESCRIPTIONS,
  EDGE_CAPABILITY_NAMES,
  describeEdgeCapability,
  isEdgeCapabilityName,
  parseEdgeCapabilityName,
} from "../src/index.js";

/** The closed vocabulary exactly mirrors spec/architecture.md §7. */
const SPEC_SECTION_7_VOCABULARY = [
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

describe("closed capability-name vocabulary (RL-040, RL-LOCK-011)", () => {
  it("matches spec/architecture.md §7 exactly (no invented names)", () => {
    expect([...EDGE_CAPABILITY_NAMES]).toEqual([...SPEC_SECTION_7_VOCABULARY]);
  });

  it("parses every member of the closed vocabulary", () => {
    for (const name of EDGE_CAPABILITY_NAMES) {
      expect(parseEdgeCapabilityName(name)).toBe(name);
      expect(isEdgeCapabilityName(name)).toBe(true);
    }
  });

  it("parse-rejects unknown names without echoing the value", () => {
    for (const bad of [
      "wifi_super_control",
      "esim_profile_download",
      "",
      "WIFI_OBSERVATION",
      "wifi-observation",
      42,
      null,
      undefined,
      {},
    ]) {
      expect(() => parseEdgeCapabilityName(bad)).toThrowError(/closed edge capability vocabulary/);
      expect(isEdgeCapabilityName(bad)).toBe(false);
    }
  });

  it("the rejection error never contains the offending value (RL-LOCK-016)", () => {
    try {
      parseEdgeCapabilityName("super-secret-capability-name");
      expect.unreachable("parse must throw");
    } catch (error) {
      expect((error as Error).message).not.toContain("super-secret-capability-name");
    }
  });

  it("every name has a description and describeEdgeCapability resolves it", () => {
    for (const name of EDGE_CAPABILITY_NAMES) {
      expect(EDGE_CAPABILITY_NAME_DESCRIPTIONS[name].length).toBeGreaterThan(10);
      expect(describeEdgeCapability(name)).toBe(EDGE_CAPABILITY_NAME_DESCRIPTIONS[name]);
    }
  });
});
