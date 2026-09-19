/**
 * The first-run onboarding flow (RL-082, spec/ux-architecture.md §5).
 *
 * FOUR lightweight steps, exactly:
 *   1. Welcome — the product in plain language (no architecture vocabulary).
 *   2. Choose the primary connectivity goal (the spec's goal language).
 *   3. Add or enroll a device (pick an enrolled one, or enroll a new one).
 *   4. Confirm preferences and finish -> the customer lands on Home.
 *
 * Hard rules locked here (spec §5 + tech-lead handoff §6):
 *  - NEVER requires the customer to understand ADCOS, ConnectivityIntent,
 *    reservations, NetworkPath, provider adapters, leases or routing — a
 *    vocabulary-ban test scans every rendered step for those terms;
 *  - the wizard holds NO state of its own: every step's choices ride the
 *    page request params (a pure view), so the UI never becomes an
 *    authority and no local onboarding state machine exists;
 *  - the only mutations are RoamLink-owned commands through the app's
 *    flows (device enrollment, goal create + activate) with the full
 *    command envelope.
 */
import {
  DEVICE_PLATFORMS,
  el,
  fragment,
  text,
  type DeviceResource,
  type HtmlFragment,
  type IntentAccessClass,
} from "@roamlink/app-kit";

import { DEVICE_PLATFORM_LANGUAGE } from "./language.js";

export const ONBOARDING_STEPS = ["welcome", "goal", "device", "preferences"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function parseOnboardingStep(value: string | undefined): OnboardingStep {
  switch (value) {
    case "goal":
      return "goal";
    case "device":
      return "device";
    case "preferences":
      return "preferences";
    default:
      return "welcome";
  }
}

// --------------------------------------------------------------------------------
// Goal choices: the spec's human goal language mapped onto the typed
// ExperienceIntent access classes. Presentation mapping only — the human
// sentence becomes the intent rationale (the authoritative record carries
// both).
// --------------------------------------------------------------------------------

export interface GoalChoice {
  readonly id: string;
  /** The human goal sentence shown to the customer (spec §5 examples). */
  readonly statement: string;
  /** One-line plain-language explanation of what RoamLink will do. */
  readonly explanation: string;
  readonly accessClasses: readonly IntentAccessClass[];
}

export const GOAL_CHOICES: readonly GoalChoice[] = Object.freeze([
  {
    id: "travel",
    statement: "Stay connected while traveling",
    explanation: "RoamLink works to keep you online as you move between places and networks.",
    accessClasses: ["any_internet"],
  },
  {
    id: "work",
    statement: "Keep work reliable",
    explanation: "RoamLink prioritizes keeping your work apps reachable and stable.",
    accessClasses: ["work_apps_only"],
  },
  {
    id: "cost",
    statement: "Save connectivity cost",
    explanation: "RoamLink prefers good-enough options that keep your costs down.",
    accessClasses: ["metered_cost_cap"],
  },
  {
    id: "trusted-wifi",
    statement: "Prefer trusted Wi-Fi when it is good enough",
    explanation: "RoamLink uses trusted Wi-Fi when it meets your goal, and moves you when it does not.",
    accessClasses: ["any_internet", "metered_cost_cap"],
  },
  {
    id: "privacy",
    statement: "Protect privacy",
    explanation: "RoamLink favors private, trusted paths for your connectivity.",
    accessClasses: ["privacy_first"],
  },
  {
    id: "automatic-recovery",
    statement: "Let RoamLink handle recovery automatically",
    explanation: "When connectivity degrades, RoamLink works on recovery without bothering you.",
    accessClasses: ["any_internet"],
  },
]);

export function findGoalChoice(id: string | undefined): GoalChoice | undefined {
  return GOAL_CHOICES.find((choice) => choice.id === id);
}

// --------------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------------

export interface OnboardingPageInput {
  readonly step: OnboardingStep;
  /** The chosen goal id (carried through the params from step 2 on). */
  readonly goalId?: string;
  /** All enrolled devices (step 3 lets the customer pick one). */
  readonly devices?: readonly DeviceResource[];
  /** The chosen device (carried from step 3 into step 4). */
  readonly deviceId?: string;
  /** A previous flow failure to present honestly (typed panel rendered by the app). */
  readonly notice?: string;
}

function stepHeader(current: OnboardingStep): HtmlFragment {
  const index = ONBOARDING_STEPS.indexOf(current);
  return el(
    "div",
    { class: "onboarding-progress", "data-onboarding-step": current },
    fragment(
      el(
        "p",
        { class: "muted" },
        text(`Step ${index + 1} of ${ONBOARDING_STEPS.length}`),
      ),
      el(
        "ol",
        { class: "onboarding-steps" },
        ...ONBOARDING_STEPS.map((step, i) =>
          el(
            "li",
            {
              "data-step": step,
              ...(step === current ? { "aria-current": "step" } : {}),
            },
            text(i < index ? "✓" : `${i + 1}. ${stepLabel(step)}`),
          ),
        ),
      ),
    ),
  );
}

function stepLabel(step: OnboardingStep): string {
  switch (step) {
    case "welcome":
      return "Welcome";
    case "goal":
      return "Your goal";
    case "device":
      return "Your device";
    case "preferences":
      return "Confirm";
  }
}

/**
 * Renders the onboarding page for one step. All state arrives via the input
 * (params); the forms navigate between steps by carrying the choices in
 * hidden fields/links, so the wizard stays stateless and pure.
 */
export function onboardingPage(input: OnboardingPageInput): HtmlFragment {
  const body = (() => {
    switch (input.step) {
      case "welcome":
        return welcomeStep();
      case "goal":
        return goalStep();
      case "device":
        return deviceStep(input);
      case "preferences":
        return preferencesStep(input);
    }
  })();
  return el(
    "section",
    { class: "onboarding", "data-onboarding": "true", "data-onboarding-step": input.step },
    fragment(stepHeader(input.step), body),
  );
}

/** Step 1 — plain-language value proposition. No product jargon. */
function welcomeStep(): HtmlFragment {
  return el(
    "div",
    { class: "onboarding-body" },
    fragment(
      el("h2", {}, text("Welcome to RoamLink")),
      el(
        "p",
        { class: "onboarding-lede" },
        text(
          "RoamLink keeps you connected to what matters. You tell it what a good connection looks like for you; it watches your connectivity, fixes what it can on its own, and tells you plainly what it did and why.",
        ),
      ),
      el(
        "ul",
        { class: "onboarding-points" },
        el("li", {}, text("You choose a goal in your own words.")),
        el("li", {}, text("RoamLink works on your goal continuously — not only when you ask.")),
        el("li", {}, text("You always see what happened, why, and whether it needs you.")),
      ),
      el(
        "p",
        {},
        el(
          "a",
          { class: "onboarding-primary-action", href: "/onboarding?step=goal" },
          text("Get started"),
        ),
      ),
      el(
        "p",
        { class: "muted" },
        text("Takes about a minute. You can change everything later."),
      ),
    ),
  );
}

/** Step 2 — choose the primary connectivity goal. */
function goalStep(): HtmlFragment {
  return el(
    "div",
    { class: "onboarding-body" },
    fragment(
      el("h2", {}, text("What do you want your connectivity to do for you?")),
      el("p", { class: "muted" }, text("Pick the one that matters most. You can add more goals later.")),
      el(
        "form",
        { method: "get", action: "/onboarding", "data-onboarding-form": "choose-goal" },
        el("input", { type: "hidden", name: "step", value: "device" }),
        el(
          "fieldset",
          { class: "onboarding-goal-list" },
          el("legend", { class: "sr-only" }, text("Connectivity goal")),
          ...GOAL_CHOICES.map((choice) =>
            el(
              "label",
              { class: "onboarding-goal" },
              el("input", {
                type: "radio",
                name: "goal",
                value: choice.id,
                required: true,
              }),
              el(
                "span",
                { class: "onboarding-goal-text" },
                fragment(
                  el("strong", {}, text(choice.statement)),
                  el("span", { class: "muted" }, text(choice.explanation)),
                ),
              ),
            ),
          ),
        ),
        el(
          "button",
          { type: "submit", class: "onboarding-primary-action" },
          text("Continue"),
        ),
      ),
    ),
  );
}

/** Step 3 — add or enroll a device. */
function deviceStep(input: OnboardingPageInput): HtmlFragment {
  const goal = input.goalId ?? "";
  return el(
    "div",
    { class: "onboarding-body" },
    fragment(
      el("h2", {}, text("Where should RoamLink help?")),
      el("p", { class: "muted" }, text("Choose a device you have already added, or add a new one.")),
      input.notice === undefined
        ? fragment()
        : el("p", { class: "onboarding-notice" }, text(input.notice)),
      (input.devices ?? []).length > 0
        ? el(
            "form",
            { method: "get", action: "/onboarding", "data-onboarding-form": "pick-device" },
            el("input", { type: "hidden", name: "step", value: "preferences" }),
            el("input", { type: "hidden", name: "goal", value: goal }),
            el(
              "fieldset",
              { class: "onboarding-device-list" },
              el("legend", { class: "sr-only" }, text("Your devices")),
              ...(input.devices ?? []).map((device) =>
                el(
                  "label",
                  { class: "onboarding-device" },
                  el("input", {
                    type: "radio",
                    name: "deviceId",
                    value: device.deviceId,
                    required: true,
                  }),
                  el(
                    "span",
                    { class: "onboarding-goal-text" },
                    fragment(
                      el("strong", {}, text(device.name)),
                      el(
                        "span",
                        { class: "muted" },
                        text(` ${DEVICE_PLATFORM_LANGUAGE[device.platform] ?? device.platform}`),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            el(
              "button",
              { type: "submit", class: "onboarding-primary-action" },
              text("Continue"),
            ),
          )
        : fragment(),
      el("h3", {}, text("Add a new device")),
      el(
        "form",
        {
          method: "post",
          action: "/flows/onboarding-enroll-device",
          "data-onboarding-form": "enroll-device",
        },
        el("input", { type: "hidden", name: "goal", value: goal }),
        el("label", { for: "onboard-device-name" }, text("Name")),
        el("input", { type: "text", name: "name", id: "onboard-device-name", required: true, minlength: "1" }),
        el("label", { for: "onboard-device-platform" }, text("Kind of device")),
        el(
          "select",
          { name: "platform", id: "onboard-device-platform" },
          ...DEVICE_PLATFORMS.map((platform) =>
            el(
              "option",
              { value: platform },
              text(DEVICE_PLATFORM_LANGUAGE[platform] ?? platform),
            ),
          ),
        ),
        el("button", { type: "submit", class: "onboarding-primary-action" }, text("Add device")),
      ),
      el(
        "p",
        { class: "muted" },
        text("RoamLink never needs your device password or accounts."),
      ),
    ),
  );
}

/** Step 4 — confirm preferences and finish. */
function preferencesStep(input: OnboardingPageInput): HtmlFragment {
  const goal = findGoalChoice(input.goalId);
  const device = (input.devices ?? []).find((d) => d.deviceId === input.deviceId);
  return el(
    "div",
    { class: "onboarding-body" },
    fragment(
      el("h2", {}, text("Confirm and finish")),
      el(
        "dl",
        { class: "onboarding-confirm", "data-onboarding-confirm": "true" },
        el("dt", {}, text("Your goal")),
        el("dd", {}, text(goal?.statement ?? "(no goal chosen)")),
        el("dt", {}, text("What RoamLink will do")),
        el("dd", {}, text(goal?.explanation ?? "—")),
        el("dt", {}, text("Your device")),
        el(
          "dd",
          {},
          text(device ? `${device.name} (${DEVICE_PLATFORM_LANGUAGE[device.platform] ?? device.platform})` : "(no device chosen)"),
        ),
        el("dt", {}, text("Automatic recovery")),
        el("dd", {}, text("On — RoamLink acts on your goal and tells you what it did.")),
      ),
      el(
        "p",
        { class: "muted" },
        text(
          "Your goal is recorded in your own words and kept as a version, so you can always see what changed later.",
        ),
      ),
      input.notice === undefined
        ? fragment()
        : el("p", { class: "onboarding-notice" }, text(input.notice)),
      device && goal
        ? el(
            "form",
            {
              method: "post",
              action: "/flows/onboarding-finish",
              "data-onboarding-form": "finish",
            },
            el("input", { type: "hidden", name: "goal", value: goal.id }),
            el("input", { type: "hidden", name: "deviceId", value: device.deviceId }),
            el(
              "button",
              { type: "submit", class: "onboarding-primary-action" },
              text("Finish and go to Home"),
            ),
          )
        : el(
            "p",
            {},
            el(
              "a",
              { href: "/onboarding?step=device" },
              text("Back: choose a device first"),
            ),
          ),
      el(
        "p",
        { class: "muted" },
        el("a", { href: "/onboarding?step=goal" }, text("Change your goal")),
      ),
    ),
  );
}
