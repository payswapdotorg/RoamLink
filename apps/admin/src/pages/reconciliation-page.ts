/**
 * The reconciliation job monitoring page (RL-061): durable job records with
 * their envelope metadata (command/correlation/idempotency - jobs ARE §5
 * commands, RL-LOCK-014) and the per-action repair outcomes. Truth
 * unreachable reads as DEGRADED_STALE/DEGRADED_UNKNOWN - never a guess
 * (RL-LOCK-010), and the console surfaces that honesty instead of hiding it.
 */
import {
  healthBadge,
  instantView,
  stateBadge,
  el,
  fragment,
  text,
  type HtmlFragment,
  type ReconciliationJobResource,
} from "@roamlink/app-kit";

import { pageHeading } from "../page-kit.js";

const OUTCOME_HEALTH: Readonly<Record<string, string>> = Object.freeze({
  REPAIRED: "healthy",
  ALREADY_CONSISTENT: "healthy",
  DEGRADED_STALE: "degraded",
  DEGRADED_UNKNOWN: "degraded",
  CANONICAL_ABSENT: "degraded",
  DEFERRED: "degraded",
  FAILED: "down",
});

export function reconciliationPage(input: {
  readonly jobs: readonly ReconciliationJobResource[];
}): HtmlFragment {
  return fragment(
    pageHeading(
      "Reconciliation jobs",
      "Periodic/triggered repair comparing projections against canonical ADCOS resources. Re-running a crashed job converges instead of duplicating.",
    ),
    el(
      "form",
      { method: "post", action: "/admin/flows/trigger-reconciliation", "data-flow": "trigger-reconciliation" },
      el("button", { type: "submit" }, text("Trigger manual reconciliation")),
    ),
    input.jobs.length === 0
      ? el("p", { class: "muted" }, text("No reconciliation jobs recorded."))
      : fragment(...input.jobs.map(jobCard)),
  );
}

function jobCard(job: ReconciliationJobResource): HtmlFragment {
  return el(
    "section",
    { class: "panel", "data-job-id": job.jobId, "data-job-status": job.status },
    fragment(
      el(
        "h3",
        {},
        fragment(text(`Job ${job.jobId} `), stateBadge(job.status)),
      ),
      el(
        "p",
        {},
        fragment(
          text("Trigger: "),
          stateBadge(job.trigger),
          text(" Created "),
          instantView(job.createdAt),
          job.startedAt === undefined ? text("") : fragment(text("; started "), instantView(job.startedAt)),
          job.completedAt === undefined
            ? text("")
            : fragment(text("; completed "), instantView(job.completedAt)),
        ),
      ),
      el(
        "p",
        { class: "muted" },
        text(
          `Command ${job.commandId}; correlation ${job.correlationId}; idempotency key ${job.idempotencyKey}`,
        ),
      ),
      job.actions.length === 0
        ? el("p", { class: "muted" }, text("No actions recorded."))
        : el(
            "table",
            { "data-job-actions": "true" },
            el(
              "thead",
              {},
              el(
                "tr",
                {},
                el("th", {}, text("Action")),
                el("th", {}, text("Outcome")),
                el("th", {}, text("Target")),
                el("th", {}, text("At")),
              ),
            ),
            el(
              "tbody",
              {},
              ...job.actions.map((action) =>
                el(
                  "tr",
                  { "data-action-outcome": action.outcome },
                  el("td", {}, text(action.actionType)),
                  el(
                    "td",
                    {},
                    healthBadge(OUTCOME_HEALTH[action.outcome] ?? "degraded"),
                  ),
                  el(
                    "td",
                    {},
                    text(
                      action.targetType === undefined || action.targetId === undefined
                        ? "-"
                        : `${action.targetType} / ${action.targetId}`,
                    ),
                  ),
                  el("td", {}, instantView(action.at)),
                ),
              ),
            ),
          ),
    ),
  );
}
