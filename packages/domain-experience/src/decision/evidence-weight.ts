/**
 * Evidence weighting for decision inputs (RL-013, RL-LOCK-010).
 *
 * Every input a decision is computed from carries an evidence class and a
 * freshness state. The weight is a DETERMINISTIC function of the two: the
 * evidence-class rank sets the ceiling, and freshness can only LOWER it
 * (STALE evidence contributes nothing; UNKNOWN never contributes). The
 * weights exist to make "evidence-weighted inputs" visible and explainable on
 * the read model - they never authorize anything.
 *
 * Ranking rationale (spec/authority-model.md "Evidence classes"):
 *   AUTHENTICATED (4) - cryptographically authenticated authority statement
 *   OBSERVED      (3) - directly observed by the device/service
 *   REPORTED      (2) - statement reported by another node/service
 *   DERIVED       (2) - deterministically computed from authoritative facts
 *   INFERRED      (1) - heuristic/model-based; never canonical
 *   STALE         (0) - known prior state, freshness expired
 *   UNKNOWN       (0) - absence or insufficient evidence
 */
import type { EvidenceClass, Freshness } from "@roamlink/contracts";

/** The frozen evidence-class rank (higher = stronger). */
export const EVIDENCE_CLASS_WEIGHTS: Readonly<Record<EvidenceClass, number>> = Object.freeze({
  AUTHENTICATED: 4,
  OBSERVED: 3,
  REPORTED: 2,
  DERIVED: 2,
  INFERRED: 1,
  STALE: 0,
  UNKNOWN: 0,
});

/**
 * The weight of an input given its evidence class and freshness. Deterministic
 * and monotone: STALE or UNKNOWN freshness collapses the weight to 0 no
 * matter how strong the recorded evidence class was.
 */
export function evidenceWeight(evidenceClass: EvidenceClass, freshness: Freshness): number {
  if (freshness.freshnessState === "STALE" || freshness.freshnessState === "UNKNOWN") {
    return EVIDENCE_CLASS_WEIGHTS.STALE;
  }
  return EVIDENCE_CLASS_WEIGHTS[evidenceClass];
}

/**
 * The weakest evidence class among a snapshot's entries (the snapshot is as
 * strong as its weakest claim - conservative by construction). An empty
 * entry set is honest UNKNOWN ("nothing observed"), never a guess.
 */
export function weakestEvidenceClass(
  classes: readonly EvidenceClass[],
): EvidenceClass {
  if (classes.length === 0) {
    return "UNKNOWN";
  }
  let weakest = classes[0] as EvidenceClass;
  for (const candidate of classes) {
    if (EVIDENCE_CLASS_WEIGHTS[candidate] < EVIDENCE_CLASS_WEIGHTS[weakest]) {
      weakest = candidate;
    }
  }
  return weakest;
}
