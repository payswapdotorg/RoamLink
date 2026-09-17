/**
 * The intent-satisfaction measurement point (RL-013 read model → §11 SLO
 * "intent satisfaction rate", spec/architecture.md §11).
 *
 * PURE mapping: given one built {@link ExperienceDecisionRecord}, what is
 * the satisfaction OUTCOME the product may record for the §11 SLO?
 *
 *  - `experience_supported`  -> satisfied (the active intent is backed by
 *    usable, fresh device evidence — the experience read model says the
 *    customer's expressed intent is currently being met);
 *  - `experience_degraded`   -> not satisfied (stale evidence or capability
 *    limits on the preferred access classes — the intent is only partially
 *    met);
 *  - `experience_unresolved` -> not satisfied (missing/unknown evidence —
 *    the read model cannot say the intent is met, and it never guesses);
 *  - `experience_pending` / `experience_closed` -> NOT MEASURABLE (null):
 *    a draft intent has nothing to satisfy yet and a terminal intent is no
 *    longer evaluated — recording either would fabricate a denominator.
 *
 * This module owns NO new authority: it derives the outcome from the closed
 * derived-status vocabulary the RL-013 read model already computes, and the
 * CALLER owns the recording instant and the emission port (the §11 recorder
 * from `@roamlink/observability`). Decisions reference connectivity; they
 * never authorize it (RL-LOCK-004/005) — and neither does this mapping.
 */
import type { DerivedExperienceStatus } from "./derived-status.js";
import { isDerivedExperienceStatus } from "./derived-status.js";

/** The minimal decision shape the satisfaction mapping reads. */
export interface DecisionSatisfactionInput {
  readonly derivedStatus: DerivedExperienceStatus;
}

/** One measurable satisfaction outcome (null = not measurable — see module doc). */
export type IntentSatisfactionMeasurement = { readonly satisfied: boolean } | null;

/**
 * Maps one decision's derived status to the §11 intent-satisfaction outcome.
 * Pure; fails closed on values outside the closed derived-status vocabulary.
 */
export function intentSatisfactionOf(
  decision: DecisionSatisfactionInput,
): IntentSatisfactionMeasurement {
  if (decision === null || typeof decision !== "object") {
    throw new TypeError("intentSatisfactionOf requires a decision carrying a derivedStatus");
  }
  const status = isDerivedExperienceStatus(decision.derivedStatus)
    ? decision.derivedStatus
    : undefined;
  if (status === undefined) {
    throw new TypeError(
      "intentSatisfactionOf requires a derivedStatus from the closed vocabulary (experience_pending/supported/degraded/unresolved/closed)",
    );
  }
  switch (status) {
    case "experience_supported":
      return { satisfied: true };
    case "experience_degraded":
    case "experience_unresolved":
      return { satisfied: false };
    case "experience_pending":
    case "experience_closed":
      return null;
  }
}
