/**
 * The Home page (RL-083): the customer's landing surface.
 *
 * Answers within one viewport (spec/ux-architecture.md §4):
 *   - Am I usefully connected?        -> the dominant hero (derived from the
 *     authoritative read model, facts shown, never one opaque badge)
 *   - What is my current goal?        -> the active goal in human language
 *   - Is RoamLink managing anything?  -> the explainable decision summary
 *   - Does RoamLink need me?          -> items that need attention
 *
 * Pure function over parsed API resources. The page NEVER decides outcomes:
 * every fact comes from the typed client reads; derived phrases are
 * presentation-only translations of authoritative values (language.ts), and
 * the authoritative value stays visible next to its human phrase.
 */
import {
  freshnessBadge,
  instantView,
  severityBadge,
  isUnavailableRead,
  unavailablePanelFor,
  el,
  fragment,
  text,
  type ConnectivityOverviewResource,
  type DeviceResource,
  type ExperienceIntentResource,
  type HtmlFragment,
  type IntentAccessClass,
  type NotificationResource,
  type ReadOrUnavailable,
} from "@roamlink/app-kit";

import {
  ACCESS_CLASS_LANGUAGE,
  DERIVED_EXPERIENCE_LANGUAGE,
} from "./language.js";

/** Maps a goal's access classes to human preference phrases. */
export function goalPreferences(classes: readonly IntentAccessClass[]): string {
  if (classes.length === 0) return "No preference recorded";
  return classes.map((c) => ACCESS_CLASS_LANGUAGE[c] ?? c).join("; ");
}

/** The active goal, if any: the active subject whose current version is active. */
export function findActiveGoal(
  intents: readonly ExperienceIntentResource[],
): ExperienceIntentResource | undefined {
  return intents.find(
    (intent) => intent.status === "active" && intent.currentVersion?.status === "active",
  );
}

function factCard(
  input: { readonly heading: string; readonly testid: string },
  body: HtmlFragment,
  action: HtmlFragment,
): HtmlFragment {
  return el(
    "section",
    { class: "home-fact", "data-home-fact": input.testid },
    fragment(
      el("h3", {}, text(input.heading)),
      body,
      el("p", { class: "home-fact-action" }, action),
    ),
  );
}

export interface HomePageInput {
  readonly connectivity: ConnectivityOverviewResource;
  readonly intents: readonly ExperienceIntentResource[];
  readonly devices: readonly DeviceResource[];
  /**
   * PA-020: the notification feed is a SECONDARY read on Home (the audit
   * journey's "Does RoamLink need you?" card). When its source refuses (the
   * typed 501 READ_MODEL_NOT_COMPOSED with its named reason, or any
   * unavailability-class typed error), that ONE card degrades to the quiet
   * unavailable panel - the hero and the goal/devices cards still render
   * from their own core reads. A core read failing keeps the page-level
   * fail-closed law.
   */
  readonly notifications: ReadOrUnavailable<readonly NotificationResource[]>;
}

export function homePage(input: HomePageInput): HtmlFragment {
  const overview = input.connectivity;
  const activeGoal = findActiveGoal(input.intents);
  const goalLanguage = activeGoal?.decision
    ? DERIVED_EXPERIENCE_LANGUAGE[activeGoal.decision.derivedStatus]
    : undefined;
  // PA-020: the attention card degrades alone when the notification feed is
  // unavailable; nothing below reads invented notification state.
  const notifications = input.notifications;
  const needsAttention = isUnavailableRead(notifications)
    ? []
    : notifications.filter((n) => n.state === "delivered");
  const criticalCount = needsAttention.filter((n) => n.severity !== "info").length;

  // The hero facts line: every state family named separately, never merged.
  const evidenced = overview.subjects.filter((s) => s.deliveryEvidenceState === "EVIDENCED");
  const unevidenced = overview.subjects.length - evidenced.length;
  const heroFacts =
    overview.subjects.length === 0
      ? "No connectivity reference is set up yet."
      : `${overview.subjects.length} active reference${overview.subjects.length === 1 ? "" : "s"}: ` +
        `${evidenced.length} with delivery evidence, ${unevidenced} without.`;

  return fragment(
    el(
      "section",
      { class: "home-hero", "data-home-hero": "true" },
      fragment(
        el("p", { class: "home-hero-kicker" }, text("Your connectivity")),
        el("h2", { class: "home-hero-headline" }, text(heroHeadline(overview))),
        el("p", { class: "home-hero-facts" }, text(heroFacts)),
        el(
          "p",
          { class: "home-hero-evidence" },
          text("Evidence freshness: "),
          evidenceFreshnessBadges(overview),
          text(" · presented "),
          instantView(overview.presentedAt),
        ),
        el(
          "p",
          {},
          el("a", { href: "/connectivity" }, text("See the full connectivity read")),
        ),
      ),
    ),
    el(
      "div",
      { class: "home-facts", "data-home-facts": "true" },
      factCard(
        { heading: "Your current goal", testid: "goal" },
        activeGoal?.currentVersion
          ? fragment(
              el("p", { class: "home-fact-primary" }, text(activeGoal.currentVersion.rationale)),
              goalLanguage
                ? el("p", { class: "home-fact-muted" }, text(goalLanguage))
                : fragment(),
              el("p", { class: "home-fact-muted" }, text(goalPreferences(activeGoal.currentVersion.accessClasses))),
            )
          : fragment(
              el("p", { class: "home-fact-muted" }, text("No goal chosen yet. Tell RoamLink what you want your connectivity to do for you.")),
            ),
        el("a", { href: activeGoal ? "/intents" : "/onboarding" }, text(activeGoal ? "Review your goal" : "Choose a goal")),
      ),
      factCard(
        { heading: "What RoamLink is doing", testid: "management" },
        activeGoal?.decision
          ? fragment(
              el("p", {}, text(DERIVED_EXPERIENCE_LANGUAGE[activeGoal.decision.derivedStatus])),
              el(
                "p",
                { class: "home-fact-muted" },
                fragment(
                  text("Status: "),
                  el("span", { class: "badge", "data-derived-status": activeGoal.decision.derivedStatus }, text(activeGoal.decision.derivedStatus)),
                  text(` · computed ${activeGoal.decision.computedAt}`),
                ),
              ),
            )
          : fragment(
              el("p", { class: "home-fact-muted" }, text("Nothing yet. RoamLink starts managing once you have a goal and a device.")),
            ),
        el("a", { href: "/activity" }, text("See what RoamLink did")),
      ),
      factCard(
        { heading: "Does RoamLink need you?", testid: "attention" },
        isUnavailableRead(notifications)
          ? unavailablePanelFor(notifications, {
              section: "home-attention",
              meaning:
                "RoamLink cannot show your attention items right now. Your connectivity, goal and devices on this page are unaffected, and Support is reachable from the navigation if you need help.",
            })
          : needsAttention.length === 0
            ? fragment(
                el("p", { class: "home-fact-muted" }, text("No. Nothing needs your attention right now.")),
              )
            : fragment(
                el(
                  "p",
                  {},
                  text(
                    `${needsAttention.length} item${needsAttention.length === 1 ? "" : "s"} need${needsAttention.length === 1 ? "s" : ""} your attention` +
                      (criticalCount > 0 ? ` (${criticalCount} warning or worse)` : "") +
                      ".",
                  ),
                ),
                el(
                  "ul",
                  { class: "home-fact-list" },
                  ...needsAttention.slice(0, 3).map((n) =>
                    el("li", {}, fragment(severityBadge(n.severity), text(` ${n.title}`))),
                  ),
                ),
              ),
        el("a", { href: "/activity" }, text("Open Activity")),
      ),
      factCard(
        { heading: "Your devices", testid: "devices" },
        input.devices.length === 0
          ? fragment(
              el("p", { class: "home-fact-muted" }, text("No devices enrolled yet.")),
            )
          : el(
              "ul",
              { class: "home-fact-list" },
              ...input.devices.slice(0, 4).map((device) =>
                el(
                  "li",
                  {},
                  fragment(
                    text(`${device.name} — capability `),
                    freshnessBadge(device.capabilityFreshness),
                  ),
                ),
              ),
            ),
        el("a", { href: "/devices" }, text("Manage devices")),
      ),
    ),
    input.devices.length === 0 && overview.subjects.length === 0 && input.intents.length === 0
      ? el(
          "section",
          { class: "home-getting-started", "data-getting-started": "true" },
          fragment(
            el("h3", {}, text("New to RoamLink?")),
            el(
              "p",
              {},
              text("Four short steps: tell us what you want, add a device, confirm your preferences."),
            ),
            el("p", {}, el("a", { href: "/onboarding" }, text("Get started"))),
          ),
        )
      : fragment(),
  );
}

/** The hero headline: derived language, still tied to the facts line below it. */
function heroHeadline(overview: ConnectivityOverviewResource): string {
  if (overview.subjects.length === 0) {
    return "RoamLink is not managing any connectivity yet.";
  }
  const anyFreshEvidenced = overview.subjects.some(
    (s) => s.deliveryEvidenceState === "EVIDENCED" && s.evidence?.freshness.freshnessState === "FRESH",
  );
  if (anyFreshEvidenced) {
    return "You are usefully connected — delivery evidence is fresh.";
  }
  const anyEvidenced = overview.subjects.some((s) => s.deliveryEvidenceState === "EVIDENCED");
  return anyEvidenced
    ? "Connectivity is delivering, but the evidence is not fresh. RoamLink is watching it."
    : "Connectivity is set up but not yet delivering. RoamLink has not received delivery evidence.";
}

function evidenceFreshnessBadges(overview: ConnectivityOverviewResource): HtmlFragment {
  const badges = overview.subjects.map((s) =>
    freshnessBadge(s.evidence?.freshness ?? null),
  );
  if (badges.length === 0) {
    return el("span", { class: "badge", "data-freshness": "UNKNOWN" }, text("UNKNOWN"));
  }
  return fragment(...badges);
}
