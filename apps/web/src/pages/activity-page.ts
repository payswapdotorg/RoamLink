/**
 * The Activity page (RL-083 shell destination; the full automation timeline
 * is RL-085).
 *
 * The bridge between invisible automation and user trust (spec
 * ux-architecture.md §8): each item answers what happened, when, why,
 * whether RoamLink acted automatically and whether the customer needs to
 * intervene. Built over the parsed read model: the durable notifications
 * (which keep their dedicated route/API for compatibility) plus the
 * explainable per-goal decision summaries. Pure function; no authority.
 */
import {
  instantView,
  severityBadge,
  stateBadge,
  el,
  fragment,
  text,
  type DeviceResource,
  type ExperienceIntentResource,
  type HtmlFragment,
  type NotificationResource,
} from "@roamlink/app-kit";

import { DERIVED_EXPERIENCE_LANGUAGE } from "./language.js";
import { findActiveGoal } from "./home-page.js";
import { pageHeading } from "../app.js";

export interface ActivityPageInput {
  readonly notifications: readonly NotificationResource[];
  readonly intents: readonly ExperienceIntentResource[];
  readonly devices: readonly DeviceResource[];
}

function deviceName(devices: readonly DeviceResource[], deviceId: string): string {
  return devices.find((d) => d.deviceId === deviceId)?.name ?? deviceId;
}

export function activityPage(input: ActivityPageInput): HtmlFragment {
  // Newest first by the source event's occurredAt (deterministic tiebreak on id).
  const items = [...input.notifications].sort((a, b) => {
    const byTime = b.source.occurredAt.localeCompare(a.source.occurredAt);
    return byTime !== 0 ? byTime : a.notificationId.localeCompare(b.notificationId);
  });
  const needsYou = (n: NotificationResource) => n.state === "delivered";
  const activeGoal = findActiveGoal(input.intents);

  return fragment(
    pageHeading(
      "Activity",
      "What RoamLink observed, did and recovered — and what needs you.",
    ),
    el(
      "section",
      { "data-activity-needs-you": "true" },
      el("h3", {}, text("Needs your attention")),
      items.some(needsYou)
        ? el(
            "ul",
            { class: "activity-list" },
            ...items.filter(needsYou).map((n) =>
              el(
                "li",
                { class: "activity-item", "data-needs-you": "true" },
                fragment(
                  el("p", {}, fragment(severityBadge(n.severity), text(` ${n.title}`))),
                  el("p", { class: "muted" }, text(n.body)),
                  el(
                    "p",
                    { class: "muted" },
                    fragment(
                      text(`Happened `),
                      instantView(n.source.occurredAt),
                      text(" — "),
                      el("a", { href: "/support" }, text("Get help")),
                    ),
                  ),
                ),
              ),
            ),
          )
        : el(
            "p",
            { class: "muted", "data-nothing-needs-you": "true" },
            text("Nothing needs you right now."),
          ),
    ),
    pageHeading("What RoamLink did"),
    items.length === 0
      ? el(
          "p",
          { class: "muted", "data-activity-empty": "true" },
          text("No activity yet. Once RoamLink starts managing your connectivity, every action shows up here with its reason."),
        )
      : el(
          "ul",
          { class: "activity-list", "data-activity-feed": "true" },
          ...items.map((n) =>
            el(
              "li",
              { class: "activity-item", "data-notification-id": n.notificationId },
              fragment(
                el(
                  "p",
                  {},
                  fragment(
                    severityBadge(n.severity),
                    text(` ${n.title} `),
                    stateBadge(n.state),
                  ),
                ),
                el("p", { class: "muted" }, text(n.body)),
                el(
                  "p",
                  { class: "muted" },
                  fragment(
                    text(`${n.source.transition} · happened `),
                    instantView(n.source.occurredAt),
                    n.state === "delivered" ? text(" · needs your review") : text(""),
                  ),
                ),
              ),
            ),
          ),
        ),
    pageHeading("Automation status"),
    activeGoal?.decision
      ? el(
          "section",
          { class: "panel", "data-automation-status": "true" },
          fragment(
            el(
              "p",
              {},
              fragment(
                text(`${deviceName(input.devices, activeGoal.deviceId)}: `),
                text(DERIVED_EXPERIENCE_LANGUAGE[activeGoal.decision.derivedStatus]),
              ),
            ),
            el(
              "p",
              { class: "muted" },
              text(
                `RoamLink evaluated this automatically (status ${activeGoal.decision.derivedStatus}, computed ${activeGoal.decision.computedAt}).`,
              ),
            ),
          ),
        )
      : el(
          "p",
          { class: "muted", "data-automation-idle": "true" },
          text("No goal is active yet, so RoamLink is not managing anything."),
        ),
  );
}
