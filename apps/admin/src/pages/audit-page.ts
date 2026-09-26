/**
 * The audit/security event review page (RL-061): the append-only event
 * stream from the audit read models, with the digest-chain verification
 * banner and the closed category filter. Every event shows actor, tenant,
 * correlation (+command when applicable), outcome and target - the review
 * surface for security-relevant mutations (spec/security.md "Audit").
 */
import {
  healthBadge,
  instantView,
  isUnavailableRead,
  stateBadge,
  unavailablePanelFor,
  el,
  fragment,
  text,
  type AuditEventListResource,
  type HtmlFragment,
  type ReadOrUnavailable,
} from "@roamlink/app-kit";

import { pageHeading } from "../page-kit.js";

const CATEGORIES = ["auth", "secret-access", "authority-decision", "admin-override"] as const;

export function auditPage(input: {
  /**
   * PA-020: the audit event read is the page's data-plane read. When its
   * source refuses (the typed 501 with its named reason, or any
   * unavailability-class typed error), the event section degrades to the
   * quiet unavailable panel - the console navigation and every healthy
   * diagnostic page stay usable.
   */
  readonly audit: ReadOrUnavailable<AuditEventListResource>;
  readonly activeCategory?: (typeof CATEGORIES)[number];
}): HtmlFragment {
  if (isUnavailableRead(input.audit)) {
    return fragment(
      pageHeading(
        "Audit & security events",
        "The append-only, digest-chained record of security-relevant actions. Tampering with any recorded field breaks the chain at the first modified event.",
      ),
      unavailablePanelFor(input.audit, {
        section: "audit-events",
        meaning:
          "The audit event record cannot be shown right now. The rest of the console stays usable from the navigation above, and this page will show the record again once its source answers.",
      }),
    );
  }
  const chain = input.audit.chain;
  return fragment(
    pageHeading(
      "Audit & security events",
      "The append-only, digest-chained record of security-relevant actions. Tampering with any recorded field breaks the chain at the first modified event.",
    ),
    el(
      "div",
      {
        class: chain.verified ? "panel ok" : "panel error",
        "data-chain-verified": chain.verified ? "true" : "false",
        ...(chain.verifiedCount !== undefined ? { "data-chain-count": chain.verifiedCount } : {}),
        ...(chain.brokenAtSequence !== undefined
          ? { "data-chain-broken-at": chain.brokenAtSequence }
          : {}),
      },
      chain.verified
        ? text(
            `Digest chain verified end-to-end (${chain.verifiedCount ?? 0} events).`,
          )
        : text(
            `DIGEST CHAIN BROKEN at sequence ${chain.brokenAtSequence ?? "?"} - events after this point are untrustworthy.`,
          ),
    ),
    el(
      "form",
      { method: "get", action: "/admin/audit", "data-flow": "audit-filter" },
      el("label", {}, text("Category ")),
      el(
        "select",
        { name: "category" },
        el("option", { value: "" }, text("all categories")),
        ...CATEGORIES.map((category) =>
          el(
            "option",
            { value: category, ...(input.activeCategory === category ? { selected: true } : {}) },
            text(category),
          ),
        ),
      ),
      el("button", { type: "submit" }, text("Filter")),
    ),
    input.audit.events.length === 0
      ? el("p", { class: "muted" }, text("No events match the current filter."))
      : el(
          "table",
          { "data-audit-events": "true" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, text("Seq")),
              el("th", {}, text("Occurred")),
              el("th", {}, text("Category")),
              el("th", {}, text("Action")),
              el("th", {}, text("Outcome")),
              el("th", {}, text("Actor")),
              el("th", {}, text("Correlation")),
              el("th", {}, text("Target")),
              el("th", {}, text("Digest (chain)")),
            ),
          ),
          el(
            "tbody",
            {},
            ...input.audit.events.map((event) =>
              el(
                "tr",
                {
                  "data-audit-sequence": event.sequence,
                  "data-audit-outcome": event.outcome,
                },
                el("td", {}, text(event.sequence)),
                el("td", {}, instantView(event.occurredAt)),
                el("td", {}, stateBadge(event.category)),
                el("td", {}, text(event.action)),
                el(
                  "td",
                  {},
                  event.outcome === "allowed"
                    ? healthBadge("healthy")
                    : event.outcome === "denied"
                      ? healthBadge("degraded")
                      : stateBadge(event.outcome),
                ),
                el("td", {}, text(event.actorId)),
                el(
                  "td",
                  {},
                  text(
                    event.commandId === undefined
                      ? event.correlationId
                      : `${event.correlationId} (cmd ${event.commandId})`,
                  ),
                ),
                el("td", {}, text(event.target ?? "-")),
                el(
                  "td",
                  {},
                  el("code", {}, text(`${event.digest.slice(0, 12)}...`)),
                ),
              ),
            ),
          ),
        ),
    el(
      "p",
      { class: "muted" },
      text("Denied admin commands appear here with outcome 'denied' - the review surface for privilege-escalation attempts."),
    ),
  );
}
