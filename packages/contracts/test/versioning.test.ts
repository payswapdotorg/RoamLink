import { describe, expect, it } from "vitest";
import {
  CONTRACTS_CONTRACT_VERSION,
  compareContractVersions,
  contractVersionMajor,
  contractVersionMinor,
  isAdditiveCompatible,
  isContractVersion,
  isRevision,
  isSameMajorVersion,
  parseContractVersion,
  parseRevision,
} from "../src/versioning/versioning.js";
import { ValidationError } from "../src/errors/errors.js";

describe("ContractVersion", () => {
  it("parses MAJOR.MINOR forms", () => {
    expect(parseContractVersion("2.0")).toBe("2.0");
    expect(parseContractVersion("0.1")).toBe("0.1");
    expect(parseContractVersion("10.20")).toBe("10.20");
    expect(isContractVersion("2.0")).toBe(true);
  });

  it("rejects malformed versions", () => {
    for (const bad of ["2", "v2.0", "2.0.0", "02.0", "2.01", "2.-1", ".2", "2.", "2.0 ", "", 20, null, undefined, "2,0"]) {
      expect(() => parseContractVersion(bad), `form: '${String(bad)}'`).toThrowError(ValidationError);
      expect(isContractVersion(bad)).toBe(false);
    }
  });

  it("compares versions by major then minor", () => {
    expect(compareContractVersions(parseContractVersion("2.0"), parseContractVersion("2.1"))).toBeLessThan(0);
    expect(compareContractVersions(parseContractVersion("2.9"), parseContractVersion("3.0"))).toBeLessThan(0);
    expect(compareContractVersions(parseContractVersion("2.0"), parseContractVersion("2.0"))).toBe(0);
    expect(contractVersionMajor(parseContractVersion("10.20"))).toBe(10);
    expect(contractVersionMinor(parseContractVersion("10.20"))).toBe(20);
    expect(isSameMajorVersion(parseContractVersion("2.9"), parseContractVersion("2.0"))).toBe(true);
    expect(isSameMajorVersion(parseContractVersion("2.9"), parseContractVersion("3.0"))).toBe(false);
  });

  it("additive compatibility follows RL-LOCK-017 (same major, same-or-newer minor)", () => {
    const v2_0 = parseContractVersion("2.0");
    expect(isAdditiveCompatible(v2_0, parseContractVersion("2.0"))).toBe(true);
    expect(isAdditiveCompatible(v2_0, parseContractVersion("2.5"))).toBe(true);
    expect(isAdditiveCompatible(v2_0, parseContractVersion("3.0"))).toBe(false);
    expect(isAdditiveCompatible(parseContractVersion("2.5"), parseContractVersion("2.0"))).toBe(false);
  });

  it("declares the contracts package contract version", () => {
    expect(CONTRACTS_CONTRACT_VERSION).toBe("0.1");
    expect(isContractVersion(CONTRACTS_CONTRACT_VERSION)).toBe(true);
  });
});

describe("Revision", () => {
  it("accepts positive integers only", () => {
    expect(parseRevision(1)).toBe(1);
    expect(parseRevision(999_999)).toBe(999_999);
    expect(isRevision(1)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN, "1", null, undefined]) {
      expect(() => parseRevision(bad), `value: ${String(bad)}`).toThrowError(ValidationError);
      expect(isRevision(bad)).toBe(false);
    }
  });
});
