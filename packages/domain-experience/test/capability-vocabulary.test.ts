/**
 * RL-010 drift guards (RL-LOCK-018): the closed capability vocabulary MUST
 * mirror spec/architecture.md §7 verbatim (bullet by bullet) and MUST carry
 * the same eleven names as the edge package's EDGE_CAPABILITY_NAMES.
 *
 * The guard is designed to FAIL: a mutated vocabulary, a changed spec
 * section or a drifted edge list breaks this file. The self-proof test
 * demonstrates the guard can fail.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEVICE_CAPABILITY_NAMES,
  isDeviceCapabilityName,
  parseDeviceCapabilityName,
} from "../src/index.js";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SPEC_PATH = join(REPO_ROOT, "spec", "architecture.md");
const EDGE_SOURCE_PATH = join(
  REPO_ROOT,
  "packages",
  "edge",
  "src",
  "capability",
  "capability-name.ts",
);

/** The §7 spec bullets, verbatim, mapped to the vocabulary names they define. */
const SPEC_SECTION7_BULLETS: ReadonlyArray<{ readonly bullet: string; readonly names: string[] }> = [
  { bullet: "- Wi-Fi observation/control;", names: ["wifi_observation", "wifi_control"] },
  {
    bullet: "- cellular data-SIM selection;",
    names: ["cellular_data_sim_selection"],
  },
  {
    bullet: "- eSIM profile installation/removal/enablement;",
    names: ["esim_profile_install", "esim_profile_remove", "esim_profile_enable"],
  },
  { bullet: "- active interface selection;", names: ["active_interface_selection"] },
  { bullet: "- VPN/network-extension operation;", names: ["vpn_network_extension"] },
  {
    bullet: "- concurrent-interface constraints;",
    names: ["concurrent_interface_constraints"],
  },
  { bullet: "- radio/OS telemetry;", names: ["radio_os_telemetry"] },
  { bullet: "- background execution limits.", names: ["background_execution_limits"] },
];

/** Extracts §7 from the architecture spec (between the §7 and §8 headings). */
function specSection7(): string {
  const text = readFileSync(SPEC_PATH, "utf8");
  const start = text.indexOf("## 7. Device capability boundary");
  const end = text.indexOf("## 8. Enterprise deployment model");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("spec/architecture.md §7 section could not be located (spec drift?)");
  }
  return text.slice(start, end);
}

/** Extracts the EDGE_CAPABILITY_NAMES entries from the edge source text. */
function edgeCapabilityNames(): string[] {
  const text = readFileSync(EDGE_SOURCE_PATH, "utf8");
  const match = /export const EDGE_CAPABILITY_NAMES = \[([\s\S]*?)\] as const;/.exec(text);
  if (match === null || match[1] === undefined) {
    throw new Error("EDGE_CAPABILITY_NAMES could not be located in the edge source (drift?)");
  }
  return [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
}

/** The guard itself: does `names` cover the §7 spec bullets exactly? */
function vocabularyCoversSpec(names: readonly string[]): boolean {
  const specNames = SPEC_SECTION7_BULLETS.flatMap((entry) => entry.names);
  const set = new Set(names);
  return (
    names.length === specNames.length &&
    specNames.every((name) => set.has(name)) &&
    new Set(names).size === names.length
  );
}

describe("closed capability vocabulary (RL-010, spec §7)", () => {
  it("spec/architecture.md §7 still contains every bullet the vocabulary is derived from (verbatim)", () => {
    const section = specSection7();
    for (const { bullet } of SPEC_SECTION7_BULLETS) {
      expect(section).toContain(bullet);
    }
  });

  it("the vocabulary covers exactly the §7-derived names (drift guard)", () => {
    expect([...DEVICE_CAPABILITY_NAMES]).toHaveLength(11);
    expect(vocabularyCoversSpec(DEVICE_CAPABILITY_NAMES)).toBe(true);
  });

  it("cross-check: the edge package's EDGE_CAPABILITY_NAMES carries the SAME eleven names (no import)", () => {
    const edgeNames = edgeCapabilityNames();
    expect(edgeNames).toHaveLength(11);
    expect([...edgeNames].sort()).toEqual([...DEVICE_CAPABILITY_NAMES].sort());
  });

  it("SELF-PROOF: the guard FAILS on mutated vocabularies (missing, extra, duplicated)", () => {
    const names = [...DEVICE_CAPABILITY_NAMES];
    const missing = names.slice(1); // drop wifi_observation
    expect(vocabularyCoversSpec(missing)).toBe(false);
    const extra = [...names, "teleportation"];
    expect(vocabularyCoversSpec(extra)).toBe(false);
    const duplicated = [...names.filter((n) => n !== "wifi_observation"), "wifi_control"];
    expect(duplicated).toHaveLength(11);
    expect(vocabularyCoversSpec(duplicated)).toBe(false);
  });

  it("the parser accepts every member and rejects outsiders without echoing them", () => {
    for (const name of DEVICE_CAPABILITY_NAMES) {
      expect(parseDeviceCapabilityName(name)).toBe(name);
      expect(isDeviceCapabilityName(name)).toBe(true);
    }
    for (const bad of ["wifi", "teleportation", "WIFI_OBSERVATION", "", 42, null]) {
      expect(isDeviceCapabilityName(bad)).toBe(false);
      expect(() => parseDeviceCapabilityName(bad)).toThrowError(/closed device capability vocabulary/);
    }
    try {
      parseDeviceCapabilityName("secret-capability-name");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-capability-name");
    }
  });
});
