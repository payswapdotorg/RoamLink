/**
 * Domain-commerce contract versioning (RL-020/RL-021, RL-LOCK-017).
 *
 * Versioned, additive-change tolerant record contracts for the commerce
 * domain (products/variants, orders/lines, subscriptions, events). Every
 * persisted commerce record embeds a `ContractVersion`; a record is
 * readable when it shares this package's contract MAJOR and is not NEWER
 * than the implemented minor.
 */
import {
  contractVersionMajor,
  contractVersionMinor,
  isSameMajorVersion,
  parseContractVersion,
  type ContractVersion,
} from "@roamlink/contracts";

/** Contract version of the @roamlink/domain-commerce record contracts. */
export const DOMAIN_COMMERCE_CONTRACT_VERSION: ContractVersion = parseContractVersion("0.1");

/**
 * True when a record's contract version is readable by this package: same
 * major, minor not newer than the implemented minor.
 */
export function isDomainCommerceRecordVersionCompatible(version: ContractVersion): boolean {
  return (
    isSameMajorVersion(DOMAIN_COMMERCE_CONTRACT_VERSION, version) &&
    contractVersionMinor(version) <= contractVersionMinor(DOMAIN_COMMERCE_CONTRACT_VERSION)
  );
}

/** Human-readable explanation used in version-mismatch errors. */
export function describeDomainCommerceVersionExpectation(): string {
  return `record contractVersion must share the domain-commerce contract major ${contractVersionMajor(
    DOMAIN_COMMERCE_CONTRACT_VERSION,
  )} and must not be newer than minor ${contractVersionMinor(DOMAIN_COMMERCE_CONTRACT_VERSION)}`;
}
