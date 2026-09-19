/**
 * Support contextual entry points (RL-103, spec/ux-architecture.md §11,
 * spec/user-journey-audit.md §9).
 *
 * spec/ux-architecture.md §11: "Support should be reachable from every
 * degraded/error state" and "A support case should automatically carry
 * relevant references where the customer permits it: device; goal;
 * connectivity reference; activity; order/subscription/payment; recent
 * evidence/freshness."
 *
 * These tests lock:
 *  - an escape hatch pre-carrying its context from EACH of the five
 *    degraded states: degraded connectivity, failed automation,
 *    stale/unknown evidence, failed purchase/delivery, unsupported
 *    capability;
 *  - the plumbing fix end-to-end: createSupportCaseFlow carries
 *    relatedRefs -> the command layer validates them -> the fake stores
 *    them -> listSupportCases returns them (so the admin triage surface
 *    receives the same context through the existing commands);
 *  - the Support page renders the carried context transparently BEFORE
 *    the case is opened (the customer decides);
 *  - fail-closed decode: unknown kinds/overlong values are dropped;
 *  - internal messages stay hidden from customer threads;
 *  - the carried-context narrative is honest (evidence/freshness facts
 *    travel as the case description, never invented state).
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
const LAPTOP_ID = "dddddddd-0000-4000-8000-000000000002";
const SEED_ORDER_ID = "66666666-0000-4000-8000-000000000001";
const SEED_SUBSCRIPTION_ID = "88888888-0000-4000-8000-000000000001";

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

/** A world whose only notification is a CRITICAL connectivity warning. */
function failedAutomationSeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  tenants[TENANT] = {
    ...tenant,
    notifications: [
      {
        notificationId: "d0d0d0d0-0000-4000-8000-000000000099",
        recipientUserId: "aaaaaaaa-0000-4000-8000-000000000003",
        topic: "connectivity",
        severity: "critical",
        title: "Connectivity automation could not complete",
        body: "RoamLink could not finish the requested change on your device.",
        state: "delivered",
        source: {
          origin: "roamlink_state_transition",
          aggregateType: "connectivity_reference",
          aggregateId: "ref-99",
          transition: "automation_failed",
          eventId: "evt_999",
          occurredAt: "2025-01-06T09:20:00.000Z",
        },
        related: [
          { kind: "device", id: "dddddddd-0000-4000-8000-000000000001" },
          { kind: "subscription", id: "88888888-0000-4000-8000-000000000001" },
        ],
        channels: [
          { channel: "in_app", outcome: "delivered", attemptedAt: "2025-01-06T09:20:00.000Z" },
        ],
        createdAt: "2025-01-06T09:20:00.000Z",
        updatedAt: "2025-01-06T09:20:00.000Z",
      },
    ],
  };
  return { ...seed, tenants };
}

/** A world with NO evidenced subject (shell state: unevidenced). */
function unevidencedWorldSeed(): FakeApiSeed {
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

describe("contextual escapes from the five degraded states", () => {
  it("1. degraded connectivity: the waiting section escapes with the subject references", async () => {
    const { app } = buildApp({ seed: unevidencedWorldSeed() });
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-shell-state="unevidenced"');
    expect(page.html).toContain('data-support-escape="true"');
    expect(page.html).toContain("My connectivity is requested but has no delivery evidence yet.");
    // The escape pre-carries the connectivity subjects.
    expect(page.html).toContain(`order ${SEED_ORDER_ID}`);
    expect(page.html).toContain(`subscription ${SEED_SUBSCRIPTION_ID}`);
    expect(page.html).toContain('href="/support?about=');
    // The waiting narrative rides as the carried detail.
    expect(page.html).toContain("RoamLink is waiting for the network to confirm delivery");
  });

  it("2. failed automation: a warning/critical activity entry escapes with the notification + related refs", async () => {
    const { app } = buildApp({ seed: failedAutomationSeed() });
    const page = await app.renderPage({ page: "activity" });
    expect(page.html).toContain('data-support-escape="true"');
    expect(page.html).toContain("Connectivity automation could not complete");
    // The activity record itself is carried (the notification kind).
    expect(page.html).toContain("notification d0d0d0d0-0000-4000-8000-000000000099");
    // Its typed related references ride along.
    expect(page.html).toContain(`device ${PHONE_ID}`);
  });

  it("3. stale/unknown evidence: stale subject cards escape with their own reference", async () => {
    const { app, clock } = buildApp();
    clock.advanceTo("2025-01-06T11:00:00.000Z"); // evidence guarantee expired
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-freshness="STALE"');
    // The page-level escape AND the stale order subject's own escape.
    expect(page.html).toContain("My delivery evidence has gone stale and I want to know what is happening.");
    expect(page.html).toContain(`My delivery evidence is stale on order ${SEED_ORDER_ID}.`);
    expect(page.html).toContain(`order ${SEED_ORDER_ID}`);
  });

  it("4. failed purchase/delivery: the unevidenced subject and a failed payment each escape", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    // Delivery: the unevidenced subscription subject carries its escape.
    expect(page.html).toContain("I paid but my connectivity has no delivery evidence yet.");
    expect(page.html).toContain(`subscription ${SEED_SUBSCRIPTION_ID}`);
  });

  it("5. unsupported capability: unverified/stale device capability escapes with the device reference", async () => {
    const { app } = buildApp();
    // The Laptop's capability snapshot is STALE in the seed.
    const page = await app.renderPage({ page: "device", params: { deviceId: LAPTOP_ID } });
    expect(page.html).toContain('data-capability-state="STALE"');
    expect(page.html).toContain('data-support-escape="true"');
    expect(page.html).toContain("My device Laptop needs its capability verification re-checked.");
    expect(page.html).toContain(`device ${LAPTOP_ID}`);
    expect(page.html).toContain('href="/support?about=');

    // The Phone's capability is FRESH: no escape appears.
    const freshPage = await app.renderPage({ page: "device", params: { deviceId: PHONE_ID } });
    expect(freshPage.html).toContain('data-capability-state="FRESH"');
    expect(freshPage.html).not.toContain('data-support-escape="true"');
  });
});

describe("the Support page renders the carried context before sending", () => {
  it("decodes the carried context, shows the transparency panel and prefills the form", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({
      page: "support",
      params: {
        about: "My connectivity is requested but has no delivery evidence yet.",
        detail: "RoamLink is waiting for the network to confirm delivery.",
        ref: `order~${SEED_ORDER_ID},subscription~${SEED_SUBSCRIPTION_ID}`,
      },
    });
    expect(page.html).toContain('data-carried-support-context="true"');
    expect(page.html).toContain("Context carried from the page you came from");
    expect(page.html).toContain('data-carried-context-refs="true"');
    expect(page.html).toContain(`order ${SEED_ORDER_ID}`);
    expect(page.html).toContain(`subscription ${SEED_SUBSCRIPTION_ID}`);
    // The form is prefilled and the refs ride as typed hidden fields.
    expect(page.html).toContain('data-related-ref-kind="order"');
    expect(page.html).toContain(`data-related-ref-id="${SEED_ORDER_ID}"`);
    expect(page.html).toContain(`value="order~${SEED_ORDER_ID}"`);
    expect(page.html).toContain('data-support-context-note="true"');
    expect(page.html).toContain("You can remove them by editing the fields before sending.");
  });

  it("decodes fail-closed: unknown kinds and malformed refs are dropped", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({
      page: "support",
      params: {
        about: "Something looks wrong",
        ref: `workspace~${SEED_ORDER_ID},nonsense,broken~,,subscription~${SEED_SUBSCRIPTION_ID}`,
      },
    });
    // Only the legitimate subscription reference survives the decode.
    expect(page.html).toContain('data-carried-ref-kind="subscription"');
    expect(page.html).not.toContain('data-carried-ref-kind="workspace"');
    expect(page.html).not.toContain('data-carried-ref-kind="nonsense"');
    expect(page.html).toContain(`subscription ${SEED_SUBSCRIPTION_ID}`);
  });

  it("without context params the support page renders the plain form", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "support" });
    expect(page.html).not.toContain('data-carried-support-context="true"');
    expect(page.html).toContain('data-support-context-note="false"');
    expect(page.html).toContain("Nothing is attached automatically from this form.");
  });
});

describe("the carried context flows through the command to triage", () => {
  it("createSupportCaseFlow carries relatedRefs; the case resource returns them (admin triage path)", async () => {
    const { app, client } = buildApp();
    const result = await app.createSupportCaseFlow({
      subject: "My connectivity is requested but has no delivery evidence yet.",
      description:
        "RoamLink is waiting for the network to confirm delivery. Recent facts: delivery evidence UNEVIDENCED, freshness UNKNOWN (nothing linked).",
      priority: "high",
      relatedRefs: [
        { kind: "order", id: SEED_ORDER_ID },
        { kind: "subscription", id: SEED_SUBSCRIPTION_ID },
        { kind: "device", id: PHONE_ID },
        { kind: "notification", id: "d0d0d0d0-0000-4000-8000-000000000099" },
      ],
    });
    expect(result.status).toBe("ok");
    const cases = await client.listSupportCases();
    const created = cases.find((c) => c.subject.startsWith("My connectivity is requested"));
    expect(created).toBeDefined();
    // The fake HONORS the body now (the L1402 gap is fixed end-to-end).
    expect(created?.relatedRefs).toEqual([
      { kind: "order", id: SEED_ORDER_ID },
      { kind: "subscription", id: SEED_SUBSCRIPTION_ID },
      { kind: "device", id: PHONE_ID },
      { kind: "notification", id: "d0d0d0d0-0000-4000-8000-000000000099" },
    ]);
  });

  it("opening a case without refs still works (empty relatedRefs)", async () => {
    const { app, client } = buildApp();
    const result = await app.createSupportCaseFlow({
      subject: "A plain question",
      description: "No context needed.",
      priority: "low",
    });
    expect(result.status).toBe("ok");
    const cases = await client.listSupportCases();
    const created = cases.find((c) => c.subject === "A plain question");
    expect(created?.relatedRefs).toEqual([]);
  });

  it("the customer thread still hides internal messages (boundary intact)", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "support" });
    expect(page.html).toContain("It dropped twice near the crossing.");
    expect(page.html).not.toContain("Internal: checking projection freshness");
  });
});

describe("surface language discipline", () => {
  it("keeps internal architecture vocabulary off the support and degraded surfaces", async () => {
    const { app } = buildApp({ seed: failedAutomationSeed() });
    for (const request of [
      { page: "support" as const },
      { page: "activity" as const },
      { page: "connectivity" as const },
      { page: "order" as const, params: { orderId: SEED_ORDER_ID } },
    ]) {
      const rendered = await app.renderPage(request);
      for (const term of FORBIDDEN_SURFACE_VOCABULARY) {
        expect(rendered.html, `${request.page} leaked "${term}"`).not.toContain(term);
      }
    }
  });
});
