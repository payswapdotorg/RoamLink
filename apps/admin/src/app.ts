/**
 * The admin/operations console (RL-061).
 *
 * A view + command surface over the SAME public application APIs the
 * customer app consumes. It holds NO parallel authority: authorization is
 * enforced by the API (spec/security.md "Authorization"), and the console
 * adds a FAIL-CLOSED RENDERING GATE on top - the top threat for admin
 * tooling is privilege escalation, so every surface resolves the actor's
 * session BEFORE any surface data is fetched and renders an access-denied
 * panel (never the surface, never partial data) when the actor lacks the
 * required permission. A denied actor therefore never even triggers the
 * surface's data request.
 *
 * Admin actions go through the SAME command semantics as everything else:
 * full envelope (request/correlation/idempotency ids, actor/tenant context),
 * optimistic version for existing resources, tenant-checked and
 * permission-checked by the API - denials surface as typed error panels and
 * are audited server-side.
 */
import {
  errorPanel,
  mutationResultPanel,
  pageShell,
  type ActorSessionResource,
  type HtmlFragment,
  type MutationAcknowledgement,
  type MutationFlowResult,
  type RoamLinkApiClient,
} from "@roamlink/app-kit";
import { htmlDocument, fragment, el, text } from "@roamlink/app-kit";

import { auditPage } from "./pages/audit-page.js";
import { integrationHealthPage } from "./pages/integration-health-page.js";
import { projectionHealthPage } from "./pages/projection-health-page.js";
import { reconciliationPage } from "./pages/reconciliation-page.js";
import { supportTriagePage } from "./pages/support-triage-page.js";
import { tenantsPage } from "./pages/tenants-page.js";
import { adminPagePath, OPS_SLO_DASHBOARD_PATH, type AdminPageName } from "./routes.js";

/**
 * The permission each surface requires (rendering gate). These mirror the
 * API contract's server-side requirements (app-kit README "Admin surface
 * permission mapping"): reads need `org:read`; the commands need
 * `org:manage` (enforced by the API, mirrored here only for rendering).
 */
export const SURFACE_READ_PERMISSIONS: Readonly<Record<AdminPageName, string>> = Object.freeze({
  tenants: "org:read",
  audit: "org:read",
  reconciliation: "org:read",
  projectionHealth: "org:read",
  supportTriage: "org:read",
  // PA-010: the integration-health read is a read surface like the other
  // observability pages (the API enforces org:read; the console mirrors it
  // for the fail-closed rendering gate).
  integrationHealth: "org:read",
});

export interface AdminConsoleAppDeps {
  readonly client: RoamLinkApiClient;
}

/** One rendered console page request. */
export interface AdminPageRequest {
  readonly page: AdminPageName;
  readonly lastResult?: MutationFlowResult;
  /** Audit filters (only used by the audit page). */
  readonly auditCategory?: "auth" | "secret-access" | "authority-decision" | "admin-override";
}

/**
 * The console navigation. The six console pages — the §13 admin musts
 * (tenants, audit/security events, reconciliation, projection freshness,
 * support triage) plus the integration-health page (PA-010, closes
 * RL-115-F6: the recorded ADCOS compatibility probe outcome) — and the §13
 * "SLO health" entry (PA-009, closes RL-115-F2): a plain link to the HOST's
 * session-gated `/ops/slo` ops surface (RL-109) — not a console page, so it
 * has no SURFACE_READ_PERMISSIONS row and fetches nothing here. The links
 * render on every console page (including denied renders — the nav is
 * chrome); the TARGET keeps its own fail-closed session + `org:read` gate,
 * exactly the discipline apps/portal-host enforces for the ops surface.
 */
const NAV = [
  { label: "Tenants", href: adminPagePath("tenants") },
  { label: "Audit & security", href: adminPagePath("audit") },
  { label: "Reconciliation", href: adminPagePath("reconciliation") },
  { label: "Projection health", href: adminPagePath("projectionHealth") },
  { label: "SLO health", href: OPS_SLO_DASHBOARD_PATH },
  { label: "Support triage", href: adminPagePath("supportTriage") },
  { label: "Integration health", href: adminPagePath("integrationHealth") },
] as const;

export class AdminConsoleApp {
  readonly #client: RoamLinkApiClient;

  constructor(deps: AdminConsoleAppDeps) {
    this.#client = deps.client;
  }

  client(): RoamLinkApiClient {
    return this.#client;
  }

  // ---------------------------------------------------------------------------
  // Rendering (fail-closed gate BEFORE any surface data is fetched)
  // ---------------------------------------------------------------------------

  async renderDocument(request: AdminPageRequest): Promise<string> {
    const body = await this.renderPage(request);
    return htmlDocument(
      `RoamLink Ops - ${request.page}`,
      pageShell({
        appTitle: "RoamLink Ops",
        navLinks: [...NAV],
        main: body,
        footerNote:
          "RoamLink admin console (RL-061): a view + command surface over the same public APIs; authorization is enforced server-side and rendered fail-closed.",
      }),
    ).html;
  }

  async renderPage(request: AdminPageRequest): Promise<HtmlFragment> {
    const gate = await this.#gate(SURFACE_READ_PERMISSIONS[request.page]);
    const pageBody = gate.ok
      ? await this.#renderSurface(request)
      : gate.deniedPanel;
    return fragment(
      request.lastResult === undefined ? fragment() : mutationResultPanel(request.lastResult),
      pageBody,
    );
  }

  async #renderSurface(request: AdminPageRequest): Promise<HtmlFragment> {
    switch (request.page) {
      case "tenants":
        return tenantsPage({ organizations: await this.#client.listOrganizations() });
      case "audit":
        return auditPage({
          audit: await this.#client.listAuditEvents({
            ...(request.auditCategory !== undefined ? { category: request.auditCategory } : {}),
          }),
        });
      case "reconciliation":
        return reconciliationPage({
          jobs: await this.#client.listReconciliationJobs(),
        });
      case "projectionHealth":
        return projectionHealthPage({ health: await this.#client.getProjectionHealth() });
      case "supportTriage":
        return supportTriagePage({ cases: await this.#client.listSupportCases() });
      case "integrationHealth":
        // PA-010: the recorded probe outcome through the application contract
        // — a READ. The surface never triggers the probe and never mutates
        // compatibility state (the gate stays in the integration boundary).
        return integrationHealthPage({ health: await this.#client.getIntegrationHealth() });
    }
  }

  /**
   * The fail-closed rendering gate: resolve the actor's session; on ANY
   * failure (transport, auth, tenant mismatch) or a missing permission,
   * render the denied panel WITHOUT fetching the surface's data.
   */
  async #gate(
    permission: string,
  ): Promise<
    | { readonly ok: true; readonly session: ActorSessionResource }
    | { readonly ok: false; readonly deniedPanel: HtmlFragment }
  > {
    let session: ActorSessionResource;
    try {
      session = await this.#client.getActorSession();
    } catch (error) {
      return { ok: false, deniedPanel: errorPanel(error) };
    }
    if (!session.permissions.includes(permission)) {
      return { ok: false, deniedPanel: accessDeniedPanel(session, permission) };
    }
    return { ok: true, session };
  }

  // ---------------------------------------------------------------------------
  // Admin command flows (same command semantics; server-authoritative)
  // ---------------------------------------------------------------------------

  /** Suspends the organization (read revision, then command). */
  async suspendOrganizationFlow(
    input: { readonly tenantId: string },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(async () => {
      const organizations = await this.#client.listOrganizations();
      const organization = organizations.find((o) => o.tenantId === input.tenantId);
      if (organization === undefined) {
        return this.#client.suspendOrganization(input, options);
      }
      return this.#client.suspendOrganization(input, {
        ...options,
        expectedVersion: organization.revision,
      });
    });
  }

  /**
   * Reactivates a suspended organization (the sanctioned escape).
   *
   * While the organization is suspended every READ is blocked (only the
   * reactivation command path is open), so the revision cannot be re-read:
   * the operator supplies the version from the suspension acknowledgement
   * (the command's optimistic anchor). Without it, the flow attempts the
   * read path - which fails closed with ORGANIZATION_SUSPENDED, exactly as
   * the boundary demands.
   */
  async reactivateOrganizationFlow(
    input: { readonly tenantId: string; readonly expectedVersion?: number },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(async () => {
      if (input.expectedVersion !== undefined) {
        return this.#client.reactivateOrganization(
          { tenantId: input.tenantId },
          { ...options, expectedVersion: input.expectedVersion },
        );
      }
      const organizations = await this.#client.listOrganizations();
      const organization = organizations.find((o) => o.tenantId === input.tenantId);
      if (organization === undefined) {
        return this.#client.reactivateOrganization({ tenantId: input.tenantId }, options);
      }
      return this.#client.reactivateOrganization(
        { tenantId: input.tenantId },
        { ...options, expectedVersion: organization.revision },
      );
    });
  }

  /** Triggers a manual reconciliation job. */
  async triggerReconciliationFlow(
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(() =>
      this.#client.triggerReconciliation({ trigger: "manual" }, options),
    );
  }

  /** Advances a support case through its triage lifecycle. */
  async advanceSupportCaseFlow(
    input: {
      readonly caseId: string;
      readonly transition: "startProgress" | "resolve" | "close" | "cancel";
    },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(async () => {
      const cases = await this.#client.listSupportCases();
      const supportCase = cases.find((c) => c.caseId === input.caseId);
      if (supportCase === undefined) {
        return this.#client.advanceSupportCase(input, options);
      }
      return this.#client.advanceSupportCase(input, {
        ...options,
        expectedVersion: supportCase.revision,
      });
    });
  }

  async #runMutation(
    run: () => Promise<MutationAcknowledgement>,
  ): Promise<MutationFlowResult> {
    try {
      return { status: "ok", acknowledgement: await run() };
    } catch (error) {
      return { status: "error", error };
    }
  }
}

/**
 * The access-denied panel: names the missing permission, shows the actor's
 * scope/role for context, and NEVER renders any surface data. Denials are
 * audited server-side; this panel includes no retry affordance that could
 * encourage escalation attempts.
 */
export function accessDeniedPanel(
  session: ActorSessionResource,
  permission: string,
): HtmlFragment {
  return el(
    "div",
    {
      class: "panel error",
      "data-access-denied": "true",
      "data-required-permission": permission,
    },
    fragment(
      el("h3", {}, text("Access denied")),
      el(
        "p",
        {},
        text(
          `This console surface requires the '${permission}' permission in tenant ${session.tenantId}.`,
        ),
      ),
      el(
        "p",
        { class: "muted" },
        text(
          `Your session: scope ${session.scope}${session.role === null ? "" : `, role ${session.role}`}. Authorization is enforced by the API; this decision is final for this session.`,
        ),
      ),
    ),
  );
}
