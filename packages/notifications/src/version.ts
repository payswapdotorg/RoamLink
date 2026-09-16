/**
 * Notifications contract versioning (RL-014, RL-LOCK-017).
 *
 * Versioned, additive-change tolerant record contracts for the
 * notifications/support domain. Every persisted record embeds a
 * `ContractVersion`; a record is readable when it shares this package's
 * contract MAJOR and is not NEWER than the implemented minor.
 */
import {
  contractVersionMajor,
  contractVersionMinor,
  isSameMajorVersion,
  parseContractVersion,
  type ContractVersion,
} from "@roamlink/contracts";

/** Contract version of the @roamlink/notifications record contracts. */
export const NOTIFICATIONS_CONTRACT_VERSION: ContractVersion = parseContractVersion("0.1");

/**
 * True when a record's contract version is readable by this package: same
 * major, minor not newer than the implemented minor.
 */
export function isNotificationsRecordVersionCompatible(version: ContractVersion): boolean {
  return (
    isSameMajorVersion(NOTIFICATIONS_CONTRACT_VERSION, version) &&
    contractVersionMinor(version) <= contractVersionMinor(NOTIFICATIONS_CONTRACT_VERSION)
  );
}

/** Human-readable explanation used in version-mismatch errors. */
export function describeNotificationsVersionExpectation(): string {
  return `record contractVersion must share the notifications contract major ${contractVersionMajor(
    NOTIFICATIONS_CONTRACT_VERSION,
  )} and must not be newer than minor ${contractVersionMinor(NOTIFICATIONS_CONTRACT_VERSION)}`;
}
