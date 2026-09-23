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
  type FakeApiSeed,
  type FakeIntegrationHealthSeed,
  type FakeTenantSeed,
  type HttpRequest,
  type HttpResponse,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { AdminConsoleApp, SURFACE_READ_PERMISSIONS } from "../src/app.js";
import { OPS_SLO_DASHBOARD_PATH, type AdminPageName } from "../src/routes.js";

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
  "integrationHealth",
];

function buildConsole(options?: {
  actor?: string;
  tenant?: string;
  captured?: HttpRequest[];
  /** Share an existing fake (state, clock) across consoles. */
  shared?: ReturnType<typeof newFake>;
  /** Scenario seed (the integration-health worlds derive from it). */
  seed?: FakeApiSeed;
}) {
  const fake = options?.shared ?? newFake(options?.seed);
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

function newFake(seed?: FakeApiSeed) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(100_000);
  return createInMemoryApi(seed ?? fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
}

/**
 * Derives an integration-health scenario world (PA-010): the recorded probe
 * outcome of the default tenant is replaced (or removed, for the unknown
 * world) while every other fact stays identical.
 */
function integrationHealthSeed(
  integrationHealth: FakeIntegrationHealthSeed | undefined,
): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  const { integrationHealth: _removed, ...rest } = tenant;
  tenants[TENANT] =
    integrationHealth === undefined ? rest : { ...rest, integrationHealth };
  return { ...seed, tenants };
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
      "/v1/integration-health",
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

describe("SLO health navigation entry (PA-009, closes RL-115-F2)", () => {
  it("every console page's nav renders the SLO health entry pointing at the ops route", async () => {
    const { console } = buildConsole({ actor: ADMIN });
    for (const surface of ALL_SURFACES) {
      const doc = await console.renderDocument({ page: surface });
      // The entry is a real anchor in the shell nav, labelled per §13's
      // "SLO health" vocabulary, with the host ops route as its href.
      expect(
        doc,
        `${surface}: the SLO health nav entry`,
      ).toContain(`<a href="${OPS_SLO_DASHBOARD_PATH}">SLO health</a>`);
    }
  });

  it("the entry is a link, not a console surface: no SLO read is triggered and no dashboard content is rendered", async () => {
    const captured: HttpRequest[] = [];
    const { console } = buildConsole({ actor: ADMIN, captured });
    const doc = await console.renderDocument({ page: "tenants" });
    // The console composes NO SLO dashboard content of its own — the
    // host-side surface (RL-109) owns the view over the real recorder state.
    expect(doc).not.toContain("data-slo-dashboard");
    expect(doc).not.toMatch(/data-slo-id=/);
    // The entry adds ZERO requests: rendering a console page with the nav
    // entry performs no SLO-related read (the target owns both the gate
    // and the data; nothing is fetched or fabricated here).
    for (const request of captured) {
      expect(request.path, "the console never reads SLO state").not.toMatch(/slo/i);
    }
  });

  it("the gate behavior is unchanged: the entry renders on the denied panel too, and the target keeps its own session gate", async () => {
    // A personal-tenant actor is denied every console surface (the
    // fail-closed gate) — yet the nav, including the SLO health entry,
    // still renders: the link is navigation chrome, and the PERMISSION
    // decision lives at the target (/ops/slo enforces org:read with its
    // own session resolution — proven in apps/portal-host/test/ops-slo.test.ts).
    const { console } = buildConsole({
      actor: MEMBER,
      tenant: `usr:aaaaaaaa-0000-4000-8000-000000000003`,
    });
    const doc = await console.renderDocument({ page: "tenants" });
    expect(doc).toContain('data-access-denied="true"');
    expect(doc).toContain(`data-required-permission="${SURFACE_READ_PERMISSIONS.tenants}"`);
    expect(doc).toContain(`<a href="${OPS_SLO_DASHBOARD_PATH}">SLO health</a>`);
    // The denied render leaked no surface state before the entry and still
    // does not: the entry introduced no data path.
    expect(doc).not.toContain("data-slo-dashboard");
  });
});

describe("Integration health surface (PA-010, closes RL-115-F6)", () => {
  it("the compatible world renders the recorded report: state, version, last-checked, every check passed, mutations allowed", async () => {
    const { console } = buildConsole({ actor: ADMIN });
    const page = await console.renderPage({ page: "integrationHealth" });
    expect(page.html).toContain('data-integration-health="true"');
    expect(page.html).toContain('data-integration-state="compatible"');
    expect(page.html).toContain(">Compatible</span>");
    expect(page.html).toContain('data-mutations="allowed"');
    expect(page.html).toContain("mutations allowed");
    // The supported API version renders (the single-site pin).
    expect(page.html).toContain('data-fact="supported-api-version"');
    expect(page.html).toContain("Supported ADCOS API version: 2.0");
    // Freshness pairs with the state: the recorded last-checked instant.
    expect(page.html).toContain('data-fact="last-checked"');
    expect(page.html).toContain('data-last-checked="2025-01-06T09:00:00.000Z"');
    expect(page.html).toContain("2025-01-06T09:00:00.000Z");
    // The recorded report's checks render as the real §9 suite names, all
    // passed — and no failure explanation exists on a compatible report.
    expect(page.html).toContain('data-compat-checks="true"');
    expect(page.html).toContain('data-check-name="application_self.available"');
    expect(page.html).toContain('data-check-name="version_pin.single_site"');
    expect(page.html).not.toContain('data-check-passed="false"');
    expect(page.html).not.toContain('data-failure-explanation');
    // The read-only discipline is stated on the surface itself.
    expect(page.html).toContain("never triggers the probe");
    expect(page.html).toContain("never changes compatibility state");
  });

  it("the incompatible world renders the fail-closed state with a useful failure explanation", async () => {
    const { console } = buildConsole({
      actor: ADMIN,
      seed: integrationHealthSeed({
        state: "incompatible",
        supportedApiVersion: "2.0",
        lastCheckedAt: "2025-01-06T09:40:00.000Z",
        suiteVersion: "1.0",
        checks: [
          {
            name: "application_self.available",
            passed: true,
            detail: "GET application answered with a contract-shaped response",
          },
          {
            name: "contract_lifecycle_states.required",
            passed: false,
            code: "ADCOS_CONTRACT_STATE_INVALID",
            detail: "the pinned contract-state vocabulary must carry the 13 documented v2 states (found 11)",
          },
          {
            name: "version_pin.single_site",
            passed: false,
            code: "ADCOS_VERSION_UNSUPPORTED",
            detail: "the endpoint rejects the pinned ADCOS API version",
          },
        ],
      }),
    });
    const page = await console.renderPage({ page: "integrationHealth" });
    expect(page.html).toContain('data-integration-state="incompatible"');
    expect(page.html).toContain(">Incompatible</span>");
    expect(page.html).toContain('data-mutations="fail-closed"');
    expect(page.html).toContain("mutations fail closed");
    // The failure explanation is the recorded failed checks — names, codes
    // and value-free details, never a guess.
    expect(page.html).toContain('data-failure-explanation="true"');
    expect(page.html).toContain("Why the probe recorded incompatible");
    expect(page.html).toContain("2 of 3 recorded checks failed");
    expect(page.html).toContain('data-failed-check="contract_lifecycle_states.required"');
    expect(page.html).toContain("contract_lifecycle_states.required (ADCOS_CONTRACT_STATE_INVALID)");
    expect(page.html).toContain('data-failed-check="version_pin.single_site"');
    expect(page.html).toContain("version_pin.single_site (ADCOS_VERSION_UNSUPPORTED)");
    // The passing check still renders as passed (the full report is shown).
    expect(page.html).toContain('data-check-name="application_self.available"');
    expect(page.html).toContain('data-check-passed="true"');
    // Freshness pairs with the state (the recorded instant, not "now").
    expect(page.html).toContain('data-last-checked="2025-01-06T09:40:00.000Z"');
  });

  it("the not-configured world renders the honest first-class state — never a fabricated compatibility", async () => {
    const { console } = buildConsole({
      actor: ADMIN,
      seed: integrationHealthSeed({
        state: "not-configured",
        supportedApiVersion: "2.0",
      }),
    });
    const page = await console.renderPage({ page: "integrationHealth" });
    expect(page.html).toContain('data-integration-state="not-configured"');
    expect(page.html).toContain(">Not configured</span>");
    expect(page.html).toContain("The ADCOS probe environment is not configured");
    expect(page.html).toContain("no compatibility claim is made");
    // No report exists: never checked, no checks, mutations fail closed.
    expect(page.html).toContain('data-never-checked="true"');
    expect(page.html).toContain("never checked (no report recorded)");
    expect(page.html).toContain('data-compat-checks="none"');
    expect(page.html).not.toContain('data-check-name=');
    expect(page.html).toContain('data-mutations="fail-closed"');
    // The supported pin still renders (it is a pin, not a probe outcome).
    expect(page.html).toContain("Supported ADCOS API version: 2.0");
  });

  it("the unknown world renders the fail-closed default (no report recorded — absent seed is unknown, never healthy)", async () => {
    // The absent seed section IS the honest unknown world (nothing recorded).
    const { console } = buildConsole({ actor: ADMIN, seed: integrationHealthSeed(undefined) });
    const page = await console.renderPage({ page: "integrationHealth" });
    expect(page.html).toContain('data-integration-state="unknown"');
    expect(page.html).toContain(">Unknown</span>");
    expect(page.html).toContain("The compatibility gate has not recorded a report");
    expect(page.html).toContain("Mutations are refused until a startup compatibility check passes");
    expect(page.html).toContain('data-never-checked="true"');
    expect(page.html).toContain('data-compat-checks="none"');
    expect(page.html).toContain('data-mutations="fail-closed"');
  });

  it("the surface performs NO mutations: rendering is read-only and never triggers the probe", async () => {
    const captured: HttpRequest[] = [];
    const { console } = buildConsole({ actor: ADMIN, captured });
    const first = await console.renderPage({ page: "integrationHealth" });
    expect(first.html).toContain('data-integration-state="compatible"');
    // Every request is a READ (GET): the session resolution + the one
    // integration-health read. No mutation route, no probe trigger, no
    // adcos route is ever requested by the console surface.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const request of captured) {
      expect(request.method, "the surface only reads").toBe("GET");
      expect(request.path, "the surface never mutates or probes").not.toMatch(/probe|adcos|suspend|reactivate|trigger|transitions/);
    }
    const paths = captured.map((request) => `${request.method} ${request.path}`);
    expect(paths).toContain("GET /v1/integration-health");
    // Re-rendering is pure: the recorded state is unchanged by being read.
    const second = await console.renderPage({ page: "integrationHealth" });
    expect(second.html).toContain('data-integration-state="compatible"');
    expect(second.html).toContain('data-last-checked="2025-01-06T09:00:00.000Z"');
    // The mutations-allowed fact comes from the recorded state only — the
    // gate itself stays inside the ADCOS integration boundary.
    expect(second.html).toContain('data-mutations="allowed"');
  });

  it("freshness pairs with the state on every world (§14: text plus treatment, never hidden)", async () => {
    // Report states: the recorded last-checked instant renders BESIDE the
    // state; no-report states: the honest "never checked" renders.
    const compatible = await buildConsole({ actor: ADMIN }).console.renderPage({ page: "integrationHealth" });
    expect(compatible.html).toMatch(/data-integration-state="compatible"[\s\S]{0,2000}?data-last-checked="2025-01-06T09:00:00\.000Z"/);
    expect(compatible.html).toContain('data-fact="presented-at"');
    expect(compatible.html).toContain("Presented at: 2025-01-06T09:45:00.000Z");
    const notConfigured = await buildConsole({
      actor: ADMIN,
      seed: integrationHealthSeed({ state: "not-configured", supportedApiVersion: "2.0" }),
    }).console.renderPage({ page: "integrationHealth" });
    expect(notConfigured.html).toMatch(/data-integration-state="not-configured"[\s\S]{0,2000}?data-never-checked="true"/);
    expect(notConfigured.html).toContain('data-fact="presented-at"');
  });

  it("the nav entry renders on every console page (including denied renders — the nav is chrome)", async () => {
    const { console } = buildConsole({ actor: ADMIN });
    for (const surface of ALL_SURFACES) {
      const doc = await console.renderDocument({ page: surface });
      expect(doc, `${surface}: the integration-health nav entry`).toContain(
        '<a href="/integration-health">Integration health</a>',
      );
    }
    // A personal-tenant actor is denied the surface (fail-closed gate) but
    // the nav entry still renders — and the surface's data is never fetched.
    const captured: HttpRequest[] = [];
    const denied = buildConsole({
      actor: MEMBER,
      tenant: `usr:aaaaaaaa-0000-4000-8000-000000000003`,
      captured,
    });
    const doc = await denied.console.renderDocument({ page: "integrationHealth" });
    expect(doc).toContain('data-access-denied="true"');
    expect(doc).toContain(`data-required-permission="${SURFACE_READ_PERMISSIONS.integrationHealth}"`);
    expect(doc).toContain('<a href="/integration-health">Integration health</a>');
    expect(doc).not.toContain('data-integration-state=');
    for (const request of captured) {
      expect(request.path).not.toBe("/v1/integration-health");
    }
  });

  it("a read failure renders the typed error panel, never a guessed compatibility", async () => {
    const brokenConsole = new AdminConsoleApp({
      client: new RoamLinkApiClient({
        transport: {
          async request(): Promise<HttpResponse> {
            return {
              status: 503,
              body: JSON.stringify({
                kind: "unavailable",
                reason: "READ_MODEL_NOT_COMPOSED",
                message: "the integration-health read model is not composed on this runtime",
                retryable: true,
                details: [],
              }),
            };
          },
        },
        actor: { actorId: ADMIN, tenantId: TENANT },
        ids: new DeterministicUuidGenerator(400_000),
      }),
    });
    const page = await brokenConsole.renderPage({ page: "integrationHealth" });
    expect(page.html).toContain('data-error-kind="unavailable"');
    expect(page.html).not.toContain('data-integration-state=');
    expect(page.html).not.toContain('data-integration-health=');
  });
});
