/**
 * The Activity page (RL-085, spec/ux-architecture.md §8): the bridge
 * between invisible automation and user trust.
 *
 * Every entry answers the spec's questions — what happened, when, why,
 * what evidence supported it, whether RoamLink acted automatically, and
 * whether the customer needs to intervene — in honest chronological order,
 * each traceable to the durable record it came from (the recorded
 * transition, event id and related references with their evidence). The
 * narrative language ADDS explanation only: the authoritative record stays
 * visible, unknown transitions fall back to the honest "recorded change"
 * narrative, and commerce records never render as connectivity progress
 * (RL-LOCK-008). Empty states are honest, never fabricated.
 *
 * Pure function over parsed read models; no authority, no decisions.
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

import { pagePath } from "../routes.js";
import { DERIVED_EXPERIENCE_LANGUAGE } from "./language.js";
import { activityNarrativeFor, ACTIVITY_KIND_LANGUAGE } from "./language.js";
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

/** Newest first by the source event's occurredAt (deterministic tiebreak on id). */
function chronological(notifications: readonly NotificationResource[]): NotificationResource[] {
  return [...notifications].sort((a, b) => {
    const byTime = b.source.occurredAt.localeCompare(a.source.occurredAt);
    return byTime !== 0 ? byTime : a.notificationId.localeCompare(b.notificationId);
  });
}

/**
 * The evidence line for one entry: every related reference with its linked
 * evidence summary, so the customer can trace the claim back to its record.
 */
function evidenceLines(notification: NotificationResource): readonly string[] {
  const lines = notification.related.map((ref) => {
    if (ref.evidence === undefined) return `${ref.kind} ${ref.id}`;
    return `${ref.kind} ${ref.id} — evidence ${ref.evidence.evidenceClass}, freshness ${ref.evidence.freshnessState}`;
  });
  return lines;
}

function activityItem(notification: NotificationResource): HtmlFragment {
  const narrative = activityNarrativeFor(
    notification.source.aggregateType,
    notification.source.transition,
    notification.title,
  );
  const automatic = notification.source.origin === "roamlink_state_transition";
  const evidence = evidenceLines(notification);
  const needsYou = notification.state === "delivered";
  return el(
    "li",
    {
      class: "activity-item",
      "data-notification-id": notification.notificationId,
      "data-entry-kind": narrative.kind,
      "data-needs-you": needsYou ? "true" : "false",
    },
    fragment(
      el(
        "p",
        {},
        fragment(
          el(
            "span",
            { class: "kind-chip", "data-kind": narrative.kind },
            text(ACTIVITY_KIND_LANGUAGE[narrative.kind]),
          ),
          text(" "),
          severityBadge(notification.severity),
          text(` ${notification.title} `),
          stateBadge(notification.state),
        ),
      ),
      el("p", { class: "activity-what" }, text(narrative.whatHappened)),
      el("p", { class: "muted" }, text(notification.body)),
      el(
        "p",
        { class: "muted" },
        fragment(
          text("Recorded change: "),
          text(`${notification.source.aggregateType} ${notification.source.transition}`),
          text(` (event ${notification.source.eventId})`),
        ),
      ),
      evidence.length === 0
        ? fragment()
        : el(
            "ul",
            { class: "evidence-list", "data-evidence-lines": "true" },
            ...evidence.map((line) => el("li", {}, text(line))),
          ),
      el(
        "p",
        { class: "muted" },
        fragment(
          text(automatic
            ? "RoamLink acted automatically and recorded this itself. "
            : `Recorded from ${notification.source.origin}. `),
          text("Happened "),
          instantView(notification.source.occurredAt),
          text("."),
        ),
      ),
      needsYou
        ? el(
            "p",
            { class: "needs-you" },
            fragment(
              text("This needs your review. "),
              el("a", { href: pagePath("support") }, text("Get help")),
            ),
          )
        : fragment(),
    ),
  );
}

export function activityPage(input: ActivityPageInput): HtmlFragment {
  const items = chronological(input.notifications);
  const needsYou = (n: NotificationResource) => n.state === "delivered";
  const needsYouCount = items.filter(needsYou).length;
  const activeGoal = findActiveGoal(input.intents);

  return fragment(
    pageHeading(
      "Activity",
      "What RoamLink observed, did and recovered — in order, with the reason and the evidence behind every entry.",
    ),
    el(
      "section",
      { "data-activity-needs-you": "true" },
      el("h3", {}, text("Needs your attention")),
      needsYouCount === 0
        ? el(
            "p",
            { class: "muted", "data-nothing-needs-you": "true" },
            text("Nothing needs you right now."),
          )
        : el(
            "ul",
            { class: "activity-list", "aria-label": "Items that need your review" },
            ...items.filter(needsYou).map((n) => activityItem(n)),
          ),
    ),
    pageHeading("What RoamLink did"),
    items.length === 0
      ? el(
          "p",
          { class: "muted", "data-activity-empty": "true" },
          text(
            "Nothing yet — connect a device and choose a goal to begin. Every action RoamLink takes shows up here with its reason and its evidence.",
          ),
        )
      : fragment(
          el(
            "p",
            { class: "muted", "data-activity-summary": "true" },
            text(
              `${items.length} record${items.length === 1 ? "" : "s"}, newest first` +
                (needsYouCount > 0 ? `; ${needsYouCount} need${needsYouCount === 1 ? "s" : ""} your review.` : "."),
            ),
          ),
          el(
            "ul",
            {
              class: "activity-list",
              "data-activity-feed": "true",
              "aria-label": "Full activity timeline, newest first",
            },
            ...items.map((n) => activityItem(n)),
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
            el(
              "p",
              {},
              el("a", { href: pagePath("connectivity") }, text("See what this means for your connection")),
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
