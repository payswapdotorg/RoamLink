/**
 * Domain-experience contract versioning (RL-010/RL-011, RL-LOCK-017).
 *
 * Versioned, additive-change tolerant record contracts. Every persisted
 * domain-experience record (device, snapshots, intent, intent version)
 * embeds a `ContractVersion`. A record is readable when it shares this
 * package's contract MAJOR and is not NEWER than the implemented minor
 * (newer minors may carry unknown fields; we fail closed instead of
 * dropping them silently).
 */
import {
  contractVersionMajor,
  contractVersionMinor,
  isSameMajorVersion,
  parseContractVersion,
  type ContractVersion,
} from "@roamlink/contracts";

/** Contract version of the @roamlink/domain-experience record contracts. */
export const DOMAIN_EXPERIENCE_CONTRACT_VERSION: ContractVersion = parseContractVersion("0.1");

/**
 * True when a record's contract version is readable by this package: same
 * major, minor not newer than the implemented minor.
 */
export function isDomainExperienceRecordVersionCompatible(version: ContractVersion): boolean {
  return (
    isSameMajorVersion(DOMAIN_EXPERIENCE_CONTRACT_VERSION, version) &&
    contractVersionMinor(version) <= contractVersionMinor(DOMAIN_EXPERIENCE_CONTRACT_VERSION)
  );
}

/** Human-readable explanation used in version-mismatch errors. */
export function describeDomainExperienceVersionExpectation(): string {
  return `record contractVersion must share the domain-experience contract major ${contractVersionMajor(
    DOMAIN_EXPERIENCE_CONTRACT_VERSION,
  )} and must not be newer than minor ${contractVersionMinor(DOMAIN_EXPERIENCE_CONTRACT_VERSION)}`;
}
