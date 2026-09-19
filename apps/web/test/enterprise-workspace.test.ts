/**
 * Enterprise workspace + guided onboarding journey tests (RL-104,
 * spec/tech-lead-handoff.md §11, spec/ux-architecture.md §12/§13,
 * spec/user-journey-audit.md §8).
 *
 * The frozen chain: workspace -> organization verification -> policy ->
 * connector -> devices -> capability verification -> first goal -> live
 * organization overview.
 *
 * These tests lock:
 *  - the guided journey renders ALL EIGHT steps with the closed per-step
 *    states, derived only from the read models;
 *  - the HARD LAW: enterprise UX creates NO second connectivity authority
 *    - the org connectivity section renders from the SAME read model and
 *    the same derived state vocabulary as every other page, and no org-
 *    aggregated connectivity status is invented;
 *  - honest gaps: the policy summary and workspace switching render the
 *    not-available state (nothing invented);
 *  - the mirrored enterprise vocabulary renders verbatim (drift-guarded
 *    in tests/architecture; apps/web imports ONLY app-kit);
 *  - fail-closed behavior: personal-scope tenants and failing reads
 *    render the typed error panel;
 *  - discoverability: the workspace is reachable from the More sheet and
 *    Settings (the frozen primary nav stays untouched);
 *  - admin/protocol surfaces stay out of the customer workspace.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type FakeApiSeed,
  type FakeTenantSeed,
  type HttpTransport,
  type HttpResponse,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { CustomerWebApp } from "../src/app.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const OTHER_TENANT = "org:99999999-8888-4777-8666-555555555555";
const OTHER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000004";

/** The jargon that must never reach the customer surface (any state of it). */
const FORBIDDEN_SURFACE_VOCABULARY = [
  "ADCOS",
  "ConnectivityIntent",
  "ExperienceIntent",
  "NetworkPath",
  "provider adapter",
  "idempotency",
];

function buildApp(options?: {
  seed?: FakeApiSeed;
  actor?: string;
  tenant?: string;
  transport?: HttpTransport;
}) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(10_000);
  const fake = createInMemoryApi(options?.seed ?? fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
  const client = new RoamLinkApiClient({
    transport: options?.transport ?? fake.transport,
    actor: { actorId: options?.actor ?? MEMBER_ACTOR, tenantId: options?.tenant ?? TENANT },
    ids: new DeterministicUuidGenerator(40_000),
  });
  const app = new CustomerWebApp({ client });
  return { app, clock, client };
}

describe("the guided enterprise journey renders the frozen chain", () => {
  it("renders all eight steps with per-step honest states on a live org", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-workspace-journey="true"');
    for (const step of [
      "workspace",
      "organization-verification",
      "policy",
      "connector",
      "devices",
      "capability-verification",
      "first-goal",
      "live-overview",
    ]) {
      expect(page.html).toContain(`data-workspace-step="${step}"`);
    }
    // The completed steps of the seeded org.
    expect(page.html).toContain('data-workspace-step="workspace" data-workspace-step-state="complete"');
    expect(page.html).toContain('data-workspace-step="organization-verification" data-workspace-step-state="complete"');
    expect(page.html).toContain('data-workspace-step="connector" data-workspace-step-state="complete"');
    expect(page.html).toContain('data-workspace-step="devices" data-workspace-step-state="complete"');
    expect(page.html).toContain('data-workspace-step="capability-verification" data-workspace-step-state="complete"');
    expect(page.html).toContain('data-workspace-step="first-goal" data-workspace-step-state="complete"');
    expect(page.html).toContain('data-workspace-step="live-overview" data-workspace-step-state="complete"');
    // The honest gap: policy is not available yet (never invented).
    expect(page.html).toContain('data-workspace-step="policy" data-workspace-step-state="not-available"');
    expect(page.html).toContain("A organization policy summary is not available yet.");
  });

  it("renders the mirrored enterprise states verbatim in the enrollment section", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-workspace-enrollment="true"');
    // The enrollment and connector state badges render the MIRRORED
    // vocabulary values verbatim (active / provisioned).
    expect(page.html).toContain('data-state="active"');
    expect(page.html).toContain('data-state="provisioned"');
    expect(page.html).toContain("Acme Roaming Corp");
    expect(page.html).toContain("Organization verification:");
    expect(page.html).toContain("Connector:");
  });

  it("a workspace without an enterprise record renders the honest not-started states", async () => {
    const { app } = buildApp({ actor: OTHER_ACTOR, tenant: OTHER_TENANT });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-workspace-step="organization-verification" data-workspace-step-state="not-started"');
    expect(page.html).toContain('data-workspace-step="connector" data-workspace-step-state="not-started"');
    expect(page.html).toContain("No organization verification journey has been recorded yet.");
    expect(page.html).toContain("No connector has been set up for this workspace yet.");
    expect(page.html).toContain('data-enrollment-absent="true"');
    expect(page.html).toContain('data-connector-absent="true"');
    // The other org's fleet is empty: action-needed + not-started.
    expect(page.html).toContain('data-workspace-step="devices" data-workspace-step-state="action-needed"');
    expect(page.html).toContain('data-workspace-step="capability-verification" data-workspace-step-state="not-started"');
  });

  it("a rejected enrollment renders the blocked state with its rejection reason", async () => {
    const { app } = buildApp({ seed: rejectedEnrollmentSeed() });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-workspace-step="organization-verification" data-workspace-step-state="blocked"');
    expect(page.html).toContain("Organization verification was rejected (verification-failed).");
    expect(page.html).toContain('data-state="rejected"');
  });
});

describe("no second connectivity authority", () => {
  it("organization connectivity renders from the SAME read model and derived state vocabulary", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-org-connectivity="true"');
    // The same shell derivation vocabulary the whole app shares.
    expect(page.html).toContain('data-shell-state="evidenced-fresh"');
    // The same per-subject cards from the same read - not an org-level
    // re-aggregation.
    expect(page.html).toContain('data-subject-id="66666666-0000-4000-8000-000000000001"');
    expect(page.html).toContain('data-subject-type="subscription"');
    // The frozen no-second-authority sentence is on the section.
    expect(page.html).toContain("the workspace adds no second source of truth");
  });

  it("invents no org-aggregated connectivity status anywhere", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).not.toMatch(/orgStatus|organizationStatus=|data-org-status|fleetConnectivity/);
  });

  it("the live-overview step language carries the honest connectivity truth", async () => {
    const { app } = buildApp({ seed: unevidencedSeed() });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-shell-state="unevidenced"');
    expect(page.html).toContain('data-workspace-step="live-overview" data-workspace-step-state="waiting"');
    expect(page.html).toContain("Not delivering yet");
  });
});

describe("honest gaps and support", () => {
  it("workspace switching renders its honest not-available note", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-workspace-switcher="true"');
    expect(page.html).toContain('data-workspace-switch-note="true"');
    expect(page.html).toContain("Switching between several workspaces is not available yet.");
  });

  it("a degraded workspace carries the support escape with its facts", async () => {
    const { app } = buildApp({ seed: unevidencedSeed() });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-support-escape="true"');
    expect(page.html).toContain("Our organization workspace shows a degraded state we need help with.");
    expect(page.html).toContain(`subscription 88888888-0000-4000-8000-000000000001`);
    expect(page.html).toContain("device dddddddd-0000-4000-8000-000000000002");
  });

  it("a healthy workspace renders the quiet support note instead", async () => {
    const { app } = buildApp({ seed: healthyWorkspaceSeed() });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain("Everything looks healthy right now.");
    expect(page.html).not.toContain('data-support-escape="true"');
  });
});

describe("fail-closed + discoverability + language discipline", () => {
  it("a personal-scope tenant gets the typed error panel (no workspace to compose)", async () => {
    const seed = fakeApiSeed();
    const personalSeed: FakeApiSeed = {
      ...seed,
      tenants: {
        ...seed.tenants,
        // A personal tenant (usr:) with a device - no organization.
        "usr:aaaaaaaa-0000-4000-8000-000000000003": personalTenantSeed(),
      },
    };
    const { app } = buildApp({
      seed: personalSeed,
      actor: "usr:aaaaaaaa-0000-4000-8000-000000000003",
      tenant: "usr:aaaaaaaa-0000-4000-8000-000000000003",
    });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-error-kind="unauthorized"');
    expect(page.html).toContain("organization tenant scope");
    expect(page.html).not.toContain('data-workspace-journey="true"');
  });

  it("a failing workspace read renders the typed error panel only", async () => {
    const { app } = buildApp({
      transport: {
        async request(request): Promise<HttpResponse> {
          if (request.path === "/v1/enterprise/workspace") {
            return {
              status: 503,
              body: JSON.stringify({
                kind: "unavailable",
                reason: "ENTERPRISE_READ_UNAVAILABLE",
                message: "the workspace read is temporarily unavailable",
                retryable: true,
                details: [],
              }),
            };
          }
          throw new Error("unreachable");
        },
      },
    });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-error-kind="unavailable"');
    expect(page.html).not.toContain('data-workspace-journey="true"');
  });

  it("the workspace is discoverable from the More sheet and Settings (frozen nav untouched)", async () => {
    const { app } = buildApp();
    const more = await app.renderPage({ page: "more" });
    expect(more.html).toContain('href="/workspace"');
    expect(more.html).toContain("Workspace");
    const settings = await app.renderPage({ page: "settings" });
    expect(settings.html).toContain('data-settings-workspace="true"');
    expect(settings.html).toContain('href="/workspace"');
    // The frozen desktop navigation did not grow an item.
    const home = await app.renderDocument({ page: "home" });
    const sidebar = home.slice(home.indexOf('shell-sidebar'), home.indexOf("shell-main"));
    expect(sidebar).not.toContain('href="/workspace"');
  });

  it("keeps admin/diagnostics and internal vocabulary off the workspace", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "workspace" });
    for (const term of FORBIDDEN_SURFACE_VOCABULARY) {
      expect(page.html).not.toContain(term);
    }
    // Admin surfaces are not customer navigation: the audit trail note
    // says where it lives without linking it.
    expect(page.html).toContain('data-audit-note="true"');
    expect(page.html).not.toContain('href="/admin');
  });
});

// ---------------------------------------------------------------------------------
// Scenario seeds
// ---------------------------------------------------------------------------------

/** A live org whose fleet is fully verified (the quiet-support world). */
function healthyWorkspaceSeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  tenants[TENANT] = {
    ...tenant,
    devices: tenant.devices.map((device) => ({
      ...device,
      capabilityFreshness: {
        observedAt: "2025-01-06T09:00:00.000Z",
        receivedAt: "2025-01-06T09:00:00.000Z",
        freshUntil: "2025-01-06T10:00:00.000Z",
      },
    })),
  };
  return { ...seed, tenants };
}

function rejectedEnrollmentSeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  tenants[TENANT] = {
    ...tenant,
    enterprise: {
      enrollment: {
        enrollmentId: "eeeeeeee-0000-4000-8000-000000000002",
        organizationName: "Acme Roaming Corp",
        state: "rejected",
        tenantId: null,
        requestedBy: "act:aaaaaaaa-0000-4000-8000-000000000001",
        createdAt: "2024-06-01T00:00:00.000Z",
        updatedAt: "2024-06-01T00:05:00.000Z",
        rejectionReason: "verification-failed",
      },
    },
  };
  return { ...seed, tenants };
}

function unevidencedSeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  tenants[TENANT] = {
    ...tenant,
    references: tenant.references.map((reference) => ({
      ...reference,
      deliveryEvidenceState: "UNEVIDENCED" as const,
      evidence: undefined,
    })),
  };
  return { ...seed, tenants };
}

function personalTenantSeed(): FakeTenantSeed {
  return {
    devices: [],
    intents: [],
    orders: [],
    subscriptions: [],
    payments: [],
    invoices: [],
    references: [],
    notifications: [],
    supportCases: [],
    projections: [],
    slos: [],
    reconciliationJobs: [],
  };
}
