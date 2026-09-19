/**
 * Activity / automation timeline tests (RL-085, spec/ux-architecture.md §8).
 *
 * The Activity surface is the bridge between invisible automation and user
 * trust. These tests lock:
 *  - honest chronological order (newest first) with deterministic tiebreak;
 *  - every entry answers what/when/why/evidence/automatic/needs-you;
 *  - entries trace back to the durable record (transition + event + related
 *    references with evidence summaries);
 *  - unknown transitions fall back to the honest "recorded change"
 *    narrative instead of a fabricated story;
 *  - empty states are honest, never fabricated;
 *  - notifications render as the digest companion with per-item mark-read;
 *  - the customer-surface vocabulary discipline holds.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type FakeApiSeed,
  type FakeNotificationSeed,
  type FakeTenantSeed,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { CustomerWebApp } from "../src/app.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const MEMBER_USER = "aaaaaaaa-0000-4000-8000-000000000003";

const FORBIDDEN_SURFACE_VOCABULARY = [
  "ADCOS",
  "ConnectivityIntent",
  "ExperienceIntent",
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
  return { app, fake, clock, client };
}

function seedWithNotifications(
  extra: readonly FakeNotificationSeed[],
  options?: { readonly emptyDefault?: boolean },
): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  tenants[TENANT] = {
    ...tenant,
    notifications: options?.emptyDefault === true ? [...extra] : [...tenant.notifications, ...extra],
  };
  return { ...seed, tenants };
}

describe("the automation timeline", () => {
  it("renders entries in honest chronological order, newest first", async () => {
    const older: FakeNotificationSeed = {
      notificationId: "a0a0a0a0-0000-4000-8000-0000000000a1",
      recipientUserId: MEMBER_USER,
      topic: "system",
      severity: "info",
      title: "Older system record",
      body: "An older recorded change.",
      state: "read",
      source: {
        origin: "roamlink_state_transition",
        aggregateType: "system",
        aggregateId: "sys-1",
        transition: "something_happened",
        eventId: "evt_old",
        occurredAt: "2025-01-06T08:30:00.000Z",
      },
      related: [],
      channels: [{ channel: "in_app", outcome: "delivered", attemptedAt: "2025-01-06T08:30:00.000Z" }],
      createdAt: "2025-01-06T08:30:00.000Z",
      updatedAt: "2025-01-06T08:30:00.000Z",
    };
    const { app } = buildApp({ seed: seedWithNotifications([older]) });
    const page = await app.renderPage({ page: "activity" });
    const feed = page.html;
    const seedIndex = feed.indexOf("Connectivity evidence linked");
    const olderIndex = feed.indexOf("Older system record");
    expect(seedIndex).toBeGreaterThan(-1);
    expect(olderIndex).toBeGreaterThan(-1);
    expect(seedIndex).toBeLessThan(olderIndex);
    expect(page.html).toContain("newest first");
  });

  it("answers what/why/evidence/automatic per entry and stays traceable", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "activity" });
    // The known narrative for the seeded evidence-linked transition.
    expect(page.html).toContain('data-entry-kind="delivery"');
    expect(page.html).toContain("Delivery evidence was linked for your connectivity");
    // Traceability: the raw recorded change + event id + related reference.
    expect(page.html).toContain("Recorded change: connectivity_reference evidence_linked");
    expect(page.html).toContain("event evt_555");
    expect(page.html).toContain('data-evidence-lines="true"');
    expect(page.html).toContain("order 66666666-0000-4000-8000-000000000001");
    // Automation honesty + when.
    expect(page.html).toContain("RoamLink acted automatically and recorded this itself");
    expect(page.html).toContain("Happened");
  });

  it("flags entries that need the customer's review with the support hatch", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "activity" });
    expect(page.html).toContain('data-needs-you="true"');
    expect(page.html).toContain("This needs your review.");
    expect(page.html).toContain('href="/support"');
  });

  it("falls back to the honest recorded-change narrative for unknown transitions", async () => {
    const unknown: FakeNotificationSeed = {
      notificationId: "b0b0b0b0-0000-4000-8000-0000000000b1",
      recipientUserId: MEMBER_USER,
      topic: "system",
      severity: "info",
      title: "A change RoamLink has no story for yet",
      body: "The record speaks for itself.",
      state: "read",
      source: {
        origin: "roamlink_state_transition",
        aggregateType: "gadget",
        aggregateId: "g-9",
        transition: "flipped",
        eventId: "evt_flip",
        occurredAt: "2025-01-06T08:45:00.000Z",
      },
      related: [],
      channels: [{ channel: "in_app", outcome: "delivered", attemptedAt: "2025-01-06T08:45:00.000Z" }],
      createdAt: "2025-01-06T08:45:00.000Z",
      updatedAt: "2025-01-06T08:45:00.000Z",
    };
    const { app } = buildApp({ seed: seedWithNotifications([unknown]) });
    const page = await app.renderPage({ page: "activity" });
    expect(page.html).toContain('data-entry-kind="recorded"');
    expect(page.html).toContain("A change RoamLink has no story for yet");
    // The raw transition stays visible — the narrative never hides it.
    expect(page.html).toContain("gadget flipped");
  });

  it("keeps the honest empty state for a brand-new customer", async () => {
    const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
    const tenant = seed.tenants[TENANT];
    if (tenant === undefined) throw new Error("missing tenant in seed");
    const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
    tenants[TENANT] = { ...tenant, notifications: [], intents: [], devices: [] };
    const { app } = buildApp({ seed: { ...seed, tenants } });
    const page = await app.renderPage({ page: "activity" });
    expect(page.html).toContain('data-activity-empty="true"');
    expect(page.html).toContain("Nothing yet");
    expect(page.html).toContain('data-nothing-needs-you="true"');
    expect(page.html).toContain('data-automation-idle="true"');
  });

  it("keeps the test-locked sections and the automation status", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "activity" });
    expect(document).toContain("Needs your attention");
    expect(document).toContain("What RoamLink did");
    expect(document).toContain("Connectivity evidence linked");
    expect(document).toContain('data-automation-status="true"');
    expect(document).toContain("Your goal is currently supported.");
  });
});

describe("the notifications digest companion", () => {
  it("groups the digest honestly and keeps full traceability", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "notifications" });
    expect(page.html).toContain('data-notification-digest="true"');
    expect(page.html).toContain('data-digest-kind="needs-review"');
    expect(page.html).toContain("Connectivity evidence linked");
    expect(page.html).toContain("Source: connectivity_reference evidence_linked");
    expect(page.html).toContain("occurred 2025-01-06T09:00:00.000Z");
  });

  it("offers per-item mark-read through the same flow", async () => {
    const { app, client } = buildApp();
    const page = await app.renderPage({ page: "notifications" });
    expect(page.html).toContain('data-flow="mark-notification-read"');
    expect(page.html).toContain('value="d0d0d0d0-0000-4000-8000-000000000001"');

    const result = await app.markNotificationReadFlow({
      notificationId: "d0d0d0d0-0000-4000-8000-000000000001",
    });
    expect(result.status).toBe("ok");
    const notifications = await client.listNotifications();
    expect(notifications[0]?.state).toBe("read");

    const after = await app.renderPage({ page: "notifications" });
    expect(after.html).toContain('data-digest-kind="read"');
    expect(after.html).not.toContain('data-digest-kind="needs-review"');
    // Read items do not carry the mark-read form again.
    const readSection = after.html.split('data-digest-kind="read"')[1] ?? "";
    expect(readSection).not.toContain('data-flow="mark-notification-read"');
  });

  it("keeps the honest empty state", async () => {
    const { app } = buildApp({ seed: seedWithNotifications([], { emptyDefault: true }) });
    const page = await app.renderPage({ page: "notifications" });
    expect(page.html).toContain('data-notifications-empty="true"');
    expect(page.html).toContain("No notifications yet");
  });
});

describe("surface language discipline", () => {
  it("keeps internal architecture vocabulary off the activity surfaces", async () => {
    const { app } = buildApp();
    for (const pageName of ["activity", "notifications"] as const) {
      const page = await app.renderPage({ page: pageName });
      for (const term of FORBIDDEN_SURFACE_VOCABULARY) {
        expect(page.html).not.toContain(term);
      }
    }
  });
});
