/**
 * Retention contract versioning (RL-054, RL-LOCK-017).
 */
import {
  contractVersionMajor,
  contractVersionMinor,
  isSameMajorVersion,
  parseContractVersion,
  type ContractVersion,
} from "@roamlink/contracts";

/** Contract version of the @roamlink/retention public contracts. */
export const RETENTION_CONTRACT_VERSION: ContractVersion = parseContractVersion("0.1");

/**
 * True when a record's contract version is readable by this package: same
 * major, minor not newer than the implemented minor.
 */
export function isRetentionRecordVersionCompatible(version: ContractVersion): boolean {
  return (
    isSameMajorVersion(RETENTION_CONTRACT_VERSION, version) &&
    contractVersionMinor(version) <= contractVersionMinor(RETENTION_CONTRACT_VERSION)
  );
}

/** Human-readable explanation used in version-mismatch errors. */
export function describeRetentionContractVersionExpectation(): string {
  return `record contractVersion must share the retention contract major ${contractVersionMajor(
    RETENTION_CONTRACT_VERSION,
  )} and must not be newer than minor ${contractVersionMinor(RETENTION_CONTRACT_VERSION)}`;
}
