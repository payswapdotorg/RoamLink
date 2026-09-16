/**
 * Edge-actions contract versioning (RL-043, RL-LOCK-017).
 *
 * The action-adapter records exchanged across the seam (admission outcomes,
 * projection entries, policy decisions) are versioned and additive-change
 * tolerant like every other RoamLink contract: same MAJOR, MINOR not newer
 * than the implemented minor, else fail closed (never silently drop fields).
 */
import {
  contractVersionMajor,
  contractVersionMinor,
  isSameMajorVersion,
  parseContractVersion,
  type ContractVersion,
} from "@roamlink/contracts";

/** Contract version of the @roamlink/edge-actions public contracts. */
export const EDGE_ACTIONS_CONTRACT_VERSION: ContractVersion = parseContractVersion("0.1");

/**
 * True when a record's contract version is readable by this package: same
 * major, minor not newer than the implemented minor.
 */
export function isEdgeActionsRecordVersionCompatible(version: ContractVersion): boolean {
  return (
    isSameMajorVersion(EDGE_ACTIONS_CONTRACT_VERSION, version) &&
    contractVersionMinor(version) <= contractVersionMinor(EDGE_ACTIONS_CONTRACT_VERSION)
  );
}

/** Human-readable explanation used in version-mismatch errors. */
export function describeEdgeActionsContractVersionExpectation(): string {
  return `record contractVersion must share the edge-actions contract major ${contractVersionMajor(
    EDGE_ACTIONS_CONTRACT_VERSION,
  )} and must not be newer than minor ${contractVersionMinor(EDGE_ACTIONS_CONTRACT_VERSION)}`;
}
