/**
 * Package-local opaque identifier (RL-023).
 *
 * `ConnectivityReferenceId` identifies one commerce-to-connectivity
 * reference aggregate. The Wave-0 contracts package owns the shared id
 * vocabulary and carries no reference-model id (adding one there is an
 * additive contracts change owned by the foundation); this package
 * therefore declares the branded type LOCALLY with the same canonical
 * lowercase-UUID grammar and the same parse discipline. It is never
 * interchangeable with RoamLink-owned ids or foreign ADCOS references
 * (RL-LOCK-003).
 */
import { parseCanonicalUuidAs, type Branded } from "@roamlink/contracts";

/** Opaque identity of one connectivity reference aggregate. */
export type ConnectivityReferenceId = Branded<"ConnectivityReferenceId">;

/** Parses a canonical lowercase UUID as a {@link ConnectivityReferenceId}. */
export function parseConnectivityReferenceId(value: unknown): ConnectivityReferenceId {
  return parseCanonicalUuidAs<ConnectivityReferenceId>(value, "ConnectivityReferenceId");
}
