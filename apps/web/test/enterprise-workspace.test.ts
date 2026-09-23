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
 *  - honest gaps: workspace switching renders the not-available state
 *    (nothing invented); the organization policy summary renders from the
 *    READ MODEL (PA-007, closes RL-115-F7) - the current policy record
 *    (source, version, freshness) or one of the EXPLICIT absence states
 *    (not-configured / unknown / not-available - never a UI shrug, never a
 *    collapsed absence);
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
  type FakeEnterpriseIntegrationSeed,
  type FakeEnterprisePolicySeed,
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
    // PA-007 (closes RL-115-F7): the policy step renders from the read
    // model - the seeded org carries a configured, fresh policy (the
    // honest happy-path world; the absence/stale worlds are derived below).
    expect(page.html).toContain('data-workspace-step="policy" data-workspace-step-state="complete"');
    expect(page.html).toContain('data-policy-summary="configured"');
    expect(page.html).toContain('data-workspace-step="connector" data-workspace-step-state="complete"');
    expect(page.html).toContain('data-workspace-step="devices" data-workspace-step-state="complete"');
    expect(page.html).toContain('data-workspace-step="capability-verification" data-workspace-step-state="complete"');
    expect(page.html).toContain('data-workspace-step="first-goal" data-workspace-step-state="complete"');
    expect(page.html).toContain('data-workspace-step="live-overview" data-workspace-step-state="complete"');
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

// --------------------------------------------------------------------------------
// The organization policy summary renders from the read model
// (PA-007, closes RL-115-F7): present-policy render, absent-policy honest
// render, stale-freshness pairing - and the absence states stay explicit
// contract states, never a UI shrug.
// --------------------------------------------------------------------------------

/** Derives a scenario seed by overriding the tenant's policy record. */
function policySeed(policy: FakeEnterprisePolicySeed): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  tenants[TENANT] = {
    ...tenant,
    enterprise: { ...tenant.enterprise, policy },
  };
  return { ...seed, tenants };
}

/** Derives a scenario seed whose workspace composes NO policy section. */
function policyNotAvailableSeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  const { enrollment, connector } = tenant.enterprise ?? {};
  tenants[TENANT] = {
    ...tenant,
    enterprise: {
      ...(enrollment !== undefined ? { enrollment } : {}),
      ...(connector !== undefined ? { connector } : {}),
    },
  };
  return { ...seed, tenants };
}

describe("the organization policy summary renders from the read model (PA-007, RL-115-F7)", () => {
  it("a configured, fresh policy renders its summary, source, version, effective instant and freshness", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "workspace" });
    // The section: the real summary from the read model.
    expect(page.html).toContain('data-policy-summary="configured"');
    expect(page.html).toContain('data-policy-statement="true"');
    expect(page.html).toContain("Roam on approved networks with a capped daily spend");
    // Source + version + effective instant (the current policy record's
    // facts, rendered - never invented).
    expect(page.html).toContain('data-policy-source="true"');
    expect(page.html).toContain("organization-administration");
    expect(page.html).toContain('data-policy-version="true"');
    expect(page.html).toContain("2025-01");
    expect(page.html).toContain("Effective: 2024-07-01T00:00:00.000Z");
    // The freshness pairing (§14: text + visual treatment).
    expect(page.html).toContain('data-freshness="FRESH"');
    expect(page.html).toContain("Policy read: ");
    // The journey step derives complete, with the contextual link to the
    // section (the §15 contextual link from the journey where the
    // capability becomes relevant).
    expect(page.html).toContain('data-workspace-step="policy" data-workspace-step-state="complete"');
    expect(page.html).toContain('href="#policy-summary"');
    expect(page.html).toContain("Review the policy summary");
    // The journey fact carries the policy statement (HTML-escaped quotes
    // around the summary text).
    expect(page.html).toContain("Organization policy in effect: &quot;Roam on approved networks");
    expect(page.html).toContain("(version 2025-01).");
  });

  it("the honest absence renders as the EXPLICIT not-configured contract state (never a shrug)", async () => {
    const { app } = buildApp({
      seed: policySeed({
        policyId: "pppppppp-0000-4000-8000-000000000002",
        state: "not-configured",
        source: "organization-administration",
        freshness: {
          observedAt: "2025-01-06T09:00:00.000Z",
          receivedAt: "2025-01-06T09:00:00.000Z",
          freshUntil: "2025-01-06T10:00:00.000Z",
        },
      }),
    });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-policy-summary="not-configured"');
    expect(page.html).toContain('data-policy-absent="true"');
    expect(page.html).toContain("No organization policy is configured yet.");
    // The action-needed step names where the action lives: UPSTREAM (the
    // organization's administrators) - RoamLink offers no policy editor.
    expect(page.html).toContain('data-workspace-step="policy" data-workspace-step-state="action-needed"');
    expect(page.html).toContain("your organization&#39;s administrators set its connectivity rules upstream");
    // No invented policy content anywhere.
    expect(page.html).not.toContain('data-policy-statement="true"');
    expect(page.html).not.toContain("Roam on approved networks");
  });

  it("a workspace composing no policy section renders the honest not-available state", async () => {
    const { app } = buildApp({ seed: policyNotAvailableSeed() });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-policy-summary="not-available"');
    expect(page.html).toContain('data-policy-absent="true"');
    expect(page.html).toContain("this workspace does not expose an organization policy read");
    expect(page.html).toContain('data-workspace-step="policy" data-workspace-step-state="not-available"');
    expect(page.html).toContain("An organization policy read is not available for this workspace yet.");
  });

  it("the stale-freshness pairing: a stale read keeps its summary PAIRED with the stale badge (never hidden, never trusted)", async () => {
    const { app } = buildApp({
      seed: policySeed({
        policyId: "pppppppp-0000-4000-8000-000000000003",
        state: "configured",
        source: "organization-administration",
        policyVersion: "2024-12",
        summary: "Roam on approved networks with a capped daily spend.",
        effectiveAt: "2024-07-01T00:00:00.000Z",
        freshness: {
          observedAt: "2025-01-06T08:00:00.000Z",
          receivedAt: "2025-01-06T08:00:00.000Z",
          // Expired before the deterministic query instant (09:45).
          freshUntil: "2025-01-06T09:30:00.000Z",
        },
      }),
    });
    const page = await app.renderPage({ page: "workspace" });
    // The content still renders (from the last verified read)...
    expect(page.html).toContain('data-policy-summary="configured"');
    expect(page.html).toContain('data-policy-statement="true"');
    // ...PAIRed with the stale freshness (the fake evaluates the state at
    // the query instant; the guarantee expired at 09:30 < 09:45).
    expect(page.html).toContain('data-freshness="STALE"');
    expect(page.html).toContain("Policy read: ");
    // The step waits on a fresh read - never claims a verified present.
    expect(page.html).toContain('data-workspace-step="policy" data-workspace-step-state="waiting"');
    expect(page.html).toContain("as of the last verified read");
    expect(page.html).toContain("the read is stale");
  });

  it("an unknown policy record renders the honest unknown state (absence of evidence, never a guess)", async () => {
    const { app } = buildApp({
      seed: policySeed({
        policyId: "pppppppp-0000-4000-8000-000000000004",
        state: "unknown",
        source: "organization-administration",
      }),
    });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-policy-summary="unknown"');
    expect(page.html).toContain('data-policy-unknown="true"');
    expect(page.html).toContain("no verified policy observation exists yet");
    expect(page.html).toContain('data-freshness="UNKNOWN"');
    expect(page.html).toContain('data-workspace-step="policy" data-workspace-step-state="waiting"');
    expect(page.html).not.toContain('data-policy-statement="true"');
  });

  it("the authority note names where policy management lives upstream, and support stays reachable (no policy editor)", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-policy-authority="true"');
    expect(page.html).toContain(
      "Organization policy is managed by your organization&#39;s administrators upstream. RoamLink surfaces it here read-only",
    );
    expect(page.html).toContain('data-policy-support-reachability="true"');
    // READ-ONLY: the section offers no policy write affordance (a policy
    // editor here would create a second policy authority).
    expect(page.html).not.toMatch(/data-flow="(edit|update|set)-policy"|Configure policy|Edit policy|Set policy/);
  });
});

// --------------------------------------------------------------------------------
// The enterprise integrations section renders from the read model
// (PA-008, closes RL-115-F5): each integration x each state renders
// honestly - the missing backend contract is an EXPLICIT unavailable
// state with an explanation, never a fabricated control.
// --------------------------------------------------------------------------------

/** Derives a scenario seed by overriding the tenant's integration rows. */
function integrationsSeed(integrations: readonly FakeEnterpriseIntegrationSeed[]): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  tenants[TENANT] = {
    ...tenant,
    enterprise: { ...tenant.enterprise, integrations },
  };
  return { ...seed, tenants };
}

/** Derives a scenario seed whose workspace composes NO integrations section. */
function integrationsNotAvailableSeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  const { enrollment, connector, policy } = tenant.enterprise ?? {};
  tenants[TENANT] = {
    ...tenant,
    enterprise: {
      ...(enrollment !== undefined ? { enrollment } : {}),
      ...(connector !== undefined ? { connector } : {}),
      ...(policy !== undefined ? { policy } : {}),
    },
  };
  return { ...seed, tenants };
}

const INTEGRATION_KINDS = ["sso", "scim", "mdm"] as const;
const INTEGRATION_STATES = ["configured", "not-configured", "unavailable", "unknown"] as const;

const OBSERVED_FRESH = {
  observedAt: "2025-01-06T09:00:00.000Z",
  receivedAt: "2025-01-06T09:00:00.000Z",
  freshUntil: "2025-01-06T10:00:00.000Z",
} as const;

function integrationRow(
  kind: (typeof INTEGRATION_KINDS)[number],
  state: (typeof INTEGRATION_STATES)[number],
): FakeEnterpriseIntegrationSeed {
  return {
    integrationId: `iiiiiiii-0000-4000-8000-0000000000${kind === "sso" ? "01" : kind === "scim" ? "02" : "03"}`,
    kind,
    state,
    ...(state === "configured"
      ? { summary: `The ${kind} integration, configured for the journey-test world.` }
      : {}),
    ...(state === "configured" || state === "not-configured" ? { freshness: OBSERVED_FRESH } : {}),
  };
}

describe("the enterprise integrations section renders honest states (PA-008, RL-115-F5)", () => {
  it("the seeded world: SSO configured with its summary + freshness pairing; SCIM and MDM the honest unavailable declaration", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-integrations="true"');
    expect(page.html).toContain("Enterprise integrations");
    // SSO: the present, configured read - summary + freshness pairing.
    expect(page.html).toContain('data-integration="sso" data-integration-state="configured"');
    expect(page.html).toContain("In effect: ");
    expect(page.html).toContain("Sign in to RoamLink through your organization");
    expect(page.html).toContain("Integration read: ");
    expect(page.html).toContain('data-freshness="FRESH"');
    // SCIM / MDM: the honest missing-backend-contract states, each with the
    // per-kind explanation (never a fake status, never a fake control).
    expect(page.html).toContain('data-integration="scim" data-integration-state="unavailable"');
    expect(page.html).toContain("does not expose a user provisioning status read yet");
    expect(page.html).toContain('data-integration="mdm" data-integration-state="unavailable"');
    expect(page.html).toContain("does not expose a device management status read yet");
    // The degraded-cannot-see world carries the support escape with the
    // statuses pre-carried in the narrative.
    expect(page.html).toContain('data-support-escape="true"');
    expect(page.html).toContain("Get help with integrations");
    expect(page.html).toContain(
      "The workspace reads: Single sign-on (SSO) — Configured; User provisioning (SCIM) — Unavailable; Device management (MDM) — Unavailable",
    );
  });

  it.each(
    INTEGRATION_KINDS.flatMap((kind) =>
      INTEGRATION_STATES.map((state) => ({ kind, state })),
    ),
  )("each integration renders the $state state honestly ($kind)", async ({ kind, state }) => {
    const { app } = buildApp({ seed: integrationsSeed([integrationRow(kind, state)]) });
    const page = await app.renderPage({ page: "workspace" });
    // The row's closed state marker renders.
    expect(page.html).toContain(`data-integration="${kind}" data-integration-state="${state}"`);
    // The state word renders beside the label (§14: never color alone).
    expect(page.html).toMatch(
      new RegExp(`data-integration="${kind}"[\\s\\S]{0,600}?<span class="journey-state" data-state-word="${state}">`),
    );
    // The per-state honest content:
    if (state === "configured") {
      expect(page.html).toContain("In effect: ");
      expect(page.html).toContain(`The ${kind} integration, configured for the journey-test world.`);
      expect(page.html).toContain("Integration read: ");
      expect(page.html).toContain('data-freshness="FRESH"');
    } else if (state === "not-configured") {
      expect(page.html).toContain("Not configured — a verified observation confirms");
      expect(page.html).toContain("Integration read: ");
      expect(page.html).not.toContain(`data-integration="${kind}" data-integration-state="configured"`);
    } else if (state === "unavailable") {
      expect(page.html).toContain("Unavailable — requires the enterprise integration API");
      expect(page.html).toContain("Nothing is invented in the meantime.");
      expect(page.html).not.toContain("In effect: ");
    } else {
      expect(page.html).toContain("No verified observation exists yet");
      expect(page.html).toContain('data-freshness="UNKNOWN"');
      expect(page.html).not.toContain("In effect: ");
    }
  });

  it("a stale configured read keeps its content PAIRED with the stale badge (never hidden, never trusted)", async () => {
    const { app } = buildApp({
      seed: integrationsSeed([
        {
          integrationId: "iiiiiiii-0000-4000-8000-000000000001",
          kind: "sso",
          state: "configured",
          summary: "Sign in through your organization's identity provider.",
          freshness: {
            observedAt: "2025-01-06T08:00:00.000Z",
            receivedAt: "2025-01-06T08:00:00.000Z",
            // Expired before the deterministic query instant (09:45).
            freshUntil: "2025-01-06T09:30:00.000Z",
          },
        },
        ...(["scim", "mdm"] as const).map((kind) => integrationRow(kind, "unavailable")),
      ]),
    });
    const page = await app.renderPage({ page: "workspace" });
    // The content still renders (from the last verified read)...
    expect(page.html).toContain('data-integration="sso" data-integration-state="configured"');
    expect(page.html).toContain("Sign in through your organization&#39;s identity provider");
    // ...PAIRed with the stale freshness badge (09:30 < 09:45).
    expect(page.html).toContain('data-freshness="STALE"');
    expect(page.html).toContain("In effect as of the last verified read");
    expect(page.html).toContain("the read is stale");
  });

  it("a workspace composing no integrations read degrades honestly (every kind unavailable + the support escape)", async () => {
    const { app } = buildApp({ seed: integrationsNotAvailableSeed() });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-integrations="true"');
    for (const kind of INTEGRATION_KINDS) {
      expect(page.html).toContain(`data-integration="${kind}" data-integration-state="unavailable"`);
    }
    expect(page.html).toContain("composes no integration status read yet");
    expect(page.html).toContain('data-support-escape="true"');
    expect(page.html).toContain("Get help with integrations");
    expect(page.html).not.toContain('data-integration-state="configured"');
  });

  it("the section composes NO configuration affordance (read-only; no OAuth dance, no SCIM endpoint fields, no MDM enrollment forms)", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "workspace" });
    const section = page.html.slice(
      page.html.indexOf('data-integrations="true"'),
      page.html.indexOf('data-device-fleet="true"'),
    );
    expect(section).not.toMatch(/<form|<button|data-flow=|type="password"|<input|oauth|issuer|endpoint/i);
    // The authority note names where integration management lives upstream.
    expect(page.html).toContain('data-integrations-authority="true"');
    expect(page.html).toContain(
      "Enterprise integrations are managed by your organization&#39;s administrators and its own identity and device systems",
    );
  });

  it("the fully-verified world renders the quiet reachability note instead of the escape", async () => {
    const { app } = buildApp({
      seed: integrationsSeed(
        INTEGRATION_KINDS.map((kind) => integrationRow(kind, "configured")),
      ),
    });
    const page = await app.renderPage({ page: "workspace" });
    const section = page.html.slice(
      page.html.indexOf('data-integrations="true"'),
      page.html.indexOf('data-device-fleet="true"'),
    );
    expect(section).toContain('data-integrations-support-reachability="true"');
    expect(section).not.toContain('data-support-escape="true"');
  });

  it("the settings page carries the contextual link to the integrations section", async () => {
    const { app } = buildApp();
    const settings = await app.renderPage({ page: "settings" });
    expect(settings.html).toMatch(
      /<a [^>]*href="\/workspace#integrations"[^>]*>Review enterprise integrations/,
    );
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
    // PA-008: the quiet-support world is quiet because EVERYTHING is
    // healthy - including the enterprise integrations, all verified and
    // in effect (so the integrations section renders its quiet
    // reachability note instead of the degraded-state support escape).
    enterprise: {
      ...tenant.enterprise,
      integrations: [
        {
          integrationId: "iiiiiiii-0000-4000-8000-000000000001",
          kind: "sso",
          state: "configured",
          summary: "Sign in to RoamLink through your organization's identity provider.",
          freshness: {
            observedAt: "2025-01-06T09:00:00.000Z",
            receivedAt: "2025-01-06T09:00:00.000Z",
            freshUntil: "2025-01-06T10:00:00.000Z",
          },
        },
        {
          integrationId: "iiiiiiii-0000-4000-8000-000000000002",
          kind: "scim",
          state: "configured",
          summary: "Your organization's directory keeps RoamLink membership in sync.",
          freshness: {
            observedAt: "2025-01-06T09:00:00.000Z",
            receivedAt: "2025-01-06T09:00:00.000Z",
            freshUntil: "2025-01-06T10:00:00.000Z",
          },
        },
        {
          integrationId: "iiiiiiii-0000-4000-8000-000000000003",
          kind: "mdm",
          state: "configured",
          summary: "Your organization's device management enrolls the fleet's devices.",
          freshness: {
            observedAt: "2025-01-06T09:00:00.000Z",
            receivedAt: "2025-01-06T09:00:00.000Z",
            freshUntil: "2025-01-06T10:00:00.000Z",
          },
        },
      ],
    },
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
