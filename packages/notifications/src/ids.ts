/**
 * Package-local opaque identifiers (RL-014).
 *
 * `SupportCaseId` and `SupportCaseMessageId` identify the support-ticket
 * aggregates. The Wave-0 contracts package owns the shared id vocabulary
 * and carries `NotificationId` (used here) but no support-case ids (adding
 * them there is an additive contracts change owned by the foundation);
 * this package therefore declares the branded types LOCALLY with the same
 * canonical lowercase-UUID grammar. They are never interchangeable with
 * RoamLink-owned ids or foreign ADCOS references (RL-LOCK-003).
 */
import { parseCanonicalUuidAs, type Branded } from "@roamlink/contracts";

/** Opaque identity of one support case. */
export type SupportCaseId = Branded<"SupportCaseId">;

/** Opaque identity of one support-case message. */
export type SupportCaseMessageId = Branded<"SupportCaseMessageId">;

/** Parses a canonical lowercase UUID as a {@link SupportCaseId}. */
export function parseSupportCaseId(value: unknown): SupportCaseId {
  return parseCanonicalUuidAs<SupportCaseId>(value, "SupportCaseId");
}

/** Parses a canonical lowercase UUID as a {@link SupportCaseMessageId}. */
export function parseSupportCaseMessageId(value: unknown): SupportCaseMessageId {
  return parseCanonicalUuidAs<SupportCaseMessageId>(value, "SupportCaseMessageId");
}
