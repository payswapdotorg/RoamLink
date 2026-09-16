/**
 * Device-capability vocabulary alignment (RL-043, RL-LOCK-011/017/018).
 *
 * The task's authority chain: device actions are gated by the
 * **DeviceCapabilitySnapshot's closed vocabulary** - the EXPERIENCE-domain
 * vocabulary owned by `@roamlink/domain-experience` (RL-010), which the edge
 * package mirrors as its `EdgeCapabilityName` vocabulary (RL-040). The two
 * lists carry the same eleven names BY CONSTRUCTION, and the edge-action
 * adapter relies on that identity when it gates actions with the edge-side
 * `assertCapability` gate on behalf of the device registry's vocabulary.
 *
 * `assertDeviceCapabilityVocabularyAlignment()` proves the invariant at
 * runtime (and in tests): if either vocabulary ever drifts, the adapter
 * fails CLOSED instead of admitting an action whose capability name the
 * device registry would not recognize (RL-LOCK-017 additive-change tolerance
 * does not license silent drift between two closed vocabularies).
 */
import { DomainError } from "@roamlink/contracts";
import { DOMAIN_EXPERIENCE_CONTRACT_VERSION, DEVICE_CAPABILITY_NAMES } from "@roamlink/domain-experience";
import { EDGE_CAPABILITY_NAMES } from "@roamlink/edge";

/**
 * The frozen, sorted intersection of the edge and experience-domain device
 * capability vocabularies. Empty iff the vocabularies have drifted apart.
 */
export function deviceCapabilityVocabularyIntersection(): readonly string[] {
  const edgeSet = new Set<string>(EDGE_CAPABILITY_NAMES);
  return Object.freeze(
    [...new Set<string>(DEVICE_CAPABILITY_NAMES)].filter((name) => edgeSet.has(name)).sort(),
  );
}

/**
 * True iff both closed vocabularies carry EXACTLY the same names (order
 * insensitive). Called at adapter construction and by conformance tests.
 */
export function isDeviceCapabilityVocabularyAligned(): boolean {
  if (DEVICE_CAPABILITY_NAMES.length !== EDGE_CAPABILITY_NAMES.length) {
    return false;
  }
  const edgeSet = new Set<string>(EDGE_CAPABILITY_NAMES);
  return DEVICE_CAPABILITY_NAMES.every((name) => edgeSet.has(name));
}

/**
 * Fail-closed alignment assertion. Throws a typed DomainError when the edge
 * and experience-domain capability vocabularies have drifted - an action
 * admitted through one vocabulary but not the other would be a silent
 * capability guess, which RL-LOCK-011 forbids.
 */
export function assertDeviceCapabilityVocabularyAlignment(): readonly string[] {
  if (!isDeviceCapabilityVocabularyAligned()) {
    const edgeOnly = EDGE_CAPABILITY_NAMES.filter(
      (name) => !(DEVICE_CAPABILITY_NAMES as readonly string[]).includes(name),
    );
    const domainOnly = DEVICE_CAPABILITY_NAMES.filter(
      (name) => !(EDGE_CAPABILITY_NAMES as readonly string[]).includes(name),
    );
    throw new DomainError(
      "the edge capability vocabulary and the DeviceCapabilitySnapshot vocabulary have drifted apart; device actions fail closed until the vocabularies are realigned (names are never guessed, RL-LOCK-011/017)",
      {
        reason: "DEVICE_CAPABILITY_VOCABULARY_DRIFT",
        details: [
          { path: "edge-only", issue: `${edgeOnly.length} unmatched name(s)` },
          { path: "domain-experience-only", issue: `${domainOnly.length} unmatched name(s)` },
        ],
      },
    );
  }
  return DEVICE_CAPABILITY_NAMES;
}

/** Re-exported so adapter consumers can quote the registry vocabulary size. */
export const DEVICE_ACTION_CAPABILITY_COUNT = DEVICE_CAPABILITY_NAMES.length;

/** Re-exported registry contract version (diagnostics only). */
export const REGISTRY_CONTRACT_VERSION = DOMAIN_EXPERIENCE_CONTRACT_VERSION;
