/**
 * The More sheet (RL-083 mobile navigation): the destinations that live
 * outside the mobile bottom nav — Goals, Plans & Billing, Support and
 * Settings (spec/ux-architecture.md §3). Pure navigation surface.
 */
import { el, fragment, text, type HtmlFragment } from "@roamlink/app-kit";

import { pageHeading } from "../app.js";

export interface MoreLink {
  readonly label: string;
  readonly href: string;
  readonly description: string;
}

export const MORE_LINKS: readonly MoreLink[] = Object.freeze([
  {
    label: "Goals",
    href: "/intents",
    description: "What you want your connectivity to do for you.",
  },
  {
    label: "Plans & Billing",
    href: "/commerce",
    description: "Plans, orders, payments and invoices. Payment confirms a commercial fact; it never proves connectivity delivery.",
  },
  {
    label: "Support",
    href: "/support",
    description: "Open a case; RoamLink carries the relevant context for you.",
  },
  {
    label: "Settings",
    href: "/settings",
    description: "Your account and preferences.",
  },
]);

export function morePage(): HtmlFragment {
  return fragment(
    pageHeading("More", "Everything else in RoamLink."),
    el(
      "ul",
      { class: "more-list", "data-more-sheet": "true" },
      ...MORE_LINKS.map((link) =>
        el(
          "li",
          { class: "more-item" },
          el(
            "a",
            { class: "more-item-link", href: link.href },
            fragment(
              el("strong", {}, text(link.label)),
              el("span", { class: "muted" }, text(link.description)),
            ),
          ),
        ),
      ),
    ),
  );
}
