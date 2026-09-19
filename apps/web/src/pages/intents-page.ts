/**
 * The Goals pages (RL-086, spec/ux-architecture.md §7): the customer's
 * goal-oriented journey over the ExperienceIntent surface.
 *
 * "Goal" is the user-facing word for an intent (user-journey audit Gap B);
 * the advanced label stays available through progressive disclosure. A goal
 * reads as a first-class journey:
 *   - what the customer expressed (the goal statement, in their words);
 *   - what RoamLink derived from it (the explainable decision + the
 *     freshness of the evidence it used);
 *   - the connectivity it produced (delivery evidence facts, rendered as
 *     the separate connectivity truth they are);
 *   - the honest gap between requested and delivered.
 * The immutable version chain renders as "what changed" — an honesty
 * guarantee, not the main metaphor (RL-LOCK-007: these are experience
 * domain objects; the page NEVER claims connectivity from them).
 *
 * Every mutation rides the app's flows with the full command envelope;
 * forms are human-labeled but field-compatible (deviceId, rationale,
 * accessClasses, intentId).
 */
import {
  freshnessBadge,
  instantView,
  stateBadge,
  el,
  fragment,
  text,
  type ConnectivityOverviewResource,
  type DeviceResource,
  type ExperienceIntentResource,
  type HtmlFragment,
  type IntentAccessClass,
} from "@roamlink/app-kit";

import { pagePath } from "../routes.js";
import { pageHeading, tableWrap } from "../app.js";
import { ACCESS_CLASS_LANGUAGE, DERIVED_EXPERIENCE_LANGUAGE } from "./language.js";

const ACCESS_CLASSES: readonly IntentAccessClass[] = [
  "any_internet",
  "work_apps_only",
  "streaming",
  "low_power",
  "metered_cost_cap",
  "privacy_first",
  "regional_compliance",
];

function deviceName(devices: readonly DeviceResource[], deviceId: string): string {
  return devices.find((d) => d.deviceId === deviceId)?.name ?? deviceId;
}

function preferencePhrases(classes: readonly IntentAccessClass[]): readonly string[] {
  if (classes.length === 0) return ["No preference recorded"];
  return classes.map((c) => ACCESS_CLASS_LANGUAGE[c] ?? c);
}

function goalStatusLanguage(status: string): string {
  switch (status) {
    case "draft":
      return "Draft — not working yet";
    case "active":
      return "Active — RoamLink is working toward this";
    case "superseded":
      return "Replaced by a newer version";
    case "archived":
      return "Archived";
    case "canceled":
      return "Canceled";
    default:
      return status;
  }
}

function goalCard(
  intent: ExperienceIntentResource,
  devices: readonly DeviceResource[],
): HtmlFragment {
  const current = intent.currentVersion;
  const versions = [...intent.versions].sort((a, b) => a.versionNumber - b.versionNumber);
  const firstVersion = versions[0];
  const whatChanged =
    versions.length > 1 && current !== null && firstVersion !== undefined
      ? `Version ${firstVersion.versionNumber} asked for “${firstVersion.rationale}”; the current version asks for “${current.rationale}”.`
      : undefined;
  return el(
    "li",
    {
      class: "goal-card",
      "data-goal-id": intent.intentId,
      "data-goal-status": intent.status,
    },
    fragment(
      el("h3", {}, text(current === null ? "Goal (not described yet)" : current.rationale)),
      el(
        "p",
        { class: "muted" },
        fragment(
          text("Status: "),
          stateBadge(intent.status),
          text(` ${goalStatusLanguage(intent.status)}`),
        ),
      ),
      el(
        "p",
        { class: "muted" },
        text(`Device: ${deviceName(devices, intent.deviceId)}`),
      ),
      el(
        "p",
        { class: "goal-preferences" },
        text(`What this means: ${preferencePhrases(current?.accessClasses ?? []).join("; ")}`),
      ),
      current === null
        ? fragment()
        : el(
            "p",
            { class: "muted" },
            text(`Working version: v${current.versionNumber} (${current.status})`),
          ),
      intent.decision === null
        ? el(
            "p",
            { class: "muted" },
            text("RoamLink has not evaluated this goal yet."),
          )
        : el(
            "p",
            {},
            text(DERIVED_EXPERIENCE_LANGUAGE[intent.decision.derivedStatus]),
          ),
      whatChanged === undefined
        ? fragment()
        : el("p", { class: "muted" }, text(`What changed: ${whatChanged}`)),
      el("p", {}, el("a", { href: pagePath("intent", { intentId: intent.intentId }) }, text("Open this goal"))),
    ),
  );
}

/** The create form: human language, same flow fields as the app's flows. */
function createGoalForm(devices: readonly DeviceResource[]): HtmlFragment {
  return el(
    "form",
    { method: "post", action: "/flows/create-intent", "data-flow": "create-intent" },
    fragment(
      el("label", { for: "goal-device" }, text("For which device?")),
      el(
        "select",
        { name: "deviceId", id: "goal-device", required: true },
        ...devices.map((device) =>
          el(
            "option",
            { value: device.deviceId },
            text(`${device.name} (${device.platform})`),
          ),
        ),
      ),
      el("label", { for: "goal-rationale" }, text("In your own words, what do you want?")),
      el("input", {
        type: "text",
        name: "rationale",
        id: "goal-rationale",
        required: true,
        placeholder: "e.g. Keep work apps reachable while I travel",
      }),
      el(
        "fieldset",
        { class: "preference-list" },
        el("legend", {}, text("What matters most about this goal?")),
        ...ACCESS_CLASSES.map((accessClass) =>
          el(
            "label",
            { class: "preference-option" },
            el("input", {
              type: "checkbox",
              name: "accessClasses",
              value: accessClass,
            }),
            el("span", {}, text(ACCESS_CLASS_LANGUAGE[accessClass])),
          ),
        ),
      ),
      el("p", { class: "muted" }, text("RoamLink records your goal as a version, so you can always see what changed later.")),
      el("button", { type: "submit" }, text("Create this goal")),
    ),
  );
}

export function goalsPage(input: {
  readonly intents: readonly ExperienceIntentResource[];
  readonly devices: readonly DeviceResource[];
}): HtmlFragment {
  return fragment(
    pageHeading(
      "Goals",
      "What you want your connectivity to do for you — in your own words. (Advanced: experience intents.)",
    ),
    input.intents.length === 0
      ? el(
          "div",
          { class: "panel", "data-goals-empty": "true" },
          fragment(
            el("p", {}, text("No goals yet. A goal tells RoamLink what a good connection looks like for you, and it gets to work on it.")),
            el("p", {}, el("a", { href: pagePath("onboarding") }, text("Choose your first goal"))),
          ),
        )
      : el(
          "ul",
          { class: "goal-list", "data-intents": "true", "aria-label": "Your goals" },
          ...input.intents.map((intent) => goalCard(intent, input.devices)),
        ),
    pageHeading("Add a goal"),
    input.devices.length === 0
      ? el(
          "p",
          { class: "muted", "data-goal-no-devices": "true" },
          text("Enroll a device first — a goal always works for a device."),
        )
      : createGoalForm(input.devices),
  );
}

// --------------------------------------------------------------------------------
// The goal detail journey
// --------------------------------------------------------------------------------

function decisionSection(intent: ExperienceIntentResource): HtmlFragment {
  if (intent.decision === null) {
    return el(
      "p",
      { class: "muted", "data-decision": "none" },
      text("RoamLink has not evaluated this goal yet. Once it does, the result and the evidence it used appear here."),
    );
  }
  return el(
    "div",
    { class: "panel", "data-decision": intent.decision.decisionId },
    fragment(
      el("h3", {}, text("What RoamLink derived from your goal")),
      el(
        "p",
        {},
        fragment(
          text(DERIVED_EXPERIENCE_LANGUAGE[intent.decision.derivedStatus]),
          text(" "),
          stateBadge(intent.decision.derivedStatus),
        ),
      ),
      el(
        "p",
        { class: "muted" },
        text(`Evaluated ${intent.decision.computedAt}. RoamLink re-evaluates as your connectivity changes — the derived status explains the goal; it never overwrites it and never claims connectivity by itself.`),
      ),
      el(
        "dl",
        { class: "fact-list" },
        el(
          "div",
          { class: "fact-row" },
          el("dt", {}, text("Freshness of the evidence used")),
          el(
            "dd",
            {},
            intent.decision.inputFreshness.length === 0
              ? text("no inputs recorded for this evaluation")
              : fragment(...intent.decision.inputFreshness.map((freshness) => freshnessBadge(freshness))),
          ),
        ),
      ),
    ),
  );
}

function versionChain(intent: ExperienceIntentResource): HtmlFragment {
  return el(
    "section",
    { "data-goal-history": "true" },
    fragment(
      pageHeading("What changed", "Every change to your goal is kept as its own version, so the history cannot be lost or rewritten."),
      tableWrap(
        "Goal version history",
        el(
          "table",
          { "data-versions": "true" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", { scope: "col" }, text("Version")),
              el("th", { scope: "col" }, text("Status")),
              el("th", { scope: "col" }, text("What it asked for")),
              el("th", { scope: "col" }, text("What matters most")),
              el("th", { scope: "col" }, text("Created")),
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
                  el("td", {}, text(`v${version.versionNumber}`)),
                  el("td", {}, stateBadge(version.status)),
                  el("td", {}, text(version.rationale)),
                  el("td", {}, text(preferencePhrases(version.accessClasses).join("; "))),
                  el("td", {}, instantView(version.createdAt)),
                ),
              ),
          ),
        ),
      ),
    ),
  );
}

function honestGapSection(
  intent: ExperienceIntentResource,
  connectivity: ConnectivityOverviewResource,
): HtmlFragment {
  const requestedPhrase =
    intent.decision === null
      ? "RoamLink has not evaluated this goal yet."
      : DERIVED_EXPERIENCE_LANGUAGE[intent.decision.derivedStatus];
  const delivering = connectivity.subjects.filter(
    (subject) => subject.deliveryEvidenceState === "EVIDENCED",
  );
  const deliveryPhrase =
    connectivity.subjects.length === 0
      ? "No connectivity references exist yet, so nothing is delivering."
      : delivering.length === 0
        ? "No delivery evidence is linked yet — the network has not confirmed delivery."
        : `${delivering.length} of ${connectivity.subjects.length} reference${connectivity.subjects.length === 1 ? "" : "s"} ${connectivity.subjects.length === 1 ? "has" : "have"} delivery evidence linked.`;
  return el(
    "section",
    { class: "panel", "data-goal-gap": "true" },
    fragment(
      el("h3", {}, text("Requested and delivered — kept honest")),
      el(
        "dl",
        { class: "fact-list" },
        el(
          "div",
          { class: "fact-row" },
          el("dt", {}, text("What you asked for")),
          el("dd", {}, text(requestedPhrase)),
        ),
        el(
          "div",
          { class: "fact-row" },
          el("dt", {}, text("What is delivering right now")),
          el("dd", {}, text(deliveryPhrase)),
        ),
      ),
      el(
        "p",
        { class: "muted" },
        text(
          "These are two separate truths: your goal is the request, and delivery is confirmed only by delivery evidence on your connectivity references. RoamLink works on closing the gap; the facts above never borrow from each other.",
        ),
      ),
      el("p", {}, el("a", { href: pagePath("connectivity") }, text("See the connectivity journey"))),
    ),
  );
}

function goalActions(intent: ExperienceIntentResource): HtmlFragment {
  const actions: HtmlFragment[] = [];
  if (intent.status === "draft") {
    actions.push(
      el(
        "form",
        { method: "post", action: "/flows/activate-intent", "data-flow": "activate-intent" },
        el("input", { type: "hidden", name: "intentId", value: intent.intentId }),
        el("button", { type: "submit" }, text("Start working on this goal")),
      ),
    );
  }
  if (intent.status === "active") {
    actions.push(
      el(
        "form",
        { method: "post", action: "/flows/supersede-intent", "data-flow": "supersede-intent" },
        el("input", { type: "hidden", name: "intentId", value: intent.intentId }),
        el("label", { for: "supersede-rationale" }, text("Change your goal")),
        el("input", {
          type: "text",
          name: "rationale",
          id: "supersede-rationale",
          required: true,
          placeholder: "Describe what you want instead",
        }),
        el(
          "fieldset",
          { class: "preference-list" },
          el("legend", {}, text("What matters most now?")),
          ...ACCESS_CLASSES.map((accessClass) =>
            el(
              "label",
              { class: "preference-option" },
              el("input", {
                type: "checkbox",
                name: "accessClasses",
                value: accessClass,
              }),
              el("span", {}, text(ACCESS_CLASS_LANGUAGE[accessClass])),
            ),
          ),
        ),
        el("button", { type: "submit" }, text("Replace with a new version")),
      ),
    );
  }
  return el(
    "section",
    { "data-goal-actions": "true" },
    fragment(
      pageHeading("What you can do"),
      actions.length === 0
        ? el(
            "p",
            { class: "muted" },
            text("This goal is closed to changes. Create a new goal to keep going."),
          )
        : fragment(...actions),
    ),
  );
}

export function goalDetailPage(input: {
  readonly intent: ExperienceIntentResource;
  readonly devices: readonly DeviceResource[];
  readonly connectivity: ConnectivityOverviewResource;
}): HtmlFragment {
  const intent = input.intent;
  const current = intent.currentVersion;
  const name = deviceName(input.devices, intent.deviceId);
  return fragment(
    pageHeading(
      current === null ? "Goal" : `Goal: ${current.rationale}`,
      `For ${name}. (Advanced: experience intent ${intent.intentId}.)`,
    ),
    el(
      "section",
      { class: "panel", "data-goal-current": "true", "data-goal-status": intent.status },
      fragment(
        el("h3", {}, text("What you asked for")),
        current === null
          ? el("p", { class: "muted" }, text("This goal has no described version yet."))
          : fragment(
              el("p", {}, text(current.rationale)),
              el(
                "p",
                { class: "goal-preferences" },
                text(`What this means: ${preferencePhrases(current.accessClasses).join("; ")}`),
              ),
            ),
        el(
          "p",
          { class: "muted" },
          fragment(
            text("Status: "),
            stateBadge(intent.status),
            text(` ${goalStatusLanguage(intent.status)}`),
            intent.supersededByIntentId === undefined
              ? text("")
              : text(` — replaced by goal ${intent.supersededByIntentId}`),
          ),
        ),
        el(
          "p",
          {},
          el("a", { href: pagePath("device", { deviceId: intent.deviceId }) }, text(`See ${name}`)),
        ),
      ),
    ),
    decisionSection(intent),
    honestGapSection(intent, input.connectivity),
    versionChain(intent),
    goalActions(intent),
  );
}
