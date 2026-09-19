/**
 * Device capability experience tests (RL-087, spec/ux-architecture.md §9).
 *
 * The device registry must be understandable as capabilities, not
 * inventory rows. Locked here:
 *  - the list renders devices as cards: identity, platform in human
 *    language, enrollment status language, what it can do (evidence-based),
 *    and its current connectivity observation;
 *  - the capability card is honest by construction (RL-LOCK-011): the
 *    read model carries snapshot FRESHNESS, not capability facts, so the
 *    page renders the verified/needs-re-checking/not-verified statement and
 *    the five-level automation key, assuming NOTHING unverified;
 *  - the device detail carries its connectivity observations, its goals,
 *    its recent actions (honest when none), and the manual fallback
 *    guidance; update/retire ride the same flows;
 *  - honest empty states for a brand-new customer;
 *  - the vocabulary discipline holds.
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
import { deviceCapabilityStatement } from "../src/pages/devices-page.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const PHONE_ID = "dddddddd-0000-4000-8000-000000000001";
const LAPTOP_ID = "dddddddd-0000-4000-8000-000000000002";

const FORBIDDEN_SURFACE_VOCABULARY = [
  "ADCOS",
  "ConnectivityIntent",
  "ExperienceIntent",
  "NetworkPath",
  "provider adapter",
  "idempotency",
];

function buildApp(options?: { seed?: FakeApiSeed; clock?: DeterministicClock }) {
  const clock = options?.clock ?? new DeterministicClock("2025-01-06T09:45:00.000Z");
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

describe("the devices list", () => {
  it("renders devices as capability cards with platform and status language", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "devices" });
    expect(page.html).toContain('data-devices="true"');
    expect(page.html).toContain(`data-device-id="${PHONE_ID}"`);
    expect(page.html).toContain("iPhone / iPad");
    expect(page.html).toContain("Mac");
    expect(page.html).toContain("Ready");
    expect(page.html).toContain("Enrolled — waiting to be used");
    // What it can do: the evidence-based capability statement.
    expect(page.html).toContain("What it can do:");
    expect(page.html).toContain("Verified recently");
    // Current connectivity from the observation read.
    expect(page.html).toContain("Latest observation");
    expect(page.html).toContain("Open this device");
  });

  it("keeps the honest empty state and the human enroll form", async () => {
    const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
    const tenant = seed.tenants[TENANT];
    if (tenant === undefined) throw new Error("missing tenant in seed");
    const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
    tenants[TENANT] = { ...tenant, devices: [], intents: [] };
    const { app } = buildApp({ seed: { ...seed, tenants } });
    const page = await app.renderPage({ page: "devices" });
    expect(page.html).toContain('data-devices-empty="true"');
    expect(page.html).toContain("No devices yet");
    expect(page.html).toContain('data-flow="enroll-device"');
    expect(page.html).toContain("Kind of device");
  });
});

describe("the device capability card (evidence-based, RL-LOCK-011)", () => {
  it("renders the verified statement for a fresh snapshot", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "device", params: { deviceId: PHONE_ID } });
    expect(page.html).toContain('data-device-capability="true"');
    expect(page.html).toContain('data-capability-state="FRESH"');
    expect(page.html).toContain("Verified recently");
    // The five-level automation key is explanatory, never per-device claims.
    expect(page.html).toContain('data-automation-key="true"');
    expect(page.html).toContain("Automatic — RoamLink can act without asking you first.");
    expect(page.html).toContain("Unknown — not verified for this device yet; RoamLink assumes nothing.");
    expect(page.html).toContain("established by verification, never assumed");
  });

  it("renders the not-verified statement where the projection has no data", async () => {
    // The seeded Laptop has STALE capability freshness and NO context
    // freshness; advance the clock so even its capability goes stale.
    const { app, clock } = buildApp();
    clock.advanceTo("2025-01-06T11:00:00.000Z");
    const page = await app.renderPage({ page: "device", params: { deviceId: LAPTOP_ID } });
    expect(page.html).toContain('data-capability-state="STALE"');
    expect(page.html).toContain("Needs re-checking");
    expect(page.html).toContain("treats unconfirmed abilities as unavailable");
    // Context snapshot has no data at all: honest UNKNOWN, never hidden.
    expect(page.html).toContain("no observation recorded");
  });

  it("maps missing freshness to the honest unknown statement", () => {
    const statement = deviceCapabilityStatement(null);
    expect(statement.state).toBe("UNKNOWN");
    expect(statement.label).toBe("Not verified yet");
    expect(statement.detail).toContain("nothing is assumed");
  });

  it("carries the manual fallback guidance as guidance, not authority", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "device", params: { deviceId: PHONE_ID } });
    expect(page.html).toContain('data-manual-fallback="true"');
    expect(page.html).toContain("When RoamLink cannot do it for you");
    expect(page.html).toContain("own settings");
  });
});

describe("the device detail journey", () => {
  it("shows its connectivity observation, its goals, and its actions honestly", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "device", params: { deviceId: PHONE_ID } });
    // The seeded Phone HAS an observation with fresh snapshots.
    expect(page.html).toContain('data-device-observation="true"');
    expect(page.html).toContain("Last observed");
    expect(page.html).toContain('href="/connectivity"');
    // The seeded intent belongs to the Phone: its goal is listed by name.
    expect(page.html).toContain('data-device-goals="true"');
    expect(page.html).toContain("Widen to any internet with a cost cap.");
    expect(page.html).toContain("Open this goal");
    // No device-related notifications exist in the seed: honest absence.
    expect(page.html).toContain('data-device-actions-empty="true"');
    expect(page.html).toContain("No device-specific actions recorded yet");
  });

  it("renders the honest empty goals + observations for a device without them", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "device", params: { deviceId: LAPTOP_ID } });
    expect(page.html).toContain('data-device-goals-empty="true"');
    expect(page.html).toContain("No goal involves this device yet");
    // The Laptop has an observation (stale) — assert its presence + honesty.
    expect(page.html).toContain('data-device-observation="true"');
    expect(page.html).toContain('data-freshness="STALE"');
  });

  it("keeps the update/retire flows field-compatible with human labels", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "device", params: { deviceId: PHONE_ID } });
    expect(page.html).toContain('data-flow="update-device"');
    expect(page.html).toContain(`value="${PHONE_ID}"`);
    expect(page.html).toContain('data-flow="retire-device"');
    expect(page.html).toContain("Save name");
    expect(page.html).toContain("Retire this device");
  });
});

describe("the enroll flow through the app", () => {
  it("a newly enrolled device renders with the honest not-verified capability", async () => {
    const { app, client } = buildApp();
    const result = await app.enrollDeviceFlow({ name: "Tablet", platform: "android" });
    expect(result.status).toBe("ok");
    const devices = await client.listDevices();
    const tablet = devices.find((d) => d.name === "Tablet");
    expect(tablet).toBeDefined();
    const page = await app.renderPage({ page: "device", params: { deviceId: tablet?.deviceId ?? "" } });
    expect(page.html).toContain('data-capability-state="UNKNOWN"');
    expect(page.html).toContain("Not verified yet");
    // The observation read exists but carries no data yet: honest UNKNOWN.
    expect(page.html).toContain('data-device-observation="true"');
    expect(page.html).toContain('data-freshness="UNKNOWN"');
    expect(page.html).toContain("not recorded");
  });
});

describe("surface language discipline", () => {
  it("keeps internal architecture vocabulary off the device surfaces", async () => {
    const { app } = buildApp();
    const list = await app.renderPage({ page: "devices" });
    const detail = await app.renderPage({ page: "device", params: { deviceId: PHONE_ID } });
    for (const page of [list, detail]) {
      for (const term of FORBIDDEN_SURFACE_VOCABULARY) {
        expect(page.html).not.toContain(term);
      }
    }
  });
});
