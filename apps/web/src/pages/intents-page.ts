/**
 * The experience-intents pages (RL-060): the customer's desired-experience
 * surface - create (draft v1), activate, supersede (new immutable version).
 *
 * The page renders the immutable version chain, the authoritative intent
 * status and the explainable decision summary (derived status + input
 * freshness). It NEVER renders a connectivity claim: intents are experience
 * domain objects (RL-LOCK-007).
 */
import {
  emptyState,
  freshnessBadge,
  instantView,
  stateBadge,
  el,
  fragment,
  text,
  type ExperienceIntentResource,
  type HtmlFragment,
  type IntentAccessClass,
} from "@roamlink/app-kit";

import { pageHeading } from "../app.js";

const ACCESS_CLASSES: readonly IntentAccessClass[] = [
  "any_internet",
  "work_apps_only",
  "streaming",
  "low_power",
  "metered_cost_cap",
  "privacy_first",
  "regional_compliance",
];

function versionTable(intent: ExperienceIntentResource): HtmlFragment {
  return el(
    "table",
    { "data-versions": "true" },
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", {}, text("Version")),
        el("th", {}, text("Status")),
        el("th", {}, text("Rationale")),
        el("th", {}, text("Access classes")),
        el("th", {}, text("Created")),
      ),
    ),
    el(
      "tbody",
      {},
      ...[...intent.versions]
        .sort((a, b) => a.versionNumber - b.versionNumber)
        .map((version) =>
          el(
            "tr",
            { "data-version-number": version.versionNumber },
            el("td", {}, text(version.versionNumber)),
            el("td", {}, stateBadge(version.status)),
            el("td", {}, text(version.rationale)),
            el("td", {}, text(version.accessClasses.join(", "))),
            el("td", {}, instantView(version.createdAt)),
          ),
        ),
    ),
  );
}

function decisionBlock(intent: ExperienceIntentResource): HtmlFragment {
  if (intent.decision === null) {
    return el(
      "p",
      { class: "muted", "data-decision": "none" },
      text("No decision snapshot yet: the explainable decision is computed from the active version's evidence."),
    );
  }
  return el(
    "div",
    { class: "panel", "data-decision": intent.decision.decisionId },
    fragment(
      el("h3", {}, text("Experience decision (read-side)")),
      el(
        "p",
        {},
        fragment(
          text("Derived status: "),
          stateBadge(intent.decision.derivedStatus),
          text(" computed at "),
          instantView(intent.decision.computedAt),
        ),
      ),
      el(
        "p",
        { class: "muted" },
        text("The derived status references the authoritative intent status; it never overwrites it and never claims connectivity."),
      ),
      intent.decision.inputFreshness.length === 0
        ? fragment()
        : el(
            "ul",
            {},
            ...intent.decision.inputFreshness.map((freshness, index) =>
              el("li", {}, fragment(text(`Input ${index + 1}: `), freshnessBadge(freshness))),
            ),
          ),
    ),
  );
}

export function intentsPage(input: {
  readonly intents: readonly ExperienceIntentResource[];
}): HtmlFragment {
  return fragment(
    pageHeading(
      "Goals",
      "What you want your connectivity experience to be. Immutable versions, linked by supersession. (Advanced: experience intents.)",
    ),
    input.intents.length === 0
      ? emptyState("experience intents")
      : el(
          "table",
          { "data-intents": "true" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, text("Intent")),
              el("th", {}, text("Device")),
              el("th", {}, text("Status")),
              el("th", {}, text("Current version")),
              el("th", {}, text("Derived status")),
              el("th", {}, text("Revision")),
            ),
          ),
          el(
            "tbody",
            {},
            ...input.intents.map((intent) =>
              el(
                "tr",
                { "data-intent-id": intent.intentId },
                el("td", {}, text(intent.intentId)),
                el("td", {}, text(intent.deviceId)),
                el("td", {}, stateBadge(intent.status)),
                el(
                  "td",
                  {},
                  intent.currentVersion === null
                    ? text("-")
                    : text(`v${intent.currentVersion.versionNumber}`),
                ),
                el(
                  "td",
                  {},
                  intent.decision === null ? text("-") : stateBadge(intent.decision.derivedStatus),
                ),
                el("td", {}, text(intent.revision)),
              ),
            ),
          ),
        ),
    intentForms(),
  );
}

export function intentDetailPage(input: { readonly intent: ExperienceIntentResource }): HtmlFragment {
  const intent = input.intent;
  return fragment(
    pageHeading(`Experience intent ${intent.intentId}`, `Device ${intent.deviceId}`),
    el(
      "p",
      {},
      fragment(
        text("Status: "),
        stateBadge(intent.status),
        text(" Revision: "),
        text(intent.revision),
        intent.supersededByIntentId === undefined
          ? fragment()
          : fragment(text(" Superseded by: "), text(intent.supersededByIntentId)),
      ),
    ),
    decisionBlock(intent),
    pageHeading("Version chain"),
    versionTable(intent),
    intentForms(),
  );
}

function intentForms(): HtmlFragment {
  return fragment(
    pageHeading("Create a draft intent"),
    el(
      "form",
      { method: "post", action: "/flows/create-intent", "data-flow": "create-intent" },
      el("label", {}, text("Device id ")),
      el("input", { type: "text", name: "deviceId", required: true }),
      el("label", {}, text(" Rationale ")),
      el("input", { type: "text", name: "rationale", required: true }),
      el(
        "select",
        { name: "accessClasses", multiple: true },
        ...ACCESS_CLASSES.map((accessClass) =>
          el("option", { value: accessClass }, text(accessClass)),
        ),
      ),
      el("button", { type: "submit" }, text("Create draft")),
    ),
    pageHeading("Activate / supersede"),
    el(
      "form",
      { method: "post", action: "/flows/activate-intent", "data-flow": "activate-intent" },
      el("label", {}, text("Intent id ")),
      el("input", { type: "text", name: "intentId", required: true }),
      el("button", { type: "submit" }, text("Activate")),
    ),
    el(
      "form",
      { method: "post", action: "/flows/supersede-intent", "data-flow": "supersede-intent" },
      el("label", {}, text("Intent id ")),
      el("input", { type: "text", name: "intentId", required: true }),
      el("label", {}, text(" New rationale ")),
      el("input", { type: "text", name: "rationale", required: true }),
      el(
        "select",
        { name: "accessClasses", multiple: true },
        ...ACCESS_CLASSES.map((accessClass) =>
          el("option", { value: accessClass }, text(accessClass)),
        ),
      ),
      el("button", { type: "submit" }, text("Supersede with new version")),
    ),
    el(
      "p",
      { class: "muted" },
      text("Each command carries the full envelope and commands against the current revision; the acknowledgement shows accepted/executed/delivered/billable-final separately."),
    ),
  );
}
