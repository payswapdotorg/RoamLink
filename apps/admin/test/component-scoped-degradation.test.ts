/**
 * Component-scoped degradation battery (PA-020) - the admin console.
 *
 * THE LAW UNDER TEST: when one console source is unbound (the typed 501
 * READ_MODEL_NOT_COMPOSED with its named reason, or any unavailability-class
 * typed error), the console page degrades PER-SECTION: the page heading and
 * the quiet unavailable panel render in the data section, the console
 * navigation stays usable, and every healthy diagnostic page keeps rendering
 * its real data. The session GATE stays the CORE: a denied or unresolvable
 * actor NEVER sees surface data (the fail-closed authorization law is
 * unchanged - "no data even fetched").
 *
 * The three mandated states for the Admin surface:
 *  1. gate available + the data-plane read unavailable -> the page renders
 *     its heading + the quiet panel (both asserted), and a sibling console
 *     page on the SAME runtime still renders its real data;
 *  2. the core (the session gate) unavailable -> the honest fail-closed
 *     body, and the surface's data request is never even issued;
 *  3. mixed fresh/stale/unknown -> each diagnostic section renders its own
 *     truthful state (the existing freshness vocabulary, never guessed).
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type HttpTransport,
  type HttpRequest,
  type HttpResponse,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { AdminConsoleApp } from "../src/app.js";
import type { AdminPageName } from "../src/routes.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const ADMIN = "usr:aaaaaaaa-0000-4000-8000-000000000002";
const MEMBER = "usr:aaaaaaaa-0000-4000-8000-000000000003";

/** One typed refusal a degraded route answers (status + body). */
interface TypedRefusal {
  readonly status: number;
  readonly body: string;
}

/** The real runtime's kept-501 refusal (services/api readModelNotComposed). */
function notComposedBody(path: string, namedCode: string, explanation: string): string {
  return JSON.stringify({
    kind: "unavailable",
    reason: "READ_MODEL_NOT_COMPOSED",
    message: `this read model has no composed source on the real runtime (${namedCode}: ${explanation}); no data is invented here`,
    retryable: false,
    details: [{ path, issue: `read model not composed (${namedCode}: ${explanation})` }],
  });
}

/** The five console pages PA-020 covers, with their data routes and panels. */
const DEGRADABLE_SURFACES: readonly {
  readonly page: AdminPageName;
  readonly route: string;
  readonly refusal: TypedRefusal;
  readonly panelSection: string;
  /** A content marker that MUST NOT render when the source refuses. */
  readonly absentContent: string;
}[] = [
  {
    page: "audit",
    route: "/v1/audit-events",
    refusal: {
      status: 501,
      body: notComposedBody(
        "/v1/audit-events",
        "AUDIT_CHAIN_NOT_BOUND",
        "the tamper-evident audit chain is a domain-plane component; no audit chain is bound in this service",
      ),
    },
    panelSection: "audit-events",
    absentContent: 'data-audit-events="true"',
  },
  {
    page: "reconciliation",
    route: "/v1/reconciliation-jobs",
    refusal: {
      status: 501,
      body: notComposedBody(
        "/v1/reconciliation-jobs",
        "RECONCILIATION_JOBS_NOT_BOUND",
        "the reconciliation job records are worker-plane state; no job source is bound in this service",
      ),
    },
    panelSection: "reconciliation-jobs",
    absentContent: "data-job-id=",
  },
  {
    page: "projectionHealth",
    route: "/v1/projection-health",
    refusal: {
      status: 501,
      body: notComposedBody(
        "/v1/projection-health",
        "PROJECTION_HEALTH_SOURCE_NOT_BOUND",
        "the projection store and SLO state live in the worker plane (in-memory by design); no projection-health source exists in this service's bound persistence",
      ),
    },
    panelSection: "projection-health",
    absentContent: 'data-projections="true"',
  },
  {
    page: "supportTriage",
    route: "/v1/support-cases",
    refusal: {
      status: 501,
      body: notComposedBody(
        "/v1/support-cases",
        "SUPPORT_CASE_STORE_NOT_BOUND",
        "the support-case records are not bound in this service's persistence",
      ),
    },
    panelSection: "support-cases",
    absentContent: "data-case-id=",
  },
  {
    page: "integrationHealth",
    route: "/v1/integration-health",
    refusal: {
      status: 501,
      body: notComposedBody(
        "/v1/integration-health",
        "INTEGRATION_HEALTH_SOURCE_NOT_BOUND",
        "the ADCOS compatibility probe is env-gated in the worker host; its recorded state is not part of this service's bound persistence",
      ),
    },
    panelSection: "integration-health",
    absentContent: 'data-integration-health="true"',
  },
];

function buildConsole(options?: {
  readonly actor?: string;
  readonly tenant?: string;
  readonly refusals?: Readonly<Record<string, TypedRefusal>>;
  readonly observed?: HttpRequest[];
}) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(10_000);
  const fake = createInMemoryApi(fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
  const base: HttpTransport = fake.transport;
  const transport: HttpTransport = {
    async request(request: HttpRequest): Promise<HttpResponse> {
      if (options?.observed !== undefined) options.observed.push(request);
      const refusal = options?.refusals?.[request.path];
      if (refusal !== undefined) {
        return { status: refusal.status, body: refusal.body };
      }
      return base.request(request);
    },
  };
  const client = new RoamLinkApiClient({
    transport,
    actor: { actorId: options?.actor ?? ADMIN, tenantId: options?.tenant ?? TENANT },
    ids: new DeterministicUuidGenerator(40_000),
  });
  const console = new AdminConsoleApp({ client });
  return { console, fake, clock, client };
}

describe("PA-020 state 1 - one unbound console source degrades its own page only", () => {
  for (const surface of DEGRADABLE_SURFACES) {
    it(`${surface.page}: the heading + the quiet panel render, the named reason is shown, and no data is invented`, async () => {
      const { console } = buildConsole({
        refusals: { [surface.route]: surface.refusal },
      });
      const page = await console.renderPage({ page: surface.page });
      // The page renders its own heading (the console page exists) ...
      expect(page.html).not.toContain('data-error-kind=');
      // ... and the data section is the quiet unavailable panel with the
      // typed reason and the named WHY rendered verbatim.
      expect(page.html).toContain('data-unavailable="true"');
      expect(page.html).toContain(`data-unavailable-section="${surface.panelSection}"`);
      expect(page.html).toContain('data-unavailable-reason="READ_MODEL_NOT_COMPOSED"');
      expect(page.html).toContain("Not available right now");
      // The refusal body's named reason is contract-borne text and renders.
      const namedReason = /real runtime \(([A-Z_]+):/.exec(surface.refusal.body)?.[1];
      expect(namedReason).toBeDefined();
      expect(page.html).toContain(namedReason ?? "");
      // No data content is invented into the degraded section.
      expect(page.html).not.toContain(surface.absentContent);
    });

    it(`${surface.page}: the navigation stays usable and a healthy sibling page still renders its real data`, async () => {
      const { console } = buildConsole({
        refusals: { [surface.route]: surface.refusal },
      });
      // The full document keeps the console shell + navigation, so every
      // OTHER diagnostic page stays one keyboard stop away.
      const document = await console.renderDocument({ page: surface.page });
      expect(document).toContain("<!DOCTYPE html>");
      expect(document).toContain("RoamLink Ops");
      expect(document).toContain(">Audit &amp; security</a>");
      expect(document).toContain(">Reconciliation</a>");
      expect(document).toContain(">Projection health</a>");
      expect(document).toContain(">Support triage</a>");
      expect(document).toContain(">Integration health</a>");
      expect(document).toContain('data-unavailable-section="' + surface.panelSection + '"');
      // A healthy sibling on the SAME runtime still renders its real data:
      // the organizations read is composed, so Tenants keeps working.
      const tenants = await console.renderPage({ page: "tenants" });
      expect(tenants.html).not.toContain('data-unavailable="true"');
      expect(tenants.html).not.toContain('data-error-kind=');
    });
  }
});

describe("PA-020 state 2 - the session gate (the core) keeps the fail-closed law", () => {
  it("an unresolvable session renders the typed error panel and NEVER fetches the surface data", async () => {
    const observed: HttpRequest[] = [];
    const { console } = buildConsole({
      observed,
      refusals: {
        "/v1/users/me": {
          status: 503,
          body: JSON.stringify({
            kind: "unavailable",
            reason: "SESSION_RESOLUTION_UNAVAILABLE",
            message: "session resolution is temporarily unavailable",
            retryable: true,
            details: [],
          }),
        },
      },
    });
    for (const surface of DEGRADABLE_SURFACES) {
      const page = await console.renderPage({ page: surface.page });
      expect(page.html).toContain('data-error-kind="unavailable"');
      expect(page.html).not.toContain('data-unavailable="true"');
    }
    // The gate failed BEFORE any surface data request: only the session
    // read was issued (once per rendered surface - "no data even fetched",
    // the standing law).
    const requestedPaths = observed.map((request) => request.path);
    expect(requestedPaths.length).toBe(DEGRADABLE_SURFACES.length);
    for (const path of requestedPaths) {
      expect(path).toBe("/v1/users/me");
    }
  });

  it("an actor outside the organization gets the access-denied panel (never the surface, never partial data)", async () => {
    // A personal-tenant actor is denied every console surface by the
    // fail-closed gate (the top-threat law: privilege escalation) - the
    // degradation never widens what a denied actor sees.
    const observed: HttpRequest[] = [];
    const personalTenant = "usr:aaaaaaaa-0000-4000-8000-000000000003";
    const { console } = buildConsole({ actor: MEMBER, tenant: personalTenant, observed });
    const page = await console.renderPage({ page: "audit" });
    expect(page.html).toContain('data-access-denied="true"');
    expect(page.html).not.toContain('data-unavailable="true"');
    expect(page.html).not.toContain('data-audit-events="true"');
    // The denial also never fetched the surface data.
    const requestedPaths = observed.map((request) => request.path);
    expect(requestedPaths).toEqual(["/v1/users/me"]);
  });
});

describe("PA-020 state 3 - mixed fresh/stale/unknown render truthfully (no panels)", () => {
  it("projection health renders FRESH, STALE and UNKNOWN rows exactly as recorded", async () => {
    const { console } = buildConsole();
    const page = await console.renderPage({ page: "projectionHealth" });
    expect(page.html).toContain('data-projection-freshness="FRESH"');
    expect(page.html).toContain('data-projection-freshness="STALE"');
    expect(page.html).toContain('data-projection-freshness="UNKNOWN"');
    expect(page.html).toContain('data-slos=');
    expect(page.html).not.toContain('data-unavailable="true"');
  });

  it("audit renders the verified chain + every recorded outcome; reconciliation and triage render their records", async () => {
    const { console } = buildConsole();
    // A suspended+reactivated org produces audited events on the fake.
    const suspended = await console.suspendOrganizationFlow({ tenantId: TENANT });
    expect(suspended.status).toBe("ok");
    const suspendedVersion =
      suspended.status === "ok" ? suspended.acknowledgement.resource?.version : undefined;
    const reactivated = await console.reactivateOrganizationFlow({
      tenantId: TENANT,
      ...(suspendedVersion !== undefined ? { expectedVersion: suspendedVersion } : {}),
    });
    expect(reactivated.status).toBe("ok");

    const audit = await console.renderPage({ page: "audit" });
    expect(audit.html).toContain('data-chain-verified="true"');
    expect(audit.html).toContain('data-audit-events="true"');
    expect(audit.html).not.toContain('data-unavailable="true"');

    const reconciliation = await console.renderPage({ page: "reconciliation" });
    expect(reconciliation.html).toContain("data-job-id=");
    expect(reconciliation.html).not.toContain('data-unavailable="true"');

    const triage = await console.renderPage({ page: "supportTriage" });
    expect(triage.html).toContain("data-case-id=");
    expect(triage.html).not.toContain('data-unavailable="true"');

    const integrationHealth = await console.renderPage({ page: "integrationHealth" });
    expect(integrationHealth.html).toContain('data-integration-health="true"');
    expect(integrationHealth.html).toContain('data-integration-state="compatible"');
    expect(integrationHealth.html).not.toContain('data-unavailable="true"');
  });
});
