/**
 * Contract versioning primitives (RL-002, RL-LOCK-017).
 *
 * Public RoamLink and ADCOS-integration contracts are versioned and
 * additive-change tolerant. Contract versions are `MAJOR.MINOR` (no patch
 * segment): a new MINOR within the same MAJOR means additive-only change
 * (new optional fields, new enum members appended); a new MAJOR means a
 * breaking change. Consumers MUST tolerate unknown additive fields when the
 * major version matches.
 *
 * `Revision` is the monotonic revision / optimistic-concurrency token used by
 * mutable customer state and by command envelopes (intentVersion/orderVersion).
 */
import type { Branded, BrandedRevision } from "../brand.js";
import { ValidationError } from "../errors/errors.js";

export type ContractVersion = Branded<"ContractVersion">;
export type Revision = BrandedRevision;

const CONTRACT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseContractVersion(value: unknown): ContractVersion {
  if (typeof value !== "string") {
    throw new ValidationError("ContractVersion must be a string of the form MAJOR.MINOR", {
      reason: "CONTRACT_VERSION_INVALID",
      details: [{ path: "ContractVersion", issue: "value is not a string" }],
    });
  }
  if (!CONTRACT_VERSION_PATTERN.test(value) || value.length > 18) {
    throw new ValidationError(
      "ContractVersion must be MAJOR.MINOR with non-negative integers and no leading zeros (e.g. '2.0', '0.1')",
      {
        reason: "CONTRACT_VERSION_INVALID",
        details: [{ path: "ContractVersion", issue: "malformed version string" }],
      },
    );
  }
  return value as ContractVersion;
}

export function isContractVersion(value: unknown): value is ContractVersion {
  try {
    parseContractVersion(value);
    return true;
  } catch {
    return false;
  }
}

export function contractVersionMajor(version: ContractVersion): number {
  return Number(version.split(".")[0]);
}

export function contractVersionMinor(version: ContractVersion): number {
  return Number(version.split(".")[1]);
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. */
export function compareContractVersions(a: ContractVersion, b: ContractVersion): number {
  const majorDiff = contractVersionMajor(a) - contractVersionMajor(b);
  if (majorDiff !== 0) return majorDiff;
  return contractVersionMinor(a) - contractVersionMinor(b);
}

export function isSameMajorVersion(a: ContractVersion, b: ContractVersion): boolean {
  return contractVersionMajor(a) === contractVersionMajor(b);
}

/**
 * Additive-change tolerance (RL-LOCK-017): `candidate` is compatible with
 * `baseline` when it shares the major and is the same or a newer minor.
 * Older minors and different majors are NOT compatible.
 */
export function isAdditiveCompatible(baseline: ContractVersion, candidate: ContractVersion): boolean {
  return (
    isSameMajorVersion(baseline, candidate) &&
    contractVersionMinor(candidate) >= contractVersionMinor(baseline)
  );
}

/** A version-tagged public contract payload. */
export interface Versioned<TPayload> {
  readonly contractVersion: ContractVersion;
  readonly payload: TPayload;
}

export function parseRevision(value: unknown): Revision {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ValidationError("Revision must be a positive integer (>= 1)", {
      reason: "REVISION_INVALID",
      details: [{ path: "Revision", issue: "not a positive integer" }],
    });
  }
  return value as Revision;
}

export function isRevision(value: unknown): value is Revision {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * Contract version of the @roamlink/contracts package itself. Bump the MINOR
 * for additive changes (new exports), the MAJOR for breaking changes.
 */
export const CONTRACTS_CONTRACT_VERSION: ContractVersion = "0.1" as ContractVersion;
