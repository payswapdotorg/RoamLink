/**
 * The tenants page (RL-061): organization management view + the
 * suspend/reactivate command surfaces. The console manages the organization
 * the actor administrates - cross-tenant targets are the confused-deputy
 * threat and fail closed with 404 at the API (spec/security.md).
 */
import {
  stateBadge,
  el,
  fragment,
  text,
  type HtmlFragment,
  type OrganizationResource,
} from "@roamlink/app-kit";

import { pageHeading } from "../page-kit.js";

export function tenantsPage(input: {
  readonly organizations: readonly OrganizationResource[];
}): HtmlFragment {
  return fragment(
    pageHeading(
      "Tenants & organizations",
      "Administrative view of the organization tied to your session's tenant. Cross-tenant management is not a console capability.",
    ),
    input.organizations.length === 0
      ? el("p", { class: "muted" }, text("No organization is visible for this session."))
      : fragment(...input.organizations.map(organizationCard)),
    pageHeading("Organization lifecycle commands"),
    el(
      "form",
      { method: "post", action: "/admin/flows/suspend-organization", "data-flow": "suspend-organization" },
      el("label", {}, text("Tenant id ")),
      el("input", { type: "text", name: "tenantId", required: true }),
      el("button", { type: "submit" }, text("Suspend organization")),
    ),
    el(
      "form",
      { method: "post", action: "/admin/flows/reactivate-organization", "data-flow": "reactivate-organization" },
      el("label", {}, text("Tenant id ")),
      el("input", { type: "text", name: "tenantId", required: true }),
      el("button", { type: "submit" }, text("Reactivate organization")),
    ),
    el(
      "p",
      { class: "muted" },
      text("Suspension blocks all member access; reactivation is the single sanctioned escape and is audited. Commands carry the full envelope and command against the current revision."),
    ),
  );
}

function organizationCard(organization: OrganizationResource): HtmlFragment {
  return el(
    "section",
    { class: "panel", "data-organization-id": organization.organizationId },
    fragment(
      el("h3", {}, text(organization.name)),
      el(
        "p",
        {},
        fragment(
          text("Status: "),
          stateBadge(organization.status),
          text(" Revision: "),
          text(organization.revision),
        ),
      ),
      el(
        "p",
        { class: "muted" },
        text(`Tenant ${organization.tenantId}; organization ${organization.organizationId}`),
      ),
      pageHeading("Members"),
      el(
        "table",
        { "data-members": "true" },
        el(
          "thead",
          {},
          el("tr", {}, el("th", {}, text("User")), el("th", {}, text("Role")), el("th", {}, text("Status"))),
        ),
        el(
          "tbody",
          {},
          ...organization.members.map((member) =>
            el(
              "tr",
              { "data-member-user-id": member.userId },
              el("td", {}, text(member.userId)),
              el("td", {}, stateBadge(member.role)),
              el("td", {}, stateBadge(member.status)),
            ),
          ),
        ),
      ),
    ),
  );
}
