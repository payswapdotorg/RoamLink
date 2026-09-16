/**
 * RL-LOCK-017 conformance suite: versioned contracts.
 *
 * Public RoamLink and ADCOS integration contracts are versioned and
 * additive-change tolerant (MAJOR.MINOR: same major + newer-or-equal minor
 * is compatible; different major or older minor is not).
 *
 * GREEN PROOFS:
 *  - the Wave-0 version primitives reject malformed versions and implement
 *    the additive tolerance rule exactly;
 *  - a persisted domain record REQUIRES a contractVersion from its own
 *    contract line: a different major is rejected, and a NEWER minor than
 *    implemented is rejected too (the reader knows its limit);
 *  - the ADCOS API version is pinned to "2.0" in one closed set, and the
 *    env schema rejects any other value (fail-closed).
 *
 * NEGATIVE PROOFS (red-on-violation):
 *  - a record with a different-major contractVersion is accepted by the
 *    violating tree (the toggle flips the rejection);
 *  - an ADCOS_API_VERSION outside the pinned line is likewise rejected.
 */
import { describe, expect, it } from "vitest";
import {
  compareContractVersions,
  isAdditiveCompatible,
  parseContractVersion,
  parseEnv,
  SUPPORTED_ADCOS_API_VERSIONS,
} from "@roamlink/contracts";
import { ADCOS_API_VERSION } from "@roamlink/adcos";
import { DeviceCapabilitySnapshot, DOMAIN_EXPERIENCE_CONTRACT_VERSION } from "@roamlink/domain-experience";
import { violationEnabled } from "../src/index.js";

const LOCK = "RL-LOCK-017";
const T0 = "2026-01-15T08:30:00.000Z";

const SNAPSHOT_BASE = {
  snapshotId: "00000000-0000-4000-8000-000000000401",
  contractVersion: "0.1",
  sequence: 1,
  deviceId: "00000000-0000-4000-8000-000000000402",
  platform: { family: "ios", platformVersion: "18.2" },
  observedAt: T0,
  freshUntil: "2026-01-15T09:30:00.000Z",
  capabilities: {
    wifi_observation: { status: "available", evidenceClass: "OBSERVED", observedAt: T0 },
  },
} as const;

describe(`${LOCK}: versioned contracts`, () => {
  it("green: contract versions are MAJOR.MINOR; malformed versions are rejected", () => {
    expect(parseContractVersion("2.0")).toBe("2.0");
    expect(parseContractVersion("0.1")).toBe("0.1");
    for (const malformed of ["1", "1.0.0", "v2.0", "01.2", "two.zero", ""]) {
      expect(() => parseContractVersion(malformed)).toThrow();
    }
  });

  it("green: additive-change tolerance is exactly 'same major, newer-or-equal minor'", () => {
    expect(isAdditiveCompatible(parseContractVersion("0.1"), parseContractVersion("0.1"))).toBe(true);
    expect(isAdditiveCompatible(parseContractVersion("0.1"), parseContractVersion("0.2"))).toBe(true);
    expect(isAdditiveCompatible(parseContractVersion("0.1"), parseContractVersion("0.0"))).toBe(false);
    expect(isAdditiveCompatible(parseContractVersion("0.1"), parseContractVersion("1.0"))).toBe(false);
    expect(isAdditiveCompatible(parseContractVersion("0.1"), parseContractVersion("1.1"))).toBe(false);
    expect(compareContractVersions(parseContractVersion("0.2"), parseContractVersion("0.10"))).toBeLessThan(0);
  });

  it("green: the experience domain's own contract version is a valid MAJOR.MINOR", () => {
    expect(parseContractVersion(DOMAIN_EXPERIENCE_CONTRACT_VERSION)).toBe(
      DOMAIN_EXPERIENCE_CONTRACT_VERSION,
    );
  });

  it("green: a domain record with its own contract version constructs cleanly", () => {
    expect(() => new DeviceCapabilitySnapshot({ ...SNAPSHOT_BASE })).not.toThrow();
  });

  it("negative proof: a different-major record version is rejected (red when admitted)", () => {
    for (const incompatible of ["99.0", "1.0"]) {
      const violating = { ...SNAPSHOT_BASE, contractVersion: incompatible };
      if (violationEnabled(LOCK)) {
        expect(() => new DeviceCapabilitySnapshot(violating)).not.toThrow();
      } else {
        expect(() => new DeviceCapabilitySnapshot(violating)).toThrow(
          /DEVICE_CAPABILITY_SNAPSHOT_INVALID|contractVersion/,
        );
      }
    }
  });

  it("green: a record from a NEWER minor than implemented is rejected (the reader knows its limit)", () => {
    const newerMinor = { ...SNAPSHOT_BASE, contractVersion: "0.2" };
    expect(() => new DeviceCapabilitySnapshot(newerMinor)).toThrow(
      /DEVICE_CAPABILITY_SNAPSHOT_INVALID|contractVersion/,
    );
  });

  it("green: the ADCOS API version is pinned to 2.0 in exactly one closed set", () => {
    expect(ADCOS_API_VERSION).toBe("2.0");
    expect(SUPPORTED_ADCOS_API_VERSIONS).toEqual(["2.0"]);
  });

  it("green: the env schema pins ADCOS_API_VERSION to the supported line (other values rejected)", () => {
    const base = { NODE_ENV: "test" };
    const withDefault = parseEnv(base);
    expect(withDefault.adcosApiVersion).toBe("2.0");
    const explicit = parseEnv({ ...base, ADCOS_API_VERSION: "2.0" });
    expect(explicit.adcosApiVersion).toBe("2.0");
    expect(() => parseEnv({ ...base, ADCOS_API_VERSION: "3.0" })).toThrow();
    expect(() => parseEnv({ ...base, ADCOS_API_VERSION: "1.9" })).toThrow();
  });

  it("negative proof: an unpinned ADCOS version is a violation (red when accepted)", () => {
    if (violationEnabled(LOCK)) {
      expect(() => parseEnv({ NODE_ENV: "test", ADCOS_API_VERSION: "3.0" })).not.toThrow();
    } else {
      expect(() => parseEnv({ NODE_ENV: "test", ADCOS_API_VERSION: "3.0" })).toThrow();
    }
  });
});
