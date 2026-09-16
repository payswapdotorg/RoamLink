/**
 * Enterprise contract versioning (RL-063, RL-LOCK-017).
 *
 * Every persisted enterprise record (enrollment, federation link, API key,
 * connector provisioning, webhook endpoint/delivery) embeds a
 * `ContractVersion`. The discipline mirrors the other RoamLink contract
 * families exactly:
 *
 *  - additive changes are preferred and stay inside a MAJOR;
 *  - a record from an OLDER minor (produced by an older producer) parses;
 *  - a record from a NEWER minor may carry fields this parser does not
 *    know - it FAILS CLOSED instead of silently dropping them;
 *  - a different MAJOR is a breaking change and never parses silently.
 */
import {
  contractVersionMajor,
  contractVersionMinor,
  isSameMajorVersion,
  parseContractVersion,
  type ContractVersion,
} from "@roamlink/contracts";

/** Contract version of the @roamlink/enterprise public contracts. */
export const ENTERPRISE_CONTRACT_VERSION: ContractVersion = parseContractVersion("0.1");

/**
 * True when a record's contract version is readable by this package: same
 * major, minor not newer than the implemented minor.
 */
export function isEnterpriseRecordVersionCompatible(version: ContractVersion): boolean {
  return (
    isSameMajorVersion(ENTERPRISE_CONTRACT_VERSION, version) &&
    contractVersionMinor(version) <= contractVersionMinor(ENTERPRISE_CONTRACT_VERSION)
  );
}

/** Human-readable explanation used in version-mismatch errors. */
export function describeEnterpriseContractVersionExpectation(): string {
  return `record contractVersion must share the enterprise contract major ${contractVersionMajor(
    ENTERPRISE_CONTRACT_VERSION,
  )} and must not be newer than minor ${contractVersionMinor(ENTERPRISE_CONTRACT_VERSION)}`;
}
