import { describe, expect, it } from "vitest";
import {
  CAPABILITY_EVIDENCE_MINIMUM_CLASSES,
  EDGE_CAPABILITY_DEFINITIONS,
  EDGE_CAPABILITY_NAMES,
  EDGE_PLATFORM_FAMILIES,
  edgeCapabilitiesInScope,
  edgeCapabilityDefinition,
  isCapabilityEvidenceMinimumClass,
  isEdgeCapabilityInScope,
  isEdgePlatformFamily,
  parseCapabilityEvidenceMinimumClass,
  parseEdgePlatformFamily,
} from "../src/index.js";

describe("closed platform-family vocabulary", () => {
  it("parses every member and rejects unknown families", () => {
    for (const family of EDGE_PLATFORM_FAMILIES) {
      expect(parseEdgePlatformFamily(family)).toBe(family);
      expect(isEdgePlatformFamily(family)).toBe(true);
    }
    for (const bad of ["webos", "IOS", "", 7, null]) {
      expect(() => parseEdgePlatformFamily(bad)).toThrowError(/platform-family vocabulary/);
      expect(isEdgePlatformFamily(bad)).toBe(false);
    }
  });
});

describe("capability definitions (platform scope + evidence requirement)", () => {
  it("cover every capability name in the closed vocabulary", () => {
    expect(Object.keys(EDGE_CAPABILITY_DEFINITIONS).sort()).toEqual(
      [...EDGE_CAPABILITY_NAMES].sort(),
    );
    for (const name of EDGE_CAPABILITY_NAMES) {
      expect(edgeCapabilityDefinition(name).name).toBe(name);
    }
  });

  it("each definition declares a non-empty, valid platform scope that never lists 'other'", () => {
    for (const name of EDGE_CAPABILITY_NAMES) {
      const scope = edgeCapabilityDefinition(name).platformScope;
      expect(scope.length).toBeGreaterThan(0);
      for (const family of scope) {
        expect(EDGE_PLATFORM_FAMILIES).toContain(family);
        expect(family).not.toBe("other");
      }
    }
  });

  it("each evidence requirement uses a gating-capable minimum class and a boolean permission flag", () => {
    for (const name of EDGE_CAPABILITY_NAMES) {
      const requirement = edgeCapabilityDefinition(name).evidenceRequirement;
      expect(CAPABILITY_EVIDENCE_MINIMUM_CLASSES).toContain(
        requirement.minimumClassForAvailable,
      );
      expect(typeof requirement.permissionGrantRequired).toBe("boolean");
    }
  });

  it("definitions and requirements are frozen", () => {
    expect(Object.isFrozen(EDGE_CAPABILITY_DEFINITIONS)).toBe(true);
    for (const name of EDGE_CAPABILITY_NAMES) {
      expect(Object.isFrozen(edgeCapabilityDefinition(name))).toBe(true);
      expect(Object.isFrozen(edgeCapabilityDefinition(name).evidenceRequirement)).toBe(true);
      expect(Object.isFrozen(edgeCapabilityDefinition(name).platformScope)).toBe(true);
    }
  });
});

describe("platform scope resolution", () => {
  it("scopes capabilities per family (eSIM is defined on ios, not linux)", () => {
    expect(isEdgeCapabilityInScope("esim_profile_install", "ios")).toBe(true);
    expect(isEdgeCapabilityInScope("esim_profile_install", "android")).toBe(true);
    expect(isEdgeCapabilityInScope("esim_profile_install", "linux")).toBe(false);
    expect(isEdgeCapabilityInScope("wifi_observation", "linux")).toBe(true);
    expect(isEdgeCapabilityInScope("radio_os_telemetry", "macos")).toBe(false);
  });

  it("the 'other' family defers everything to evidence (never assumes, RL-LOCK-011)", () => {
    for (const name of EDGE_CAPABILITY_NAMES) {
      expect(isEdgeCapabilityInScope(name, "other")).toBe(true);
    }
  });

  it("edgeCapabilitiesInScope lists the full vocabulary for ios and a subset for linux", () => {
    expect(edgeCapabilitiesInScope("ios")).toHaveLength(EDGE_CAPABILITY_NAMES.length);
    const linux = edgeCapabilitiesInScope("linux");
    expect(linux).not.toContain("esim_profile_install");
    expect(linux).not.toContain("cellular_data_sim_selection");
    expect(linux).not.toContain("concurrent_interface_constraints");
    expect(linux).not.toContain("radio_os_telemetry");
    expect(linux).toContain("wifi_control");
    expect(linux).toContain("background_execution_limits");
    expect(linux).toContain("vpn_network_extension");
  });
});

describe("gating-capable minimum evidence classes", () => {
  it("accepts exactly AUTHENTICATED, OBSERVED, REPORTED, DERIVED", () => {
    for (const good of CAPABILITY_EVIDENCE_MINIMUM_CLASSES) {
      expect(isCapabilityEvidenceMinimumClass(good)).toBe(true);
      expect(parseCapabilityEvidenceMinimumClass(good)).toBe(good);
    }
    // heuristic/absent evidence can never gate an action (RL-LOCK-011/012)
    for (const bad of ["INFERRED", "STALE", "UNKNOWN", "observed", "", null]) {
      expect(isCapabilityEvidenceMinimumClass(bad)).toBe(false);
      expect(() => parseCapabilityEvidenceMinimumClass(bad)).toThrowError(
        /INFERRED, STALE and UNKNOWN can never gate/,
      );
    }
  });
});
