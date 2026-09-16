/**
 * Intent-compiler contract versioning (RL-012, RL-LOCK-017).
 *
 * The compiled-intent model is a versioned, additive-change tolerant public
 * contract: it is the handoff artifact between the experience domain
 * (RL-010/RL-011 aggregates) and the ADCOS integration surface (RL-031
 * intent adapter). A compiled model is readable by consumers that share this
 * package's contract MAJOR and are not newer than the implemented minor.
 */
import {
  contractVersionMajor,
  contractVersionMinor,
  isSameMajorVersion,
  parseContractVersion,
  type ContractVersion,
} from "@roamlink/contracts";

/** Contract version of the @roamlink/intent-compiler output contracts. */
export const INTENT_COMPILER_CONTRACT_VERSION: ContractVersion = parseContractVersion("0.1");

/**
 * True when a compiled-model record's contract version is readable by this
 * package: same major, minor not newer than the implemented minor.
 */
export function isIntentCompilerRecordVersionCompatible(version: ContractVersion): boolean {
  return (
    isSameMajorVersion(INTENT_COMPILER_CONTRACT_VERSION, version) &&
    contractVersionMinor(version) <= contractVersionMinor(INTENT_COMPILER_CONTRACT_VERSION)
  );
}

/** Human-readable explanation used in version-mismatch errors. */
export function describeIntentCompilerVersionExpectation(): string {
  return `record contractVersion must share the intent-compiler contract major ${contractVersionMajor(
    INTENT_COMPILER_CONTRACT_VERSION,
  )} and must not be newer than minor ${contractVersionMinor(INTENT_COMPILER_CONTRACT_VERSION)}`;
}
