/**
 * The overview page (RL-060): the customer's dashboard.
 *
 * Answers "what connectivity do I currently have?" through the aggregate
 * read (projections + observations + freshness, never collapsed) plus the
 * recent-notifications summary. Pure function over parsed resources.
 */
import {
  connectivityOverviewSection,
  emptyState,
  freshnessBadge,
  severityBadge,
  stateBadge,
  instantView,
  el,
  fragment,
  text,
  type ConnectivityOverviewResource,
  type HtmlFragment,
  type NotificationResource,
} from "@roamlink/app-kit";

import { pageHeading, tableWrap } from "../app.js";

export function overviewPage(input: {
  readonly connectivity: ConnectivityOverviewResource;
  readonly notifications: readonly NotificationResource[];
}): HtmlFragment {
  const unread = input.notifications.filter((n) => n.state === "delivered");
  return fragment(
    pageHeading(
      "Your connectivity, honestly",
      "Aggregated from authoritative projections, device observations and freshness metadata. Separate facts stay separate.",
    ),
    connectivityOverviewSection(input.connectivity),
    pageHeading("Recent notifications"),
    unread.length === 0
      ? emptyState("unread notifications")
      : tableWrap(
          "Unread notifications",
          el(
            "table",
            { "data-notifications": "true" },
            el(
              "thead",
              {},
              el(
                "tr",
                {},
                el("th", { scope: "col" }, text("Severity")),
                el("th", { scope: "col" }, text("Topic")),
                el("th", { scope: "col" }, text("Title")),
                el("th", { scope: "col" }, text("State")),
              ),
            ),
            el(
              "tbody",
              {},
              ...unread.map((notification) =>
                el(
                  "tr",
                  {},
                  el("td", {}, severityBadge(notification.severity)),
                  el("td", {}, text(notification.topic)),
                  el("td", {}, text(notification.title)),
                  el("td", {}, stateBadge(notification.state)),
                ),
              ),
            ),
          ),
        ),
    pageHeading("Device observation freshness"),
    el(
      "ul",
      {},
      ...input.connectivity.deviceObservations.map((observation) =>
        el(
          "li",
          {},
          fragment(
            text(`${observation.deviceName}: capability `),
            freshnessBadge(observation.capabilityFreshness),
            text(", context "),
            freshnessBadge(observation.contextFreshness),
            text(" (last observed "),
            instantView(observation.lastObservedAt),
            text(")"),
          ),
        ),
      ),
    ),
  );
}
