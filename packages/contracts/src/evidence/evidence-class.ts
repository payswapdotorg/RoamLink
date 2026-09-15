import { ValidationError } from "../errors/errors.js";

/**
 * Evidence classes - the frozen provenance vocabulary (RL-002, RL-LOCK-010,
 * spec/authority-model.md "Evidence classes").
 *
 * The vocabulary is CLOSED. `UNKNOWN` is a valid state meaning "absence or
 * insufficient evidence" - it is NOT an error and must never be converted into
 * a false success or failure. Downstream code may not invent new classes;
 * additions require an approved contract change (RL-017).
 */

export const EVIDENCE_CLASSES = [
  "AUTHENTICATED",
  "OBSERVED",
  "REPORTED",
  "DERIVED",
  "INFERRED",
  "STALE",
  "UNKNOWN",
] as const;

export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const EVIDENCE_CLASS_DESCRIPTIONS: Readonly<Record<EvidenceClass, string>> = {
  AUTHENTICATED: "Cryptographically authenticated statement from the authoritative source.",
  OBSERVED: "Directly observed by a device/service.",
  REPORTED: "Statement reported by another node/service.",
  DERIVED: "Deterministically computed from authoritative/observed facts.",
  INFERRED: "Heuristic/model-based interpretation; never canonical.",
  STALE: "Known prior state whose freshness guarantee has expired.",
  UNKNOWN: "Absence or insufficient evidence; not equivalent to failure.",
};

export function isEvidenceClass(value: unknown): value is EvidenceClass {
  return typeof value === "string" && (EVIDENCE_CLASSES as readonly string[]).includes(value);
}

/**
 * Parses an evidence class. Throws a ValidationError for anything outside the
 * frozen vocabulary. `UNKNOWN` parses successfully - it is a valid state.
 */
export function parseEvidenceClass(value: unknown): EvidenceClass {
  if (!isEvidenceClass(value)) {
    throw new ValidationError(
      "value is not a member of the frozen evidence-class vocabulary (AUTHENTICATED, OBSERVED, REPORTED, DERIVED, INFERRED, STALE, UNKNOWN - UNKNOWN is valid, not an error)",
      {
        reason: "EVIDENCE_CLASS_INVALID",
        details: [{ path: "EvidenceClass", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}

export function describeEvidenceClass(evidenceClass: EvidenceClass): string {
  return EVIDENCE_CLASS_DESCRIPTIONS[evidenceClass];
}
