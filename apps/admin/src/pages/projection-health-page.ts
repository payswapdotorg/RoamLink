/**
 * The projection freshness/health dashboard (RL-061): the observability SLO
 * surfaces. Every projection row shows its freshness facts (FRESH / STALE /
 * UNKNOWN - unknown is a valid state and is displayed, never hidden), and
 * the SLO table shows burn rate and remaining budget. `no-data` SLOs render
 * as degraded (never silently healthy - fail-safe defaults,
 * spec/security.md).
 */
import {
  freshnessBadge,
  healthBadge,
  instantView,
  el,
  fragment,
  text,
  type HtmlFragment,
  type ProjectionHealthResource,
} from "@roamlink/app-kit";

import { pageHeading } from "../page-kit.js";

export function projectionHealthPage(input: {
  readonly health: ProjectionHealthResource;
}): HtmlFragment {
  return fragment(
    pageHeading(
      "Projection health",
      "ADCOS-derived projections with provenance, freshness and evidence. Stale/unknown projections are degraded, never guessed healthy.",
    ),
    el(
      "p",
      {},
      fragment(
        text("Overall: "),
        healthBadge(input.health.overallHealth),
        text(" presented at "),
        instantView(input.health.presentedAt),
      ),
    ),
    pageHeading("Projections"),
    input.health.projections.length === 0
      ? el("p", { class: "muted" }, text("No projections recorded."))
      : el(
          "table",
          { "data-projections": "true" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, text("Projection")),
              el("th", {}, text("Canonical resource")),
              el("th", {}, text("Freshness")),
              el("th", {}, text("Observed")),
              el("th", {}, text("Fresh until")),
              el("th", {}, text("Evidence class")),
              el("th", {}, text("Version")),
            ),
          ),
          el(
            "tbody",
            {},
            ...input.health.projections.map((projection) =>
              el(
                "tr",
                {
                  "data-projection-id": projection.projectionId,
                  "data-projection-freshness": projection.freshness.freshnessState,
                },
                el("td", {}, text(projection.projectionId)),
                el(
                  "td",
                  {},
                  text(`${projection.canonicalResourceType} / ${projection.canonicalResourceId}`),
                ),
                el("td", {}, freshnessBadge(projection.freshness)),
                el("td", {}, instantView(projection.freshness.observedAt)),
                el("td", {}, instantView(projection.freshness.freshUntil)),
                el("td", {}, text(projection.evidenceClass)),
                el("td", {}, text(projection.projectionVersion)),
              ),
            ),
          ),
        ),
    pageHeading("Service level objectives"),
    input.health.slos.length === 0
      ? el("p", { class: "muted" }, text("No SLOs registered."))
      : el(
          "table",
          { "data-slos": "true" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, text("SLO")),
              el("th", {}, text("State")),
              el("th", {}, text("Events (bad/total)")),
              el("th", {}, text("Burn rate")),
              el("th", {}, text("Budget remaining")),
            ),
          ),
          el(
            "tbody",
            {},
            ...input.health.slos.map((slo) =>
              el(
                "tr",
                { "data-slo-name": slo.name, "data-slo-state": slo.state },
                el("td", {}, text(slo.name)),
                el(
                  "td",
                  {},
                  healthBadge(
                    slo.state === "within-budget"
                      ? "healthy"
                      : "degraded",
                  ),
                ),
                el("td", {}, text(`${slo.bad}/${slo.total}`)),
                el(
                  "td",
                  {},
                  slo.burnRate === null ? text("n/a (no data)") : text(slo.burnRate.toFixed(4)),
                ),
                el(
                  "td",
                  {},
                  slo.budgetRemainingRatio === null
                    ? text("n/a (no data)")
                    : text(slo.budgetRemainingRatio.toFixed(4)),
                ),
              ),
            ),
          ),
        ),
    el(
      "p",
      { class: "muted" },
      text("no-data is never healthy: an SLO with no events renders degraded (fail-safe defaults)."),
    ),
  );
}
