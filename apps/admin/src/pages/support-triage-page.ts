/**
 * The support-case triage page (RL-061): the OPERATIONS view - unlike the
 * customer thread, triage shows internal messages explicitly (the structural
 * visibility boundary is per-audience: internal notes are console-only).
 * Case transitions go through the same command semantics (org:manage,
 * enforced server-side; audited as admin-override).
 */
import {
  instantView,
  stateBadge,
  el,
  fragment,
  text,
  type HtmlFragment,
  type SupportCaseResource,
} from "@roamlink/app-kit";

import { pageHeading } from "../page-kit.js";

const TRANSITIONS = ["startProgress", "resolve", "close", "cancel"] as const;

export function supportTriagePage(input: {
  readonly cases: readonly SupportCaseResource[];
}): HtmlFragment {
  return fragment(
    pageHeading(
      "Support triage",
      "The operations view: internal messages are visible here and structurally absent from the customer thread. Transitions require org:manage and are audited.",
    ),
    input.cases.length === 0
      ? el("p", { class: "muted" }, text("No support cases to triage."))
      : fragment(...input.cases.map(caseCard)),
    pageHeading("Advance a case"),
    el(
      "form",
      { method: "post", action: "/admin/flows/advance-support-case", "data-flow": "advance-support-case" },
      el("label", {}, text("Case id ")),
      el("input", { type: "text", name: "caseId", required: true }),
      el(
        "select",
        { name: "transition" },
        ...TRANSITIONS.map((transition) => el("option", { value: transition }, text(transition))),
      ),
      el("button", { type: "submit" }, text("Apply transition")),
    ),
  );
}

function caseCard(supportCase: SupportCaseResource): HtmlFragment {
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
          text(` by ${supportCase.createdByUserId}`),
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
      pageHeading("Thread (operations view: customer + internal)"),
      supportCase.messages.length === 0
        ? el("p", { class: "muted" }, text("No messages yet."))
        : el(
            "ul",
            { "data-triage-thread": "true" },
            ...supportCase.messages.map((message) =>
              el(
                "li",
                {
                  "data-message-id": message.messageId,
                  "data-message-visibility": message.visibility,
                },
                fragment(
                  text(`[${message.sentAt}] (${message.visibility}) `),
                  text(message.body),
                ),
              ),
            ),
          ),
    ),
  );
}
