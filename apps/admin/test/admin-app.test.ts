/**
 * Admin console authorization fail-closed proofs (RL-061, the top threat:
 * privilege escalation through administrative toolting - spec/security.md).
 *
 * Every surface is proven to fail closed for actors without the required
 * permission, including the "no data even fetched" property: the console
 * resolves the actor session BEFORE requesting surface data, so a denied
 * actor never triggers the surface request. All flows run through the REAL
 * client against the deterministic fake with testkit clocks/ids.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type HttpRequest,
  type HttpResponse,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { AdminConsoleApp, SURFACE_READ_PERMISSIONS } from "../src/app.js";
import type { AdminPageName } from "../src/routes.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const OTHER_TENANT = "org:99999999-8888-4777-8666-555555555555";
const OWNER = "usr:aaaaaaaa-0000-4000-8000-000000000001";
const ADMIN = "usr:aaaaaaaa-0000-4000-8000-000000000002";
const MEMBER = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const CASE_ID = "cafecafe-0000-4000-8000-000000000001";
const ALL_SURFACES: readonly AdminPageName[] = [
  "tenants",
  "audit",
  "reconciliation",
  "projectionHealth",
  "supportTriage",
];

function buildConsole(options?: {
  actor?: string;
  tenant?: string;
  captured?: HttpRequest[];
  /** Share an existing fake (state, clock) across consoles. */
  shared?: ReturnType<typeof newFake>;
}) {
  const fake = options?.shared ?? newFake();
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const transport =
    options?.captured === undefined
      ? fake.transport
      : {
          async request(request: HttpRequest): Promise<HttpResponse> {
            options.captured?.push(request);
            return fake.transport.request(request);
          },
        };
  const client = new RoamLinkApiClient({
    transport,
    actor: { actorId: options?.actor ?? OWNER, tenantId: options?.tenant ?? TENANT },
    ids: new DeterministicUuidGenerator(200_000),
  });
  const console = new AdminConsoleApp({ client });
  return { console, fake, clock, client };
}

function newFake() {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(100_000);
  return createInMemoryApi(fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
}

describe("fail-closed rendering gate (privilege-escalation threat)", () => {
  it("a member (org:read only) sees every READ surface but no command succeeds", async () => {
    const { console } = buildConsole({ actor: MEMBER });
    for (const surface of ALL_SURFACES) {
      const page = await console.renderPage({ page: surface });
      expect(
        page.html.includes('data-access-denied="true"'),
        `surface ${surface} should render for a member (org:read)`,
      ).toBe(false);
    }
    // The command surfaces fail closed server-side:
    const suspend = await console.suspendOrganizationFlow({ tenantId: TENANT });
    expect(suspend.status).toBe("error");
    const trigger = await console.triggerReconciliationFlow();
    expect(trigger.status).toBe("error");
    const advance = await console.advanceSupportCaseFlow({
      caseId: CASE_ID,
      transition: "resolve",
    });
    expect(advance.status).toBe("error");
  });

  it("a member's denied commands render as typed unauthorized panels and are audited", async () => {
    const { console } = buildConsole({ actor: MEMBER });
    const result = await console.suspendOrganizationFlow({ tenantId: TENANT });
    expect(result.status).toBe("error");
    const page = await console.renderPage({ page: "tenants", lastResult: result });
    expect(page.html).toContain('data-error-kind="unauthorized"');
    expect(page.html).toContain('data-error-reason="ACTOR_PERMISSION_MISSING"');
    expect(page.html).toContain("lacks the");

    // The denial is audited server-side with outcome 'denied' - on the SAME
    // fake the member's console used (a fresh one would know nothing).
    const harness = buildConsole({ actor: MEMBER });
    const denial = await harness.console.suspendOrganizationFlow({ tenantId: TENANT });
    expect(denial.status).toBe("error");
    const ownerConsole = buildConsole({ actor: OWNER, shared: harness.fake }).console;
    const auditPageHtml = await ownerConsole.renderPage({ page: "audit", auditCategory: "admin-override" });
    expect(auditPageHtml.html).toContain('data-audit-outcome="denied"');
    expect(auditPageHtml.html).toContain("org.suspend");
  });

  it("personal-tenant actors are denied every surface WITHOUT fetching its data", async () => {
    const captured: HttpRequest[] = [];
    const { console } = buildConsole({
      actor: MEMBER,
      tenant: `usr:aaaaaaaa-0000-4000-8000-000000000003`,
      captured,
    });
    for (const surface of ALL_SURFACES) {
      const page = await console.renderPage({ page: surface });
      expect(page.html).toContain('data-access-denied="true"');
      expect(page.html).toContain(`data-required-permission="${SURFACE_READ_PERMISSIONS[surface]}"`);
      expect(page.html).toContain("permission in tenant");
    }
    // Only the session requests happened - NO surface data was fetched.
    const surfacePaths = [
      "/v1/organizations",
      "/v1/audit-events",
      "/v1/reconciliation-jobs",
      "/v1/projection-health",
      "/v1/support-cases",
    ];
    for (const request of captured) {
      expect(
        surfacePaths.some((path) => request.path === path),
        `denied actor must not fetch surface data (got ${request.method} ${request.path})`,
      ).toBe(false);
    }
  });

  it("cross-tenant actors render typed error panels (404, no oracle)", async () => {
    const { console } = buildConsole({ actor: MEMBER, tenant: OTHER_TENANT });
    const page = await console.renderPage({ page: "tenants" });
    expect(page.html).toContain('data-error-kind="not-found"');
    expect(page.html).not.toContain('data-organization-id');
  });

  it("session read failures render the typed error panel, never the surface", async () => {
    const { console } = buildConsole({ actor: OWNER });
    // A session that cannot be resolved at all:
    const brokenConsole = new AdminConsoleApp({
      client: new RoamLinkApiClient({
        transport: {
          async request(): Promise<HttpResponse> {
            return {
              status: 503,
              body: JSON.stringify({
                kind: "unavailable",
                reason: "SESSION_STORE_DOWN",
                message: "session resolution is temporarily unavailable",
                retryable: true,
                details: [],
              }),
            };
          },
        },
        actor: { actorId: OWNER, tenantId: TENANT },
        ids: new DeterministicUuidGenerator(300_000),
      }),
    });
    const page = await brokenConsole.renderPage({ page: "audit" });
    expect(page.html).toContain('data-error-kind="unavailable"');
    expect(page.html).not.toContain('data-audit-events');
    // Sanity: the working console still renders.
    const ok = await console.renderPage({ page: "audit" });
    expect(ok.html).toContain('data-chain-verified="true"');
  });
});

describe("owner/admin operations over the same command semantics", () => {
  it("an admin suspends and reactivates the org; the escape is audited", async () => {
    const harness = buildConsole({ actor: ADMIN });
    const { console } = harness;
    const suspended = await console.suspendOrganizationFlow(
      { tenantId: TENANT },
      { correlationId: "ops-suspend-1" },
    );
    expect(suspended.status).toBe("ok");

    // While suspended, member access is blocked fail-closed - on the SAME
    // fake (the suspension actually happened).
    const memberConsole = buildConsole({ actor: MEMBER, shared: harness.fake }).console;
    const memberPage = await memberConsole.renderPage({ page: "tenants" });
    expect(memberPage.html).toContain("ORGANIZATION_SUSPENDED");
    expect(memberPage.html).not.toContain('data-organization-id');

    const suspendedVersion = suspended.status === "ok" ? suspended.acknowledgement.resource?.version : undefined;
    const reactivated = await console.reactivateOrganizationFlow(
      { tenantId: TENANT, ...(suspendedVersion !== undefined ? { expectedVersion: suspendedVersion } : {}) },
      { correlationId: "ops-reactivate-1" },
    );
    expect(reactivated.status).toBe("ok");

    const auditPage = await console.renderPage({ page: "audit", auditCategory: "admin-override" });
    expect(auditPage.html).toContain("org.suspend");
    expect(auditPage.html).toContain("org.reactivate");
    expect(auditPage.html).toContain('data-audit-outcome="allowed"');
  });

  it("triggering reconciliation reports honest outcomes (never invented repairs)", async () => {
    const { console } = buildConsole({ actor: ADMIN });
    const result = await console.triggerReconciliationFlow({ idempotencyKey: "ops-job-1" });
    expect(result.status).toBe("ok");
    const page = await console.renderPage({ page: "reconciliation", lastResult: result });
    expect(page.html).toContain('data-stage="accepted" data-reached="true"');
    expect(page.html).toContain('data-stage="executed" data-reached="true"');
    expect(page.html).toContain('data-job-status="COMPLETED"');
    expect(page.html).toContain('data-action-outcome="ALREADY_CONSISTENT"');
    expect(page.html).toContain('data-action-outcome="DEGRADED_STALE"');
    expect(page.html).toContain('data-action-outcome="DEGRADED_UNKNOWN"');
  });

  it("triage advances a case and sees internal messages (ops view)", async () => {
    const { console } = buildConsole({ actor: ADMIN });
    const before = await console.renderPage({ page: "supportTriage" });
    expect(before.html).toContain('data-message-visibility="internal"');
    expect(before.html).toContain('data-message-visibility="customer"');

    const result = await console.advanceSupportCaseFlow({
      caseId: CASE_ID,
      transition: "resolve",
    });
    expect(result.status).toBe("ok");
    const after = await console.renderPage({ page: "supportTriage", lastResult: result });
    expect(after.html).toContain('data-case-status="resolved"');
  });

  it("illegal case transitions fail typed", async () => {
    const { console } = buildConsole({ actor: ADMIN });
    const result = await console.advanceSupportCaseFlow({
      caseId: CASE_ID,
      transition: "startProgress",
    });
    expect(result.status).toBe("error");
    const page = await console.renderPage({ page: "supportTriage", lastResult: result });
    expect(page.html).toContain('data-error-kind="validation"');
  });
});

describe("audit review surface integrity", () => {
  it("renders the digest chain banner and event rows with correlation", async () => {
    const { console } = buildConsole({ actor: OWNER });
    const suspended = await console.suspendOrganizationFlow({ tenantId: TENANT }, { correlationId: "chain-1" });
    expect(suspended.status).toBe("ok");
    // Suspension blocks all reads; reactivate (the sanctioned escape) with
    // the suspension acknowledgement's version so the audit review can render.
    const suspendedVersion = suspended.status === "ok" ? suspended.acknowledgement.resource?.version : undefined;
    const reactivated = await console.reactivateOrganizationFlow({
      tenantId: TENANT,
      ...(suspendedVersion !== undefined ? { expectedVersion: suspendedVersion } : {}),
    });
    expect(reactivated.status).toBe("ok");
    const page = await console.renderPage({ page: "audit" });
    expect(page.html).toContain('data-chain-verified="true"');
    expect(page.html).toContain('data-audit-events="true"');
    expect(page.html).toContain("chain-1");
    expect(page.html).toContain("Digest chain verified");
  });

  it("events and admin-override categories appear once actions happened", async () => {
    const harness = buildConsole({ actor: OWNER });
    // A member denial is audited; an allowed owner action is audited.
    const memberConsole = buildConsole({ actor: MEMBER, shared: harness.fake }).console;
    const denied = await memberConsole.suspendOrganizationFlow({ tenantId: TENANT });
    expect(denied.status).toBe("error");
    const suspended = await harness.console.suspendOrganizationFlow({ tenantId: TENANT });
    expect(suspended.status).toBe("ok");
    const suspendedVersion = suspended.status === "ok" ? suspended.acknowledgement.resource?.version : undefined;
    await harness.console.reactivateOrganizationFlow({
      tenantId: TENANT,
      ...(suspendedVersion !== undefined ? { expectedVersion: suspendedVersion } : {}),
    });
    const page = await harness.console.renderPage({ page: "audit" });
    expect(page.html).toContain('data-audit-events="true"');
    expect(page.html).toContain("admin-override");
    expect(page.html).toContain('data-audit-outcome="denied"');
    expect(page.html).toContain('data-audit-outcome="allowed"');
  });
});

describe("projection health dashboard (observability SLO surfaces)", () => {
  it("shows freshness states honestly; degraded overall; no-data never healthy", async () => {
    const { console } = buildConsole({ actor: ADMIN });
    const page = await console.renderPage({ page: "projectionHealth" });
    expect(page.html).toContain('data-projection-freshness="FRESH"');
    expect(page.html).toContain('data-projection-freshness="STALE"');
    expect(page.html).toContain('data-projection-freshness="UNKNOWN"');
    expect(page.html).toContain('data-health="degraded"');
    expect(page.html).toContain('data-slos');
    expect(page.html).toContain("no-data is never healthy");
  });

  it("an empty-tenant health surface renders honest empties", async () => {
    const { console } = buildConsole({ actor: MEMBER, tenant: OTHER_TENANT });
    // MEMBER is not in OTHER_TENANT -> 404 panels (fail closed, no oracle).
    const page = await console.renderPage({ page: "projectionHealth" });
    expect(page.html).toContain('data-error-kind="not-found"');
  });
});
