/**
 * The notifications page (RL-060): durable notifications with their source
 * durable RoamLink transition (never a raw provider payload), related
 * references with evidence summaries, and the recipient-scoped mark-read
 * command.
 */
import {
  emptyState,
  instantView,
  severityBadge,
  el,
  fragment,
  text,
  type HtmlFragment,
  type NotificationResource,
} from "@roamlink/app-kit";

import { pageHeading } from "../app.js";

export function notificationsPage(input: {
  readonly notifications: readonly NotificationResource[];
}): HtmlFragment {
  return fragment(
    pageHeading(
      "Notifications",
      "Emitted from RoamLink's own durable state transitions, with correlation back to the causing event.",
    ),
    input.notifications.length === 0
      ? emptyState("notifications")
      : fragment(...input.notifications.map((notification) => notificationCard(notification))),
    el(
      "form",
      { method: "post", action: "/flows/mark-notification-read", "data-flow": "mark-notification-read" },
      el("label", {}, text("Notification id ")),
      el("input", { type: "text", name: "notificationId", required: true }),
      el("button", { type: "submit" }, text("Mark read")),
    ),
  );
}

function notificationCard(notification: NotificationResource): HtmlFragment {
  return el(
    "section",
    {
      class: "panel",
      "data-notification-id": notification.notificationId,
      "data-notification-state": notification.state,
    },
    fragment(
      el(
        "h3",
        {},
        fragment(text(notification.title), text(" "), severityBadge(notification.severity)),
      ),
      el("p", {}, text(notification.body)),
      el(
        "p",
        { class: "muted" },
        text(
          `Topic ${notification.topic}; state ${notification.state}; created ${notification.createdAt}`,
        ),
      ),
      el(
        "p",
        {},
        fragment(
          text("Source: "),
          text(
            `${notification.source.aggregateType} ${notification.source.transition} (event ${notification.source.eventId}, occurred ${notification.source.occurredAt})`,
          ),
        ),
      ),
      notification.related.length === 0
        ? fragment()
        : el(
            "ul",
            {},
            ...notification.related.map((ref) =>
              el(
                "li",
                {},
                ref.evidence === undefined
                  ? text(`${ref.kind} ${ref.id}`)
                  : fragment(
                      text(`${ref.kind} ${ref.id} - evidence ${ref.evidence.evidenceClass} (${ref.evidence.freshnessState}, ${ref.evidence.canonicalResourceType} / ${ref.evidence.canonicalResourceId})`),
                    ),
              ),
            ),
          ),
      notification.channels.length === 0
        ? fragment()
        : el(
            "p",
            { class: "muted" },
            text(
              `Channels: ${notification.channels
                .map((channel) => `${channel.channel} ${channel.outcome}`)
                .join("; ")}`,
            ),
          ),
      el(
        "p",
        { class: "muted" },
        fragment(text("Last updated "), instantView(notification.updatedAt)),
      ),
    ),
  );
}
