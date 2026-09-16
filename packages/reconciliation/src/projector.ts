/**
 * The boundary webhook projector (RL-035 binding RL-033 -> RL-034).
 *
 * Implements the `AdcosWebhookProjector` port from @roamlink/webhook-inbox
 * by delegating to the Wave-2 projection engine owned by the reconciliation
 * boundary. This is the seam that keeps webhook-driven projection INSIDE the
 * reconciler/integration boundary (spec §8: "Only the reconciler/integration
 * boundary may write ADCOS-derived projections") - the inbox admits signals
 * durably; the boundary projects them; nothing else writes.
 *
 * Idempotent by construction: the engine's ordering defense makes
 * reprocessing after a crash converge (same version = no-op).
 */
import type { AdcosWebhookProjectionOutcome, AdcosWebhookProjector, AdmittedWebhookEventView } from "@roamlink/webhook-inbox";
import type { AdcosProjectionEngine, ProjectionApplyOutcome } from "@roamlink/projections";

export class BoundaryWebhookProjector implements AdcosWebhookProjector {
  readonly #engine: AdcosProjectionEngine;

  constructor(engine: AdcosProjectionEngine) {
    this.#engine = engine;
  }

  async project(admission: AdmittedWebhookEventView): Promise<AdcosWebhookProjectionOutcome> {
    let outcome: ProjectionApplyOutcome;
    try {
      outcome = await this.#engine.projectVerifiedEvent(admission.event, admission.receivedAt);
    } catch (error) {
      // The projector contract reports failures as values so the inbox can
      // retry them deterministically; only the closed reason is surfaced
      // (log-safe, RL-LOCK-016).
      const reason = error instanceof Error && "reason" in error
        ? String((error as { reason: unknown }).reason)
        : "PROJECTION_FAILED";
      return { outcome: "FAILED", reason };
    }
    switch (outcome.outcome) {
      case "APPLIED":
        return { outcome: "APPLIED" };
      case "SKIPPED_OUTDATED":
        return { outcome: "SKIPPED", reason: outcome.reason };
      case "SKIPPED_SAME_VERSION":
        return { outcome: "SKIPPED", reason: outcome.reason };
      case "MARKED_STALE":
        return { outcome: "SKIPPED", reason: `UNEXPECTED_OUTCOME_MARKED_STALE (${outcome.cause})` };
      case "MARKED_UNKNOWN":
        return { outcome: "SKIPPED", reason: `UNEXPECTED_OUTCOME_MARKED_UNKNOWN (${outcome.cause})` };
      case "NO_RECORD":
        return { outcome: "SKIPPED", reason: outcome.reason };
    }
  }
}
