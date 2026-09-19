/**
 * Evidence + why progressive-disclosure tests (RL-102,
 * spec/ux-architecture.md §6 L118-122).
 *
 * The frozen pattern: "Use progressive disclosure: Summary -> Why ->
 * Evidence -> Technical detail" and "A user should be able to understand
 * the situation without opening Technical detail."
 *
 * These tests lock the SHARED disclosure builder contract across every
 * surface that shows evidence:
 *  - the exact data-disclosure vocabulary (why | evidence | technical)
 *    is preserved everywhere the pattern applies;
 *  - every evidence claim stays linked to its source facts (RL-LOCK-009):
 *    class, record id, timestamps, freshness;
 *  - freshness stays the honest closed set (FRESH/STALE/UNKNOWN) from the
 *    read model (RL-LOCK-010) - never re-derived or invented;
 *  - absence renders honestly; disclosure layers add no invented facts;
 *  - the understanding layers never require the technical one;
 *  - novice-path vocabulary stays off the surface.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type FakeApiSeed,
  type FakeTenantSeed,
  type HttpTransport,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { CustomerWebApp } from "../src/app.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const PHONE_ID = "dddddddd-0000-4000-8000-000000000001";

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

/** A world with zero recorded activity (the honest-empty seed). */
function emptyActivitySeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  tenants[TENANT] = { ...tenant, notifications: [] };
  return { ...seed, tenants };
}

describe("the shared disclosure pattern across evidence-bearing surfaces", () => {
  it("the connectivity center keeps all three layers with the frozen vocabulary", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-disclosure="why"');
    expect(page.html).toContain('data-disclosure="evidence"');
    expect(page.html).toContain('data-disclosure="technical"');
    // A user understands the situation without opening Technical detail.
    expect(page.html).toContain("You never need this section to understand your connection");
  });

  it("every activity entry with related records discloses its evidence traceably", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "activity" });
    expect(page.html).toContain('data-disclosure="evidence"');
    expect(page.html).toContain("Evidence for this entry");
    // The claim stays linked to its source record (RL-LOCK-009): the entry's
    // related records render verbatim inside the disclosure.
    expect(page.html).toContain('data-evidence-lines="true"');
    expect(page.html).toContain("order 66666666-0000-4000-8000-000000000001");
    // The technical layer is never required to follow the story.
    expect(page.html).toContain("You never need this section to follow the story");
  });

  it("an activity world without related records renders honestly and adds no invented evidence", async () => {
    const { app } = buildApp({ seed: emptyActivitySeed() });
    const page = await app.renderPage({ page: "activity" });
    expect(page.html).toContain('data-activity-empty="true"');
    expect(page.html).not.toContain('data-disclosure="evidence"');
  });

  it("the device capability card discloses its evidence and its automation key separately", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "device", params: { deviceId: PHONE_ID } });
    expect(page.html).toContain('data-disclosure="evidence"');
    expect(page.html).toContain("Capability evidence");
    expect(page.html).toContain('data-capability-evidence="true"');
    expect(page.html).toContain('data-disclosure="technical"');
    expect(page.html).toContain("Automation levels explained");
    expect(page.html).toContain('data-automation-key="true"');
    // The authoritative freshness still renders beside the disclosure.
    expect(page.html).toContain('data-freshness="FRESH"');
  });
});

describe("evidence claims stay linked to their source (RL-LOCK-009)", () => {
  it("the evidence layer renders class, record id and freshness facts from the read model", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "connectivity" });
    // The evidenced order subject carries its full provenance chain.
    expect(page.html).toContain('data-evidence-present="true"');
    expect(page.html).toContain("Evidence class");
    expect(page.html).toContain("AUTHENTICATED_WEBHOOK");
    expect(page.html).toContain("Evidence record id");
    expect(page.html).toContain("ctr_123");
    expect(page.html).toContain("Freshness guarantee until");
    // The unevidenced subject states its absence honestly.
    expect(page.html).toContain('data-evidence-present="false"');
    expect(page.html).toContain("No delivery evidence is linked to this reference yet");
  });

  it("freshness stays the honest closed set everywhere (never a re-derived state)", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "connectivity" });
    for (const match of page.html.matchAll(/data-freshness="([^"]+)"/g)) {
      expect(["FRESH", "STALE", "UNKNOWN"]).toContain(match[1]);
    }
    expect(page.html).toContain('data-freshness="FRESH"');
  });

  it("stale evidence still names its freshness honestly inside the disclosures", async () => {
    const { app, clock } = buildApp();
    clock.advanceTo("2025-01-06T11:00:00.000Z");
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-freshness="STALE"');
    expect(page.html).not.toContain('data-freshness="FRESH"');
    // The evidence layer still links the claim to its (now stale) source.
    expect(page.html).toContain('data-evidence-present="true"');
    expect(page.html).toContain("Freshness when linked");
  });
});

describe("surface language discipline", () => {
  it("keeps internal architecture vocabulary off every disclosing surface", async () => {
    const { app } = buildApp();
    for (const page of ["connectivity", "activity", "device"] as const) {
      const rendered =
        page === "device"
          ? await app.renderPage({ page, params: { deviceId: PHONE_ID } })
          : await app.renderPage({ page });
      for (const term of FORBIDDEN_SURFACE_VOCABULARY) {
        expect(rendered.html, `${page} leaked "${term}"`).not.toContain(term);
      }
    }
  });
});
