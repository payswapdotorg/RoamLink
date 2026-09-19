/**
 * Goal-oriented intent UX tests (RL-086, spec/ux-architecture.md §7).
 *
 * The Goals surface is the first-class journey over the ExperienceIntent
 * domain: what the customer expressed, what RoamLink derived, what
 * connectivity it produced, and the honest gap between requested and
 * delivered. Locked here:
 *  - "Goal" is the user-facing word; the advanced label stays available;
 *  - the goal page shows status, affected device, preferences, active
 *    version, what changed, the derived decision + evidence freshness, and
 *    a clear edit/activate/replace action;
 *  - the honest-gap section keeps requested and delivered as SEPARATE
 *    truths (RL-LOCK-007/008) — no causal claim is fabricated;
 *  - the flows still work end-to-end through the app (create -> activate
 *    -> supersede) with human-labeled, field-compatible forms;
 *  - honest empty states for a brand-new customer.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type FakeApiSeed,
  type FakeTenantSeed,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { CustomerWebApp } from "../src/app.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const PHONE_ID = "dddddddd-0000-4000-8000-000000000001";
const SEEDED_INTENT_ID = "cccccccc-0000-4000-8000-000000000001";

const FORBIDDEN_SURFACE_VOCABULARY = [
  "ADCOS",
  "ConnectivityIntent",
  "NetworkPath",
  "provider adapter",
  "idempotency",
];

function buildApp(options?: { seed?: FakeApiSeed }) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(10_000);
  const fake = createInMemoryApi(options?.seed ?? fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
  const client = new RoamLinkApiClient({
    transport: fake.transport,
    actor: { actorId: MEMBER_ACTOR, tenantId: TENANT },
    ids: new DeterministicUuidGenerator(40_000),
  });
  const app = new CustomerWebApp({ client });
  return { app, fake, clock, client, client2: null };
}

function freshCustomerSeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  tenants[TENANT] = { ...tenant, intents: [], notifications: [] };
  return { ...seed, tenants };
}

describe("the goals list journey", () => {
  it("renders goals as first-class cards with device, preferences and derivation", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "intents" });
    expect(page.html).toContain('data-intents="true"');
    expect(page.html).toContain('data-goal-id="cccccccc-0000-4000-8000-000000000001"');
    // The goal statement in the customer's words (the active version).
    expect(page.html).toContain("Widen to any internet with a cost cap.");
    // The affected device by name, not raw id.
    expect(page.html).toContain("Device: Phone");
    // Preferences in human language.
    expect(page.html).toContain("Full internet when you need it");
    expect(page.html).toContain("Keep costs under control");
    // What RoamLink derived.
    expect(page.html).toContain("Your goal is currently supported.");
    // What changed (v1 -> v2) without leaking the version-chain metaphor.
    expect(page.html).toContain("What changed:");
    expect(page.html).toContain("Initial: work apps on the road.");
  });

  it("keeps the Goals label with the advanced intent label available", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "intents" });
    expect(document).toContain('href="/intents" aria-current="page"');
    expect(document).toContain("Goals");
    expect(document).toContain("Advanced: experience intents");
  });

  it("creates goals from a device select with real device ids", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "intents" });
    expect(page.html).toContain('data-flow="create-intent"');
    expect(page.html).toContain(`<option value="${PHONE_ID}">`);
    expect(page.html).toContain('name="rationale"');
    expect(page.html).toContain('name="accessClasses"');
    expect(page.html).toContain("Full internet when you need it");
  });

  it("keeps the honest empty state for a brand-new customer", async () => {
    const { app } = buildApp({ seed: freshCustomerSeed() });
    const page = await app.renderPage({ page: "intents" });
    expect(page.html).toContain('data-goals-empty="true"');
    expect(page.html).toContain("No goals yet");
  });
});

describe("the goal detail journey", () => {
  it("renders what-you-asked, the derivation, and the version chain", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "intent", params: { intentId: SEEDED_INTENT_ID } });
    expect(page.html).toContain('data-goal-current="true"');
    expect(page.html).toContain("What you asked for");
    expect(page.html).toContain("Widen to any internet with a cost cap.");
    expect(page.html).toContain("What RoamLink derived from your goal");
    expect(page.html).toContain('data-decision="0c0c0c0c-0000-4000-8000-000000000001"');
    expect(page.html).toContain("Freshness of the evidence used");
    // What changed: the immutable chain stays visible (guarantee, not metaphor).
    expect(page.html).toContain("What changed");
    expect(page.html).toContain('data-versions="true"');
    expect(page.html).toContain('data-version-number="1"');
    expect(page.html).toContain('data-version-number="2"');
    expect(page.html).toContain('data-state="superseded"');
    expect(page.html).toContain('data-state="active"');
    // Device link by name.
    expect(page.html).toContain("See Phone");
  });

  it("presents the honest gap between requested and delivered as separate truths", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "intent", params: { intentId: SEEDED_INTENT_ID } });
    expect(page.html).toContain('data-goal-gap="true"');
    expect(page.html).toContain("Requested and delivered — kept honest");
    expect(page.html).toContain("What you asked for");
    expect(page.html).toContain("What is delivering right now");
    // The seed has one evidenced subject of two references.
    expect(page.html).toContain("1 of 2 references have delivery evidence linked");
    // The separation sentence is explicit; no causal borrowing.
    expect(page.html).toContain("two separate truths");
    expect(page.html).toContain("delivery is confirmed only by delivery evidence");
  });

  it("offers the replace action for an active goal, with the full flow fields", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "intent", params: { intentId: SEEDED_INTENT_ID } });
    expect(page.html).toContain('data-flow="supersede-intent"');
    expect(page.html).toContain(`value="${SEEDED_INTENT_ID}"`);
    expect(page.html).toContain("Replace with a new version");
    expect(page.html).toContain("What matters most now?");
  });
});

describe("the goal lifecycle through the app flows", () => {
  it("create -> activate -> supersede renders the deepened journey", async () => {
    const { app } = buildApp();
    const created = await app.createIntentFlow({
      deviceId: PHONE_ID,
      rationale: "Keep work apps reachable while I travel.",
      accessClasses: ["work_apps_only"],
    });
    expect(created.status).toBe("ok");
    if (created.status !== "ok") return;
    const intentId = created.acknowledgement.resource?.id ?? "";

    const draftPage = await app.renderPage({ page: "intent", params: { intentId } });
    expect(draftPage.html).toContain('data-goal-status="draft"');
    expect(draftPage.html).toContain("RoamLink has not evaluated this goal yet");
    expect(draftPage.html).toContain("Start working on this goal");
    expect(draftPage.html).toContain('data-flow="activate-intent"');

    const activated = await app.activateIntentFlow({ intentId });
    expect(activated.status).toBe("ok");

    const superseded = await app.supersedeIntentFlow({
      intentId,
      rationale: "Also keep costs down.",
      accessClasses: ["work_apps_only", "metered_cost_cap"],
    });
    expect(superseded.status).toBe("ok");

    const detailPage = await app.renderPage({ page: "intent", params: { intentId } });
    expect(detailPage.html).toContain('data-version-number="1"');
    expect(detailPage.html).toContain('data-version-number="2"');
    expect(detailPage.html).toContain('data-state="superseded"');
    expect(detailPage.html).toContain('data-state="active"');
    expect(detailPage.html).toContain("Also keep costs down.");
    expect(detailPage.html).toContain("Keep costs under control");
  });
});

describe("surface language discipline", () => {
  it("keeps internal architecture vocabulary off the goals surfaces", async () => {
    const { app } = buildApp();
    const list = await app.renderPage({ page: "intents" });
    const detail = await app.renderPage({ page: "intent", params: { intentId: SEEDED_INTENT_ID } });
    for (const page of [list, detail]) {
      for (const term of FORBIDDEN_SURFACE_VOCABULARY) {
        expect(page.html).not.toContain(term);
      }
    }
  });
});
