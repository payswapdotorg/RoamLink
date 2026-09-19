/**
 * The support page (RL-060 + RL-103): the CUSTOMER's support view.
 *
 * The customer thread view renders only customer-visible messages: internal
 * messages are structurally absent from this page (the visibility boundary
 * is enforced by the API resource contract - this page additionally filters,
 * so an internal message can never leak into the customer thread even if a
 * future API surface slips).
 *
 * RL-103 (spec/ux-architecture.md §11): a case opened from a degraded
 * surface PRE-CARRIES its context. The carried context arrives as page
 * params (the query string a contextual escape emitted), renders to the
 * customer as a transparency panel - "RoamLink will attach ..." - before
 * anything is sent, prefills the form, and rides the create-case flow as
 * typed relatedRefs. Carried context is decoded fail-closed: unknown
 * kinds/overlong values are dropped by the shared decoder, so the case can
 * only ever carry what a degraded surface legitimately emitted.
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
import {
  contextNarrative,
  readSupportContextParams,
  supportContextParams,
  type SupportCaseContext,
} from "./support-context.js";

export interface SupportPageInput {
  readonly cases: readonly SupportCaseResource[];
  /** Context pre-carried from a degraded surface (RL-103), if any. */
  readonly carriedContext?: SupportCaseContext | null;
}

export function supportPage(input: SupportPageInput): HtmlFragment {
  const carried = input.carriedContext ?? null;
  return fragment(
    pageHeading("Support", "Open a case; follow the customer-visible thread."),
    carriedContextPanel(carried),
    input.cases.length === 0 ? emptyState("support cases") : fragment(...input.cases.map(caseCard)),
    pageHeading("Open a support case"),
    el(
      "form",
      { method: "post", action: "/flows/create-support-case", "data-flow": "create-support-case" },
      el(
        "label",
        { for: "case-subject" },
        text(carried === null ? "Subject" : "Subject (carried from the page you came from)"),
      ),
      el("input", {
        type: "text",
        name: "subject",
        id: "case-subject",
        required: true,
        ...(carried !== null ? { value: carried.subject } : {}),
      }),
      el("label", { for: "case-description" }, text("Description")),
      el("input", {
        type: "text",
        name: "description",
        id: "case-description",
        required: true,
        ...(carried !== null ? { value: contextNarrative(carried) } : {}),
      }),
      el("label", { for: "case-priority" }, text("Priority")),
      el(
        "select",
        { name: "priority", id: "case-priority" },
        ...(["low", "normal", "high", "urgent"] as const).map((priority) =>
          el("option", { value: priority }, text(priority)),
        ),
      ),
      ...(carried?.refs ?? []).map((ref) =>
        el("input", {
          type: "hidden",
          name: "relatedRef",
          value: `${ref.kind}~${ref.id}`,
          "data-related-ref-kind": ref.kind,
          "data-related-ref-id": ref.id,
        }),
      ),
      el("button", { type: "submit" }, text("Open case")),
      el(
        "p",
        { class: "muted", "data-support-context-note": carried === null ? "false" : "true" },
        text(
          carried === null
            ? "Nothing is attached automatically from this form. When you open a case from a degraded page, RoamLink shows you exactly what will be attached first."
            : "Opening this case attaches the references listed above so support sees the same facts you see. You can remove them by editing the fields before sending.",
        ),
      ),
    ),
  );
}

function carriedContextPanel(carried: SupportCaseContext | null): HtmlFragment {
  if (carried === null || carried.refs.length === 0) return fragment();
  return el(
    "section",
    { class: "panel", "data-carried-support-context": "true" },
    fragment(
      el("h3", {}, text("Context carried from the page you came from")),
      el("p", {}, text(carried.subject)),
      carried.detail === undefined ? fragment() : el("p", { class: "muted" }, text(carried.detail)),
      el(
        "p",
        { class: "muted" },
        text(
          "A case opened here will attach these references automatically — remove any you would rather not share:",
        ),
      ),
      el(
        "ul",
        { class: "evidence-list", "data-carried-context-refs": "true" },
        ...carried.refs.map((ref) =>
          el("li", { "data-carried-ref-kind": ref.kind }, text(`${ref.kind} ${ref.id}`)),
        ),
      ),
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

/** Re-exported for hosts composing the flow parsing next to the page. */
export { readSupportContextParams, supportContextParams };
