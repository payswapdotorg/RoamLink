/**
 * Edge contract versioning (RL-040, RL-LOCK-017).
 *
 * Versioned, additive-change tolerant record contracts. Every persisted edge
 * record (capability snapshot, desired state, outbox record) embeds a
 * `ContractVersion`. A record is readable when it shares the edge contract
 * MAJOR and is not NEWER than the minor this package implements (a newer
 * minor may carry fields this parser does not know; it fails closed instead
 * of silently dropping them).
 */
import {
  contractVersionMajor,
  contractVersionMinor,
  isSameMajorVersion,
  parseContractVersion,
  type ContractVersion,
} from "@roamlink/contracts";

/** Contract version of the @roamlink/edge package's public contracts. */
export const EDGE_CONTRACT_VERSION: ContractVersion = parseContractVersion("0.1");

/**
 * True when a record's contract version is readable by this package: same
 * major, minor not newer than the implemented minor.
 */
export function isEdgeRecordVersionCompatible(version: ContractVersion): boolean {
  return (
    isSameMajorVersion(EDGE_CONTRACT_VERSION, version) &&
    contractVersionMinor(version) <= contractVersionMinor(EDGE_CONTRACT_VERSION)
  );
}

/** Human-readable explanation used in version-mismatch errors. */
export function describeEdgeContractVersionExpectation(): string {
  return `record contractVersion must share the edge contract major ${contractVersionMajor(
    EDGE_CONTRACT_VERSION,
  )} and must not be newer than minor ${contractVersionMinor(EDGE_CONTRACT_VERSION)}`;
}
