/**
 * The Connectivity Center (RL-084, spec/ux-architecture.md §6): the
 * product's primary explanation surface.
 *
 * It exposes, with progressive disclosure (Summary -> Why -> Evidence ->
 * Technical detail):
 *   - the current connectivity facts, per subject, each state family
 *     rendered separately (never one opaque combined badge);
 *   - the authoritative lifecycle as the user-visible journey
 *     (observed -> requested -> accepted -> reserved -> path active ->
 *     delivery -> recovered), derived ONLY from projection state by
 *     lifecycle.ts;
 *   - source/evidence and freshness;
 *   - active and recent access (device observations + recent connectivity
 *     events from the durable notification record);
 *   - why RoamLink is taking an action, what it is waiting for, and what
 *     the customer can do next;
 *   - the support escape hatch on every degraded state.
 *
 * The page NEVER invents connectivity state and never speaks ADCOS: it
 * renders the RoamLink read models through the shared presentation
 * language. Commerce facts (commercial state) render labeled as commercial
 * facts and are never folded into the connectivity narrative
 * (RL-LOCK-008).
 */
import {
  SHELL_CONNECTIVITY_LANGUAGE,
  deliveryEvidenceBadge,
  deriveShellConnectivityState,
  freshnessBadge,
  instantView,
  stateBadge,
  el,
  fragment,
  text,
  type ConnectivityOverviewResource,
  type HtmlFragment,
  type NotificationResource,
  type SubjectConnectivityResource,
} from "@roamlink/app-kit";

import { pagePath } from "../routes.js";
import { pageHeading } from "../app.js";
import {
  CONNECTION_STAGE_LANGUAGE,
  CONNECTION_STAGE_STATE_LANGUAGE,
  CONNECTIVITY_WHY_LANGUAGE,
  DELIVERY_EVIDENCE_LANGUAGE,
  REFERENCE_STATUS_LANGUAGE,
} from "./language.js";
import { deriveConnectionJourney, isDegradedShellState } from "./lifecycle.js";

export interface ConnectivityCenterInput {
  readonly connectivity: ConnectivityOverviewResource;
  readonly notifications: readonly NotificationResource[];
}

// --------------------------------------------------------------------------------
// Subject-level rendering (the summary layer)
// --------------------------------------------------------------------------------

function subjectSummaryCard(subject: SubjectConnectivityResource): HtmlFragment {
  const reference = REFERENCE_STATUS_LANGUAGE[subject.referenceStatus] ?? subject.referenceStatus;
  const evidence = DELIVERY_EVIDENCE_LANGUAGE[subject.deliveryEvidenceState] ?? subject.deliveryEvidenceState;
  return el(
    "section",
    {
      class: "panel",
      "data-connectivity-subject": "true",
      "data-subject-type": subject.subjectType,
      "data-subject-id": subject.subjectId,
    },
    fragment(
      el("h3", {}, text(`${subject.subjectType === "order" ? "Order" : "Subscription"} reference`)),
      el("p", { class: "muted" }, text(`Reference ${subject.subjectId}`)),
      el(
        "dl",
        { class: "fact-list" },
        el(
          "div",
          { class: "fact-row" },
          el("dt", {}, text("Delivery")),
          el(
            "dd",
            {},
            fragment(
              deliveryEvidenceBadge(subject.deliveryEvidenceState),
              text(` ${evidence}`),
            ),
          ),
        ),
        el(
          "div",
          { class: "fact-row" },
          el("dt", {}, text("Reference")),
          el("dd", {}, fragment(stateBadge(subject.referenceStatus), text(` ${reference}`))),
        ),
        el(
          "div",
          { class: "fact-row" },
          el("dt", {}, text("Evidence freshness")),
          el(
            "dd",
            {},
            fragment(
              freshnessBadge(subject.evidence?.freshness ?? null),
              subject.evidence === null
                ? text("")
                : text(" (freshness of the linked delivery evidence)"),
            ),
          ),
        ),
        el(
          "div",
          { class: "fact-row" },
          el("dt", {}, text("Commercial fact (separate)")),
          el(
            "dd",
            {},
            fragment(
              stateBadge(subject.commercialState),
              text(" — this is the commerce state; it never stands in for delivery"),
            ),
          ),
        ),
      ),
    ),
  );
}

// --------------------------------------------------------------------------------
// The journey (the narrative layer)
// --------------------------------------------------------------------------------

function journeySection(overview: ConnectivityOverviewResource): HtmlFragment {
  const journey = deriveConnectionJourney(overview);
  return el(
    "section",
    { "data-connection-journey": "true" },
    fragment(
      pageHeading(
        "Your connection journey",
        "Where your connection really is, stage by stage — only what delivery evidence and device observations confirm is marked confirmed.",
      ),
      el(
        "ol",
        { class: "journey" },
        ...journey.stages.map((stage) => {
          const language = CONNECTION_STAGE_LANGUAGE[stage.stage];
          return el(
            "li",
            {
              class: "journey-stage",
              "data-lifecycle-stage": stage.stage,
              "data-lifecycle-state": stage.state,
            },
            fragment(
              el(
                "p",
                { class: "journey-headline" },
                fragment(
                  el("strong", {}, text(language.label)),
                  text(" — "),
                  el(
                    "span",
                    { class: "journey-state", "data-state-word": stage.state },
                    text(CONNECTION_STAGE_STATE_LANGUAGE[stage.state]),
                  ),
                ),
              ),
              el("p", { class: "muted" }, text(language.explanation)),
              ...stage.facts.map((fact) => el("p", { class: "journey-fact" }, text(fact))),
            ),
          );
        }),
      ),
    ),
  );
}

function waitingAndNextSections(overview: ConnectivityOverviewResource): HtmlFragment {
  const state = deriveShellConnectivityState(overview.subjects);
  const narrative = CONNECTIVITY_WHY_LANGUAGE[state];
  return el(
    "section",
    { "data-connectivity-next": "true", "data-shell-state": state },
    fragment(
      pageHeading("What happens next"),
      el(
        "dl",
        { class: "fact-list" },
        el(
          "div",
          { class: "fact-row" },
          el("dt", {}, text("Why RoamLink is doing this")),
          el("dd", {}, text(narrative.why)),
        ),
        el(
          "div",
          { class: "fact-row" },
          el("dt", {}, text("What RoamLink is waiting for")),
          el("dd", {}, text(narrative.waitingFor)),
        ),
        el(
          "div",
          { class: "fact-row" },
          el("dt", {}, text("What you can do")),
          el("dd", {}, text(narrative.nextStep)),
        ),
      ),
      isDegradedShellState(state)
        ? el(
            "p",
            { class: "support-escape", "data-support-escape": "true" },
            el("a", { href: pagePath("support") }, text("Get help with this")),
          )
        : fragment(),
      state === "no-reference"
        ? el(
            "p",
            {},
            el("a", { href: pagePath("onboarding") }, text("Start with a goal")),
          )
        : fragment(),
    ),
  );
}

// --------------------------------------------------------------------------------
// Progressive disclosure layers
// --------------------------------------------------------------------------------

function whyDisclosure(overview: ConnectivityOverviewResource): HtmlFragment {
  const state = deriveShellConnectivityState(overview.subjects);
  const narrative = CONNECTIVITY_WHY_LANGUAGE[state];
  return el(
    "details",
    { class: "disclosure", "data-disclosure": "why" },
    fragment(
      el("summary", {}, text("Why is RoamLink doing this?")),
      el("p", {}, text(narrative.why)),
      el(
        "p",
        { class: "muted" },
        text(
          "This explanation is derived only from your authoritative connectivity read — never from payments, orders or notifications arriving.",
        ),
      ),
    ),
  );
}

function evidenceDisclosure(overview: ConnectivityOverviewResource): HtmlFragment {
  const sections = overview.subjects.map((subject) => {
    if (subject.evidence === null) {
      return el(
        "section",
        { class: "panel", "data-evidence-subject": subject.subjectId },
        fragment(
          el("h4", {}, text(`${subject.subjectType} ${subject.subjectId}`)),
          el(
            "p",
            { class: "muted", "data-evidence-present": "false" },
            text("No delivery evidence is linked to this reference yet. When the network confirms delivery, the evidence and its freshness appear here."),
          ),
        ),
      );
    }
    const freshness = subject.evidence.freshness;
    return el(
      "section",
      { class: "panel", "data-evidence-subject": subject.subjectId, "data-evidence-present": "true" },
      fragment(
        el("h4", {}, text(`${subject.subjectType} ${subject.subjectId}`)),
        el(
          "dl",
          { class: "fact-list" },
          factRow("Evidence class", subject.evidence.evidenceClass),
          factRow("Kind of evidence record", subject.evidence.canonicalResourceType),
          factRow("Evidence record id", subject.evidence.canonicalResourceId),
          factRow("Observed", freshness.observedAt ?? "never"),
          factRow("Received", freshness.receivedAt ?? "never"),
          factRow("Freshness guarantee until", freshness.freshUntil ?? "(no guarantee recorded)"),
          factRow("Freshness when linked", freshness.recordedFreshnessState),
        ),
      ),
    );
  });
  return el(
    "details",
    { class: "disclosure", "data-disclosure": "evidence" },
    fragment(
      el("summary", {}, text("Evidence")),
      sections.length === 0
        ? el("p", { class: "muted" }, text("No connectivity references exist yet, so there is no evidence to show."))
        : fragment(...sections),
    ),
  );
}

function technicalDisclosure(overview: ConnectivityOverviewResource): HtmlFragment {
  const rows = overview.subjects.map((subject) =>
    el(
      "section",
      { class: "panel", "data-technical-subject": subject.subjectId },
      fragment(
        el("h4", {}, text(`${subject.subjectType} ${subject.subjectId}`)),
        subject.evidence === null
          ? el("p", { class: "muted" }, text("No evidence record is linked yet."))
          : el(
              "dl",
              { class: "fact-list" },
              factRow("Evidence class", subject.evidence.evidenceClass),
              factRow("Canonical resource type", subject.evidence.canonicalResourceType),
              factRow("Canonical resource id", subject.evidence.canonicalResourceId),
              factRow(
                "Source version",
                subject.evidence.sourceVersion === null ? "not recorded" : subject.evidence.sourceVersion,
              ),
              factRow("Causing event id", subject.evidence.eventId ?? "not recorded"),
              el(
                "div",
                { class: "fact-row" },
                el("dt", {}, text("Payload digest")),
                el("dd", {}, el("code", {}, text(subject.evidence.payloadDigest))),
              ),
            ),
      ),
    ),
  );
  return el(
    "details",
    { class: "disclosure", "data-disclosure": "technical" },
    fragment(
      el("summary", {}, text("Technical detail")),
      el(
        "p",
        { class: "muted" },
        text("Record identifiers for the delivery evidence. You never need this section to understand your connection."),
      ),
      rows.length === 0
        ? el("p", { class: "muted" }, text("Nothing to show yet."))
        : fragment(...rows),
    ),
  );
}

function factRow(label: string, value: string | number): HtmlFragment {
  return el(
    "div",
    { class: "fact-row" },
    el("dt", {}, text(label)),
    el("dd", {}, text(value)),
  );
}

// --------------------------------------------------------------------------------
// Observations + recent events (active/recent access)
// --------------------------------------------------------------------------------

function observationsSection(overview: ConnectivityOverviewResource): HtmlFragment {
  return el(
    "section",
    { "data-device-observations": "true" },
    fragment(
      pageHeading(
        "What your devices are seeing",
        "Device observations are inputs to RoamLink — each with its own freshness, never merged into the connectivity facts above.",
      ),
      overview.deviceObservations.length === 0
        ? el(
            "p",
            { class: "muted", "data-observations-empty": "true" },
            text("No device observations have been recorded yet. Once a device reports in, its freshness shows here."),
          )
        : el(
            "ul",
            { class: "observation-list" },
            ...overview.deviceObservations.map((observation) =>
              el(
                "li",
                { class: "observation-item", "data-observation-device": observation.deviceId },
                fragment(
                  el("p", {}, fragment(el("strong", {}, text(observation.deviceName)))),
                  el(
                    "p",
                    { class: "muted" },
                    fragment(
                      text("Capability snapshot: "),
                      freshnessBadge(observation.capabilityFreshness),
                      text(" · Context snapshot: "),
                      freshnessBadge(observation.contextFreshness),
                    ),
                  ),
                  el(
                    "p",
                    { class: "muted" },
                    fragment(text("Last observed: "), instantView(observation.lastObservedAt)),
                  ),
                ),
              ),
            ),
          ),
    ),
  );
}

function recentEventsSection(notifications: readonly NotificationResource[]): HtmlFragment {
  const events = [...notifications]
    .filter((n) => n.topic === "connectivity")
    .sort((a, b) => {
      const byTime = b.source.occurredAt.localeCompare(a.source.occurredAt);
      return byTime !== 0 ? byTime : a.notificationId.localeCompare(b.notificationId);
    })
    .slice(0, 5);
  return el(
    "section",
    { "data-recent-connectivity-events": "true" },
    fragment(
      pageHeading("Recent connectivity events", "The latest records from RoamLink's own state changes. The full story lives in Activity."),
      events.length === 0
        ? el(
            "p",
            { class: "muted", "data-recent-events-empty": "true" },
            text("No connectivity events recorded yet."),
          )
        : el(
            "ul",
            { class: "activity-list" },
            ...events.map((event) =>
              el(
                "li",
                { class: "activity-item", "data-event-id": event.notificationId },
                fragment(
                  el("p", {}, fragment(el("strong", {}, text(event.title)))),
                  el("p", { class: "muted" }, text(event.body)),
                  el(
                    "p",
                    { class: "muted" },
                    fragment(
                      text(`Recorded change: ${event.source.transition} · happened `),
                      instantView(event.source.occurredAt),
                    ),
                  ),
                ),
              ),
            ),
          ),
      el(
        "p",
        {},
        el("a", { href: pagePath("activity") }, text("See everything RoamLink has done")),
      ),
    ),
  );
}

// --------------------------------------------------------------------------------
// The page
// --------------------------------------------------------------------------------

export function connectivityCenterPage(input: ConnectivityCenterInput): HtmlFragment {
  const overview = input.connectivity;
  const shellState = deriveShellConnectivityState(overview.subjects);
  const shellLanguage = SHELL_CONNECTIVITY_LANGUAGE[shellState];
  return fragment(
    pageHeading(
      "Connectivity",
      "What is happening now, why, and what happens next — every fact from your authoritative connectivity read, kept separate and honest.",
    ),
    el(
      "section",
      { class: "home-hero", "data-connectivity-status": "true", "data-shell-state": shellState },
      fragment(
        el("p", { class: "home-hero-kicker" }, text("Right now")),
        el("h3", { class: "home-hero-headline" }, text(shellLanguage.label)),
        el("p", { class: "home-hero-facts" }, text(shellLanguage.detail)),
        el(
          "p",
          { class: "home-hero-evidence" },
          text("Read at "),
          instantView(overview.presentedAt),
          text(" — state is claimed only from delivery evidence and its freshness."),
        ),
      ),
    ),
    el(
      "section",
      { "data-connectivity-subjects": "true" },
      overview.subjects.length === 0
        ? el(
            "p",
            { class: "muted", "data-subjects-empty": "true" },
            text("No connectivity references exist yet — nothing has been requested. Start with a goal and a device, and the journey appears here."),
          )
        : fragment(...overview.subjects.map(subjectSummaryCard)),
    ),
    journeySection(overview),
    waitingAndNextSections(overview),
    whyDisclosure(overview),
    evidenceDisclosure(overview),
    technicalDisclosure(overview),
    observationsSection(overview),
    recentEventsSection(input.notifications),
  );
}
