/**
 * Commerce-connectivity contract versioning (RL-023, RL-LOCK-017).
 *
 * Versioned, additive-change tolerant record contracts for the
 * commerce-to-connectivity reference model. Every persisted reference
 * record embeds a `ContractVersion`; a record is readable when it shares
 * this package's contract MAJOR and is not NEWER than the implemented
 * minor.
 */
import {
  contractVersionMajor,
  contractVersionMinor,
  isSameMajorVersion,
  parseContractVersion,
  type ContractVersion,
} from "@roamlink/contracts";

/** Contract version of the @roamlink/commerce-connectivity record contracts. */
export const COMMERCE_CONNECTIVITY_CONTRACT_VERSION: ContractVersion = parseContractVersion("0.1");

/**
 * True when a record's contract version is readable by this package: same
 * major, minor not newer than the implemented minor.
 */
export function isCommerceConnectivityRecordVersionCompatible(version: ContractVersion): boolean {
  return (
    isSameMajorVersion(COMMERCE_CONNECTIVITY_CONTRACT_VERSION, version) &&
    contractVersionMinor(version) <= contractVersionMinor(COMMERCE_CONNECTIVITY_CONTRACT_VERSION)
  );
}

/** Human-readable explanation used in version-mismatch errors. */
export function describeCommerceConnectivityVersionExpectation(): string {
  return `record contractVersion must share the commerce-connectivity contract major ${contractVersionMajor(
    COMMERCE_CONNECTIVITY_CONTRACT_VERSION,
  )} and must not be newer than minor ${contractVersionMinor(COMMERCE_CONNECTIVITY_CONTRACT_VERSION)}`;
}
