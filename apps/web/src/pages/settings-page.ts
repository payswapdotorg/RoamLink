/**
 * The Settings page (RL-083 More sheet destination): a quiet account +
 * preferences surface over the authoritative actor-session read. It owns
 * nothing and decides nothing: identity, workspace scope and role render
 * from the typed client read; preferences live with the customer's Goals.
 */
import {
  el,
  fragment,
  text,
  type ActorSessionResource,
  type HtmlFragment,
} from "@roamlink/app-kit";

import { pageHeading } from "../app.js";

export function settingsPage(input: { readonly session: ActorSessionResource }): HtmlFragment {
  return fragment(
    pageHeading(
      "Settings",
      "Your account and preferences. Connectivity preferences live with your goals.",
    ),
    el(
      "section",
      { class: "panel", "data-settings-account": "true" },
      el(
        "table",
        {},
        el(
          "tbody",
          {},
          el(
            "tr",
            {},
            el("th", {}, text("Signed in as")),
            el("td", {}, text(input.session.actorId)),
          ),
          el(
            "tr",
            {},
            el("th", {}, text("Workspace")),
            el(
              "td",
              {},
              fragment(
                text(input.session.tenantId),
                text(` (scope: ${input.session.scope}`),
                input.session.role === null ? text("") : text(`, role: ${input.session.role}`),
                text(")"),
              ),
            ),
          ),
        ),
      ),
    ),
    el(
      "section",
      { class: "panel", "data-settings-preferences": "true" },
      fragment(
        el("h3", {}, text("Connectivity preferences")),
        el(
          "p",
          {},
          text("Your goals are your connectivity preferences — what you want, in your own words, with the knobs RoamLink turns on your behalf."),
        ),
        el("p", {}, el("a", { href: "/intents" }, text("Review your goals"))),
      ),
    ),
    el(
      "section",
      { class: "panel", "data-settings-accessibility": "true" },
      fragment(
        el("h3", {}, text("Accessibility")),
        el(
          "p",
          { class: "muted" },
          text(
            "RoamLink follows your system's reduced-motion preference, keeps every control keyboard-reachable, and never shows state by color alone — every state is also written out.",
          ),
        ),
      ),
    ),
  );
}
