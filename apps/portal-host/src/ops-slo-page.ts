/**
 * The operator SLO dashboard surface (RL-109) — the HOST-SIDE ops surface.
 *
 * See `./slo.ts` for the architecture decision and its trade-off (in short:
 * the admin console's /v1 read routes answer the honest 501
 * READ_MODEL_NOT_COMPOSED on the real runtime, and this item must not invent
 * read models — so the surface consumes the observability package through
 * the host composition directly).
 *
 * THE HONESTY LAW of this surface: every number is the REAL recorder state
 * evaluated at the render instant — the closed §11 vocabulary
 * (within-budget | at-risk | exhausted | no-data), the REAL event counts,
 * burn rates and budget remainders, and the multi-window burn-rate pairing.
 * Zero mocked numbers, zero invented read models. An unconfigured id
 * renders as `not budgeted` (never a fabricated classification); a
 * no-data budgeted SLO renders DEGRADED (never silently healthy — fail-safe
 * defaults). The surface is read-only: it invents no state, commands
 * nothing, and leaks nothing (RL-LOCK-016 — counters/ratios only).
 */
import {
  el,
  fragment,
  healthBadge,
  htmlDocument,
  instantView,
  pageShell,
  text,
  type HtmlFragment,
} from "@roamlink/app-kit";
import type { SloDashboardSnapshot, SloDashboardRow } from "@roamlink/observability";

function stateCell(row: SloDashboardRow): HtmlFragment {
  if (!row.budgeted || row.healthState === null || row.evaluation === null) {
    return el("td", {}, text("not budgeted"));
  }
  // The SLO state rides the row (data-slo-state) and the health-vocabulary
  // badge carries the composed truth; no-data shows its own label so an
  // operator can tell "no events yet" from "burning budget".
  const label =
    row.evaluation.state === "no-data" ? "no-data (degraded)" : row.evaluation.state;
  return el("td", {}, healthBadge(row.healthState), text(` ${label}`));
}

function ratio(value: number | null, digits = 4): string {
  return value === null ? "n/a (no data)" : value.toFixed(digits);
}

/**
 * Renders the SLO dashboard BODY (the caller wraps it in the document
 * shell). `snapshot` is the real evaluation; nothing here mutates state.
 */
export function opsSloSurfaceBody(input: {
  readonly snapshot: SloDashboardSnapshot;
}): HtmlFragment {
  const { snapshot } = input;
  return fragment(
    el("h2", {}, text("Service level objectives (§11)")),
    el(
      "p",
      {},
      fragment(
        text("Overall: "),
        healthBadge(snapshot.overall),
        text(` — evaluated at `),
        instantView(snapshot.asOf),
        text(
          snapshot.budgetedCount === 0
            ? ` — no objectives are configured for this deployment (${SLO_OBJECTIVES_ENV_HINT}); every row below is honestly measured-only.`
            : ` over ${snapshot.budgetedCount} configured objective(s).`,
        ),
      ),
    ),
    el(
      "table",
      { "data-slo-dashboard": "true" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, text("§11 SLO")),
          el("th", {}, text("State")),
          el("th", {}, text("Target")),
          el("th", {}, text("Events (good/total)")),
          el("th", {}, text("Burn rate")),
          el("th", {}, text("Budget remaining")),
          el("th", {}, text("Windows (5m / 1h / 30m / 6h)")),
        ),
      ),
      el(
        "tbody",
        {},
        ...snapshot.rows.map((row) =>
          el(
            "tr",
            {
              "data-slo-id": row.id,
              "data-slo-state": row.evaluation?.state ?? "not-budgeted",
            },
            el("td", {}, text(row.id)),
            stateCell(row),
            el(
              "td",
              {},
              text(row.targetRatio === null ? "—" : `${(row.targetRatio * 100).toFixed(3)}% / ${humanWindow(row.windowMs)}`),
            ),
            el(
              "td",
              {},
              text(
                row.evaluation === null
                  ? "—"
                  : `${row.evaluation.good}/${row.evaluation.total}`,
              ),
            ),
            el("td", {}, text(ratio(row.evaluation?.burnRate ?? null))),
            el("td", {}, text(ratio(row.evaluation?.budgetRemainingRatio ?? null))),
            el(
              "td",
              {},
              text(
                row.budgeted
                  ? row.windows
                      .map((window) =>
                        window.burnRate === null
                          ? `${window.label}: n/a (no data)`
                          : `${window.label}: ${window.burnRate.toFixed(4)}`,
                      )
                      .join(" / ")
                  : "—",
              ),
            ),
          ),
        ),
      ),
    ),
    el(
      "p",
      { class: "muted" },
      text(
        "no-data is never healthy: a budgeted SLO with no events in its window renders degraded (fail-safe defaults). The nine rows are the §11 product SLOs of spec/architecture.md; the recorder primitives are the frozen observability seams (RL-052), this surface only reads them (RL-109).",
      ),
    ),
  );
}

/** The full document for the host-side ops surface (session-gated upstream). */
export function opsSloSurfaceDocument(input: {
  readonly snapshot: SloDashboardSnapshot;
}): string {
  return htmlDocument(
    "RoamLink Ops - SLO dashboard",
    pageShell({
      appTitle: "RoamLink Ops",
      navLinks: [{ label: "SLO dashboard", href: "/ops/slo" }],
      main: opsSloSurfaceBody({ snapshot: input.snapshot }),
      footerNote:
        "RoamLink ops surface (RL-109, host-side): real recorder state over the frozen observability seams; targets are deployment configuration, never invented defaults.",
    }),
  ).html;
}

/** The env hint (the key name only — values are never rendered, RL-LOCK-016). */
const SLO_OBJECTIVES_ENV_HINT = "ROAMLINK_SLO_OBJECTIVES";

function humanWindow(windowMs: number | null): string {
  if (windowMs === null) return "—";
  if (windowMs % 3_600_000 === 0) return `${windowMs / 3_600_000}h`;
  if (windowMs % 60_000 === 0) return `${windowMs / 60_000}m`;
  return `${windowMs}ms`;
}
