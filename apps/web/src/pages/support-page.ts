/**
 * The support page (RL-060): the CUSTOMER's support view.
 *
 * The customer thread view renders only customer-visible messages: internal
 * messages are structurally absent from this page (the visibility boundary
 * is enforced by the API resource contract - this page additionally filters,
 * so an internal message can never leak into the customer thread even if a
 * future API surface slips).
 */
import {
  emptyState,
  instantView,
  stateBadge,
  el,
  fragment,
  text,
  type HtmlFragment,
  type SupportCaseResource,
} from "@roamlink/app-kit";

import { pageHeading } from "../app.js";

export function supportPage(input: { readonly cases: readonly SupportCaseResource[] }): HtmlFragment {
  return fragment(
    pageHeading("Support", "Open a case; follow the customer-visible thread."),
    input.cases.length === 0 ? emptyState("support cases") : fragment(...input.cases.map(caseCard)),
    pageHeading("Open a support case"),
    el(
      "form",
      { method: "post", action: "/flows/create-support-case", "data-flow": "create-support-case" },
      el("label", {}, text("Subject ")),
      el("input", { type: "text", name: "subject", required: true }),
      el("label", {}, text(" Description ")),
      el("input", { type: "text", name: "description", required: true }),
      el(
        "select",
        { name: "priority" },
        ...(["low", "normal", "high", "urgent"] as const).map((priority) =>
          el("option", { value: priority }, text(priority)),
        ),
      ),
      el("button", { type: "submit" }, text("Open case")),
    ),
  );
}

function caseCard(supportCase: SupportCaseResource): HtmlFragment {
  const customerMessages = supportCase.messages.filter((message) => message.visibility === "customer");
  return el(
    "section",
    {
      class: "panel",
      "data-case-id": supportCase.caseId,
      "data-case-status": supportCase.status,
    },
    fragment(
      el("h3", {}, text(supportCase.subject)),
      el(
        "p",
        {},
        fragment(
          text("Status: "),
          stateBadge(supportCase.status),
          text(" Priority: "),
          stateBadge(supportCase.priority),
          text(" Opened "),
          instantView(supportCase.createdAt),
        ),
      ),
      el("p", {}, text(supportCase.description)),
      supportCase.relatedRefs.length === 0
        ? fragment()
        : el(
            "p",
            { class: "muted" },
            text(
              `Related: ${supportCase.relatedRefs.map((ref) => `${ref.kind} ${ref.id}`).join("; ")}`,
            ),
          ),
      pageHeading("Customer thread"),
      customerMessages.length === 0
        ? el("p", { class: "muted", "data-customer-thread": "empty" }, text("No customer-visible messages yet."))
        : el(
            "ul",
            { "data-customer-thread": "true" },
            ...customerMessages.map((message) =>
              el(
                "li",
                { "data-message-id": message.messageId },
                fragment(
                  text(`[${message.sentAt}] `),
                  text(message.body),
                ),
              ),
            ),
          ),
    ),
  );
}
