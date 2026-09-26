/**
 * Component-scoped degradation battery (PA-020) - the customer surfaces.
 *
 * THE LAW UNDER TEST (docs/live-journey-runtime-audit-2026-09-26 §5 and the
 * tech-lead handoff §7): a secondary read that is unavailable must degrade
 * THAT COMPONENT to a quiet unavailable panel - never blank the whole page
 * body when the page still has authoritative core facts to render. A CORE
 * read that fails keeps the existing honest full-body fail-closed law.
 *
 * Per surface (Home, Connectivity, Activity, Workspace), the three mandated
 * states:
 *  1. core available + secondary unavailable -> core renders + the quiet
 *     panel renders in the secondary section (BOTH asserted);
 *  2. core unavailable -> the honest fail-closed body (unchanged law);
 *  3. mixed fresh/stale/unknown -> each section renders its own truthful
 *     state (the existing evidence/freshness vocabulary, never hidden).
 *
 * Every test drives the REAL app through the REAL typed client over the
 * deterministic fake, with a transport wrapper that answers the REAL
 * runtime's typed refusal bodies (the services/api kept-501 shape with its
 * named reason, and the not-composed workspace route's honest 404) for the
 * degraded routes only.
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

import { CustomerWebApp } from "../src/app.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";

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

const NOTIFICATIONS_501: TypedRefusal = {
  status: 501,
  body: notComposedBody(
    "/v1/notifications",
    "NOTIFICATION_STORE_NOT_BOUND",
    "notifications are emitted from durable domain transitions; no notification store is bound on this runtime",
  ),
};

const WORKSPACE_501: TypedRefusal = {
  status: 501,
  body: notComposedBody(
    "/v1/enterprise/workspace",
    "ENTERPRISE_WORKSPACE_SOURCE_NOT_BOUND",
    "the enterprise workspace composition is not bound in this service's persistence",
  ),
};

/** The not-composed workspace route's honest 404 (the real hosted runtime). */
const WORKSPACE_404: TypedRefusal = {
  status: 404,
  body: JSON.stringify({
    kind: "not-found",
    reason: "NOT_FOUND",
    message: "no such route",
    retryable: false,
    details: [],
  }),
};

/** The core-read failure shape (a plain typed unavailability). */
const UNAVAILABLE_503: TypedRefusal = {
  status: 503,
  body: JSON.stringify({
    kind: "unavailable",
    reason: "ADCOS_PROJECTION_STORE_DOWN",
    message: "the read is temporarily unavailable",
    retryable: true,
    details: [],
  }),
};

/**
 * Wraps the fake transport: the given exact paths answer the provided typed
 * refusals; everything else passes through to the deterministic fake
 * untouched (the rest of the composition stays healthy, exactly like the
 * real runtime where only the kept-501 routes refuse).
 */
function refusingTransport(
  base: HttpTransport,
  refusals: Readonly<Record<string, TypedRefusal>>,
): HttpTransport {
  return {
    async request(request: HttpRequest): Promise<HttpResponse> {
      const refusal = refusals[request.path];
      if (refusal !== undefined) {
        return { status: refusal.status, body: refusal.body };
      }
      return base.request(request);
    },
  };
}

function buildApp(options?: {
  readonly refusals?: Readonly<Record<string, TypedRefusal>>;
  readonly actor?: string;
  readonly tenant?: string;
}) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(10_000);
  const fake = createInMemoryApi(fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
  const transport =
    options?.refusals === undefined
      ? fake.transport
      : refusingTransport(fake.transport, options.refusals);
  const client = new RoamLinkApiClient({
    transport,
    actor: { actorId: options?.actor ?? MEMBER_ACTOR, tenantId: options?.tenant ?? TENANT },
    ids: new DeterministicUuidGenerator(40_000),
  });
  const app = new CustomerWebApp({ client });
  return { app, fake, clock, client };
}

/** The seeded notification title (used to prove no feed content leaks). */
const SEEDED_NOTIFICATION_TITLE = "Connectivity evidence linked";

describe("PA-020 Home: core facts survive an unavailable notification feed", () => {
  it("state 1 - core renders + the quiet panel renders in the attention section (both asserted)", async () => {
    const { app } = buildApp({ refusals: { "/v1/notifications": NOTIFICATIONS_501 } });
    const page = await app.renderPage({ page: "home" });

    // CORE: the hero + the goal card + the devices card still render from
    // their own authoritative reads.
    expect(page.html).toContain('data-home-hero="true"');
    expect(page.html).toContain('data-home-fact="goal"');
    expect(page.html).toContain('data-home-fact="devices"');
    // SECONDARY: the attention card is the quiet unavailable panel, with
    // the typed reason and the named WHY rendered verbatim.
    expect(page.html).toContain('data-unavailable="true"');
    expect(page.html).toContain('data-unavailable-section="home-attention"');
    expect(page.html).toContain('data-unavailable-reason="READ_MODEL_NOT_COMPOSED"');
    expect(page.html).toContain("NOTIFICATION_STORE_NOT_BOUND");
    expect(page.html).toContain("Not available right now");
    // The degraded page body is NOT the fail-closed panel (no error panel),
    // and no notification content is invented into the degraded section.
    expect(page.html).not.toContain('data-error-kind=');
    expect(page.html).not.toContain(SEEDED_NOTIFICATION_TITLE);
  });

  it("state 2 - a CORE read failing keeps the honest full-body fail-closed law", async () => {
    const { app } = buildApp({ refusals: { "/v1/connectivity": UNAVAILABLE_503 } });
    const page = await app.renderPage({ page: "home" });
    expect(page.html).toContain('data-error-kind="unavailable"');
    expect(page.html).not.toContain('data-home-hero="true"');
    expect(page.html).not.toContain('data-unavailable-section="home-attention"');
  });

  it("state 3 - mixed fresh/stale/unknown: every section renders its own truthful state", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "home" });
    // The hero renders the subjects' evidence freshness side by side (the
    // seeded world: an evidenced order with FRESH evidence, an unevidenced
    // subscription whose absence of evidence renders the UNKNOWN badge);
    // the devices card renders the fleet's capability badges (Phone FRESH,
    // Laptop STALE). Every state renders in its own card, none is guessed.
    expect(page.html).toContain('data-home-hero="true"');
    expect(page.html).toContain("2 active references: 1 with delivery evidence, 1 without.");
    expect(page.html).toContain('data-freshness="FRESH"');
    expect(page.html).toContain('data-freshness="STALE"');
    expect(page.html).toContain('data-freshness="UNKNOWN"');
    // The attention section renders its real content (the seeded delivered
    // notification) - no unavailable panel anywhere on the healthy page.
    expect(page.html).toContain('data-home-fact="attention"');
    expect(page.html).toContain(SEEDED_NOTIFICATION_TITLE);
    expect(page.html).not.toContain('data-unavailable="true"');
  });
});

describe("PA-020 Connectivity: the explanation center survives an unavailable event feed", () => {
  it("state 1 - core renders + the quiet panel renders in the recent-events section (both asserted)", async () => {
    const { app } = buildApp({ refusals: { "/v1/notifications": NOTIFICATIONS_501 } });
    const page = await app.renderPage({ page: "connectivity" });

    // CORE: the whole explanation surface renders from the authoritative
    // connectivity read - status, subjects, journey, why, observations.
    expect(page.html).toContain('data-connectivity-status="true"');
    expect(page.html).toContain('data-connection-journey="true"');
    expect(page.html).toContain('data-device-observations="true"');
    expect(page.html).toContain('data-connectivity-next="true"');
    // SECONDARY: the recent-events section is the quiet unavailable panel.
    expect(page.html).toContain('data-unavailable="true"');
    expect(page.html).toContain('data-unavailable-section="recent-connectivity-events"');
    expect(page.html).toContain('data-unavailable-reason="READ_MODEL_NOT_COMPOSED"');
    expect(page.html).toContain("NOTIFICATION_STORE_NOT_BOUND");
    // Not the fail-closed body; no event content invented.
    expect(page.html).not.toContain('data-error-kind=');
    expect(page.html).not.toContain(SEEDED_NOTIFICATION_TITLE);
  });

  it("state 2 - the CORE connectivity read failing keeps the honest full-body law", async () => {
    const { app } = buildApp({ refusals: { "/v1/connectivity": UNAVAILABLE_503 } });
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-error-kind="unavailable"');
    expect(page.html).not.toContain('data-connectivity-status="true"');
    expect(page.html).not.toContain('data-connection-journey="true"');
  });

  it("state 3 - mixed fresh/stale/unknown: each section renders its own truthful state", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "connectivity" });
    // The seeded world: an evidenced order with FRESH evidence freshness, an
    // unevidenced subscription, device observations with FRESH / STALE /
    // UNKNOWN capability+context snapshots - every state renders in its own
    // section, none is hidden or guessed.
    expect(page.html).toContain('data-freshness="FRESH"');
    expect(page.html).toContain('data-freshness="STALE"');
    expect(page.html).toContain('data-freshness="UNKNOWN"');
    expect(page.html).toContain('data-evidence="UNEVIDENCED"');
    expect(page.html).toContain('data-observation-device=');
    // The recent-events section renders its real records (no panel).
    expect(page.html).toContain('data-recent-connectivity-events="true"');
    expect(page.html).toContain(SEEDED_NOTIFICATION_TITLE);
    expect(page.html).not.toContain('data-unavailable="true"');
  });
});

describe("PA-020 Activity: the narrative degrades around the unavailable feed", () => {
  it("state 1 - the automation status (core) renders + both feed sections degrade to the quiet panel", async () => {
    const { app } = buildApp({ refusals: { "/v1/notifications": NOTIFICATIONS_501 } });
    const page = await app.renderPage({ page: "activity" });

    // CORE: the page frame + the automation-status section still render
    // from the intents/devices reads (their own honest state).
    expect(page.html).toContain("Activity");
    expect(
      page.html,
      "the automation status renders from the core reads",
    ).toMatch(/data-automation-status="true"|data-automation-idle="true"/);
    // SECONDARY: both notification-derived sections degrade quietly.
    expect(page.html).toContain('data-unavailable-section="activity-needs-you"');
    expect(page.html).toContain('data-unavailable-section="activity-timeline"');
    expect(page.html).toContain('data-unavailable-reason="READ_MODEL_NOT_COMPOSED"');
    expect(page.html).toContain("NOTIFICATION_STORE_NOT_BOUND");
    // Not the fail-closed body; no timeline content invented.
    expect(page.html).not.toContain('data-error-kind=');
    expect(page.html).not.toContain('data-activity-feed="true"');
    expect(page.html).not.toContain(SEEDED_NOTIFICATION_TITLE);
  });

  it("state 2 - a CORE read failing (the intents read) keeps the honest full-body law", async () => {
    const { app } = buildApp({ refusals: { "/v1/experience-intents": UNAVAILABLE_503 } });
    const page = await app.renderPage({ page: "activity" });
    expect(page.html).toContain('data-error-kind="unavailable"');
    expect(page.html).not.toContain('data-activity-needs-you="true"');
    expect(page.html).not.toContain('data-automation-status="true"');
  });

  it("state 3 - mixed states: the feed, the attention list and the automation status each render truthfully", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "activity" });
    // The seeded notification is delivered -> it appears BOTH in the
    // needs-attention list and the timeline; the automation status renders
    // from the active goal. No unavailable panel anywhere.
    expect(page.html).toContain('data-activity-needs-you="true"');
    expect(page.html).toContain('data-activity-feed="true"');
    expect(page.html).toContain('data-activity-summary="true"');
    expect(page.html).toMatch(/data-automation-status="true"|data-automation-idle="true"/);
    expect(page.html).not.toContain('data-unavailable="true"');
  });
});

describe("PA-020 Workspace: the org view survives an unavailable workspace composition", () => {
  it("state 1 (the real runtime's 404) - core sections render + every workspace-composed section degrades", async () => {
    const { app } = buildApp({ refusals: { "/v1/enterprise/workspace": WORKSPACE_404 } });
    const page = await app.renderPage({ page: "workspace" });

    // CORE: the fleet, the goals and the org connectivity sections still
    // render from their own authoritative reads.
    expect(page.html).toContain('data-device-fleet="true"');
    expect(page.html).toContain('data-workspace-goals="true"');
    expect(page.html).toContain('data-org-connectivity="true"');
    expect(page.html).toContain('data-workspace-support="true"');
    // The journey keeps its spine: the CORE steps render their honest
    // states, the workspace-composed steps do NOT render (their facts are
    // unknown - never invented step states).
    expect(page.html).toContain('data-workspace-journey="true"');
    expect(page.html).toContain('data-workspace-step="devices"');
    expect(page.html).toContain('data-workspace-step="live-overview"');
    expect(page.html).not.toContain('data-workspace-step="workspace"');
    expect(page.html).not.toContain('data-workspace-step="organization-verification"');
    expect(page.html).not.toContain('data-workspace-step="policy"');
    expect(page.html).not.toContain('data-workspace-step="connector"');
    // SECONDARY: every workspace-composed section degrades to its own quiet
    // panel, each carrying the typed reason.
    expect(page.html).toContain('data-unavailable-section="workspace-switcher"');
    expect(page.html).toContain('data-unavailable-section="workspace-journey"');
    expect(page.html).toContain('data-unavailable-section="connector-enrollment"');
    expect(page.html).toContain('data-unavailable-section="policy-summary"');
    expect(page.html).toContain('data-unavailable-section="enterprise-integrations"');
    expect(page.html).toContain('data-unavailable-section="workspace-enrollment"');
    expect(page.html).toContain('data-unavailable-reason="NOT_FOUND"');
    // The degraded page is NOT the fail-closed body.
    expect(page.html).not.toContain('data-error-kind=');
  });

  it("state 1 (the typed 501 variant) - the same degradation with the typed reason rendered", async () => {
    const { app } = buildApp({ refusals: { "/v1/enterprise/workspace": WORKSPACE_501 } });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-device-fleet="true"');
    expect(page.html).toContain('data-workspace-step="devices"');
    expect(page.html).toContain('data-unavailable-section="workspace-journey"');
    expect(page.html).toContain('data-unavailable-reason="READ_MODEL_NOT_COMPOSED"');
    expect(page.html).toContain("ENTERPRISE_WORKSPACE_SOURCE_NOT_BOUND");
    expect(page.html).not.toContain('data-error-kind=');
  });

  it("state 2 - a CORE read failing (the session read) keeps the honest full-body law", async () => {
    const { app } = buildApp({ refusals: { "/v1/users/me": UNAVAILABLE_503 } });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-error-kind="unavailable"');
    expect(page.html).not.toContain('data-workspace-journey="true"');
    expect(page.html).not.toContain('data-device-fleet="true"');
    expect(page.html).not.toContain('data-unavailable-section="workspace-journey"');
  });

  it("state 3 - mixed states: the full journey + every section renders truthfully (no panels)", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "workspace" });
    // All eight steps of the frozen chain render with their per-step states.
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
    expect(page.html).toContain('data-policy-summary="configured"');
    expect(page.html).toContain('data-integrations="true"');
    expect(page.html).not.toContain('data-unavailable="true"');
  });

  it("an authorization refusal still fails the whole page closed (never a partial surface)", async () => {
    // The standing security law: the enterprise workspace requires an
    // organization tenant scope; a personal-scope actor gets the typed
    // unauthorized panel - NOT a degraded-but-partial workspace page.
    const personalTenantId = "usr:aaaaaaaa-0000-4000-8000-000000000003";
    const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
    const fakeIds = new DeterministicUuidGenerator(10_000);
    const fake = createInMemoryApi(
      {
        ...fakeApiSeed(),
        tenants: {
          ...fakeApiSeed().tenants,
          [personalTenantId]: {
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
          },
        },
      },
      { now: () => clock.now(), ids: () => fakeIds.next() },
    );
    const client = new RoamLinkApiClient({
      transport: fake.transport,
      actor: { actorId: personalTenantId, tenantId: personalTenantId },
      ids: new DeterministicUuidGenerator(41_007),
    });
    const app = new CustomerWebApp({ client });
    const page = await app.renderPage({ page: "workspace" });
    expect(page.html).toContain('data-error-kind="unauthorized"');
    expect(page.html).not.toContain('data-unavailable="true"');
    expect(page.html).not.toContain('data-workspace-journey="true"');
  });
});
