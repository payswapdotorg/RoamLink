/**
 * The notifications page (RL-085 digest companion; route/API kept for
 * compatibility per spec/ux-architecture.md §8).
 *
 * The digest groups the durable notifications honestly: what needs the
 * customer's review first, then what has been read, then everything else.
 * Each notification keeps its full traceability — the durable RoamLink
 * transition it was emitted from (never a raw provider payload), its
 * related references with evidence summaries, and its channel outcomes —
 * and the recipient-scoped mark-read command rides the same flow as
 * everywhere else (one form per item; no raw ids to copy).
 */
import {
  instantView,
  severityBadge,
  stateBadge,
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
  const needsReview = input.notifications.filter((n) => n.state === "delivered");
  const read = input.notifications.filter((n) => n.state === "read");
  const rest = input.notifications.filter(
    (n) => n.state !== "delivered" && n.state !== "read",
  );

  return fragment(
    pageHeading(
      "Notifications",
      "Everything RoamLink has told you, emitted from its own recorded state changes — Activity is the full story.",
    ),
    input.notifications.length === 0
      ? el(
          "p",
          { class: "muted", "data-notifications-empty": "true" },
          text("No notifications yet. When RoamLink does something on your behalf, you will hear about it here."),
        )
      : fragment(
          el(
            "p",
            { class: "muted", "data-notification-digest": "true" },
            text(
              `${input.notifications.length} notification${input.notifications.length === 1 ? "" : "s"}: ` +
                `${needsReview.length} need${needsReview.length === 1 ? "s" : ""} your review, ` +
                `${read.length} read` +
                (rest.length > 0 ? `, ${rest.length} in other states.` : "."),
            ),
          ),
          digestSection("Needs your review", needsReview, "needs-review"),
          digestSection("Already read", read, "read"),
          digestSection("Everything else", rest, "other"),
        ),
  );
}

function digestSection(
  heading: string,
  items: readonly NotificationResource[],
  digestKind: string,
): HtmlFragment {
  if (items.length === 0) return fragment();
  return el(
    "section",
    { "data-digest-kind": digestKind },
    el("h3", {}, text(heading)),
    el(
      "ul",
      { class: "activity-list" },
      ...items.map((notification) => digestItem(notification)),
    ),
  );
}

function digestItem(notification: NotificationResource): HtmlFragment {
  return el(
    "li",
    { class: "activity-item", "data-notification-id": notification.notificationId },
    fragment(
      el(
        "p",
        {},
        fragment(
          severityBadge(notification.severity),
          text(` ${notification.title} `),
          stateBadge(notification.state),
        ),
      ),
      el("p", {}, text(notification.body)),
      el(
        "p",
        { class: "muted" },
        text(
          `Topic ${notification.topic}; created ${notification.createdAt}`,
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
            { class: "evidence-list" },
            ...notification.related.map((ref) =>
              el(
                "li",
                {},
                ref.evidence === undefined
                  ? text(`${ref.kind} ${ref.id}`)
                  : fragment(
                      text(
                        `${ref.kind} ${ref.id} - evidence ${ref.evidence.evidenceClass} (${ref.evidence.freshnessState}, observed ${ref.evidence.observedAt ?? "never"})`,
                      ),
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
      notification.state === "delivered"
        ? el(
            "form",
            {
              method: "post",
              action: "/flows/mark-notification-read",
              "data-flow": "mark-notification-read",
            },
            el("input", {
              type: "hidden",
              name: "notificationId",
              value: notification.notificationId,
            }),
            el("button", { type: "submit" }, text("Mark as read")),
          )
        : fragment(),
    ),
  );
}
