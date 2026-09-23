/**
 * The ADCOS integration-health surface (PA-010, closes RL-115-F6).
 *
 * spec/ux-architecture.md §13 ("integration/compatibility health") and the
 * RL-115 audit's CAP-D-COMPAT row: the env-gated compatibility probe (RL-108)
 * runs host-side, but its outcome had no admin-facing surface. This page IS
 * that surface — fed by the probe's fail-closed recorded state through the
 * application contract's integration-health read.
 *
 * READ-ONLY BY CONSTRUCTION:
 *  - it renders what the probe RECORDED (compatible/incompatible with the
 *    report's checks, or the honest not-configured/unknown states) — never a
 *    live probe run, never a compatibility mutation;
 *  - the mutation gate itself stays inside the ADCOS integration boundary
 *    (spec/adcos-integration.md §9): this page displays the gate's recorded
 *    effect ("mutations allowed" / "mutations fail closed"), it never holds it;
 *  - not configured is a first-class honest state — no fabricated
 *    compatibility value is ever rendered (the fake, the real runtime and the
 *    wire parser all enforce the same cross-field honesty invariants);
 *  - freshness pairs with the state: the recorded last-checked instant
 *    renders beside it, and "never checked" renders when no report exists.
 */
import {
  el,
  fragment,
  instantView,
  text,
  type HtmlFragment,
  type IntegrationHealthResource,
} from "@roamlink/app-kit";

import { pageHeading } from "../page-kit.js";

/** The human labels for the closed four-state vocabulary (§14: text, not color). */
const STATE_LABELS: Readonly<Record<IntegrationHealthResource["state"], string>> = Object.freeze({
  "compatible": "Compatible",
  "incompatible": "Incompatible",
  "not-configured": "Not configured",
  "unknown": "Unknown",
});

/** The honest per-state explanation (rendered with the state, never instead of it). */
const STATE_EXPLANATIONS: Readonly<Record<IntegrationHealthResource["state"], string>> = Object.freeze({
  "compatible":
    "The probe recorded a passing report: the endpoint answered the pinned contract and every check passed. Mutations are allowed through the ADCOS integration boundary.",
  "incompatible":
    "The probe recorded failed checks — mutations fail closed through the ADCOS integration boundary until a compatible report is recorded. The failed checks below are the diagnosis (names and codes only; values are never echoed).",
  "not-configured":
    "The ADCOS probe environment is not configured on this deployment (the ADCOS_* env keys are absent), so no compatibility claim is made — the probe never blocks local/CI runs. This is an honest first-class state, not a failure.",
  "unknown":
    "The compatibility gate has not recorded a report — the fail-closed default. Mutations are refused until a startup compatibility check passes (spec/adcos-integration.md §9).",
});

export function integrationHealthPage(input: {
  readonly health: IntegrationHealthResource;
}): HtmlFragment {
  const { health } = input;
  const reportRecorded = health.state === "compatible" || health.state === "incompatible";
  const failedChecks = health.checks.filter((check) => !check.passed);
  return fragment(
    pageHeading(
      "Integration health",
      "The ADCOS compatibility probe's recorded outcome (RL-108): compatibility against the supported ADCOS API contract. Read-only — this surface never triggers the probe and never changes compatibility state.",
    ),
    el(
      "p",
      { "data-integration-health": "true" },
      fragment(
        text("ADCOS compatibility: "),
        el(
          "span",
          { class: "badge", "data-integration-state": health.state },
          text(STATE_LABELS[health.state]),
        ),
        text(" "),
        el(
          "span",
          {
            class: "badge",
            "data-mutations": health.mutationsAllowed ? "allowed" : "fail-closed",
          },
          text(health.mutationsAllowed ? "mutations allowed" : "mutations fail closed"),
        ),
      ),
    ),
    el(
      "p",
      { "data-integration-state-explanation": health.state },
      text(STATE_EXPLANATIONS[health.state]),
    ),
    pageHeading("Recorded facts"),
    el(
      "ul",
      { class: "facts", "data-integration-facts": "true" },
      el(
        "li",
        { "data-fact": "supported-api-version" },
        fragment(text("Supported ADCOS API version: "), text(health.supportedApiVersion), text(" (the single-site pin)")),
      ),
      el(
        "li",
        { "data-fact": "last-checked" },
        fragment(
          text("Last checked: "),
          reportRecorded && health.lastCheckedAt !== null
            ? el("span", { "data-last-checked": health.lastCheckedAt }, instantView(health.lastCheckedAt))
            : el("span", { class: "muted", "data-never-checked": "true" }, text("never checked (no report recorded)")),
        ),
      ),
      el(
        "li",
        { "data-fact": "suite-version" },
        fragment(
          text("Probe suite version: "),
          health.suiteVersion !== null ? text(health.suiteVersion) : el("span", { class: "muted" }, text("n/a (no report recorded)")),
        ),
      ),
      el(
        "li",
        { "data-fact": "presented-at" },
        fragment(text("Presented at: "), instantView(health.presentedAt)),
      ),
    ),
    pageHeading("Compatibility checks"),
    !reportRecorded
      ? el(
          "p",
          { class: "muted", "data-compat-checks": "none" },
          text("No probe report is recorded, so there are no checks to show — never a guessed outcome."),
        )
      : el(
          "table",
          { "data-compat-checks": "true" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, text("Check")),
              el("th", {}, text("Outcome")),
              el("th", {}, text("Code")),
              el("th", {}, text("Detail")),
            ),
          ),
          el(
            "tbody",
            {},
            ...health.checks.map((check) =>
              el(
                "tr",
                { "data-check-name": check.name, "data-check-passed": check.passed ? "true" : "false" },
                el("td", {}, text(check.name)),
                el("td", {}, text(check.passed ? "passed" : "FAILED")),
                el("td", {}, check.code !== null ? text(check.code) : el("span", { class: "muted" }, text("-"))),
                el("td", {}, text(check.detail)),
              ),
            ),
          ),
        ),
    health.state === "incompatible"
      ? el(
          "div",
          { class: "panel error", "data-failure-explanation": "true" },
          fragment(
            el("h3", {}, text("Why the probe recorded incompatible")),
            el(
              "p",
              {},
              text(
                `${failedChecks.length} of ${health.checks.length} recorded checks failed. Mutations fail closed until a compatible report is recorded; re-run the deployment probe (services/workers adcos:probe) to record a fresh outcome.`,
              ),
            ),
            el(
              "ul",
              {},
              ...failedChecks.map((check) =>
                el(
                  "li",
                  { "data-failed-check": check.name },
                  text(
                    `${check.name}${check.code !== null ? ` (${check.code})` : ""}: ${check.detail}`,
                  ),
                ),
              ),
            ),
          ),
        )
      : fragment(),
    el(
      "p",
      { class: "muted" },
      text(
        "Read-only surface: the mutation gate lives inside the ADCOS integration boundary (spec/adcos-integration.md §9); this page renders the recorded state and claims nothing the probe did not record.",
      ),
    ),
  );
}
