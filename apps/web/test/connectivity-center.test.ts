/**
 * Connectivity Center tests (RL-084, spec/ux-architecture.md §6).
 *
 * The Connectivity Center is the primary explanation surface. These tests
 * lock its honesty contract:
 *  - the connection journey renders the frozen stage vocabulary with only
 *    the three honest per-stage states, derived ONLY from projection state;
 *  - no connected/delivering claim ever arises from commerce facts or event
 *    arrival (RL-LOCK-008/009);
 *  - progressive disclosure (Summary -> Why -> Evidence -> Technical detail)
 *    is present;
 *  - the support escape hatch appears on degraded states and honest empty
 *    states appear where the projection has nothing;
 *  - novice-path vocabulary stays out of the surface.
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
  transport?: HttpTransport;
  seed?: FakeApiSeed;
  clock?: DeterministicClock;
}) {
  const clock = options?.clock ?? new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(10_000);
  const fake = createInMemoryApi(options?.seed ?? fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
  const client = new RoamLinkApiClient({
    transport: options?.transport ?? fake.transport,
    actor: { actorId: MEMBER_ACTOR, tenantId: TENANT },
    ids: new DeterministicUuidGenerator(40_000),
  });
  const app = new CustomerWebApp({ client });
  return { app, fake, clock, client };
}

/** A brand-new customer: no references, no observations, no notifications. */
function freshCustomerSeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  tenants[TENANT] = {
    ...tenant,
    devices: [],
    intents: [],
    orders: [],
    subscriptions: [],
    payments: [],
    invoices: [],
    references: [],
    notifications: [],
    projections: [],
    slos: [],
    reconciliationJobs: [],
  };
  return { ...seed, tenants };
}

describe("the connection journey (honest state machine rendering)", () => {
  it("renders all seven stages with per-stage honest states on a mixed world", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "connectivity" });
    for (const stage of [
      "observed",
      "requested",
      "accepted",
      "reserved",
      "path-active",
      "delivery",
      "recovered",
    ]) {
      expect(page.html).toContain(`data-lifecycle-stage="${stage}"`);
    }
    // Fresh evidence exists -> observation and request confirmed; the
    // confirmed chain is backed by the linked delivery evidence.
    expect(page.html).toContain('data-lifecycle-stage="observed" data-lifecycle-state="reached"');
    expect(page.html).toContain('data-lifecycle-stage="requested" data-lifecycle-state="reached"');
    expect(page.html).toContain('data-lifecycle-stage="accepted" data-lifecycle-state="reached"');
    expect(page.html).toContain('data-lifecycle-stage="reserved" data-lifecycle-state="reached"');
    expect(page.html).toContain('data-lifecycle-stage="path-active" data-lifecycle-state="reached"');
    // The subscription reference is still UNEVIDENCED -> delivery waits.
    expect(page.html).toContain('data-lifecycle-stage="delivery" data-lifecycle-state="waiting"');
    // Recovery is never claimed from this read.
    expect(page.html).toContain('data-lifecycle-stage="recovered" data-lifecycle-state="not-recorded"');
    expect(page.html).toContain("is recorded in Activity");
  });

  it("never derives delivery from the commerce facts (payment is not delivery)", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "connectivity" });
    // The seeded subscription has a succeeded payment behind its order and an
    // active subscription, yet its reference is UNEVIDENCED: the page says so.
    expect(page.html).toContain("no delivery evidence linked");
    // The commercial fact renders labeled as separate and never as delivery.
    expect(page.html).toContain("Commercial fact (separate)");
    expect(page.html).toContain("it never stands in for delivery");
    expect(page.html).not.toMatch(/data-connectivity-status="[^"]*paid/);
  });

  it("renders the honest not-started journey for a brand-new customer", async () => {
    const { app } = buildApp({ seed: freshCustomerSeed() });
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-lifecycle-stage="observed" data-lifecycle-state="waiting"');
    expect(page.html).toContain('data-lifecycle-stage="requested" data-lifecycle-state="waiting"');
    expect(page.html).toContain('data-lifecycle-stage="accepted" data-lifecycle-state="not-recorded"');
    expect(page.html).toContain('data-lifecycle-stage="delivery" data-lifecycle-state="not-recorded"');
    expect(page.html).toContain('data-subjects-empty="true"');
    expect(page.html).toContain("Start with a goal");
    expect(page.html).toContain('data-observations-empty="true"');
  });

  it("stale evidence degrades honestly and opens the support escape hatch", async () => {
    const { app, clock } = buildApp();
    clock.advanceTo("2025-01-06T11:00:00.000Z");
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-freshness="STALE"');
    expect(page.html).toContain('data-shell-state="evidenced-stale"');
    expect(page.html).toContain('data-support-escape="true"');
    expect(page.html).toContain("freshness guarantee on that evidence has expired");
    // The waiting section explains the honest state.
    expect(page.html).toContain("What RoamLink is waiting for");
  });
});

describe("progressive disclosure (Summary -> Why -> Evidence -> Technical detail)", () => {
  it("carries the three disclosure layers with human summaries", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-disclosure="why"');
    expect(page.html).toContain('data-disclosure="evidence"');
    expect(page.html).toContain('data-disclosure="technical"');
    expect(page.html).toContain("Why is RoamLink doing this?");
    expect(page.html).toContain("Evidence");
    expect(page.html).toContain("Technical detail");
    // The understanding layers never require the technical one.
    expect(page.html).toContain(
      "You never need this section to understand your connection",
    );
  });

  it("renders evidence facts with freshness, and honestly when none is linked", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "connectivity" });
    // The evidenced order shows its evidence record facts.
    expect(page.html).toContain('data-evidence-present="true"');
    expect(page.html).toContain("Freshness guarantee until");
    // The unevidenced subscription shows the honest absence.
    expect(page.html).toContain('data-evidence-present="false"');
    expect(page.html).toContain("No delivery evidence is linked to this reference yet");
  });
});

describe("recent access + events", () => {
  it("lists recent connectivity events traceable to their recorded change", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-recent-connectivity-events="true"');
    expect(page.html).toContain("Connectivity evidence linked");
    expect(page.html).toContain("Recorded change: evidence_linked");
    expect(page.html).toContain('href="/activity"');
  });

  it("shows per-device observation freshness with the honest empty state", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-device-observations="true"');
    expect(page.html).toContain("Phone");
    expect(page.html).toContain("Laptop");
    expect(page.html).toContain("Last observed:");
  });
});

describe("surface language discipline", () => {
  it("keeps internal architecture vocabulary off the connectivity surface", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "connectivity" });
    for (const term of FORBIDDEN_SURFACE_VOCABULARY) {
      expect(page.html).not.toContain(term);
    }
  });

  it("the summary answers with the shared derived state, not a new vocabulary", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-connectivity-status="true"');
    expect(page.html).toContain('data-shell-state="evidenced-fresh"');
    expect(page.html).toContain("Usefully connected");
  });
});

describe("fail-closed behavior is preserved", () => {
  it("a failing connectivity read renders the typed error panel only", async () => {
    const { app } = buildApp({
      transport: {
        async request(): Promise<HttpResponse> {
          return {
            status: 503,
            body: JSON.stringify({
              kind: "unavailable",
              reason: "ADCOS_PROJECTION_STORE_DOWN",
              message: "projection reads are temporarily unavailable",
              retryable: true,
              details: [],
            }),
          };
        },
      },
    });
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-error-kind="unavailable"');
    expect(page.html).not.toContain('data-connection-journey');
    expect(page.html).not.toContain('data-connectivity-status');
  });
});
