/**
 * Edge-connector contract versioning (RL-044, RL-LOCK-017).
 */
import {
  contractVersionMajor,
  contractVersionMinor,
  isSameMajorVersion,
  parseContractVersion,
  type ContractVersion,
} from "@roamlink/contracts";

/** Contract version of the @roamlink/edge-connector public contracts. */
export const EDGE_CONNECTOR_CONTRACT_VERSION: ContractVersion = parseContractVersion("0.1");

/**
 * True when a record's contract version is readable by this package: same
 * major, minor not newer than the implemented minor.
 */
export function isEdgeConnectorRecordVersionCompatible(version: ContractVersion): boolean {
  return (
    isSameMajorVersion(EDGE_CONNECTOR_CONTRACT_VERSION, version) &&
    contractVersionMinor(version) <= contractVersionMinor(EDGE_CONNECTOR_CONTRACT_VERSION)
  );
}

/** Human-readable explanation used in version-mismatch errors. */
export function describeEdgeConnectorContractVersionExpectation(): string {
  return `record contractVersion must share the edge-connector contract major ${contractVersionMajor(
    EDGE_CONNECTOR_CONTRACT_VERSION,
  )} and must not be newer than minor ${contractVersionMinor(EDGE_CONNECTOR_CONTRACT_VERSION)}`;
}
